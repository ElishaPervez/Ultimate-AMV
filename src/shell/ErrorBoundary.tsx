import React from "react";
import { logFrontend, safeLogValue } from "../lib/log";

/**
 * ErrorBoundary — minimal React error boundary.
 *
 * SCOPE: this is INSURANCE for a catchable JS throw during render/lifecycle of
 * the wrapped subtree. It degrades that throw into a small "something went
 * wrong" card with a Reload/Retry affordance and logs it to the backend, instead
 * of letting the throw blank the whole app (React unmounts the entire tree on an
 * uncaught render error).
 *
 * It CANNOT catch a WebView2/Chromium RENDERER-PROCESS death (e.g. the GPU /
 * decoder crash from exceeding Chromium's concurrent video-decoder limit) — that
 * is not a JS exception, so no JS handler ever runs. That class of failure is
 * bounded upstream by the central hard-capped offset-<video> mount set,
 * fast-fling suppression, and synchronous decoder release in the clip grid. Do
 * not present this boundary as the fix for the white-screen crash.
 */
type ErrorBoundaryProps = {
  /** A short label for the wrapped region, included in the log + fallback copy. */
  name?: string;
  children: React.ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
  message: string | null;
};

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: null };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const message = error instanceof Error ? error.message : String(error);
    return { hasError: true, message };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    logFrontend("error", "frontend.errorboundary.caught", "React error boundary caught a render error", {
      boundary: this.props.name ?? "app",
      error: safeLogValue(error),
      componentStack: info?.componentStack ?? null,
    });
  }

  private handleRetry = (): void => {
    // Clear the error so the subtree re-mounts and re-renders. If the underlying
    // condition persists the boundary simply re-catches and shows the card again.
    this.setState({ hasError: false, message: null });
  };

  private handleReload = (): void => {
    // Hard reload of the WebView document — the heavier reset when a retry alone
    // can't recover (e.g. corrupt module-level state).
    window.location.reload();
  };

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="error-boundary-fallback" role="alert">
        <div className="error-boundary-card">
          <h2>Something went wrong</h2>
          <p>
            {this.props.name ? `The ${this.props.name} ran into a problem.` : "This view ran into a problem."}{" "}
            You can retry, or reload the app.
          </p>
          {this.state.message && <pre className="error-boundary-detail">{this.state.message}</pre>}
          <div className="error-boundary-actions">
            <button type="button" className="install-btn" onClick={this.handleRetry}>
              Retry
            </button>
            <button type="button" className="install-btn is-secondary" onClick={this.handleReload}>
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
