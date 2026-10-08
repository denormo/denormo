export {
  CONFIG_VERSION,
  type CompiledConfig,
  type FieldMapping,
  type OnDeletePolicy,
  type RelationConfig,
  type RelationMode,
  type SourceConfig,
} from './config/types.js';
export {
  assertValidConfig,
  DEFAULT_MAX_CASCADE_DEPTH,
  validateConfig,
  type ConfigProblemCode,
  type ValidateOptions,
  type ValidationProblem,
} from './config/validate.js';
export { buildReverseMap, type ReverseMap, type ReverseMapEntry } from './config/reverse-map.js';
export { planUpdates } from './planner/plan.js';
export type { ChangeOperation, NormalizedChangeEvent, PlannedOperation } from './planner/types.js';
export {
  DenormoConfigError,
  DenormoRuntimeError,
  type ConfigProblem,
  type DenormoConfigErrorOptions,
  type DenormoRuntimeErrorOptions,
} from './errors.js';
export {
  createSyncEngine,
  DEFAULT_STATE_PREFIX,
  type SyncEngine,
  type SyncEngineOptions,
} from './engine/engine.js';
