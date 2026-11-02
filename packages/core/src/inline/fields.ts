import type { CompiledConfig } from '../config/types.js';

/**
 * The synced source fields an inline write must carry: every synced field of each stream relation
 * that copies one of `changed`, repeated until no relation adds a field. A copy has one `_v` for
 * all its fields, so writing only some of them would mark the rest as current and block an older,
 * still-queued change to them.
 */
export function fieldsToWrite(
  config: CompiledConfig,
  source: string,
  changed: readonly string[],
): string[] {
  const relations = config.relations
    .filter((relation) => relation.source === source && relation.mode === 'stream')
    .map((relation) => relation.fields.filter((field) => field.sync).map((field) => field.from));
  const fields = new Set(changed.filter((field) => relations.some((r) => r.includes(field))));
  for (let grew = true; grew;) {
    grew = false;
    for (const relationFields of relations) {
      if (!relationFields.some((field) => fields.has(field))) continue;
      for (const field of relationFields) {
        if (!fields.has(field)) {
          fields.add(field);
          grew = true;
        }
      }
    }
  }
  return [...fields];
}
