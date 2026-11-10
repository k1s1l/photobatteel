/**
 * Expected business-rule violations. Their `code` maps to a localized message
 * that can be shown to the user as-is.
 */
export type DomainErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'USER_BLOCKED'
  | 'CONSENT_REQUIRED'
  | 'INVALID_STATE'
  | 'BATTLE_LIMIT'
  | 'NO_ACTIVE_BATTLE'
  | 'DUPLICATE_PHOTO'
  | 'INVALID_IMAGE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FORMAT'
  | 'DIMENSIONS'
  | 'VIDEO_TOO_LONG'
  | 'BATTLE_EXISTS'
  | 'SELF_VOTE'
  | 'VOTING_CLOSED'
  | 'NOT_SUBSCRIBED'
  | 'INSUFFICIENT_BALANCE'
  | 'PAYMENTS_DISABLED'
  | 'VOTING_STARTED'
  | 'FINAL_SPOT_UNAVAILABLE'
  | 'FINAL_SPOTS_TAKEN';

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    public readonly params: Record<string, string | number> = {},
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'DomainError';
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/** Prisma unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}
