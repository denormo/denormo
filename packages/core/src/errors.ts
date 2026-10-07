/** One reason a compiled config is invalid. */
export interface ConfigProblem {
  readonly code: string;
  readonly message: string;
  readonly relationId?: string;
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
