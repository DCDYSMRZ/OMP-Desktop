import { useTranslation } from 'react-i18next';
import { Modal } from './Dialogs';
import { shortcutDefinitions, shortcutKeycaps, shortcutLabelKey } from './shortcuts';
import '../styles/command-palette.css';
export function ShortcutHelp({ platform, onClose }: { platform: string; onClose: () => void }) {
  const { t } = useTranslation();
  return <Modal title={t('omp.palette.action.shortcuts')} onClose={onClose} className="shortcut-help"><div className="shortcut-help-list">{shortcutDefinitions.map(shortcut => <div key={shortcut.id}><span>{t(shortcutLabelKey(shortcut.id))}</span><span className="palette-keycaps">{shortcutKeycaps(shortcut.id, platform).map((key, index) => <kbd key={index}>{key}</kbd>)}</span></div>)}</div><p className="shortcut-help-note">{t('omp.palette.helpNote')}</p></Modal>;
}
