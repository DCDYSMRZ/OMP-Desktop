import type { ReactNode } from 'react';
import { HelpIcon } from './ui';

/** One decision with visible help and a single control column. */
export function SettingsRow({ title, description, detail, children, id }: {
  title: ReactNode; description?: string; detail?: ReactNode; children: ReactNode; id?: string;
}) {
  return <div className="settings-row" id={id} tabIndex={id ? -1 : undefined}>
    <div className="settings-row-copy"><div className="settings-row-title">{title}</div>
      {description && <p className="settings-row-description">{description}</p>}
      {detail && <div className="settings-row-detail">{detail}</div>}
    </div><div className="settings-row-control">{children}</div>
  </div>;
}
export function SettingsCard({ title, description, children }: { title?: string; description?: string; children: ReactNode }) {
  return <section className="settings-card-block">{title && <div className="settings-card-heading-help"><h3 className="settings-card-heading">{title}</h3>{description && <HelpIcon label={description} />}</div>}<div className="settings-panel">{children}</div></section>;
}
