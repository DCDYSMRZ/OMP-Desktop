import { writeFileSync } from 'node:fs';

// A continuously resized sentinel triggers a post-layout sample every painted
// frame, including the glide after content stops growing. No application state
// is changed. Return transitions are recorded separately from steady following.
export const installPaintedFollow = `(() => {
  const p = window.__e2ePaint = { samples: [], checkpoints: [], returns: [], attachedAt: performance.now(), latest: null };
  let scroll, content, observer, frame, previous, growthAt = performance.now(), sentinelSize = 1, intentUntil = 0;
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;pointer-events:none;contain:strict';
  document.body.append(sentinel);
  const sample = () => {
    if (!scroll?.isConnected) return;
    const at=performance.now(), height=scroll.scrollHeight, top=scroll.scrollTop, viewport=scroll.clientHeight;
    const heightDelta=previous?height-previous.scrollHeight:0;
    const targetDelta=previous?height-viewport-(previous.scrollHeight-previous.clientHeight):0;
    if(targetDelta>0)growthAt=at;
    const activeReturn=p.returns.at(-1);
    const returning=!!activeReturn && at-activeReturn.at<=300;
    const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const viewportResized=!!previous&&viewport!==previous.clientHeight;
    const clamped=heightDelta>0&&!!previous&&previous.gap+targetDelta>64&&height-viewport-top>=63.5;
    const row={at,wallTime:performance.timeOrigin+at,gap:height-viewport-top,scrollTop:top,scrollHeight:height,clientHeight:viewport,scrollHeightDelta:heightDelta,delta:previous?top-previous.scrollTop:0,dt:previous?at-previous.at:0,growthAge:at-growthAt,following:document.querySelector('.thread-wrap')?.dataset.following==='true',userScrolling:at<intentUntil,running:!!document.querySelector('.stop-btn'),returning,reducedMotion,viewportResized,clamped,snap:reducedMotion||heightDelta>viewport||!!activeReturn&&at-activeReturn.at<50&&activeReturn.distance>2*viewport};
    if(previous&&previous.gap>0&&previous.gap<=1.5&&row.gap===0&&heightDelta===0)row.snap=true;
    if(activeReturn&&!activeReturn.reachedAt&&row.following&&row.gap<=1)activeReturn.reachedAt=at;
    previous=row;p.latest=row;p.samples.push(row);window.__e2ePaintSample?.(JSON.stringify(row));
  };
  const attach=()=>{const next=document.querySelector('.thread-scroll');if(next===scroll)return;observer?.disconnect();scroll=next;content=scroll?.querySelector('.thread-content');previous=undefined;if(!scroll)return;observer=new ResizeObserver(sample);observer.observe(sentinel);observer.observe(scroll);if(content)observer.observe(content,{box:'border-box'});};
  const tick=()=>{attach();sentinel.style.width=(sentinelSize=sentinelSize===1?2:1)+'px';frame=requestAnimationFrame(tick);};
  const onClick=event=>{if(!(event.target instanceof Element)||!event.target.closest('.live-status-main,.live-status-return,.minimap-marker:last-child'))return;intentUntil=0;if(scroll)p.returns.push({at:performance.now(),distance:scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop});};
  const onIntent=event=>{if(event.target instanceof Element&&event.target.closest('.thread-scroll')&&!event.target.closest('pre,textarea,.native-tool-details,.timeline-thinking-viewport'))intentUntil=performance.now()+200;};
  document.addEventListener('click',onClick,true);
  document.addEventListener('wheel',onIntent,{capture:true,passive:true});
  document.addEventListener('touchmove',onIntent,{capture:true,passive:true});
  p.checkpoint=label=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const row={...p.latest,checkpoint:label};p.checkpoints.push(row);resolve(row)})));
  p.stop=()=>{cancelAnimationFrame(frame);observer?.disconnect();sentinel.remove();document.removeEventListener('click',onClick,true);document.removeEventListener('wheel',onIntent,true);document.removeEventListener('touchmove',onIntent,true);};
  tick();return true;
})()`;

export async function assertPaintedFollow(cdp, check) {
  await new Promise(resolve => setTimeout(resolve, 350));
  const data = await cdp.eval('({samples:window.__e2ePaint.samples,returns:window.__e2ePaint.returns})');
  const following = data.samples.filter(row => row.following && !row.userScrolling && !row.returning);
  check('all painted following gaps <= 64 px', following.length > 0 && following.every(row => row.gap <= 64), following.filter(row => row.gap > 64));
  const settled = following.filter(row => row.growthAge >= 350 && row.scrollHeightDelta >= 0 && !row.viewportResized);
  check('settles within 350 ms of last growth to <= 1 px', settled.length > 0 && settled.every(row => row.gap <= 1), settled.filter(row => row.gap > 1));
  const steps = data.samples.filter((row, index) => index > 0 && row.dt > 0 && row.following && !row.userScrolling && !row.returning && data.samples[index-1].following && !data.samples[index-1].userScrolling && !data.samples[index-1].returning && !row.snap && !row.viewportResized && row.scrollHeightDelta >= 0);
  const ordinary = steps.filter(row => !row.clamped);
  check('unclamped scroll velocity <= 1.45 px/ms', ordinary.every(row => Math.abs(row.delta) <= 1.45 * row.dt), ordinary.filter(row => Math.abs(row.delta) > 1.45 * row.dt));
  const clamps=steps.filter(row=>row.clamped);
  check('visibility clamp movement <= content growth',clamps.every(row=>Math.abs(row.delta)<=row.scrollHeightDelta),clamps.filter(row=>Math.abs(row.delta)>row.scrollHeightDelta));
  const deltas = steps.map(row => Math.abs(row.delta)).sort((a,b)=>a-b);
  const p95 = deltas[Math.floor(deltas.length*.95)] ?? 0;
  check('per-frame follow movement p95 <= 12 px', p95 <= 12, p95);
  check('return reaches bottom within 400 ms', data.returns.every(row => row.reachedAt !== undefined && row.reachedAt-row.at <= 400), data.returns);
  return data;
}

export async function startPaintedCapture(cdp, prefix) {
  await cdp.call('Runtime.enable');
  await cdp.call('Runtime.addBinding', { name: '__e2ePaintSample' });
  let worst = null, firstPaint = null, capture = null, latest = null;
  const frames = [], screenshots = [];
  const offSample = cdp.on('Runtime.bindingCalled', event => {
    if (event.name !== '__e2ePaintSample') return;
    latest = JSON.parse(event.payload);
    if (latest.following && !latest.userScrolling && !latest.returning && (!worst || latest.gap > worst.gap)) { worst = latest; firstPaint = null; }
  });
  const offFrame = cdp.on('Page.screencastFrame', event => {
    void cdp.call('Page.screencastFrameAck', { sessionId:event.sessionId });
    const wallTime = event.metadata.timestamp * 1000;
    frames.push({wallTime,metadata:event.metadata,sample:latest});
    if (worst && firstPaint === null && wallTime >= worst.wallTime) { firstPaint = {wallTime,sample:worst,deltaMs:wallTime-worst.wallTime,metadata:event.metadata}; capture = event.data; }
    if (screenshots.length < 5 && latest?.following && latest.running && latest.delta > 0 && latest.gap > 0 && !latest.returning) {
      const path=prefix+'-glide-'+(screenshots.length+1)+'.jpg';
      writeFileSync(path,Buffer.from(event.data,'base64'));screenshots.push(path);
    }
  });
  await cdp.call('Page.startScreencast', { format:'jpeg',quality:75,everyNthFrame:1 });
  await cdp.eval(installPaintedFollow);
  return async () => {
    await cdp.eval('window.__e2ePaint.stop()');
    await cdp.call('Page.stopScreencast');offSample();offFrame();
    if (capture) writeFileSync(prefix+'-worst-painted.jpg',Buffer.from(capture,'base64'));
    const result={worst,firstPaint,screenshot:capture?prefix+'-worst-painted.jpg':null,screenshots,frames};
    writeFileSync(prefix+'-painted-capture.json',JSON.stringify(result,null,2));
    return result;
  };
}

// Observe public disclosure state, without exposing the application's guard.
export const installChapterMotion = `(() => {
  const p=window.__chapterMotion={transitions:[],flips:[],scrolls:[],lastInput:null,lastScroll:null,process:null};
  const previous=new Map();let currentId,processLive=false;
  const input=event=>{if(event.target instanceof Element&&event.target.closest('.thread-scroll'))p.lastInput=performance.now();};
  const scrolled=event=>{if(event.target instanceof Element&&event.target.closest('.thread-scroll')){p.lastScroll=performance.now();if(p.lastInput!==null)p.scrolls.push({at:p.lastScroll,top:event.target.scrollTop,target:event.target.className,sinceInput:p.lastScroll-p.lastInput});}};
  const scan=()=>{
    const at=performance.now(),following=document.querySelector('.thread-wrap')?.dataset.following==='true';
    const nodes=[...document.querySelectorAll('.timeline-chapter')];
    const next=nodes.find(node=>node.hasAttribute('data-current-chapter'))?.dataset.chapterId;
    if(currentId&&next&&next!==currentId){const old=nodes.find(node=>node.dataset.chapterId===currentId);p.transitions.push({id:currentId,next,at,following,wasOpen:previous.get(currentId)?.open===true,interactionAge:p.lastInput===null?null:at-p.lastInput,closedAt:old?.querySelector('.chapter-toggle')?.getAttribute('aria-expanded')==='false'?at:null});}
    for(const node of nodes){const id=node.dataset.chapterId,open=node.querySelector('.chapter-toggle')?.getAttribute('aria-expanded')==='true',old=previous.get(id);if(old&&old.open!==open)p.flips.push({id,at,open,following});if(!open)for(const transition of p.transitions)if(transition.id===id&&transition.closedAt===null)transition.closedAt=at;previous.set(id,{open});}
    if(next)currentId=next;
    const process=document.querySelector('.turn-timeline'),live=!!process?.classList.contains('is-live'),open=process?.querySelector('.timeline-toggle')?.getAttribute('aria-expanded')==='true';
    if(processLive&&!live)p.process={endedAt:at,heldOpen:open,lastInput:p.lastInput,lastScroll:p.lastScroll,closedAt:open?null:at};
    if(p.process&&!open&&p.process.closedAt===null)p.process.closedAt=at;
    processLive=live;
  };
  const observer=new MutationObserver(scan);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-expanded','data-current-chapter','class']});
  document.addEventListener('wheel',input,{capture:true,passive:true});
  document.addEventListener('scroll',scrolled,{capture:true,passive:true});
  p.stop=()=>{observer.disconnect();document.removeEventListener('wheel',input,true);document.removeEventListener('scroll',scrolled,true);};
  scan();return true;
})()`;
