import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Sandbox } from './control.mjs';
import { sleep, until } from './cdp.mjs';
import { installProbe, snapshot } from './probe.mjs';
import { translations } from './locale.mjs';
import { ui, attribute } from './contracts.mjs';
import { startPaintedCapture, assertPaintedFollow, installChapterMotion } from './painted-follow.mjs';
import { formatElapsed } from '../src/renderer/lib/format-duration.ts';
const args=process.argv.slice(2).filter(a=>a!=='--');const option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1]};
const size=option('--size','1440x900').split('x').map(Number);if(size.length!==2||size.some(n=>!Number.isInteger(n)||n<600))throw new Error('Invalid --size');
const locale=option('--locale','zh-CN');
const app=resolve(option('--app',new URL('..',import.meta.url).pathname));
const t=await translations(locale);
const out=resolve(option('--out',`/tmp/E2EHarness-evidence/${Date.now()}-${size.join('x')}`));mkdirSync(out,{recursive:true});
const ports={fixture:Number(option('--fixture-port','19750')),cdp:Number(option('--cdp-port','19751'))};
const selected=option('--scenario','all');const results=[];let box,c,current;const started=Date.now();
const json=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2));
const text=()=>c.eval('document.body.innerText');
const visible=selector=>c.eval(`Boolean([...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getBoundingClientRect().width&&!e.disabled))`);
const action=(key,selector)=>c.clickName(t(key),selector);
const stopSelector='button'+attribute('aria-label',t('chat.stopGenerating'));
const check=(name,pass,actual)=>{current.assertions.push({name,pass:!!pass,actual});};
async function shot(label){const path=`${out}/${current.name}-${label}.png`;await c.shot(path);json(path.replace('.png','.json'),await c.eval(snapshot));current.evidence.push(path);}
async function ready(){await until(()=>visible(ui.editor),'editable composer');await until(async()=>/Local scripted live fixture/.test(await c.eval(`document.querySelector('${ui.model}')?.innerText||''`))&&await visible(ui.model),'real model ready',45000);}
async function send(prompt,double=false){await c.click(ui.editor);await c.call('Input.insertText',{text:prompt});await c.key();if(double)await c.key();}
async function complete(marker='E2E_ANSWER_COMPLETE',timeout=90000,count=1){await until(async()=>await c.eval(`(document.querySelector('.thread-scroll')?.innerText.split(${JSON.stringify(marker)}).length-1)>=${count}`)&&!await visible(stopSelector),`completion ${marker}`,timeout);}
async function fresh(){await action('omp.shell.newSession','.sidebar button');await ready();}
async function simple(){await ready();await send('E2E_SIMPLE: Describe this workspace.');await complete();}
async function menu(){await action('nav.sessionActions',ui.activeRow+' button');await until(()=>visible('[role=menuitem]'),'session actions');}
async function openSaved(){const recorded=await c.eval(`document.querySelector('.composer-model-thinking-model')?.textContent`);await menu();await action('sidebar.disconnectSession','[role=menuitem]');await until(()=>visible('[data-state=disconnected]'),'native disconnect');await c.click('.thread-item button[aria-current=page]');await until(async()=>await c.eval(`document.querySelector('.composer-model-thinking-model')?.textContent===${JSON.stringify(recorded)}`)&&!await visible('[data-state=disconnected]'),'saved recorded model');check('recorded model selection preserved',await c.eval(`document.querySelector('.composer-model-thinking-model')?.textContent===${JSON.stringify(recorded)}`),recorded);}
async function performance(){const p=await c.eval('window.__e2e');if(!p)return;const painted=await c.eval('window.__e2ePaint ? {samples:window.__e2ePaint.samples,checkpoints:window.__e2ePaint.checkpoints,attachedAt:window.__e2ePaint.attachedAt} : null');const frames=p.frames.slice().sort((a,b)=>a-b);const p95=frames[Math.floor(frames.length*.95)]??null;current.metrics={rafP95:p95,frameCount:frames.length,longTasks:p.longTasks,followGapMax:painted?.samples.length?Math.max(...painted.samples.map(g=>g.gap)):null,prePinGapMax:p.gaps.length?Math.max(...p.gaps.map(g=>g.gap)):null};if(frames.length)check('streaming rAF p95 < 20 ms',p95<20,p95);check('no interaction long task > 100 ms',p.longTasks.every(t=>t.duration<=100),p.longTasks);current.warnings=p.longTasks.filter(t=>t.duration>=50&&t.duration<=100);json(`${out}/${current.name}-measurements.json`,{...p,prePinGaps:p.gaps,gaps:painted?.samples??[],painted});}
const scenarios={
  'cold-launch':async()=>{await ready();await shot('home');check('real model displayed',(await text()).includes('Local scripted live fixture'));check('home editor ready',await visible('.composer-input'));},
  'find-immediate':async()=>{
    await simple();
    await c.call('Input.dispatchKeyEvent',{type:'keyDown',key:'f',code:'KeyF',modifiers:4,windowsVirtualKeyCode:70});
    await c.call('Input.insertText',{text:'isolated workspace'});
    await c.call('Input.dispatchKeyEvent',{type:'keyUp',key:'f',code:'KeyF',modifiers:4,windowsVirtualKeyCode:70});
    check('immediate typing reaches find input',await c.eval(`document.activeElement===document.querySelector('.transcript-find input')&&document.querySelector('.transcript-find input')?.value==='isolated workspace'`));
    await until(()=>c.eval(`document.querySelector('.transcript-find output')?.textContent.replace(/\\s/g,'')==='1/1'`),'exact find match count');
    check('find shows one native answer match',await c.eval(`document.querySelector('.transcript-find output')?.textContent.replace(/\\s/g,'')==='1/1'`));
    await shot('matched');
  },
  'immediate-enter':async()=>{await ready();await c.eval(`Object.assign(window.__e2e,{tracking:true,prompt:'E2E_IMMEDIATE: One request only.'})`);await send('E2E_IMMEDIATE: One request only.',true);await shot('accepted');await complete();await sleep(500);await c.eval('window.__e2e.tracking=false');const p=await c.eval('window.__e2e.acceptance');const first=p.find(f=>f.accepted);const sameProject=f=>f.project?.replace('/private/tmp/','/tmp/')===box.workspace.replace('/private/tmp/','/tmp/');check('row under project in acceptance frame',first?.rows===1&&sameProject(first),first);const positioned=p.filter(f=>f.accepted);check('row never relocates',positioned.length>0&&positioned.every(f=>f.rows===1&&sameProject(f)&&f.rect&&first.rect&&Math.abs(f.rect.y-first.rect.y)<=1),positioned.filter(f=>!f.rect||f.rect.y!==first?.rect?.y));const health=await(await fetch(`http://127.0.0.1:${ports.fixture}/health`)).json();check('exactly one model submission',health.counts.Simple===1,health.counts);await shot('completed');},
  'live-follow':async()=>{
    const transcriptWheelPoint=async label=>{
      const hit=await c.eval(`(()=>{const scroll=document.querySelector('.thread-scroll'),content=scroll?.querySelector('.thread-content');if(!scroll||!content)throw new Error('Native wheel target unavailable: transcript is not mounted');const s=scroll.getBoundingClientRect(),r=content.getBoundingClientRect(),left=Math.max(0,s.left,r.left),right=Math.min(innerWidth,s.right,r.right),top=Math.max(0,s.top,r.top),bottom=Math.min(innerHeight,s.bottom,r.bottom);if(right<=left||bottom<=top)throw new Error('Native wheel target unavailable: transcript content has no visible area');const x=(left+right)/2,y=(top+bottom)/2,target=document.elementFromPoint(x,y);if(target?.closest('.thread-scroll')!==scroll||!target.closest('.thread-content')||target.closest('pre,textarea,.native-tool-details,.thinking-viewport'))throw new Error('Native wheel target blocked at '+JSON.stringify({x,y,target:target?.tagName,className:target?.className}));return {x,y,target:target.tagName,className:target.className};})()`);
      (current.wheelTargets??=[]).push({label,...hit});json(`${out}/${current.name}-wheel-targets.json`,current.wheelTargets);
      return {x:hit.x,y:hit.y};
    };
    const wheel=async(point,deltaY)=>{
      await c.eval(`(()=>{const target=document.elementFromPoint(${point.x},${point.y});if(!target?.closest('.thread-scroll')||!target.closest('.thread-content')||target.closest('pre,textarea,.native-tool-details,.thinking-viewport'))throw new Error('Native wheel target left transcript content at '+JSON.stringify({x:${point.x},y:${point.y},target:target?.tagName,className:target?.className}));})()`);
      await c.call('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaY,deltaX:0});
    };
    await ready();await c.eval(installChapterMotion);await send('LIVE_FIXTURE_SCENARIO: Review this workspace with three subagents and a final report.');await until(()=>visible('[data-live-turn-header]'),'inline live header');
    await c.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const finishCapture=await startPaintedCapture(c,`${out}/${current.name}`);
    try {
      await shot('running');
      await until(async()=>(await text()).includes('Report section 5'),'long report',120000);
      const chapters=await c.eval('window.__chapterMotion.transitions.filter(row=>row.following&&row.wasOpen&&(row.interactionAge===null||row.interactionAge>200))');
      check('following chapter auto-collapse within 400 ms',chapters.length>0&&chapters.every(row=>row.closedAt!==null&&row.closedAt-row.at<=400),chapters);
      await until(()=>visible(ui.live),'floating status after header leaves viewport');
      check('out of view header hands off to bottom status',await c.eval(`(()=>{const h=document.querySelector('[data-live-turn-header]').getBoundingClientRect(),v=document.querySelector('.thread-scroll').getBoundingClientRect(),s=document.querySelector(${JSON.stringify(ui.live)}).getBoundingClientRect(),e=document.querySelector(${JSON.stringify(ui.editor)}).getBoundingClientRect();return h.bottom<=v.top&&s.y>innerHeight/2&&s.bottom<=e.y&&s.x>=0&&s.right<=innerWidth})()`));
      const layout=await c.eval(`(()=>{const row=document.querySelector(${JSON.stringify(ui.live)}),dock=document.querySelector('.composer-dock'),scroll=document.querySelector('.thread-scroll');const shown={composerTop:dock.getBoundingClientRect().top,transcriptHeight:scroll.clientHeight};row.style.display='none';const hidden={composerTop:dock.getBoundingClientRect().top,transcriptHeight:scroll.clientHeight};row.style.removeProperty('display');return {shown,hidden}})()`);
      check('floating status causes no layout shift',layout.shown.composerTop===layout.hidden.composerTop&&layout.shown.transcriptHeight===layout.hidden.transcriptHeight,layout);
      const following=await c.eval("window.__e2ePaint.checkpoint('following')");check('painted follow gap <= 64 px',following.gap<=64,following);await shot('following');
      await wheel(await transcriptWheelPoint('reading'),-650);await sleep(250);check('wheel up leaves follow mode',await c.eval(`document.querySelector('.thread-wrap')?.dataset.following==='false'`));await shot('reading');
      await c.eval("window.__e2ePaint.checkpoint('before-status-return')");await c.click(ui.liveAction);await sleep(350);
      const returned=await c.eval("window.__e2ePaint.checkpoint('status-return')");check('status click resumes following',returned.following,returned);await shot('returned');
      await until(async()=>(await text()).includes('Report section 27'),'late report',120000);
      const wheelPoint=await transcriptWheelPoint('process-collapse');
      await wheel(wheelPoint,-350);
      const pendingWheels=new Set();
      let wheelError;
      const wheelTimer=setInterval(()=>{const task=wheel(wheelPoint,-20).catch(error=>{wheelError=error;});pendingWheels.add(task);void task.finally(()=>pendingWheels.delete(task));},20);
      try {
        await complete('E2E_REPORT_COMPLETE',120000);await sleep(200);
        const protectedProcess=await c.eval('window.__chapterMotion.process');
        check('automatic process collapse waits for user scrolling',protectedProcess?.heldOpen&&protectedProcess.closedAt===null,protectedProcess);
      } finally {clearInterval(wheelTimer);await Promise.all(pendingWheels);await c.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');}
      if(wheelError)throw wheelError;
      await until(()=>c.eval('window.__chapterMotion.process?.closedAt!==null'),'process collapse after wheel release',2000);
      const motionTrace=await c.eval('({transitions:window.__chapterMotion.transitions,flips:window.__chapterMotion.flips,process:window.__chapterMotion.process,lastInput:window.__chapterMotion.lastInput,scrolls:window.__chapterMotion.scrolls})');
      check('automatic process collapse resumes within 400 ms after user scroll',motionTrace.process.closedAt-motionTrace.lastInput<=400,motionTrace);
      json(`${out}/${current.name}-chapter-motion.json`,motionTrace);
      await action('chat.scrollToBottom','button');await sleep(350);
      await complete('E2E_REPORT_COMPLETE',120000);await c.eval("window.__e2ePaint.checkpoint('completed')");await shot('report');
      const h=await(await fetch(`http://127.0.0.1:${ports.fixture}/health`)).json();check('three subagents completed',h.finished.length===3,h.finished);check('failing bash recorded',box.journals().some(p=>readFileSync(p,'utf8').includes('Expected fixture failure')));
      await assertPaintedFollow(c,check);
    } finally {await c.eval('window.__chapterMotion.stop()');current.paintedCapture=await finishCapture();if(current.paintedCapture.screenshot)current.evidence.push(current.paintedCapture.screenshot);}
  },
  'minimap-follow':async()=>{
    const markerState=()=>c.eval(`(()=>{const markers=[...document.querySelectorAll('.minimap-marker')],s=document.querySelector('.thread-scroll');return {count:markers.length,active:markers.findIndex(e=>e.getAttribute('aria-current')==='true'),following:document.querySelector('.thread-wrap')?.dataset.following==='true',gap:s.scrollHeight-s.clientHeight-s.scrollTop,top:s.scrollTop,height:s.scrollHeight,viewport:s.clientHeight}})()`);
    const latest=async label=>{const painted=await c.eval(`window.__e2ePaint.checkpoint(${JSON.stringify(label)})`);const state=await markerState();check(label+' newest marker',state.count>=6&&state.active===state.count-1,state);check(label+' following',state.following&&painted.gap<=64,{...state,painted});await shot(label);};
    const wheelTop=async()=>{const r=await c.eval(`(()=>{const s=document.querySelector('.thread-scroll'),r=s.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,deltaY:-s.scrollHeight,deltaX:0}})()`);await c.call('Input.dispatchMouseEvent',{type:'mouseWheel',...r});await until(()=>c.eval(`document.querySelector('.thread-scroll').scrollTop<=1`),'top of transcript');await sleep(200);};
    const returnLatest=async()=>{await action('chat.scrollToBottom','button');await sleep(350);};
    await ready();
    for(let turn=1;turn<=2;turn++){await send('E2E_SLOW: Minimap turn '+turn);await complete('E2E_ANSWER_COMPLETE',90000,turn);}
    await send('E2E_SLOW: Minimap turn 3');await until(()=>visible('[data-live-turn-header]'),'third reply running');
    const finishCapture=await startPaintedCapture(c,`${out}/${current.name}`);
    try {
      await until(()=>c.eval(`document.querySelectorAll('.assistant-turn').length>=3&&document.querySelectorAll('.assistant-turn')[2].innerText.includes('Check 5')`),'third reply streaming');
      check('third reply still streaming',await visible(stopSelector));await latest('streaming-bottom');
      await complete('E2E_ANSWER_COMPLETE',90000,3);await latest('idle-bottom');
      await wheelTop();const top=await markerState();check('top selects first marker',top.active===0&&!top.following,top);await shot('top');
      await returnLatest();await latest('returned');
      await wheelTop();await c.click('.minimap-marker:last-child');await sleep(350);await latest('last-marker-return');
      await c.call('Input.dispatchKeyEvent',{type:'keyDown',key:'f',code:'KeyF',modifiers:4,windowsVirtualKeyCode:70});
      await c.call('Input.dispatchKeyEvent',{type:'keyUp',key:'f',code:'KeyF',modifiers:4,windowsVirtualKeyCode:70});
      await until(()=>visible('.transcript-find input'),'find open');await c.key('Escape');await latest('find-closed');
      await openSaved();await until(()=>visible(ui.editor),'saved editor');await latest('saved-bottom');
      await send('E2E_SLOW: Minimap saved continuation');await until(()=>visible('[data-live-turn-header]'),'saved reply running');
      await until(()=>c.eval(`document.querySelectorAll('.minimap-marker').length===8`),'saved reply marker');await latest('saved-streaming');
      await complete('E2E_ANSWER_COMPLETE',90000,4);await latest('saved-complete');
      await assertPaintedFollow(c,check);
    } finally {current.paintedCapture=await finishCapture();if(current.paintedCapture.screenshot)current.evidence.push(current.paintedCapture.screenshot);}
  },
  completion:async()=>{await simple();await shot('answer');const body=await text();check('answer present',body.includes('The isolated workspace is ready.'));check('composer present',await visible('.composer-input'));check('no raw technical text',!/(injected|woken|Waiting for|Error invoking remote method|Default view follows|ENOENT|undefined|NaN|\[object Object\])/.test(body),body.match(/injected|woken|Waiting for|Error invoking remote method|Default view follows|ENOENT|undefined|NaN|\[object Object\]/g));},
  concurrent:async()=>{await ready();await send('E2E_SLOW: First parallel conversation.');await until(()=>visible('.thread-item'),'first row');await fresh();await send('E2E_SLOW: Second parallel conversation.');await until(async()=>await c.eval(`document.querySelectorAll('.thread-item').length===2`),'second row');check('two concurrent running rows',await c.eval(`document.querySelectorAll('.thread-item-status.running').length===2`));await shot('second');await c.click('.thread-item:not(.active) .thread-item-main');await until(async()=>(await text()).includes('First parallel conversation.'),'switch to first');await shot('first');await c.click('.thread-item:not(.active) .thread-item-main');await until(async()=>(await text()).includes('Second parallel conversation.'),'switch to second');await complete();await shot('finished');},
  'saved-idle':async()=>{await simple();await openSaved();await until(()=>visible(ui.editor),'saved idle editor');await shot('opened');await send('E2E_RESUME: Continue this saved session.',true);await complete('E2E_ANSWER_COMPLETE',90000,2);await sleep(500);const h=await(await fetch(`http://127.0.0.1:${ports.fixture}/health`)).json();check('resume exactly once',h.counts.Simple===2,h.counts);await shot('resumed');},
  thinking:async()=>{await ready();await c.click(ui.model);await until(()=>visible('[role=dialog]'),'reasoning menu');await shot('levels');for(const level of ['low','high','max']){const label=t('composer.thinking.'+level);if(!await c.eval(`!![...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.trim()===${JSON.stringify(label)})`)){check(`${level} available`,false);continue;}const latency=await c.eval(`new Promise(resolve=>{const b=[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});const start=performance.now();b.click();const tick=()=>{if(document.querySelector('.composer-model-thinking-level')?.textContent.includes(${JSON.stringify(label)}))resolve(performance.now()-start);else if(performance.now()-start>3000)resolve(performance.now()-start);else requestAnimationFrame(tick)};tick()})`);check(`${level} label updates < 100 ms`,latency<100,latency);await sleep(300);await shot(level);if(!await visible('[role=dialog]')){await c.click(ui.model);await until(()=>visible('[role=dialog]'),'reasoning menu reopened');}}check('no thinking error',!/(Invalid thinking|Error invoking remote method)/.test(await text()));},
  'thinking-live':async()=>{
    await ready();await send('E2E_THINKING_LIVE: 请逐项思考，再简短回答。');
    await until(()=>visible('[data-thinking-live] .thinking-viewport'),'live reasoning viewport');
    await c.eval(`(()=>{const samples=[],sentinel=document.createElement('div');sentinel.style.cssText='position:fixed;left:-10px;top:-10px;width:1px;height:1px;contain:strict;pointer-events:none';document.body.append(sentinel);let size=1,frame;window.__thinkingMotion={samples};const sample=()=>{const row=document.querySelector('.timeline-thinking'),box=row?.querySelector('.thinking-viewport'),page=document.querySelector('.thread-scroll');if(box&&row.dataset.thinkingLive){const style=getComputedStyle(box),prose=box.querySelector('.prose-chat'),walker=document.createTreeWalker(prose,NodeFilter.SHOW_TEXT);let last;for(let node=walker.nextNode();node;node=walker.nextNode())if(node.textContent.trim())last=node;const range=document.createRange();if(last)range.selectNodeContents(last);const newestBottom=last?[...range.getClientRects()].at(-1)?.bottom:null,viewportBottom=box.getBoundingClientRect().top+box.clientTop+box.clientHeight,paddingBottom=parseFloat(style.paddingBottom);samples.push({at:performance.now(),height:box.clientHeight,top:box.scrollTop,gap:Math.max(0,box.scrollHeight-box.clientHeight-box.scrollTop),pageTop:page.scrollTop,expanded:row.querySelector('button').getAttribute('aria-expanded'),mask:style.maskImage,font:prose&&getComputedStyle(prose).fontSize,line:prose&&getComputedStyle(prose).lineHeight,paddingBottom,newestBottom,viewportBottom,contentBottom:viewportBottom-paddingBottom});}};const observer=new ResizeObserver(sample);observer.observe(sentinel);const tick=()=>{sentinel.style.width=(size=size===1?2:1)+'px';frame=requestAnimationFrame(tick);};window.__thinkingMotion.stop=()=>{cancelAnimationFrame(frame);observer.disconnect();sentinel.remove();};tick();})()`);
    await sleep(300);await shot('live-expanded');
    check('readable live reasoning auto expands',await c.eval(`document.querySelector('.timeline-thinking button')?.getAttribute('aria-expanded')==='true'`));
    check('live header has title without duration',await c.eval(`document.querySelector('.timeline-thinking button')?.innerText.includes('核对推理依据')&&!document.querySelector('.thinking-duration')`));
    await until(()=>c.eval(`document.querySelector('.thinking-viewport')?.scrollTop>28`),'full reasoning viewport');
    await sleep(400);await shot('full-top-fade');
    await c.eval(`(()=>{const durations=[];window.__thinkingTitleDurations=durations;const tick=()=>{const title=document.querySelector('[data-thinking-live] .timeline-thinking-preview');if(!title)return;for(const animation of title.getAnimations({subtree:true}))durations.push(animation.effect.getTiming().duration);requestAnimationFrame(tick);};tick();})()`);
    await until(()=>visible('.assistant-turn-live-tail'),'answer starts',60000);
    const answerAt=Date.now();await until(()=>c.eval(`document.querySelector('.timeline-thinking button')?.getAttribute('aria-expanded')==='false'`),'reasoning auto collapse',900);
    const collapseDelay=Date.now()-answerAt;check('reasoning collapses within 900 ms',collapseDelay<=900,collapseDelay);
    const titleDurations=await c.eval('window.__thinkingTitleDurations');check('title changes crossfade over 120 ms',titleDurations.includes(120)&&titleDurations.every(value=>value===120),titleDurations);
    check('latest summary heading replaces prior heading',await c.eval(`document.querySelector('.timeline-thinking button')?.innerText.includes('整理最终结论')`));
    const collapseMotion=await c.eval(`document.querySelector('.timeline-thinking > .ui-collapse')?.getAnimations().map(animation=>animation.effect.getTiming().duration)`);check('automatic disclosure uses 180 ms motion',collapseMotion?.includes(180),collapseMotion);
    await shot('auto-collapsed');
    await c.eval('window.__thinkingMotion.stop()');
    const samples=await c.eval('window.__thinkingMotion.samples');json(`${out}/thinking-live-frames.json`,samples);
    const full=samples.filter(s=>s.height>=168&&s.top>28);const stable=full.filter(s=>s.at>=full[0]?.at+400);
    check('live body stays at most 168 px',samples.length>0&&samples.every(s=>s.height<=170),Math.max(...samples.map(s=>s.height)));
    check('inner painted gap at most 12 px',full.length>0&&full.every(s=>s.gap<=12),Math.max(...full.map(s=>s.gap)));
    check('live viewport reserves 12 px inside 168 px',samples.every(s=>s.paddingBottom===12&&s.height<=168));
    check('newest reasoning line stays inside visible scrollport',full.length>0&&full.every(s=>s.newestBottom!==null&&s.newestBottom<=s.viewportBottom),Math.min(...full.map(s=>s.viewportBottom-s.newestBottom)));
    const movement=Math.max(...stable.map(s=>s.pageTop))-Math.min(...stable.map(s=>s.pageTop));check('outer page stays still after viewport fills',stable.length>0&&movement<=1,movement);
    check('top fade only after inner scroll',full.every(s=>s.mask.includes('28px')),full[0]);
    check('reasoning uses 13 px and 1.6 line height',samples.every(s=>s.font==='13px'&&Math.abs(parseFloat(s.line)-20.8)<0.1),samples[0]);
    await complete();await sleep(300);await shot('settled-collapsed');
    const settled=await c.eval(`({expanded:document.querySelector('.timeline-toggle')?.getAttribute('aria-expanded'),text:document.querySelector('.timeline-header')?.innerText})`);
    const elapsedSeconds=Number(settled.text?.match(/\d+/)?.[0]);
    check('settled thought row collapsed with duration',settled.expanded==='false'&&elapsedSeconds>0&&settled.text?.trim()===t('omp.timeline.thought',{duration:formatElapsed(elapsedSeconds*1000,'units',locale)}),settled);
    check('fixture renders the answer heading once',await c.eval(`[...document.querySelectorAll('.assistant-turn-response h1')].filter(node=>node.textContent==='Local answer').length===1`));
    await c.click('.timeline-toggle');await sleep(250);await shot('settled-expanded');
    check('settled expansion is complete natural height',await c.eval(`(()=>{const body=document.querySelector('.timeline-body');return body.innerText.includes('第28项')&&!body.querySelector('.thinking-viewport')&&body.scrollHeight>168})()`));
    await fresh();await send('E2E_THINKING_LIVE: 保持手动折叠。');await until(()=>visible('[data-thinking-live] .thinking-viewport'),'second live reasoning');
    await until(()=>c.eval(`document.querySelector('.thinking-viewport')?.scrollTop>100`),'inner overflow before reader scroll');
    await c.eval(`(()=>{const e=document.querySelector('.thinking-viewport');window.__thinkingScroll=[];for(const type of ['wheel','scroll','scrollend'])e.addEventListener(type,event=>window.__thinkingScroll.push({at:performance.now(),type,deltaY:event.deltaY,top:e.scrollTop,height:e.scrollHeight,viewport:e.clientHeight,gap:e.scrollHeight-e.clientHeight-e.scrollTop}),{capture:true,passive:true});})()`);
    const wheel=await c.eval(`(()=>{const r=document.querySelector('.thinking-viewport').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,deltaY:-80,deltaX:0}})()`);
    await c.call('Input.dispatchMouseEvent',{type:'mouseWheel',...wheel});await sleep(200);
    const pausedTop=await c.eval(`document.querySelector('.thinking-viewport').scrollTop`);await sleep(500);
    check('inner user scroll pauses following',await c.eval(`document.querySelector('.thinking-viewport').scrollTop`)===pausedTop,pausedTop);
    await c.call('Input.dispatchMouseEvent',{type:'mouseWheel',...wheel,deltaY:10000});await sleep(500);
    const resumedGap=await c.eval(`new Promise(resolve=>{const e=document.querySelector('.thinking-viewport'),sentinel=document.createElement('div');sentinel.style.cssText='position:fixed;left:-10px;top:-10px;width:1px;height:1px;contain:strict';document.body.append(sentinel);const observer=new ResizeObserver(()=>{const gap=e.scrollHeight-e.clientHeight-e.scrollTop;observer.disconnect();sentinel.remove();resolve(gap);});observer.observe(sentinel);})`);
    check('inner follow resumes within eight pixels of bottom',resumedGap<=12,resumedGap);
    json(`${out}/thinking-live-scroll-intent.json`,await c.eval('window.__thinkingScroll'));
    await c.click('.timeline-thinking > button');await sleep(1200);
    check('manual live collapse persists through new tokens',await c.eval(`document.querySelector('[data-thinking-live] > button')?.getAttribute('aria-expanded')==='false'`));
    await complete();
    await sleep(300);check('manual reasoning collapse survives settlement',await c.eval(`document.querySelector('.timeline-thinking > button')?.getAttribute('aria-expanded')==='false'`));
  },
  'thinking-kept':async()=>{
    await ready();await send('E2E_THINKING: 请先思考，再简短回答。');
    await until(()=>visible('[data-live-turn-header]'),'in-place thinking header');
    await c.eval("void(window.__thinkingHeader=document.querySelector('.timeline-header'))");
    await c.eval(`(()=>{const timing=window.__thinkingKeptTiming={};const sample=()=>{const now=performance.now(),answer=document.querySelector('.assistant-turn-live-tail,.assistant-turn-response'),header=document.querySelector('.timeline-toggle');if(answer)timing.answerAt??=now;if(timing.answerAt!==undefined&&!document.querySelector(${JSON.stringify(stopSelector)}))timing.completedAt??=now;if(timing.answerAt!==undefined&&header?.getAttribute('aria-expanded')==='false')timing.collapsedAt??=now;};const observer=new MutationObserver(sample);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-expanded']});window.__stopThinkingKeptTiming=()=>observer.disconnect();sample();})()`);
    await sleep(1200);await shot('running');
    check('running header says thinking',(await c.eval("document.querySelector('.timeline-heading')?.textContent")).includes(t('omp.timeline.thinkingLive')));
    await complete();await until(()=>c.eval(`document.querySelector('.timeline-toggle')?.getAttribute('aria-expanded')==='false'`),'settled reasoning collapse',1500);
    current.thinkingTiming=await c.eval('window.__thinkingKeptTiming');json(`${out}/thinking-kept-timing.json`,current.thinkingTiming);await c.eval('window.__stopThinkingKeptTiming()');
    const timing=current.thinkingTiming;check('reasoning header respects answer grace and completion deadline',timing.collapsedAt>=timing.answerAt+550&&timing.collapsedAt<=Math.max(timing.completedAt,timing.answerAt+600)+150,timing);
    await shot('settled-collapsed');
    const settled=await c.eval("(()=>{const h=document.querySelector('.timeline-header'),s=h?.closest('.turn-timeline'),b=h?.querySelector('button');return {same:h===window.__thinkingHeader,text:h?.innerText,collapsed:b?.getAttribute('aria-expanded')==='false',above:s?.nextElementSibling?.classList.contains('assistant-turn-response'),chapters:s?.querySelectorAll('.timeline-chapter').length}})()");
    check('same header settles above answer without empty chapters',settled.same&&settled.above&&settled.collapsed&&settled.chapters===0,settled);
    check('settled thinking label',settled.text?.includes(t('omp.timeline.thoughtShort'))&&!settled.text?.includes('0秒'),settled.text);
    await c.click('.timeline-toggle');await until(async()=>(await text()).includes('最后给出清晰的答复。'),'expanded streamed reasoning');await shot('settled-expanded');
    check('reasoning in stream order',/先确认问题的范围。[\s\S]*再按顺序核对依据。[\s\S]*最后给出清晰的答复。/.test(await text()));
    await c.click('.timeline-toggle');await openSaved();await until(()=>visible('.timeline-toggle'),'saved thinking row');await sleep(350);await shot('reopened-collapsed');
    check('saved label equals settled label',await c.eval("document.querySelector('.timeline-header')?.innerText")===settled.text);
    await c.click('.timeline-toggle');await until(async()=>(await text()).includes('最后给出清晰的答复。'),'saved reasoning');await shot('reopened-expanded');
    check('saved reasoning in stream order',/先确认问题的范围。[\s\S]*再按顺序核对依据。[\s\S]*最后给出清晰的答复。/.test(await text()));
  },
  delete:async()=>{await simple();await menu();await shot('menu');const discard=await c.eval(`!![...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent===${JSON.stringify(t('omp.removal.discard'))})`);await action(discard?'omp.removal.discard':'sidebar.deleteSession','[role=menuitem]');await until(()=>visible('[role=dialog]'),'removal confirmation');await shot('confirmation');await action(discard?'omp.removal.confirmDiscard':'omp.removal.confirmTrash','[role=dialog] button');await until(async()=>await c.eval(`document.querySelectorAll('.thread-item').length===0`),'removed row');await sleep(300);await shot('deleted');check('result is toast only',!await visible('[role=alertdialog]')&&!await visible('[role=dialog]'));check('deletion toast shown',(await text()).includes(t('omp.removal.trashed')),await text());box.recordTrash();check('own Trash journal recorded',box.trash.length===1,box.trash);},
  terminal:async()=>{await simple();await openSaved();const journal=box.journals().find(p=>readFileSync(p,'utf8').includes('E2E_SIMPLE'));if(!journal)throw Error('Native journal missing');await box.terminal('E2E_SLOW: Terminal presence conversation.',journal);await until(async()=>(await text()).includes(t('omp.observe.running')),'exact terminal running wording',45000);await shot('running');check('exact running wording',(await text()).includes(t('omp.observe.running')));await menu();await action('sidebar.deleteSession','[role=menuitem]');await until(()=>visible('[role=dialog]'),'terminal removal confirmation');await action('omp.removal.confirmTrash','[role=dialog] button');await until(async()=>(await text()).includes(t('omp.removal.external')),'terminal removal blocked');check('delete blocked while terminal owns session',box.journals().includes(journal));await shot('blocked');await c.key('Escape');await until(async()=>!await visible('[data-live-turn-header]'),'terminal run complete',45000);box.terminalProcess.stdin.write('/exit'+String.fromCharCode(13));await until(()=>box.terminalProcess.exitCode!==null,'terminal /exit',15000);await sleep(2000);await menu();await action('sidebar.deleteSession','[role=menuitem]');await until(()=>visible('[role=dialog]'),'released removal confirmation');check('delete enabled after exit',await c.eval(`!![...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent===${JSON.stringify(t('omp.removal.confirmTrash'))}&&!e.disabled)`));await shot('released');},
  settings:async()=>{await ready();await action('nav.settings','.sidebar button');await until(()=>visible('[data-nav=back-to-app]'),'settings page');await action('settings.notificationsPresence');const toggle='[role=switch]'+attribute('aria-label',t('settings.terminalPresence'));await until(()=>visible(toggle),'presence preference');await shot('open');const before=await c.eval(`document.querySelector(${JSON.stringify(toggle)})?.getAttribute('aria-checked')`);await c.click(toggle);await until(async()=>await c.eval(`document.querySelector(${JSON.stringify(toggle)})?.getAttribute('aria-checked')`)!==before,'presence disabled');await shot('disabled');await c.click(toggle);await until(async()=>await c.eval(`document.querySelector(${JSON.stringify(toggle)})?.getAttribute('aria-checked')`)===before,'presence restored');await action('omp.settings.backToApp');await shot('closed');check('settings closed',!await visible('[data-nav=back-to-app]'));},
  'provider-error':async()=>{await ready();await send('E2E_ERROR: Exercise a provider failure.');await until(async()=>(await text()).includes(t('omp.errors.provider')),'provider error message',60000);await shot('error');const body=await text();check('clear actionable provider message',body.includes(t('omp.errors.provider'))&&body.includes(t('omp.errors.providerAction')),body);check('no raw IPC error',!/Error invoking remote method|ENOENT|undefined|NaN/.test(body));},
  ask:async()=>{await ready();await send('LIVE_FIXTURE_ASK: Choose verification scope.');await until(async()=>(await text()).includes('这次优先验证哪个界面'),'native ask');await until(()=>c.eval(`document.querySelector('[data-live-turn-header] button')?.getAttribute('aria-label')===${JSON.stringify(t('omp.live.waitingChoice'))}`),'inline choice waiting state');await shot('question');check('native ask owns in-place waiting state',await c.eval(`document.querySelector('[data-live-turn-header] .timeline-heading')?.textContent===${JSON.stringify(t('omp.live.waitingChoice'))}`));await c.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.innerText.includes('对话与收件箱'));if(!b)throw Error('Ask choice missing');b.click()})()`);await complete('LIVE_FIXTURE_ASK_COMPLETE');await shot('answered');check('native answer preserved',(await text()).includes('对话与收件箱'));},
  'slow-first-token':async()=>{
    await ready();await send('E2E_SLOW: Wait for first token.');await until(()=>visible('[data-live-turn-header]'),'inline waiting status');await sleep(1500);await shot('waiting');
    const finishCapture=await startPaintedCapture(c,`${out}/${current.name}`);
    try {
    const inline=await c.eval(`(()=>{const h=document.querySelector('[data-live-turn-header]'),u=[...document.querySelectorAll('.message-row.user')].at(-1),v=document.querySelector('.thread-scroll').getBoundingClientRect(),r=h.getBoundingClientRect(),b=u.getBoundingClientRect();return {text:h.innerText,name:h.querySelector('button').getAttribute('aria-label'),visible:r.top>=v.top&&r.bottom<=v.bottom,directlyAfter:u.nextElementSibling===h.closest('.assistant-turn'),distance:r.top-b.bottom,bottomHidden:document.querySelector('.live-status-row[data-state]')?.getAttribute('aria-hidden')==='true',chapters:h.closest('.assistant-turn').querySelectorAll('.timeline-chapter').length,announcementMounted:!!document.querySelector('.live-status-announcement')}})()`);
    check('thinking visible directly below sent message before first token',inline.visible&&inline.directlyAfter&&inline.distance>=0&&inline.distance<80&&inline.text.includes(t('omp.timeline.thinkingLive'))&&inline.name===inline.text.trim()&&!(await text()).includes('Local answer'),inline);
    check('thinking clock omits zero duration',locale==='zh-CN'?/正在思考 · [1-9]\d*秒/.test(inline.text):inline.text.includes(' · '),inline.text);
    check('visible inline header hides bottom row without losing announcements',inline.bottomHidden&&inline.announcementMounted&&inline.chapters===0,inline);
    await complete();await shot('complete');
      await assertPaintedFollow(c,check);
    } finally {current.paintedCapture=await finishCapture();if(current.paintedCapture.screenshot)current.evidence.push(current.paintedCapture.screenshot);}
  }
};
if(selected!=='all'&&!scenarios[selected])throw new Error(`Unknown scenario ${selected}. Choose: ${Object.keys(scenarios).join(', ')}`);
let stopping=false;async function interrupt(){if(stopping)return;stopping=true;await box?.stop();process.exit(130)}process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
for(const [name,run]of Object.entries(scenarios)){if(selected!=='all'&&selected!==name)continue;current={name,assertions:[],evidence:[],startedAt:new Date().toISOString()};const began=Date.now();try{box=new Sandbox(`${out}/${name}`,ports,{app,locale,scenario:name});c=await box.launch(size);await c.eval(installProbe);await run();}catch(error){check('scenario completes',false,String(error));if(c)try{await shot('failure')}catch{}}finally{if(c)try{await performance()}catch(error){check('metrics collected',false,String(error))}try{await box?.stop()}catch(error){check('cleanup succeeds',false,String(error))}c=null;box=null;}current.durationMs=Date.now()-began;current.pass=current.assertions.every(a=>a.pass);results.push(current);json(`${out}/${name}.json`,current);console.log(`${current.pass?'PASS':'FAIL'} ${name} ${(current.durationMs/1000).toFixed(1)}s ${current.assertions.filter(a=>!a.pass).map(a=>a.name).join('; ')}`);}
json(`${out}/results.json`,{size,locale,app,startedAt:new Date(started).toISOString(),durationMs:Date.now()-started,results});console.table(results.map(r=>({scenario:r.name,result:r.pass?'PASS':'FAIL',seconds:(r.durationMs/1000).toFixed(1),failures:r.assertions.filter(a=>!a.pass).length})));console.log(`Evidence: ${out}`);process.exitCode=results.every(r=>r.pass)?0:1;
