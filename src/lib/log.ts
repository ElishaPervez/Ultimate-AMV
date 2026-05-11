import { invoke } from "@tauri-apps/api/core";

export function safeLogValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value == null) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

export function logFrontend(level: "info" | "warn" | "error", event: string, message: string, details?: Record<string, unknown>) {
  void invoke("frontend_log", {
    level,
    event,
    message,
    details: details ?? null,
  }).catch(() => undefined);
}
