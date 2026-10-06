import { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import { errorMessage } from "../lib/api";
import { reloadInterface, reportRenderError } from "../shell/health/health";

interface Props {
  /** What this boundary protects, shown in the recovery card ("Missions view", "Right panel"…). */
  label: string;
  /** A new value clears a previous crash (e.g. the view name: navigating away retries). */
  resetKey?: unknown;
  /** Smaller card for narrow areas (right panel, workspace panels). */
  compact?: boolean;
  /** Replaces the inline recovery card (the root boundary shows the Safe Recovery Overlay). */
  fallback?: (error: Error, retry: () => void) => ReactNode;
  children: ReactNode;
}

interface State {
  error: Error | null;
  key: unknown;
}

/**
 * Contains a render crash to one part of the interface: the rest keeps working and the crashed
 * part shows a recovery card instead of a black area. Crashes are reported to the health monitor.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(errorMessage(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.key) ? null : { key: props.resetKey, error: null };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[NEXUS] ${this.props.label} crashed`, error, info.componentStack);
    reportRenderError(this.props.label, error);
  }

  retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.retry);
    return (
      <div className={`crash-card${this.props.compact ? " compact" : ""}`} role="alert">
        <div className="crash-head">
          <TriangleAlert size={16} aria-hidden="true" />
          <strong>{this.props.label} crashed</strong>
        </div>
        <p className="crash-text">
          Only this part of the interface failed. NEXUS is not stopped: agents, missions and MCP keep running in the engine.
        </p>
        <details className="crash-details">
          <summary>Error details</summary>
          <pre>{error.message}</pre>
        </details>
        <div className="crash-actions">
          <button className="btn btn-sm primary" onClick={this.retry}>
            <RotateCcw size={12} /> Retry
          </button>
          <button className="btn btn-sm" onClick={() => void reloadInterface("manual", `${this.props.label} crashed: ${error.message}`)}>
            <RefreshCw size={12} /> Reload interface
          </button>
        </div>
      </div>
    );
  }
}
