import React from "react";
import { useClipRunProgressSnapshot } from "./clipRunProgressStore";

export type ClipRunStatusProps = {
  error: string | null;
  sceneCount: number;
  displayedClipCount: number;
  hasResult: boolean;
  isExtracting: boolean;
  featherweightActive: boolean;
  resolvedProxySources: readonly string[];
  gridPreview: boolean;
  readyPreviewCount: number;
  settledPreviewCount: number;
};

function formatStage(stage?: string): string {
  switch (stage) {
    case "starting": return "Starting";
    case "dependencies": return "Checking Dependencies";
    case "probe": return "Reading Source";
    case "decode": return "Decoding";
    case "analyze": return "Analyzing";
    case "scenes": return "Building Scenes";
    case "complete": return "Complete";
    default:
      return stage
        ? stage
          .split(/[-_\s]+/)
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" ")
        : "Ready";
  }
}

export function ClipRunStatus(props: ClipRunStatusProps) {
  const { detection, proxyBySource } = useClipRunProgressSnapshot();
  const resolved = React.useMemo(
    () => new Set(props.resolvedProxySources),
    [props.resolvedProxySources],
  );
  const proxyPercent = React.useMemo(() => {
    let lowest: number | null = null;
    for (const [source, percent] of Object.entries(proxyBySource)) {
      if (resolved.has(source)) continue;
      if (lowest === null || percent < lowest) lowest = percent;
    }
    return lowest;
  }, [proxyBySource, resolved]);
  const prepBar = React.useMemo(() => {
    if (props.featherweightActive) {
      if (proxyPercent === null && props.resolvedProxySources.length === 0) return null;
      if (proxyPercent === null) {
        return { label: "Preview proxy", percent: 100, indeterminate: false };
      }
      return {
        label: "Building preview proxy",
        percent: Math.max(0, Math.min(100, proxyPercent)),
        indeterminate: proxyPercent <= 0,
      };
    }
    if (!props.gridPreview || props.displayedClipCount === 0) return null;
    return {
      label: `Caching previews (${props.readyPreviewCount}/${props.displayedClipCount})`,
      percent: Math.round((props.settledPreviewCount / props.displayedClipCount) * 100),
      indeterminate: false,
    };
  }, [
    props.featherweightActive,
    props.resolvedProxySources.length,
    props.gridPreview,
    props.displayedClipCount,
    props.readyPreviewCount,
    props.settledPreviewCount,
    proxyPercent,
  ]);
  if (!detection && !props.error && !props.hasResult) return null;
  const detectionIndeterminate = props.isExtracting && (!detection || detection.percent <= 0);
  const message = props.error ?? (props.hasResult
    ? (props.featherweightActive
      ? `${props.displayedClipCount} scenes ready - live previews`
      : `${props.sceneCount} scenes ready`)
    : detection?.message ?? "");

  return (
    <div className={`clip-run-card glass ${props.error ? "is-error" : ""}`}>
      {(detection || props.error) && (
        <div className="clip-bar-row">
          <div className="clip-run-line">
            <strong>{props.error ? "Extraction failed" : formatStage(detection?.stage)}</strong>
            {detection && !props.error && <span>{Math.round(detection.percent)}%</span>}
          </div>
          {detection && !props.error && (
            <div className={`clip-progress-track ${detectionIndeterminate ? "is-indeterminate" : ""}`}>
              <span
                className="spring-motion"
                style={{ width: `${Math.max(0, Math.min(100, detection.percent))}%` }}
              />
            </div>
          )}
        </div>
      )}
      {!props.error && prepBar && (
        <div className="clip-bar-row">
          <div className="clip-run-line">
            <strong>{prepBar.label}</strong>
            {!prepBar.indeterminate && <span>{prepBar.percent}%</span>}
          </div>
          <div className={`clip-progress-track ${prepBar.indeterminate ? "is-indeterminate" : ""}`}>
            <span className="spring-motion" style={{ width: `${prepBar.percent}%` }} />
          </div>
        </div>
      )}
      <p>{message}</p>
    </div>
  );
}

export function ClipRunProgressMessage({ fallback }: { fallback: string }) {
  const { detection } = useClipRunProgressSnapshot();
  return <>{detection?.message ?? fallback}</>;
}
