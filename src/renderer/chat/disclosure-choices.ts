/** Per-transcript disclosure choices: explicit reader choices plus identity reveals (with exclusions). */
export class DisclosureChoices {
  private choices = new Map<string, boolean>();
  private listeners = new Map<string, Set<() => void>>();
  private revealed = new Map<string, readonly string[]>();
  get = (key: string) => {
    const choice = this.choices.get(key);
    if (choice !== undefined) return choice;
    const identities: string[] = JSON.parse(key);
    for (const [identity, excluded] of this.revealed) if ((key === identity || identities.includes(identity)) && !excluded.includes(key)) return true;
    return undefined;
  };
  reveal = (identity: string, options?: { exclude?: readonly string[] }) => this.revealMany([identity], options);
  revealMany = (identities: readonly string[], options?: { exclude?: readonly string[] }) => {
    const excluded = options?.exclude ?? [];
    for (const identity of identities) this.revealed.set(identity, excluded);
    const keys = new Set([...this.choices.keys(), ...this.listeners.keys()]);
    const changed: string[] = [];
    for (const key of keys) {
      if (excluded.includes(key)) continue;
      const parts: string[] = JSON.parse(key);
      if (!identities.some(identity => key === identity || parts.includes(identity))) continue;
      if (this.choices.has(key)) this.choices.set(key, true);
      changed.push(key);
    }
    for (const key of changed) this.listeners.get(key)?.forEach(listener => listener());
  };
  set(key: string, open: boolean) {
    if (this.choices.get(key) === open) return;
    this.choices.set(key, open);
    this.listeners.get(key)?.forEach(listener => listener());
  }
  subscribe(key: string, listener: () => void) {
    const listeners = this.listeners.get(key) ?? new Set<() => void>();
    listeners.add(listener); this.listeners.set(key, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(key); };
  }
}
