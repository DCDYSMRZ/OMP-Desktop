import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Markdown } from '../../ui/Markdown';
import { object, string, list, resultText, messageReceipts, receiptOutcome } from './tool-model';
import { Literal, StatusIcon, ErrorBlock } from './detail-primitives';
import type { DetailProps } from './FileDetails';

export function MessageDetails({ tool, ...body }: DetailProps) {
  const { t } = useTranslation(), args = object(tool.args);
  return <div className="tool-agent-message"><div className="tool-detail-heading"><strong>→ {string(args.to) || string(args.path).replace(/^agent:\/\//, '')}</strong>{messageReceipts(tool).map((receipt, i) => <span className="tool-chip" key={i}>{string(receipt.to)} · {receiptOutcome(receipt, t)}</span>)}</div><Markdown source={string(args.content) || string(args.message)} {...body} /><Literal>{resultText(tool.result)}</Literal></div>;
}
export function WebDetails({ tool, ...body }: DetailProps) {
  const { t } = useTranslation(), [error, setError] = useState('');
  const response = object(object(object(tool.result).details).response), answer = string(response.answer);
  const sources = list(response.sources);
  return <>{answer ? <div className="tool-web-answer"><Markdown source={answer} {...body} /></div> : <Literal>{resultText(tool.result)}</Literal>}<div className="tool-sources">{sources.map((value, index) => {
    const source = object(value), url = string(source.url);
    let host = ''; try { const parsed = new URL(url); if (/^https?:$/.test(parsed.protocol)) host = parsed.hostname; } catch { /* Invalid source URLs stay literal, never navigable. */ }
    const open = () => { if (host) void window.ompDesktop.openExternal(url).catch((cause: unknown) => setError(String(cause))); };
    return <article key={index}>{host ? <a href={url} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); open(); }} onAuxClick={event => { event.preventDefault(); if (event.button === 1) open(); }}>{string(source.title) || url}</a> : <span>{string(source.title) || url}</span>}{host && <span className="tool-source-host">{host}</span>}{string(source.snippet) && <p>{string(source.snippet)}</p>}</article>;
  })}</div>{error && <ErrorBlock text={`${t('tools.linkError')}\n${error}`} />}</>;
}
export function TodoDetails({ tool }: DetailProps) {
  const { t } = useTranslation(), phases = list(object(object(tool.result).details).phases);
  const tasks = phases.flatMap(phase => list(object(phase).tasks)).map(object);
  if (!phases.length) return <Literal>{resultText(tool.result)}</Literal>;
  return <><p className="tool-note">{t('tools.todoProgress', { done: tasks.filter(task => task.status === 'completed').length, total: tasks.length })}</p>{phases.map((value, index) => { const phase = object(value); return <section className="tool-phase" key={index}><h4>{string(phase.name)}</h4><ul>{list(phase.tasks).map((item, i) => { const task = object(item); return <li key={i} className={`status-${string(task.status)}`}><span title={t(`tools.status.${string(task.status)}`)}><StatusIcon status={string(task.status)} /></span><span>{string(task.content)}{string(task.blocker) && <small>{string(task.blocker)}</small>}</span></li>; })}</ul></section>; })}</>;
}
export function AskDetails({ tool }: DetailProps) {
  const { t } = useTranslation(), args = object(tool.args), details = object(object(tool.result).details);
  const results = list(details.results), questions = list(args.questions);
  const receipt = resultText(tool.result).match(/^User (selected|provided custom input):\s*([\s\S]+)$/);
  const legacy = receipt ? { ...args, ...(receipt[1] === 'selected' ? { selectedOptions: [receipt[2].trim()] } : { customInput: receipt[2].trim() }) } : undefined;
  const entries = results.length ? results : legacy ? [legacy] : questions.length ? questions : [args];
  return <>{entries.map((value, index) => {
    const question = object(value), selected = list(question.selectedOptions);
    const options = list(question.options).length ? list(question.options) : list(object(questions[index]).options).length ? list(object(questions[index]).options) : list(args.options);
    const labelOf = (option: unknown) => string(option) || string(object(option).label);
    const choices = selected.map(choice => typeof choice === 'number' ? labelOf(options[choice]) : labelOf(options.find(option => object(option).value === choice) ?? choice)).filter(Boolean);
    const answer = string(question.customInput);
    return <section className="tool-question" key={index}><h4>{string(question.question) || string(question.prompt) || string(object(questions[index]).question) || string(args.question)}</h4>{choices.length > 0 && <p>{t('omp.timeline.askSelected', { value: choices.join('、') })}</p>}{answer && <p>{t('omp.timeline.askAnswered', { value: answer })}</p>}{!choices.length && !answer && <ul>{options.map((option, i) => <li key={i}>{labelOf(option)}</li>)}</ul>}{string(question.note) && <p className="tool-note">{string(question.note)}</p>}{question.timedOut === true && <p className="tool-note">{t('tools.timedOut')}</p>}</section>;
  })}{details.timedOut === true && <p className="tool-note">{t('tools.timedOut')}</p>}{!results.length && !legacy && <Literal>{resultText(tool.result)}</Literal>}</>;
}
