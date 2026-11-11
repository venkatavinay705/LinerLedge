export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR', details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class InsufficientFundsError extends AppError {
  constructor(message = 'Insufficient funds for transaction') {
    super(message, 400, 'INSUFFICIENT_FUNDS');
  }
}

export class AccountFrozenError extends AppError {
  constructor(message = 'Account is frozen') {
    super(message, 400, 'ACCOUNT_FROZEN');
  }
}

export class AccountClosedError extends AppError {
  constructor(message = 'Account is closed') {
    super(message, 400, 'ACCOUNT_CLOSED');
  }
}

export class SelfTransferError extends AppError {
  constructor(message = 'Source and destination accounts must be distinct') {
    super(message, 400, 'SELF_TRANSFER_PROHIBITED');
  }
}

export class IdempotencyConflictError extends AppError {
  constructor(message = 'Idempotency key reused with different request payload') {
    super(message, 422, 'IDEMPOTENCY_CONFLICT');
  }
}
