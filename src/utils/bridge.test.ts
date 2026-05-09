import test from "node:test";
import assert from "node:assert";
import { parseBridgePayload, readBridgeError } from "./bridge.ts";

test("parseBridgePayload - single line", () => {
  const input = '{"success": true, "count": 42}';
  const result = parseBridgePayload<{ success: boolean; count: number }>(input);
  assert.deepStrictEqual(result, { success: true, count: 42 });
});

test("parseBridgePayload - multi line", () => {
  const input = "some log line\nanother log line\n" + '{"type": "done", "value": 123}';
  const result = parseBridgePayload<{ type: string; value: number }>(input);
  assert.deepStrictEqual(result, { type: "done", value: 123 });
});

test("parseBridgePayload - trailing lines", () => {
  const input = '{"status": "ok"}\n\n  \n';
  const result = parseBridgePayload<{ status: string }>(input);
  assert.deepStrictEqual(result, { status: "ok" });
});

test("parseBridgePayload - invalid JSON", () => {
  const input = "not a json string";
  assert.throws(() => parseBridgePayload(input), SyntaxError);
});

test("readBridgeError - Error object", () => {
  const error = new Error("something went wrong");
  const result = readBridgeError(error);
  assert.strictEqual(result, "something went wrong");
});

test("readBridgeError - simple string", () => {
  const input = "simple error message";
  const result = readBridgeError(input);
  assert.strictEqual(result, "simple error message");
});

test("readBridgeError - JSON with message", () => {
  const input = '{"message": "error from backend", "code": 500}';
  const result = readBridgeError(input);
  assert.strictEqual(result, "error from backend");
});

test("readBridgeError - JSON without message", () => {
  const input = '{"error_code": 500}';
  const result = readBridgeError(input);
  assert.strictEqual(result, '{"error_code": 500}');
});

test("readBridgeError - multi line JSON", () => {
  const input = "traceback...\n" + '{"message": "internal error"}';
  const result = readBridgeError(input);
  assert.strictEqual(result, "internal error");
});

test("readBridgeError - invalid JSON", () => {
  const input = "invalid { json";
  const result = readBridgeError(input);
  assert.strictEqual(result, "invalid { json");
});
