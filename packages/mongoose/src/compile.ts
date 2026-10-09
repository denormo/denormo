import {
  CONFIG_VERSION,
  type CompiledConfig,
  DenormoConfigError,
  type RelationConfig,
  type SourceConfig,
} from '@denormo/core';
import mongoose, { type Model, type Schema } from 'mongoose';
import { Snapshot, type SnapshotOptions } from './snapshot-type.js';
import { getExposedFields } from './source-plugin.js';

/** Any Mongoose model, whatever its document type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- models of every document type
export type AnyModel = Model<any>;

interface FoundSnapshot {
  /** Core relation path, with `[]` marking array segments. */
  readonly path: string;
  readonly options: Partial<SnapshotOptions>;
}

/**
 * Compiles the snapshot paths of `models` into the core config. Referenced models are looked up
 * on each model's own connection, so they need not be in `models`.
 */
export function compileConfig(models: readonly AnyModel[]): CompiledConfig {
  const sources: Record<string, SourceConfig> = {};
  const relations: RelationConfig[] = [];

  for (const model of models) {
    // Discriminators share their base model's collection and paths.
    if (model.baseModelName !== undefined) continue;
    const target = model.collection.collectionName;

    for (const found of findSnapshots(model.schema, '')) {
      const id = `${target}.${found.path.replaceAll('[]', '')}`;
      const ref = found.options.ref;
      const source = typeof ref === 'string' ? model.db.models[ref] : undefined;
      if (!source) {
        throw new DenormoConfigError(
          `Relation "${id}": ref ${JSON.stringify(ref)} is not a model on this connection.`,
          { code: 'UNKNOWN_REF', relationId: id, problems: [] },
        );
      }
      const expose = getExposedFields(source.schema);
      if (!expose) {
        throw new DenormoConfigError(
          `Relation "${id}": model "${source.modelName}" has no snapshotSource plugin, so it exposes nothing.`,
          { code: 'SOURCE_NOT_DECLARED', relationId: id, problems: [] },
        );
      }
      const sourceCollection = source.collection.collectionName;
      sources[sourceCollection] = { expose: [...expose] };
      relations.push({
        id,
        source: sourceCollection,
        target,
        path: found.path,
        array: found.path.includes('[]'),
        fields: toFieldMappings(id, found.options.fields),
        onDelete: found.options.onDelete ?? 'keep',
        mode: found.options.mode ?? 'stream',
      });
    }
  }

  return { version: CONFIG_VERSION, sources, relations };
}

/** Every `Snapshot` path in a schema, including nested paths and array elements. */
function findSnapshots(schema: Schema, prefix: string): FoundSnapshot[] {
  const found: FoundSnapshot[] = [];
  schema.eachPath((path, type) => {
    if (type instanceof Snapshot) {
      found.push({ path: `${prefix}${path}`, options: type.options });
    } else if (type instanceof mongoose.Schema.Types.DocumentArray) {
      found.push(...findSnapshots(type.schema, `${prefix}${path}[].`));
    } else if (type instanceof mongoose.Schema.Types.Subdocument) {
      found.push(...findSnapshots(type.schema, `${prefix}${path}.`));
    } else if (type instanceof mongoose.Schema.Types.Array) {
      const element = arrayElementType(type);
      if (element instanceof Snapshot) {
        found.push({ path: `${prefix}${path}[]`, options: element.options });
      }
    }
  });
  return found;
}

/** The element schema type of an array path: `embeddedSchemaType` in Mongoose 9, `caster` in 8. */
function arrayElementType(type: mongoose.Schema.Types.Array): unknown {
  const { embeddedSchemaType, caster } = type as unknown as {
    embeddedSchemaType?: unknown;
    caster?: unknown;
  };
  return embeddedSchemaType ?? caster;
}

function toFieldMappings(id: string, fields: SnapshotOptions['fields'] | undefined) {
  return Object.entries(fields ?? {}).map(([from, field]) => {
    // Schemas are untyped at runtime: `field` may be anything, e.g. `true`.
    const spec: unknown = field;
    const { sync, as } = (typeof spec === 'object' && spec !== null ? spec : {}) as Partial<{
      sync: unknown;
      as: unknown;
    }>;
    if (typeof sync !== 'boolean' || (as !== undefined && typeof as !== 'string')) {
      throw new DenormoConfigError(
        `Relation "${id}": field "${from}" must be { sync: boolean, as?: string }.`,
        { code: 'INVALID_SNAPSHOT_FIELD', relationId: id, problems: [] },
      );
    }
    return { from, to: as ?? from, sync };
  });
}
