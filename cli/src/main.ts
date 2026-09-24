#!/usr/bin/env node
/**
 * npx smallprint check [--json] [--no-upload] [--share] [--email <you@x>] [--no-signup] [--base <url>]
 * npx smallprint sync  --label "work laptop" [--yes] [--prune] [--dry-run] [--base <url>]
 *   Needs SMALLPRINT_TOKEN (or --token), minted on your brief settings page. Uploads the same
 *   inventory as check and pins it to your account, so the daily brief watches it. Also sends
 *   the instruction files as a hash of each path, a kind label and the content hash, so the
 *   record of them lives off the machine and every change reaches the brief.
 * npx smallprint schedule --install --label "work laptop"   the same sync every six hours (launchd or systemd), installed by you, removed by you
 *
 * Finds the MCP servers and skills your agents have installed, prints what it
 * found and exactly what it would send, then asks smallprint.dev for advisories
 * and a grade. Nothing leaves the machine but names, versions, hosts and file
 * hashes (and with sync, a kind label and a hash of the path for each instruction file); config values, env vars and tokens are looked at locally for hygiene
 * findings that are printed here and never uploaded. Instruction files
 * (CLAUDE.md, AGENTS.md, OpenClaw's TOOLS.md and SOUL.md, Cursor and Windsurf
 * rules, settings with hooks) are hashed and compared with the last run on
 * this machine; those hashes stay in the local state file.
 *
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, sep } from "node:path";
import { discover, toUpload, type Discovered } from "./discover";
import { detectFirewalls, firewallsForUpload } from "./firewalls";
import { compareInstructions, formatInstructions, pathHash, readInstructionFiles, toFileUpload, type InstructionBaseline } from "./instructions";
import { buildLock, diffIsEmpty, diffLock, formatDiff, LOCK_FILE, parseLock, projectItems, type LockScope } from "./lock";
import { launchdPlist, schtasksCommand, systemdUnits, schedulePlan, systemLaunchdPlist, systemPaths, systemPlan, systemUnits } from "./schedule";
import { execFileSync } from "node:child_process";
import { chmodSync, chownSync, copyFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (k: string) => args.includes(`--${k}`);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
// the root-owned reporter (--system) never takes its destination from the environment: an agent running as the user can
// set SMALLPRINT_BASE_URL in a shell profile, and the install would bake that host into a root job (decision 110)
const systemMode = args[0] === "schedule" && args.includes("--system");
const base = (opt("base") ?? (systemMode ? undefined : process.env.SMALLPRINT_BASE_URL) ?? "https://smallprint.dev").replace(/\/$/, "");
{
  // uploads carry a bearer token: plain http is allowed only to this machine
  let u: URL | null = null;
  try {
    u = new URL(base);
  } catch {
    u = null;
  }
  const local = u !== null && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
  if (!u || (u.protocol !== "https:" && !local) || u.username || u.password) {
    console.error(`Refusing base URL ${base}: use https (http is allowed only for localhost).`);
    process.exit(2);
  }
}

const VERSION = "0.0.15";
const TIMEOUT = () => AbortSignal.timeout(20_000);
/**
 * The one command for level four. sudo's own environment reset drops NODE_OPTIONS and every other variable an agent
 * could have planted in a shell profile; PATH is kept so npx is found, and the token travels beside it. The base URL is
 * never read from the environment in --system mode.
 */
const SYSTEM_INSTALL = 'sudo --preserve-env=PATH,SMALLPRINT_TOKEN npx -y smallprint schedule --install --system --label "this machine"';

/**
 * Local state: where a successful signup from this machine is remembered (so
 * check stops asking) and the hash baseline for instruction files. Never uploaded.
 */
interface State {
  signedUp?: string;
  instructions?: InstructionBaseline;
  /** Scheduled runs so far: the first reports at once, later ones wait a random slice of the interval. */
  scheduledRuns?: number;
}
function stateFile(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "smallprint", "state.json");
}
function readState(): State {
  try {
    if (!existsSync(stateFile())) return {};
    return JSON.parse(readFileSync(stateFile(), "utf8")) as State;
  } catch {
    return {};
  }
}
function writeState(state: State): void {
  try {
    mkdirSync(dirname(stateFile()), { recursive: true, mode: 0o700 });
    writeFileSync(stateFile(), JSON.stringify(state), { mode: 0o600 });
  } catch {
    /* a read-only home is fine; the question just comes back next time */
  }
}

/**
 * The token, in order: --token (discouraged, it lands in shell history), the
 * environment, then ~/.config/smallprint/token, a file only you can read, so a
 * hook or a shell profile can run sync without carrying the token in its text.
 */
function tokenFile(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "smallprint", "token");
}
function readToken(): string | undefined {
  const given = opt("token") ?? process.env.SMALLPRINT_TOKEN;
  if (given) return given;
  try {
    if (!existsSync(tokenFile())) return undefined;
    const t = readFileSync(tokenFile(), "utf8").trim();
    return /^sp_[0-9a-f]{48}$/.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

/** The server's one line when it says no; the raw body when it is not JSON. */
async function errorLine(res: Response): Promise<string> {
  const text = (await res.text()).slice(0, 600);
  try {
    const j = JSON.parse(text) as { error?: string };
    if (typeof j.error === "string") return j.error;
  } catch {
    // not JSON: print what came back
  }
  return text;
}

/** A path shortened to ~ for reading only; the separator is the platform's. */
function tilde(p: string): string {
  const home = homedir();
  return p.startsWith(home + sep) ? "~" + p.slice(home.length) : p;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n - 1) + "…" : s + " ".repeat(n - s.length);
}

function printTable(items: Discovered[]): void {
  console.log(pad("host", 16) + pad("kind", 8) + pad("name", 34) + pad("identity", 40) + "version");
  for (const it of items) {
    if (it.kind === "mcp") console.log(pad(it.host, 16) + pad("mcp", 8) + pad(it.name, 34) + pad(it.canonicalName ?? (it.remoteHost ? `remote ${it.remoteHost}` : "local command"), 40) + (it.version ?? ""));
    else console.log(pad(it.host, 16) + pad("skill", 8) + pad(it.displayName ?? it.name, 34) + pad(`${it.files.length} files, SKILL.md ${it.skillMdSha256.slice(0, 12)}`, 40));
  }
}

/**
 * Instruction files (CLAUDE.md, AGENTS.md, an OpenClaw workspace, Cursor and
 * Windsurf rules, settings with hooks) compared with this machine's last run.
 * Local only: the hashes live in the state file and are never sent.
 */
function reportInstructions(): void {
  const errors: string[] = [];
  const files = readInstructionFiles(homedir(), process.cwd(), errors);
  const state = readState();
  const { statuses, baseline } = compareInstructions(files, state.instructions ?? {});
  console.log("\nInstruction files (compared with this machine's last run, never uploaded):");
  if (!files.length && !statuses.length) {
    console.log("  none found (CLAUDE.md, AGENTS.md, OpenClaw workspace, Cursor and Windsurf rules, Claude settings).");
    return;
  }
  for (const line of formatInstructions(statuses, homedir())) console.log(line);
  for (const e of errors) console.log(`  could not read ${e}`);
  const changed = statuses.filter((s) => s.status === "changed" || s.status === "removed").length;
  const fresh = statuses.filter((s) => s.status === "new").length;
  if (changed) console.log(`  ${changed} changed since the last run. If that was not you, read the file before your agent does.`);
  if (fresh && !state.instructions) console.log("  Recorded. From the next run on, a rewrite of any of these is reported here.");
  console.log("  This record is a file on this machine (~/.config/smallprint/state.json). An agent that can write files can change it as well as the files above.");
  console.log("  To keep a copy it cannot reach, run sync with a free account; the record then lives on smallprint.dev and keeps every change. schedule runs that sync every six hours. https://smallprint.dev/cli#record");
  writeState({ ...state, instructions: baseline });
}

/** The lock on disk for --locked and lock; the path comes from --file, default smallprint.lock in the working directory. */
function lockPath(): string {
  return opt("file") ?? LOCK_FILE;
}

/** What the lock covers: --project keeps to the working directory (the shape CI can check); the default is the whole machine. */
function lockScope(fallback: LockScope = "machine"): LockScope {
  return flag("project") ? "project" : fallback;
}

/** The machine as the lock sees it, at the given scope. */
function currentLock(found: ReturnType<typeof discover>, scope: LockScope) {
  const cwd = process.cwd();
  const items = scope === "project" ? projectItems(found.items, cwd) : found.items;
  return buildLock(toUpload(items), readInstructionFiles(homedir(), cwd), { scope, cwd });
}

/** `smallprint lock`: write what this machine runs and the hashes of its instruction files. Nothing is sent. */
function lock(): number {
  const scope = lockScope();
  const current = currentLock(discover(), scope);
  const path = lockPath();
  let previous: ReturnType<typeof parseLock> | null = null;
  if (existsSync(path)) {
    try {
      previous = parseLock(readFileSync(path, "utf8"));
    } catch (err) {
      console.error(`${path}: ${(err as Error).message}; not overwriting it. Move it aside to write a fresh lock.`);
      return 1;
    }
  }
  writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
  console.log(`${previous ? "Updated" : "Wrote"} ${path} (${scope === "project" ? "this project only" : "this whole machine"}): ${current.items.length} server${current.items.length === 1 ? "" : "s"} and skill${current.items.length === 1 ? "" : "s"}, ${current.files.length} instruction file${current.files.length === 1 ? "" : "s"}. Names, versions, hosts, hashes and instruction-file paths; no configuration values.`);
  if (scope === "machine") console.log("For a lock the repository owns and CI can check, write it with --project: it then holds only what lives under this directory.");
  if (previous) {
    const d = diffLock(previous, current);
    if (!diffIsEmpty(d)) {
      console.log("Since the last lock:");
      for (const l of formatDiff(d)) console.log(l);
    } else console.log("Nothing changed since the last lock.");
  }
  console.log("Commit it. `smallprint check --locked` then fails when anything moves, here or in CI.");
  return 0;
}

/** `check --locked`: compare this machine with the lock and exit 2 when anything moved. Local only, works offline. */
function checkLocked(found: ReturnType<typeof discover>): number {
  const path = lockPath();
  if (!existsSync(path)) {
    console.error(`No ${path}. Write one with: smallprint lock`);
    return 1;
  }
  let previous: ReturnType<typeof parseLock>;
  try {
    previous = parseLock(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`${path}: ${(err as Error).message}`);
    return 1;
  }
  // the lock says what it covers; --project on the command line narrows an older machine lock to the project
  const scope = lockScope(previous.scope);
  const current = currentLock(found, scope);
  const d = diffLock(previous, current);
  if (diffIsEmpty(d)) {
    console.log(`Matches ${path} (written ${previous.written.slice(0, 10)}, ${scope === "project" ? "this project" : "this machine"}): ${current.items.length} servers and skills, ${current.files.length} instruction files, nothing moved.`);
    return 0;
  }
  console.log(`Differs from ${path} (written ${previous.written.slice(0, 10)}):`);
  for (const l of formatDiff(d)) console.log(l);
  console.log(`If these are yours, run \`smallprint lock${scope === "project" ? " --project" : ""}\` again and commit it. Exit 2.`);
  if (scope === "machine" && d.filesMissing.length + d.removed.length > 0) console.log("A machine lock includes home-directory entries, which another machine or a CI runner will not have; a lock written with --project holds only this repository's.");
  return 2;
}

async function check(): Promise<number> {
  const found = discover();
  if (flag("locked")) return checkLocked(found);
  if (flag("json")) {
    const instructions = readInstructionFiles().map((f) => ({ host: f.host, path: f.path, sha256: f.sha256 }));
    // self-describing, because readers paste this into an assistant (decision 210): nothing was sent, and the fields are explained on the CLI page
    console.log(JSON.stringify({ about: "https://smallprint.dev/cli#json", sent: "nothing", read: found.read, errors: found.errors, items: toUpload(found.items), instructions }, null, 2));
    return 0;
  }
  console.log(`Read ${found.read.length} config location${found.read.length === 1 ? "" : "s"}:`);
  for (const p of found.read) console.log(`  ${tilde(p)}`);
  for (const e of found.errors) console.log(`  could not read ${e.path}: ${e.error}`);
  console.log("");
  if (!found.items.length) {
    console.log("No MCP servers or skills found in the locations above (Claude Desktop, Claude Code, Cursor, Windsurf, Codex, OpenClaw, Hermes, harnOS).");
    console.log("Have a config somewhere else? Paste it at https://smallprint.dev/check.");
    reportInstructions();
    return 0;
  }
  printTable(found.items);
  const hygiene = [...new Set(found.items.flatMap((it) => (it.kind === "mcp" ? it.hygiene : [])))];
  if (hygiene.length) {
    console.log("\nLocal findings (never uploaded):");
    for (const h of hygiene) console.log(`  ${h}`);
  }
  reportInstructions();
  if (flag("no-upload")) {
    console.log("\n--no-upload: nothing sent.");
    return 0;
  }
  const payload = toUpload(found.items);
  console.log(`\nSending to ${base}/api/check: ${payload.length} item${payload.length === 1 ? "" : "s"} (names, versions, hosts, file hashes; no config values).`);
  let res: Response;
  try {
    res = await fetch(`${base}/api/check`, { method: "POST", headers: { "content-type": "application/json", "user-agent": `smallprint-cli/${VERSION}` }, body: JSON.stringify({ items: payload, share: flag("share"), source: "cli" }), signal: TIMEOUT() });
  } catch (err) {
    console.error(`Could not reach ${base} (${(err as Error).message}). Check your connection or proxy; --no-upload prints the inventory without sending.`);
    return 1;
  }
  if (!res.ok) {
    console.error(`${base}/api/check answered ${res.status}: ${await errorLine(res)}`);
    return 1;
  }
  const r = (await res.json()) as { grade: string; criterion: string; headline: string; results: { name: string; status: string; detail: string; url: string | null }[]; cardUrl?: string };
  console.log(`\nGrade ${r.grade}: ${r.headline}`);
  console.log(`  ${r.criterion}`);
  // "clean" is the status key the record answers with; on screen it reads as what it is, no advisory on record, never as safe (decision 210)
  for (const x of r.results) console.log(`  ${pad(x.status === "clean" ? "no advisory" : x.status, 12)} ${pad(x.name, 40)} ${x.detail}${x.url ? `  ${x.url}` : ""}`);
  if (r.cardUrl) console.log(`\nShareable card: ${r.cardUrl}`);
  else console.log("\nAdd --share for a card link you can post.");
  return await offerBrief(payload);
}

/** The one question at the end of check: watch these every morning? */
async function offerBrief(payload: ReturnType<typeof toUpload>): Promise<number> {
  if (flag("no-signup")) return 0;
  let email = opt("email")?.trim();
  if (!email) {
    if (!process.stdin.isTTY) return 0;
    const state = readState();
    if (state.signedUp) {
      console.log(`\nThis machine signed up as ${state.signedUp}. Pin changes with sync; run with --email to sign up another address.`);
      return 0;
    }
    const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
    email = (await rl.question("\nWatch these every morning? Type your email to start: 30 days of Pro, no card; Free after that keeps 25 pins and the daily brief. Enter to skip (--no-signup silences this): ")).trim();
    rl.close();
    if (!email) return 0;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("That does not look like an email address. Nothing sent; the check above still stands.");
    return 0;
  }
  const label = hostname();
  let tz = "UTC";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    /* keep UTC */
  }
  let res: Response;
  try {
    res = await fetch(`${base}/api/start`, { method: "POST", headers: { "content-type": "application/json", "user-agent": `smallprint-cli/${VERSION}` }, body: JSON.stringify({ email, tz, label, items: payload }), signal: TIMEOUT() });
  } catch (err) {
    console.error(`Could not reach ${base} (${(err as Error).message}). Ask for your link at ${base}/start instead.`);
    return 1;
  }
  const j = (await res.json().catch(() => ({}))) as { message?: string; error?: string; notPinned?: { name: string; reason: string }[] };
  if (!res.ok) {
    console.error(j.error ?? `${base}/api/start answered ${res.status}`);
    return 1;
  }
  console.log(`\n${j.message ?? "Sent."}`);
  for (const u of j.notPinned ?? []) console.log(`  not pinned: ${u.name}: ${u.reason}`);
  writeState({ ...readState(), signedUp: email });
  return 0;
}

async function sync(): Promise<number> {
  const token = readToken();
  if (opt("token")) console.error("Note: --token shows up in shell history and process listings; prefer SMALLPRINT_TOKEN in the environment or the token file (see --help).");
  const label = opt("label") ?? hostname();
  const quiet = flag("quiet");
  const say = (m: string) => {
    if (!quiet) console.log(m);
  };
  // a scheduled run waits a random slice of its interval first (a fifth, at most thirty minutes), so a rewrite
  // cannot be timed to sit between two predictable runs; --no-jitter for tests and hand runs
  const every = flag("scheduled") && opt("every") ? Number(opt("every")) * 3600 : 0;
  if (every > 0) {
    const st = readState();
    const runs = st.scheduledRuns ?? 0;
    writeState({ ...st, scheduledRuns: runs + 1 });
    if (runs > 0 && !flag("no-jitter")) {
      const wait = Math.floor(Math.random() * Math.min(every / 5, 1800) * 1000);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  const found = discover();
  say(`Read ${found.read.length} config location${found.read.length === 1 ? "" : "s"}.`);
  const instructionFiles = readInstructionFiles(homedir(), process.cwd());
  const byPathHash = new Map(instructionFiles.map((f) => [pathHash(f.path), f.path]));
  const fileUpload = toFileUpload(instructionFiles, process.cwd());
  if (!found.items.length && !instructionFiles.length) {
    console.log("Nothing to pin: no MCP servers, skills or instruction files found.");
    return 0;
  }
  if (!quiet) printTable(found.items);
  const payload = toUpload(found.items);
  // agent firewalls on this machine, names only (decision 156): a count for Small Print, shown in no brief and on no page
  const firewalls = firewallsForUpload(detectFirewalls());
  say(`Agent firewalls: ${firewalls.length ? firewalls.join(", ") : "none detected"}${firewalls.length ? " (name only is sent)" : ""}`);
  say(`\nWill pin ${payload.length} item${payload.length === 1 ? "" : "s"} to your account as machine "${label}" via ${base}/api/sync, and record ${instructionFiles.length} instruction file${instructionFiles.length === 1 ? "" : "s"} there.`);
  say("Sent: names, versions, hosts, file hashes (for a skill, its SKILL.md hash and one hash over all its files); for instruction files a kind label, a hash of the path and the content hash; the names of any agent firewalls found. Not sent: paths, file lists, config values, env vars, tokens, file contents, anything about a firewall but its name.");
  if (flag("dry-run")) {
    for (const f of fileUpload.files) console.log(`  ${pad(f.kind, 44)} ${f.sha256.slice(0, 12)}  path hash ${f.pathHash.slice(0, 12)}`);
    console.log("--dry-run: nothing sent.");
    return 0;
  }
  if (!token) {
    console.error(`\nNo token. Make one on your brief settings page, then: SMALLPRINT_TOKEN=sp_... npx smallprint sync --label \"work laptop\"\nOr keep it in ${tokenFile()} (chmod 600) and leave the environment alone.`);
    return 2;
  }
  if (!flag("yes")) {
    if (!process.stdin.isTTY) {
      console.error("\nRefusing to upload without --yes when not run interactively.");
      return 2;
    }
    const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("\nUpload and pin? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      console.log("Not sent.");
      return 0;
    }
  }
  let res: Response;
  try {
    res = await fetch(`${base}/api/sync`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "user-agent": `smallprint-cli/${VERSION}` }, body: JSON.stringify({ label, items: payload, prune: flag("prune"), files: fileUpload.files, scopes: fileUpload.scopes, firewalls, scheduled: flag("scheduled"), ...(flag("scheduled") && opt("every") ? { every: Math.round(Number(opt("every")) * 3600) } : {}) }), signal: TIMEOUT() });
  } catch (err) {
    console.error(`Could not reach ${base} (${(err as Error).message}). Check your connection or proxy and try again.`);
    return 1;
  }
  if (!res.ok) {
    console.error(`${base}/api/sync answered ${res.status}: ${await errorLine(res)}`);
    return 1;
  }
  interface FileChange {
    pathHash: string;
    kind: string;
    from: string | null;
    to: string | null;
    since: string | null;
    where?: string[];
  }
  const r = (await res.json()) as { pinned: number; created: number; dropped: number; unknown: { name: string; host: string; reason: string }[]; files?: { recorded: number; firstSeen: FileChange[]; changed: FileChange[]; removed: FileChange[]; returned: FileChange[]; limited: { pathHash: string; kind: string; reason: string }[] } };
  const summary = `Pinned ${r.pinned} (${r.created} new${r.dropped ? `, ${r.dropped} dropped` : ""}).`;
  const problems = r.unknown.map((u) => `  not pinned: ${u.name} (${u.host}): ${u.reason}`);
  const where = (c: FileChange) => (c.where ? `  in: ${c.where.length ? c.where.join(", ") : "formatting only"}` : "");
  const name = (c: { pathHash: string; kind: string }) => {
    const p = byPathHash.get(c.pathHash);
    return p ? tilde(p) : c.kind;
  };
  const fileLines: string[] = [];
  const alerts: string[] = [];
  if (r.files) {
    fileLines.push(`Instruction files reported for "${label}": ${r.files.recorded}. The record lives on smallprint.dev and keeps every change; a rewrite here cannot erase it.`);
    for (const c of r.files.changed) alerts.push(`  CHANGED since ${(c.since ?? "").slice(0, 10)}  ${name(c)}  was ${(c.from ?? "").slice(0, 12)}, now ${(c.to ?? "").slice(0, 12)}${where(c)}`);
    for (const c of r.files.removed) alerts.push(`  REMOVED  ${name(c)}  was ${(c.from ?? "").slice(0, 12)} since ${(c.since ?? "").slice(0, 10)}`);
    for (const c of r.files.returned) alerts.push(`  RETURNED ${name(c)}  ${c.from === c.to ? "same content as before" : `changed while away: was ${(c.from ?? "").slice(0, 12)}, now ${(c.to ?? "").slice(0, 12)}${where(c)}`}`);
    if (r.files.firstSeen.length) fileLines.push(`  ${r.files.firstSeen.length} first seen; from the next sync on, a change to any of them is recorded and reaches your brief.`);
    for (const l of r.files.limited) fileLines.push(`  not recorded: ${name(l)}: ${l.reason}`);
  }
  if (quiet) {
    // the scheduled run: one line when nothing moved, the alerts when something did
    console.log(`[${new Date().toISOString()}] ${summary} ${r.files ? `${r.files.recorded} instruction files reported` : ""}${alerts.length ? `; ${alerts.length} CHANGED` : ""}`);
    for (const a of alerts) console.log(a);
    for (const p of problems) console.log(p);
    return 0;
  }
  console.log(`\n${summary}`);
  for (const p of problems) console.log(p);
  for (const l of fileLines) console.log(l);
  if (alerts.length) {
    console.log("  Since the last report from this machine:");
    for (const a of alerts) console.log(a);
    console.log("  These are in your next brief. If that was not you, read the file before your agent does.");
  }
  console.log("Your next brief covers these pins and files.");
  return 0;
}

/** The home directory of another account, asked of the system rather than guessed. */
function homeOf(user: string): string {
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("dscl", [".", "-read", `/Users/${user}`, "NFSHomeDirectory"], { encoding: "utf8" });
      const m = /NFSHomeDirectory:\s*(.+)/.exec(out);
      if (m) return m[1]!.trim();
    } else {
      const out = execFileSync("getent", ["passwd", user], { encoding: "utf8" });
      const home = out.split(":")[5];
      if (home) return home.trim();
    }
  } catch {
    /* fall through */
  }
  return process.platform === "darwin" ? `/Users/${user}` : `/home/${user}`;
}

/** True when a path is owned by root and writable by nobody else: the only kind of file root should run. */
function rootOnly(path: string): boolean {
  try {
    const st = statSync(path);
    return st.uid === 0 && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/**
 * Level four: install, remove or show the root-owned reporter. Needs sudo.
 * Copies the dependency-free Python helper shipped in this package to a
 * root-owned folder, puts the token in a root-owned file, and loads a system
 * job that runs the helper with the system interpreter. Refuses if the
 * interpreter or the destination is writable by anyone but root, because a
 * file the user can edit is a file the user's agent can edit.
 */
async function scheduleSystem(): Promise<number> {
  const plat = process.platform;
  if (plat !== "darwin" && plat !== "linux") {
    console.log("Level four (a root-owned reporter) is available on macOS and Linux. On Windows, level three under an administrator account is the closest equivalent.");
    return 2;
  }
  const paths = systemPaths(plat);
  if (flag("status")) {
    console.log(existsSync(paths.job) ? `Installed: ${paths.job}, helper ${paths.helper}, token ${paths.token} (root-owned). Log: ${paths.log}` : "Not installed. sudo smallprint schedule --install --system --label \"this machine\"");
    return 0;
  }
  if ((process.getuid?.() ?? 1) !== 0) {
    console.error(`Level four installs a root-owned job, so it needs sudo: ${SYSTEM_INSTALL}`);
    return 2;
  }
  // the installer runs as root from the user's shell, which is the one moment an agent running as the user could interfere:
  // a preload in NODE_OPTIONS would run as root before this line. Refuse it rather than run it (decision 110).
  if (process.env.NODE_OPTIONS && (flag("install") || flag("uninstall"))) {
    console.error(`NODE_OPTIONS is set (${process.env.NODE_OPTIONS.slice(0, 80)}). The level-four installer does not run with a preload; unset it, or run: ${SYSTEM_INSTALL}`);
    return 2;
  }
  if (flag("uninstall")) {
    if (plat === "darwin") {
      try {
        execFileSync("launchctl", ["bootout", "system", paths.job], { stdio: "ignore" });
      } catch {
        /* not loaded */
      }
    } else {
      try {
        execFileSync("systemctl", ["disable", "--now", "smallprint-report.timer"], { stdio: "ignore" });
      } catch {
        /* not enabled */
      }
    }
    rmSync(paths.job, { force: true });
    if (paths.timer) rmSync(paths.timer, { force: true });
    rmSync(paths.helper, { force: true });
    rmSync(paths.token, { force: true });
    if (plat === "linux") {
      try {
        execFileSync("systemctl", ["daemon-reload"], { stdio: "ignore" });
      } catch {
        /* fine */
      }
    }
    console.log(`Removed the root-owned reporter, its token and its job. The record on smallprint.dev stays. The log at ${paths.log} is left for you to read or delete.`);
    return 0;
  }
  if (!flag("install")) {
    console.log(`usage: ${SYSTEM_INSTALL} [--user name] [--every 6]\n       sudo npx -y smallprint schedule --uninstall --system\n       smallprint schedule --status --system`);
    return 2;
  }
  const user = opt("user") ?? process.env.SUDO_USER;
  if (!user || user === "root") {
    console.error("Say whose files to read: --user <account>, or run through sudo from that account so SUDO_USER is set.");
    return 2;
  }
  const userHome = homeOf(user);
  // the token: --token, the environment (sudo --preserve-env=SMALLPRINT_TOKEN keeps it), or the account's own token file
  let token = opt("token") ?? process.env.SMALLPRINT_TOKEN;
  if (!token) {
    try {
      token = readFileSync(join(userHome, ".config", "smallprint", "token"), "utf8").trim();
    } catch {
      token = undefined;
    }
  }
  if (!token || !/^sp_[0-9a-f]{48}$/.test(token)) {
    console.error(`No token. Put it in ${join(userHome, ".config", "smallprint", "token")} (chmod 600) or pass it: ${SYSTEM_INSTALL}`);
    return 2;
  }
  const python = "/usr/bin/python3";
  if (!rootOnly(python)) {
    console.error(`${python} is missing or not root-owned. On macOS install the Command Line Tools (xcode-select --install); on Linux install python3 from your distribution. Level four will not run an interpreter the account can edit.`);
    return 2;
  }
  try {
    execFileSync(python, ["-c", "import hashlib, json, pwd, urllib.request"], { stdio: "ignore" });
  } catch {
    console.error(`${python} did not start (on macOS this usually means the Command Line Tools are not installed: xcode-select --install).`);
    return 2;
  }
  const source = fileURLToPath(new URL("../report/smallprint-report.py", import.meta.url));
  if (!existsSync(source)) {
    console.error(`The helper is missing from this install (${source}). Reinstall the package.`);
    return 2;
  }
  const every = Number(opt("every") ?? 6);
  const plan = systemPlan({ platform: plat, user, label: (opt("label") ?? hostname()).slice(0, 60), everyHours: Number.isFinite(every) ? every : 6, base });
  mkdirSync(paths.dir, { recursive: true, mode: 0o755 });
  chownSync(paths.dir, 0, 0);
  chmodSync(paths.dir, 0o755);
  copyFileSync(source, paths.helper);
  chownSync(paths.helper, 0, 0);
  chmodSync(paths.helper, 0o755);
  mkdirSync(paths.tokenDir, { recursive: true, mode: 0o700 });
  chownSync(paths.tokenDir, 0, 0);
  chmodSync(paths.tokenDir, 0o700);
  writeFileSync(paths.token, token + "\n", { mode: 0o600 });
  chownSync(paths.token, 0, 0);
  chmodSync(paths.token, 0o600);
  for (const p of [paths.dir, paths.helper, paths.tokenDir, paths.token]) {
    if (!rootOnly(p)) {
      console.error(`${p} ended up writable by someone other than root; refusing to load the job. Check the ownership of its parent folders.`);
      return 2;
    }
  }
  // the helper's own copy on disk is what runs from now on: npx updates never touch it
  if (plat === "darwin") {
    const { path, body } = systemLaunchdPlist(plan);
    writeFileSync(path, body, { mode: 0o644 });
    chownSync(path, 0, 0);
    try {
      execFileSync("launchctl", ["bootout", "system", path], { stdio: "ignore" });
    } catch {
      /* first install */
    }
    execFileSync("launchctl", ["bootstrap", "system", path], { stdio: "inherit" });
  } else {
    const u = systemUnits(plan);
    writeFileSync(u.service.path, u.service.body, { mode: 0o644 });
    writeFileSync(u.timer.path, u.timer.body, { mode: 0o644 });
    execFileSync("systemctl", ["daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["enable", "--now", "smallprint-report.timer"], { stdio: "inherit" });
  }
  console.log(`Installed the level-four reporter for account "${user}" as machine "${plan.label}":`);
  console.log(`  helper  ${paths.helper} (root-owned, ${python}, standard library only; read it, it is short)`);
  console.log(`  token   ${paths.token} (root-owned, mode 600: the account and its agent cannot read it)`);
  console.log(`  job     ${paths.job} (runs now, then every ${plan.everySeconds / 3600} hours)`);
  console.log(`  log     ${paths.log}`);
  console.log("It reads the account's instruction files, MCP configs and skill folders, sends kind labels and hashes, and nothing else. Remove with: sudo smallprint schedule --uninstall --system");
  console.log("What it does not cover: files in project folders (it runs from the home directory), and an attacker who already has root.");
  return 0;
}

/** Tell the site a machine's schedule is gone. Quiet on every failure: removal must not depend on the network. */
async function tellUnscheduled(label: string): Promise<void> {
  const token = readToken();
  if (!token) return;
  try {
    await fetch(`${base}/api/sync`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "user-agent": `smallprint-cli/${VERSION}` }, body: JSON.stringify({ label, unschedule: true }), signal: TIMEOUT() });
  } catch {
    /* offline: the next hand-run sync says nothing about the schedule either way */
  }
}

/** Install, remove or show the scheduled sync. */
async function schedule(): Promise<number> {
  if (flag("system")) return scheduleSystem();
  const home = homedir();
  const plat = process.platform;
  const plistPath = join(home, "Library", "LaunchAgents", "dev.smallprint.sync.plist");
  const units = systemdUnits(schedulePlan({ home, execPath: process.execPath, version: VERSION, label: "", token: "" }));
  if (flag("status")) {
    if (plat === "darwin") console.log(existsSync(plistPath) ? `Installed: ${plistPath} (launchd, every 6 hours). Log: ~/Library/Logs/smallprint/sync.log` : "Not installed. smallprint schedule --install --label \"this machine\"");
    else if (plat === "linux") console.log(existsSync(units.timer.path) ? `Installed: ${units.timer.path} (systemd user timer). Status: systemctl --user status smallprint-sync.timer` : "Not installed. smallprint schedule --install --label \"this machine\"");
    else console.log("On Windows the schedule is a Task Scheduler entry named \"Small Print sync\": schtasks /Query /TN \"Small Print sync\"");
    return 0;
  }
  if (flag("uninstall")) {
    // the site is told the schedule is gone, so the machine's silence is not news (decision 109); best effort, never blocks the removal
    const installedLabel = (() => {
      try {
        const text = readFileSync(plat === "darwin" ? plistPath : units.service.path, "utf8");
        const m = plat === "darwin" ? /<string>--label<\/string>\s*<string>([^<]*)<\/string>/.exec(text) : /--label "((?:[^"\\]|\\.)*)"/.exec(text);
        return m ? m[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\\"/g, '"') : undefined;
      } catch {
        return undefined;
      }
    })();
    await tellUnscheduled(opt("label") ?? installedLabel ?? hostname());
    if (plat === "darwin") {
      try {
        execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, plistPath], { stdio: "ignore" });
      } catch {
        /* not loaded */
      }
      rmSync(plistPath, { force: true });
      console.log("Removed the launchd agent. The record on smallprint.dev stays; run sync by hand whenever you like.");
    } else if (plat === "linux") {
      try {
        execFileSync("systemctl", ["--user", "disable", "--now", "smallprint-sync.timer"], { stdio: "ignore" });
      } catch {
        /* not enabled */
      }
      rmSync(units.timer.path, { force: true });
      rmSync(units.service.path, { force: true });
      try {
        execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      } catch {
        /* fine */
      }
      console.log("Removed the systemd user timer. The record on smallprint.dev stays.");
    } else console.log('Remove it with: schtasks /Delete /TN "Small Print sync" /F');
    return 0;
  }
  if (!flag("install")) {
    console.log("usage: smallprint schedule --install --label \"work laptop\" [--every 6]   (SMALLPRINT_TOKEN=sp_...)\n       smallprint schedule --status | --uninstall\nInstalls a job on this machine that runs \"smallprint sync\" every six hours: it sends names, versions, hosts and hashes, never paths or contents, and logs locally. You install it; --uninstall removes it.");
    return 2;
  }
  const token = readToken();
  if (!token || !/^sp_[0-9a-f]{48}$/.test(token)) {
    console.error(`No token. Make one on your brief settings page, then: SMALLPRINT_TOKEN=sp_... npx smallprint schedule --install --label \"work laptop\" (or keep it in ${tokenFile()}, chmod 600)`);
    return 2;
  }
  const label = (opt("label") ?? hostname()).slice(0, 60);
  const every = Number(opt("every") ?? 6);
  const plan = schedulePlan({ home, execPath: process.execPath, version: VERSION, label, token, everyHours: Number.isFinite(every) ? every : 6 });
  if (plat === "darwin") {
    const { path, body } = launchdPlist(plan);
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(join(home, "Library", "Logs", "smallprint"), { recursive: true });
    writeFileSync(path, body, { mode: 0o600 });
    chmodSync(path, 0o600);
    const domain = `gui/${process.getuid?.() ?? 501}`;
    try {
      execFileSync("launchctl", ["bootout", domain, path], { stdio: "ignore" });
    } catch {
      /* first install */
    }
    execFileSync("launchctl", ["bootstrap", domain, path], { stdio: "inherit" });
    console.log(`Installed ${path} (readable by you only; it holds your token). It runs "smallprint sync --scheduled" now, then every ${plan.everySeconds / 3600} hours at a random moment inside a fifth of that, as machine "${label}", with npx pinned to smallprint@${VERSION}. Each run sends names, versions, hosts and hashes; never paths, contents or config values.`);
    console.log("Log: ~/Library/Logs/smallprint/sync.log. Remove with: smallprint schedule --uninstall");
    return 0;
  }
  if (plat === "linux") {
    const u = systemdUnits(plan);
    mkdirSync(u.dir, { recursive: true });
    writeFileSync(u.service.path, u.service.body, { mode: 0o600 });
    chmodSync(u.service.path, 0o600);
    writeFileSync(u.timer.path, u.timer.body, { mode: 0o644 });
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", "smallprint-sync.timer"], { stdio: "inherit" });
    console.log(`Installed ${u.timer.path} and ${u.service.path} (the service file, which holds the token, is readable by you only). Runs every ${plan.everySeconds / 3600} hours as machine "${label}".`);
    console.log("If this machine has no login session at boot, run once: loginctl enable-linger $USER. Remove with: smallprint schedule --uninstall");
    return 0;
  }
  console.log("Windows: run this once in an elevated prompt (it stores the token in the task):");
  console.log(schtasksCommand(plan));
  return 0;
}


/**
 * `smallprint gate` (decision 145): the pre-session check. Every server this machine runs is looked up on the record,
 * and the command exits non-zero when the small print of an installed version moved since the lock, or when an
 * advisory names an installed version. One request per server, names and versions only, nothing else sent. Made for
 * a shell hook or a launcher: `smallprint gate && claude`.
 */
async function gate(): Promise<number> {
  const found = discover();
  const scope = lockScope();
  const items = toUpload(scope === "project" ? projectItems(found.items, process.cwd()) : found.items).filter((i) => i.kind === "mcp" && i.canonicalName);
  const path = lockPath();
  const locked = existsSync(path) ? parseLock(readFileSync(path, "utf8")) : null;
  const lockedVersion = new Map<string, string | null>();
  if (locked) for (const l of locked.items) if (l.canonicalName) lockedVersion.set(l.canonicalName, l.version);
  if (!items.length) {
    console.log("No MCP servers with a registry identity found in the configs read; nothing to gate on.");
    return 0;
  }
  const strict = flag("strict");
  let moved = 0, advisories = 0, unknown = 0;
  for (const it of items) {
    const cn = it.canonicalName!;
    const [registry, ...rest] = cn.split(":");
    const url = `${base}/api/asset/${registry}/${rest.join(":").split("/").map(encodeURIComponent).join("/")}`;
    let e: { asset: { latestVersion: string | null; url: string }; baseline: { version: string; contentHash: string | null } | null; advisories: { id: string; severity: string; versionRange: string | null }[]; releases: { from: string | null; to: string; publishedAt: string | null; worst: string; identical: boolean }[]; versions: { version: string; publishedAt: string | null; contentHash: string | null }[] };
    try {
      const res = await fetch(url, { headers: { accept: "application/json", "user-agent": `smallprint-cli/${VERSION}` }, signal: TIMEOUT() });
      if (res.status === 404) { console.log(`  ?  ${cn}: not on the record`); unknown++; continue; }
      if (!res.ok) { console.log(`  ?  ${cn}: record answered ${res.status}`); unknown++; continue; }
      e = (await res.json()) as typeof e;
    } catch (err) {
      console.log(`  ?  ${cn}: ${(err as Error).message}`); unknown++; continue;
    }
    const installed = it.version ?? lockedVersion.get(cn) ?? null;
    const since = lockedVersion.get(cn) ?? installed;
    const sinceRow = since ? e.versions.find((v) => v.version === since) : undefined;
    const changedSince = sinceRow ? e.releases.filter((r) => !r.identical && (r.publishedAt ?? "") > (sinceRow.publishedAt ?? "")) : [];
    const worst = changedSince.reduce((w, r) => (RANK_ORDER.indexOf(r.worst) > RANK_ORDER.indexOf(w) ? r.worst : w), "info");
    const adv = e.advisories.filter((a) => a.severity === "critical" || a.severity === "high");
    const line = [`${cn}${installed ? ` @ ${installed}` : ""}`];
    if (!sinceRow) { line.push(since ? `version ${since} not read on the record` : "no version to compare"); unknown++; }
    else if (changedSince.length) { line.push(`small print moved in ${changedSince.length} release(s) since ${since}, worst ${worst}`); moved++; }
    else line.push(`unchanged since ${since}`);
    if (adv.length) { line.push(`${adv.length} high or critical advisory(ies): ${adv.map((a) => a.id).join(", ")}`); advisories++; }
    console.log(`  ${changedSince.length || adv.length ? "!" : sinceRow ? "ok" : "?"}  ${line.join("; ")}  ${e.asset.url}`);
  }
  const bad = moved + advisories + (strict ? unknown : 0);
  console.log(bad ? `Gate: ${moved} moved, ${advisories} with advisories, ${unknown} unknown. Exit ${moved || (strict && unknown) ? 2 : 3}.` : `Gate: clear. ${items.length} server(s), ${unknown} unknown.`);
  if (!bad) return 0;
  return moved || (strict && unknown) ? 2 : 3;
}
const RANK_ORDER = ["info", "low", "medium", "high", "critical"];

if (cmd === "check") {
  process.exit(await check());
} else if (cmd === "lock") {
  process.exit(lock());
} else if (cmd === "gate") {
  process.exit(await gate());
} else if (cmd === "sync") {
  process.exit(await sync());
} else if (cmd === "schedule") {
  process.exit(await schedule());
} else if (cmd === "--version" || cmd === "-v" || cmd === "version") {
  console.log(VERSION);
  process.exit(0);
} else {
  console.log(`smallprint ${VERSION}
usage: smallprint check [--json] [--no-upload] [--share] [--email <you@x>] [--no-signup] [--base <url>]
       smallprint lock [--project] [--file smallprint.lock]   write what this machine runs, and its instruction-file hashes, to a file you commit; --project keeps to this directory
       smallprint check --locked [--project] [--file ...]      compare with the lock, exit 2 when anything moved; local only, works offline, made for CI
       smallprint gate [--project] [--strict]                  ask the record about every server here: exit 2 when a small print moved since the lock, 3 when a high advisory names one; for a shell hook before a session
       smallprint sync --label "work laptop" [--yes] [--prune] [--dry-run] [--base <url>]   (SMALLPRINT_TOKEN=sp_...)
       smallprint schedule --install --label "work laptop" [--every 6] | --status | --uninstall
       sudo --preserve-env=PATH,SMALLPRINT_TOKEN smallprint schedule --install --system --label "work laptop"   (level four: a root-owned reporter the agent cannot reach)
  check   find every MCP server and skill your agents have installed and grade them; --json prints the inventory and sends nothing
          also hashes your instruction files (CLAUDE.md, AGENTS.md, OpenClaw workspace, Cursor and Windsurf rules) and reports any that changed since the last run, locally
  sync    pin that inventory to your account so the daily brief watches it (token from your settings page);
          also records your instruction files there as hashes, so a rewrite on this machine cannot erase the record
  schedule  installs a job on this machine that runs sync every six hours (launchd on macOS, systemd on Linux); you install it, you remove it
Three ways to keep the record of your instruction files, weakest to strongest:
  check     the record is a file on this machine; an agent that can write files can change it too
  sync      the record is on smallprint.dev and keeps every change; seen the next time you run sync
  schedule  the same, every six hours, and a machine that goes quiet is reported
  --system  the same from a root-owned job with a root-owned token: an agent running as you cannot read, forge or stop it
Token: --token, or SMALLPRINT_TOKEN in the environment, or ~/.config/smallprint/token (a file only you can read; chmod 600).
Nothing leaves the machine but names, versions, hosts and file hashes; sync adds a kind label and a hash of the path for each instruction file, and the names of any agent firewalls it finds installed (pipelock, AgentGate and the like), nothing about them. https://smallprint.dev/cli`);
  process.exit(cmd && cmd !== "--help" && cmd !== "-h" && cmd !== "help" ? 2 : 0);
}
