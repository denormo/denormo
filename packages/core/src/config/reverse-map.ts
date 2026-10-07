import type { CompiledConfig, FieldMapping, RelationConfig } from './types.js';

/** One synced copy of a source field: the relation and the field mapping that writes it. */
export interface ReverseMapEntry {
  readonly relation: RelationConfig;
  readonly field: FieldMapping;
}

/** Source collection → source field path → every synced copy of that field, in config order. */
export type ReverseMap = ReadonlyMap<string, ReadonlyMap<string, readonly ReverseMapEntry[]>>;

/** Indexes relations by source field so a change event only touches affected relations. */
export function buildReverseMap(config: CompiledConfig): ReverseMap {
  const map = new Map<string, Map<string, ReverseMapEntry[]>>();
  for (const relation of config.relations) {
    for (const field of relation.fields) {
      if (!field.sync) continue;
      let byField = map.get(relation.source);
      if (!byField) {
        byField = new Map();
        map.set(relation.source, byField);
      }
      let entries = byField.get(field.from);
      if (!entries) {
        entries = [];
        byField.set(field.from, entries);
      }
      entries.push({ relation, field });
    }
  }
  return map;
}
