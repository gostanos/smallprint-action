/**
 * The level-four reporter is a separate program in a separate language, and it
 * must produce exactly the hashes and kind labels the node CLI produces, or the
 * record would show a change the moment someone moved from level three to four.
 * This runs the shipped Python file with the system interpreter against a
 * fixture home and compares it with the node code path.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discover, toUpload } from "../src/discover";
import { readInstructionFiles } from "../src/instructions";

const PY = "/usr/bin/python3";
const HELPER = fileURLToPath(new URL("../report/smallprint-report.py", import.meta.url));

describe("level-four reporter parity", () => {
  it.skipIf(!existsSync(PY))("hashes the same files, kinds, sections and skill trees as the node CLI", () => {
    const home = mkdtempSync(join(tmpdir(), "sp-l4-"));
    mkdirSync(join(home, ".claude", "notes"), { recursive: true });
    mkdirSync(join(home, ".openclaw", "workspace"), { recursive: true });
    mkdirSync(join(home, ".openclaw", "skills", "pdf-tools", "scripts"), { recursive: true });
    mkdirSync(join(home, ".claude", "agents"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "Be careful. See @~/.claude/notes/a.md\n");
    writeFileSync(join(home, ".claude", "notes", "a.md"), "imported\n");
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git status:*)"] }, hooks: { PreToolUse: [] } }, null, 2));
    writeFileSync(join(home, ".claude", "agents", "reviewer.md"), "review things\n");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "ghp_x" } } }, projects: { "/Users/x/p": { mcpServers: { local: { command: "node", args: ["x.js"] } }, history: [1] } }, numStartups: 3 }));
    writeFileSync(join(home, ".openclaw", "workspace", "TOOLS.md"), "tools: none\n");
    writeFileSync(join(home, ".openclaw", "workspace", "SOUL.md"), "kind\n");
    writeFileSync(join(home, ".openclaw", "skills", "pdf-tools", "SKILL.md"), "---\nname: pdf-tools\n---\nExtract\n");
    writeFileSync(join(home, ".openclaw", "skills", "pdf-tools", "scripts", "extract.sh"), "#!/bin/sh\necho hi\n");

    const py = JSON.parse(execFileSync(PY, [HELPER, "--user", "nobody", "--label", "t", "--json", "--home", home], { encoding: "utf8" })) as { files: { path: string; kind: string; sha256: string; sections?: Record<string, string> }[]; items: Record<string, unknown>[] };
    const nodeFiles = readInstructionFiles(home, home).map((f) => ({ path: f.path, kind: f.kind, sha256: f.sha256, ...(f.sections ? { sections: f.sections } : {}) }));
    const nodeItems = toUpload(discover({ home, cwd: home }).items).filter((i) => i.kind === "agent-skill");
    const byPath = (xs: { path: string }[]) => Object.fromEntries(xs.map((x) => [x.path, x]));
    expect(Object.keys(byPath(py.files)).sort()).toEqual(Object.keys(byPath(nodeFiles)).sort());
    expect(byPath(py.files)).toEqual(byPath(nodeFiles));
    expect(py.items).toEqual(nodeItems);
    expect(py.files.map((f) => f.kind)).toContain("Claude Code CLAUDE.md import, home");
    expect(py.files.find((f) => f.kind === "Claude Code MCP servers, home")!.sections).toHaveProperty("github");
    expect(JSON.stringify(py)).not.toContain("ghp_x");
    // an imported file is hashed whole, never per key (both sides)
    const imported = py.files.find((f) => f.kind === "Claude Code CLAUDE.md import, home")!;
    expect(imported.sections).toBeUndefined();
  });

  it.skipIf(!existsSync(PY))("follows an @import only to a file inside the home directory, and never a json import's sections", () => {
    const home = mkdtempSync(join(tmpdir(), "sp-l4-imp-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "sp-l4-outside-"));
    writeFileSync(join(outside, "secret.json"), JSON.stringify({ port: 22, admin: true }));
    writeFileSync(join(home, ".claude", "inside.json"), JSON.stringify({ port: 22, admin: true }));
    // the import line is user-written text: it may name any path, and root must not hash what the user could not read
    writeFileSync(join(home, ".claude", "CLAUDE.md"), `See @${join(outside, "secret.json")} and @/etc/hosts and @~/.claude/inside.json\n`);
    const py = JSON.parse(execFileSync(PY, [HELPER, "--user", "nobody", "--label", "t", "--json", "--home", home], { encoding: "utf8" })) as { files: { path: string; kind: string; sections?: Record<string, string> }[] };
    const paths = py.files.map((f) => f.path);
    expect(paths).toContain(join(home, ".claude", "inside.json"));
    expect(paths).not.toContain(join(outside, "secret.json"));
    expect(paths).not.toContain("/etc/hosts");
    expect(py.files.find((f) => f.path.endsWith("inside.json"))!.sections).toBeUndefined();
  });
});
