import { spawn, type ChildProcess } from 'node:child_process';

/** Only signal the process group created by this bridge, never a discovered PID. */
export function signalOwned(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export interface CaptureOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxBytes?: number;
  timeoutMs?: number;
}

/** No argv, environment, stdout or stderr is included in errors: config commands can contain credentials. */
export function capture(executable: string, args: string[], options: CaptureOptions): Promise<{ stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string }>();
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let timer: NodeJS.Timeout | undefined;
    const fail = (error: Error): void => {
      if (failure) return;
      failure = error;
      clearTimeout(timer);
      try { signalOwned(child, 'SIGKILL'); }
      catch (killError) { reject(new AggregateError([error, killError], 'Native command failed and its owned process could not be terminated')); return; }
      reject(error);
    };
    const consume = (target: Buffer[], data: Buffer): void => {
      if (failure) return;
      bytes += data.length;
      if (bytes > (options.maxBytes ?? 16 * 1024 * 1024)) {
        fail(new Error('Native command output exceeded the capture limit'));
        return;
      }
      target.push(data);
    };
    child.stdout.on('data', (data: Buffer) => consume(stdout, data));
    child.stderr.on('data', (data: Buffer) => consume(stderr, data));
    child.stdout.on('error', () => fail(new Error('Native command stdout failed')));
    child.stderr.on('error', () => fail(new Error('Native command stderr failed')));
    child.on('error', (error: NodeJS.ErrnoException) => fail(new Error(`Unable to launch native command (${error.code ?? 'spawn error'})`)));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) return;
      if (code !== 0) { reject(new Error(`Native command failed (${signal ?? `exit ${code}`}); command output is withheld because it may contain credentials`)); return; }
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        resolve({ stdout: decoder.decode(Buffer.concat(stdout)), stderr: decoder.decode(Buffer.concat(stderr)) });
      } catch { reject(new Error('Native command emitted invalid UTF-8')); }
    });
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => fail(new Error('Executable discovery probe timed out')), options.timeoutMs);
      timer.unref();
    }
  return promise;
}
