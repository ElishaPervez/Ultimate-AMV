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

  const missingCount = mediaList.filter((m) => m.status === "missing").length;

  return createPortal(
    <div className="episode-label-backdrop" role="dialog" aria-label="Relink Missing Media">
      <div className="episode-label-modal" style={{ width: "min(680px, 94vw)", maxWidth: 680, gap: 16 }}>
        <div className="episode-label-header">
          <div>
            <span className="episode-label-kicker" style={{ color: "#f59e0b" }}>
              <FileWarning size={14} strokeWidth={2.2} style={{ color: "#f59e0b" }} /> Missing Media Files
            </span>
            <h2 style={{ margin: "4px 0 6px" }}>Relink Source Media</h2>
            <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.85, maxWidth: "100%" }}>
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

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 12px",
            borderRadius: 10,
            background: "rgba(255, 255, 255, 0.03)",
            border: "1px solid rgba(255, 255, 255, 0.06)",
          }}
        >
          <span style={{ fontSize: "0.82rem", color: "#8896a3", fontWeight: 600 }}>
            {missingCount === 0
              ? "All files found"
              : `${missingCount} missing ${missingCount === 1 ? "file" : "files"}`}
          </span>
          <button
            type="button"
            className="episode-label-secondary"
            onClick={handleScanFolder}
            style={{ padding: "6px 12px", fontSize: "0.82rem" }}
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
            padding: "2px 0",
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
                  padding: "10px 14px",
                  borderRadius: 10,
                  backgroundColor: isOk
                    ? "rgba(34, 197, 94, 0.04)"
                    : "rgba(245, 158, 11, 0.04)",
                  border: isOk
                    ? "1px solid rgba(34, 197, 94, 0.22)"
                    : "1px solid rgba(245, 158, 11, 0.28)",
                  gap: 14,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      display: "grid",
                      placeItems: "center",
                      backgroundColor: isOk
                        ? "rgba(34, 197, 94, 0.12)"
                        : "rgba(245, 158, 11, 0.12)",
                      flexShrink: 0,
                    }}
                  >
                    {isOk ? (
                      <FileCheck2 size={17} color="#22c55e" />
                    ) : (
                      <FileWarning size={17} color="#f59e0b" />
                    )}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontWeight: 650,
                        fontSize: "0.88rem",
                        color: "#eef3f8",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={fileNameStr}
                    >
                      {fileNameStr}
                    </div>
                    <div
                      style={{
                        fontSize: "0.76rem",
                        color: isOk ? "#22c55e" : "#8896a3",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        marginTop: 2,
                      }}
                      title={item.currentPath || item.source.path}
                    >
                      {item.currentPath || item.source.path}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  className="episode-label-secondary"
                  onClick={() => handleBrowseSingle(index)}
                  style={{
                    padding: "6px 12px",
                    fontSize: "0.8rem",
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

        <div className="episode-label-actions" style={{ marginTop: 6 }}>
          <div className="episode-label-actions-right">
            <button type="button" className="episode-label-cancel" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="episode-label-confirm"
              onClick={handleConfirm}
              disabled={!allResolved}
            >
              <FileCheck2 size={16} />
              Load Project
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
