// Pure helpers of the AI Engines view and the AI Setup wizard (tested in aiLogic.test.ts).

import type {
  AiOverview,
  AiEngineSettings,
  AiMode,
  EngineProvider,
  LocalCapacity,
  ModelAssessment,
  Recommendation,
  RuntimeStatus,
} from "../../lib/aiTypes";

const RUNTIME_NAMES: Record<string, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
  openai: "OpenAI-compatible server",
};

export function runtimeName(id: string): string {
  return RUNTIME_NAMES[id] ?? id;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

export function formatMb(mb: number | null | undefined): string {
  if (mb == null) return "unknown";
  const gb = mb / 1024;
  return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` : `${mb} MB`;
}

export interface EngineLabel {
  /** "Claude", "Ollama", "Hybrid"... */
  provider: string;
  model: string;
  /** "Provider: Ollama · Model: qwen3:8b" */
  text: string;
  local: boolean;
}

/**
 * Engine an agent is configured for (before health checks): its own override,
 * else the project's default for its kind. `claudeModel` is the Claude model
 * it would use (agent or project default, `null` = Claude Code's default).
 */
export function engineLabel(
  ai: AiEngineSettings | undefined,
  kind: "central" | "worker",
  override: EngineProvider | null | undefined,
  claudeModel: string | null,
): EngineLabel {
  const chosen: EngineProvider = override ?? (ai ? (kind === "central" ? ai.central : ai.workers) : "claude");
  if (chosen === "claude" || !ai) {
    const model = claudeModel ?? "default";
    return { provider: "Claude", model, text: `Provider: Claude · Model: ${model}`, local: false };
  }
  const model = ai.local.model ?? "no model chosen";
  const rt = runtimeName(ai.local.runtime);
  if (chosen === "local") return { provider: rt, model, text: `Provider: ${rt} · Model: ${model}`, local: true };
  return { provider: "Hybrid", model, text: `Provider: Hybrid (router: Claude or ${rt} ${model})`, local: true };
}

/** Text of the "Local AI unavailable" banner, or null when nothing configured needs the local runtime. */
export function localUnavailable(ai: AiEngineSettings, cap: LocalCapacity | null): string | null {
  const usesLocal = ai.mode !== "claude" || ai.central !== "claude" || ai.workers !== "claude";
  if (!usesLocal || !cap || cap.available) return null;
  return cap.reason ?? "the local runtime does not answer";
}

// ---------------------------------------------------------------- downloads

export interface DownloadPlan {
  allowed: boolean;
  /** Why it is refused, when it is. */
  reason: string | null;
  size: string;
}

const DISK_MARGIN = 2e9;

/** Mirrors the backend check (catalog size + 2 GB margin must fit on the models' drive). */
export function downloadPlan(a: ModelAssessment, diskFreeMb: number | null): DownloadPlan {
  const size = formatBytes(a.model.sizeBytes);
  if (a.installed) return { allowed: false, reason: "already installed", size };
  if (diskFreeMb == null) return { allowed: false, reason: "free disk space unknown", size };
  if (diskFreeMb * 1024 * 1024 < a.model.sizeBytes + DISK_MARGIN)
    return { allowed: false, reason: `not enough disk space (${formatMb(diskFreeMb)} free, 2 GB kept free)`, size };
  if (a.fit === "too_large") return { allowed: false, reason: "does not fit in GPU memory + RAM", size };
  return { allowed: true, reason: null, size };
}

// ---------------------------------------------------------------- wizard

export const WIZARD_STEPS = [
  "welcome",
  "hardware",
  "runtimes",
  "models",
  "install",
  "download",
  "validate",
  "configure",
  "done",
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const STEP_LABELS: Record<WizardStep, string> = {
  welcome: "Welcome",
  hardware: "Hardware",
  runtimes: "Runtimes",
  models: "Models",
  install: "Install runtime",
  download: "Download model",
  validate: "Validate",
  configure: "Configure NEXUS",
  done: "AI Town",
};

export interface WizardState {
  step: WizardStep;
  /** Runtime chosen for local AI (Ollama is the only one Claude Code agents can use). */
  runtime: string;
  runtimeInstalled: boolean;
  runtimeAnswering: boolean;
  /** Chosen chat model, or null = Claude only (no local model). */
  model: string | null;
  modelInstalled: boolean;
  /** The model passed the real validation call. */
  validated: boolean;
  /** The configuration was saved. */
  configured: boolean;
}

export function initialWizard(): WizardState {
  return {
    step: "welcome",
    runtime: "ollama",
    runtimeInstalled: false,
    runtimeAnswering: false,
    model: null,
    modelInstalled: false,
    validated: false,
    configured: false,
  };
}

/** Steps that apply now: install/download/validate disappear when there is nothing to do. */
export function activeSteps(s: WizardState): WizardStep[] {
  return WIZARD_STEPS.filter((st) => {
    if (st === "install") return s.model !== null && !s.runtimeInstalled;
    if (st === "download") return s.model !== null && !s.modelInstalled;
    if (st === "validate") return s.model !== null;
    return true;
  });
}

/** Why the user cannot continue from the current step (null = can continue). */
export function blocker(s: WizardState): string | null {
  switch (s.step) {
    case "install":
      return s.runtimeInstalled ? null : `${runtimeName(s.runtime)} is not installed yet`;
    case "download":
      if (!s.runtimeAnswering) return `${runtimeName(s.runtime)} is not running`;
      return s.modelInstalled ? null : "the model is not downloaded yet";
    case "validate":
      return s.validated ? null : "the model has not been validated yet";
    case "configure":
      return s.configured ? null : "save the configuration first";
    default:
      return null;
  }
}

export function nextStep(s: WizardState): WizardStep {
  const steps = activeSteps(s);
  const i = steps.indexOf(s.step);
  return steps[Math.min(i + 1, steps.length - 1)] ?? "done";
}

export function prevStep(s: WizardState): WizardStep {
  const steps = activeSteps(s);
  const i = steps.indexOf(s.step);
  return steps[Math.max(i - 1, 0)] ?? "welcome";
}

/** "Step 3 of 8". */
export function stepPosition(s: WizardState): { index: number; total: number } {
  const steps = activeSteps(s);
  return { index: Math.max(steps.indexOf(s.step), 0) + 1, total: steps.length };
}

/** Default choice from the recommendation: the recommended model, installed or not. */
export function suggestedModel(r: Recommendation | null): string | null {
  return r?.recommended ?? null;
}

/** NEXUS configuration the wizard proposes for a choice. */
export function proposedSettings(
  base: AiEngineSettings,
  choice: { model: string | null; tools: boolean; runtime: RuntimeStatus | null; mode: AiMode; centralLocal: boolean },
): AiEngineSettings {
  if (!choice.model) return { ...base, mode: "claude", central: "claude", workers: "claude" };
  // Agents run through Claude Code, which needs tool calling and the Anthropic API.
  const agentsCanBeLocal = choice.tools && (choice.runtime?.anthropicApi ?? false);
  return {
    ...base,
    mode: choice.mode,
    central: agentsCanBeLocal && choice.centralLocal ? "local" : "claude",
    workers: agentsCanBeLocal && choice.mode === "hybrid" ? "hybrid" : agentsCanBeLocal && choice.mode === "local" ? "local" : "claude",
    local: { runtime: choice.runtime?.id ?? base.local.runtime, baseUrl: choice.runtime?.baseUrl ?? base.local.baseUrl, model: choice.model },
  };
}

// ---------------------------------------------------------------- settings checks

/**
 * Problems of a configuration against what the machine reports now. Agents run through Claude Code,
 * which needs tool calling and a runtime serving the Anthropic API (Ollama).
 */
export function engineWarnings(ai: AiEngineSettings, cap: LocalCapacity | null, runtimes: RuntimeStatus[]): string[] {
  const out: string[] = [];
  const agentsLocal = ai.central !== "claude" || ai.workers !== "claude";
  const usesLocal = agentsLocal || ai.mode !== "claude";
  if (!usesLocal) return out;
  if (!ai.local.model) out.push("No local model is selected.");
  if (agentsLocal) {
    if (ai.local.runtime !== "ollama") out.push(`Agents need a runtime serving the Anthropic API (Ollama); ${runtimeName(ai.local.runtime)} does not.`);
    else {
      const rt = runtimes.find((r) => r.id === "ollama");
      if (rt?.health.ok && !rt.anthropicApi) out.push("This Ollama version does not serve the Anthropic API (/v1/messages): update Ollama.");
    }
    if (cap?.available && !cap.tools)
      out.push(`${cap.model ?? "The local model"} has no tool calling: Central and workers cannot run on it (fine for AI Town dialogue). Choose a model with tools, e.g. qwen3:8b.`);
  }
  return out;
}

// ---------------------------------------------------------------- diagnostics

export interface RuntimeTreeNode {
  id: string;
  label: string;
  detail?: string;
  status?: { label: string; tone: "green" | "amber" | "red" | "grey" | "blue" | "dim" };
  children: RuntimeTreeNode[];
}

/** Diagnostics "AI runtimes" tree: each runtime with its process and models (configured runtime only). */
export function runtimeTree(o: Pick<AiOverview, "runtimes" | "models" | "settings" | "capacity">): RuntimeTreeNode[] {
  return o.runtimes.map((r) => {
    const configured = r.id === o.settings.local.runtime;
    const status = r.health.ok
      ? { label: "running", tone: "green" as const }
      : r.installed
        ? { label: configured ? "stopped" : "installed", tone: configured ? ("amber" as const) : ("grey" as const) }
        : { label: "not installed", tone: "dim" as const };
    const children: RuntimeTreeNode[] = [];
    if (r.managedPid) children.push({ id: `${r.id}.pid`, label: "Process", detail: `PID ${r.managedPid} · started by NEXUS`, children: [] });
    else if (r.health.ok) children.push({ id: `${r.id}.pid`, label: "Process", detail: "started outside NEXUS", children: [] });
    if (configured && r.health.ok)
      for (const m of o.models)
        children.push({
          id: `${r.id}.m.${m.name}`,
          label: m.name,
          detail: [formatBytes(m.sizeBytes), m.capabilities?.includes("tools") ? "tools" : null, m.name === o.settings.local.model ? "used by NEXUS" : null]
            .filter(Boolean)
            .join(" · "),
          status: m.loaded ? { label: "loaded", tone: "green" } : { label: "on disk", tone: "dim" },
          children: [],
        });
    if (configured && !o.capacity.available && o.capacity.reason)
      children.push({ id: `${r.id}.reason`, label: "Local AI unavailable", detail: o.capacity.reason, status: { label: "unavailable", tone: "red" }, children: [] });
    return {
      id: r.id,
      label: `${r.name}${configured ? " (configured)" : ""}`,
      detail: [r.version ? `v${r.version}` : null, r.health.ok ? `${r.health.latencyMs} ms` : null, r.baseUrl].filter(Boolean).join(" · "),
      status,
      children,
    };
  });
}
