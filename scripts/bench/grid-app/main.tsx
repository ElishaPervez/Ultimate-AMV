/* Bench-only entry: mounts the real Scene Splitter panel with the Tauri
 * backend replaced by tauriMock.ts. Built by vite.config.ts in this folder
 * (production React; GRID_BENCH_PROFILING=1 builds React's profiling variant
 * so every commit is recorded in window.__gridCommits).
 *
 * ?shell=1 mounts the whole desktop shell (sidebar, background, window chrome,
 * UI zoom) and opens the Scene Splitter, instead of the bare panel. */
import "./tauriMock";
import React from "react";
import ReactDOM from "react-dom/client";
import "../../../src/styles.css";
import { ClipExtractorPanel } from "../../../src/features/clips/ClipExtractorPanel";
import { App } from "../../../src/shell/App";
import { startUiScaling } from "../../../src/lib/uiScale";

type Commit = { phase: string; actualMs: number; at: number };
const commits: Commit[] = [];
(window as unknown as { __gridCommits: Commit[] }).__gridCommits = commits;

function onRender(_id: string, phase: string, actualDuration: number, _base: number, _start: number, commitTime: number) {
  commits.push({ phase, actualMs: actualDuration, at: commitTime });
}

const shell = new URLSearchParams(window.location.search).get("shell") === "1";
if (shell) startUiScaling();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <React.Profiler id="panel" onRender={onRender}>
      {shell ? (
        <App />
      ) : (
        <div className="panel-body" style={{ height: "100vh" }}>
          <div className="panel-view is-active">
            <ClipExtractorPanel active />
          </div>
        </div>
      )}
    </React.Profiler>
  </React.StrictMode>,
);

if (shell) {
  window.setTimeout(
    () => window.dispatchEvent(new CustomEvent("navigate-section", { detail: "clip-hunting" })),
    300,
  );
}
