/** Extracts the PostgreSQL SQLSTATE error code from a thrown value or its `cause`. */
export function pgErrorCode(e: unknown): string | null {
  let cur: unknown = e;
  for (let i = 0; i < 3 && cur && typeof cur === 'object'; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_INVALID_BYTE_SEQUENCE = '22021';
export const PG_NUMERIC_VALUE_OUT_OF_RANGE = '22003';
