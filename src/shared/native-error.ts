/** Plain data survives both Electron IPC and the context bridge without losing origin. */
export interface NativeErrorSource { origin: 'omp'; message: string; command?: string; code?: string }
export interface NativeFailureEnvelope { desktopNativeFailure: NativeErrorSource }
export function nativeError(message: string, command?: string, code?: string): NativeErrorSource {
  return { origin: 'omp', message, ...(command ? { command } : {}), ...(code ? { code } : {}) };
}
export function isNativeError(value: unknown): value is NativeErrorSource {
  return !!value && typeof value === 'object' && 'origin' in value && value.origin === 'omp' && 'message' in value && typeof value.message === 'string';
}
export function unwrapNativeFailure<T>(value: T | NativeFailureEnvelope): T {
  if (value && typeof value === 'object' && 'desktopNativeFailure' in value && isNativeError(value.desktopNativeFailure)) throw value.desktopNativeFailure;
  return value as T;
}
