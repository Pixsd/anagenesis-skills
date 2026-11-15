export type ErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "STALE_BASE"
  | "EVIDENCE_INVALID"
  | "VALIDATION_FAILED"
  | "STORE_BUSY"
  | "STORE_CORRUPT"
  | "IDEMPOTENCY_CONFLICT";
export class AnagenesisError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details: Record<string, unknown> = {},
    public retryable = code === "STORE_BUSY",
  ) {
    super(message);
    this.name = "AnagenesisError";
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}
export function fail(
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new AnagenesisError(code, message, details);
}
export function normalizeError(error: unknown): AnagenesisError {
  if (error instanceof AnagenesisError) return error;
  return new AnagenesisError(
    "STORE_CORRUPT",
    "Local I/O or integrity failure",
    { cause: error instanceof Error ? error.message : String(error) },
  );
}
export function exitCode(code: ErrorCode): number {
  if (code === "INVALID_INPUT") return 2;
  if (
    [
      "STALE_BASE",
      "ALREADY_EXISTS",
      "IDEMPOTENCY_CONFLICT",
      "STORE_BUSY",
    ].includes(code)
  )
    return 3;
  if (["EVIDENCE_INVALID", "VALIDATION_FAILED"].includes(code)) return 4;
  return 5;
}
