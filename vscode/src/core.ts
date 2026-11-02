/**
 * What the extension decides, with no editor in it, so every rule is tested without VS Code. Three watches:
 *  - an MCP server with a package identity: the public record's releases and advisories for it, once the person allowed
 *    the lookup (the package name only, one request per server, the same request `smallprint gate` makes);
 *  - a skill: its files, hashed on this machine, compared with the last time;
 *  - an instruction file (CLAUDE.md, AGENTS.md, an .mcp.json, rules): hashed on this machine, compared with the last time.
 */
// the command's range rule, the one implementation (packages/cli/src/range.ts), bundled in like its discovery code
import { compareVersions, inRange } from "../../cli/src/range";
// the command's rule for what is a change to the small print (NOT_TEXT_CHANGE_FIELDS), bundled in the same way
import { textChanges } from "../../cli/src/release";
// the gate's rule for what the record holds between two versions, bundled in the same way (pass 6 audit of 16 Oct 2026)
import { betweenVersions } from "../../cli/src/gate";

export type Grade = "critical" | "high" | "medium" | "low" | "info";
const RANK: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
export const atLeast = (g: string | null | undefined, floor: Grade): boolean => (RANK[g ?? ""] ?? 0) >= RANK[floor]!;

/** What the entry API returns, only the fields used here. */
export interface RecordEntry {
  asset: { canonicalName: string; displayName: string; latestVersion: string | null; url: string };
  advisories: { id: string; severity: string; versionRange: string | null; summary: string; url: string; attribution?: string | null; source?: string }[];
  releases: { from: string | null; to: string; publishedAt: string | null; worst: string; identical: boolean; summary: string; changes: { field: string; subject: string; severity: string; severityRule: string }[] }[];
  /** The newest versions on record (the read API's window), and the record's count of them all. */
  versions?: { version: string; publishedAt: string | null; read?: boolean; contentHash: string | null }[];
  counts?: { versions?: number };
}

/**
 * Small Print's own incident records (source incident-backfill) are its summaries of the reports they link, with a grade it
 * chose: the notice says so, in the brief's words (packages/brief/src/compose.ts OWN_RECORD_LINE). Until the pass 6 audit
 * of 16 Oct 2026 the notice showed SP-2025-0001 like any other advisory (decision 537).
 */
export const OWN_RECORD_LINE = "Small Print wrote this record from the reports it links and chose its grade.";

export interface ServerState {
  canonicalName: string;
  /** The version found on this machine at the last check; null when it could not be read. */
  version: string | null;
  /** The newest version on record at the last check. */
  latestSeen: string | null;
  /** High and critical advisories already reported for this server. */
  advisoriesSeen: string[];
  checkedAt: string;
}

export interface Finding {
  key: string;
  kind: "text-changed" | "install-script" | "you-upgraded" | "advisory" | "skill-changed" | "file-changed";
  grade: Grade;
  title: string;
  detail: string;
  url?: string;
}

export const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
type Change = RecordEntry["releases"][number]["changes"][number];
const subjects = (cs: readonly Change[]) => [...new Set(cs.map((c) => c.subject).filter(Boolean))].slice(0, 3).join(", ");
const worstOf = (cs: readonly Change[]): Grade => cs.reduce<Grade>((w, c) => (RANK[c.severity] && atLeast(c.severity, w) ? (c.severity as Grade) : w), "info");

/** Releases after `after`, oldest first; `after` null means none are new (the first check only takes a baseline). */
export function releasesAfter(entry: RecordEntry, after: string | null): RecordEntry["releases"] {
  if (!after) return [];
  return entry.releases.filter((r) => compareVersions(r.to, after) > 0).sort((a, b) => compareVersions(a.to, b.to));
}

/**
 * Compare one server's record now with what was seen last time. Returns the findings to show and the state to keep.
 * The first check keeps a baseline and reports only advisories whose range covers, or may cover, the version found here.
 */
export function evaluateServer(key: string, name: string, version: string | null, entry: RecordEntry, prev: ServerState | undefined, now = new Date()): { findings: Finding[]; state: ServerState } {
  const findings: Finding[] = [];
  const latest = entry.asset.latestVersion;
  // new releases on record since the last check that changed the small print. An install script, a version line or a
  // source that stopped serving the entry is not a change to what it tells the agent (NOT_TEXT_CHANGE_FIELDS); until
  // 16 Oct 2026 a release holding only an install script was called one. An added install script is said in its own words.
  // A release names the two versions the record compared: versions between them were not read, so "0.4.1 changed" was
  // untrue when the change could have come in 0.3.4 (pass 6 audit of 16 Oct 2026, @vicsee/mcp-server 0.3.3 to 0.4.1).
  for (const r of releasesAfter(entry, prev?.latestSeen ?? null)) {
    if (r.identical) continue;
    const text = textChanges(r);
    const scripts = r.changes.filter((c) => c.field === "install.script");
    if (!text.length && !scripts.length) continue;
    const inside = !!version && !!r.from && compareVersions(version, r.from) > 0 && compareVersions(version, r.to) < 0;
    const runsLine = !version ? "Your config does not pin a version, so the version that starts can change." : inside ? `You run ${version}, which lies between the two, so whether it holds these changes is not known.` : `You run ${version}.`;
    const scriptWords = subjects(scripts) ? ` (${subjects(scripts)})` : "";
    if (text.length) findings.push({ key: `release:${key}:${r.to}`, kind: "text-changed", grade: worstOf(text), title: r.from ? `${name}'s small print changed between ${r.from} and ${r.to}` : `${name} ${r.to}: a change to its small print is on record`, detail: `${plural(text.length, "change")}, worst ${worstOf(text)}${subjects(text) ? ` (${subjects(text)})` : ""}.${scripts.length ? ` It also added an install script${scriptWords}.` : ""} ${runsLine}`, url: entry.asset.url });
    else findings.push({ key: `script:${key}:${r.to}`, kind: "install-script", grade: worstOf(scripts), title: `${name} ${r.to} added an install script${scriptWords}`, detail: runsLine, url: entry.asset.url });
  }
  // this machine moved to another version since the last check: say what the record holds between the two, by the gate's
  // rule (betweenVersions): a change, no comparison, or no change, and never "no change" where nothing was compared
  // (pass 4 audit: mcp-remote 0.1.15 to 0.1.16; pass 6 audit: atom-mcp-server 1.1.0 to 2.1.0, fingerprints that differ)
  if (prev?.version && version && prev.version !== version) {
    const was = prev.version;
    const b = entry.versions ? betweenVersions({ releases: entry.releases, versions: entry.versions, counts: entry.counts }, was, version) : null;
    const between = b?.state === "changed" ? b.releases.flatMap((r) => textChanges(r)) : [];
    const worst = worstOf(between);
    const detail = !b
      ? "Whether its small print changed in between is not known."
      : b.state === "changed"
        ? `${plural(between.length, "change")} to its small print in between, worst ${worst}.`
        : b.state === "no-text"
          ? `Whether its small print changed in between is not known: ${b.why}.`
          : b.state === "not-compared"
            ? "Their fingerprints differ, and the record has not compared every version in between, so whether the small print changed is not known."
            : "The record holds no change to its small print in between.";
    findings.push({ key: `upgrade:${key}:${version}`, kind: "you-upgraded", grade: between.length ? worst : "info", title: `${name} is now ${version} on this machine (was ${was})`, detail, url: entry.asset.url });
  }
  // high and critical advisories whose range covers this version (or any, when the version here is unknown), once each.
  // An advisory gives a range, so it "covers" a version; it does not name one (pass 6 audit of 16 Oct 2026: "CVE-2025-6514
  // (critical) names remote 0.1.15", for the range ">= 0.0.5, < 0.1.16")
  const seen = new Set(prev?.advisoriesSeen ?? []);
  const serious = entry.advisories.filter((a) => atLeast(a.severity, "high"));
  const applies = serious.filter((a) => !version || !a.versionRange || inRange(version, a.versionRange) !== false);
  for (const a of applies) {
    if (seen.has(a.id)) continue;
    // a range that is missing or cannot be read does not say it covers the version here (pass 4 audit of 16 Oct 2026)
    const covers = version && a.versionRange && inRange(version, a.versionRange) === true;
    const what = !version ? `names ${name}` : covers ? `covers ${name} ${version}` : `names ${name}; whether it covers ${version} is not known`;
    const own = a.source === "incident-backfill" ? `${OWN_RECORD_LINE} ` : "";
    findings.push({ key: `advisory:${key}:${a.id}`, kind: "advisory", grade: atLeast(a.severity, "critical") ? "critical" : "high", title: `${a.id} (${a.severity}) ${what}`, detail: `${own}${/[.!?]$/.test(a.summary.trim()) ? a.summary.trim() : `${a.summary.trim()}.`}${a.versionRange ? ` Affected: ${a.versionRange}.` : ""}${version ? "" : " The version here is unknown, so check it against the range."}`, url: a.url });
  }
  return { findings, state: { canonicalName: entry.asset.canonicalName, version, latestSeen: latest ?? prev?.latestSeen ?? null, advisoriesSeen: [...new Set([...seen, ...applies.map((a) => a.id)])], checkedAt: now.toISOString() } };
}

/** A local hash compared with the last one; a first sighting is a baseline, not a finding. */
export function evaluateLocal(kind: "skill-changed" | "file-changed", key: string, label: string, hash: string, prev: string | undefined): Finding | null {
  if (!prev || prev === hash) return null;
  return kind === "skill-changed"
    ? { key: `skill:${key}:${hash.slice(0, 12)}`, kind, grade: "high", title: `The files of the skill ${label} changed on this machine`, detail: "A skill's instructions are read by your agent as written. If you did not update it, read it before your agent does." }
    : { key: `file:${key}:${hash.slice(0, 12)}`, kind, grade: "high", title: `${label} changed outside this editor`, detail: "Your agents read this file as instructions. If that was not you, read the change before your agent does." };
}

/**
 * What the panel says of a server after its last lookup: a 404 is "not on record yet", and a lookup that failed says so
 * with its status, or that it got no answer (pass 5 audit of 16 Oct 2026: both read "not on record yet"). `status` is
 * null when no answer came.
 */
export function lookupWords(status: number | null): string {
  if (status === 404) return "not on record yet";
  return status === null ? "the last lookup got no answer" : `the last lookup failed (HTTP ${status})`;
}

/** The footer's count of lookups that failed or got no answer; a 5xx or a 429 is an answer, so "did not answer" is not said. */
export const failedWords = (n: number): string => `${plural(n, "lookup")} failed; they are tried again at the next check.`;

/** Whether a finding is worth a notification at the level the person chose. */
export function notifies(f: Finding, level: "high" | "any" | "none"): boolean {
  if (level === "none") return false;
  if (f.kind === "file-changed" || f.kind === "skill-changed" || f.kind === "advisory") return true;
  return level === "any" ? f.grade !== "info" : atLeast(f.grade, "high");
}

/**
 * The two settings that decide what leaves the machine and where it goes (security audit of 29 Sep 2026, item 40; tools
 * audit fix 7) are read from the user's own settings only. package.json marks them `"scope": "application"`, so VS Code
 * ignores a workspace's value, and the extension also reads the user-level value through `inspect`, so a repository's
 * .vscode/settings.json can neither turn the lookup on without asking nor point it at another address.
 */
export interface Inspected<T> {
  defaultValue?: T;
  globalValue?: T;
}

export function userSetting<T>(inspected: Inspected<T> | undefined, fallback: T): T {
  return inspected?.globalValue ?? inspected?.defaultValue ?? fallback;
}

export const DEFAULT_BASE = "https://smallprint.dev";

/** The record's address: https only, with no user name, password, query or fragment; anything else falls back to smallprint.dev. */
export function safeBase(value: string | undefined): string {
  try {
    const u = new URL((value ?? "").trim());
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return DEFAULT_BASE;
    return u.href.replace(/\/$/, "");
  } catch {
    return DEFAULT_BASE;
  }
}
