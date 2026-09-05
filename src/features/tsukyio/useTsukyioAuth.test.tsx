import { act, renderHook } from "@testing-library/react";
import { mockInvoke } from "../../../tests/setup/tauri";
import { useTsukyioAuth } from "./useTsukyioAuth";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

const code = {
  device_code: "device-1", user_code: "TSK-1234",
  verification_uri: "https://tsukyio.com/activate",
  verification_uri_complete: "https://tsukyio.com/activate?code=TSK-1234",
  expires_in: 600, interval: 5,
};

beforeEach(() => {
  vi.useFakeTimers();
  mockInvoke("frontend_log", async () => {});
  mockInvoke("tsukyio_get_auth_state", async () => ({ isAuthenticated: false }));
  mockInvoke("tsukyio_cancel_device_auth", async () => {});
  mockInvoke("tsukyio_start_device_auth", async () => code);
});
afterEach(() => vi.useRealTimers());

it("does not show a code returned after cancellation", async () => {
  let finish!: (value: typeof code) => void;
  mockInvoke("tsukyio_start_device_auth", () => new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(useTsukyioAuth);
  let starting!: Promise<void>;
  await act(async () => { starting = result.current.startDeviceAuth(); });
  await act(async () => { result.current.cancelDeviceAuth(); });
  await act(async () => { finish(code); await starting; });
  expect(result.current.deviceFlow.status).toBe("idle");
});

it("stops and displays a denied authorization", async () => {
  mockInvoke("tsukyio_poll_device_auth", async () => ({ status: "pending", error: "access_denied" }));
  const { result } = renderHook(useTsukyioAuth);
  await act(async () => { await result.current.startDeviceAuth(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(result.current.deviceFlow).toEqual({ status: "error", message: "Authorization was denied on Tsukyio." });
  expect(vi.getTimerCount()).toBe(0);
});

it("waits longer after the server asks it to slow down", async () => {
  let polls = 0;
  mockInvoke("tsukyio_poll_device_auth", async () => {
    polls++;
    return { status: "pending", error: "slow_down" };
  });
  const { result } = renderHook(useTsukyioAuth);
  await act(async () => { await result.current.startDeviceAuth(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(polls).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(polls).toBe(2);
});

it("updates another mounted account view when sign-in changes", async () => {
  const { result } = renderHook(useTsukyioAuth);
  await act(async () => {});
  mockInvoke("tsukyio_get_auth_state", async () => ({ isAuthenticated: true, user: null }));
  await act(async () => { window.dispatchEvent(new Event("tsukyio-config-changed")); });
  expect(result.current.authState.isAuthenticated).toBe(true);
});

it("displays terminal server errors instead of polling until expiry", async () => {
  mockInvoke("tsukyio_poll_device_auth", async () => ({ status: "pending", error: "invalid_client", message: "Client unavailable" }));
  const { result } = renderHook(useTsukyioAuth);
  await act(async () => { await result.current.startDeviceAuth(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(result.current.deviceFlow).toEqual({ status: "error", message: "Client unavailable" });
});
