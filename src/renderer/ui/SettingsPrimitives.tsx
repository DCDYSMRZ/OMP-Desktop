import type { ReactNode } from "react";
import { HelpIcon } from "./ui";

/**
 * One settings decision: the title and its control on a single line.
 *
 * The explanation never occupies a permanent second line — it is reached from
 * the question mark beside the title, which keeps a card scannable (D601).
 * `detail` is the exception in kind, not in styling: a row that shows a live
 * value (the pinned default model) keeps it visible, because that is data the
 * user came to read, not prose explaining a switch.
 */
export function SettingsRow({
  title,
  description,
  detail,
  children,
}: {
  title: string;
  /** Explanatory copy, revealed on demand from the help icon. */
  description?: string;
  /** Live row metadata that stays visible (not an explanation). */
  detail?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <div className="settings-row-title">
          {title}
          {description ? <HelpIcon label={description} /> : null}
        </div>
        {detail ? <div className="settings-row-detail">{detail}</div> : null}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

/**
 * A titled group of rows. `description` follows the same rule as a row's: it
 * explains the card, so it lives behind the heading's help icon.
 */
export function SettingsCard({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-card-block">
      {title ? (
        /*
          The help mark is the heading's sibling, not its child: a nested
          button joins the heading's accessible name, and a screen reader's
          list of headings should not read out every explanation.
        */
        <div className="settings-card-heading-help">
          <h3 className="settings-card-heading">{title}</h3>
          {description ? <HelpIcon label={description} /> : null}
        </div>
      ) : null}
      <div className="settings-panel lg-regular lg-pane">{children}</div>
    </section>
  );
}
