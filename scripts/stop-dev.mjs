// Runs before `npm run dev:local` / `dev:cloud`: stops dev servers left over from earlier runs of THIS project
// (the concurrently/vite/`node --watch` processes), so they can't hold the ports or keep serving stale code.
// Processes are matched by command line AND working directory, so the same commands in other projects are untouched.
import { execFileSync } from 'node:child_process';
import { existsSync, readlinkSync, realpathSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  console.log('[stop-dev] skipped on Windows; stop old dev servers manually if the ports are busy');
  process.exit(0);
}

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const PORTS = [3001, 5173];
const DEV_COMMAND =
  /server\/dev\.ts|node_modules\/\.bin\/(vite|concurrently)|npm run (dev|dev:local|dev:cloud|api:local|api:cloud|web)\b|npm:(api|web)/;

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};

const table = run('ps', ['-axo', 'pid=,ppid=,command='])
  .split('\n')
  .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
  .filter(Boolean)
  .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));

// Never touch this script's own ancestry: the `npm run dev:*` that is running us.
const protectedPids = new Set();
for (let p = process.pid; p && !protectedPids.has(p); p = table.find((r) => r.pid === p)?.ppid) protectedPids.add(p);

function cwdOf(pids) {
  const out = new Map();
  if (existsSync('/proc/self')) {
    for (const pid of pids) {
      try {
        out.set(pid, readlinkSync(`/proc/${pid}/cwd`));
      } catch {}
    }
  } else if (pids.length) {
    let current;
    for (const line of run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')]).split('\n')) {
      if (line.startsWith('p')) current = Number(line.slice(1));
      else if (line.startsWith('n') && current) out.set(current, line.slice(1));
    }
  }
  return out;
}

// Only real node/npm processes: a shell wrapper (`zsh -c "npm run dev"`, an editor task...) merely mentions our
// commands and may be what launched this very run.
const isNodeOrNpm = (command) => ['node', 'npm', 'npx'].includes(command.split(/\s+/)[0].split('/').pop());
const candidates = table.filter((r) => !protectedPids.has(r.pid) && isNodeOrNpm(r.command) && DEV_COMMAND.test(r.command));
const cwds = cwdOf(candidates.map((r) => r.pid));
const stale = candidates.filter((r) => {
  const cwd = cwds.get(r.pid);
  try {
    return cwd && realpathSync(cwd) === root;
  } catch {
    return false;
  }
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (stale.length) {
  for (const r of stale) {
    try {
      process.kill(r.pid, 'SIGTERM');
    } catch {}
  }
  for (let i = 0; i < 30 && stale.some((r) => alive(r.pid)); i++) await sleep(100);
  for (const r of stale) if (alive(r.pid)) process.kill(r.pid, 'SIGKILL');
  console.log(`[stop-dev] stopped ${stale.length} previous dev process${stale.length === 1 ? '' : 'es'}`);
}

// Whatever still holds the ports now isn't ours to kill: say so instead of starting into a conflict.
const busy = [];
for (const port of PORTS) {
  for (let i = 0; i < 20; i++) {
    const free = await new Promise((resolve) => {
      const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
      s.listen(port);
    });
    if (free) break;
    if (i === 19) busy.push(port);
    await sleep(100);
  }
}
if (busy.length) {
  for (const port of busy) {
    const pid = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).split('\n')[0];
    const command = pid && run('ps', ['-p', pid, '-o', 'command=']).trim().slice(0, 100);
    console.error(`[stop-dev] port ${port} is in use by a process that is not part of this project's dev servers: pid ${pid || '?'} ${command || ''}`);
  }
  console.error('[stop-dev] stop it (or free the port) and try again.');
  process.exit(1);
}
