import React from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

type AcceptFn = (path: string) => boolean;
type DropHandler = (paths: string[]) => void;

interface Zone {
  el: HTMLElement;
  handlers: { onDrop: DropHandler; accept?: AcceptFn };
  setHover: (hover: boolean) => void;
}

const zones = new Set<Zone>();
let unlistenPromise: Promise<() => void> | null = null;

function pointInRect(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function topmostZone(x: number, y: number): Zone | null {
  // Iterate in registration order; later registrations win on overlap
  // (e.g. a modal cropper inside the settings panel).
  let match: Zone | null = null;
  for (const zone of zones) {
    if (!zone.el.isConnected) continue;
    const rect = zone.el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (pointInRect(x, y, rect)) match = zone;
  }
  return match;
}

function clearAllHover() {
  for (const zone of zones) zone.setHover(false);
}

function ensureListener() {
  if (unlistenPromise) return;
  unlistenPromise = getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "leave") {
      clearAllHover();
      return;
    }
    if (payload.type !== "over" && payload.type !== "drop") return;
    const dpr = window.devicePixelRatio || 1;
    const x = payload.position.x / dpr;
    const y = payload.position.y / dpr;
    const target = topmostZone(x, y);
    for (const zone of zones) zone.setHover(zone === target && payload.type === "over");
    if (payload.type === "drop" && target) {
      const accept = target.handlers.accept;
      const paths = accept ? payload.paths.filter(accept) : payload.paths.slice();
      if (paths.length > 0) target.handlers.onDrop(paths);
    }
  });
}

export function useFileDrop({
  onDrop,
  accept,
  enabled = true,
}: {
  onDrop: DropHandler;
  accept?: AcceptFn;
  enabled?: boolean;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = React.useState(false);
  const handlersRef = React.useRef<{ onDrop: DropHandler; accept?: AcceptFn }>({ onDrop, accept });
  handlersRef.current = { onDrop, accept };

  React.useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    const zone: Zone = {
      el,
      handlers: handlersRef.current,
      setHover,
    };
    // Keep zone.handlers pointed at the live ref so callers don't need to memoize.
    Object.defineProperty(zone, "handlers", {
      get: () => handlersRef.current,
    });
    zones.add(zone);
    ensureListener();
    return () => {
      zones.delete(zone);
      setHover(false);
    };
  }, [enabled]);

  return { ref, hover };
}

export function extensionAccept(extensions: string[]): AcceptFn {
  const allowed = new Set(extensions.map((ext) => ext.toLowerCase().replace(/^\./, "")));
  return (path: string) => {
    const dot = path.lastIndexOf(".");
    if (dot < 0) return false;
    return allowed.has(path.slice(dot + 1).toLowerCase());
  };
}
