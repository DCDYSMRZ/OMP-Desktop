import { useTranslation } from 'react-i18next';
import { CodeView, languageFromPath } from '../../ui/CodeView';
import { parseFileTarget } from '../../lib/file-target';
import type { ToolActivity } from '../model';
import type { BodyProps } from '../body-props';
import { readDisplay, object, string, list, editFiles, parseNumberedDiff, parseGrepDisplay, resultText, diagnosticSeverity, diagnosticTarget } from './tool-model';
import { FileLink, Literal, ErrorBlock, BoundedCode } from './detail-primitives';

export type DetailProps = BodyProps & { tool: ToolActivity };
export function ReadDetails({ tool, onOpenFile }: DetailProps) {
  const { t } = useTranslation();
  const details = object(object(tool.result).details), display = readDisplay(tool.result);
  const file = parseFileTarget(string(object(tool.args).path) || string(details.resolvedPath));
  const numbers = display.lineNumbers?.filter((n): n is number => n !== null);
  const count = numbers?.length ?? (display.text ? display.text.replace(/\n$/, '').split('\n').length : 0);
  const first = numbers?.[0] ?? display.startLine ?? file.line ?? (count && !details.isDirectory && details.kind !== 'url' ? 1 : undefined);
  const last = numbers?.at(-1) ?? (first && count ? first + count - 1 : undefined);
  const truncation = object(object(details.meta).truncation);
  const total = Number(truncation.totalLines ?? details.totalLines) || 0;
  const highlight = file.line ? { start: file.line, end: file.endLine } : undefined;
  if (display.image) return <>{display.image.dimensions && <p className="tool-note">{display.image.dimensions}</p>}<Literal>{display.text}</Literal>{list(details.notes).map((note, i) => <p className="tool-note" key={i}>{string(note) || string(object(note).text)}</p>)}</>;
  return <>{first && last && <div className="tool-detail-heading"><FileLink file={{ path: file.path, line: first, endLine: last }} onOpenFile={onOpenFile}>{t(total ? 'tools.displayedRangeTotal' : 'tools.displayedRange', { start: first, end: last, total })}</FileLink></div>}
    {details.isDirectory || details.kind === 'url' ? <Literal>{display.text}</Literal> : <CodeView code={display.text} lang={languageFromPath(file.path)} wrap={/\.(?:md|markdown|txt)(?:$|[?#])/i.test(file.path)} startLine={first} lineNumbers={display.lineNumbers} highlight={highlight} maxHeight={360} />}
    {list(details.notes).map((note, i) => <p className="tool-note" key={i}>{string(note) || string(object(note).text)}</p>)}
    </>;
}
export function EditDetails({ tool, onOpenFile }: DetailProps) {
  const { t } = useTranslation();
  const files = editFiles(tool);
  return <>{files.map((file, index) => {
    const diff = parseNumberedDiff(file.diff);
    return <section className="tool-file-section" key={`${file.path}:${index}`}>{files.length > 1 && <div className="tool-detail-heading"><FileLink file={{ ...parseFileTarget(file.path), line: file.firstChangedLine }} onOpenFile={onOpenFile} /><span className="tool-added">+{diff.added}</span><span className="tool-removed">−{diff.removed}</span></div>}
      {file.errorText && <ErrorBlock text={file.errorText} />}
      {file.diff && <div className="tool-diff">{diff.rows.map((row, i) => <div key={i} className={`tool-diff-row ${row.sign === '+' ? 'is-added' : row.sign === '-' ? 'is-removed' : row.sign === '...' ? 'is-separator' : ''}`}><span className="tool-line-number">{row.sign === '-' ? row.oldNo : row.newNo}</span><span className="tool-diff-sign">{row.sign === '...' ? '' : row.sign}</span><span>{row.text || ' '}</span></div>)}</div>}
      {file.isError && !file.errorText && <ErrorBlock text={t('tools.status.error')} />}
      {file.diagnostics && <section className={`tool-diagnostics${file.diagnostics.errored ? ' has-errors' : ''}`} aria-label={t('tools.diagnostics', { count: file.diagnostics.messages.length })}>{file.diagnostics.summary && <p className="tool-note">{file.diagnostics.summary}</p>}<ul>{file.diagnostics.messages.map((message, i) => {
        const target = diagnosticTarget(message);
        return <li key={i} className={`severity-${diagnosticSeverity(message)}`}>{target ? <button type="button" onClick={() => onOpenFile(target)} title={t('tools.openCurrentFile')}>{message}</button> : <span>{message}</span>}</li>;
      })}</ul></section>}
    </section>;
  })}
  {!files.some(file => file.diff || file.errorText) && <Literal>{readDisplay(tool.result).text}</Literal>}</>;
}
export function WriteDetails({ tool }: DetailProps) {
  const args = object(tool.args), code = string(args.content);
  return <><BoundedCode code={code} lang={languageFromPath(string(args.path))} limit={16} identity={`write:${tool.id}`} /><Literal>{resultText(tool.result)}</Literal></>;
}
export function SearchDetails({ tool, onOpenFile }: DetailProps) {
  const { t } = useTranslation(), args = object(tool.args), details = object(object(tool.result).details);
  const display = typeof details.displayContent === 'string' ? details.displayContent : string(object(details.displayContent).text);
  const groups = parseGrepDisplay(display || resultText(tool.result), string(args.path) || string(details.scopePath));
  return <>{groups.length ? groups.map((group, index) => <section className="tool-file-section" key={`${group.path}:${index}`}><div className="tool-detail-heading"><FileLink file={{ path: group.path, line: group.lines.find(line => line.match)?.number ?? undefined }} onOpenFile={onOpenFile} /><span>{t('tools.chip.matches', { value: group.lines.filter(line => line.match).length, count: group.lines.filter(line => line.match).length })}</span></div><div className="tool-grep">{group.lines.map((line, i) => <div key={i} className={`tool-grep-row${line.match ? ' is-match' : ''}`}><span className="tool-line-number">{line.number ?? '…'}</span><span>{line.text}</span></div>)}</div></section>) : <Literal>{display || resultText(tool.result)}</Literal>}{details.truncated === true && <p className="tool-note">{t('tools.truncated')}</p>}</>;
}
export function FindDetails({ tool, onOpenFile }: DetailProps) {
  const { t } = useTranslation(), details = object(object(tool.result).details);
  const files = list(details.files).map(file => string(file) || string(object(file).path)).filter(Boolean);
  return <>{files.length ? <div className="tool-file-list">{files.slice(0, 200).map((path, i) => <FileLink key={`${path}:${i}`} file={parseFileTarget(path)} onOpenFile={onOpenFile} />)}{files.length > 200 && <span className="tool-note">{t('tools.moreFiles', { count: files.length - 200 })}</span>}</div> : <Literal>{resultText(tool.result)}</Literal>}{details.truncated === true && <p className="tool-note">{t('tools.truncated')}</p>}</>;
}
