import React from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Minus, X } from "lucide-react";
import { logFrontend, safeLogValue } from "../lib/log";

export function WindowChrome() {
  const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  async function withWindow(action: (appWindow: ReturnType<typeof getCurrentWindow>) => Promise<void>) {
    if (!isDesktop) return;
    try {
      await action(getCurrentWindow());
    } catch (error) {
      console.error("Window action failed:", error);
      logFrontend("error", "frontend.window.action.error", "Window action failed", {
        error: safeLogValue(error),
      });
    }
  }

  function startWindowDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    void withWindow((appWindow) => appWindow.startDragging());
  }

  return (
    <div className="window-chrome">
      <div className="drag-zone" onPointerDown={startWindowDrag} />
      <div className="window-controls">
        <button
          type="button"
          aria-label="Minimize"
          onClick={() => withWindow((appWindow) => appWindow.minimize())}
        >
          <Minus size={15} />
        </button>
        <button
          type="button"
          aria-label="Maximize"
          onClick={() => withWindow((appWindow) => appWindow.toggleMaximize())}
        >
          <Maximize2 size={13} />
        </button>
        <button
          type="button"
          className="close-window"
          aria-label="Close"
          onClick={() => withWindow((appWindow) => appWindow.close())}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
