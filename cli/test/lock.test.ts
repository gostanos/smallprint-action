import { describe, expect, it } from "vitest";
import { buildLock, diffIsEmpty, diffLock, displayPath, formatDiff, parseLock, projectItems } from "../src/lock";

const item = (over: Record<string, unknown> = {}) => ({ kind: "mcp" as const, host: "claude-code", name: "fs", canonicalName: "npm:@modelcontextprotocol/server-filesystem", version: "1.0.0", ...over });
const skill = (over: Record<string, unknown> = {}) => ({ kind: "agent-skill" as const, host: "openclaw", name: "self-improving-agent", canonicalName: null, version: null, skillMdSha256: "a".repeat(64), treeSha256: "b".repeat(64), ...over });
const file = (path: string, sha: string) => ({ host: "claude-code" as const, path, kind: "CLAUDE.md, project", scope: "project" as const, sha256: sha, bytes: 10 });

describe("lockfile", () => {
  it("writes a sorted lock with display paths, round-trips, and diffs versions, skill files, instruction files and presence", () => {
    const home = "/Users/nick";
    const cwd = "/Users/nick/proj";
    const lock = buildLock([skill(), item()] as never[], [file("/Users/nick/proj/CLAUDE.md", "1".repeat(64)), file("/Users/nick/.claude/CLAUDE.md", "2".repeat(64))] as never[], { now: new Date("2026-09-12T00:00:00Z"), home, cwd });
    expect(lock.items.map((i) => i.name)).toEqual(["self-improving-agent", "fs"]);
    expect(lock.files.map((f) => f.path).sort()).toEqual(["CLAUDE.md", "~/.claude/CLAUDE.md"]);
    expect(displayPath("/etc/x", home, cwd)).toBe("/etc/x");
    const again = parseLock(JSON.stringify(lock));
    expect(diffIsEmpty(diffLock(lock, again))).toBe(true);
    const moved = buildLock([skill({ treeSha256: "c".repeat(64) }), item({ version: "1.1.0" }), item({ name: "new-one", canonicalName: "npm:new-one" })] as never[], [file("/Users/nick/proj/CLAUDE.md", "9".repeat(64))] as never[], { home, cwd });
    const d = diffLock(lock, moved);
    expect(d.changed.map((c) => c.what)).toEqual(["skill files changed", "version 1.0.0 -> 1.1.0"]);
    expect(d.added.map((i) => i.name)).toEqual(["new-one"]);
    expect(d.filesChanged.map((f) => f.path)).toEqual(["CLAUDE.md"]);
    expect(d.filesMissing.map((f) => f.path)).toEqual(["~/.claude/CLAUDE.md"]);
    const lines = formatDiff(d);
    expect(lines.some((l) => l.startsWith("  CHANGED  fs (claude-code, 1.0.0): version 1.0.0 -> 1.1.0"))).toBe(true);
    expect(lines.some((l) => l.includes("MISSING  ~/.claude/CLAUDE.md"))).toBe(true);
    expect(() => parseLock("{}")).toThrow(/not a smallprint lock/);
    for (const l of lines) expect(l).not.toMatch(/—/);
    expect(lock.scope).toBe("machine");
    // a lock from 0.0.12 has no scope and is a machine lock
    expect(parseLock(JSON.stringify({ ...lock, scope: undefined })).scope).toBe("machine");
  });

  it("a project lock keeps only what lives under the working directory, so a CI runner with an empty home compares equal", () => {
    const home = "/Users/nick";
    const cwd = "/Users/nick/proj";
    const homeFile = { host: "claude-code" as const, path: "/Users/nick/.claude/CLAUDE.md", kind: "Claude Code CLAUDE.md, home", scope: "home" as const, sha256: "2".repeat(64), bytes: 1 };
    const projFile = { host: "claude-code" as const, path: "/Users/nick/proj/CLAUDE.md", kind: "Claude Code CLAUDE.md, project", scope: "project" as const, sha256: "1".repeat(64), bytes: 1 };
    const discovered = [
      { kind: "mcp" as const, host: "claude-code" as const, name: "fs", configPath: "/Users/nick/.claude.json", transport: "stdio" as const, canonicalName: "npm:fs", version: "1", remoteHost: null, hygiene: [] },
      { kind: "mcp" as const, host: "claude-code" as const, name: "proj-server", configPath: "/Users/nick/proj/.mcp.json", transport: "stdio" as const, canonicalName: "npm:proj-server", version: "2", remoteHost: null, hygiene: [] },
      { kind: "agent-skill" as const, host: "claude-code" as const, name: "sk", path: "/Users/nick/proj/.claude/skills/sk", displayName: null, description: null, files: [], skillMdSha256: "a".repeat(64) },
    ];
    expect(projectItems(discovered, cwd).map((i) => i.name)).toEqual(["proj-server", "sk"]);
    const onLaptop = buildLock([{ kind: "mcp", host: "claude-code", name: "proj-server", canonicalName: "npm:proj-server", version: "2" }] as never[], [homeFile, projFile], { home, cwd, scope: "project" });
    expect(onLaptop.scope).toBe("project");
    expect(onLaptop.files.map((f) => f.path)).toEqual(["CLAUDE.md"]);
    // the runner: a different home, the same repository at a different path, nothing under the home
    const onRunner = buildLock([{ kind: "mcp", host: "claude-code", name: "proj-server", canonicalName: "npm:proj-server", version: "2" }] as never[], [{ ...projFile, path: "/home/runner/work/proj/proj/CLAUDE.md" }], { home: "/home/runner", cwd: "/home/runner/work/proj/proj", scope: "project" });
    expect(diffIsEmpty(diffLock(onLaptop, onRunner))).toBe(true);
    // paths in a lock use forward slashes whatever wrote them
    expect(displayPath("/Users/nick/proj/.claude/agents/x.md", home, cwd)).toBe(".claude/agents/x.md");
  });
});
