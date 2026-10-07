import { createContext, useContext, useMemo, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ContextMenu, useContextMenu, type ContextMenuRequest } from '../ui/ContextMenu';
import { Modal } from '../app/Dialogs';
import { parseFileTarget } from './file-target';
import { fileObjectPath, parseEditorTarget } from './file-object-target';
import { UserErrorNotice } from './UserErrorNotice';

const FileObjectContext = createContext<{ cwd: string; onOpenFile: (target: string) => void; menu: (event: MouseEvent<HTMLElement>, request: ContextMenuRequest) => void; report: (error: unknown) => void } | null>(null);

export function FileObjectProvider({ cwd, onOpenFile, children }: { cwd: string; onOpenFile: (target: string) => void; children: ReactNode }) {
  const menu = useContextMenu(), [error, setError] = useState('');
  const { t } = useTranslation();
  const value = useMemo(() => ({ cwd, onOpenFile, menu: menu.openContextMenu, report: (error: unknown) => setError(error instanceof Error ? error.message : String(error)) }), [cwd, onOpenFile, menu.openContextMenu]);
  return <FileObjectContext.Provider value={value}>{children}<ContextMenu state={menu.contextMenu} onClose={menu.closeContextMenu} />{error && <Modal title={t('objects.failed')} onClose={() => setError('')}><UserErrorNotice error={error} /></Modal>}</FileObjectContext.Provider>;
}

export function useFileObject(cwd: string) {
  const context = useContext(FileObjectContext), { t } = useTranslation();
  const root = cwd || context?.cwd || '';
  const report = (error: unknown) => { if (context) context.report(error); else console.error(error); };
  const run = (operation: Promise<void>) => { void operation.catch(report); };
  const open = (target: string) => context?.onOpenFile(target);
  const openInEditor = (target: string) => run(window.ompDesktop.openInEditor({ cwd: root, ...parseEditorTarget(target) }));
  const quickLook = (target: string) => run(window.ompDesktop.quickLook({ cwd: root, path: parseEditorTarget(target).path }));
  const reveal = (target: string) => run(window.ompDesktop.revealFile(root, parseEditorTarget(target).path));
  const copyPath = (target: string) => run(window.ompDesktop.copyText(fileObjectPath(root, parseEditorTarget(target).path)));
  const dragProps = (target: string): { draggable: true; onDragStart: (event: DragEvent) => void } => ({ draggable: true, onDragStart: event => { event.preventDefault(); event.stopPropagation(); window.ompDesktop.startFileDrag({ cwd: root, path: parseEditorTarget(target).path }); } });
  const contextMenu = (target: string, event: MouseEvent<HTMLElement>) => context?.menu(event, { label: parseFileTarget(target).path, items: [
    { id: 'preview', label: t('objects.preview'), onSelect: () => open(target) },
    { id: 'editor', label: `${t('objects.editor')}    ${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+'}Enter`, onSelect: () => openInEditor(target) },
    { id: 'quickLook', label: `${t('objects.quickLook')}    Space`, onSelect: () => quickLook(target) },
    { id: 'reveal', label: t('objects.reveal'), onSelect: () => reveal(target) },
    { id: 'copy', label: t('objects.copyPath'), onSelect: () => copyPath(target) },
  ] });
  return { open, openInEditor, quickLook, reveal, copyPath, dragProps, contextMenu };
}
