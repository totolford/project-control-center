// Client-generated keys for calls that must not run twice (double click, retried IPC call).

let counter = 0;

/** A key unique to this call site instance; the backend returns the first result for a repeated key. */
export function newIdempotencyKey(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  counter += 1;
  return `${random}-${counter}`;
}
