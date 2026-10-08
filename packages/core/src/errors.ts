/** One reason a compiled config is invalid. */
export interface ConfigProblem {
  readonly code: string;
  readonly message: string;
  readonly relationId?: string;
  /** The offending field path, when the problem is about one field. */
  readonly field?: string;
}

export interface DenormoConfigErrorOptions {
  readonly code: string;
  readonly relationId?: string;
  readonly problems: readonly ConfigProblem[];
}

/** Thrown when a compiled config fails validation. */
export class DenormoConfigError extends Error {
  override readonly name = 'DenormoConfigError';
  readonly code: string;
  readonly relationId: string | undefined;
  readonly problems: readonly ConfigProblem[];

  constructor(message: string, options: DenormoConfigErrorOptions) {
    super(message);
    this.code = options.code;
    this.relationId = options.relationId;
    this.problems = options.problems;
  }
}

export interface DenormoRuntimeErrorOptions {
  readonly code: string;
  readonly relationId?: string;
  /** Source collection the error concerns, when there is one. */
  readonly source?: string;
  readonly cause?: unknown;
}

/** Thrown or reported by the running engine (streams, writes, startup checks). */
export class DenormoRuntimeError extends Error {
  override readonly name = 'DenormoRuntimeError';
  readonly code: string;
  readonly relationId: string | undefined;
  readonly source: string | undefined;

  constructor(message: string, options: DenormoRuntimeErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code;
    this.relationId = options.relationId;
    this.source = options.source;
  }
}
