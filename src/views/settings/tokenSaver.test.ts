import { describe, expect, it } from "vitest";
import { DEFAULT_TOKEN_SAVER, nextStart, opusWorkers } from "./tokenSaver";

describe("token saver", () => {
  it("predicts resume, fresh session or new session like the engine", () => {
    expect(nextStart({ claudeSessionId: null, contextTokens: 500_000 }, DEFAULT_TOKEN_SAVER)).toBe("new");
    expect(nextStart({ claudeSessionId: "s", contextTokens: 40_000 }, DEFAULT_TOKEN_SAVER)).toBe("resume");
    expect(nextStart({ claudeSessionId: "s", contextTokens: 250_000 }, DEFAULT_TOKEN_SAVER)).toBe("fresh");
    expect(nextStart({ claudeSessionId: "s", contextTokens: null }, DEFAULT_TOKEN_SAVER)).toBe("resume");
    expect(nextStart({ claudeSessionId: "s", contextTokens: 250_000 }, { ...DEFAULT_TOKEN_SAVER, freshSessionAboveTokens: 0 })).toBe("resume");
  });

  it("counts workers on Opus only", () => {
    expect(
      opusWorkers([
        { kind: "central", model: "claude-opus-5-5", status: "waiting" },
        { kind: "worker", model: "claude-opus-5-5", status: "waiting" },
        { kind: "worker", model: "claude-sonnet-5-5", status: "waiting" },
        { kind: "worker", model: "claude-opus-5-5", status: "retired" },
      ]),
    ).toBe(1);
  });
});
