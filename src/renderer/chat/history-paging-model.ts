/** Cursor-keyed request gate: repeated observer notifications cannot duplicate reads. */
export class PagingGate {
  inFlight = false;
  failed = false;
  private attempted: string | undefined;
  begin(cursor: string | undefined, near: boolean, busy: boolean): boolean {
    if (!cursor || !near || busy || this.inFlight || this.failed || this.attempted === cursor) return false;
    this.inFlight = true; this.attempted = cursor; return true;
  }
  finish(failed: boolean) { this.inFlight = false; this.failed = failed; }
  retry() { this.failed = false; this.attempted = undefined; }
}
