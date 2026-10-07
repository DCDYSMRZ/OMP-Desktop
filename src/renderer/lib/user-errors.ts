import i18next from 'i18next';
import { errorsMessages } from '../locales/messages/errors';
import { isNativeError } from '../../shared/native-error';

export type UserErrorKind = 'userFacing' | 'permission' | 'missing' | 'space' | 'connection' | 'timeout' | 'credentials' | 'quota' | 'rateLimit' | 'provider' | 'runtime' | 'thinking' | 'busy' | 'source' | 'sourceAccess' | 'sourceVersion' | 'sourceLimit' | 'generic';
export interface UserError { kind: UserErrorKind; message: string; action: string; details: string; nativeMessage?: string }
/** Explicit desktop-authored copy, not a native diagnostic or a language heuristic. */
export class UserFacingError extends Error {
  constructor(message: string, readonly technicalDetails = '') {
    super(message);
    this.name = 'UserFacingError';
  }
}
/** React error state keeps the native origin that Electron transported as plain data. */
export function preserveUserError(error: unknown): Error | string {
  if (isNativeError(error)) return Object.assign(new Error(error.message), error);
  return error instanceof Error ? error : String(error);
}
/** Preserve native evidence separately; transport wrappers never become primary copy. */
export function errorDetails(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    return [value.code, value.message ?? value.error].filter(Boolean).map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(': ') || JSON.stringify(error);
  }
  return String(error ?? '');
}
export function stripIpcError(error: unknown): string {
  return errorDetails(error).replace(/^(?:Error invoking remote method ['"][^'"]+['"]:\s*)+/i, '').replace(/^(?:(?:Error|TypeError|RangeError):\s*)+/, '');
}
export function presentUserError(error: unknown): UserError {
  if (error instanceof UserFacingError) return { kind: 'userFacing', message: error.message, action: '', details: error.technicalDetails };
  const details = errorDetails(error);
  const text = stripIpcError(error);
  const kind: UserErrorKind = /\b(EACCES|EPERM)\b|permission denied|operation not permitted/i.test(text) ? 'permission'
    : /\bENOENT\b|no such file|folder does not exist|workspace.*(?:missing|not found)/i.test(text) ? 'missing'
    : /Choose a native session file or select it from history first|source session has not been persisted or is no longer available/i.test(text) ? 'sourceAccess'
    : /Invalid (?:native )?session header|session header.*missing/i.test(text) ? 'source'
    : /Unsupported (?:native )?(?:journal|session) version/i.test(text) ? 'sourceVersion'
    : /History listing reached/i.test(text) ? 'sourceLimit'
    : /\bENOSPC\b|no space left/i.test(text) ? 'space'
    : /\bECONNREFUSED\b|connection refused|unable to connect|fetch failed/i.test(text) ? 'connection'
    : /\bETIMEDOUT\b|timed? ?out|timeout/i.test(text) ? 'timeout'
    : /(?:\b401\b|unauthorized|invalid api.?key|missing.*(?:credential|api.?key)|no api.?key)/i.test(text) ? 'credentials'
    : /quota|insufficient[_ ]credits|credit balance|billing limit|\b429\b/i.test(text) ? 'quota'
    : /rate.?limit/i.test(text) ? 'rateLimit'
    : /\b50[0-9]\b|internal server error|service unavailable|overloaded/i.test(text) ? 'provider'
    : /runtime.*(?:exit|closed|ended)|omp.*(?:退出|exit)|connection (?:ended|closed)|process.*(?:exit|signal)/i.test(text) ? 'runtime'
    : /invalid thinking|unsupported thinking/i.test(text) ? 'thinking'
    : /another.*(?:process|terminal)|already.*(?:running|open)|session.*(?:busy|occupied)|not writable/i.test(text) ? 'busy' : 'generic';
  const catalog = errorsMessages[i18next.language?.startsWith('en') ? 'en' : 'zh-CN'];
  return { kind, message: i18next.t(`omp.errors.${kind}`, { defaultValue: catalog[`omp.errors.${kind}`] }) || catalog[`omp.errors.${kind}`], action: i18next.t(`omp.errors.${kind}Action`, { defaultValue: catalog[`omp.errors.${kind}Action`] }) || catalog[`omp.errors.${kind}Action`], details, ...(kind === 'generic' && isNativeError(error) ? { nativeMessage: error.message } : {}) };
}
