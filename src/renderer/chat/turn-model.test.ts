import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTranscriptEntries, type TurnPart } from './presentation';
import { groupChapterSteps, projectTurn, type TurnProjection } from './turn-model';
import { buildFindSources } from './find-model';
import type { ChatMessage } from './model';
import type { NativeMessage } from '../../shared/contracts';
const row = (id: string, raw: NativeMessage): ChatMessage => ({id,raw,source:'history',streaming:false});
const say = (id: string, value: string) => row(id,{role:'assistant',stopReason:'stop',content:[{type:'text',text:value}]});
const call = (id: string, name: string, args: unknown = {}) => row(id,{role:'assistant',stopReason:'toolUse',content:[{type:'toolCall',id,name,arguments:args}]});
const result = (id: string, name: string, details: unknown = {}) => row(id+'-result',{role:'toolResult',toolCallId:id,toolName:name,content:'done',details});
const delivery = () => row('delivery',{role:'custom',customType:'async-result',display:true,attribution:'agent',content:'job output',details:{jobs:[{jobId:'bg_1',type:'bash'}]}});
const report = '# Report\n\n- Changed the renderer.\n- Verified real behavior.\n';
function project(messages: ChatMessage[]) { const entry=buildTranscriptEntries(messages,{}).entries.find(entry=>entry.kind==='assistant-turn'); assert.ok(entry?.kind==='assistant-turn'); return {entry,p:projectTurn(entry)}; }
const prose = (parts: TurnPart[]) => parts.flatMap(part=>part.kind==='text'?[part.value]:[]).join('');
test('same-message report plus todo remains answer through housekeeping and acknowledgement',()=>{
 const reportRow=row('report',{role:'assistant',stopReason:'toolUse',content:[{type:'text',text:report},{type:'toolCall',id:'todo',name:'todo',arguments:{op:'update'}}]});
 const {p}=project([reportRow,result('todo','todo'),say('ack','Completed.')]);
 assert.equal(prose(p.answer),report);assert.equal(p.answerSource,'report-before-epilogue');assert.deepEqual(p.epilogue.map(x=>x.kind),['housekeeping','reply']);assert.equal(prose(p.epilogue.flatMap(x=>x.parts)),'Completed.');
});
test('hidden reminder and todo never displace the primary report or leak instructions',()=>{
 const {entry,p}=project([say('report',report),row('nudge',{role:'developer',content:'INVISIBLE'}),call('todo','todo'),result('todo','todo'),say('ack','Stopped.')]);
 assert.equal(prose(p.answer),report);assert.ok(entry.parts.some(p=>p.kind==='boundary'&&p.trigger==='reminder'));assert.ok(buildFindSources([entry]).every(s=>!s.text.includes('INVISIBLE')));
});
test('delivery acknowledgement and provoked verification stay epilogue',()=>{
 for(const work of [[],[call('verify','bash'),result('verify','bash')]]) {
 const {p}=project([say('report',report),delivery(),...work,say('41822366','The last result confirms the previous report.')]);
 assert.equal(prose(p.answer),report);assert.equal(p.epilogue[0].kind,'background-result');assert.equal(p.epilogue[0].origin?.jobId,'bg_1');assert.ok(p.epilogue.flatMap(x=>x.parts).some(x=>x.row.id==='41822366'));
 }
});
test('only substantive work plus a full report can supersede a triggered report',()=>{
 for(const first of ['Pending results.',report]) { const {p}=project([say('first',first),delivery(),call('verify','bash'),result('verify','bash'),say('real',report)]);assert.equal(p.answer[0].row.id,'real');assert.equal(p.answerSource,'superseded');assert.ok(p.supersededChapterId);assert.ok(p.chapters.some(c=>prose(c.narration).includes(first))); }
 const {p}=project([say('first',report),delivery(),say('ack','# A structured acknowledgement')]);assert.equal(p.answer[0].row.id,'first');
});
test('length tie-break applies both 600-character floor and one-third ratio, without phrase matching',()=>{
 for(const [length,accepted] of [[599,false],[600,false],[899,false],[900,true]] as const){const {p}=project([say('first','x'.repeat(2700)),delivery(),call('verify','read'),result('verify','read'),say('next','z'.repeat(length))]);assert.equal(p.answer[0].row.id,accepted?'next':'first');}
});
test('wait/jobs recovered completed snapshots trigger epilogues, running snapshots are work',()=>{
 for(const name of ['wait','jobs']) { const {p}=project([say('report',report),call('wait',name),result('wait',name,{jobs:[{id:'child-job',agentUrlId:'Child',type:'task',status:'completed',resultText:'result'}]}),say('ack','Received.')]);assert.equal(p.answer[0].row.id,'report');assert.ok(p.epilogue.some(x=>x.kind==='background-result')); }
});
test('terminal yield exposes native report while incremental yield remains work',()=>{
 const {p}=project([call('section','yield',{type:['section'],data:{report:'incremental'}}),result('section','yield'),call('terminal','yield',{data:{report}}),result('terminal','yield')]);assert.equal(p.answerSource,'yield');assert.equal(p.answer[0].kind,'content');assert.ok(p.chapters.flatMap(c=>c.steps).some(x=>x.kind==='tool'&&x.tool.id==='section'));
});
test('aborted and error outcomes retain partial output and diagnostic visibility',()=>{
 for(const stopReason of ['aborted','error']) {const {p}=project([row('partial',{role:'assistant',content:'Partial output',stopReason,errorMessage:stopReason==='aborted'?'Interrupted by user':'Provider error'})]);assert.equal(prose(p.answer),'Partial output');assert.ok([...p.answer,...p.chapters.flatMap(c=>c.steps)].some(x=>x.kind==='error'));}
});
test('consecutive steering prompts are requests, compaction is not a new request',()=>{
 const messages=[row('q1',{role:'user',content:'First'}),row('q2',{role:'user',steering:true,content:'Second'}),call('read','read'),result('read','read'),row('compact',{role:'compactionSummary',summary:'Context summary'}),say('report',report)];
 const entries=buildTranscriptEntries(messages,{}).entries;assert.equal(entries.filter(x=>x.kind==='assistant-turn').length,1);assert.deepEqual(entries.filter(x=>x.kind==='message').map(x=>x.id),['q1','q2']);
 const entry=entries.find(x=>x.kind==='assistant-turn')!;assert.equal(entry.kind,'assistant-turn');if(entry.kind==='assistant-turn'){const p=projectTurn(entry);assert.equal(prose(p.answer),report);assert.ok(entry.parts.some(x=>x.row.id==='compact'));}
});
test('find reveals narration and tool output through chapters and acknowledgements through epilogue',()=>{
 const {entry,p}=project([row('work',{role:'assistant',content:[{type:'text',text:'Inspect sources.'},{type:'toolCall',id:'read',name:'read'}]}),result('read','read'),say('report',report),delivery(),say('ack','Acknowledged.')]);
 const sources=buildFindSources([entry]);assert.ok(sources.find(s=>s.text.includes('Inspect sources.'))?.reveal.some(s=>s.includes('chapter:')));assert.ok(sources.find(s=>s.text==='Acknowledged.')?.reveal.some(s=>s.includes('epilogue')));assert.equal(p.chapters[0].title,'Inspect sources.');
});
test('compaction stays between work chapters and its summary remains searchable',()=>{
 const {entry,p}=project([call('first','read'),result('first','read'),row('compact',{role:'compactionSummary',summary:'Unique compacted summary'}),say('narration','Next work.'),call('second','read'),result('second','read'),say('report',report)]);
 assert.equal(p.chapters.find(c=>c.boundary)?.boundary?.row.id,'compact');
 const source=buildFindSources([entry]).find(s=>s.text.includes('Unique compacted summary'));assert.ok(source);assert.ok(source.reveal.includes(JSON.stringify(['compact','compact:summary'])));
});
test('an earlier chapter retains running children without stealing current focus',()=>{
 const entries=buildTranscriptEntries([call('spawn','task'),result('spawn','task'),say('next','Inspecting sources.'),call('read','read')],{},[{id:'Child',parentToolCallId:'spawn',status:'running'}]).entries;
 const entry=entries[0];assert.equal(entry.kind,'assistant-turn');if(entry.kind!=='assistant-turn')return;const p=projectTurn(entry);assert.equal(p.chapters[0].summary.agentsRunning,1);assert.equal(p.chapters[0].status,'running');assert.equal(p.chapters.filter(c=>c.current).length,1);assert.equal(p.chapters.at(-1)?.current,true);
});
test('awaited completed-job results never promote same-message waiting narration',()=>{
 const waiting=row('waiting',{role:'assistant',stopReason:'toolUse',content:[{type:'text',text:'Verification is pending.'},{type:'toolCall',id:'wait',name:'wait'}]});
 const recovered=result('wait','wait',{jobs:[{id:'job',type:'bash',status:'completed'}]});
 const interrupted=project([waiting,recovered,call('verify','read'),result('verify','read')]);assert.equal(interrupted.p.answerSource,'none');assert.equal(prose(interrupted.p.chapters.flatMap(c=>c.narration)),'Verification is pending.');
 const completed=project([waiting,recovered,call('verify','read'),result('verify','read'),say('report',report)]);assert.equal(completed.p.answer[0].row.id,'report');
});
test('report absence distinguishes next-prompt continuation from abort and unknown history',()=>{
 const entries=buildTranscriptEntries([call('work','read'),result('work','read'),row('next',{role:'user',steering:true,content:'Change direction'})],{}).entries;const entry=entries[0];assert.equal(entry.kind,'assistant-turn');if(entry.kind!=='assistant-turn')return;assert.equal(projectTurn(entry).noAnswerReason,'continued-by-next-prompt');
 assert.equal(project([row('stop',{role:'assistant',content:[],stopReason:'aborted'})]).p.noAnswerReason,'aborted');
 assert.equal(project([call('work','read')]).p.noAnswerReason,'no-report');
 assert.equal(project([{...call('live','read'),streaming:true}]).p.noAnswerReason,'running');
});
test('retrieving a completed job is not substantive verification that allows supersession',()=>{
 const {p}=project([say('report',report),delivery(),call('wait','wait'),result('wait','wait',{jobs:[{id:'job',type:'bash',status:'completed'}]}),say('ack','# Structured acknowledgement')]);assert.equal(p.answer[0].row.id,'report');
});
test('housekeeping receipt preserves proven call origin for its following reply',()=>{
 const {p}=project([say('report',report),call('todo','todo'),result('todo','todo'),say('ack','Done.')]);assert.equal(p.epilogue.find(item=>item.kind==='reply')?.origin?.toolCallId,'todo');
});
test('prework text plus housekeeping becomes narration as the original work continues',()=>{
 const plan=row('plan',{role:'assistant',stopReason:'toolUse',content:[{type:'text',text:'Establishing the plan.'},{type:'toolCall',id:'plan-call',name:'todo',arguments:{op:'init'}}]});
 const prefix=[plan,result('plan-call','todo'),row('inspect',{role:'assistant',stopReason:'toolUse',content:[{type:'text',text:'Inspecting sources.'},{type:'toolCall',id:'read',name:'read'}]})];
 const {p}=project(prefix);assert.equal(p.answerSource,'none');assert.deepEqual(p.chapters.map(c=>c.title),['Establishing the plan.','Inspecting sources.']);assert.equal(p.chapters.at(-1)?.current,true);
 const settled=project([...prefix,result('read','read'),say('report',report)]).p;assert.equal(settled.answer[0].row.id,'report');
});
test('successful retry resolves chapter issues across chapters without erasing failed steps',()=>{
 const failed=row('failed-result',{role:'toolResult',toolCallId:'failed',toolName:'bash',isError:true,content:'Compilation failed'});
 const prefix=[say('first','Checking the build.'),call('failed','bash',{command:'npm test',cwd:'/workspace',i:'Checking tests'}),failed,say('retry','Retrying after correction.'),call('retry','bash',{cwd:'/workspace',i:'Rechecking tests',command:'npm test'})];
 const {p}=project([...prefix,result('retry','bash'),say('report',report)]);
 assert.equal(p.chapters.reduce((count,c)=>count+c.summary.issues,0),0);assert.ok(p.chapters.flatMap(c=>c.steps).some(p=>p.kind==='tool'&&p.tool.id==='failed'&&p.tool.status==='error'));
 const different=project([...prefix.slice(0,-1),call('other','bash',{command:'npm test',cwd:'/elsewhere'}),result('other','bash'),row('error',{role:'assistant',stopReason:'error',errorMessage:'Cannot complete the task'})]).p;assert.equal(different.chapters.reduce((count,c)=>count+c.summary.issues,0),1);
});
test('parallel success and neutral skips do not resolve an earlier failed action',()=>{
 const calls=row('parallel',{role:'assistant',stopReason:'toolUse',content:[{type:'toolCall',id:'failed',name:'bash',arguments:{command:'npm test'}},{type:'toolCall',id:'passed',name:'bash',arguments:{command:'npm test'}}]});
 const failed=row('failed-result',{role:'toolResult',toolCallId:'failed',toolName:'bash',isError:true,content:'Compilation failed'});
 const parallel=project([calls,failed,result('passed','bash'),row('error',{role:'assistant',stopReason:'error',errorMessage:'Cannot complete the task'})]).p;assert.equal(parallel.chapters.reduce((n,c)=>n+c.summary.issues,0),1);
 const skipped=row('skip-result',{role:'toolResult',toolCallId:'skip',toolName:'bash',isError:true,content:'Skipped due to a queued background completion.'});
 const retry=project([call('failed','bash',{command:'npm test'}),failed,call('skip','bash',{command:'npm test'}),skipped,row('error',{role:'assistant',stopReason:'error',errorMessage:'Cannot complete the task'})]).p;assert.equal(retry.chapters.reduce((n,c)=>n+c.summary.issues,0),1);
});
test('leading thinking joins the first narrated chapter with every reasoning anchor preserved',()=>{
 const thought=row('thought',{role:'assistant',content:[{type:'thinking',thinking:'Inspect the inputs.'}]});
 const {entry,p}=project([thought,say('narration','Reading sources.'),call('read','read',{path:'src/main.ts'}),result('read','read'),say('report',report)]);assert.equal(p.chapters.length,1);assert.equal(p.chapters[0].title,'Reading sources.');assert.ok(p.chapters[0].steps.some(part=>part.kind==='thinking'&&part.row.id==='thought'));assert.ok(buildFindSources([entry]).some(source=>source.text.includes('Inspect the inputs.')&&source.reveal.some(path=>path.includes('chapter:'))));
});
test('completed and user-stopped outcomes never retain actionable tool issues', () => {
 for (const stopReason of ['stop', 'aborted']) {
  const {p}=project([call('bad','bash',{command:'exit 7'}),row('bad-result',{role:'toolResult',toolCallId:'bad',toolName:'bash',isError:true,content:'exit 7'}),row('finish',{role:'assistant',stopReason,content:stopReason==='stop'?'Expected negative check completed.':''})]);
  assert.equal(p.chapters.reduce((sum,chapter)=>sum+chapter.summary.issues,0),0);
 }
});
test('only runs of five successful same-kind inspections fold and preserve order', () => {
 const make=(id:string,name:string,status:'complete'|'error'='complete'):TurnPart=>({kind:'tool',key:id,row:call(id,name),tool:{id,name,status}});
 const parts=[...Array.from({length:4},(_,i)=>make(`short${i}`,'read')),make('break','bash'),...Array.from({length:5},(_,i)=>make(`long${i}`,'read')),make('failed','read','error'),...Array.from({length:5},(_,i)=>make(`search${i}`,'grep'))];
 const groups=groupChapterSteps(parts);
 assert.deepEqual(groups.map(group=>group.length),[1,1,1,1,1,5,1,5]);
 assert.deepEqual(groups.flat(),parts);
});
test('successful terminal yield resolves expected negative checks without erasing evidence', () => {
 const failed=row('bad-result',{role:'toolResult',toolCallId:'bad',toolName:'bash',isError:true,content:'exit 7'});
 const {p}=project([call('bad','bash',{command:'exit 7'}),failed,call('report','yield',{data:{report:'Expected negative check observed.',expectedFailure:true}}),result('report','yield')]);
 assert.equal(p.chapters.reduce((sum,chapter)=>sum+chapter.summary.issues,0),0);
 assert.ok(p.chapters.flatMap(chapter=>chapter.steps).some(part=>part.kind==='tool'&&part.tool.status==='error'));
});
test('live narration and housekeeping remain process until the report settles', () => {
 const narration=row('intro',{role:'assistant',stopReason:'toolUse',content:[{type:'text',text:'Establishing the plan.'},{type:'toolCall',id:'todo',name:'todo',arguments:{op:'init'}}]});
 const initial=project([narration]);
 for (const entry of [initial.entry,project([narration,result('todo','todo'),call('read','read'),result('read','read')]).entry]) {
  const live=projectTurn(entry,true);
  assert.equal(live.answer.length,0); assert.equal(live.epilogue.length,0);
  assert.ok(live.chapters.some(chapter=>prose(chapter.narration)==='Establishing the plan.'));
 }
 const entry=project([narration,result('todo','todo'),call('read','read'),result('read','read'),{...say('report',report),streaming:true}]).entry;
 const live=projectTurn(entry,true);assert.equal(prose(live.liveTail),report);assert.equal(live.answer.length,0);assert.equal(live.epilogue.length,0);
 assert.equal(prose(projectTurn(entry,false).answer),report);
});
test('reasoning survives answer selection, live settlement and saved re-projection', () => {
 const content=[{type:'thinking',thinking:'First reason.'},{type:'thinking',thinking:'Second reason.'},{type:'text',text:'Answer'}];
 const saved=project([row('a',{role:'assistant',content,stopReason:'stop'})]);
 const live=project([{...row('a',{role:'assistant',content,stopReason:'stop'}),source:'live',streaming:true}]);
 const reasoning=(p:TurnProjection)=>p.chapters.flatMap(c=>c.steps).filter(p=>p.kind==='thinking').map(p=>({value:p.value,redacted:p.redacted}));
 assert.deepEqual(reasoning(saved.p),[{value:'First reason.\n\nSecond reason.',redacted:false}]);
 assert.deepEqual(reasoning(live.p),reasoning(saved.p));
 assert.deepEqual(reasoning(projectTurn(live.entry,false)),reasoning(saved.p));
 assert.equal(prose(saved.p.answer),'Answer');
 assert.equal(saved.p.chapters.flatMap(c=>c.steps).filter(p=>p.kind==='tool').length,0);
});
test('opaque and empty native reasoning retain a redacted marker without exposing signatures', () => {
 for(const block of [{type:'thinking',thinking:'',thinkingSignature:'SECRET'},{type:'redactedThinking',data:'SECRET'},{type:'thinking',thinking:''}]) {
  const {p}=project([row('a',{role:'assistant',content:[block,{type:'text',text:'Answer'}]})]);
  const reasoning=p.chapters.flatMap(c=>c.steps).filter(p=>p.kind==='thinking');
  assert.deepEqual(reasoning.map(p=>({value:p.value,redacted:p.redacted})),[{value:'',redacted:true}]);
  assert.equal(prose(p.answer),'Answer');
 }
});
test('mixed readable and hidden reasoning preserve native order, and absent reasoning creates no process', () => {
 const {p}=project([row('a',{role:'assistant',content:[{type:'thinking',thinking:'Before'},{type:'thinking',thinking:''},{type:'thinking',thinking:'After'},{type:'text',text:'Answer'}]})]);
 assert.deepEqual(p.chapters.flatMap(c=>c.steps).map(p=>p.kind==='thinking'?[p.value,p.redacted]:p.kind),[['Before',false],['',true],['After',false]]);
 assert.deepEqual(project([say('a','Answer')]).p.chapters,[]);
});
test('reasoning interleaved after answer text remains in the process disclosure', () => {
 const {p}=project([row('a',{role:'assistant',content:[{type:'text',text:'Answer'},{type:'thinking',thinking:'Retained reason'}]})]);
 assert.deepEqual(p.chapters.flatMap(c=>c.steps).filter(p=>p.kind==='thinking').map(p=>p.value),['Retained reason']);
 assert.deepEqual(p.epilogue,[]);
});
