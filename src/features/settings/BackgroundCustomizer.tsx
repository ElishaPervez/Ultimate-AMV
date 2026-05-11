import React from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { AlertTriangle, CheckCircle2, Image as ImageIcon, Loader2, Trash2, Upload, X } from "lucide-react";
import { DEFAULT_BG_STATE } from "../../lib/constants";
import { clampNumber } from "../../lib/numbers";
import { extensionAccept, useFileDrop } from "../../lib/useFileDrop";
import type { BackgroundState } from "../../types/app";
import { readBridgeError } from "../../utils/bridge";

const BG_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];
const bgImageAccept = extensionAccept(BG_IMAGE_EXTENSIONS);

export function BackgroundCustomizer({
  initial,
  onPreview,
  onCommit,
  onCancel,
}: {
  initial: BackgroundState;
  onPreview: (state: BackgroundState) => void;
  onCommit: (state: BackgroundState) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = React.useState<BackgroundState>(initial);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const frameRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const draftRef = React.useRef(draft);
  React.useEffect(() => { draftRef.current = draft; }, [draft]);

  const update = React.useCallback((patch: Partial<BackgroundState>) => {
    setDraft((current) => {
      const next = { ...current, ...patch };
      onPreview(next);
      return next;
    });
  }, [onPreview]);

  const previewUrl = draft.imagePath ? convertFileSrc(draft.imagePath) : "";

  async function ingestImagePath(source: string) {
    setError(null);
    setBusy(true);
    try {
      const savedPath = await invoke<string>("save_background_image", { source });
      update({
        imagePath: savedPath,
        scale: 1,
        offsetX: 50,
        offsetY: 50,
      });
    } catch (e) {
      setError(readBridgeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function chooseImage() {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Image", extensions: BG_IMAGE_EXTENSIONS }],
      });
      if (!selected || typeof selected !== "string") return;
      await ingestImagePath(selected);
    } catch (e) {
      setError(readBridgeError(e));
    }
  }

  const dropZone = useFileDrop({
    accept: bgImageAccept,
    enabled: !busy,
    onDrop: (paths) => {
      const first = paths[0];
      if (first) void ingestImagePath(first);
    },
  });

  async function clearImage() {
    setError(null);
    try {
      setBusy(true);
      await invoke("clear_background_image");
      update({ imagePath: "" });
    } catch (e) {
      setError(readBridgeError(e));
    } finally {
      setBusy(false);
    }
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!draft.imagePath) return;
    const frame = frameRef.current;
    if (!frame) return;
    frame.setPointerCapture(event.pointerId);
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      offsetX: draftRef.current.offsetX,
      offsetY: draftRef.current.offsetY,
    };
  }
  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const frame = frameRef.current;
    if (!drag || !frame) return;
    const rect = frame.getBoundingClientRect();
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    const scale = draftRef.current.scale;
    const nextX = clampNumber(drag.offsetX - (dx / rect.width) * 100 / scale, 0, 100);
    const nextY = clampNumber(drag.offsetY - (dy / rect.height) * 100 / scale, 0, 100);
    update({ offsetX: nextX, offsetY: nextY });
  }
  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    frameRef.current?.releasePointerCapture(event.pointerId);
  }
  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    if (!draft.imagePath) return;
    event.preventDefault();
    const delta = -event.deltaY * 0.0015;
    const next = clampNumber(draftRef.current.scale + delta, 1, 5);
    update({ scale: Number(next.toFixed(3)) });
  }

  function reset() {
    update({ ...DEFAULT_BG_STATE, imagePath: draft.imagePath });
  }

  async function apply() {
    setError(null);
    setBusy(true);
    try {
      const fields: Array<[string, string]> = [
        ["background_image", draft.imagePath],
        ["background_scale", String(draft.scale)],
        ["background_offset_x", String(draft.offsetX)],
        ["background_offset_y", String(draft.offsetY)],
        ["background_dim", String(Math.round(draft.dim))],
        ["background_blur", String(Math.round(draft.blur))],
      ];
      for (const [key, value] of fields) {
        await invoke<string>("set_config", { key, value });
      }
      onCommit(draft);
    } catch (e) {
      setError(readBridgeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-customizer-backdrop" role="dialog" aria-label="Background customizer">
      <div className="bg-customizer">
        <div className="bg-customizer-header">
          <span>Customize background</span>
          <button type="button" className="bg-customizer-close" onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div
          ref={(node) => {
            frameRef.current = node;
            dropZone.ref.current = node;
          }}
          className={`bg-cropper-frame drop-zone ${draft.imagePath ? "is-active" : "is-empty"}${dropZone.hover ? " is-drop-target" : ""}`}
          role={draft.imagePath ? undefined : "button"}
          tabIndex={draft.imagePath ? undefined : 0}
          onClick={draft.imagePath || busy ? undefined : () => void chooseImage()}
          onKeyDown={
            draft.imagePath
              ? undefined
              : (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    if (!busy) void chooseImage();
                  }
                }
          }
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
        >
          {draft.imagePath ? (
            <div
              className="bg-cropper-image"
              style={{
                backgroundImage: `url("${previewUrl}")`,
                backgroundPosition: `${draft.offsetX}% ${draft.offsetY}%`,
                transform: `scale(${draft.scale})`,
                filter: draft.blur > 0 ? `blur(${draft.blur * 0.4}px)` : undefined,
              }}
            />
          ) : (
            <div className="bg-cropper-empty">
              <ImageIcon size={28} strokeWidth={1.6} />
              <span>Click to pick an image · or drop one here</span>
            </div>
          )}
          {draft.imagePath && (
            <div
              className="bg-cropper-overlay"
              style={{ background: `rgba(5, 5, 7, ${draft.dim / 100})` }}
            />
          )}
          <div className="drop-zone-overlay">
            <Upload size={28} strokeWidth={1.8} />
            <span>Drop image to {draft.imagePath ? "replace" : "use"}</span>
            <small>PNG · JPG · WEBP · BMP · GIF</small>
          </div>
        </div>

        <div className="bg-customizer-hint">
          {draft.imagePath ? "Drag inside the frame to pan · scroll to zoom" : ""}
        </div>

        <div className="bg-customizer-controls">
          <label className="bg-control">
            <span>Zoom <em>{draft.scale.toFixed(2)}×</em></span>
            <input
              type="range"
              min={1}
              max={5}
              step={0.01}
              value={draft.scale}
              onChange={(e) => update({ scale: Number(e.currentTarget.value) })}
              disabled={!draft.imagePath}
            />
          </label>
          <label className="bg-control">
            <span>Dim <em>{Math.round(draft.dim)}%</em></span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={draft.dim}
              onChange={(e) => update({ dim: Number(e.currentTarget.value) })}
              disabled={!draft.imagePath}
            />
          </label>
          <label className="bg-control">
            <span>Blur <em>{Math.round(draft.blur)}px</em></span>
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={draft.blur}
              onChange={(e) => update({ blur: Number(e.currentTarget.value) })}
              disabled={!draft.imagePath}
            />
          </label>
        </div>

        {error && (
          <div className="settings-notice is-error">
            <AlertTriangle size={16} /> {error}
          </div>
        )}

        <div className="bg-customizer-actions">
          <div className="bg-customizer-actions-left">
            {draft.imagePath && (
              <button type="button" className="install-btn is-secondary" onClick={chooseImage} disabled={busy}>
                <ImageIcon size={16} strokeWidth={2.2} />
                <span>Replace image</span>
              </button>
            )}
            {draft.imagePath && (
              <button type="button" className="install-btn is-secondary" onClick={clearImage} disabled={busy}>
                <Trash2 size={16} strokeWidth={2.2} />
                <span>Remove</span>
              </button>
            )}
            {draft.imagePath && (
              <button type="button" className="install-btn is-secondary" onClick={reset} disabled={busy}>
                <span>Reset position</span>
              </button>
            )}
          </div>
          <div className="bg-customizer-actions-right">
            <button type="button" className="install-btn is-secondary" onClick={onCancel} disabled={busy}>
              <span>Cancel</span>
            </button>
            <button type="button" className="install-btn is-primary" onClick={() => void apply()} disabled={busy}>
              {busy ? <Loader2 size={16} className="audio-spin" /> : <CheckCircle2 size={16} strokeWidth={2.3} />}
              <span>{busy ? "Saving..." : "Apply"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
