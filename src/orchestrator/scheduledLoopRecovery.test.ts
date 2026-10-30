import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test,{type TestContext} from 'node:test';
import {Orchestrator} from './orchestrator.js';
import {loadWorkflowFromFile} from '../workflow/loadWorkflow.js';
import {readLoopState} from '../loops/state.js';
import {updateRunState} from '../status/runState.js';
import {createBridgeBackend} from '../telegram/runBridge.js';
import {TelegramBridge,type BridgeState} from '../telegram/bridge.js';
import {EpisodeStore} from '../episodes/episodeStore.js';

async function fixture(t:TestContext,command:string,hook?:string){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'symphony-loop-recovery-')),workflow=path.join(root,'WORKFLOW.md');
 await fs.writeFile(workflow,`---
tracker:
  owner: example
  repo: app
  token: token
  api_base_url: https://api.github.test
workspace:
  root: ${path.join(root,'workspaces')}
${hook?`hooks:\n  before_run: ${JSON.stringify(hook)}\n`:''}
agent:
  max_retry_backoff_ms: 1
  max_attempts: 2
loops:
  - id: quality
    interval_ms: 86400000
    prompt: Inspect quality. Ask if a decision is missing.
agents:
  providers:
    codex:
      command: ${JSON.stringify(command)}
---
Prompt.
`);
 const {config}=await loadWorkflowFromFile(workflow);const original=globalThis.fetch;
 const mutations:string[]=[];
 globalThis.fetch=async(input,init)=>{if(init?.method&&init.method!=='GET')mutations.push(String(input));return Response.json([]);};
 const agents:Orchestrator[]=[];
 const start=()=>{const agent=new Orchestrator({workflowPath:workflow,repoId:'default'});agents.push(agent);return agent;};
 t.after(async()=>{for(const agent of agents)await agent.shutdown('test');globalThis.fetch=original;await fs.rm(root,{recursive:true,force:true});});
 return {config,workflow,start,mutations,workspace:path.join(config.workspace.root,'_loops','quality')};
}
async function idle(agent:Orchestrator){const end=Date.now()+5000;while(agent.getRunningCount()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.equal(agent.getRunningCount(),0);}

test('loop failures retry with backoff across restart, preserve work and skip destructive hooks',async t=>{
 const f=await fixture(t,'echo run >> runs; if [ "$SYMPHONY_LOOP_ATTEMPT" = 1 ]; then echo partial > partial; exit 17; fi; test -f partial; echo done > "$SYMPHONY_LAST_MESSAGE_PATH"','echo setup >> hooks');
 const first=f.start();await first.tickOnce();await idle(first);
 const failed=await readLoopState(f.config,'quality');assert.equal(failed?.status,'retry-wait');assert.equal(failed?.attempt,2);
 await first.shutdown('restart');const second=f.start();await second.tickOnce();await idle(second);
 const completed=await readLoopState(f.config,'quality');assert.equal(completed?.status,'completed');assert.equal(completed?.loop_run_id,failed?.loop_run_id);
 assert.equal((await fs.readFile(path.join(f.workspace,'hooks'),'utf8')).trim(),'setup');
 assert.equal((await fs.readFile(path.join(f.workspace,'runs'),'utf8')).trim(),'run\nrun');
 await second.tickOnce();assert.equal(second.getRunningCount(),0);
});

test('exhausted loop retries stop until human attention instead of repeating every interval',async t=>{
 const f=await fixture(t,'echo run >> runs; exit 17');const a=f.start();await a.tickOnce();await idle(a);await a.tickOnce();await idle(a);
 assert.equal((await readLoopState(f.config,'quality'))?.status,'failed');
 const real=Date.now;Date.now=()=>real()+2*86400000;
 try{await a.tickOnce();assert.equal(a.getRunningCount(),0);}finally{Date.now=real;}
 assert.equal((await fs.readFile(path.join(f.workspace,'runs'),'utf8')).trim(),'run\nrun');
});

test('scheduled questions survive restart and Telegram replies resume exactly that loop without GitHub mutations',async t=>{
 const command=`if grep -q USER_REPLY_MARKER "$SYMPHONY_PROMPT_PATH"; then echo 'Completed follow-up https://github.com/example/app/issues/42' > "$SYMPHONY_LAST_MESSAGE_PATH"; else printf 'SYMPHONY_PAUSE\\nreason: policy\\nquestion: Include tablets?\\noptions:\\n- Yes\\n- No\\nEND_SYMPHONY_PAUSE\\n' > "$SYMPHONY_LAST_MESSAGE_PATH"; fi`;
 const f=await fixture(t,command);const first=f.start();await first.tickOnce();await idle(first);
 assert.equal((await readLoopState(f.config,'quality'))?.status,'paused');await first.shutdown('restart');
 const second=f.start();await second.tickOnce();assert.equal(second.getRunningCount(),0);
 const backend=await createBridgeBackend({workflow:f.workflow});const tasks=await backend.tasks();assert.equal(tasks[0]?.key,'default#loop:quality');
 const baseline=(await backend.activity!({}))[0]!;
 const state:BridgeState={offset:0,seen:{},messages:{},pending:{}};const sent:string[]=[],reactions:number[]=[];
 const bridge=new TelegramBridge({updates:async()=>[],send:async text=>{sent.push(text);return sent.length;},react:async id=>{reactions.push(id);}},backend,state,{chatId:123,userId:456},async()=>{});
 await bridge.notify();assert.match(sent[0]!,/Include tablets/);
 const reply={update_id:9,message:{message_id:19,chat:{id:123,type:'private'},from:{id:456},text:'USER_REPLY_MARKER: yes, include tablets',reply_to_message:{message_id:1}}};
 await bridge.receive(reply);await bridge.receive(reply);assert.deepEqual(reactions,[19]);
 assert.equal((await readLoopState(f.config,'quality'))?.loop_inputs?.length,1);
 await second.tickOnce();await idle(second);assert.equal((await readLoopState(f.config,'quality'))?.status,'completed');
 assert.deepEqual(f.mutations,[],'Scheduled-loop replies must never create an issue or change issue labels');
 const activity=(await backend.activity!({default:baseline.cursor}))[0]!;
 assert.ok(activity.activities.some(a=>a.kind==='loop_completed'));assert.ok(activity.activities.some(a=>a.kind==='followup'));
 await bridge.receive({...reply,update_id:10,message:{...reply.message,message_id:20}});
 assert.match(sent.at(-1)!,/earlier run/);assert.deepEqual(reactions,[19]);
 await fs.writeFile(f.workflow,(await fs.readFile(f.workflow,'utf8')).replace('  - id: quality','  - id: quality\n    enabled: false'));
 assert.equal(await backend.resume((await backend.tasks())[0]!),false,'Resume must recheck the current loop enablement');

});

test('preparation retries preserve the first agent attempt and exhausted setup needs intervention',async t=>{
 const f=await fixture(t,'echo agent-started > agent-started','echo setup >> hooks; exit 19');const a=f.start();
 await a.tickOnce();await idle(a);assert.equal((await readLoopState(f.config,'quality'))?.attempt,1);
 await a.tickOnce();await idle(a);const failed=await readLoopState(f.config,'quality');assert.equal(failed?.status,'failed');assert.equal(failed?.attempt,1);
 await assert.rejects(fs.access(path.join(f.workspace,'agent-started')));
});

test('orphaned loop work is retried with preserved invocation context and fresh output files',async t=>{
 const f=await fixture(t,'echo done > "$SYMPHONY_LAST_MESSAGE_PATH"');const first=f.start();await first.tickOnce();await idle(first);await first.shutdown('restart');
 const completed=await readLoopState(f.config,'quality');
 await updateRunState(f.workspace,s=>s?{...s,status:'agent-running',worker_pid:null,loop_coordinator_pid:null}:null);
 // Simulate a crash while a legacy clone hook had moved metadata out of its empty checkout.
 const saved=path.join(f.config.workspace.root,'.symphony','loop-preparation-fixture');
 await fs.writeFile(path.join(f.config.workspace.root,'.symphony','loop-preparation-quality.json'),JSON.stringify({workspace:f.workspace,saved,owner_pid:99999999}));
 await fs.rename(path.join(f.workspace,'.symphony'),saved);
 assert.equal((await readLoopState(f.config,'quality'))?.status,'agent-running','Read-only bridge readers can see the checkpoint');

 const second=f.start();await second.tickOnce();await idle(second);
 if((await readLoopState(f.config,'quality'))?.status==='retry-wait'){await second.tickOnce();await idle(second);}
 const recovered=await readLoopState(f.config,'quality');assert.equal(recovered?.status,'completed');assert.equal(recovered?.loop_run_id,completed?.loop_run_id);
 const store=new EpisodeStore(path.join(f.config.workspace.root,'.symphony','episodes.sqlite'));
 try{assert.ok(store.list({event:'loop.retry_scheduled'}).some(e=>e.payload.reason==='orphaned invocation recovered'));}finally{store.close();}
});


test('provider quota backoff survives restart without spending a loop attempt',async t=>{
 const f=await fixture(t,'echo run >> runs; exit 29');
 await fs.writeFile(f.workflow,(await fs.readFile(f.workflow,'utf8')).replace('      command:', '      usage_limit_exit_codes: [29]\n      usage_limit_backoff_ms: 60000\n      command:'));
 const before=Date.now(),first=f.start();await first.tickOnce();await idle(first);
 const state=await readLoopState(f.config,'quality');assert.equal(state?.status,'retry-wait');assert.equal(state?.attempt,1);
 assert.ok(Date.parse(state!.retry_not_before!)>=before+59000);await first.shutdown('restart');
 const second=f.start();await second.tickOnce();assert.equal(second.getRunningCount(),0);
 assert.equal((await fs.readFile(path.join(f.workspace,'runs'),'utf8')).trim(),'run');
});


test('live loop workers are accounted for even when no new dispatch capacity is available',async t=>{
 const f=await fixture(t,'echo started > marker; sleep 30');const first=f.start();await first.tickOnce();
 const end=Date.now()+5000;while(!(await readLoopState(f.config,'quality'))?.worker_pid && Date.now()<end)await new Promise(r=>setTimeout(r,10));
 assert.ok((await readLoopState(f.config,'quality'))?.worker_pid);
 const second=f.start();
 // Exercise recovery bookkeeping without taking the workflow lock from the still-live owner.
 await (second as unknown as {dispatchScheduledLoops(config:typeof f.config,capacity:{remaining:number}):Promise<void>}).dispatchScheduledLoops(f.config,{remaining:0});
 assert.equal(second.getRunningCount(),1,'The existing worker must consume capacity, never launch a duplicate');
 assert.equal((await fs.readFile(path.join(f.workspace,'marker'),'utf8')).trim(),'started');
});
