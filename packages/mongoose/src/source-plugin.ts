import { DenormoConfigError } from '@denormo/core';
import type { Schema } from 'mongoose';

export interface SnapshotSourceOptions {
  /** Source field paths (dot notation) that snapshots may copy. */
  readonly expose: readonly string[];
}

/** Marks a schema as a snapshot source. Fields not listed in `expose` can never be copied. */
export function snapshotSource(_schema: Schema, options: SnapshotSourceOptions): void {
  const expose: unknown = (options as Partial<SnapshotSourceOptions> | undefined)?.expose;
  if (!Array.isArray(expose) || !expose.every((field) => typeof field === 'string')) {
    throw new DenormoConfigError('snapshotSource needs { expose: string[] }.', {
      code: 'INVALID_SNAPSHOT_SOURCE',
      problems: [],
    });
  }
  // Nothing to store: Mongoose keeps plugins and their options on the schema (see below).
}

interface RegisteredPlugin {
  readonly fn: unknown;
  readonly opts?: unknown;
}

/**
 * The `expose` list a schema registered with `snapshotSource`, read from Mongoose's plugin
 * registry (`schema.plugins`), which survives `clone()`, `connection.model()` and discriminators.
 * It is not in Mongoose's TypeScript types.
 */
export function getExposedFields(schema: Schema): readonly string[] | undefined {
  const plugins = (schema as unknown as { plugins?: readonly RegisteredPlugin[] }).plugins ?? [];
  const registration = plugins.find((plugin) => plugin.fn === snapshotSource);
  return (registration?.opts as SnapshotSourceOptions | undefined)?.expose;
}
