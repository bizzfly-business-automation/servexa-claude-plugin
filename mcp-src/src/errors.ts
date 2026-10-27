import { redact } from './redact.ts';

export type ErrorCode =
  | 'NOT_CONFIGURED'
  | 'UNREACHABLE'
  | 'UNAUTHORIZED'
  | 'UNAVAILABLE'
  | 'NOT_SUPPORTED'
  | 'INCOMPATIBLE_SERVER'
  | 'INCOMPATIBLE_PLUGIN'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'BAD_RESPONSE'
  | 'INVALID_INPUT';

/** An error a tool reports to the model: a stable code, a message with no credential in it, and (when known) what the user can do. */
export class ServexaError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly status?: number;

  constructor(code: ErrorCode, message: string, options: { hint?: string; status?: number } = {}) {
    super(redact(message));
    this.name = 'ServexaError';
    this.code = code;
    this.hint = options.hint === undefined ? undefined : redact(options.hint);
    this.status = options.status;
  }
}
