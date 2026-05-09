export function parseBridgePayload<T>(raw: string): T {
  const line = raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1);
  return JSON.parse(line || raw) as T;
}

export function readBridgeError(error: unknown): string {
  const message = String(error instanceof Error ? error.message : error);
  try {
    const parsed = parseBridgePayload<{ message?: string }>(message);
    return parsed.message || message;
  } catch {
    return message;
  }
}
