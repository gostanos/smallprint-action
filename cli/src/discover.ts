/**
 * Discovery: where each agent host keeps its MCP server and skill configuration,
 * and how to read it without touching secrets. This package is the open, thin
 * client: it collects names, versions, source hints and file hashes, and
 * nothing else. Config values, env vars and tokens never leave the machine;
 * the hygiene checks look at them locally and report only a finding.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, lstatSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { parseClaudeJson as parseJsonPure, parseCodexToml as parseTomlPure, type Discovered, type DiscoveredServer, type DiscoveredSkill, type Host } from "./parse";

export * from "./parse";
import { toUpload as toUploadPure, type UploadItem } from "./parse";
/** toUpload with the tree hash filled in (node has crypto; the pure module does not). */
export function toUpload(items: readonly Discovered[]): UploadItem[] {
  return toUploadPure(items, (s) => createHash("sha256").update(s).digest("hex"));
}

/** Config files on disk get one more hygiene note the browser cannot make: world-readable mode bits. */
function fileModeHygiene(configPath: string): string[] {
  // Windows reports 0o666 for every file: the bits mean nothing there, so there is nothing to say
  if (platform() === "win32") return [];
  try {
    const mode = statSync(configPath).mode & 0o077;
    if (mode) return [`${configPath} is readable by other users (mode ${(statSync(configPath).mode & 0o777).toString(8)})`];
  } catch {
    // unreadable stat: nothing to say
  }
  return [];
}

export function parseClaudeJson(text: string, host: Host, configPath: string): DiscoveredServer[] {
  const extra = fileModeHygiene(configPath);
  return parseJsonPure(text, host, configPath).map((s) => ({ ...s, hygiene: [...s.hygiene, ...extra] }));
}

export function parseCodexToml(text: string, configPath: string): DiscoveredServer[] {
  const extra = fileModeHygiene(configPath);
  return parseTomlPure(text, configPath).map((s) => ({ ...s, hygiene: [...s.hygiene, ...extra] }));
}


export interface DiscoverOptions {
  home?: string;
  cwd?: string;
  /** Extra config files to read as Claude-style JSON (tests). */
  extraJsonConfigs?: { path: string; host: Host }[];
}

export interface ConfigLocation {
  host: Host;
  path: string;
  format: "claude-json" | "cursor-json" | "codex-toml" | "skills-dir";
}

/** Everything we look for, in order. Paths are best effort per docs/SOURCES.md. */
export function configLocations(home = homedir(), cwd = process.cwd()): ConfigLocation[] {
  const win = platform() === "win32";
  const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
  return [
    { host: "claude-desktop", path: win ? join(appData, "Claude", "claude_desktop_config.json") : join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), format: "claude-json" },
    { host: "claude-code", path: join(home, ".claude.json"), format: "claude-json" },
    { host: "claude-code", path: join(cwd, ".mcp.json"), format: "claude-json" },
    { host: "claude-code", path: join(home, ".claude", "skills"), format: "skills-dir" },
    { host: "claude-code", path: join(cwd, ".claude", "skills"), format: "skills-dir" },
    { host: "cursor", path: join(home, ".cursor", "mcp.json"), format: "cursor-json" },
    { host: "cursor", path: join(cwd, ".cursor", "mcp.json"), format: "cursor-json" },
    { host: "windsurf", path: join(home, ".codeium", "windsurf", "mcp_config.json"), format: "cursor-json" },
    { host: "codex", path: join(home, ".codex", "config.toml"), format: "codex-toml" },
    { host: "codex", path: join(cwd, ".codex", "config.toml"), format: "codex-toml" },
    // decision 143: the clients agent-bom style tools discover and the lock did not
    { host: "vscode", path: join(cwd, ".vscode", "mcp.json"), format: "claude-json" },
    { host: "vscode", path: win ? join(appData, "Code", "User", "mcp.json") : join(home, "Library", "Application Support", "Code", "User", "mcp.json"), format: "claude-json" },
    { host: "zed", path: join(home, ".config", "zed", "settings.json"), format: "claude-json" },
    { host: "zed", path: join(cwd, ".zed", "settings.json"), format: "claude-json" },
    { host: "gemini", path: join(home, ".gemini", "settings.json"), format: "claude-json" },
    { host: "gemini", path: join(cwd, ".gemini", "settings.json"), format: "claude-json" },
    { host: "windsurf", path: join(cwd, ".windsurf", "mcp.json"), format: "cursor-json" },
    { host: "cline", path: win ? join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json") : join(home, "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"), format: "claude-json" },
    { host: "roo", path: join(cwd, ".roo", "mcp.json"), format: "claude-json" },
    { host: "openclaw", path: join(home, ".openclaw", "skills"), format: "skills-dir" },
    { host: "openclaw", path: join(home, "clawd", "skills"), format: "skills-dir" },
    { host: "hermes", path: join(home, ".hermes", "skills"), format: "skills-dir" },
    { host: "harnos", path: join(home, ".harnos", "skills"), format: "skills-dir" },
  ];
}


function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Ceilings for one skill: past these the skill is reported, not hashed, so a hostile tree cannot make the CLI read the disk. */
export const SKILL_MAX_FILES = 2_000;
export const SKILL_MAX_BYTES = 200_000_000;
const FILE_MAX_BYTES = 5_000_000;

export class SkillTooLarge extends Error {}

/**
 * Hash every regular file under a skill directory. Symbolic links are never
 * followed (lstat, not stat): a skill that ships `data -> ~` must not turn into
 * a listing of the home directory. Paths in the result are relative to the
 * skill and never leave it.
 */
export function readSkillDir(host: Host, dir: string): DiscoveredSkill | null {
  const skillMd = join(dir, "SKILL.md");
  if (!existsSync(skillMd) || lstatSync(skillMd).isSymbolicLink()) return null;
  const files: { path: string; sha256: string }[] = [];
  let total = 0;
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === "node_modules" || name === ".git" || name === ".DS_Store") continue;
      const full = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full, r);
      else if (st.isFile() && st.size <= FILE_MAX_BYTES) {
        total += st.size;
        if (files.length >= SKILL_MAX_FILES || total > SKILL_MAX_BYTES) throw new SkillTooLarge(`${dir}: more than ${SKILL_MAX_FILES} files or ${SKILL_MAX_BYTES / 1_000_000} MB`);
        files.push({ path: r, sha256: sha256(readFileSync(full)) });
      }
    }
  };
  walk(dir, "");
  const text = readFileSync(skillMd, "utf8");
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? null;
  return { kind: "agent-skill", host, name: dir.split(/[\\/]/).pop()!, path: dir, displayName: field("name"), description: field("description"), files, skillMdSha256: sha256(Buffer.from(text)) };
}

export function readSkillsDir(host: Host, root: string, errors: string[] = []): DiscoveredSkill[] {
  if (!existsSync(root)) return [];
  const out: DiscoveredSkill[] = [];
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink()) {
        errors.push(`${dir}: skipped, symbolic link`);
        continue;
      }
      if (!st.isDirectory()) continue;
      const s = readSkillDir(host, dir);
      if (s) out.push(s);
    } catch (err) {
      errors.push(`${dir}: skipped, ${err instanceof SkillTooLarge ? err.message : ((err as NodeJS.ErrnoException).code ?? "unreadable")}`);
    }
  }
  return out;
}

export interface DiscoveryResult {
  items: Discovered[];
  /** Config files that existed and were read. */
  read: string[];
  /** Files that existed but could not be parsed. */
  errors: { path: string; error: string }[];
}

export function discover(opts: DiscoverOptions = {}): DiscoveryResult {
  const home = opts.home ?? homedir();
  const cwd = resolve(opts.cwd ?? process.cwd());
  const items: Discovered[] = [];
  const read: string[] = [];
  const errors: { path: string; error: string }[] = [];
  const locations = [...configLocations(home, cwd), ...(opts.extraJsonConfigs ?? []).map((e) => ({ ...e, format: "claude-json" as const }))];
  // a run from the home directory makes the home and project entries the same file: read it once
  const seen = new Set<string>();
  for (const loc of locations) {
    if (!existsSync(loc.path)) continue;
    const key = resolve(loc.path);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (loc.format === "skills-dir") {
        const skillErrors: string[] = [];
        const skills = readSkillsDir(loc.host, loc.path, skillErrors);
        for (const e of skillErrors) errors.push({ path: loc.path, error: e });
        if (skills.length) read.push(loc.path);
        items.push(...skills);
        continue;
      }
      const text = readFileSync(loc.path, "utf8");
      read.push(loc.path);
      if (loc.format === "codex-toml") items.push(...parseCodexToml(text, loc.path));
      else items.push(...parseClaudeJson(text, loc.host, loc.path));
    } catch (err) {
      errors.push({ path: loc.path, error: (err as Error).message });
    }
  }
  return { items, read, errors };
}

/** The exact payload a check or sync sends. Names, versions, hosts, hashes: nothing else. */
