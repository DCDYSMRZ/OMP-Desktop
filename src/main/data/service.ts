import { homedir } from 'node:os';
import type { DesktopPreferences, HistoryListing, JsonValue, SettingsSnapshot, SettingsWriteResult } from '../../shared/contracts';
import type { ExecutionContext } from '../omp/cli';
import { PreferenceStore } from './preferences';
import { HistoryIndex } from './history';
import { listNativeSettings, writeNativeSetting } from './settings';

export class NativeDataService {
  private readonly preferences: PreferenceStore;
  private readonly history = new HistoryIndex();
  constructor(private readonly options: { userDataDir: string; getContext: (cwd: string) => Promise<ExecutionContext>; getHistoryContext: (cwd: string) => Promise<ExecutionContext> }) {
    this.preferences = new PreferenceStore(options.userDataDir);
  }

  getPreferences(): Promise<DesktopPreferences> { return this.preferences.get(); }
  setPreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences> { return this.preferences.set(patch); }

  async listHistory(options: { cwd?: string; query?: string } = {}): Promise<HistoryListing> {
    const preferences = await this.preferences.get();
    const context = await this.options.getHistoryContext(options.cwd || preferences.lastWorkspace || homedir());
    return this.history.list(context, options);
  }

  async listSettings(cwd: string): Promise<SettingsSnapshot> {
    return listNativeSettings(await this.options.getContext(cwd));
  }

  async setSetting(cwd: string, key: string, value: JsonValue): Promise<SettingsWriteResult> {
    if (value === undefined) throw new Error('A setting value is required; use reset to remove a global setting');
    return writeNativeSetting(await this.options.getContext(cwd), key, value);
  }

  async resetSetting(cwd: string, key: string): Promise<SettingsWriteResult> {
    return writeNativeSetting(await this.options.getContext(cwd), key);
  }
}
