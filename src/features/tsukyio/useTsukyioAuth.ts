import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { logFrontend, safeLogValue } from "../../lib/log";
import type {
  TsukyioAuthState,
  TsukyioDeviceAuthStartResponse,
  TsukyioUserProfile,
} from "../../types/tsukyio";

export type DeviceAuthFlowState =
  | { status: "idle" }
  | {
      status: "prompt";
      userCode: string;
      deviceCode: string;
      verificationUri: string;
      verificationUriComplete: string;
      expiresAt: number;
    }
  | { status: "polling"; userCode: string }
  | { status: "error"; message: string };

export function useTsukyioAuth() {
  const [authState, setAuthState] = React.useState<TsukyioAuthState>({
    isAuthenticated: false,
    user: null,
    expiresAt: null,
  });
  const [loading, setLoading] = React.useState(true);
  const [deviceFlow, setDeviceFlow] = React.useState<DeviceAuthFlowState>({ status: "idle" });

  const pollTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPollRef = React.useRef(false);

  // Load current auth status from backend
  const checkAuth = React.useCallback(async () => {
    try {
      const state = await invoke<TsukyioAuthState>("tsukyio_get_auth_state");
      setAuthState(state);
      return state;
    } catch (e) {
      logFrontend("warn", "tsukyio.auth.check_error", "Failed to check Tsukyio auth state", {
        error: safeLogValue(e),
      });
      setAuthState({ isAuthenticated: false, user: null, expiresAt: null });
      return { isAuthenticated: false, user: null, expiresAt: null };
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  // Clean up polling timer on unmount
  React.useEffect(() => {
    return () => {
      cancelPollRef.current = true;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
    };
  }, []);

  const cancelDeviceAuth = React.useCallback(() => {
    cancelPollRef.current = true;
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setDeviceFlow({ status: "idle" });
  }, []);

  const startDeviceAuth = React.useCallback(async () => {
    cancelPollRef.current = false;
    setDeviceFlow({ status: "idle" });
    try {
      const data = await invoke<TsukyioDeviceAuthStartResponse>("tsukyio_start_device_auth");
      const intervalMs = Math.max((data.interval || 5) * 1000, 3000);
      const expiresAt = Date.now() + (data.expires_in || 600) * 1000;

      setDeviceFlow({
        status: "prompt",
        userCode: data.user_code,
        deviceCode: data.device_code,
        verificationUri: data.verification_uri || "https://tsukyio.com/activate",
        verificationUriComplete:
          data.verification_uri_complete || `https://tsukyio.com/activate?code=${data.user_code}`,
        expiresAt,
      });

      // Automatically launch the verification URL in the system browser
      const openTarget = data.verification_uri_complete || `https://tsukyio.com/activate?code=${data.user_code}`;
      void openUrl(openTarget).catch(() => {});

      // Begin polling loop
      const poll = async () => {
        if (cancelPollRef.current) return;
        if (Date.now() > expiresAt) {
          setDeviceFlow({ status: "error", message: "Authorization expired. Please try again." });
          return;
        }

        try {
          const res = await invoke<{
            status: string;
            user?: TsukyioUserProfile;
            error?: string;
            message?: string;
          }>("tsukyio_poll_device_auth", { deviceCode: data.device_code });

          if (cancelPollRef.current) return;

          if (res.status === "success") {
            setDeviceFlow({ status: "idle" });
            await checkAuth();
            window.dispatchEvent(new Event("tsukyio-config-changed"));
            return;
          }

          if (res.error === "authorization_declined") {
            setDeviceFlow({ status: "error", message: "Authorization was denied on Tsukyio." });
            return;
          }

          if (res.error === "expired_token") {
            setDeviceFlow({ status: "error", message: "Code expired. Please generate a new one." });
            return;
          }

          // Continue polling
          pollTimerRef.current = setTimeout(poll, intervalMs);
        } catch (pollErr) {
          if (cancelPollRef.current) return;
          pollTimerRef.current = setTimeout(poll, intervalMs);
        }
      };

      pollTimerRef.current = setTimeout(poll, intervalMs);
    } catch (err: any) {
      logFrontend("error", "tsukyio.auth.start_error", "Failed to start Tsukyio device authorization", {
        error: safeLogValue(err),
      });
      setDeviceFlow({
        status: "error",
        message: typeof err === "string" ? err : err?.message || "Failed to start Tsukyio authorization.",
      });
    }
  }, [checkAuth]);

  const disconnect = React.useCallback(async () => {
    try {
      await invoke("tsukyio_disconnect");
      setAuthState({ isAuthenticated: false, user: null, expiresAt: null });
      window.dispatchEvent(new Event("tsukyio-config-changed"));
    } catch (e) {
      logFrontend("warn", "tsukyio.auth.disconnect_error", "Failed to disconnect Tsukyio account", {
        error: safeLogValue(e),
      });
    }
  }, []);

  return {
    authState,
    loading,
    deviceFlow,
    startDeviceAuth,
    cancelDeviceAuth,
    disconnect,
    checkAuth,
  };
}
