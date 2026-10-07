import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, openSync, closeSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, until, CDP } from './cdp.mjs';
export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalTmp = path => path?.replace(/^\/private\/tmp\//, '/tmp/');
const sessionHeader = path => readFileSync(path,'utf8').split('\n').slice(0,8).map(line=>{try{return JSON.parse(line)}catch{return null}}).find(row=>row?.type==='session');
export class Sandbox {
  children = []; trash = [];
  constructor(out, ports, options = {}) {
    if (process.platform !== 'darwin') throw new Error('Requires macOS sandbox-exec; refusing unsandboxed execution');
    this.out = out; this.ports = ports; this.realHome = homedir(); this.root = realpathSync(mkdtempSync('/tmp/eh-')); this.home = `${this.root}/h`; this.workspace = `${this.root}/workspace`; this.userData = `${this.root}/u`; this.agent = `${this.home}/.omp/agent`;
    this.appDirectory = realpathSync(resolve(options.app || repo));
    this.locale = options.locale || 'zh-CN';
    for (const p of [out,this.agent,this.userData,this.workspace,`${this.workspace}/src`,`${this.workspace}/docs`,`${this.root}/tmp`]) mkdirSync(p,{recursive:true});
    const which = name => execFileSync('/usr/bin/which',[name],{encoding:'utf8'}).trim();
    this.bun = which('bun'); this.omp = which('omp');
    this.env = { HOME:this.home,CFFIXED_USER_HOME:this.home,USER:'omp-e2e',LOGNAME:'omp-e2e',SHELL:'/bin/bash',PATH:`${dirname(this.bun)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,TMPDIR:`${this.root}/tmp/`,XDG_CONFIG_HOME:`${this.root}/config`,XDG_CACHE_HOME:`${this.root}/cache`,XDG_DATA_HOME:`${this.root}/data`,XDG_STATE_HOME:`${this.root}/state`,PI_CODING_AGENT_DIR:this.agent,OMP_DESKTOP_USER_DATA:this.userData,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',TERM:'xterm-256color',LANG:'en_US.UTF-8',FIXTURE_ROOT:out,FIXTURE_PORT:String(ports.fixture) };
    const model = 'live-fixture/scripted-live';
    this.json(`${this.agent}/config.yml`,{startup:{setupWizard:false,quiet:true,checkUpdate:false},collab:{autoStart:'off'},modelRoles:Object.fromEntries(['default','task','smol','slow','tiny','plan','commit','advisor','memory'].map(r=>[r,model])),enabledModels:[model,'live-fixture/simple'],enabledProviders:['native'],disabledProviders:['local','web','ollama','llama.cpp','lm-studio','apple','anthropic','openai','openai-codex','google','openrouter','github-copilot','cursor'],async:{enabled:false},task:{batch:true,maxConcurrency:3,agentModelOverrides:{task:model}},tools:{approvalMode:'yolo'},compaction:{enabled:false},defaultThinkingLevel:'off'});
    if (options.scenario === 'provider-error') { const config=JSON.parse(readFileSync(`${this.agent}/config.yml`,'utf8'));config.retry={enabled:false};this.json(`${this.agent}/config.yml`,config); }
    const modelBase={input:['text'],contextWindow:128000,maxTokens:16000,cost:{input:1,output:2,cacheRead:0,cacheWrite:0},compat:{supportsStore:false,supportsDeveloperRole:false,supportsReasoningEffort:true}};
    this.json(`${this.agent}/models.yml`,{providers:{'live-fixture':{baseUrl:`http://127.0.0.1:${ports.fixture}/v1`,api:'openai-completions',auth:'none',models:[{...modelBase,id:'scripted-live',name:'Local scripted live fixture',reasoning:true,thinking:{mode:'effort',efforts:['minimal','low','medium','high','xhigh','max']}},{...modelBase,id:'simple',name:'Non-reasoning fixture',reasoning:false}]}}});
    this.json(`${this.userData}/desktop-preferences.json`,{language:this.locale,executablePath:this.omp,lastWorkspace:this.workspace,recentWorkspaces:[this.workspace],terminalPresence:true});
    for (const [p,t] of Object.entries({'README.md':'# E2E workspace\nDeterministic fixture.\n','src/frontend.ts':'export const fixture = true;\n','src/backend.ts':'export const fixture = 200;\n','docs/guide.txt':'Fixture operator guide\n'})) writeFileSync(`${this.workspace}/${p}`,t);
    const q = s => JSON.stringify(s);
    writeFileSync(`${this.root}/isolation.sb`,`(version 1)\n(allow default)\n(deny file-read* file-write* (subpath ${q(`${this.realHome}/.omp`)}) (subpath ${q(`${this.realHome}/Library/Application Support`)}))\n(allow process-exec (literal "/bin/ps") (with no-sandbox))\n(deny network*)\n(allow network-bind network-inbound (local ip "localhost:*") (local unix-socket))\n(allow network-outbound (remote ip "localhost:*") (remote unix-socket))\n`);
    this.json(`${out}/isolation.json`,{root:this.root,home:this.home,userData:this.userData,ports,realOmpDenied:`${this.realHome}/.omp`,nonLoopbackDenied:true});
  }
  json(path,value){writeFileSync(path,JSON.stringify(value,null,2));}
  start(executable,args,log,pipe=false){const fd=openSync(`${this.out}/${log}`,'a');const child=spawn('/usr/bin/sandbox-exec',['-f',`${this.root}/isolation.sb`,executable,...args],{cwd:this.workspace,env:this.env,detached:true,stdio:[pipe?'pipe':'ignore',fd,fd]});closeSync(fd);this.children.push(child);return child;}
  async launch(size){
    for(const port of Object.values(this.ports)){const occupied=await fetch(`http://127.0.0.1:${port}/`).then(()=>true,()=>false);if(occupied)throw new Error(`Port already occupied: ${port}`);}
    this.start(this.bun,[`${repo}/e2e/fixture.ts`],'fixture-server.log');
    await until(async()=>{try{return (await fetch(`http://127.0.0.1:${this.ports.fixture}/health`)).ok}catch{return false}},'fixture health');
    this.app=this.start(`${repo}/node_modules/.bin/electron`,[this.appDirectory,'--no-sandbox',`--user-data-dir=${this.userData}`,'--remote-debugging-address=127.0.0.1',`--remote-debugging-port=${this.ports.cdp}`],'electron.log');
    let target; await until(async()=>{try{target=(await(await fetch(`http://127.0.0.1:${this.ports.cdp}/json/list`)).json()).find(t=>t.type==='page'&&t.url===new URL(`file://${this.appDirectory}/out/renderer/index.html`).href);return !!target}catch{return false}},'own package renderer');
    // Verify this CDP port belongs to the process launched with our isolated userData, before attaching.
    const command=execFileSync('/bin/ps',['-ww','-p',String(this.app.pid),'-o','command='],{encoding:'utf8'}); if(!command.includes(`--user-data-dir=${this.userData}`))throw new Error('CDP ownership verification failed');
    const listeners=execFileSync('/usr/sbin/lsof',['-nP',`-iTCP:${this.ports.cdp}`,'-sTCP:LISTEN','-t'],{encoding:'utf8'}).trim().split('\n').map(Number);const listenerCommands=execFileSync('/bin/ps',['-ww','-p',listeners.join(','),'-o','command='],{encoding:'utf8'});if(!listenerCommands.includes(`--user-data-dir=${this.userData}`))throw new Error('CDP listener is not our Electron process');
    this.cdp=await CDP.connect(target.webSocketDebuggerUrl);await this.cdp.call('Page.enable');await this.cdp.call('Emulation.setDeviceMetricsOverride',{width:size[0],height:size[1],deviceScaleFactor:1,mobile:false});
    return this.cdp;
  }
  async terminal(prompt,session){const python=execFileSync('/usr/bin/which',['python3'],{encoding:'utf8'}).trim();this.terminalProcess=this.start(python,['-B',`${repo}/e2e/terminal_bridge.py`,this.omp,...(session?['--resume',session]:[]),prompt],'terminal.log',true);return this.terminalProcess;}
  journals(){const walk=p=>!existsSync(p)?[]:readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(p,e.name)):e.name.endsWith('.jsonl')?[join(p,e.name)]:[]);return walk(`${this.agent}/sessions`);}
  recordTrash(){const directory=`${this.realHome}/.Trash`; if(!existsSync(directory))return;for(const name of readdirSync(directory)){if(!name.endsWith('.jsonl'))continue;const path=join(directory,name);let header;try{header=sessionHeader(path);}catch{continue}if(!header||canonicalTmp(header.cwd)!==canonicalTmp(this.workspace))continue;if(!this.trash.some(t=>t.path===path))this.trash.push({path,cwd:header.cwd,id:header.id});}this.json(`${this.out}/trash.json`,this.trash);}
  async stop(){
    this.cdp?.close();
    const rows=execFileSync('/bin/ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(s=>s.trim().split(/\s+/).map(Number));const owned=new Set(this.children.map(c=>c.pid));let changed=true;while(changed){changed=false;for(const [pid,parent]of rows)if(owned.has(parent)&&!owned.has(pid)){owned.add(pid);changed=true;}}
    for(const pid of [...owned].reverse())try{process.kill(pid,'SIGTERM')}catch{};for(const child of this.children)try{process.kill(-child.pid,'SIGTERM')}catch{};await sleep(700);for(const pid of [...owned].reverse())try{process.kill(pid,'SIGKILL')}catch{};
    try { this.recordTrash();for(const item of this.trash){const header=sessionHeader(item.path);if(canonicalTmp(header?.cwd)!==canonicalTmp(this.workspace)||header?.id!==item.id)throw new Error(`Refusing changed Trash item ${item.path}`);const companion=item.path.slice(0,-6);item.companion=existsSync(companion)?companion:null;this.json(`${this.out}/trash.json`,this.trash);rmSync(item.path);if(item.companion)rmSync(item.companion,{recursive:true});item.cleaned=true;}this.json(`${this.out}/trash.json`,this.trash); } finally { rmSync(this.root,{recursive:true,force:true}); }
  }
}
