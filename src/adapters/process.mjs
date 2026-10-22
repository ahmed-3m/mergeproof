import { spawnSync } from 'node:child_process';

// Single choke point for child processes. Always argv arrays, never a shell
// string. Windows .cmd/.bat shims (npm, npx) need shell: true (CVE-2024-27980),
// so callers must opt in explicitly and pass only trusted arguments.
// With shell: true the arguments are joined unescaped either way; doing it here
// keeps that visible and avoids Node's DEP0190 warning.
export function runProcess(command, args, { cwd, shell = false, env, input, timeoutMs } = {}) {
  const res = spawnSync(shell ? [command, ...args].join(' ') : command, shell ? [] : args, {
    cwd,
    shell,
    env,
    input,
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (res.error && res.error.code !== 'ETIMEDOUT') throw res.error;
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', timedOut: res.error?.code === 'ETIMEDOUT' };
}
