import React from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, FolderOpen, Hash, Sparkles, Tv, X } from "lucide-react";

export type EpisodeLabelResult =
  | {
      mode: "anime-folder";
      animeTitle: string;
      episodeNumber: string;
      isNewFolder: boolean;
    }
  | {
      mode: "custom-dir";
      customDir: string;
      animeTitle: string;
      episodeNumber: string;
    };

export function EpisodeLabelModal({
  open,
  initialAnime,
  initialEpisode,
  downloadDir,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  initialAnime: string;
  initialEpisode: string;
  downloadDir?: string | null;
  onConfirm: (result: EpisodeLabelResult) => void;
  onCancel: () => void;
}) {
  const [folders, setFolders] = React.useState<string[]>([]);
  const [animeInput, setAnimeInput] = React.useState(initialAnime);
  const [episodeInput, setEpisodeInput] = React.useState(initialEpisode);
  const [customDir, setCustomDir] = React.useState<string | null>(null);
  const [showSuggestions, setShowSuggestions] = React.useState(false);
  const animeInputRef = React.useRef<HTMLInputElement | null>(null);
  const suggestionBlurRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setAnimeInput(initialAnime);
    setEpisodeInput(initialEpisode);
    setCustomDir(null);
    setShowSuggestions(false);
  }, [open, initialAnime, initialEpisode]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void invoke<string[]>("list_anime_folders", { downloadDir: downloadDir ?? undefined })
      .then((result) => {
        if (!cancelled) setFolders(result);
      })
      .catch(() => {
        if (!cancelled) setFolders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, downloadDir]);

  React.useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onCancel]);

  React.useEffect(() => {
    if (open) {
      const timer = window.setTimeout(() => animeInputRef.current?.focus(), 60);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [open]);

  const trimmedAnime = animeInput.trim();
  const trimmedEpisode = episodeInput.trim();
  const lowerInput = trimmedAnime.toLowerCase();
  const suggestions = React.useMemo(() => {
    if (folders.length === 0) return [];
    if (lowerInput.length === 0) return folders.slice(0, 12);
    return folders.filter((name) => name.toLowerCase().includes(lowerInput)).slice(0, 12);
  }, [folders, lowerInput]);

  const isNewFolder = trimmedAnime.length > 0
    && !folders.some((name) => name.toLowerCase() === lowerInput);
  const canSubmit = customDir
    ? trimmedEpisode.length > 0
    : trimmedAnime.length > 0 && trimmedEpisode.length > 0;

  function pickSuggestion(name: string) {
    setAnimeInput(name);
    setShowSuggestions(false);
    if (suggestionBlurRef.current !== null) {
      window.clearTimeout(suggestionBlurRef.current);
      suggestionBlurRef.current = null;
    }
  }

  async function pickCustomDir() {
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (typeof selected === "string" && selected.trim().length > 0) {
        setCustomDir(selected);
      }
    } catch {
      // User cancelled or picker failed : leave state untouched.
    }
  }

  function submit() {
    if (!canSubmit) return;
    if (customDir) {
      onConfirm({
        mode: "custom-dir",
        customDir,
        animeTitle: trimmedAnime || "Unknown anime",
        episodeNumber: trimmedEpisode,
      });
    } else {
      onConfirm({
        mode: "anime-folder",
        animeTitle: trimmedAnime,
        episodeNumber: trimmedEpisode,
        isNewFolder,
      });
    }
  }

  if (!open) return null;

  return createPortal(
    <div className="episode-label-backdrop" role="dialog" aria-label="Confirm episode details">
      <div className="episode-label-modal">
        <div className="episode-label-header">
          <div>
            <span className="episode-label-kicker">
              <Sparkles size={13} strokeWidth={2.2} /> Confirm download
            </span>
            <h2>Review download details</h2>
            <p>
              {customDir
                ? "Using a custom folder. Episode number still determines the filename."
                : "Detected values are pre-filled below. Edit anything that's wrong, then confirm to start the download."}
            </p>
          </div>
          <button type="button" className="episode-label-close" onClick={onCancel} aria-label="Cancel">
            <X size={16} />
          </button>
        </div>

        {customDir ? (
          <div className="episode-label-customdir">
            <FolderOpen size={18} strokeWidth={1.9} />
            <div>
              <small>Saving to</small>
              <strong>{customDir}</strong>
            </div>
            <button type="button" className="episode-label-link" onClick={() => setCustomDir(null)}>
              Use anime folder instead
            </button>
          </div>
        ) : downloadDir ? (
          <div className="episode-label-customdir is-default">
            <FolderOpen size={18} strokeWidth={1.9} />
            <div>
              <small>Saving to (default)</small>
              <strong>{downloadDir}\anime downloads\{trimmedAnime || "<anime name>"}</strong>
            </div>
          </div>
        ) : null}

        {!customDir && (
          <div className="episode-label-field">
            <label htmlFor="episode-label-anime">
              <Tv size={14} strokeWidth={2.1} /> Anime
            </label>
            <div className="episode-label-anime-wrap">
              <input
                ref={animeInputRef}
                id="episode-label-anime"
                value={animeInput}
                onChange={(event) => {
                  setAnimeInput(event.target.value);
                  setShowSuggestions(true);
                }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => {
                  if (suggestionBlurRef.current !== null) {
                    window.clearTimeout(suggestionBlurRef.current);
                  }
                  suggestionBlurRef.current = window.setTimeout(() => {
                    setShowSuggestions(false);
                  }, 120);
                }}
                placeholder="e.g. Attack on Titan"
                autoComplete="off"
                spellCheck={false}
              />
              {showSuggestions && suggestions.length > 0 && (
                <ul className="episode-label-suggestions" role="listbox">
                  {suggestions.map((name) => (
                    <li key={name}>
                      <button
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => pickSuggestion(name)}
                      >
                        {name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {trimmedAnime.length > 0 && (
              <small className={`episode-label-tag ${isNewFolder ? "is-new" : "is-existing"}`}>
                {isNewFolder ? "New folder will be created" : "Existing folder"}
              </small>
            )}
          </div>
        )}

        <div className="episode-label-field">
          <label htmlFor="episode-label-episode">
            <Hash size={14} strokeWidth={2.1} /> Episode number
          </label>
          <input
            id="episode-label-episode"
            value={episodeInput}
            onChange={(event) => setEpisodeInput(event.target.value)}
            placeholder="e.g. 12"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(event) => {
              if (event.key === "Enter" && canSubmit) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>

        <div className="episode-label-actions">
          {!customDir && (
            <button type="button" className="episode-label-secondary" onClick={() => void pickCustomDir()}>
              <FolderOpen size={15} strokeWidth={2.1} /> Save somewhere else…
            </button>
          )}
          <div className="episode-label-actions-right">
            <button type="button" className="episode-label-cancel" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="episode-label-confirm"
              disabled={!canSubmit}
              onClick={submit}
            >
              <CheckCircle2 size={15} strokeWidth={2.2} /> Start download
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
