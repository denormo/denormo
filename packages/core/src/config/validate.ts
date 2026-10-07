import { type ConfigProblem, DenormoConfigError } from '../errors.js';
import { isPlainPath, parseSnapshotPath, pathsOverlap, stripArrayMarker } from './paths.js';
import {
  CONFIG_VERSION,
  type CompiledConfig,
  type OnDeletePolicy,
  type RelationConfig,
  type RelationMode,
} from './types.js';

export const DEFAULT_MAX_CASCADE_DEPTH = 3;

export type ConfigProblemCode =
  | 'UNSUPPORTED_CONFIG_VERSION'
  | 'DUPLICATE_RELATION_ID'
  | 'UNKNOWN_SOURCE'
  | 'FIELD_NOT_EXPOSED'
  | 'INVALID_ON_DELETE'
  | 'INVALID_MODE'
  | 'INVALID_PATH'
  | 'INVALID_FIELD'
  | 'DUPLICATE_TARGET_FIELD'
  | 'RESERVED_TARGET_FIELD'
  | 'CYCLE'
  | 'CASCADE_TOO_DEEP';

export interface ValidationProblem extends ConfigProblem {
  readonly code: ConfigProblemCode;
}

export interface ValidateOptions {
  /** Longest allowed chain of relations a single source change can flow through. Default 3. */
  readonly maxCascadeDepth?: number;
}

const ON_DELETE_POLICIES: readonly OnDeletePolicy[] = ['markDeleted', 'unset', 'keep'];
const RELATION_MODES: readonly RelationMode[] = ['stream', 'readRepair'];
/** Snapshot fields the engine writes itself. */
const RESERVED_SNAPSHOT_FIELDS = ['_id', '_v', 'deleted'];

/** Checks a compiled config without touching a database. Returns every problem found. */
export function validateConfig(
  config: CompiledConfig,
  options: ValidateOptions = {},
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];

  if ((config.version as number) !== CONFIG_VERSION) {
    problems.push({
      code: 'UNSUPPORTED_CONFIG_VERSION',
      message: `Config version ${String(config.version)} is not supported; expected ${String(CONFIG_VERSION)}.`,
    });
  }

  const seenIds = new Set<string>();
  for (const relation of config.relations) {
    if (seenIds.has(relation.id)) {
      problems.push({
        code: 'DUPLICATE_RELATION_ID',
        relationId: relation.id,
        message: `Relation id "${relation.id}" is used more than once.`,
      });
    }
    seenIds.add(relation.id);
    problems.push(...validateRelation(config, relation));
  }

  problems.push(
    ...validateCascades(config.relations, options.maxCascadeDepth ?? DEFAULT_MAX_CASCADE_DEPTH),
  );
  return problems;
}

/** Throws a `DenormoConfigError` listing every problem, or returns if the config is valid. */
export function assertValidConfig(config: CompiledConfig, options?: ValidateOptions): void {
  const problems = validateConfig(config, options);
  const [first] = problems;
  if (!first) return;

  const count = problems.length === 1 ? '1 problem' : `${String(problems.length)} problems`;
  const details = problems.map((problem) => `  - ${problem.message}`).join('\n');
  throw new DenormoConfigError(`Invalid denormo config (${count}):\n${details}`, {
    code: first.code,
    ...(first.relationId === undefined ? {} : { relationId: first.relationId }),
    problems,
  });
}

function validateRelation(config: CompiledConfig, relation: RelationConfig): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const relationId = relation.id;
  const problem = (code: ConfigProblemCode, message: string, field?: string) => {
    problems.push({
      code,
      relationId,
      message: `Relation "${relationId}": ${message}`,
      ...(field === undefined ? {} : { field }),
    });
  };

  const source = Object.hasOwn(config.sources, relation.source)
    ? config.sources[relation.source]
    : undefined;
  if (!source) {
    problem('UNKNOWN_SOURCE', `source collection "${relation.source}" is not declared.`);
  } else {
    for (const field of relation.fields) {
      if (!source.expose.includes(field.from)) {
        problem(
          'FIELD_NOT_EXPOSED',
          `field "${field.from}" is not exposed by source "${relation.source}".`,
          field.from,
        );
      }
    }
  }

  if (!ON_DELETE_POLICIES.includes(relation.onDelete)) {
    problem(
      'INVALID_ON_DELETE',
      `onDelete "${relation.onDelete}" must be one of ${ON_DELETE_POLICIES.join(', ')}.`,
    );
  }
  if (!RELATION_MODES.includes(relation.mode)) {
    problem('INVALID_MODE', `mode "${relation.mode}" must be one of ${RELATION_MODES.join(', ')}.`);
  }
  if (!parseSnapshotPath(relation.path, relation.array)) {
    problem(
      'INVALID_PATH',
      relation.array
        ? `path "${relation.path}" must be dot notation with exactly one "[]" array marker.`
        : `path "${relation.path}" must be plain dot notation (use "[]" only with array: true).`,
    );
  }

  const targets: string[] = [];
  for (const field of relation.fields) {
    if (!isPlainPath(field.from) || !isPlainPath(field.to)) {
      problem(
        'INVALID_FIELD',
        `field mapping "${field.from}" → "${field.to}" must use plain dot notation.`,
        field.to,
      );
      continue;
    }
    const [head = ''] = field.to.split('.');
    if (RESERVED_SNAPSHOT_FIELDS.includes(head)) {
      problem(
        'RESERVED_TARGET_FIELD',
        `snapshot field "${field.to}" is reserved (${RESERVED_SNAPSHOT_FIELDS.join(', ')}).`,
        field.to,
      );
    }
    if (targets.some((target) => pathsOverlap(target, field.to))) {
      problem(
        'DUPLICATE_TARGET_FIELD',
        `snapshot field "${field.to}" overlaps another field of the same relation.`,
        field.to,
      );
    }
    targets.push(field.to);
  }

  return problems;
}

/**
 * Builds the cascade graph: relation A feeds relation B when A writes into B's source collection
 * at a path B copies with `sync: true`. Rejects cycles and chains longer than `maxDepth`.
 */
function validateCascades(
  relations: readonly RelationConfig[],
  maxDepth: number,
): ValidationProblem[] {
  const next = new Map<RelationConfig, RelationConfig[]>(
    relations.map((from) => [from, relations.filter((to) => feeds(from, to))]),
  );

  const cycles = findCycles(relations, next);
  if (cycles.length > 0) {
    return cycles.map(({ first, members }) => ({
      code: 'CYCLE',
      relationId: first.id,
      message: `Relations feed each other in a cascade cycle: ${members.map((r) => r.id).join(', ')}.`,
    }));
  }

  const problems: ValidationProblem[] = [];
  const longest = new Map<RelationConfig, RelationConfig[]>();
  const longestFrom = (relation: RelationConfig): RelationConfig[] => {
    let chain = longest.get(relation);
    if (!chain) {
      const tails = (next.get(relation) ?? []).map(longestFrom);
      const tail = tails.reduce<RelationConfig[]>((a, b) => (b.length > a.length ? b : a), []);
      chain = [relation, ...tail];
      longest.set(relation, chain);
    }
    return chain;
  };

  const hasUpstream = new Set([...next.values()].flat());
  for (const root of relations.filter((relation) => !hasUpstream.has(relation))) {
    const chain = longestFrom(root);
    if (chain.length > maxDepth) {
      problems.push({
        code: 'CASCADE_TOO_DEEP',
        relationId: root.id,
        message: `Cascade of ${String(chain.length)} relations exceeds maxCascadeDepth ${String(maxDepth)}: ${describeChain(chain)}.`,
      });
    }
  }
  return problems;
}

function feeds(upstream: RelationConfig, downstream: RelationConfig): boolean {
  if (upstream.target !== downstream.source) return false;
  const writes = writtenPaths(upstream);
  return downstream.fields.some(
    (field) => field.sync && writes.some((path) => pathsOverlap(path, field.from)),
  );
}

/** Target paths (dot notation, array marker removed) a relation's sync updates can change. */
function writtenPaths(relation: RelationConfig): string[] {
  const base = stripArrayMarker(relation.path);
  const synced = relation.fields
    .filter((field) => field.sync)
    .map((field) => `${base}.${field.to}`);
  const paths = synced.length > 0 ? [...synced, `${base}._v`] : [];
  switch (relation.onDelete) {
    case 'markDeleted':
      return [...paths, `${base}.deleted`, `${base}._v`];
    case 'unset':
      return [...paths, base];
    default:
      return paths;
  }
}

interface Cycle {
  /** The member that comes first in the config. */
  readonly first: RelationConfig;
  /** All members, in config order. */
  readonly members: readonly RelationConfig[];
}

/** Strongly connected components of the cascade graph that contain a cycle (Tarjan). */
function findCycles(
  relations: readonly RelationConfig[],
  next: ReadonlyMap<RelationConfig, readonly RelationConfig[]>,
): Cycle[] {
  interface VisitState {
    readonly index: number;
    low: number;
  }
  const states = new Map<RelationConfig, VisitState>();
  const stack: RelationConfig[] = [];
  const cycles: Cycle[] = [];
  const configOrder = (a: RelationConfig, b: RelationConfig) =>
    relations.indexOf(a) - relations.indexOf(b);

  const visit = (relation: RelationConfig): VisitState => {
    const state: VisitState = { index: states.size, low: states.size };
    states.set(relation, state);
    stack.push(relation);

    for (const successor of next.get(relation) ?? []) {
      const seen = states.get(successor);
      if (!seen) {
        state.low = Math.min(state.low, visit(successor).low);
      } else if (stack.includes(successor)) {
        state.low = Math.min(state.low, seen.index);
      }
    }

    if (state.low === state.index) {
      const members = stack.splice(stack.indexOf(relation)).sort(configOrder);
      const selfLoop = next.get(relation)?.includes(relation) ?? false;
      if (members.length > 1 || selfLoop) {
        const first = members.reduce((a, b) => (configOrder(b, a) < 0 ? b : a), relation);
        cycles.push({ first, members });
      }
    }
    return state;
  };

  for (const relation of relations) {
    if (!states.has(relation)) visit(relation);
  }
  return cycles;
}

function describeChain(chain: readonly RelationConfig[]): string {
  return chain.map((relation) => relation.id).join(' → ');
}
