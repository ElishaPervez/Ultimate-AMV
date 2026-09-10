import React from "react";
import { createPortal } from "react-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  FileCheck2,
  FileSearch,
  FileWarning,
  FolderSearch,
  X,
} from "lucide-react";
import {
  extractFilenameFromPath,
  scanFolderForFiles,
} from "../../lib/projectManifest";
import type { ResolvedSourceMedia } from "../../types/project";

export function RelinkMediaModal({
  open,
  sources,
  onResolve,
  onCancel,
}: {
  open: boolean;
  sources: ResolvedSourceMedia[];
  onResolve: (resolvedMap: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [mediaList, setMediaList] = React.useState<ResolvedSourceMedia[]>([]);

  React.useEffect(() => {
    if (open) {
      setMediaList(sources);
    }
  }, [open, sources]);

  React.useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const handleBrowseSingle = async (index: number) => {
    const item = mediaList[index];
    if (!item) return;

    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [
        { name: "Video Files", extensions: ["mp4", "mkv", "webm", "mov", "avi"] },
        { name: "All Files", extensions: ["*"] },
      ],
      title: `Locate ${item.source.filename || extractFilenameFromPath(item.source.path)}`,
    });

    if (selected && typeof selected === "string") {
      setMediaList((prev) => {
        const next = [...prev];
        next[index] = {
          ...next[index],
          currentPath: selected,
          status: "resolved",
        };
        return next;
      });
    }
  };

  const handleScanFolder = async () => {
    const selectedDir = await openDialog({
      multiple: false,
      directory: true,
      title: "Select Folder Containing Video Files",
    });

    if (!selectedDir || typeof selectedDir !== "string") return;

    const missingNames = mediaList
      .filter((m) => m.status === "missing")
      .map((m) => m.source.filename || extractFilenameFromPath(m.source.path));

    if (missingNames.length === 0) return;

    const matched = await scanFolderForFiles(selectedDir, missingNames);

    setMediaList((prev) =>
      prev.map((item) => {
        if (item.status === "resolved") return item;
        const name = item.source.filename || extractFilenameFromPath(item.source.path);
        const autoFound = matched[name] || matched[name.toLowerCase()];
        if (autoFound) {
          return {
            ...item,
            currentPath: autoFound,
            status: "resolved",
          };
        }
        return item;
      })
    );
  };

  const allResolved = mediaList.every((item) => item.status === "resolved");

  const handleConfirm = () => {
    const map: Record<string, string> = {};
    for (const item of mediaList) {
      if (item.currentPath) {
        map[item.source.path] = item.currentPath;
      }
    }
    onResolve(map);
  };

  return createPortal(
    <div className="episode-label-backdrop" role="dialog" aria-label="Relink Missing Media">
      <div className="episode-label-modal" style={{ maxWidth: 640 }}>
        <div className="episode-label-header">
          <div>
            <span className="episode-label-kicker" style={{ color: "#f59e0b" }}>
              <FileWarning size={14} strokeWidth={2.2} /> Missing Media Files
            </span>
            <h2 style={{ margin: "4px 0 6px" }}>Relink Source Media</h2>
            <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.85 }}>
              The project contains media files that were moved or created on another computer.
              Locate the corresponding files on this system to continue.
            </p>
          </div>
          <button
            type="button"
            className="episode-label-close"
            onClick={onCancel}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div style={{ margin: "14px 0 8px", display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="secondary-btn"
            onClick={handleScanFolder}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "0.82rem" }}
          >
            <FolderSearch size={15} />
            Scan Folder for Media
          </button>
        </div>

        <div
          style={{
            maxHeight: 280,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: "4px 0",
          }}
        >
          {mediaList.map((item, index) => {
            const fileNameStr =
              item.source.filename || extractFilenameFromPath(item.source.path);
            const isOk = item.status === "resolved";

            return (
              <div
                key={item.source.id || index}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 12px",
                  borderRadius: 8,
                  backgroundColor: "rgba(255, 255, 255, 0.04)",
                  border: isOk
                    ? "1px solid rgba(34, 197, 94, 0.25)"
                    : "1px solid rgba(245, 158, 11, 0.25)",
                  gap: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  {isOk ? (
                    <FileCheck2 size={18} color="#22c55e" style={{ flexShrink: 0 }} />
                  ) : (
                    <FileWarning size={18} color="#f59e0b" style={{ flexShrink: 0 }} />
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: "0.88rem",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {fileNameStr}
                    </div>
                    <div
                      style={{
                        fontSize: "0.75rem",
                        opacity: 0.6,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.currentPath || item.source.path}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => handleBrowseSingle(index)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 10px",
                    fontSize: "0.78rem",
                    flexShrink: 0,
                  }}
                >
                  <FileSearch size={14} />
                  {isOk ? "Change" : "Browse"}
                </button>
              </div>
            );
          })}
        </div>

        <div className="episode-label-actions" style={{ marginTop: 16 }}>
          <div className="episode-label-actions-right">
            <button type="button" className="episode-label-cancel" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-btn"
              onClick={handleConfirm}
              disabled={!allResolved}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                opacity: allResolved ? 1 : 0.5,
              }}
            >
              <FileCheck2 size={15} />
              Load Project
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
