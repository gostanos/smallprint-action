import { describe, expect, it } from "vitest";
import { DEFAULT_BASE, evaluateLocal, evaluateServer, failedWords, lookupWords, notifies, OWN_RECORD_LINE, plural, safeBase, userSetting, type Inspected, type RecordEntry } from "../src/core";
import { readFileSync } from "node:fs";

const entry = (over: Partial<RecordEntry> = {}): RecordEntry => ({
  asset: { canonicalName: "npm:@modelcontextprotocol/server-filesystem", displayName: "fs", latestVersion: "2026.7.10", url: "https://smallprint.dev/a/npm/fs" },
  advisories: [{ id: "GHSA-1", severity: "high", versionRange: "<2025.7.1", summary: "Path check.", url: "https://smallprint.dev/advisory/GHSA-1" }],
  releases: [
    { from: "2026.7.4", to: "2026.7.10", publishedAt: "2026-07-10", worst: "medium", identical: false, summary: "1 description", changes: [{ field: "tool.description", subject: "read_media_file", severity: "medium", severityRule: "drift.tool.description.imperative" }] },
    { from: "2026.1.14", to: "2026.7.4", publishedAt: "2026-07-04", worst: "info", identical: true, summary: "identical small print", changes: [] },
  ],
  ...over,
});

describe("a server watched against the record", () => {
  it("takes a baseline on the first check and reports only advisories that name the version here", () => {
    const r = evaluateServer("k", "filesystem", "2026.7.4", entry(), undefined);
    expect(r.findings).toEqual([]);
    expect(r.state.latestSeen).toBe("2026.7.10");
    const old = evaluateServer("k", "filesystem", "2025.6.0", entry(), undefined);
    expect(old.findings.map((f) => f.kind)).toEqual(["advisory"]);
  });

  it("reports a new release that changed the small print, once, and says whether this machine runs it", () => {
    const prev = evaluateServer("k", "filesystem", "2026.7.4", entry({ asset: { ...entry().asset, latestVersion: "2026.7.4" } }), undefined).state;
    const r = evaluateServer("k", "filesystem", "2026.7.4", entry(), prev);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ kind: "text-changed", grade: "medium" });
    expect(r.findings[0]!.detail).toContain("read_media_file");
    expect(r.findings[0]!.detail).toContain("You run 2026.7.4");
    expect(evaluateServer("k", "filesystem", "2026.7.4", entry(), r.state).findings).toEqual([]);
  });

  it("says an unpinned config can start another version, and predicts no start", () => {
    const prev = evaluateServer("k", "filesystem", null, entry({ asset: { ...entry().asset, latestVersion: "2026.7.4" }, advisories: [] }), undefined).state;
    const r = evaluateServer("k", "filesystem", null, entry({ advisories: [] }), prev);
    expect(r.findings[0]!.detail).toContain("Your config does not pin a version, so the version that starts can change.");
    expect(r.findings[0]!.detail).not.toContain("next start");
  });

  // pass 4 audit of 16 Oct 2026: mcp-remote 0.1.15 to 0.1.16, no release compared on record, and the extension said "no change"
  it("never says no change between two versions when nothing between them was compared", () => {
    const none = entry({ advisories: [], releases: [], asset: { ...entry().asset, latestVersion: "0.1.16" }, versions: [{ version: "0.1.16", publishedAt: "2025-07-10", read: true, contentHash: "b" }, { version: "0.1.15", publishedAt: "2025-07-01", read: true, contentHash: "a" }] });
    const moved = evaluateServer("k", "mcp-remote", "0.1.16", none, { canonicalName: "x", version: "0.1.15", latestSeen: "0.1.16", advisoriesSeen: [], checkedAt: "" }).findings;
    expect(moved).toEqual([expect.objectContaining({ kind: "you-upgraded", grade: "info", detail: "Their fingerprints differ, and the record has not compared every version in between, so whether the small print changed is not known." })]);
    // an answer that lists no versions says nothing about what was compared
    const bare = entry({ advisories: [], releases: [], asset: none.asset });
    expect(evaluateServer("k", "mcp-remote", "0.1.16", bare, { canonicalName: "x", version: "0.1.15", latestSeen: "0.1.16", advisoriesSeen: [], checkedAt: "" }).findings[0]!.detail).toBe("Whether its small print changed in between is not known.");
  });

  // pass 4 audit of 16 Oct 2026: an advisory with no range, or one the range rule cannot read, was said to name the version here
  it("does not say an advisory names the version here when its range is missing or cannot be read", () => {
    for (const versionRange of [null, "", "not a range"]) {
      const e = entry({ advisories: [{ id: "GHSA-2", severity: "high", versionRange, summary: "Path check.", url: "https://smallprint.dev/advisory/GHSA-2" }] });
      expect(evaluateServer("k", "filesystem", "2026.7.10", e, undefined).findings).toEqual([expect.objectContaining({ kind: "advisory", title: "GHSA-2 (high) names filesystem; whether it covers 2026.7.10 is not known" })]);
    }
    expect(evaluateServer("k", "filesystem", "2025.6.0", entry(), undefined).findings[0]!.title).toBe("GHSA-1 (high) covers filesystem 2025.6.0");
  });

  it("says what changed in between when this machine moved to another version", () => {
    const prev = { canonicalName: "x", version: "2026.7.4", latestSeen: "2026.7.10", advisoriesSeen: [], checkedAt: "" };
    const versions = [{ version: "2026.7.10", publishedAt: "2026-07-10", read: true, contentHash: "c" }, { version: "2026.7.4", publishedAt: "2026-07-04", read: true, contentHash: "b" }, { version: "2026.1.14", publishedAt: "2026-01-14", read: true, contentHash: "b" }];
    const r = evaluateServer("k", "filesystem", "2026.7.10", entry({ versions }), prev);
    expect(r.findings[0]).toMatchObject({ kind: "you-upgraded", grade: "medium" });
  });

  // pass 3 audit of 16 Oct 2026: @dimassetoid/strata-mcp 0.7.11 holds only an install script (postinstall, graded high),
  // and the extension said it "changed what it tells your agent"
  it("never calls an install script a change to what the server tells the agent, and grades the text by its own changes", () => {
    const script = { field: "install.script", subject: "postinstall", severity: "high", severityRule: "drift.install-script.added" };
    const only = entry({ advisories: [], releases: [{ from: "0.7.10", to: "0.7.11", publishedAt: "2026-10-14", worst: "high", identical: false, summary: "an install script added", changes: [script] }], asset: { ...entry().asset, latestVersion: "0.7.11" } });
    const prev = { canonicalName: "x", version: "0.7.10", latestSeen: "0.7.10", advisoriesSeen: [], checkedAt: "" };
    const r = evaluateServer("k", "strata", "0.7.10", only, prev);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ kind: "install-script", grade: "high", title: "strata 0.7.11 added an install script (postinstall)" });
    expect(JSON.stringify(r.findings)).not.toMatch(/tells your agent|small print/);
    const both = entry({ advisories: [], releases: [{ ...only.releases[0]!, changes: [script, { field: "tool.description", subject: "find", severity: "medium", severityRule: "drift.tool.description.changed" }] }], asset: only.asset });
    const f = evaluateServer("k", "strata", "0.7.10", both, prev).findings[0]!;
    expect(f).toMatchObject({ kind: "text-changed", grade: "medium" });
    expect(f.detail).toBe("1 change, worst medium (find). It also added an install script (postinstall). You run 0.7.10.");
    const versions = [{ version: "0.7.11", publishedAt: "2026-10-14", read: true, contentHash: "a" }, { version: "0.7.10", publishedAt: "2026-10-13", read: true, contentHash: "a" }];
    const moved = evaluateServer("k", "strata", "0.7.11", { ...only, versions }, { ...prev, latestSeen: "0.7.11" }).findings[0]!;
    expect(moved).toMatchObject({ kind: "you-upgraded", grade: "info", detail: "The record holds no change to its small print in between." });
  });

  it("decides notifications by the chosen level", () => {
    const f = { key: "a", kind: "text-changed" as const, grade: "medium" as const, title: "", detail: "" };
    expect(notifies(f, "high")).toBe(false);
    expect(notifies(f, "any")).toBe(true);
    expect(notifies({ ...f, kind: "file-changed" }, "high")).toBe(true);
    expect(notifies({ ...f, kind: "file-changed" }, "none")).toBe(false);
  });
});

describe("local watches", () => {
  it("treat a first sighting as a baseline and a new hash as a change", () => {
    expect(evaluateLocal("file-changed", "p", "CLAUDE.md", "aaa", undefined)).toBeNull();
    expect(evaluateLocal("file-changed", "p", "CLAUDE.md", "aaa", "aaa")).toBeNull();
    expect(evaluateLocal("file-changed", "p", "CLAUDE.md", "bbb", "aaa")?.title).toBe("CLAUDE.md changed outside this editor");
  });
});

describe("what counts as a change to the small print is the command's", () => {
  it("is imported from packages/cli/src/release.ts here, and the JetBrains plugin's copy holds the same fields", async () => {
    expect(readFileSync(new URL("../src/core.ts", import.meta.url), "utf8")).toContain('from "../../cli/src/release"');
    const { NOT_TEXT_CHANGE_FIELDS } = await import("../../cli/src/release");
    const kt = readFileSync(new URL("../../jetbrains/src/main/kotlin/dev/smallprint/jetbrains/core/Core.kt", import.meta.url), "utf8");
    const copy = /val NOT_TEXT_CHANGE_FIELDS = setOf\(([^)]*)\)/.exec(kt)?.[1]?.match(/"[^"]+"/g)?.map((x) => x.slice(1, -1));
    expect(copy?.sort()).toEqual([...NOT_TEXT_CHANGE_FIELDS].sort());
  });
});

describe("the version-range rule is the command's", () => {
  it("is imported from packages/cli/src/range.ts, the one implementation, and reads an exact-version list", () => {
    expect(readFileSync(new URL("../src/core.ts", import.meta.url), "utf8")).toContain('from "../../cli/src/range"');
    const malware = entry({ advisories: [{ id: "MAL-1", severity: "critical", versionRange: "0.0.0, 0.0.1", summary: "Malicious code.", url: "https://smallprint.dev/advisory/MAL-1" }] });
    expect(evaluateServer("k", "pkg", "0.0.1", malware, undefined).findings.some((f) => f.kind === "advisory")).toBe(true);
    expect(evaluateServer("k", "pkg", "0.0.2", malware, undefined).findings.some((f) => f.kind === "advisory")).toBe(false);
  });
});

describe("a repository cannot turn the lookup on or move it (security audit item 40, tools audit fix 7)", () => {
  it("marks lookup and baseUrl as application settings, and the base as https only", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string; contributes: { configuration: { properties: Record<string, { scope?: string; pattern?: string }> } } };
    const props = pkg.contributes.configuration.properties;
    expect(props["smallprint.lookup"]!.scope).toBe("application");
    expect(props["smallprint.baseUrl"]!.scope).toBe("application");
    expect(props["smallprint.baseUrl"]!.pattern).toBe("^https://");
    // the version the extension says in its requests is the package's
    expect(readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8")).toContain(`const VERSION = "${pkg.version}";`);
  });

  it("reads the user's own value and ignores a workspace's", () => {
    expect(userSetting({ defaultValue: "ask", globalValue: undefined, workspaceValue: "allow" } as Inspected<string>, "ask")).toBe("ask");
    expect(userSetting({ defaultValue: "ask", globalValue: "never" }, "ask")).toBe("never");
    expect(userSetting(undefined, "ask")).toBe("ask");
  });

  it("uses https only, with no credentials, and falls back to smallprint.dev", () => {
    expect(safeBase("https://smallprint.dev/")).toBe("https://smallprint.dev");
    expect(safeBase("http://anyone.example")).toBe(DEFAULT_BASE);
    expect(safeBase("https://user:pw@anyone.example")).toBe(DEFAULT_BASE);
    expect(safeBase("javascript:alert(1)")).toBe(DEFAULT_BASE);
    expect(safeBase("https://mirror.example/record")).toBe("https://mirror.example/record");
  });
});

// pass 5 audit of 16 Oct 2026: a failed lookup read "not on record yet", the footer called a 5xx or a 429 "did not
// answer", the tooltip said "1 MCP servers", and both READMEs promised a notice for any serious advisory naming the server
describe("the panel's words after a lookup, and the READMEs", () => {
  it("tells a 404 apart from a failed lookup, counts failures as failed, and says one in the singular", () => {
    expect(lookupWords(404)).toBe("not on record yet");
    expect(lookupWords(503)).toBe("the last lookup failed (HTTP 503)");
    expect(lookupWords(429)).toBe("the last lookup failed (HTTP 429)");
    expect(lookupWords(null)).toBe("the last lookup got no answer");
    expect(failedWords(1)).toBe("1 lookup failed; they are tried again at the next check.");
    expect(failedWords(2)).toBe("2 lookups failed; they are tried again at the next check.");
    expect(plural(1, "MCP server")).toBe("1 MCP server");
    const ext = readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");
    expect(ext).not.toMatch(/did not answer|: "not on record yet"|\$\{servers\.length\} MCP servers/);
    expect(ext).toContain("lookupWords(s.lookups[keyOf(x)] ?? null)");
    const kt = (p: string) => readFileSync(new URL(`../../jetbrains/src/main/kotlin/dev/smallprint/jetbrains/${p}`, import.meta.url), "utf8");
    expect(kt("SmallPrintService.kt")).not.toContain("did not answer");
    expect(kt("SmallPrintToolWindowFactory.kt")).toContain('else -> s.lookups[x.key] ?: "not looked up yet"');
    expect(kt("core/Core.kt")).toContain('404 -> "not on record yet"');
  });

  it("promise an advisory notice only for a range that covers, or may cover, the version here, and claim no reading of a server", () => {
    for (const p of ["../README.md", "../../jetbrains/README.md", "../../jetbrains/src/main/resources/META-INF/plugin.xml"]) {
      const text = readFileSync(new URL(p, import.meta.url), "utf8").replace(/\s+/g, " ");
      expect(text, p).toContain("security advisory's range covers, or may cover, the version you run.");
      expect(text, p).not.toMatch(/advisory names the server|reads the text a server or skill gives your agent/);
    }
  });
});

// pass 6 audit of 16 Oct 2026: the notices named one version where the record compared two (@vicsee/mcp-server's release
// 0.3.3 to 0.4.1 was "0.4.1 changed what it tells your agent", and a machine that moved from 0.4.0 was told its changes);
// said "no change in between" where the record never compared the versions (atom-mcp-server 1.1.0 and 2.1.0); said an
// advisory "names" a version its range covers; and showed Small Print's own incident record with no word whose it was
describe("what the record compared, said as it was compared (pass 6 audit)", () => {
  const vicsee = (): RecordEntry => ({
    asset: { canonicalName: "npm:@vicsee/mcp-server", displayName: "@vicsee/mcp-server", latestVersion: "0.4.1", url: "https://smallprint.dev/a/npm/@vicsee/mcp-server" },
    advisories: [],
    releases: [{ from: "0.3.3", to: "0.4.1", publishedAt: "2026-09-17T16:50:05Z", worst: "medium", identical: false, summary: "3 descriptions, 2 schemas, 1 tool added", changes: [{ field: "tool.description", subject: "vicsee_get_task", severity: "medium", severityRule: "drift.tool.description.changed" }, { field: "tool.added", subject: "vicsee_estimate", severity: "low", severityRule: "drift.tool.added" }] }],
    versions: [
      { version: "0.4.1", publishedAt: "2026-09-17T16:50:05Z", read: true, contentHash: "h2" },
      { version: "0.4.0", publishedAt: "2026-09-17T16:49:07Z", read: false, contentHash: null },
      { version: "0.3.6", publishedAt: "2026-09-16T10:00:00Z", read: false, contentHash: null },
      { version: "0.3.3", publishedAt: "2026-09-10T10:00:00Z", read: true, contentHash: "h1" },
    ],
  });

  it("names both versions a release compared, and does not give a machine inside them the release's changes", () => {
    const notice = evaluateServer("k", "@vicsee/mcp-server", "0.4.0", vicsee(), { canonicalName: "x", version: "0.4.0", latestSeen: "0.3.3", advisoriesSeen: [], checkedAt: "" }).findings[0]!;
    expect(notice.title).toBe("@vicsee/mcp-server's small print changed between 0.3.3 and 0.4.1");
    expect(notice.detail).toContain("You run 0.4.0, which lies between the two, so whether it holds these changes is not known.");
    const moved = evaluateServer("k", "@vicsee/mcp-server", "0.4.1", vicsee(), { canonicalName: "x", version: "0.4.0", latestSeen: "0.4.1", advisoriesSeen: [], checkedAt: "" }).findings;
    expect(moved).toEqual([expect.objectContaining({ kind: "you-upgraded", grade: "info", detail: "Whether its small print changed in between is not known: version 0.4.0 is on the record but its small print was not read." })]);
    expect(JSON.stringify(moved)).not.toMatch(/changes? to its small print in between|0\.4\.1 changed/);
  });

  it("says not compared, never no change, between two read versions whose fingerprints differ with a version no release reaches", () => {
    const atom: RecordEntry = {
      asset: { canonicalName: "npm:atom-mcp-server", displayName: "atom-mcp-server", latestVersion: "2.1.0", url: "https://smallprint.dev/a/npm/atom-mcp-server" },
      advisories: [],
      releases: [
        { from: "1.1.1", to: "1.1.2", publishedAt: "2026-08-03", worst: "info", identical: true, summary: "identical small print", changes: [] },
        { from: "1.1.0", to: "1.1.1", publishedAt: "2026-08-02", worst: "info", identical: true, summary: "identical small print", changes: [] },
      ],
      versions: [
        { version: "2.1.0", publishedAt: "2026-09-01", read: true, contentHash: "fe33a35b02" },
        { version: "1.1.2", publishedAt: "2026-08-03", read: true, contentHash: "eadc4bd608" },
        { version: "1.1.1", publishedAt: "2026-08-02", read: true, contentHash: "eadc4bd608" },
        { version: "1.1.0", publishedAt: "2026-08-01", read: true, contentHash: "eadc4bd608" },
      ],
    };
    const f = evaluateServer("k", "atom-mcp-server", "2.1.0", atom, { canonicalName: "x", version: "1.1.0", latestSeen: "2.1.0", advisoriesSeen: [], checkedAt: "" }).findings[0]!;
    expect(f.detail).toBe("Their fingerprints differ, and the record has not compared every version in between, so whether the small print changed is not known.");
  });

  it("says an advisory's range covers a version, and marks Small Print's own incident record as its own", () => {
    const remote = entry({ asset: { ...entry().asset, displayName: "mcp-remote" }, releases: [], advisories: [{ id: "CVE-2025-6514", severity: "critical", versionRange: ">= 0.0.5, < 0.1.16", summary: "OS command injection.", url: "https://smallprint.dev/advisory/CVE-2025-6514" }] });
    expect(evaluateServer("k", "mcp-remote", "0.1.15", remote, undefined).findings[0]!.title).toBe("CVE-2025-6514 (critical) covers mcp-remote 0.1.15");
    expect(evaluateServer("k", "mcp-remote", "0.1.15", remote, undefined).findings[0]!.detail).not.toContain("Small Print wrote");
    const own = entry({ releases: [], advisories: [{ id: "SP-2025-0001", severity: "critical", versionRange: ">=1.0.16", summary: "Koi Security reported that postmark-mcp 1.0.16 on npm sent a copy of outgoing email elsewhere.", url: "https://smallprint.dev/advisory/SP-2025-0001", source: "incident-backfill" }] });
    const f = evaluateServer("k", "postmark", "1.0.16", own, undefined).findings[0]!;
    expect(f.title).toBe("SP-2025-0001 (critical) covers postmark 1.0.16");
    expect(f.detail.startsWith(`${OWN_RECORD_LINE} Koi Security reported`)).toBe(true);
  });

  it("is said the same way by the JetBrains plugin, the README caption and the /cli page", () => {
    const kt = readFileSync(new URL("../../jetbrains/src/main/kotlin/dev/smallprint/jetbrains/core/Core.kt", import.meta.url), "utf8");
    expect(kt).toContain(`const val OWN_RECORD_LINE = "${OWN_RECORD_LINE}"`);
    expect(kt).toContain("Their fingerprints differ, and the record has not compared every version in between, so whether the small print changed is not known.");
    expect(kt).not.toMatch(/\$\{r\.to\} changed what it tells your agent|\) names \$names/);
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("A critical advisory's range covers the version of a server this machine runs:");
    expect(readme).not.toContain("advisory names the version");
    const cli = readFileSync(new URL("../../../apps/web/app/cli/page.tsx", import.meta.url), "utf8");
    expect(cli).not.toContain("advisory names the version you run");
  });
});
