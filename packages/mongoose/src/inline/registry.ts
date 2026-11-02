import { DenormoRuntimeError, type InlineSync } from '@denormo/core';
import type { Connection } from 'mongoose';

/** What the hooks call while an inline sync is running on a connection. */
export interface InlineHandler {
  readonly sync: InlineSync;
  readonly onError: (error: DenormoRuntimeError) => void;
}

const active = new WeakMap<Connection, InlineHandler>();

export function activateInline(connection: Connection, handler: InlineHandler): void {
  if (active.has(connection)) {
    throw new DenormoRuntimeError('An inline sync is already running on this connection.', {
      code: 'ALREADY_STARTED',
    });
  }
  active.set(connection, handler);
}

export function deactivateInline(connection: Connection, handler: InlineHandler): void {
  if (active.get(connection) === handler) active.delete(connection);
}

export function activeInline(connection: Connection): InlineHandler | undefined {
  return active.get(connection);
}
