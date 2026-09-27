import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { IconClose } from '../ui/icons';
import { useTranslation } from 'react-i18next';
import { useGlassExit } from '../lib/portal-visibility';
export function ImagePreview({ source, name, onClose }: { source: string; name: string; onClose: () => void }) {
  const { t } = useTranslation();
  const button = useRef<HTMLButtonElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = frame.current;
    const trigger = document.activeElement?.getBoundingClientRect();
    if (!element || !trigger) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      element.style.setProperty('--lg-origin-x', `${trigger.x + trigger.width / 2 - bounds.x}px`);
      element.style.setProperty('--lg-origin-y', `${trigger.y + trigger.height / 2 - bounds.y}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useGlassExit(overlay);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; button.current?.focus(); return () => previous?.focus(); }, []);
  return createPortal(<div ref={overlay} className="modal-backdrop native-image-preview" role="dialog" aria-modal="true" aria-label={name} onClick={onClose} onKeyDown={event => { if (event.key === 'Escape') onClose(); if (event.key === 'Tab') { event.preventDefault(); button.current?.focus(); } }}><button ref={button} className="icon-btn lg-thin lg-capsule lg-pressable" aria-label={t('common.close')} onClick={onClose}><IconClose size={22} /></button><div ref={frame} className="native-image-preview-frame lg-regular lg-morph-in"><img src={source} alt={name} onClick={event => event.stopPropagation()} /></div></div>, document.body);
}
