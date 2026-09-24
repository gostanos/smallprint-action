/**
 * Agent firewalls present on this machine (decision 156): presence only, by name, so Small Print can count how many
 * synced machines run one before building anything that reads their logs. Detection is a binary on PATH, an npm or
 * pip package on disk, or a reference in an agent config or hook file. Nothing is executed, nothing is read for its
 * contents beyond a substring test, and only the tool's name ever leaves the machine. Unknown means not detected.
 * Footprints verified against each tool's repository or registry entry; the dates are in docs/SOURCES.md.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { configLocations } from "./discover";

export interface FirewallSpec {
  /** The name that is uploaded. Nothing else about the tool is. */
  name: string;
  /** Executables the tool installs on PATH. Left empty where another project's package installs the same name. */
  bins: string[];
  /** npm package names, looked for under a global prefix or the project's node_modules. */
  npm: string[];
  /** PyPI distribution names, looked for as dist-info directories in user, venv, pipx and Homebrew site-packages. */
  pip: string[];
  /** Files or directories the tool creates, relative to the home directory or the project, or absolute. */
  paths: (home: string, cwd: string) => string[];
  /** Patterns that mark the tool inside an agent config or hook file: the hook command it installs, the MCP server entry, the proxy address. */
  configPatterns: RegExp[];
}

/** Verified against each tool's repository or registry entry on 18 Sep 2026 (docs/SOURCES.md, "Agent firewalls"). */
export const FIREWALLS: readonly FirewallSpec[] = [
  {
    // Homebrew tap or release binary; `pipelock claude setup` writes a PreToolUse command "<path>/pipelock claude hook"; MCP wrapping is "command": "pipelock", args ["mcp","proxy",...]
    name: "pipelock",
    bins: ["pipelock"],
    npm: [],
    pip: [],
    paths: (home) => [join(home, ".pipelock"), join(home, ".config", "pipelock", "pipelock.yaml")],
    configPatterns: [/\bpipelock\b/i],
  },
  {
    // PyPI agentgate-firewall (the bare PyPI "agentgate" is another project, so no bin match); `agentgate install-hook` writes a PreToolUse command ending agentgate-hook.py with AGENTGATE_POLICY and AGENTGATE_DB; `agentgate init` writes agentgate.yaml
    name: "agentgate",
    bins: [],
    npm: [],
    pip: ["agentgate_firewall"],
    paths: (_home, cwd) => [join(cwd, "agentgate.yaml")],
    configPatterns: [/agentgate-hook\.py|AGENTGATE_POLICY|AGENTGATE_DB/],
  },
  {
    // PyPI mcpkernel, console script mcpkernel; `mcpkernel init` creates .mcpkernel/config.yaml; `mcpkernel install` adds mcpServers.mcpkernel with command mcpkernel
    name: "mcpkernel",
    bins: ["mcpkernel"],
    npm: [],
    pip: ["mcpkernel"],
    paths: (_home, cwd) => [join(cwd, ".mcpkernel", "config.yaml")],
    configPatterns: [/\bmcpkernel\b/i],
  },
  {
    // Martello, installed from GitHub (npm "agent-firewall" is another project, so no bin or package match); the hand-written hook runs bin/agent-firewall.js --config firewall.config.json hook; audit at .agent-firewall/
    name: "agent-firewall",
    bins: [],
    npm: [],
    pip: [],
    paths: (_home, cwd) => [join(cwd, "firewall.config.json"), join(cwd, ".firewall.config.json"), join(cwd, ".agent-firewall")],
    configPatterns: [/agent-firewall\.js|firewall\.config\.json/],
  },
  {
    // npm ecc-agentshield, bin agentshield (npm "agentshield" is another project with bin "shield"); `agentshield runtime install` writes a hook naming .agentshield/runtime-policy.json; home ~/.agentshield/
    name: "agentshield",
    bins: ["agentshield"],
    npm: ["ecc-agentshield"],
    pip: [],
    paths: (home, cwd) => [join(home, ".agentshield"), join(cwd, ".agentshield")],
    configPatterns: [/\.agentshield\/|AgentShield: BLOCKED|ecc-agentshield/],
  },
  {
    // not on any registry; console script auditguard-mcp from a checkout, a stdio MCP server, so it shows as an MCP server command
    name: "auditguard-mcp",
    bins: ["auditguard-mcp"],
    npm: [],
    pip: ["auditguard_mcp"],
    paths: () => [],
    configPatterns: [/auditguard[-_]mcp/i],
  },
  {
    // Dataiku Kiji Privacy Proxy: brew cask or DMG on macOS, deb on Linux; binary kiji-proxy; CA under ~/.kiji-proxy or the app support folder; Claude Code integration is HTTPS_PROXY 127.0.0.1:8081 plus its CA in settings.json env
    name: "kiji-proxy",
    bins: ["kiji-proxy"],
    npm: [],
    pip: [],
    paths: (home) => ["/Applications/Kiji Privacy Proxy.app", join(home, ".kiji-proxy"), join(home, "Library", "Application Support", "Kiji Privacy Proxy")],
    configPatterns: [/Kiji Privacy Proxy|kiji-proxy/i],
  },
];

export interface DetectEnv {
  home?: string;
  cwd?: string;
  /** PATH entries; defaults to the process PATH. */
  pathDirs?: string[];
  /** Extra config or hook files to scan, on top of the ones the CLI already knows. */
  extraConfigFiles?: string[];
  win?: boolean;
}

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const ls = (p: string): string[] => {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
};

/** The files a firewall would have to touch to be in use: every MCP config the CLI reads, and the Claude Code hook settings. */
export function firewallConfigFiles(home = homedir(), cwd = process.cwd()): string[] {
  const out = new Set<string>();
  for (const l of configLocations(home, cwd)) if (l.format !== "skills-dir") out.add(l.path);
  for (const p of [join(home, ".claude", "settings.json"), join(home, ".claude", "settings.local.json"), join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")]) out.add(p);
  return [...out];
}

/** Which of the known agent firewalls are present, by name, sorted. Never throws. */
export function detectFirewalls(env: DetectEnv = {}): string[] {
  const home = env.home ?? homedir();
  const cwd = env.cwd ?? process.cwd();
  const win = env.win ?? platform() === "win32";
  const pathDirs = env.pathDirs ?? (process.env.PATH ?? "").split(win ? ";" : ":").filter(Boolean);
  const found = new Set<string>();
  const userBins = [join(home, ".local", "bin"), join(home, "go", "bin"), join(home, ".cargo", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const binDirs = [...new Set([...pathDirs, ...userBins])];
  const nodePrefixes = new Set<string>();
  for (const d of binDirs) if (d.endsWith("/bin") || d.endsWith("\\bin")) nodePrefixes.add(dirname(d));
  const sitePackages: string[] = [];
  for (const root of [join(home, ".local", "lib"), "/opt/homebrew/lib", "/usr/local/lib", "/usr/lib", join(cwd, ".venv", "lib"), join(cwd, "venv", "lib")]) {
    for (const py of ls(root)) if (py.startsWith("python3")) sitePackages.push(join(root, py, "site-packages"));
  }
  const pipxVenvs = join(home, ".local", "pipx", "venvs");
  const configTexts: string[] = [];
  for (const f of [...firewallConfigFiles(home, cwd), ...(env.extraConfigFiles ?? [])]) {
    try {
      if (!isFile(f) || statSync(f).size > MAX_CONFIG_BYTES) continue;
      configTexts.push(readFileSync(f, "utf8"));
    } catch {
      /* unreadable is absent */
    }
  }
  for (const fw of FIREWALLS) {
    try {
      let hit = false;
      for (const bin of fw.bins) {
        for (const d of binDirs) {
          if (isFile(join(d, bin)) || (win && (isFile(join(d, `${bin}.exe`)) || isFile(join(d, `${bin}.cmd`))))) hit = true;
          if (hit) break;
        }
        if (hit) break;
      }
      if (!hit) for (const pkg of fw.npm) {
        if (isDir(join(cwd, "node_modules", pkg))) hit = true;
        for (const prefix of nodePrefixes) if (isDir(join(prefix, "lib", "node_modules", pkg))) hit = true;
        if (isDir(join(home, ".npm-global", "lib", "node_modules", pkg))) hit = true;
        if (hit) break;
      }
      if (!hit) for (const dist of fw.pip) {
        const norm = dist.toLowerCase().replace(/-/g, "_");
        // a dist-info directory is <name>-<version>.dist-info with the name's dashes folded to underscores
        for (const sp of sitePackages) if (ls(sp).some((e) => e.endsWith(".dist-info") && e.slice(0, e.indexOf("-")).toLowerCase().replace(/-/g, "_") === norm)) hit = true;
        if (isDir(join(pipxVenvs, dist)) || isDir(join(pipxVenvs, dist.replace(/_/g, "-")))) hit = true;
        if (hit) break;
      }
      if (!hit) for (const p of fw.paths(home, cwd)) if (existsSync(p)) hit = true;
      if (!hit) for (const text of configTexts) if (fw.configPatterns.some((re) => re.test(text))) hit = true;
      if (hit) found.add(fw.name);
    } catch {
      /* one tool's check failing is that tool not detected, never a failed sync */
    }
  }
  return [...found].sort();
}

/** What is uploaded: the names, nothing else. */
export function firewallsForUpload(found: readonly string[]): string[] {
  const known = new Set(FIREWALLS.map((f) => f.name));
  return [...new Set(found.filter((n) => known.has(n)))].sort();
}
