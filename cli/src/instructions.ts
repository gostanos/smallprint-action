/**
 * Instruction and settings files: the text an agent reads before it does
 * anything. CLAUDE.md, AGENTS.md, an OpenClaw workspace's TOOLS.md and SOUL.md,
 * Cursor and Windsurf rules, and the settings files where hooks live. None of
 * these are published anywhere, so there is no catalog to compare them with:
 * the only baseline is this machine's last run. Hashes are kept in the local
 * state file and nothing here is ever uploaded.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Host } from "./parse";

export interface InstructionLocation {
  host: Host;
  path: string;
  /** What the file is, in words a person recognises: the only name the server ever sees. */
  kind: string;
  /** "home" for files under the home directory, "project" for files under the working directory. */
  scope: "home" | "project";
  /** A directory whose files are each recorded (Cursor and Windsurf rules folders). */
  dir?: boolean;
  /** MCP config files: hash the server definitions, not the raw file, so a state-heavy file like ~/.claude.json does not move every run and env values are hashed rather than the text that holds them. */
  digest?: "mcp-json";
}

export interface InstructionFile {
  host: Host;
  path: string;
  kind: string;
  scope: "home" | "project";
  sha256: string;
  bytes: number;
  /** For JSON settings files: a hash per top-level section, so a change can be named. */
  sections?: Record<string, string>;
}

export interface InstructionRecord {
  sha256: string;
  /** ISO date the file was first recorded. */
  seen: string;
  /** ISO date of the last recorded change, if any. */
  changed?: string;
  changes?: number;
  sections?: Record<string, string>;
}

export type InstructionBaseline = Record<string, InstructionRecord>;

export type InstructionStatus =
  | { status: "new"; file: InstructionFile }
  | { status: "unchanged"; file: InstructionFile; since: string }
  | { status: "changed"; file: InstructionFile; previous: string; since: string; changes: number; /** Sections that differ, when both runs had section hashes. */ where?: string[] }
  | { status: "removed"; path: string; previous: string; since: string };

const FILE_MAX_BYTES = 5_000_000;
const DIR_MAX_FILES = 200;

export function instructionLocations(home = homedir(), cwd = process.cwd()): InstructionLocation[] {
  const openclaw = (root: string): InstructionLocation[] => ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md", "BOOTSTRAP.md", "MEMORY.md"].map((f) => ({ host: "openclaw" as const, path: join(root, f), kind: `OpenClaw ${f}, home`, scope: "home" as const }));
  return [
    { host: "claude-code", path: join(home, ".claude", "CLAUDE.md"), kind: "Claude Code CLAUDE.md, home", scope: "home" },
    { host: "claude-code", path: join(home, ".claude", "settings.json"), kind: "Claude Code settings.json, home", scope: "home" },
    { host: "claude-code", path: join(cwd, "CLAUDE.md"), kind: "Claude Code CLAUDE.md, project", scope: "project" },
    { host: "claude-code", path: join(cwd, "CLAUDE.local.md"), kind: "Claude Code CLAUDE.local.md, project", scope: "project" },
    { host: "claude-code", path: join(cwd, ".claude", "CLAUDE.md"), kind: "Claude Code .claude/CLAUDE.md, project", scope: "project" },
    { host: "claude-code", path: join(cwd, ".claude", "settings.json"), kind: "Claude Code settings.json, project", scope: "project" },
    { host: "claude-code", path: join(cwd, ".claude", "settings.local.json"), kind: "Claude Code settings.local.json, project", scope: "project" },
    { host: "codex", path: join(home, ".codex", "AGENTS.md"), kind: "Codex AGENTS.md, home", scope: "home" },
    { host: "codex", path: join(cwd, "AGENTS.md"), kind: "Codex AGENTS.md, project", scope: "project" },
    { host: "cursor", path: join(cwd, ".cursorrules"), kind: "Cursor .cursorrules, project", scope: "project" },
    { host: "cursor", path: join(cwd, ".cursor", "rules"), kind: "Cursor rules file, project", scope: "project", dir: true },
    { host: "windsurf", path: join(home, ".codeium", "windsurf", "memories", "global_rules.md"), kind: "Windsurf global rules, home", scope: "home" },
    { host: "windsurf", path: join(cwd, ".windsurfrules"), kind: "Windsurf .windsurfrules, project", scope: "project" },
    { host: "windsurf", path: join(cwd, ".windsurf", "rules"), kind: "Windsurf rules file, project", scope: "project", dir: true },
    { host: "claude-code", path: join(home, ".claude", "agents"), kind: "Claude Code agent definition, home", scope: "home", dir: true },
    { host: "claude-code", path: join(cwd, ".claude", "agents"), kind: "Claude Code agent definition, project", scope: "project", dir: true },
    { host: "claude-code", path: join(home, ".claude", "commands"), kind: "Claude Code command, home", scope: "home", dir: true },
    { host: "claude-code", path: join(cwd, ".claude", "commands"), kind: "Claude Code command, project", scope: "project", dir: true },
    { host: "manual", path: join(cwd, ".github", "copilot-instructions.md"), kind: "Copilot instructions, project", scope: "project" },
    { host: "manual", path: join(home, ".gemini", "GEMINI.md"), kind: "Gemini GEMINI.md, home", scope: "home" },
    { host: "manual", path: join(cwd, "GEMINI.md"), kind: "Gemini GEMINI.md, project", scope: "project" },
    { host: "manual", path: join(cwd, ".clinerules"), kind: "Cline .clinerules, project", scope: "project" },
    { host: "manual", path: join(cwd, ".roo", "rules"), kind: "Roo rules file, project", scope: "project", dir: true },
    // the MCP configs themselves: a server's command, args, URL or env changed under the same name
    { host: "claude-desktop", path: process.platform === "win32" ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json") : join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), kind: "Claude Desktop MCP servers, home", scope: "home", digest: "mcp-json" },
    { host: "claude-code", path: join(home, ".claude.json"), kind: "Claude Code MCP servers, home", scope: "home", digest: "mcp-json" },
    { host: "claude-code", path: join(cwd, ".mcp.json"), kind: "Claude Code MCP servers, project", scope: "project", digest: "mcp-json" },
    { host: "cursor", path: join(home, ".cursor", "mcp.json"), kind: "Cursor MCP servers, home", scope: "home", digest: "mcp-json" },
    { host: "cursor", path: join(cwd, ".cursor", "mcp.json"), kind: "Cursor MCP servers, project", scope: "project", digest: "mcp-json" },
    { host: "windsurf", path: join(home, ".codeium", "windsurf", "mcp_config.json"), kind: "Windsurf MCP servers, home", scope: "home", digest: "mcp-json" },
    { host: "codex", path: join(home, ".codex", "config.toml"), kind: "Codex config.toml, home", scope: "home" },
    ...openclaw(join(home, ".openclaw", "workspace")),
    ...openclaw(join(home, "clawd")),
    { host: "openclaw", path: join(home, ".openclaw", "openclaw.json"), kind: "OpenClaw config, home", scope: "home" },
  ];
}

/**
 * The server definitions in an MCP config, canonical, with every env value
 * replaced by its own hash: the digest moves when a command, an argument, a
 * URL or a secret changes, and the text hashed never contains the secret.
 * ~/.claude.json keeps per-project servers under projects.<path>.mcpServers;
 * those are folded in under "project:<hash of path>" so paths never appear.
 */
export function mcpServersDigest(text: string): { sha256: string; sections: Record<string, string> } | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const j = doc as Record<string, unknown>;
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
    return v;
  };
  const servers: Record<string, unknown> = {};
  const take = (m: unknown, prefix: string) => {
    if (!m || typeof m !== "object" || Array.isArray(m)) return;
    for (const [name, def] of Object.entries(m as Record<string, unknown>)) {
      const d = def && typeof def === "object" ? { ...(def as Record<string, unknown>) } : def;
      if (d && typeof d === "object" && (d as Record<string, unknown>).env && typeof (d as Record<string, unknown>).env === "object") {
        const env = (d as Record<string, unknown>).env as Record<string, unknown>;
        (d as Record<string, unknown>).env = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, `sha256:${sha256(Buffer.from(String(v)))}`]));
      }
      servers[prefix + name] = canon(d);
    }
  };
  take(j.mcpServers, "");
  if (j.projects && typeof j.projects === "object") for (const [path, p] of Object.entries(j.projects as Record<string, { mcpServers?: unknown }>)) take(p?.mcpServers, `project:${sha256(Buffer.from(path)).slice(0, 12)}/`);
  const sections: Record<string, string> = {};
  for (const [name, def] of Object.entries(servers)) sections[name] = sha256(Buffer.from(JSON.stringify(def)));
  return { sha256: sha256(Buffer.from(JSON.stringify(canon(servers)))), sections };
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * A settings file is one document with several jobs: hooks (commands the agent
 * runs), permissions (what it may do without asking), env and the key helper.
 * Claude Code rewrites the permission list itself every time someone picks
 * "always allow", so a plain file hash would read as changed most days. One hash
 * per top-level key lets the report say which part changed. Values are hashed,
 * never kept.
 */
export function sectionHashes(text: string): Record<string, string> | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) out[k] = sha256(Buffer.from(JSON.stringify(v)));
  return out;
}

/** Hash one regular file; symbolic links and oversized files are skipped. An imported file is hashed whole: no per-key hashes for text the import author chose. */
function readOne(loc: InstructionLocation, path: string, imported = false): InstructionFile | null {
  const st = lstatSync(path);
  if (!st.isFile() || st.size > FILE_MAX_BYTES) return null;
  const buf = readFileSync(path);
  if (loc.digest === "mcp-json") {
    const d = mcpServersDigest(buf.toString("utf8"));
    if (!d) return null;
    return { host: loc.host, path, kind: loc.kind, scope: loc.scope, sha256: d.sha256, bytes: st.size, sections: d.sections };
  }
  const file: InstructionFile = { host: loc.host, path, kind: loc.kind, scope: loc.scope, sha256: sha256(buf), bytes: st.size };
  if (!imported && path.endsWith(".json")) {
    const sections = sectionHashes(buf.toString("utf8"));
    if (sections) file.sections = sections;
  }
  return file;
}

const IMPORT_MAX = 20;
const IMPORT_DEPTH = 3;

/**
 * Claude Code follows `@path` imports inside CLAUDE.md (a home path, a relative
 * path, or an absolute one). A rewrite that adds an import and then edits the
 * imported file would otherwise move only once. So imported files are hashed
 * too, up to three levels and twenty files, under the parent's kind.
 */
export function claudeImports(text: string, fromDir: string, home: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\s)@((?:~\/|\.{1,2}\/|\/)[^\s"'`)]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < IMPORT_MAX) {
    const raw = m[1]!;
    const p = raw.startsWith("~/") ? join(home, raw.slice(2)) : raw.startsWith("/") ? raw : resolve(fromDir, raw);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Every instruction file that exists on this machine, in a stable order. */
export function readInstructionFiles(home = homedir(), cwd = resolve(process.cwd()), errors: string[] = []): InstructionFile[] {
  const out: InstructionFile[] = [];
  const seen = new Set<string>();
  const push = (f: InstructionFile | null) => {
    if (f && !seen.has(f.path)) {
      seen.add(f.path);
      out.push(f);
      return true;
    }
    return false;
  };
  const followImports = (loc: InstructionLocation, path: string, depth: number) => {
    // only CLAUDE.md files start a chain; the files they import are followed whatever they are called
    if (depth > IMPORT_DEPTH || (depth === 1 && !/CLAUDE(?:\.local)?\.md$/.test(path))) return;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return;
    }
    for (const imp of claudeImports(text, dirname(path), home)) {
      if (seen.has(imp) || !existsSync(imp)) continue;
      try {
        const kind = `${loc.kind.replace(/, (home|project)$/, "")} import, ${loc.scope}`;
        if (push(readOne({ ...loc, kind }, imp, true))) followImports(loc, imp, depth + 1);
      } catch {
        /* unreadable import: skip */
      }
    }
  };
  for (const loc of instructionLocations(home, cwd)) {
    if (!existsSync(loc.path)) continue;
    try {
      if (loc.dir) {
        const st = lstatSync(loc.path);
        if (!st.isDirectory()) continue;
        const names = readdirSync(loc.path).sort().slice(0, DIR_MAX_FILES);
        for (const name of names) {
          if (name.startsWith(".")) continue;
          push(readOne(loc, join(loc.path, name)));
        }
      } else if (push(readOne(loc, loc.path))) {
        followImports(loc, loc.path, 1);
      }
    } catch (err) {
      errors.push(`${loc.path}: ${(err as NodeJS.ErrnoException).code ?? "unreadable"}`);
    }
  }
  return out;
}

/**
 * Compare what is on disk with the baseline and return the new baseline. A
 * changed file is reported once, against the hash last recorded, and then the
 * new hash becomes the record: the next run reports it as unchanged since now.
 */
export function compareInstructions(files: InstructionFile[], baseline: InstructionBaseline, now = new Date()): { statuses: InstructionStatus[]; baseline: InstructionBaseline } {
  const at = now.toISOString();
  const next: InstructionBaseline = {};
  const statuses: InstructionStatus[] = [];
  for (const file of files) {
    const prev = baseline[file.path];
    const rec = (r: InstructionRecord): InstructionRecord => (file.sections ? { ...r, sections: file.sections } : r);
    if (!prev) {
      statuses.push({ status: "new", file });
      next[file.path] = rec({ sha256: file.sha256, seen: at });
    } else if (prev.sha256 === file.sha256) {
      statuses.push({ status: "unchanged", file, since: prev.changed ?? prev.seen });
      next[file.path] = rec(prev);
    } else {
      const changes = (prev.changes ?? 0) + 1;
      let where: string[] | undefined;
      if (prev.sections && file.sections) {
        const keys = new Set([...Object.keys(prev.sections), ...Object.keys(file.sections)]);
        where = [...keys].filter((k) => prev.sections![k] !== file.sections![k]).sort();
      }
      statuses.push({ status: "changed", file, previous: prev.sha256, since: prev.changed ?? prev.seen, changes, ...(where ? { where } : {}) });
      next[file.path] = rec({ sha256: file.sha256, seen: prev.seen, changed: at, changes });
    }
  }
  const present = new Set(files.map((f) => f.path));
  for (const [path, prev] of Object.entries(baseline)) {
    if (!present.has(path)) statuses.push({ status: "removed", path, previous: prev.sha256, since: prev.changed ?? prev.seen });
  }
  return { statuses, baseline: next };
}

/** Local calendar day, YYYY-MM-DD, so "since" reads the way the person remembers it. */
const day = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const short = (h: string) => h.slice(0, 12);

/** Lines for the terminal. `home` is shortened to ~ for reading only. */
export function formatInstructions(statuses: InstructionStatus[], home = homedir()): string[] {
  const tilde = (p: string) => (p.startsWith(home + "/") || p.startsWith(home + "\\") ? "~" + p.slice(home.length) : p);
  const lines: string[] = [];
  for (const s of statuses) {
    if (s.status === "new") lines.push(`  first seen  ${tilde(s.file.path)}  ${short(s.file.sha256)}`);
    else if (s.status === "unchanged") lines.push(`  unchanged   ${tilde(s.file.path)}  ${short(s.file.sha256)} since ${day(s.since)}`);
    else if (s.status === "changed") lines.push(`  CHANGED     ${tilde(s.file.path)}  was ${short(s.previous)} since ${day(s.since)}, now ${short(s.file.sha256)}${s.changes > 1 ? ` (change ${s.changes})` : ""}${s.where ? `  in: ${s.where.length ? s.where.join(", ") : "formatting only"}` : ""}`);
    else lines.push(`  REMOVED     ${tilde(s.path)}  was ${short(s.previous)} since ${day(s.since)}`);
  }
  return lines;
}

/** What sync sends for one file: a hash of the path, the kind label, the host, the scope, the content hash. Never the path. */
export interface FileUpload {
  pathHash: string;
  kind: string;
  host: Host;
  scope: string;
  sha256: string;
  sections?: Record<string, string>;
}

export const pathHash = (path: string): string => sha256(Buffer.from(path));
/** A project scope is the working directory's hash, so a sync from another directory never reports this one's files removed. */
export const projectScope = (cwd: string): string => `project:${sha256(Buffer.from(resolve(cwd))).slice(0, 12)}`;

export function toFileUpload(files: InstructionFile[], cwd = process.cwd()): { files: FileUpload[]; scopes: string[] } {
  const scopes = new Set<string>(["home"]);
  const out: FileUpload[] = files.map((f) => {
    const scope = f.scope === "home" ? "home" : projectScope(cwd);
    scopes.add(scope);
    return { pathHash: pathHash(f.path), kind: f.kind, host: f.host, scope, sha256: f.sha256, ...(f.sections ? { sections: f.sections } : {}) };
  });
  return { files: out, scopes: [...scopes] };
}
