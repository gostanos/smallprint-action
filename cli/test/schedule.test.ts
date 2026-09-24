import { describe, expect, it } from "vitest";
import { launchdPlist, schtasksCommand, systemdUnits, schedulePlan, systemLaunchdPlist, systemPaths, systemPlan, systemUnits } from "../src/schedule";

import { toFileUpload, projectScope, type InstructionFile } from "../src/instructions";

describe("level four, the root-owned reporter", () => {
  const p = systemPlan({ platform: "darwin", user: "nick", label: "mac mini", everyHours: 6 });
  it("runs the helper with the system interpreter from root-owned paths, with no token in the job file", () => {
    const { path, body } = systemLaunchdPlist(p);
    expect(path).toBe("/Library/LaunchDaemons/dev.smallprint.report.plist");
    expect(body).toContain("<string>/usr/bin/python3</string>");
    expect(body).toContain("<string>/Library/Application Support/smallprint/smallprint-report.py</string>");
    expect(body).toContain("<string>--token-file</string>\n    <string>/etc/smallprint/token</string>");
    expect(body).toContain("<key>UserName</key><string>root</string>");
    expect(body).not.toContain("sp_");
    expect(body).not.toContain("npx");
    const paths = systemPaths("darwin");
    expect(paths.token).toBe("/etc/smallprint/token");
    expect(paths.log).toBe("/var/log/smallprint-report.log");
  });
  it("writes root systemd units on Linux with a randomized start", () => {
    const u = systemUnits({ ...p, platform: "linux" });
    expect(u.service.path).toBe("/etc/systemd/system/smallprint-report.service");
    expect(u.service.body).toContain('ExecStart=/usr/bin/python3 /usr/lib/smallprint/smallprint-report.py --user "nick" --label "mac mini" --every 6 --base https://smallprint.dev --token-file /etc/smallprint/token');
    expect(u.service.body).toContain("User=root");
    expect(u.timer.body).toContain("RandomizedDelaySec=1800");
    expect(u.timer.body).toContain("OnUnitActiveSec=21600s");
  });
});
const plan = schedulePlan({ platform: "darwin", home: "/Users/nick", execPath: "/opt/homebrew/bin/node", version: "0.0.7", label: "work laptop", token: "sp_" + "0".repeat(48), everyHours: 6 });

describe("scheduled sync", () => {
  it("writes a launchd agent that runs the pinned CLI with the token in its own environment", () => {
    const { path, body } = launchdPlist(plan);
    expect(path).toBe("/Users/nick/Library/LaunchAgents/dev.smallprint.sync.plist");
    expect(body).toContain("<string>/opt/homebrew/bin/npx</string>");
    expect(body).toContain("<string>smallprint@0.0.7</string>");
    expect(body).toContain("<string>--scheduled</string>");
    expect(body).toContain("<string>--every</string>\n    <string>6</string>");
    expect(body).toContain("<string>work laptop</string>");
    expect(body).toContain("<key>StartInterval</key><integer>21600</integer>");
    expect(body).toContain("<key>SMALLPRINT_TOKEN</key><string>sp_");
  });
  it("writes systemd user units and a schtasks command", () => {
    const u = systemdUnits({ ...plan, platform: "linux", home: "/home/nick", nodeDir: "/usr/bin" });
    expect(u.timer.path).toBe("/home/nick/.config/systemd/user/smallprint-sync.timer");
    expect(u.service.body).toContain('ExecStart=/usr/bin/npx -y smallprint@0.0.7 sync --yes --quiet --scheduled --every 6 --label "work laptop"');
    expect(u.timer.body).toContain("OnUnitActiveSec=21600s");
    expect(schtasksCommand({ ...plan, platform: "win32" })).toContain('/SC HOURLY /MO 6');
  });
  it("clamps the interval to one to twenty-four hours", () => {
    expect(schedulePlan({ home: "/h", execPath: "/n/node", version: "1", label: "l", token: "t", everyHours: 0 }).everySeconds).toBe(3600);
    expect(schedulePlan({ home: "/h", execPath: "/n/node", version: "1", label: "l", token: "t", everyHours: 99 }).everySeconds).toBe(86400);
  });
});

describe("file upload", () => {
  it("sends a hash of the path, the kind, the scope and the content hash, never the path", () => {
    const files: InstructionFile[] = [
      { host: "openclaw", path: "/Users/nick/.openclaw/workspace/TOOLS.md", kind: "OpenClaw TOOLS.md, home", scope: "home", sha256: "a".repeat(64), bytes: 10 },
      { host: "codex", path: "/Users/nick/proj/AGENTS.md", kind: "Codex AGENTS.md, project", scope: "project", sha256: "b".repeat(64), bytes: 10 },
    ];
    const up = toFileUpload(files, "/Users/nick/proj");
    expect(JSON.stringify(up)).not.toContain("/Users");
    expect(up.files.map((f) => f.scope)).toEqual(["home", projectScope("/Users/nick/proj")]);
    expect(up.scopes).toEqual(["home", projectScope("/Users/nick/proj")]);
    expect(up.files[0]!.pathHash).toMatch(/^[0-9a-f]{64}$/);
    expect(projectScope("/Users/nick/proj")).toMatch(/^project:[0-9a-f]{12}$/);
  });
});

describe("skill tree hash and CLAUDE.md imports", () => {
  it("moves the tree hash when a helper script changes under an unchanged SKILL.md", async () => {
    const { treeHash } = await import("../src/parse");
    const { createHash } = await import("node:crypto");
    const h = (x: string) => createHash("sha256").update(x).digest("hex");
    const a = treeHash([{ path: "scripts/x.sh", sha256: "1".repeat(64) }, { path: "SKILL.md", sha256: "a".repeat(64) }], h);
    const b = treeHash([{ path: "SKILL.md", sha256: "a".repeat(64) }, { path: "scripts/x.sh", sha256: "1".repeat(64) }], h);
    const c = treeHash([{ path: "SKILL.md", sha256: "a".repeat(64) }, { path: "scripts/x.sh", sha256: "2".repeat(64) }], h);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    const { toUpload } = await import("../src/discover");
    const up = toUpload([{ kind: "agent-skill", host: "openclaw", name: "s", path: "/x", displayName: null, description: null, files: [{ path: "SKILL.md", sha256: "a".repeat(64) }], skillMdSha256: "a".repeat(64) }]);
    expect(up[0]).toMatchObject({ treeSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(up)).not.toContain('"files"');
  });
  it("hashes the files CLAUDE.md imports, three levels deep, under the parent's kind", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { claudeImports, readInstructionFiles } = await import("../src/instructions");
    const home = mkdtempSync(join(tmpdir(), "sp-imp-"));
    const cwd = mkdtempSync(join(tmpdir(), "sp-imp-cwd-"));
    mkdirSync(join(home, ".claude", "notes"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "Read @~/.claude/notes/a.md and @./notes/b.md first. Not an import: user@example.com, @scoped/package.\n");
    writeFileSync(join(home, ".claude", "notes", "a.md"), "a imports @./c.md\n");
    writeFileSync(join(home, ".claude", "notes", "b.md"), "b\n");
    writeFileSync(join(home, ".claude", "notes", "c.md"), "c\n");
    expect(claudeImports("x @~/one.md y @./two.md z @/abs.md", "/from", "/h")).toEqual(["/h/one.md", "/from/two.md", "/abs.md"]);
    const files = readInstructionFiles(home, cwd);
    expect(files.map((f) => [f.path.replace(home, "~"), f.kind])).toEqual([
      ["~/.claude/CLAUDE.md", "Claude Code CLAUDE.md, home"],
      ["~/.claude/notes/a.md", "Claude Code CLAUDE.md import, home"],
      ["~/.claude/notes/c.md", "Claude Code CLAUDE.md import, home"],
      ["~/.claude/notes/b.md", "Claude Code CLAUDE.md import, home"],
    ]);
  });
});
