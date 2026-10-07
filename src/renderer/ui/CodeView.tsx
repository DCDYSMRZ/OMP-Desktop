import { useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import { TokenLine, useHighlightedTokens } from './Markdown';
import { noteProgrammaticScroll } from './motion/programmatic-scroll';
import '../styles/code-view.css';

const EXTENSION_LANGUAGES: Record<string, string> = {
  mjs: 'js', cjs: 'js', mts: 'ts', cts: 'ts', jsonl: 'json', jsonc: 'jsonc', yml: 'yaml', markdown: 'md', htm: 'html', zsh: 'bash', sh: 'bash', bash: 'bash', h: 'c', hpp: 'cpp', cc: 'cpp', kt: 'kotlin', rs: 'rust', py: 'python', rb: 'ruby', go: 'go', txt: '', log: '',
};

/** Shiki language id for a file path; '' (plain text) when unknown. */
export function languageFromPath(path: string): string {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  const extension = name.includes('.') ? name.split('.').at(-1)! : '';
  return extension in EXTENSION_LANGUAGES ? EXTENSION_LANGUAGES[extension] : extension;
}

export interface CodeViewProps {
  code: string;
  lang?: string;
  /** First line number when `lineNumbers` is absent. Default 1. */
  startLine?: number;
  /** Explicit per-line numbers; `null` marks an elided/synthetic row. */
  lineNumbers?: ReadonlyArray<number | null>;
  /** Inclusive line-number range to emphasize. */
  highlight?: { start: number; end?: number };
  /** Scroll the first highlighted line into view inside the viewer. */
  revealHighlight?: boolean;
  /** Viewer max height; content scrolls inside. Omit for natural height. */
  maxHeight?: CSSProperties['maxHeight'];
  wrap?: boolean;
  gutter?: boolean;
  className?: string;
}

/**
 * Line-numbered, syntax-highlighted source viewer shared by tool results and
 * the work-panel file preview. Horizontal scroll by default; gutter stays sticky.
 */
export function CodeView({ code, lang = '', startLine = 1, lineNumbers, highlight, revealHighlight = false, maxHeight, wrap = false, gutter = true, className }: CodeViewProps) {
  const tokens = useHighlightedTokens(code, lang);
  const lines = useMemo(() => code.replace(/\n$/, '').split('\n'), [code]);
  const scroller = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const highlightEnd = highlight ? highlight.end ?? highlight.start : undefined;
  useLayoutEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    if (scroller.current && scroller.current.scrollLeft !== 0) scroller.current.scrollLeft = 0;
  }, [wrap]);
  useLayoutEffect(() => {
    if (!revealHighlight || !highlight || !scroller.current) return;
    const target = scroller.current.querySelector<HTMLElement>('[data-highlight]');
    if (!target) return;
    const lineHeight = target.offsetHeight || 20;
    scroller.current.scrollTop = Math.max(0, target.offsetTop - lineHeight * 3);
    noteProgrammaticScroll(scroller.current);
  }, [revealHighlight, highlight?.start, highlightEnd]);
  return <div className={`code-view${wrap ? ' is-wrapped' : ''}${gutter ? '' : ' no-gutter'}${className ? ` ${className}` : ''}`}>
    <div ref={scroller} className="code-view-scroll" style={maxHeight !== undefined ? { maxHeight } : undefined}>
      <div className="code-view-lines" role="presentation">
        {lines.map((line, index) => {
          const number = lineNumbers ? lineNumbers[index] ?? null : startLine + index;
          const marked = highlight && number !== null && number >= highlight.start && number <= highlightEnd!;
          return <div key={index} className={`code-view-line${number === null ? ' is-elided' : ''}`} data-line={number ?? undefined} data-highlight={marked || undefined}>
            {gutter && <span className="code-view-gutter" aria-hidden>{number ?? '⋯'}</span>}
            <span className="code-view-code">{tokens?.[index] ? <TokenLine line={tokens[index]} /> : line}{'\n'}</span>
          </div>;
        })}
      </div>
    </div>
  </div>;
}
