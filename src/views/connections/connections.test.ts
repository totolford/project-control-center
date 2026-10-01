import { describe, expect, it } from "vitest";
import type { Connection } from "../../lib/types";
import { EMPTY_FORM, agentCapabilities, authSummary, buildInput, describeTarget, formFromConnection } from "./connectionModel";

const conn = (over: Partial<Connection>): Connection => ({
  id: "c",
  name: "C",
  kind: "docker",
  config: {},
  credentialRef: null,
  status: "unknown",
  statusDetail: null,
  lastChecked: null,
  createdAt: "",
  enabled: true,
  lastUsed: null,
  ...over,
});

describe("connection forms", () => {
  it("validates and builds SSH inputs", () => {
    const f = { ...EMPTY_FORM, name: "prod", host: "h.example", user: "deploy", keyPath: " C:\\k " };
    expect(buildInput("ssh", { ...f, host: "" })).toBe("Enter a host and a user.");
    expect(buildInput("ssh", { ...f, port: "70000" })).toContain("port");
    expect(buildInput("sftp", f)).toEqual({ name: "prod", kind: "sftp", config: { host: "h.example", port: 22, user: "deploy", auth: "key", keyPath: "C:\\k" } });
    expect(buildInput("ssh", { ...f, auth: "agent" })).toMatchObject({ config: { keyPath: null } });
  });

  it("puts tokens in secrets only", () => {
    const http = buildInput("http", { ...EMPTY_FORM, name: "api", baseUrl: "https://api.x", token: "t0k" });
    expect(http).toMatchObject({ kind: "http", config: { baseUrl: "https://api.x", authHeader: "Authorization" }, secrets: { token: "t0k" } });
    expect(JSON.stringify((http as { config: object }).config)).not.toContain("t0k");
    expect(buildInput("http", { ...EMPTY_FORM, name: "api", baseUrl: "api.x" })).toContain("URL");
    expect(buildInput("gitlab", { ...EMPTY_FORM, name: "gl", project: "group" })).toContain("group/project");
    expect(buildInput("gitlab", { ...EMPTY_FORM, name: "gl", project: "group/sub/app" })).toMatchObject({ secrets: undefined });
  });

  it("builds terminal inputs and requires a name", () => {
    expect(buildInput("terminal", { ...EMPTY_FORM, name: "t", shell: "wsl", distro: "Ubuntu" })).toEqual({ name: "t", kind: "terminal", config: { shell: "wsl", distro: "Ubuntu" } });
    expect(buildInput("terminal", { ...EMPTY_FORM, name: "t", shell: "zsh" })).toBe("Choose a shell.");
    expect(buildInput("docker", EMPTY_FORM)).toBe("Enter a name.");
  });

  it("round-trips stored configs into forms without secrets", () => {
    const f = formFromConnection(conn({ kind: "ssh", name: "s", config: { host: "h", port: 2222, user: "u", auth: "agent" }, credentialRef: "ref" }));
    expect(f).toMatchObject({ name: "s", host: "h", port: "2222", user: "u", auth: "agent", token: "" });
  });
});

describe("connection descriptions", () => {
  it("describes targets, auth and agent capabilities", () => {
    expect(describeTarget(conn({ kind: "gitlab", config: { project: "g/p" } }))).toBe("gitlab.com/g/p");
    expect(describeTarget(conn({ kind: "mcp", config: { transport: "http", url: "https://m" } }))).toBe("https://m");
    expect(authSummary(conn({ kind: "ssh", config: { auth: "password" } }), null)).toContain("not usable");
    expect(authSummary(conn({ kind: "http", credentialRef: "r" }), ["token"])).toBe("token in Credential Manager (token)");
    expect(agentCapabilities(conn({ id: "my-api", kind: "http", config: { baseUrl: "https://a" }, credentialRef: "r" }))).toContain("PCC_MY_API_TOKEN");
    expect(agentCapabilities(conn({ id: "fs", kind: "mcp" }))).toContain("mcp__fs__*");
  });
});
