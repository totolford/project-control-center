import { describe, expect, it } from "vitest";
import type { MarketEntry, MarketStatus } from "../../lib/types";
import {
  compactNumber,
  entryActions,
  inCategory,
  installScopes,
  matchesQuery,
  originLabel,
  parseRepos,
  shouldAutoRefresh,
  signalText,
  sortEntries,
  visibleEntries,
} from "./marketModel";

const entry = (over: Partial<MarketEntry> = {}): MarketEntry => ({
  id: "gh:acme/skills/lint",
  name: "lint",
  description: "Runs the linter",
  author: "acme",
  version: null,
  license: null,
  repository: "acme/skills",
  path: "lint",
  homepage: null,
  tags: [],
  categories: [],
  featured: false,
  sources: [{ id: "catalog", kind: "catalog", label: "NEXUS catalog" }],
  official: false,
  installMethod: "github-skill",
  pluginId: null,
  marketplace: null,
  marketplaceRepo: null,
  marketplaceConfigured: false,
  skills: [],
  permissions: [],
  requiredMcp: [],
  dependencies: [],
  compatibility: "",
  signal: null,
  lastUpdated: null,
  installed: false,
  enabled: null,
  discovery: null,
  installedSkillIds: [],
  installedDirs: [],
  installedVersion: null,
  installedScope: null,
  localPath: null,
  installedRef: null,
  remote: null,
  ...over,
});

const status = (over: Partial<MarketStatus> = {}): MarketStatus => ({ lastRefresh: null, gh: true, claude: true, project: true, ...over });
const NOW = Date.parse("2026-10-02T12:00:00Z");

describe("categories and filtering", () => {
  it("uses only real data for Featured / Popular / New", () => {
    expect(inCategory(entry({ featured: true }), "featured", NOW)).toBe(true);
    expect(inCategory(entry(), "popular", NOW)).toBe(false);
    expect(inCategory(entry({ signal: { kind: "github-stars", value: 3, label: "", fetchedAt: null } }), "popular", NOW)).toBe(true);
    expect(inCategory(entry({ lastUpdated: "2026-09-20T00:00:00Z" }), "new", NOW)).toBe(true);
    expect(inCategory(entry({ lastUpdated: "2026-01-01T00:00:00Z" }), "new", NOW)).toBe(false);
    expect(inCategory(entry(), "new", NOW)).toBe(false);
    expect(inCategory(entry({ categories: ["roblox"] }), "roblox", NOW)).toBe(true);
    expect(inCategory(entry({ installed: true }), "installed", NOW)).toBe(true);
  });

  it("matches every query word on name, description, tags and sources", () => {
    const e = entry({ tags: ["roblox"], skills: [{ name: "roblox-ui", description: "", path: "", allowedTools: [] }] });
    expect(matchesQuery(e, "LINT roblox")).toBe(true);
    expect(matchesQuery(e, "catalog")).toBe(true);
    expect(matchesQuery(e, "lint kubernetes")).toBe(false);
  });

  it("sorts popular by signal and keeps installed first otherwise", () => {
    const a = entry({ id: "a", name: "a", signal: { kind: "installs", value: 10, label: "", fetchedAt: null } });
    const b = entry({ id: "b", name: "b", signal: { kind: "github-stars", value: 99, label: "", fetchedAt: null } });
    const c = entry({ id: "c", name: "c", installed: true });
    expect(sortEntries([a, b, c], "popular").map((e) => e.id)).toEqual(["b", "a", "c"]);
    expect(sortEntries([a, b, c], "all").map((e) => e.id)).toEqual(["c", "a", "b"]);
    expect(visibleEntries([a, b, c], "all", "", NOW, new Set(["b"])).map((e) => e.id)).toEqual(["b"]);
  });
});

describe("labels", () => {
  it("never invents a rating and only Anthropic content is official", () => {
    expect(signalText(null)).toBeNull();
    expect(signalText({ kind: "github-stars", value: 132477, label: "", fetchedAt: null })).toBe("★ 132k");
    expect(signalText({ kind: "installs", value: 1261339, label: "", fetchedAt: null })).toBe("1.3M installs");
    expect(compactNumber(950)).toBe("950");
    expect(originLabel(entry())).toBe("Third-party");
    expect(originLabel(entry({ official: true }))).toBe("Official (Anthropic)");
    expect(originLabel(entry({ discovery: "discovered" }))).toBe("Discovered on disk");
  });
});

describe("actions", () => {
  const kinds = (a: ReturnType<typeof entryActions>) => a.filter((x) => x.available).map((x) => x.kind);

  it("offers install only through a working mechanism", () => {
    expect(kinds(entryActions(entry(), status()))).toEqual(["install"]);
    const noGh = entryActions(entry(), status({ gh: false }));
    expect(noGh[0]).toMatchObject({ kind: "install", available: false });
    expect(noGh[0].reason).toContain("gh");
    expect(kinds(entryActions(entry({ installMethod: "plugin", pluginId: "p@m" }), status({ gh: false })))).toEqual(["install"]);
  });

  it("wires installed plugins and NEXUS skills, explains the rest", () => {
    const plugin = entry({ installMethod: "plugin", pluginId: "p@m", installed: true, enabled: true });
    expect(kinds(entryActions(plugin, status()))).toEqual(["disable", "configure", "update", "uninstall"]);
    const nexus = entry({ installed: true, enabled: false, installedRef: "abc" });
    expect(kinds(entryActions(nexus, status()))).toEqual(["enable", "configure", "update", "uninstall"]);
    const local = entry({ installMethod: "local", installed: true, enabled: true, discovery: "discovered" });
    const la = entryActions(local, status());
    expect(kinds(la)).toEqual(["disable", "configure"]);
    expect(la.find((a) => a.kind === "uninstall")?.reason).toContain("Skills view");
    const synced = entry({ installMethod: "local", installed: true, enabled: true, sources: [{ id: "local:user", kind: "local", label: "Synced (claude.ai)" }] });
    expect(kinds(entryActions(synced, status()))).toEqual([]);
  });

  it("disables project scopes without a project", () => {
    expect(installScopes(entry(), status({ project: false })).map((s) => [s.value, s.available])).toEqual([
      ["user", true],
      ["project", false],
    ]);
    expect(installScopes(entry({ installMethod: "plugin" }), status()).map((s) => s.value)).toEqual(["user", "project", "local"]);
  });
});

describe("refresh and settings", () => {
  it("refreshes periodically only when enabled and stale", () => {
    expect(shouldAutoRefresh({ userRepos: [], autoRefresh: false }, null, NOW)).toBe(false);
    expect(shouldAutoRefresh({ userRepos: [], autoRefresh: true }, null, NOW)).toBe(true);
    expect(shouldAutoRefresh({ userRepos: [], autoRefresh: true }, "2026-10-02T06:00:00Z", NOW)).toBe(false);
    expect(shouldAutoRefresh({ userRepos: [], autoRefresh: true }, "2026-09-30T06:00:00Z", NOW)).toBe(true);
    expect(parseRepos(" a/b \n\nhttps://github.com/c/d, e/f")).toEqual(["a/b", "https://github.com/c/d", "e/f"]);
  });
});
