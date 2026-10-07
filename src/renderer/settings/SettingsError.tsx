import { UserErrorNotice } from '../lib/UserErrorNotice';

export function SettingsError({ error }: { error: unknown }) {
  return <div className="native-setting-message"><UserErrorNotice error={error} /></div>;
}
