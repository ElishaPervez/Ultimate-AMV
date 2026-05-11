import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { logFrontend, safeLogValue } from "./lib/log";
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
