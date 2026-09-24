/**
 * `smallprint schedule --install`: the sync every six hours, so the record of
 * your instruction files on smallprint.dev stays current and a machine that
 * stops reporting is noticed. It is a job on the machine, installed by the
 * person with this command and removed with --uninstall; nothing else ever
 * installs it. macOS gets a launchd agent, Linux a systemd user timer;
 * Windows gets the schtasks command to run. The token goes into the job's
 * environment in a file only you can read, the same place the shell would
 * keep it. Pure functions here take every path as input so they can be
 * tested without touching the machine.
 */
import { dirname, join } from "node:path";

export interface SchedulePlan {
  platform: NodeJS.Platform;
  home: string;
  nodeDir: string;
  version: string;
  label: string;
  token: string;
  everySeconds: number;
}

export function launchdPlist(p: SchedulePlan): { path: string; body: string } {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const args = [join(p.nodeDir, "npx"), "-y", `smallprint@${p.version}`, "sync", "--yes", "--quiet", "--scheduled", "--every", String(p.everySeconds / 3600), "--label", p.label];
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.smallprint.sync</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SMALLPRINT_TOKEN</key><string>${esc(p.token)}</string>
    <key>PATH</key><string>${esc(p.nodeDir)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>${esc(p.home)}</string>
  </dict>
  <key>WorkingDirectory</key><string>${esc(p.home)}</string>
  <key>StartInterval</key><integer>${p.everySeconds}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${esc(join(p.home, "Library", "Logs", "smallprint", "sync.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(join(p.home, "Library", "Logs", "smallprint", "sync.log"))}</string>
</dict>
</plist>
`;
  return { path: join(p.home, "Library", "LaunchAgents", "dev.smallprint.sync.plist"), body };
}

export function systemdUnits(p: SchedulePlan): { dir: string; service: { path: string; body: string }; timer: { path: string; body: string } } {
  const dir = join(p.home, ".config", "systemd", "user");
  const q = (s: string) => s.replace(/"/g, '\\"');
  const service = `[Unit]
Description=Small Print scheduled sync (instruction files and pins)

[Service]
Type=oneshot
Environment="SMALLPRINT_TOKEN=${q(p.token)}"
Environment="PATH=${q(p.nodeDir)}:/usr/local/bin:/usr/bin:/bin"
WorkingDirectory=${p.home}
ExecStart=${join(p.nodeDir, "npx")} -y smallprint@${p.version} sync --yes --quiet --scheduled --every ${p.everySeconds / 3600} --label "${q(p.label)}"
`;
  const timer = `[Unit]
Description=Small Print scheduled sync, every ${Math.round(p.everySeconds / 3600)} hours

[Timer]
OnBootSec=5min
OnUnitActiveSec=${p.everySeconds}s
Persistent=true

[Install]
WantedBy=timers.target
`;
  return { dir, service: { path: join(dir, "smallprint-sync.service"), body: service }, timer: { path: join(dir, "smallprint-sync.timer"), body: timer } };
}

export function schtasksCommand(p: SchedulePlan): string {
  const hours = Math.max(1, Math.round(p.everySeconds / 3600));
  return `schtasks /Create /TN "Small Print sync" /SC HOURLY /MO ${hours} /TR "cmd /c set SMALLPRINT_TOKEN=${p.token}&& \"${join(p.nodeDir, "npx.cmd")}\" -y smallprint@${p.version} sync --yes --quiet --scheduled --label \"${p.label}\""`;
}

export function schedulePlan(opts: { platform?: NodeJS.Platform; home: string; execPath: string; version: string; label: string; token: string; everyHours?: number }): SchedulePlan {
  const hours = Math.min(24, Math.max(1, opts.everyHours ?? 6));
  return { platform: opts.platform ?? process.platform, home: opts.home, nodeDir: dirname(opts.execPath), version: opts.version, label: opts.label, token: opts.token, everySeconds: hours * 3600 };
}

// ---------------------------------------------------------------------------
// Level four: the reporter the user's agent cannot reach. A root-owned job runs
// a dependency-free Python file with the system interpreter, reads the user's
// files, and posts the same hashes. Its token is root-owned, mode 600. An agent
// running as the user cannot read the token, forge a report, or stop the job.
// Everything it touches is root-owned: interpreter, helper, plist, token, log.
// ---------------------------------------------------------------------------

export interface SystemPlan {
  platform: NodeJS.Platform;
  /** The account whose files are read. */
  user: string;
  label: string;
  everySeconds: number;
  /** Root-owned system interpreter: /usr/bin/python3 on macOS and Linux. */
  python: string;
  base: string;
}

/** Root-owned paths for the helper, its token, the job and its log. */
export function systemPaths(platform: NodeJS.Platform): { dir: string; helper: string; tokenDir: string; token: string; job: string; timer?: string; log: string } {
  if (platform === "darwin") {
    const dir = "/Library/Application Support/smallprint";
    return { dir, helper: join(dir, "smallprint-report.py"), tokenDir: "/etc/smallprint", token: "/etc/smallprint/token", job: "/Library/LaunchDaemons/dev.smallprint.report.plist", log: "/var/log/smallprint-report.log" };
  }
  const dir = "/usr/lib/smallprint";
  return { dir, helper: join(dir, "smallprint-report.py"), tokenDir: "/etc/smallprint", token: "/etc/smallprint/token", job: "/etc/systemd/system/smallprint-report.service", timer: "/etc/systemd/system/smallprint-report.timer", log: "/var/log/smallprint-report.log" };
}

export function systemLaunchdPlist(p: SystemPlan): { path: string; body: string } {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paths = systemPaths("darwin");
  const args = [p.python, paths.helper, "--user", p.user, "--label", p.label, "--every", String(p.everySeconds / 3600), "--base", p.base, "--token-file", paths.token];
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.smallprint.report</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin</string>
  </dict>
  <key>UserName</key><string>root</string>
  <key>StartInterval</key><integer>${p.everySeconds}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${esc(paths.log)}</string>
  <key>StandardErrorPath</key><string>${esc(paths.log)}</string>
</dict>
</plist>
`;
  return { path: paths.job, body };
}

export function systemUnits(p: SystemPlan): { service: { path: string; body: string }; timer: { path: string; body: string } } {
  const paths = systemPaths("linux");
  const q = (s: string) => s.replace(/"/g, '\\"');
  const service = `[Unit]
Description=Small Print level-four reporter (root-owned; the user's agent cannot reach it)

[Service]
Type=oneshot
User=root
Environment="PATH=/usr/bin:/bin"
ExecStart=${p.python} ${paths.helper} --user "${q(p.user)}" --label "${q(p.label)}" --every ${p.everySeconds / 3600} --base ${p.base} --token-file ${paths.token}
StandardOutput=append:${paths.log}
StandardError=append:${paths.log}
`;
  const timer = `[Unit]
Description=Small Print level-four reporter, every ${Math.round(p.everySeconds / 3600)} hours

[Timer]
OnBootSec=5min
OnUnitActiveSec=${p.everySeconds}s
RandomizedDelaySec=${Math.min(1800, Math.round(p.everySeconds / 5))}
Persistent=true

[Install]
WantedBy=timers.target
`;
  return { service: { path: paths.job, body: service }, timer: { path: paths.timer!, body: timer } };
}

export function systemPlan(opts: { platform?: NodeJS.Platform; user: string; label: string; everyHours?: number; base?: string }): SystemPlan {
  const hours = Math.min(24, Math.max(1, opts.everyHours ?? 6));
  return { platform: opts.platform ?? process.platform, user: opts.user, label: opts.label, everySeconds: hours * 3600, python: "/usr/bin/python3", base: opts.base ?? "https://smallprint.dev" };
}
