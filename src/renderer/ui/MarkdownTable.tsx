import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconClose, IconCopy, IconDownload, IconPanelMaximize } from "./icons";
import { portalOverlay, TooltipButton, useModalFocus } from "./ui";
import { motion, useReducedMotion, useSurfaceMotion } from './motion';
import "../styles/markdown-table.css";
import { UserErrorNotice } from '../lib/UserErrorNotice';

function TablePreview({ children, onClose }: {
  children: ReactNode;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  const close = () => setOpen(false);
  useSurfaceMotion(backdropRef, open, 'fade');
  useSurfaceMotion(dialogRef, open, 'scale');
  useModalFocus(dialogRef, { onClose: close, initialFocus: closeRef });
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(onClose, reduced ? motion.reduced : motion.exit);
    return () => window.clearTimeout(timer);
  }, [open, onClose, reduced]);
  return portalOverlay(
    <div
      ref={backdropRef}
      className={`overlay markdown-table-overlay${open ? '' : ' is-leaving'}`}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog markdown-table-preview"
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.tablePreview")}
      >
        <header className="markdown-table-preview-head">
          <span>{t("chat.tablePreview")}</span>
          <TooltipButton
            ref={closeRef}
            type="button"
            className="icon-btn"
            tooltip={t("chat.closeTablePreview")}
            onClick={close}
          >
            <IconClose size="var(--icon-ui)" />
          </TooltipButton>
        </header>
        <div className="markdown-table-preview-body prose-chat">{children}</div>
      </div>
    </div>,
  );
}

export function MarkdownTable({ children, markdown, csv }: {
  children: ReactNode;
  markdown: string;
  csv: string;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<{ message: string; error: boolean } | null>(null);
  const [preview, setPreview] = useState(false);
  const closePreview = useCallback(() => setPreview(false), []);
  const copy = async () => {
    try {
      await window.ompDesktop.copyText(markdown);
      setStatus({ message: t("chat.tableCopied"), error: false });
    } catch (error) {
      setStatus({ message: String(error), error: true });
    }
  };
  const download = () => {
    let url: string | undefined;
    const link = document.createElement("a");
    try {
      url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      link.href = url;
      link.download = "table.csv";
      document.body.append(link);
      link.click();
    } catch (error) {
      setStatus({ message: String(error), error: true });
    } finally {
      link.remove();
      // Keep the URL alive until the browser has consumed the download click.
      if (url) {
        const downloadUrl = url;
        window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      }
    }
  };
  const toolbar = (expanded = false) => (
    <div className="markdown-table-actions" role="group" aria-label={t("chat.tableActions")}>
      <TooltipButton
        type="button"
        className="icon-btn"
        tooltip={t("chat.copyTableMarkdown")}
        onClick={() => void copy()}
      >
        <IconCopy size="var(--icon-meta)" />
      </TooltipButton>
      <TooltipButton
        type="button"
        className="icon-btn"
        tooltip={t("chat.exportTableCsv")}
        onClick={download}
      >
        <IconDownload size="var(--icon-meta)" />
      </TooltipButton>
      {!expanded ? (
        <TooltipButton
          type="button"
          className="icon-btn"
          tooltip={t("chat.tablePreview")}
          onClick={() => setPreview(true)}
        >
          <IconPanelMaximize size="var(--icon-meta)" />
        </TooltipButton>
      ) : null}
    </div>
  );
  return (
    <div className="markdown-table">
      {toolbar()}
      {status ? status.error ? <UserErrorNotice error={status.message} /> : <div role="status">{status.message}</div> : null}
      {children}
      {preview ? (
        <TablePreview onClose={closePreview}>
          {toolbar(true)}
          {children}
        </TablePreview>
      ) : null}
    </div>
  );
}
