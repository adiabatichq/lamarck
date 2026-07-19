// pty-helper.cjs — Node subprocess that owns a real PTY.
// Core launches this separately so the native PTY remains crash-isolated.
//
// Protocol:
//   stdin  -> PTY input, or \x01{cols,rows} resize control message
//   stdout -> PTY output
//   argv[2] is the working directory.

const { chmodSync, existsSync, mkdirSync, statSync } = require("fs");
const { dirname, join } = require("path");

ensureNodePtySpawnHelperExecutable();

const pty = require("node-pty");

const cwd = process.argv[2] || process.cwd();
const shell = process.env.SHELL || "/bin/sh";
const shellArgs = shell.endsWith("zsh")
  ? ["-f"]
  : shell.endsWith("bash")
    ? ["--noprofile", "--norc"]
    : [];
const historyDir = join(cwd, ".lamarck");
const historyFile = join(historyDir, "terminal_history");

try {
  mkdirSync(historyDir, { recursive: true });
} catch {}

const term = pty.spawn(shell, shellArgs, {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd,
  env: {
    ...process.env,
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    HISTFILE: historyFile,
  },
});

term.onData((data) => {
  try {
    process.stdout.write(data);
  } catch {}
});

term.onExit(({ exitCode }) => {
  process.exit(exitCode);
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk.startsWith("\x01")) {
    try {
      const { cols, rows } = JSON.parse(chunk.slice(1));
      if (cols && rows) term.resize(cols, rows);
    } catch {}
    return;
  }
  term.write(chunk);
});

process.stdin.on("end", () => {
  term.kill();
  process.exit(0);
});

function ensureNodePtySpawnHelperExecutable() {
  if (process.platform !== "darwin") return;

  const packageJson = require.resolve("node-pty/package.json");
  const packageRoot = dirname(packageJson);
  const helperPath = join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");

  if (!existsSync(helperPath)) return;

  const mode = statSync(helperPath).mode;
  if ((mode & 0o111) !== 0) return;

  chmodSync(helperPath, mode | 0o755);
}
