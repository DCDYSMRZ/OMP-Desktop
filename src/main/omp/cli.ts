import { capture } from './process';

export interface ExecutionContext {
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  profile?: string;
}

export function runNativeCommand(context: ExecutionContext, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const argv = context.profile ? ['--profile', context.profile, ...args] : args;
  return capture(context.executable, argv, { cwd: context.cwd, env: context.env });
}
