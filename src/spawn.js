import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const META = /([()\][%!^"`<>&|;, *?])/g;

function findOnWindowsPath(cmd) {
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasDir = /[\\/]/.test(cmd);
  const dirs = hasDir ? [''] : (process.env.PATH || process.env.Path || '').split(';').filter(Boolean);
  const names = path.extname(cmd) ? [cmd, ...exts.map((e) => cmd + e)] : exts.map((e) => cmd + e);
  for (const dir of dirs) {
    for (const name of names) {
      const full = dir ? path.join(dir, name) : name;
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

function quoteForCmd(arg, doubleEscape) {
  let out = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  out = `"${out}"`.replace(META, '^$1');
  return doubleEscape ? out.replace(META, '^$1') : out;
}

// .cmd and .bat files (npx on Windows is one) cannot be spawned directly, and
// shell: true would re-parse the arguments. Quote them for cmd.exe instead.
export function resolveCommand(cmd, args) {
  if (process.platform !== 'win32') return { file: cmd, args, options: {} };
  const found = findOnWindowsPath(cmd);
  if (found && /\.(cmd|bat)$/i.test(found)) {
    const shim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(found);
    const line = [found.replace(META, '^$1'), ...args.map((a) => quoteForCmd(a, shim))].join(' ');
    return {
      file: process.env.comspec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      options: { windowsVerbatimArguments: true },
    };
  }
  return { file: found || cmd, args, options: {} };
}

export function startServer(cmd, args, stdio, extra = {}) {
  const r = resolveCommand(cmd, args);
  return spawn(r.file, r.args, { stdio, windowsHide: true, ...r.options, ...extra });
}

export function killTree(child, { group = false } = {}) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    if (group) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch { /* already gone */ }
}
