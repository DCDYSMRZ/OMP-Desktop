/** One mounted source generation; obsolete async work cannot publish into its successor. */
export class SourceReadScope {
  active = true;
  private request = 0;
  constructor(readonly key: string) {}

  begin(): () => boolean {
    const request = ++this.request;
    return () => this.active && this.request === request;
  }

  invalidate(): void {
    this.active = false;
    this.request++;
  }
}
