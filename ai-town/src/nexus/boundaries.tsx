// NEXUS addition: error boundaries of the embedded world.
//
// * CharacterBoundary wraps ONE character in the Pixi tree: if it throws
//   while rendering, the fallback (the default sprite, without decorations)
//   is drawn and the world goes on.
// * WorldBoundary wraps the whole view: on a crash it reports the context to
//   NEXUS (which saves it as a crash report and offers Recover View / Reload
//   World / Safe Mode / View Diagnostics) and shows a calm message. The AI
//   Town engine runs in Convex and is not affected.
import { Component, ErrorInfo, ReactNode } from 'react';

type CharacterProps = {
  playerId: string;
  /** Drawn instead of the character after an error. */
  fallback: ReactNode;
  onError: (playerId: string, error: unknown) => void;
  children: ReactNode;
};

export class CharacterBoundary extends Component<CharacterProps, { failed: boolean; fallbackFailed: boolean }> {
  state = { failed: false, fallbackFailed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    if (this.state.failed && !this.state.fallbackFailed) {
      this.props.onError(this.props.playerId, error);
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <FallbackGuard onFail={() => this.setState({ fallbackFailed: true })}>{this.state.fallbackFailed ? null : this.props.fallback}</FallbackGuard>;
  }
}

/** If even the fallback sprite fails, draw nothing for that character. */
class FallbackGuard extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFail();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

type WorldProps = {
  onCrash: (error: unknown, componentStack: string) => void;
  /** Shown instead of the world after a crash. */
  crashed: ReactNode;
  children: ReactNode;
};

export class WorldBoundary extends Component<WorldProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    try {
      this.props.onCrash(error, info.componentStack ?? '');
    } catch {
      // Reporting must never throw from the boundary.
    }
  }

  render() {
    return this.state.failed ? this.props.crashed : this.props.children;
  }
}
