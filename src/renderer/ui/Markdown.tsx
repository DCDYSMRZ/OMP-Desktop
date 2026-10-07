import { UserErrorNotice } from '../lib/UserErrorNotice';
import { UserFacingError, preserveUserError } from '../lib/user-errors';
import {
  createContext,
  Fragment,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ComponentProps,
  type RefObject,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import {
  advanceMarkdownBlocks,
  emptyMarkdownBlockCache,
  markdownRemarkPlugins,
} from "../lib/markdown-blocks";
import { useTranslation } from "react-i18next";
import type { ThemedToken } from "shiki";
import "katex/dist/katex.min.css";
import { REVEAL_DURATION, type StreamingReveal } from "../chat/streaming-reveal";
import { rehypeStreamingText } from "../chat/streaming-markdown";
import { remarkStreamingTail } from '../chat/streaming-tail';
import { rehypeInlineImageMarkers } from '../chat/inline-image-markers';
import { useReducedMotion } from "./motion";
import {
  IconCheck,
  IconCircleAlert,
  IconCode,
  IconCopy,
  IconExternal,
  IconImage,
  IconWorkflow,
} from "./icons";
import { TooltipButton } from "./ui";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { MarkdownTable } from "./MarkdownTable";
import { markdownTableData } from "../lib/markdown-table";
import {
  rehypeSourcePositions,
  sourcePositionProps,
  type SourcePositionProps,
} from "../lib/markdown-source";
import {
  normalizeLatexMathDelimiters,
  remarkLatexBracketDisplay,
} from "../lib/latex-math";
import { useReferencedImageDataUrl } from "../lib/use-referenced-image-data-url";
import { absoluteImagePath, remarkLocalImagePaths } from "../lib/markdown-image-paths";
import { markdownSessionResourceReference, remarkNormalizeWrappedMarkdownLinkDestinations } from "../lib/markdown-link-destinations";
import {
  remarkChatFileLinks,
  resolvePreviewTarget,
  safeDecodeUri,
  toWorkspaceRel,
} from "../lib/chat-links";
import {
  isClosedFencedCodeBlock,
  MAX_MERMAID_SOURCE_LENGTH,
  MermaidSourceTooLargeError,
  renderMermaidSvg,
} from "../lib/mermaid";
import { resolveLang, themeForMode, type ThemeMode } from "../lib/shiki";
import { createHighlightClient, type HighlightClient } from '../lib/highlight-client';

export interface MarkdownImageMarkers { count: number; render: (index: number, literal: string) => ReactNode }
type MarkdownActions = {
  cwd: string;
  onOpenFile?: (path: string) => void;
  onOpenSessionResource?: (reference: string) => void;
  imageMarkers?: MarkdownImageMarkers;
  reportError: (error: unknown) => void;
};
const MarkdownActionsContext = createContext<MarkdownActions | null>(null);
function useMarkdownActions() {
  const actions = useContext(MarkdownActionsContext);
  if (!actions) throw new Error("Markdown actions require a Markdown parent");
  return actions;
}
function useOpenMarkdownFile() {
  const { cwd, onOpenFile, reportError } = useMarkdownActions();
  const { t } = useTranslation();
  return (path: string, baseDir?: string) => {
    const target = resolvePreviewTarget(path, cwd, baseDir);
    const relative = target?.kind === "file" ? target.path : toWorkspaceRel(path, cwd, baseDir);
    if (!relative) { reportError(new UserFacingError(t("ompVisual.outsideWorkspace"))); return; }
    if (onOpenFile) onOpenFile(relative);
    else void window.ompDesktop.revealFile(cwd, relative).catch(reportError);
  };
}
function useOpenExternal() {
  const { reportError } = useMarkdownActions();
  return (url: string) => { void window.ompDesktop.openExternal(url).catch(reportError); };
}
type ChatFileMenuTarget = { path: string; baseDir?: string };

/*
 * Streaming-optimized chat markdown renderer.
 *
 * The source is split with the rendering grammar, and each block renders
 * through a memoized <ReactMarkdown>. Streaming re-parses the growing tail
 * while retaining the completed prefix; a long unclosed block still has to
 * be parsed in full until its boundary is known. A source carrying link or
 * footnote definitions opts out of splitting altogether — `markdown-blocks`
 * states why, and why that trade is the right one.
 */

export function useCopy() {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback((text: string) => {
    setError(null);
    void window.ompDesktop.copyText(text).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    }).catch((cause: unknown) => setError(String(cause)));
  }, []);
  return { copied, copy, error };
}

/* ---------- theme (follows documentElement[data-theme]) ---------- */

const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;

function subscribeTheme(listener: () => void): () => void {
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => {
      for (const cb of themeListeners) cb();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
}

function getThemeSnapshot(): ThemeMode {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribeTheme, getThemeSnapshot);
}

/* ---------- syntax highlighting ---------- */

function tokenStyle(token: ThemedToken): CSSProperties | undefined {
  const fontStyle = token.fontStyle ?? 0;
  if (!token.color && !fontStyle) return undefined;
  const style: CSSProperties = {};
  if (token.color) style.color = token.color;
  if (fontStyle & 1) style.fontStyle = "italic";
  if (fontStyle & 2) style.fontWeight = "var(--font-weight-semibold)";
  if (fontStyle & 4) style.textDecoration = "underline";
  return style;
}

/** Absolute source time survives Markdown reparses and changing React ancestry. */
function RevealSpan({ at, offset, children }: { at: number; offset: number; children: ReactNode }) {
  const reduced = useReducedMotion();
  const [settled, setSettled] = useState(() => performance.now() >= at + REVEAL_DURATION);
  const node = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const remaining = at + REVEAL_DURATION - performance.now();
    if (reduced || remaining <= 0) { setSettled(true); return; }
    const animation = node.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: REVEAL_DURATION, easing: 'cubic-bezier(0.33, 0, 0.2, 1)', fill: 'both' });
    if (animation) animation.currentTime = performance.now() - at;
    const timer = window.setTimeout(() => setSettled(true), remaining);
    return () => { window.clearTimeout(timer); animation?.cancel(); };
  }, [at, reduced]);
  return settled || reduced ? <>{children}</> : <span ref={node} className="streaming-glyph" data-reveal-offset={offset} data-reveal-at={at}>{children}</span>;
}

function StreamingSpan({ node: _node, children, ...props }: ComponentProps<"span"> & { node?: unknown; "data-reveal-at"?: number; "data-reveal-offset"?: number }) {
  const at = props["data-reveal-at"];
  return at === undefined ? <span {...props}>{children}</span> : <RevealSpan key={props["data-reveal-offset"]} at={Number(at)} offset={Number(props["data-reveal-offset"])}>{children}</RevealSpan>;
}

function MarkdownSpan(props: ComponentProps<"span"> & { node?: unknown; "data-image-marker"?: number; "data-image-literal"?: string }) {
  const { imageMarkers } = useMarkdownActions();
  const index = props["data-image-marker"];
  if (imageMarkers && index !== undefined) return imageMarkers.render(Number(index), props["data-image-literal"] ?? '');
  return <StreamingSpan {...props} />;
}

/* Rows are cached by reference in the line cache, so settled lines memo-skip. */
export const TokenLine = memo(function TokenLine({ line }: { line: ThemedToken[] }) {
  return <>{line.map((token, i) => <span key={i} style={tokenStyle(token)}>{token.content}</span>)}</>;
});

export function useHighlightedTokens(
  code: string,
  lang: string,
): ThemedToken[][] | null {
  const resolved = resolveLang(lang);
  const mode = useThemeMode();
  const [result, setResult] = useState<{ code: string; lang: string; mode: ThemeMode; tokens: ThemedToken[][] | null }>();
  const client = useRef<HighlightClient | null>(null);
  const request = useRef(0);
  const current = useRef({ code, lang, mode });
  current.current = { code, lang, mode };
  useEffect(() => {
    client.current = createHighlightClient((version, tokens) => { if (version === request.current) setResult({ ...current.current, tokens }); });
    return () => { client.current?.close(); client.current = null; };
  }, []);
  useEffect(() => {
    const version = ++request.current;
    if (resolved) client.current?.request(version, code, resolved, themeForMode(mode));
  }, [code, resolved, mode]);
  return result?.code === code && result.lang === lang && result.mode === mode ? result.tokens : null;
}

/**
 * Tokenized code body (no chrome). Shared with the transcript's tool result
 * blocks so both use the one incremental highlighter cache.
 */
export function HighlightedCode({
  code,
  lang = "",
}: {
  code: string;
  lang?: string;
}) {
  const tokens = useHighlightedTokens(code, lang);
  if (!tokens) return <>{code}</>;
  return (
    <>
      {tokens.map((line, i) => <Fragment key={i}>{i > 0 ? "\n" : null}<TokenLine line={line} /></Fragment>)}
    </>
  );
}

function CodeBlock({ code, lang, ...position }: { code: string; lang: string } & SourcePositionProps) {
  const { t } = useTranslation();
  const { copied, copy, error } = useCopy();
  return (
    <div className="code-block" {...position}>
      <div className="code-block-head">
        <span className="code-block-lang">{lang || "text"}</span>
        <TooltipButton
          className={`code-copy-btn ${copied ? "copied" : ""}`}
          tooltip={copied ? t("chat.copied") : t("chat.copy")}
          ariaLabel={t("chat.copy")}
          onClick={() => copy(code)}
        >
          {copied ? <IconCheck size="var(--icon-meta)" /> : <IconCopy size="var(--icon-meta)" />}
        </TooltipButton>
      </div>
      {error ? <UserErrorNotice error={error} /> : null}
      <pre>
        <code>
          <HighlightedCode code={code} lang={lang} />
        </code>
      </pre>
    </div>
  );
}

function useNearViewport(ref: RefObject<HTMLDivElement | null>): boolean {
  const [nearViewport, setNearViewport] = useState(false);
  useEffect(() => {
    if (nearViewport) return;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [nearViewport, ref]);
  return nearViewport;
}

function MermaidBlock({ code, ...position }: { code: string } & SourcePositionProps) {
  const { t } = useTranslation();
  const theme = useThemeMode();
  const reactId = useId();
  const renderId = useMemo(
    () => `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [reactId],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const nearViewport = useNearViewport(rootRef);
  const renderedSourceRef = useRef("");
  const [svg, setSvg] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<"invalid" | "too-large" | null>(null);
  const [showSource, setShowSource] = useState(false);
  const { copied, copy, error: copyError } = useCopy();

  useEffect(() => {
    setShowSource(false);
  }, [code]);

  useEffect(() => {
    if (!nearViewport) return;
    if (code.length > MAX_MERMAID_SOURCE_LENGTH) {
      setSvg("");
      setLoading(false);
      setError("too-large");
      return;
    }

    let active = true;
    if (renderedSourceRef.current !== code) setSvg("");
    setLoading(true);
    setError(null);
    void renderMermaidSvg({ id: renderId, source: code, theme })
      .then((nextSvg) => {
        if (!active) return;
        renderedSourceRef.current = code;
        setSvg(nextSvg);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setSvg("");
        setLoading(false);
        setError(
          cause instanceof MermaidSourceTooLargeError ? "too-large" : "invalid",
        );
      });
    return () => {
      active = false;
    };
  }, [code, nearViewport, renderId, theme]);

  const sourceVisible = showSource || error !== null;
  const statusLabel =
    error === "too-large"
      ? t("chat.diagramTooLarge")
      : t("chat.diagramUnavailable");

  return (
    <div
      ref={rootRef}
      {...position}
      className={`mermaid-block${error ? " error" : ""}`}
      aria-busy={loading}
    >
      <div className="mermaid-block-head">
        <span className="mermaid-block-title">
          <IconWorkflow size="var(--icon-meta)" aria-hidden />
          <span>mermaid</span>
        </span>
        <div className="mermaid-block-actions">
          {svg && !error ? (
            <TooltipButton
              type="button"
              className={`mermaid-action-btn${showSource ? " active" : ""}`}
              tooltip={
                showSource ? t("chat.showDiagram") : t("chat.showDiagramSource")
              }
              ariaLabel={
                showSource ? t("chat.showDiagram") : t("chat.showDiagramSource")
              }
              aria-pressed={showSource}
              onClick={() => setShowSource((value) => !value)}
            >
              {showSource ? (
                <IconWorkflow size="var(--icon-meta)" />
              ) : (
                <IconCode size="var(--icon-meta)" />
              )}
            </TooltipButton>
          ) : null}
          <TooltipButton
            type="button"
            className={`mermaid-action-btn${copied ? " copied" : ""}`}
            tooltip={copied ? t("chat.copied") : t("chat.copyDiagramSource")}
            ariaLabel={t("chat.copyDiagramSource")}
            onClick={() => copy(code)}
          >
            {copied ? <IconCheck size="var(--icon-meta)" /> : <IconCopy size="var(--icon-meta)" />}
          </TooltipButton>
        </div>
      </div>
      <div className="mermaid-block-body">
        {copyError ? <UserErrorNotice error={copyError} /> : null}
        {error ? (
          <div className="mermaid-block-error" role="status">
            <IconCircleAlert size="var(--icon-meta)" aria-hidden />
            <span>{statusLabel}</span>
          </div>
        ) : null}
        {sourceVisible ? (
          <pre className="mermaid-source">
            <code>{code}</code>
          </pre>
        ) : svg ? (
          <div
            className={`mermaid-svg${loading ? " refreshing" : ""}`}
            role="img"
            aria-label={t("chat.mermaidDiagram")}
            // Mermaid strict mode output is sanitized again in renderMermaidSvg.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div
            className="mermaid-loading"
            role="status"
            aria-label={t("chat.diagramRendering")}
          >
            <span aria-hidden />
            <span aria-hidden />
            <span aria-hidden />
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- react-markdown component overrides ---------- */

const MarkdownBlockContext = createContext({
  closedFence: false,
  renderDiagrams: true,
  originalRaw: "",
  sourceOffset: 0,
  reveal: undefined as StreamingReveal | undefined,
});

const MarkdownBaseDirContext = createContext("");

/**
 * File references inside one rendered markdown tree share a single menu.
 *
 * A chip, a link and a local image all name files the same way and offer the
 * same host actions, so the tree owns one surface instead of
 * one per reference. The default is `null` for a tree rendered outside
 * `Markdown`; a reference there keeps the platform's own menu rather than
 * offering an action that could not run.
 */
const MarkdownFileMenuContext = createContext<OpenMarkdownFileMenu | null>(null);

type OpenMarkdownFileMenu = (
  event: React.MouseEvent<HTMLElement>,
  target: ChatFileMenuTarget,
) => void;

function extractCode(children: ReactNode): { code: string; lang: string } | null {
  const element = Array.isArray(children)
    ? children.find((child) => isValidElement(child))
    : children;
  if (!isValidElement(element)) return null;
  const props = element.props as { className?: unknown; children?: unknown };
  const className = typeof props.className === "string" ? props.className : "";
  const lang = /language-(\S+)/.exec(className)?.[1] ?? "";
  const raw = props.children;
  const code =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw) && raw.every((part) => typeof part === "string")
        ? raw.join("")
        : null;
  if (code === null) return null;
  return { code: code.replace(/\n$/, ""), lang };
}

function PreBlock({
  node: _node,
  children,
  ...rest
}: ComponentProps<"pre"> & SourcePositionProps & { node?: unknown }) {
  const { closedFence, renderDiagrams } = useContext(MarkdownBlockContext);
  const info = extractCode(children);
  if (!info) return <pre {...rest}>{children}</pre>;
  if (
    renderDiagrams &&
    closedFence &&
    info.lang.toLowerCase() === "mermaid"
  ) {
    return <MermaidBlock code={info.code} {...sourcePositionProps(rest)} />;
  }
  return <CodeBlock code={info.code} lang={info.lang} {...sourcePositionProps(rest)} />;
}

/** Preview-in-panel tooltip for file and URL chat references. */
function usePreviewTitle(kind: "file" | "url"): string {
  const { t } = useTranslation();
  return kind === "file" ? t("chat.previewFile") : t("settings.linkContextMenuOpenExternal");
}

/**
 * Inline code that names a workspace file (or URL) opens in the work panel;
 * everything else stays a plain code chip. Fenced blocks never reach this
 * component — PreBlock intercepts them.
 */
function InlineCode({
  node: _node,
  className,
  children,
  ...rest
}: ComponentProps<"code"> & SourcePositionProps & { node?: unknown }) {
  const { cwd: root } = useMarkdownActions();
  const baseDir = useContext(MarkdownBaseDirContext);
  const openFileRef = useOpenMarkdownFile();
  const openHttpUrl = useOpenExternal();
  const openFileMenu = useContext(MarkdownFileMenuContext);
  const text = typeof children === "string" ? children : null;
  const target =
    text && !className && !text.includes("\n")
      ? resolvePreviewTarget(text, root, baseDir)
      : null;
  const fileTitle = usePreviewTitle("file");
  const urlTitle = usePreviewTitle("url");
  if (!target) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  }
  return (
    <button
      type="button"
      className="chat-code-link"
      title={target.kind === "file" ? fileTitle : urlTitle}
      onClick={() =>
        target.kind === "file"
          ? openFileRef(text ?? target.path, baseDir)
          : openHttpUrl(target.url)
      }
      onContextMenu={
        target.kind === "file" && openFileMenu
          ? (event) =>
              openFileMenu(event, { path: text ?? target.path, baseDir })
          : undefined
      }
    >
      <code className={className} {...rest}>
        {children}
      </code>
    </button>
  );
}

function Anchor({
  node: _node,
  children,
  href,
  ...rest
}: ComponentProps<"a"> & { node?: unknown }) {
  const { t } = useTranslation();
  const { cwd: root, reportError, onOpenSessionResource } = useMarkdownActions();
  const baseDir = useContext(MarkdownBaseDirContext);
  const openFileRef = useOpenMarkdownFile();
  const openHttpUrl = useOpenExternal();
  const openFileMenu = useContext(MarkdownFileMenuContext);

  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();

  const [copied, setCopied] = useState(false);
  const copyLink = async (target: string) => {
    try {
      await window.ompDesktop.copyText(target);
      setCopied(true);
    } catch (error) { reportError(error); }
  };

  /*
    A link keeps the renderer's own menu instead of the platform's so both
    destinations the app can send it to stay one press away. The surface is the
    shared pointer-anchored menu, which measures before it reveals, clamps inside
    the viewport, and owns dismissal and arrow-key navigation; only the items are
    link-specific. A file link has one destination of its own, and that item is
    the one the tree's menu already carries.
  */
  const onContextMenu = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!href) return;
    if (/^(?:artifact|agent):\/\//.test(href)) { event.preventDefault(); return; }
    if (!/^https?:\/\//i.test(href)) {
      /*
        A file link names the same reference a chip does, so it offers the same
        action on the file's folder. `./` and `../` resolve against the markdown
        file on screen, which is the base this row already holds.
      */
      const rel = toWorkspaceRel(safeDecodeUri(href), root, baseDir);
      if (!rel || !openFileMenu) return;
      openFileMenu(event, { path: rel, baseDir });
      return;
    }
    const target = href;
    openContextMenu(event, {
      items: [
        {
          id: "open-external",
          label: t("settings.linkContextMenuOpenExternal", {
            defaultValue: "Open in default browser",
          }),
          icon: <IconExternal size="var(--icon-meta)" />,
          onSelect: () => openHttpUrl(target),
        },
        {
          id: "copy-address",
          label: t("settings.linkContextMenuCopy", {
            defaultValue: "Copy link address",
          }),
          icon: <IconCopy size="var(--icon-meta)" />,
          separatorBefore: true,
          onSelect: () => void copyLink(target),
        },
      ],
    });
  };

  // All destinations go through the restricted host bridge, including modifier clicks.
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (!href) return;
    if (/^(?:artifact|agent):\/\//.test(href)) { if (onOpenSessionResource) onOpenSessionResource(markdownSessionResourceReference(href)); else reportError('Native output requires an authorized conversation source.'); return; }
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault();
      openHttpUrl(href);
      return;
    }
    const rel = toWorkspaceRel(safeDecodeUri(href), root, baseDir);
    if (rel) {
      e.preventDefault();
      openFileRef(rel, baseDir);
    }
  };
  return (
    <>
      <a
        {...rest}
        href={href}
        onClick={onClick}
        onContextMenu={onContextMenu}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
      <ContextMenu state={contextMenu} onClose={closeContextMenu} />
      {copied ? <span className="sr-only" role="status">{t("chat.copied")}</span> : null}
    </>
  );
}

/**
 * Local image references can't load over the renderer origin; the host
 * resolves them into a bounded data URL so they render inline. Missing,
 * escaped, or oversized files fall back to a chip. Remote images render
 * inline and click through to the browser tab.
 */
function MarkdownImage({
  node: _node,
  src,
  alt,
  ...rest
}: ComponentProps<"img"> & SourcePositionProps & { node?: unknown }) {
  const { cwd: root } = useMarkdownActions();
  const { t } = useTranslation();
  const baseDir = useContext(MarkdownBaseDirContext);
  const openFileRef = useOpenMarkdownFile();
  const openHttpUrl = useOpenExternal();
  const openFileMenu = useContext(MarkdownFileMenuContext);
  const fileTitle = usePreviewTitle("file");
  const urlTitle = usePreviewTitle("url");
  const source = typeof src === "string" ? src : "";
  const remoteUrl = safeRemoteMediaUrl(source);
  const isRemote = remoteUrl !== null;
  const decoded = safeDecodeUri(source);
  const rel = isRemote ? null : toWorkspaceRel(decoded, root, baseDir);
  const localRef = (isRemote ? null : absoluteImagePath(source)) ?? rel;
  // Always run the hook before any branch so hook order stays stable when a
  // streaming src flips between remote and local. Remote images pass null.
  const { dataUrl, error } = useReferencedImageDataUrl(isRemote ? null : localRef, root);

  /*
    A file the renderer can already show is still a file whose folder the user
    may want, so a local image carries the same menu its chip fallback does.
  */
  const onLocalContextMenu =
    localRef && openFileMenu
      ? (event: React.MouseEvent<HTMLElement>) =>
          openFileMenu(event, { path: localRef, baseDir })
      : undefined;
  if (remoteUrl) {
    return (
      <img {...rest} src={remoteUrl} alt={alt ?? ""} className="chat-image-remote"
        referrerPolicy="no-referrer" loading="lazy" decoding="async"
        title={urlTitle} onClick={() => openHttpUrl(remoteUrl)} />
    );
  }
  if (dataUrl) {
    return (
      <img
        {...rest}
        src={dataUrl}
        alt={alt ?? ""}
        className="chat-image-local"
        title={rel ? fileTitle : source}
        onClick={localRef ? () => openFileRef(localRef, baseDir) : undefined}
        onContextMenu={onLocalContextMenu}
      />
    );
  }
  if (localRef) {
    return (
      <button
        type="button"
        className="chat-image-chip"
        {...sourcePositionProps(rest)}
        title={error ?? fileTitle}
        onClick={() => openFileRef(localRef, baseDir)}
        onContextMenu={onLocalContextMenu}
      >
        <IconImage size="var(--icon-meta)" aria-hidden />
        <span>{alt || localRef.split("/").pop()}</span>
        {error ? <span role="status">{error}</span> : null}
      </button>
    );
  }
  return <span className="chat-image-chip" role="status">{alt || t("ompVisual.imageUnavailable")}</span>;
}

function Table({
  node,
  children,
  ...rest
}: ComponentProps<"table"> & { node?: Parameters<typeof markdownTableData>[0] }) {
  const { originalRaw } = useContext(MarkdownBlockContext);
  const data = useMemo(
    () => node ? markdownTableData(node, originalRaw) : null,
    [node, originalRaw],
  );
  const table = (
    <div className="table-wrap">
      <table {...rest}>{children}</table>
    </div>
  );
  return data ? <MarkdownTable {...data}>{table}</MarkdownTable> : table;
}

/** Media URLs cannot smuggle file/data/javascript schemes or credentials. */
function safeRemoteMediaUrl(source: string): string | null {
  try {
    const url = new URL(source);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function MediaBlock({ kind, src, children }: { kind: "audio" | "video"; src?: string; children?: ReactNode }) {
  const openExternal = useOpenExternal();
  const { t } = useTranslation();
  const url = safeRemoteMediaUrl(src ?? "");
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src, children]);
  const Player = kind;
  return (
    <div className={`chat-${kind}`}>
      {url || (!src && children) ? (
        <Player controls preload="none" src={url ?? undefined} onError={() => setFailed(true)}>
          {children}
        </Player>
      ) : <span role="status">{t("ompVisual.mediaUnsupported")}</span>}
      {failed ? (
        <div role="status">
          {t("ompVisual.mediaPlaybackFailed")}
          {url ? <button type="button" className="chat-image-chip" onClick={() => openExternal(url)}><IconExternal size="var(--icon-meta)" />{url}</button> : null}
        </div>
      ) : null}
    </div>
  );
}
function MediaSource({ src, type }: ComponentProps<"source"> & { node?: unknown }) {
  const url = safeRemoteMediaUrl(src ?? "");
  return url ? <source src={url} type={type} /> : null;
}

const markdownComponents: Components = {
  span: MarkdownSpan,
  pre: PreBlock,
  code: InlineCode,
  a: Anchor,
  img: MarkdownImage,
  audio: ({ src, children }) => <MediaBlock kind="audio" src={src} children={children} />,
  video: ({ src, children }) => <MediaBlock kind="video" src={src} children={children} />,
  source: MediaSource,
  table: Table,
};

// The grammar the block splitter parses with, plus the renderer-only rewrite
// of local image paths. `remarkLocalImagePaths` transforms URLs and moves no
// block boundary, so the splitter has no reason to run it.
const staticRemarkPlugins = [
  ...markdownRemarkPlugins,
  remarkNormalizeWrappedMarkdownLinkDestinations,
  remarkLocalImagePaths,
];

// Extend the default schema only for the media elements rendered above, plus
// `remark-math`'s math classes on `<code>`: the default `language-*` allow list
// drops `math-display`, which leaves `rehype-katex` rendering TeX `\[ … \]`
// (single-line or mid-paragraph) as inline math instead of display math.
const sanitizeSchema = {
  ...defaultSchema,
  protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href || []), "artifact", "agent"] },
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
    img: [...(defaultSchema.attributes?.img || []), "src", "alt", "title", "className"],
    audio: ["src", "controls", "preload", "className"],
    video: ["src", "controls", "preload", "className", "poster"],
    source: ["src", "type"],
  },
  tagNames: [
    ...(defaultSchema.tagNames || []),
    "audio",
    "video",
    "source",
  ],
};

const rehypePlugins = [rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex] as Options["rehypePlugins"];

/* ---------- block splitting ---------- */

/*
 * Splitting and its streaming reuse live in `markdown-blocks`, which owns the
 * rules a slice has to satisfy before it can be parsed on its own.
 */
function useBlocks(source: string): string[] {
  const cacheRef = useRef(emptyMarkdownBlockCache);
  return useMemo(() => {
    cacheRef.current = advanceMarkdownBlocks(cacheRef.current, source);
    return cacheRef.current.blocks;
  }, [source]);
}

const Block = memo(function MarkdownBlock({
  raw,
  originalRaw,
  sourceOffset,
  renderDiagrams,
  workspaceRoot,
  baseDir,
  reveal,
  streaming,
}: {
  raw: string;
  originalRaw: string;
  sourceOffset: number;
  renderDiagrams: boolean;
  workspaceRoot?: string | null;
  baseDir?: string;
  reveal?: StreamingReveal;
  streaming: boolean;
}) {
  const { imageMarkers } = useMarkdownActions();
  const context = useMemo(
    () => ({
      closedFence: isClosedFencedCodeBlock(raw),
      renderDiagrams,
      originalRaw,
      sourceOffset,
      reveal,
    }),
    [raw, originalRaw, renderDiagrams, sourceOffset, reveal],
  );
  const remarkPlugins = useMemo<Options["remarkPlugins"]>(
    () => [
      ...staticRemarkPlugins,
      // `originalRaw` still carries the TeX `\[ … \]` delimiters so the
      // bracket-display plugin can promote them to display math after
      // remark-math parses the pre-normalized `$$ … $$` form.
      remarkLatexBracketDisplay(originalRaw),
      remarkChatFileLinks(workspaceRoot, baseDir),
      [remarkStreamingTail, { raw, streaming }],
    ],
    [originalRaw, workspaceRoot, baseDir, raw, streaming],
  );
  const positionedRehypePlugins = useMemo(
    () => [...rehypePlugins!, [rehypeSourcePositions, { offset: sourceOffset }], ...(imageMarkers ? [[rehypeInlineImageMarkers, { count: imageMarkers.count }]] : []), [rehypeStreamingText, { offset: sourceOffset, raw, reveal }]] as Options["rehypePlugins"],
    [sourceOffset, raw, reveal, imageMarkers],
  );
  return (
    <MarkdownBlockContext.Provider value={context}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={positionedRehypePlugins}
        components={markdownComponents}
        urlTransform={(url, key) => key === "href" && /^(?:artifact|agent):\/\//.test(url) ? url : defaultUrlTransform(url)}
      >
        {raw}
      </ReactMarkdown>
    </MarkdownBlockContext.Provider>
  );
});

export const Markdown = memo(function Markdown({
  source,
  renderDiagrams = true,
  baseDir,
  cwd = "",
  onOpenFile,
  onOpenSessionResource,
  reveal,
  imageMarkers,
  streaming = false,
}: {
  source: string;
  renderDiagrams?: boolean;
  reveal?: StreamingReveal;
  streaming?: boolean;
  /** Workspace-relative directory of the source file, for `./` / `../` links. */
  baseDir?: string;
  /** Absolute workspace directory for host-contained file/image reads. */
  cwd?: string;
  onOpenFile?: (path: string) => void;
  onOpenSessionResource?: (reference: string) => void;
  imageMarkers?: MarkdownImageMarkers;
}) {
  const workspaceRoot = cwd;
  const [error, setError] = useState<Error | string | null>(null);
  const reportError = useCallback((cause: unknown) => setError(preserveUserError(cause)), []);
  const actions = useMemo(() => ({ cwd, onOpenFile, onOpenSessionResource, reportError, imageMarkers }), [cwd, onOpenFile, onOpenSessionResource, reportError, imageMarkers]);

  /*
    One menu for every file reference in this tree. Its blocks are memoized and
    rendered through the same component map, so the surface is asked for by the
    reference the pointer chose and owned here, where it outlives a block that
    streaming may replace.
  */
  const {
    contextMenu: fileMenu,
    openContextMenu: openFileMenu,
    closeContextMenu: closeFileMenu,
  } = useContextMenu();
  const { t } = useTranslation();
  const openMarkdownFileMenu = useCallback<OpenMarkdownFileMenu>((event, target) => {
    const resolved = resolvePreviewTarget(target.path, cwd, target.baseDir);
    const path = resolved?.kind === "file" ? resolved.path : toWorkspaceRel(target.path, cwd, target.baseDir);
    if (!path) return;
    const fullPath = cwd.startsWith("/") ? `${cwd.replace(/\/+$/, "")}/${path}` : null;
    openFileMenu(event, { items: [
      { id: "open", label: t("chat.previewFile"), onSelect: () => {
        if (onOpenFile) onOpenFile(path);
        else void window.ompDesktop.revealFile(cwd, path).catch(reportError);
      } },
      { id: "reveal", label: t("chat.revealFileInFolder"), onSelect: () => { void window.ompDesktop.revealFile(cwd, path).catch(reportError); } },
      ...(fullPath ? [{ id: "copy-full-path", label: t("chat.copyFullPath"), icon: <IconCopy size="var(--icon-meta)" />, separatorBefore: true, onSelect: () => { void window.ompDesktop.copyText(fullPath).catch(reportError); } }] : []),
      { id: "copy-relative-path", label: t("chat.copyRelativePath"), icon: <IconCopy size="var(--icon-meta)" />, onSelect: () => { void window.ompDesktop.copyText(path).catch(reportError); } },
    ] });
  }, [cwd, onOpenFile, openFileMenu, reportError, t]);
  // Keep normalization length-preserving so source anchors and the bracket
  // display plugin still address the original text. Block splitting uses the
  // same math grammar as rendering, including unclosed streaming math blocks.
  const normalizedSource = useMemo(
    () => normalizeLatexMathDelimiters(source),
    [source],
  );
  const blocks = useBlocks(normalizedSource);
  let sourceOffset = 0;
  return (
    <MarkdownActionsContext.Provider value={actions}>
    <MarkdownFileMenuContext.Provider value={openMarkdownFileMenu}>
      <MarkdownBaseDirContext.Provider value={baseDir ?? ""}>
        {blocks.map((raw, i) => {
          const start = sourceOffset;
          sourceOffset = start + raw.length;
          const originalRaw = source.slice(start, start + raw.length);
          return (
            <Block
              key={i}
              raw={raw}
              originalRaw={originalRaw}
              sourceOffset={start}
              renderDiagrams={renderDiagrams}
              workspaceRoot={workspaceRoot}
              baseDir={baseDir}
              reveal={reveal}
              streaming={streaming && i === blocks.length - 1}
            />
          );
        })}
      </MarkdownBaseDirContext.Provider>
      <ContextMenu state={fileMenu} onClose={closeFileMenu} />
      {error ? <div className="markdown-action-error"><UserErrorNotice error={error} /><button type="button" onClick={() => setError(null)}>{t("common.close", { defaultValue: "Close" })}</button></div> : null}
    </MarkdownFileMenuContext.Provider>
    </MarkdownActionsContext.Provider>
  );
});
