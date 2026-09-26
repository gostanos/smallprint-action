/**
 * The lockfile (decision 102): what the agents on this machine run, and the hashes of the
 * instruction files they read, written to a file that can be committed beside the project. A
 * later `check --locked` compares the machine with the lock and says what changed: a server whose
 * version changed, a skill whose files changed, an instruction file rewritten, something added
 * or gone. Entirely local: nothing is sent, nothing is fetched, and it works offline, so it can
 * run in CI. The file holds names, versions, hosts, hashes and instruction-file paths, never a
 * configuration value.
 */
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Discovered, UploadItem } from "./parse";
import type { InstructionFile } from "./instructions";

export const LOCK_VERSION = 1;
export const LOCK_FILE = "smallprint.lock";

export interface LockItem {
  kind: "mcp" | "agent-skill";
  host: string;
  name: string;
  canonicalName: string | null;
  version: string | null;
  /** For skills: the SKILL.md hash and the hash over every file. */
  skillMdSha256?: string;
  treeSha256?: string;
  /** For a server with a registry identity and a version: the record's digest of that version's tool names, descriptions and input schemas, taken from smallprint.dev when the lock was written (decision 224). */
  recordSha256?: string;
}

export interface LockFileEntry {
  /** "~/..." for a file under the home directory, a relative path for one under the project, else absolute. */
  path: string;
  kind: string;
  sha256: string;
}

/**
 * "machine": everything the machine runs, home entries included (a laptop's own lock).
 * "project": only what lives under the working directory, so the lock is the repository's and
 * a CI runner with an empty home compares equal (decision 110).
 */
export type LockScope = "machine" | "project";

export interface Lockfile {
  version: number;
  written: string;
  scope: LockScope;
  items: LockItem[];
  files: LockFileEntry[];
}

export const itemKey = (i: { host: string; name: string; kind: string }): string => `${i.kind}:${i.host}:${i.name}`;

/** Forward slashes in the lock whatever wrote it, so a lock from Windows compares on Linux and back. */
const slashes = (p: string) => p.split(sep).join("/");

/** True when the path is inside the working directory. */
export function underProject(path: string, cwd = process.cwd()): boolean {
  const rel = relative(resolve(cwd), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The servers and skills whose config or folder lives under the working directory: what a project lock holds. */
export function projectItems(items: readonly Discovered[], cwd = process.cwd()): Discovered[] {
  return items.filter((it) => underProject(it.kind === "mcp" ? it.configPath : it.path, cwd));
}

export function displayPath(path: string, home = homedir(), cwd = process.cwd()): string {
  const abs = resolve(path);
  if (underProject(abs, cwd)) return slashes(relative(resolve(cwd), abs));
  if (abs.startsWith(home + sep)) return "~" + slashes(abs.slice(home.length));
  return slashes(abs);
}

export interface BuildLockOptions {
  now?: Date;
  home?: string;
  cwd?: string;
  scope?: LockScope;
}

export function buildLock(items: readonly UploadItem[], files: readonly InstructionFile[], opts: BuildLockOptions = {}): Lockfile {
  const now = opts.now ?? new Date();
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const scope = opts.scope ?? "machine";
  // a project lock keeps only the files under the working directory; the items were filtered with projectItems before they lost their paths
  const keptFiles = scope === "project" ? files.filter((f) => f.scope === "project" && underProject(f.path, cwd)) : files;
  const lockItems: LockItem[] = items
    .map((i) => ({ kind: i.kind, host: i.host, name: i.name, canonicalName: i.canonicalName ?? null, version: i.version ?? null, ...(i.skillMdSha256 ? { skillMdSha256: i.skillMdSha256 } : {}), ...(i.treeSha256 ? { treeSha256: i.treeSha256 } : {}) }))
    .sort((a, b) => itemKey(a).localeCompare(itemKey(b)));
  const lockFiles: LockFileEntry[] = keptFiles.map((f) => ({ path: displayPath(f.path, home, cwd), kind: f.kind, sha256: f.sha256 })).sort((a, b) => a.path.localeCompare(b.path));
  return { version: LOCK_VERSION, written: now.toISOString(), scope, items: lockItems, files: lockFiles };
}

export interface LockDiff {
  added: LockItem[];
  removed: LockItem[];
  changed: { before: LockItem; after: LockItem; what: string }[];
  filesNew: LockFileEntry[];
  filesMissing: LockFileEntry[];
  filesChanged: { path: string; before: string; after: string }[];
}

export const diffIsEmpty = (d: LockDiff): boolean => !d.added.length && !d.removed.length && !d.changed.length && !d.filesNew.length && !d.filesMissing.length && !d.filesChanged.length;

/** What differs between the machine now (`current`) and the lock. */
export function diffLock(lock: Lockfile, current: Lockfile): LockDiff {
  const was = new Map(lock.items.map((i) => [itemKey(i), i]));
  const now = new Map(current.items.map((i) => [itemKey(i), i]));
  const out: LockDiff = { added: [], removed: [], changed: [], filesNew: [], filesMissing: [], filesChanged: [] };
  for (const [k, i] of now) if (!was.has(k)) out.added.push(i);
  for (const [k, i] of was) if (!now.has(k)) out.removed.push(i);
  for (const [k, after] of now) {
    const before = was.get(k);
    if (!before) continue;
    const what: string[] = [];
    if ((before.version ?? null) !== (after.version ?? null)) what.push(`version ${before.version ?? "none"} -> ${after.version ?? "none"}`);
    if ((before.canonicalName ?? null) !== (after.canonicalName ?? null)) what.push(`identity ${before.canonicalName ?? "none"} -> ${after.canonicalName ?? "none"}`);
    if (before.skillMdSha256 !== after.skillMdSha256) what.push("SKILL.md changed");
    else if (before.treeSha256 !== after.treeSha256) what.push("skill files changed");
    if (what.length) out.changed.push({ before, after, what: what.join(", ") });
  }
  const fWas = new Map(lock.files.map((f) => [f.path, f]));
  const fNow = new Map(current.files.map((f) => [f.path, f]));
  for (const [p, f] of fNow) if (!fWas.has(p)) out.filesNew.push(f);
  for (const [p, f] of fWas) if (!fNow.has(p)) out.filesMissing.push(f);
  for (const [p, f] of fNow) {
    const b = fWas.get(p);
    if (b && b.sha256 !== f.sha256) out.filesChanged.push({ path: p, before: b.sha256, after: f.sha256 });
  }
  return out;
}

export function formatDiff(d: LockDiff): string[] {
  const lines: string[] = [];
  const label = (i: LockItem) => `${i.name} (${i.host}${i.version ? `, ${i.version}` : ""})`;
  for (const c of d.changed) lines.push(`  CHANGED  ${label(c.before)}: ${c.what}`);
  for (const i of d.added) lines.push(`  ADDED    ${label(i)}: not in the lock`);
  for (const i of d.removed) lines.push(`  GONE     ${label(i)}: in the lock, not on this machine`);
  for (const f of d.filesChanged) lines.push(`  CHANGED  ${f.path}: was ${f.before.slice(0, 12)}, now ${f.after.slice(0, 12)}`);
  for (const f of d.filesNew) lines.push(`  NEW      ${f.path}: not in the lock`);
  for (const f of d.filesMissing) lines.push(`  MISSING  ${f.path}: in the lock, not on this machine`);
  return lines;
}

export function parseLock(text: string): Lockfile {
  const j = JSON.parse(text) as Partial<Lockfile>;
  if (j.version !== LOCK_VERSION || !Array.isArray(j.items) || !Array.isArray(j.files)) throw new Error(`not a smallprint lock (version ${LOCK_VERSION})`);
  // locks from 0.0.12 have no scope field: they were written for the whole machine
  const scope: LockScope = j.scope === "project" ? "project" : "machine";
  return { version: LOCK_VERSION, written: typeof j.written === "string" ? j.written : "", scope, items: j.items as LockItem[], files: j.files as LockFileEntry[] };
}

/**
 * The lines of formatDiff as a SARIF 2.1.0 log (decision 223): one result per line, level error, the rule named after the
 * kind of change, and a file location when the line is about a file. For GitHub code scanning uploads.
 */
export function sarifLog(diffLines: readonly string[], lockPath: string, version: string): Record<string, unknown> {
  const results = diffLines.map((l) => {
    const m = /^\s*(\w+)\s+(.*)$/.exec(l);
    const kind = (m?.[1] ?? "CHANGED").toLowerCase();
    const text = m?.[2] ?? l;
    const file = /^([^:(]+):/.exec(text)?.[1]?.trim();
    return {
      ruleId: `smallprint/lock-${kind}`,
      level: "error",
      message: { text: `${text}. The small print changed since ${lockPath} was written; if this is yours, run smallprint lock again and commit it.` },
      ...(file && !file.includes(" ") ? { locations: [{ physicalLocation: { artifactLocation: { uri: file } } }] } : {}),
    };
  });
  const rules = [...new Set(results.map((r) => r.ruleId))].map((id) => ({ id, shortDescription: { text: "The small print this project's agents read changed since the committed lock was written" }, helpUri: "https://smallprint.dev/cli" }));
  return { version: "2.1.0", $schema: "https://json.schemastore.org/sarif-2.1.0.json", runs: [{ tool: { driver: { name: "smallprint", version, informationUri: "https://smallprint.dev/cli", rules } }, results }] };
}
