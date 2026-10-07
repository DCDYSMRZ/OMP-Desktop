import { useTranslation } from 'react-i18next';
import type { NativeCommand } from '../../../shared/contracts';
import { commandSource } from './catalog';

export function CommandList({ commands, id, active, onSelect, retainFocus = false, filtered = false }: { commands: NativeCommand[]; id: string; active: number; onSelect: (index: number) => void; retainFocus?: boolean; filtered?: boolean }) {
  const { t } = useTranslation();
  return <div id={id} className="composer-ac-list composer-command-list" role="listbox" aria-label={t('omp.composer.commands')}>{commands.map((command, index) => {
    const source = commandSource(command);
    const sourceLabel = t(`composer.source.${source}`, { defaultValue: command.source ?? source });
    const description = source === 'builtin' ? t(`composer.command.${command.name}`, { defaultValue: command.description ?? '' }) : command.description;
    const hint = typeof command.argumentHint === 'string' ? command.argumentHint : undefined;
    return <div className="composer-command-entry" key={`${source}:${command.name}`}>
      {(index === 0 || commandSource(commands[index - 1]) !== source) && <div className="composer-catalog-group">{sourceLabel}</div>}
      <button type="button" id={`${id}-${index}`} tabIndex={-1} className={`composer-command-row${active === index ? ' active' : ''}`} role="option" aria-selected={active === index} onMouseDown={retainFocus ? event => event.preventDefault() : undefined} onClick={() => onSelect(index)}>
        <span className="composer-command-identity"><strong>/{command.name}</strong>{hint && <span className="composer-command-arguments">{hint}</span>}{!!command.aliases?.length && <span className="composer-command-aliases">{command.aliases.map(alias => `/${alias}`).join(' · ')}</span>}</span>
        <span className="composer-command-description" title={description}>{description}</span>{filtered && <span className="composer-command-source">{sourceLabel}</span>}
      </button>
    </div>;
  })}</div>;
}
