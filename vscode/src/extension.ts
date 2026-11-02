/**
 * Small Print for VS Code and Cursor. It reads the same agent configs the command reads, on this machine, and watches:
 * instruction files and skills by hash, locally; MCP servers against the public record, only after the person allows it,
 * and then only the package name leaves the machine (GET /api/asset/<name>, the request `smallprint gate` makes).
 */
import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { discover, type DiscoveredServer, type DiscoveredSkill } from "../../cli/src/discover";
import { readInstructionFiles, type InstructionFile } from "../../cli/src/instructions";
import { DEFAULT_BASE, evaluateLocal, evaluateServer, failedWords, lookupWords, notifies, plural, safeBase, userSetting, type Finding, type RecordEntry, type ServerState } from "./core";

const VERSION = "1.0.1";
const LOCAL_SCAN_MS = 10 * 60_000;
const OWN_SAVE_MS = 15_000;

interface Stored {
  servers: Record<string, ServerState>;
  skills: Record<string, string>;
  files: Record<string, string>;
  findings: Finding[];
  lastLocalAt: string | null;
  lastRecordAt: string | null;
  recordError: string | null;
  /** Each server's last lookup that brought no record: 404, another status, or null for no answer (pass 5 audit of 16 Oct 2026). */
  lookups?: Record<string, number | null>;
}
const EMPTY: Stored = { servers: {}, skills: {}, files: {}, findings: [], lastLocalAt: null, lastRecordAt: null, recordError: null };

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const cfg = () => vscode.workspace.getConfiguration("smallprint");
// what may leave the machine, and to where, comes from the user's own settings only, never a workspace's (security audit item 40)
const lookupSetting = () => userSetting(cfg().inspect<string>("lookup"), "ask");
const baseSetting = () => safeBase(userSetting(cfg().inspect<string>("baseUrl"), DEFAULT_BASE));
const et = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never");
const home = homedir();
const tilde = (p: string) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);
const skillHash = (s: DiscoveredSkill) => sha(s.files.map((f) => `${f.path}\t${f.sha256}`).sort().join("\n") + `\n${s.skillMdSha256}`);
const keyOf = (i: { kind: string; host: string; name: string }) => `${i.kind}:${i.host}:${i.name}`;

let ctx: vscode.ExtensionContext;
let tree: WatchTree;
let status: vscode.StatusBarItem;
let servers: DiscoveredServer[] = [];
let skills: DiscoveredSkill[] = [];
let files: InstructionFile[] = [];
let watchers: vscode.Disposable[] = [];
const ownSaves = new Map<string, number>();

const load = (): Stored => ({ ...EMPTY, ...(ctx.globalState.get<Stored>("smallprint.state") ?? {}) });
const save = (s: Stored) => ctx.globalState.update("smallprint.state", s);
const copyUri = (path: string) => vscode.Uri.joinPath(ctx.globalStorageUri, "files", `${sha(path).slice(0, 24)}.txt`);

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  ctx = context;
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(ctx.globalStorageUri, "files"));
  tree = new WatchTree();
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider("smallprint.watch", tree));
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.command = "workbench.view.extension.smallprint";
  ctx.subscriptions.push(status);
  ctx.subscriptions.push(
    vscode.commands.registerCommand("smallprint.checkNow", () => runAll(true)),
    vscode.commands.registerCommand("smallprint.allowLookup", async () => { await cfg().update("lookup", "allow", vscode.ConfigurationTarget.Global); await runAll(true); }),
    vscode.commands.registerCommand("smallprint.showSent", showSent),
    vscode.commands.registerCommand("smallprint.askLookup", () => checkRecord(true)),
    vscode.commands.registerCommand("smallprint.openEntry", (url: string) => vscode.env.openExternal(vscode.Uri.parse(url))),
    vscode.commands.registerCommand("smallprint.showFileChange", showFileChange),
    vscode.commands.registerCommand("smallprint.acceptAll", async () => { const s = load(); for (const f of s.findings) if (f.kind === "file-changed" && f.url) await keepCopy(f.url); s.findings = []; await save(s); refresh(); }),
    vscode.workspace.onDidSaveTextDocument((d) => ownSaves.set(d.uri.fsPath, Date.now())),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("smallprint")) void runAll(false); }),
  );
  refresh();
  setTimeout(() => void runAll(false), 5_000);
  const local = setInterval(() => void scanLocal(), LOCAL_SCAN_MS);
  const record = setInterval(() => void checkRecord(false), Math.max(1, cfg().get<number>("checkEveryHours", 6)) * 3_600_000);
  ctx.subscriptions.push({ dispose: () => { clearInterval(local); clearInterval(record); watchers.forEach((w) => w.dispose()); } });
}

export function deactivate(): void {}

async function runAll(asked: boolean): Promise<void> {
  await scanLocal();
  await checkRecord(asked);
}

/** Read the configs, skills and instruction files on this machine, and compare skills and files with the last scan. Sends nothing. */
async function scanLocal(): Promise<void> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? home;
  const found = discover({ home, cwd });
  servers = found.items.filter((i): i is DiscoveredServer => i.kind === "mcp");
  skills = found.items.filter((i): i is DiscoveredSkill => i.kind === "agent-skill");
  files = readInstructionFiles(home, cwd);
  const s = load();
  const fresh: Finding[] = [];
  for (const k of skills) {
    const key = keyOf(k), h = skillHash(k);
    const f = evaluateLocal("skill-changed", key, k.displayName ?? k.name, h, s.skills[key]);
    if (f) fresh.push(f);
    s.skills[key] = h;
  }
  for (const file of files) {
    const prev = s.files[file.path];
    const mine = (ownSaves.get(file.path) ?? 0) > Date.now() - OWN_SAVE_MS;
    const f = mine ? null : evaluateLocal("file-changed", file.path, tilde(file.path), file.sha256, prev);
    if (f) fresh.push({ ...f, url: file.path });
    // the copy kept on this machine is what the next change is shown against; it never leaves the machine
    if (prev !== file.sha256 && !f) await keepCopy(file.path);
    if (!prev) await keepCopy(file.path);
    s.files[file.path] = file.sha256;
  }
  s.lastLocalAt = new Date().toISOString();
  await addFindings(s, fresh);
  watchFiles();
}

async function keepCopy(path: string): Promise<void> {
  try { await vscode.workspace.fs.writeFile(copyUri(path), await vscode.workspace.fs.readFile(vscode.Uri.file(path))); } catch { /* unreadable now */ }
}

/** Watch each instruction file, so a change made by another program shows within seconds, not at the next scan. */
function watchFiles(): void {
  watchers.forEach((w) => w.dispose());
  watchers = files.map((f) => {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(f.path.replace(/\/[^/]+$/, "")), f.path.replace(/^.*\//, "")));
    const again = () => setTimeout(() => void scanLocal(), 1_500);
    w.onDidChange(again); w.onDidCreate(again); w.onDidDelete(again);
    return w;
  });
}

/** Ask the record about each MCP server with a package identity, if the person allowed it. Only the name is sent. */
async function checkRecord(asked: boolean): Promise<void> {
  const lookup = lookupSetting();
  const named = servers.filter((x) => x.canonicalName);
  if (!named.length || lookup === "never") { refresh(); return; }
  if (lookup === "ask") {
    if (ctx.globalState.get("smallprint.askedAt") && !asked) { refresh(); return; }
    await ctx.globalState.update("smallprint.askedAt", new Date().toISOString());
    const pick = await vscode.window.showInformationMessage(
      `Small Print found ${named.length} MCP server${named.length === 1 ? "" : "s"} your agents use. To tell you when what they say to your agent changes, it looks each one up on smallprint.dev by its package name. Nothing else is sent: no versions, config values, keys or paths.`,
      "Allow", "Show what would be sent", "Keep it on this machine");
    if (pick === "Show what would be sent") { await showSent(); return; }
    if (pick === "Keep it on this machine") { await cfg().update("lookup", "never", vscode.ConfigurationTarget.Global); refresh(); return; }
    if (pick !== "Allow") { refresh(); return; }
    await cfg().update("lookup", "allow", vscode.ConfigurationTarget.Global);
  }
  const base = baseSetting();
  const s = load();
  const fresh: Finding[] = [];
  let failed = 0;
  for (const x of named) {
    const [registry, ...rest] = x.canonicalName!.split(":");
    const url = `${base}/api/asset/${registry}/${rest.join(":").split("/").map(encodeURIComponent).join("/")}`;
    const key = keyOf(x);
    const lookups = (s.lookups ??= {});
    try {
      const res = await fetch(url, { headers: { accept: "application/json", "user-agent": `smallprint-vscode/${VERSION}` }, signal: AbortSignal.timeout(20_000) });
      // a 404 and a failed lookup are told apart in the panel (pass 5 audit of 16 Oct 2026)
      if (res.status === 404) { lookups[key] = 404; continue; }
      if (!res.ok) { lookups[key] = res.status; failed++; continue; }
      const entry = (await res.json()) as RecordEntry;
      const r = evaluateServer(key, x.name, x.version, entry, s.servers[key]);
      s.servers[key] = r.state;
      delete lookups[key];
      fresh.push(...r.findings);
    } catch { lookups[key] = null; failed++; }
  }
  s.lastRecordAt = new Date().toISOString();
  s.recordError = failed ? failedWords(failed) : null;
  await addFindings(s, fresh);
}

async function addFindings(s: Stored, fresh: Finding[]): Promise<void> {
  const known = new Set(s.findings.map((f) => f.key));
  const added = fresh.filter((f) => !known.has(f.key));
  s.findings = [...added, ...s.findings].slice(0, 100);
  await save(s);
  refresh();
  const level = cfg().get<"high" | "any" | "none">("notify", "high");
  for (const f of added.filter((x) => notifies(x, level)).slice(0, 3)) void notice(f);
}

async function notice(f: Finding): Promise<void> {
  const local = f.kind === "file-changed";
  const actions = local ? ["Show what changed", "It was me"] : f.url ? ["Open on smallprint.dev", "Mark as seen"] : ["Mark as seen"];
  const pick = await vscode.window.showWarningMessage(`Small Print: ${f.title}. ${f.detail}`, ...actions);
  if (pick === "Show what changed") await showFileChange(f.url!);
  if (pick === "Open on smallprint.dev") await vscode.env.openExternal(vscode.Uri.parse(f.url!));
  if (pick === "Mark as seen" || pick === "It was me") await dismiss(f.key);
}

async function dismiss(key: string): Promise<void> {
  const s = load();
  for (const f of s.findings) if (f.key === key && f.kind === "file-changed" && f.url) await keepCopy(f.url);
  s.findings = s.findings.filter((f) => f.key !== key);
  await save(s);
  refresh();
}

/** The copy kept at the last scan beside the file as it is now. */
async function showFileChange(path: string): Promise<void> {
  // the kept copy moves forward only when the change is marked as seen, so this view always shows the change itself
  await vscode.commands.executeCommand("vscode.diff", copyUri(path), vscode.Uri.file(path), `${tilde(path)}: last seen by Small Print ↔ now`);
}

async function showSent(): Promise<void> {
  const base = baseSetting();
  const lines = [
    "What Small Print for VS Code sends, and only after you allow it:",
    "",
    "One request per MCP server that has a package name, asking the public record about that package:",
    "",
    ...servers.filter((x) => x.canonicalName).map((x) => { const [r, ...rest] = x.canonicalName!.split(":"); return `  GET ${base}/api/asset/${r}/${rest.join(":")}`; }),
    "",
    "Nothing else leaves this machine: no versions, no config values, no environment variables, no keys, no file paths,",
    "no file contents. Instruction files and skills are compared by hash on this machine, and the copy used to show",
    "what changed is kept in this editor's own storage on this machine.",
    "",
    "To keep everything on this machine, set \"smallprint.lookup\" to \"never\".",
  ];
  const doc = await vscode.workspace.openTextDocument({ content: lines.join("\n"), language: "text" });
  await vscode.window.showTextDocument(doc, { preview: true });
}

function refresh(): void {
  const s = load();
  const open = s.findings.length;
  // the one-time question slides away on its own in VS Code, so until the person answers it the status bar keeps asking
  // (30 Sep 2026: 375 store downloads and not one lookup from an outside machine)
  const unanswered = !open && lookupSetting() === "ask" && servers.some((x) => x.canonicalName);
  status.command = unanswered ? "smallprint.askLookup" : "workbench.view.extension.smallprint";
  status.text = open ? `$(warning) Small Print: ${open} to look at` : unanswered ? "$(question) Small Print: check your MCP servers?" : "$(shield) Small Print";
  status.tooltip = unanswered ? "Click to choose whether Small Print may look up your MCP servers on smallprint.dev by package name. Nothing is sent until you choose Allow." : open ? `${open} to look at. Click to see them.` : `Watching ${plural(servers.length, "MCP server")}, ${plural(skills.length, "skill")} and ${plural(files.length, "instruction file")}. Last checked ${et(s.lastRecordAt ?? s.lastLocalAt)}.`;
  status.show();
  tree.fire();
}

type Node = { id: string; label: string; description?: string; tooltip?: string; icon?: string; color?: string; children?: Node[]; command?: vscode.Command; context?: string };

class WatchTree implements vscode.TreeDataProvider<Node> {
  private ev = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.ev.event;
  fire() { this.ev.fire(undefined); }
  getTreeItem(n: Node): vscode.TreeItem {
    // a group opens expanded while it is short enough to read at a glance; a long list of skills starts folded
    const t = new vscode.TreeItem(n.label, n.children ? (n.id === "findings" || n.children.length <= 8 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
    t.id = n.id; t.description = n.description; t.tooltip = n.tooltip; t.command = n.command; t.contextValue = n.context;
    if (n.icon) t.iconPath = new vscode.ThemeIcon(n.icon, n.color ? new vscode.ThemeColor(n.color) : undefined);
    return t;
  }
  getChildren(n?: Node): Node[] {
    if (n) return n.children ?? [];
    const s = load();
    const lookup = lookupSetting();
    const roots: Node[] = [];
    if (s.findings.length) roots.push({ id: "findings", label: "Needs a look", description: String(s.findings.length), icon: "warning", color: "list.warningForeground", children: s.findings.map((f) => ({
      id: `f:${f.key}`, label: f.title, tooltip: `${f.title}\n\n${f.detail}`, icon: f.kind === "advisory" ? "shield" : f.kind === "file-changed" ? "diff" : "warning", color: f.grade === "critical" || f.grade === "high" ? "list.errorForeground" : "list.warningForeground",
      command: f.kind === "file-changed" ? { command: "smallprint.showFileChange", title: "Show what changed", arguments: [f.url] } : f.url ? { command: "smallprint.openEntry", title: "Open", arguments: [f.url] } : undefined,
    })) });
    roots.push({ id: "servers", label: "MCP servers", description: String(servers.length), icon: "server", children: servers.map((x) => {
      const st = s.servers[keyOf(x)];
      const why = !x.canonicalName ? (x.remoteHost ? `hosted at ${x.remoteHost}; run \`npx smallprint check --live\` to compare it` : "a local path, not a published package") : lookup === "never" ? "lookup is off" : st ? `on record, checked ${et(st.checkedAt)}` : s.lookups && keyOf(x) in s.lookups ? lookupWords(s.lookups[keyOf(x)] ?? null) : "not looked up yet";
      // never a check mark: being on record says nothing about whether a server is fine, and Small Print does not say that
      const open = s.findings.filter((f) => f.key.includes(`:${keyOf(x)}:`));
      const icon = open.length ? "warning" : st ? "eye" : "circle-outline";
      return { id: `s:${keyOf(x)}`, label: x.name, description: `${x.version ?? "version unknown"} · ${x.host}`, tooltip: `${x.canonicalName ?? x.name}\n${why}${open.length ? `\n${open.length} to look at` : ""}`, icon, color: open.length ? "list.warningForeground" : undefined, command: st ? { command: "smallprint.openEntry", title: "Open", arguments: [`https://smallprint.dev/a/${x.canonicalName!.replace(":", "/")}`] } : undefined };
    }) });
    roots.push({ id: "skills", label: "Skills", description: String(skills.length), icon: "book", children: skills.map((k) => ({ id: `k:${keyOf(k)}`, label: k.displayName ?? k.name, description: k.host, tooltip: `${tilde(k.path)}\nwatched on this machine by its files' hashes`, icon: "eye" })) });
    roots.push({ id: "files", label: "Instruction files", description: String(files.length), icon: "file-text", children: files.map((f) => ({ id: `i:${f.path}`, label: tilde(f.path), description: f.kind, tooltip: "watched on this machine; a change made outside this editor gets a notice", icon: "eye", command: { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(f.path)] } })) });
    const named = servers.filter((x) => x.canonicalName).length;
    const note = !named ? `Watching on this machine, checked ${et(s.lastLocalAt)}` : lookup === "never" ? "Everything stays on this machine" : lookup === "ask" ? "Allow looking up servers on the record" : `Last checked ${et(s.lastRecordAt)}${s.recordError ? " (some lookups failed)" : ""}`;
    roots.push({ id: "footer", label: note, icon: lookup === "ask" && named ? "unlock" : "clock", tooltip: s.recordError ?? undefined, command: lookup === "ask" && named ? { command: "smallprint.allowLookup", title: "Allow" } : { command: "smallprint.checkNow", title: "Check now" } });
    return roots;
  }
}
