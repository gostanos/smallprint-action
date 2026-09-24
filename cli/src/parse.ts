/**
 * Pure config parsing: no filesystem, no network, no node built-ins, so the
 * same code runs in the CLI and in the browser (the paste-a-config form). It
 * reads server names, commands, args and URLs. Env values are inspected for
 * hygiene notes and discarded; nothing here retains them.
 */
export type Host = "claude-code" | "claude-desktop" | "cursor" | "codex" | "windsurf" | "vscode" | "zed" | "gemini" | "cline" | "roo" | "openclaw" | "hermes" | "harnos" | "manual";

/** Names that can be published: an npm package (optionally scoped) or a PyPI project. Paths never qualify. */
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
/** What a pinned version may look like (semver, PEP 440, dist tags). Anything else, such as a path after an @, is dropped. */
const VERSION_SHAPE = /^[0-9A-Za-z][0-9A-Za-z.+_~-]{0,63}$/;
const cleanVersion = (v: string | null | undefined): string | null => (v && VERSION_SHAPE.test(v) ? v : null);
const SECRET_KEY = /(key|token|secret|password|passwd|credential|auth)/i;
const SECRET_VALUE = /^(sk-|ghp_|github_pat_|xox[abp]-|AKIA|AIza|-----BEGIN)|^[A-Za-z0-9_\-]{32,}$/;

export interface DiscoveredServer {
  kind: "mcp";
  host: Host;
  /** Name as configured in the host. */
  name: string;
  configPath: string;
  transport: "stdio" | "http" | "sse" | "unknown";
  /** Best-effort package identity from the command line: npm:<pkg>, pypi:<pkg>, oci:<image>, or null for local paths. */
  canonicalName: string | null;
  /** Version pinned in the command line (npx pkg@1.2.3), if any. */
  version: string | null;
  /** Remote URL for http/sse servers (host only is kept, never query strings). */
  remoteHost: string | null;
  /** Local-only observations, never uploaded. */
  hygiene: string[];
}

export interface DiscoveredSkill {
  kind: "agent-skill";
  host: Host;
  name: string;
  path: string;
  /** SKILL.md frontmatter name / description when present. */
  displayName: string | null;
  description: string | null;
  /** Plain sha256 of SKILL.md and of every file, for the server to canonicalize. */
  files: { path: string; sha256: string }[];
  skillMdSha256: string;
}

export type Discovered = DiscoveredServer | DiscoveredSkill;


export function inferPackage(command: string | undefined, args: readonly string[]): { canonicalName: string | null; version: string | null; transport: DiscoveredServer["transport"] } {
  let cmd = ((command ?? "").split(/[\\/]/).pop() ?? "").replace(/\.(?:cmd|exe|bat)$/i, "").toLowerCase();
  let a = args.filter((x) => typeof x === "string");
  // Windows shims: "cmd /c npx ..." and "powershell -Command npx ..."
  if ((cmd === "cmd" && /^\/c$/i.test(a[0] ?? "")) || (cmd === "powershell" && /^-c(?:ommand)?$/i.test(a[0] ?? ""))) {
    cmd = ((a[1] ?? "").split(/[\\/]/).pop() ?? "").replace(/\.(?:cmd|exe|bat)$/i, "").toLowerCase();
    a = a.slice(2);
  }
  const firstPositional = (list: readonly string[]) => list.find((x) => !x.startsWith("-"));
  const splitVersion = (spec: string): [string, string | null] => {
    const m = /^(@?[^@]+)(?:@(.+))?$/.exec(spec);
    return m ? [m[1]!, m[2] ?? null] : [spec, null];
  };
  if (cmd === "npx" || cmd === "bunx" || cmd === "pnpx" || (cmd === "pnpm" && a[0] === "dlx") || (cmd === "yarn" && a[0] === "dlx")) {
    const rest = cmd === "npx" || cmd === "bunx" || cmd === "pnpx" ? a : a.slice(1);
    const spec = firstPositional(rest.filter((x) => x !== "-y" && x !== "--yes" && !x.startsWith("--package")));
    if (spec && NPM_NAME.test(splitVersion(spec)[0])) {
      const [name, version] = splitVersion(spec);
      return { canonicalName: `npm:${name}`, version: cleanVersion(version), transport: "stdio" };
    }
  }
  if (cmd === "uvx" || cmd === "pipx") {
    // pipx runs a package with `pipx run [options] <spec> [args]`; uvx is `uvx [options] <spec> [args]`.
    // Options that take a value are skipped with their value, so `--python 3.11` never becomes the package;
    // `--from` (uvx) and `--spec` (pipx) name the package itself when the positional is an entry point.
    const rest = cmd === "pipx" ? (a[0] === "run" ? a.slice(1) : []) : a;
    const valued = new Set(["--python", "-p", "--with", "-w", "--with-requirements", "--with-editable", "--index", "--default-index", "--index-url", "-i", "--extra-index-url", "--find-links", "-f", "--constraint", "-c", "--overrides", "--build-constraint", "--refresh-package", "--python-preference", "--python-platform", "--cache-dir", "--config-file", "--project", "--directory", "--exclude-newer", "--resolution", "--prerelease", "--color", "--link-mode", "--pip-args", "--spec"]);
    let spec: string | undefined;
    let named: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const x = rest[i]!;
      if (x === "--from" || x === "--spec") {
        named = rest[i + 1];
        i++;
        continue;
      }
      if (valued.has(x)) {
        i++;
        continue;
      }
      if (x.startsWith("-")) continue;
      spec = x;
      break;
    }
    const chosen = named ?? spec;
    if (chosen) {
      const m = /^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?(?:==(.+))?$/.exec(chosen);
      if (m) return { canonicalName: `pypi:${m[1]!.toLowerCase().replace(/[-_.]+/g, "-")}`, version: cleanVersion(m[2]), transport: "stdio" };
    }
    return { canonicalName: null, version: null, transport: "stdio" };
  }
  if (cmd === "uv" && a[0] === "run") {
    const rest = a.slice(1);
    let spec: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const x = rest[i]!;
      if (x === "--directory" || x === "--project" || x === "--with" || x === "--python" || x === "-p") {
        i++; // the value belongs to the option
        continue;
      }
      if (x.startsWith("-")) continue;
      spec = x;
      break;
    }
    if (spec && PYPI_NAME.test(spec)) return { canonicalName: `pypi:${spec.toLowerCase().replace(/[-_.]+/g, "-")}`, version: null, transport: "stdio" };
    return { canonicalName: null, version: null, transport: "stdio" };
  }
  if ((cmd === "python" || cmd === "python3") && a[0] === "-m" && a[1] && PYPI_NAME.test(a[1])) {
    return { canonicalName: `pypi:${a[1].toLowerCase().replace(/[-_.]+/g, "-")}`, version: null, transport: "stdio" };
  }
  if (cmd === "docker" && a[0] === "run") {
    // the image is the first argument that looks like repo/image[:tag]; anything after it is the container command
    const image = a.slice(1).find((x) => /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+(:[A-Za-z0-9._-]+)?$/.test(x) && !x.startsWith("/") && !x.startsWith("."));
    if (image) {
      const [name, version] = image.includes(":") ? [image.slice(0, image.lastIndexOf(":")), image.slice(image.lastIndexOf(":") + 1)] : [image, null];
      return { canonicalName: `oci:${name}`, version: cleanVersion(version), transport: "stdio" };
    }
  }
  if (cmd === "node" || cmd === "deno" || cmd === "bun" || cmd === "python" || cmd === "python3" || cmd === "sh" || cmd === "bash") return { canonicalName: null, version: null, transport: "stdio" };
  return { canonicalName: null, version: null, transport: command ? "stdio" : "unknown" };
}

/** Env hygiene only: which env values look like plaintext secrets. Values are inspected and discarded, never returned. */
export function envHygiene(entry: Record<string, unknown>, configPath: string): string[] {
  const out: string[] = [];
  const env = entry.env;
  if (env && typeof env === "object") {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v !== "string" || !v) continue;
      if (SECRET_KEY.test(k) || SECRET_VALUE.test(v)) out.push(`env ${k} holds a plaintext secret in ${configPath}`);
    }
  }
  return out;
}

function serverFromEntry(host: Host, name: string, entry: Record<string, unknown>, configPath: string): DiscoveredServer {
  const command = typeof entry.command === "string" ? entry.command : undefined;
  const args = Array.isArray(entry.args) ? (entry.args as string[]) : [];
  const url = typeof entry.url === "string" ? entry.url : typeof entry.serverUrl === "string" ? entry.serverUrl : null;
  const inferred = inferPackage(command, args);
  let transport = inferred.transport;
  let remoteHost: string | null = null;
  if (url) {
    transport = typeof entry.type === "string" && /sse/i.test(entry.type) ? "sse" : "http";
    try {
      remoteHost = new URL(url).host;
    } catch {
      remoteHost = null;
    }
  }
  return { kind: "mcp", host, name, configPath, transport, canonicalName: inferred.canonicalName, version: inferred.version, remoteHost, hygiene: envHygiene(entry, configPath) };
}

export function parseClaudeJson(text: string, host: Host, configPath: string): DiscoveredServer[] {
  const j = JSON.parse(text) as Record<string, unknown>;
  const out: DiscoveredServer[] = [];
  const take = (map: unknown) => {
    if (!map || typeof map !== "object") return;
    for (const [name, entry] of Object.entries(map as Record<string, unknown>)) if (entry && typeof entry === "object") out.push(serverFromEntry(host, name, entry as Record<string, unknown>, configPath));
  };
  take(j.mcpServers);
  // VS Code keeps them under "servers", Zed under "context_servers" (decision 143)
  take(j.servers);
  take(j.context_servers);
  // ~/.claude.json keeps per-project servers under projects.<path>.mcpServers
  if (j.projects && typeof j.projects === "object") for (const p of Object.values(j.projects as Record<string, { mcpServers?: unknown }>)) take(p?.mcpServers);
  return out;
}

/** Minimal TOML for Codex: [mcp_servers.<name>] tables with command, args, url. */
export function parseCodexToml(text: string, configPath: string): DiscoveredServer[] {
  const out: DiscoveredServer[] = [];
  let current: { name: string; entry: Record<string, unknown> } | null = null;
  let inEnv = false;
  const flush = () => {
    if (current) out.push(serverFromEntry("codex", current.name, current.entry, configPath));
    current = null;
    inEnv = false;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const table = /^\[mcp_servers\.("?)([^"\]]+?)\1(\.env)?\]$/.exec(line);
    if (table) {
      if (table[3]) {
        // [mcp_servers.<name>.env]: values stay local, only their presence is judged
        if (current?.name === table[2]) inEnv = true;
      } else {
        flush();
        current = { name: table[2]!, entry: {} };
      }
      continue;
    }
    if (/^\[/.test(line)) {
      flush();
      continue;
    }
    if (!current) continue;
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    const value: unknown = v!.startsWith("[") ? [...v!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!) : v!.startsWith('"') ? v!.slice(1, v!.lastIndexOf('"')) : v;
    if (inEnv) {
      const env = (current.entry.env as Record<string, unknown> | undefined) ?? {};
      env[k!] = value;
      current.entry.env = env;
    } else current.entry[k!] = value;
  }
  flush();
  return out;
}


export interface UploadItem {
  kind: "mcp" | "agent-skill";
  host: Host;
  name: string;
  canonicalName: string | null;
  version: string | null;
  transport?: string;
  remoteHost?: string | null;
  skillMdSha256?: string;
  /** One hash over every file of the skill (path and hash, sorted), so a helper script rewritten under an unchanged SKILL.md still shows. */
  treeSha256?: string;
  files?: { path: string; sha256: string }[];
}

/** Pure: sha256 over "path sha256" lines in path order. Same input, same hash, on any machine. */
export function treeHash(files: readonly { path: string; sha256: string }[], sha256: (s: string) => string): string {
  return sha256(
    [...files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => `${f.path} ${f.sha256}`)
      .join("\n"),
  );
}

export function toUpload(items: readonly Discovered[], sha256?: (s: string) => string): UploadItem[] {
  return items.map((it) =>
    it.kind === "mcp"
      ? { kind: "mcp", host: it.host, name: it.name, canonicalName: it.canonicalName, version: it.version, transport: it.transport, remoteHost: it.remoteHost }
      : // the file list stays on this machine: the server gets the SKILL.md hash and one hash over the whole tree, never the list
        { kind: "agent-skill", host: it.host, name: it.name, canonicalName: null, version: null, skillMdSha256: it.skillMdSha256, ...(sha256 ? { treeSha256: treeHash(it.files, sha256) } : {}) },
  );
}
