import { describe, expect, it } from "vitest";
import { DEFAULT_AI_SETTINGS, type AiOverview, type LocalCapacity, type ModelAssessment, type RuntimeStatus } from "../../lib/aiTypes";
import {
  activeSteps,
  blocker,
  downloadPlan,
  engineLabel,
  engineWarnings,
  initialWizard,
  localUnavailable,
  nextStep,
  prevStep,
  proposedSettings,
  runtimeTree,
  stepPosition,
} from "./aiLogic";

const qwen: ModelAssessment = {
  model: {
    id: "qwen3:8b",
    name: "Qwen3 8B",
    family: "qwen3",
    sizeBytes: 5_225_388_164,
    context: 40_960,
    tools: true,
    vision: false,
    thinking: true,
    embedding: false,
    tier: "standard",
    goodFor: "",
    quality: 7,
  },
  installed: false,
  fit: "gpu",
  installable: true,
  memoryNeededMb: 5980,
  notes: [],
};

const ollama = { id: "ollama", baseUrl: "http://127.0.0.1:11434", anthropicApi: true } as RuntimeStatus;

describe("engineLabel", () => {
  it("shows Claude by default and the local runtime when chosen", () => {
    expect(engineLabel(DEFAULT_AI_SETTINGS, "central", null, "opus").text).toBe("Provider: Claude · Model: opus");
    const ai = { ...DEFAULT_AI_SETTINGS, central: "local" as const, local: { ...DEFAULT_AI_SETTINGS.local, model: "qwen3:8b" } };
    expect(engineLabel(ai, "central", null, null).text).toBe("Provider: Ollama · Model: qwen3:8b");
    // A per-agent override wins over the project default.
    expect(engineLabel(ai, "central", "claude", null).provider).toBe("Claude");
    expect(engineLabel(ai, "worker", "hybrid", null).provider).toBe("Hybrid");
    expect(engineLabel(undefined, "worker", null, null).provider).toBe("Claude");
  });

  it("raises the unavailable banner only when local AI is in use", () => {
    const down = { available: false, runtime: "ollama", model: "qwen3:8b", context: 0, tools: false, embeddingModel: null, reason: "Ollama is not answering" };
    expect(localUnavailable(DEFAULT_AI_SETTINGS, down)).toBeNull();
    expect(localUnavailable({ ...DEFAULT_AI_SETTINGS, mode: "hybrid" }, down)).toBe("Ollama is not answering");
    expect(localUnavailable({ ...DEFAULT_AI_SETTINGS, mode: "hybrid" }, { ...down, available: true })).toBeNull();
  });
});

describe("downloadPlan", () => {
  it("refuses downloads that do not fit on disk", () => {
    expect(downloadPlan(qwen, 15 * 1024).allowed).toBe(true);
    expect(downloadPlan(qwen, 15 * 1024).size).toBe("5.2 GB");
    expect(downloadPlan(qwen, 6 * 1024).reason).toMatch(/not enough disk space/);
    expect(downloadPlan(qwen, null).allowed).toBe(false);
    expect(downloadPlan({ ...qwen, installed: true }, 100_000).reason).toBe("already installed");
    expect(downloadPlan({ ...qwen, fit: "too_large" }, 100_000).allowed).toBe(false);
  });
});

describe("wizard", () => {
  it("skips install and download when there is nothing to do", () => {
    const s = { ...initialWizard(), model: "qwen3:8b", runtimeInstalled: true, modelInstalled: true };
    expect(activeSteps(s)).toEqual(["welcome", "hardware", "runtimes", "models", "validate", "configure", "done"]);
    expect(nextStep({ ...s, step: "models" })).toBe("validate");
    expect(prevStep({ ...s, step: "validate" })).toBe("models");
    expect(stepPosition({ ...s, step: "validate" })).toEqual({ index: 5, total: 7 });
  });

  it("goes straight to configuration for Claude only", () => {
    const s = { ...initialWizard(), step: "models" as const, model: null };
    expect(nextStep(s)).toBe("configure");
  });

  it("blocks until real work is done", () => {
    const s = { ...initialWizard(), model: "qwen3:8b" };
    expect(blocker({ ...s, step: "install" })).toMatch(/not installed/);
    expect(blocker({ ...s, step: "download", runtimeInstalled: true })).toMatch(/not running/);
    expect(blocker({ ...s, step: "download", runtimeAnswering: true })).toMatch(/not downloaded/);
    expect(blocker({ ...s, step: "validate" })).toMatch(/validated/);
    expect(blocker({ ...s, step: "validate", validated: true })).toBeNull();
    expect(blocker({ ...s, step: "hardware" })).toBeNull();
  });

  it("proposes agents on the local model only with tool calling and the Anthropic API", () => {
    const withTools = proposedSettings(DEFAULT_AI_SETTINGS, { model: "qwen3:8b", tools: true, runtime: ollama, mode: "hybrid", centralLocal: true });
    expect(withTools).toMatchObject({ mode: "hybrid", central: "local", workers: "hybrid", local: { model: "qwen3:8b" } });
    const noTools = proposedSettings(DEFAULT_AI_SETTINGS, { model: "llama3:latest", tools: false, runtime: ollama, mode: "hybrid", centralLocal: true });
    expect(noTools).toMatchObject({ mode: "hybrid", central: "claude", workers: "claude" });
    const claudeOnly = proposedSettings({ ...DEFAULT_AI_SETTINGS, mode: "local" }, { model: null, tools: false, runtime: null, mode: "local", centralLocal: false });
    expect(claudeOnly.mode).toBe("claude");
  });
});

const health = (ok: boolean) => ({ ok, version: ok ? "0.20.3" : null, latencyMs: 4, error: ok ? null : "connection refused" });
const runtime = (id: RuntimeStatus["id"], over: Partial<RuntimeStatus>): RuntimeStatus => ({
  id,
  name: id,
  description: "",
  wingetId: "",
  installed: false,
  executable: null,
  version: null,
  latestVersion: null,
  baseUrl: "http://127.0.0.1:1",
  health: health(false),
  managedPid: null,
  anthropicApi: false,
  notes: [],
  ...over,
});
const llama3: LocalCapacity = { available: true, runtime: "ollama", model: "llama3:latest", context: 8192, tools: false, embeddingModel: null, reason: null };

describe("engineWarnings", () => {
  it("says nothing on Claude only", () => {
    expect(engineWarnings(DEFAULT_AI_SETTINGS, llama3, [])).toEqual([]);
  });

  it("refuses agents on a model without tool calling or a runtime without the Anthropic API", () => {
    const ai = { ...DEFAULT_AI_SETTINGS, central: "local" as const, local: { ...DEFAULT_AI_SETTINGS.local, model: "llama3:latest" } };
    const ok = runtime("ollama", { installed: true, health: health(true), anthropicApi: true });
    expect(engineWarnings(ai, llama3, [ok]).join(" ")).toMatch(/no tool calling/);
    expect(engineWarnings(ai, { ...llama3, tools: true }, [ok])).toEqual([]);
    expect(engineWarnings(ai, { ...llama3, tools: true }, [{ ...ok, anthropicApi: false }]).join(" ")).toMatch(/update Ollama/);
    expect(engineWarnings({ ...ai, local: { ...ai.local, runtime: "lmstudio" } }, { ...llama3, tools: true }, []).join(" ")).toMatch(/LM Studio does not/);
    // AI Town / hybrid work only: a model without tools is fine.
    expect(engineWarnings({ ...DEFAULT_AI_SETTINGS, mode: "hybrid", local: ai.local }, llama3, [ok])).toEqual([]);
    expect(engineWarnings({ ...DEFAULT_AI_SETTINGS, mode: "hybrid" }, null, [])).toEqual(["No local model is selected."]);
  });
});

describe("runtimeTree", () => {
  it("shows each runtime with its process and the configured runtime's models", () => {
    const o: Pick<AiOverview, "runtimes" | "models" | "settings" | "capacity"> = {
      settings: { ...DEFAULT_AI_SETTINGS, local: { ...DEFAULT_AI_SETTINGS.local, model: "llama3:latest" } },
      capacity: llama3,
      runtimes: [
        runtime("ollama", { name: "Ollama", installed: true, version: "0.20.3", health: health(true), managedPid: 4242 }),
        runtime("lmstudio", { name: "LM Studio" }),
      ],
      models: [{ name: "llama3:latest", sizeBytes: 4_661_224_676, parameterSize: "8.0B", quantization: "Q4_0", family: "llama", loaded: true, capabilities: ["completion"] }],
    };
    const [ollamaNode, lms] = runtimeTree(o);
    expect(ollamaNode.label).toBe("Ollama (configured)");
    expect(ollamaNode.status?.label).toBe("running");
    expect(ollamaNode.children[0].detail).toBe("PID 4242 · started by NEXUS");
    expect(ollamaNode.children[1]).toMatchObject({ label: "llama3:latest", status: { label: "loaded" } });
    expect(ollamaNode.children[1].detail).toContain("used by NEXUS");
    expect(lms.status?.label).toBe("not installed");
    expect(lms.children).toEqual([]);
    const down = runtimeTree({ ...o, runtimes: [runtime("ollama", { name: "Ollama", installed: true })], capacity: { ...llama3, available: false, reason: "Ollama is not answering" } });
    expect(down[0].status?.label).toBe("stopped");
    expect(down[0].children.map((c) => c.detail)).toEqual(["Ollama is not answering"]);
  });
});
