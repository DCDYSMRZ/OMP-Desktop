import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { cx } from "./ui";
import { IconCheck, IconChevronDown } from "./icons";
import { AnchoredMenu } from "./AnchoredMenu";
import { useTranslation } from 'react-i18next';

export type MenuSelectOption = {
  id: string;
  label: string;
  group?: string;
  /** Listed but not selectable; the host may report an unavailable shell. */
  disabled?: boolean;
};

export function SettingsMenuSelect({
  value,
  options,
  onChange,
  label,
  disabled = false,
  busy = false,
  fullWidth = false,
  className,
  triggerClassName,
  leading,
  searchable = false,
}: {
  value: string;
  options: MenuSelectOption[];
  onChange: (id: string) => void;
  /** Accessible name for the trigger and the menu. */
  label: string;
  disabled?: boolean;
  /** Keeps the trigger non-interactive while a write is in flight. */
  busy?: boolean;
  /** Stretch across a form field. Compact settings rows leave this off. */
  fullWidth?: boolean;
  className?: string;
  /** Optional surface-specific styling while retaining the shared menu behavior. */
  triggerClassName?: string;
  /** Optional icon or marker shown before the selected value. */
  leading?: ReactNode;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState(value);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());

  const current = options.find((option) => option.id === value);
  const visible = options.filter(option => `${option.label} ${option.id} ${option.group ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selectable = visible.filter((option) => !option.disabled);

  const close = () => { setOpen(false); setQuery(''); };

  const choose = (option: MenuSelectOption) => {
    close();
    if (option.disabled || option.id === value) return;
    onChange(option.id);
  };

  const moveActive = (from: string, delta: number) => {
    if (selectable.length === 0) return;
    const index = selectable.findIndex((option) => option.id === from);
    const next =
      index === -1
        ? delta > 0
          ? 0
          : selectable.length - 1
        : (index + delta + selectable.length) % selectable.length;
    const target = selectable[next];
    if (!target) return;
    setActiveId(target.id);
    optionRefs.current.get(target.id)?.focus();
  };

  /* Arrow keys wrap over the selectable rows for parity with the Appearance
     pickers; Home/End and Enter stay with the focused option button. */
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') { close(); return; }
    if (event.target instanceof HTMLInputElement && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const target = event.key === 'Home' ? selectable[0] : selectable.at(-1);
      if (target) { setActiveId(target.id); optionRefs.current.get(target.id)?.focus(); }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    moveActive(activeId, event.key === "ArrowDown" ? 1 : -1);
  };

  return (
    <div className={cx("settings-menu-select-anchor", fullWidth && "is-full", className)}>
      <AnchoredMenu
        open={open}
        onClose={close}
        menuClassName="settings-menu-select-menu"
        label={label}
        align="end"
        onMenuKeyDown={onMenuKeyDown}
        initialFocus={searchable ? 'input' : 'selected'}
        role={searchable ? 'dialog' : 'listbox'}
        trigger={(ref) => (
          <button
            ref={ref}
            type="button"
            className={cx("settings-menu-select-trigger", triggerClassName)}
            aria-haspopup={searchable ? 'dialog' : 'listbox'}
            aria-expanded={open}
            aria-label={`${label}: ${current?.label ?? value}`}
            aria-busy={busy || undefined}
            disabled={disabled || busy}
            onClick={() => {
              setActiveId(value);
              setOpen((current) => !current);
            }}
          >
            {leading ? (
              <span className="settings-menu-select-trigger-leading" aria-hidden="true">
                {leading}
              </span>
            ) : null}
            <span className="settings-menu-select-trigger-label">
              {current?.label ?? value}
            </span>
            <IconChevronDown size="var(--icon-meta)" aria-hidden />
          </button>
        )}
      >
        {searchable && <input className="settings-search" aria-label={label} placeholder={t('settings.catalogSearch')} value={query} onChange={event => setQuery(event.target.value)} />}
        <div className="settings-menu-select-results">
          {!visible.length && <p className="settings-empty" role="status">{t('settings.noResults')}</p>}
          <ul className="settings-menu-select-list" role={searchable ? 'listbox' : undefined} aria-label={searchable ? label : undefined}>
            {visible.map((option, index) => {
              const isCurrent = option.id === value;
              return (
                <li key={option.id}>
                  {option.group && option.group !== visible[index - 1]?.group && <div className="settings-option-group">{option.group}</div>}
                  <button
                    ref={(node) => {
                      if (node) optionRefs.current.set(option.id, node);
                      else optionRefs.current.delete(option.id);
                    }}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={isCurrent}
                    disabled={option.disabled}
                    className={cx(
                      "settings-menu-select-option",
                      isCurrent && "is-current",
                      option.id === activeId && "is-active",
                    )}
                    onMouseEnter={() => setActiveId(option.id)}
                    onFocus={() => setActiveId(option.id)}
                    onClick={() => choose(option)}
                  >
                    <span className="settings-menu-select-option-label">
                      {option.label}
                    </span>
                    {isCurrent ? (
                      <IconCheck
                        size="var(--icon-meta)"
                        className="settings-menu-select-check"
                        aria-hidden
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </AnchoredMenu>
    </div>
  );
}
