// Conversion wizard state, validation and WorldSpec building (pure).

import type { Character, WorldAnalysis, WorldMode, WorldSpec } from "../../lib/types";

export type ProviderId = WorldSpec["provider"];
export type CharacterSource = "agents" | "roles" | "custom" | "generated";
export type StepId = "architecture" | "world" | "agents" | "characters" | "infrastructure" | "review";

export const STEPS: { id: StepId; label: string }[] = [
  { id: "architecture", label: "Architecture" },
  { id: "world", label: "World" },
  { id: "agents", label: "Agents" },
  { id: "characters", label: "Characters" },
  { id: "infrastructure", label: "Infrastructure" },
  { id: "review", label: "Review" },
];

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 5;

export const INFRA_KEYS = ["frontend", "backend", "database", "llm", "authentication", "deployment"] as const;
export type InfraKey = (typeof INFRA_KEYS)[number];

/** Choices per infrastructure field; the first one is the default. */
export function infraOptions(provider: ProviderId): Record<InfraKey, string[]> {
  if (provider === "custom") {
    return {
      frontend: ["Your world project"],
      backend: ["Your world project"],
      database: [".agent-project/ai-world (JSON)"],
      llm: ["None (native)", "Claude Code for conversations"],
      authentication: ["NEXUS (local)"],
      deployment: ["Your world project"],
    };
  }
  return {
    frontend: ["NEXUS canvas"],
    backend: ["NEXUS"],
    database: [".agent-project/ai-world (JSON)"],
    llm: ["None (native)", "Claude Code for conversations"],
    authentication: ["NEXUS (local)"],
    deployment: ["Inside NEXUS"],
  };
}

export function defaultInfrastructure(provider: ProviderId): Record<string, string> {
  const opts = infraOptions(provider);
  return Object.fromEntries(INFRA_KEYS.map((k) => [k, opts[k][0]]));
}

export interface WizardState {
  provider: ProviderId;
  name: string;
  description: string;
  environment: string;
  rules: string[];
  speed: number;
  mode: WorldMode;
  source: CharacterSource;
  characters: Character[];
  /** Custom world folder. */
  targetDir: string;
  infrastructure: Record<string, string>;
}

const PROVIDERS: ProviderId[] = ["nexus_native", "custom"];

export function asProvider(id: string): ProviderId {
  return (PROVIDERS as string[]).includes(id) ? (id as ProviderId) : "nexus_native";
}

export function initialWizard(projectName: string, analysis?: WorldAnalysis, characters: Character[] = []): WizardState {
  const provider = asProvider(analysis?.recommendedProvider ?? "nexus_native");
  return {
    provider,
    name: projectName ? `${projectName} Town` : "AI Town",
    description: projectName ? `The agents of ${projectName} at work.` : "",
    environment: "Agent campus",
    rules: [],
    speed: 2,
    mode: "hybrid",
    source: "agents",
    characters,
    targetDir: "",
    infrastructure: defaultInfrastructure(provider),
  };
}

/** Switching provider resets what only makes sense for that provider. */
export function withProvider(s: WizardState, provider: ProviderId): WizardState {
  return {
    ...s,
    provider,
    targetDir: provider === "custom" ? s.targetDir : "",
    infrastructure: defaultInfrastructure(provider),
  };
}

export interface Validation {
  errors: string[];
  warnings: string[];
}

export function validateStep(step: StepId, s: WizardState): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const linked = s.characters.filter((c) => c.nexusAgent).length;
  if (step === "architecture" || step === "review") {
    if (s.provider === "custom" && !s.targetDir.trim()) errors.push("Choose the folder of the custom world.");
  }
  if (step === "world" || step === "review") {
    if (!s.name.trim()) errors.push("The world needs a name.");
    if (!(s.speed >= MIN_SPEED && s.speed <= MAX_SPEED)) errors.push(`Speed must be between ${MIN_SPEED} and ${MAX_SPEED} ticks/s.`);
  }
  if (step === "agents" || step === "characters" || step === "review") {
    if (s.characters.length === 0) errors.push("Add at least one character.");
    if (s.mode !== "simulation" && s.characters.length > 0 && linked === 0) {
      warnings.push("No character is linked to a NEXUS agent: in this mode they will all be simulated.");
    }
  }
  if (step === "characters" || step === "review") {
    const names = new Set<string>();
    for (const c of s.characters) {
      if (!c.name.trim()) errors.push("Every character needs a name.");
      else if (names.has(c.name.trim().toLowerCase())) errors.push(`Two characters are named “${c.name.trim()}”.`);
      names.add(c.name.trim().toLowerCase());
    }
  }
  return { errors: [...new Set(errors)], warnings };
}

function cleanList(items: string[]): string[] {
  return items.map((i) => i.trim()).filter(Boolean);
}

export function buildSpec(s: WizardState): WorldSpec {
  const dir = s.targetDir.trim();
  return {
    name: s.name.trim(),
    description: s.description.trim(),
    provider: s.provider,
    mode: s.mode,
    environment: s.environment.trim() || null,
    rules: cleanList(s.rules),
    speed: s.speed,
    characters: s.characters.map((c) => ({
      ...c,
      name: c.name.trim(),
      goals: cleanList(c.goals),
      memory: cleanList(c.memory),
      relationships: c.relationships.filter((r) => r.with.trim() && r.kind.trim()),
    })),
    targetDir: s.provider === "custom" && dir ? dir : null,
    infrastructure: s.infrastructure,
  };
}
