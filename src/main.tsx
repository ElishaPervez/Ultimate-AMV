import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { logFrontend, safeLogValue } from "./lib/log";
import { startUiScaling } from "./lib/uiScale";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import { Root } from "./shell/Root";

function installFrontendLogHandlers() {
  window.addEventListener("error", (event) => {
    logFrontend("error", "frontend.window.error", event.message || "Unhandled frontend error", {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: safeLogValue(event.error),
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    logFrontend("error", "frontend.promise.unhandled_rejection", "Unhandled frontend promise rejection", {
      reason: safeLogValue(event.reason),
    });
  });
}

installFrontendLogHandlers();

// Started outside React so the very first paint — the tools gate and the
// setup wizard, both of which render before <Root/> settles — is already
// scaled to the window instead of snapping a frame later.
startUiScaling();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Top-level INSURANCE boundary: any catchable JS throw below degrades to a
        retry card + backend log instead of an unmounted (blank) tree. It cannot
        catch a WebView2 renderer-process crash — that is bounded in the clip grid. */}
    <ErrorBoundary name="app">
      <Root />
    </ErrorBoundary>
  </React.StrictMode>
);
