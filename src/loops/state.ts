import fs from 'node:fs/promises';
import path from 'node:path';
import { readRunState, type RunState } from '../status/runState.js';
import type { WorkflowConfig } from '../workflow/types.js';

export const loopWorkspace = (config: WorkflowConfig, id: string) => path.join(config.workspace.root, '_loops', id);
export async function readLoopState(config: WorkflowConfig, id: string, recover = false): Promise<RunState | null> {
  const workspace = loopWorkspace(config,id);
  const intentPath = path.join(config.workspace.root,'.symphony',`loop-preparation-${id}.json`);
  const raw = await fs.readFile(intentPath,'utf8').catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
  if (raw) {
    const intent = JSON.parse(raw) as {workspace:string;saved:string;owner_pid:number};
    const metadataRoot = path.resolve(config.workspace.root,'.symphony');
    if (intent.workspace!==workspace || path.dirname(intent.saved)!==metadataRoot || !path.basename(intent.saved).startsWith('loop-preparation-')) throw new Error('Invalid loop preparation checkpoint');
    let alive = false;
    try {process.kill(intent.owner_pid,0);alive=true;} catch(error) {alive=(error as NodeJS.ErrnoException).code==='EPERM';}
    const savedExists = await fs.access(intent.saved).then(()=>true,()=>false);
    if (!alive && recover) {
      // Only the workflow-lock owner restores a checkpoint. Telegram readers never mutate preparation files.
      if (savedExists) {
        await fs.mkdir(path.join(workspace,'.symphony'),{recursive:true});
        await fs.cp(intent.saved,path.join(workspace,'.symphony'),{recursive:true});
        await fs.rm(intent.saved,{recursive:true});
      }
      await fs.unlink(intentPath);
    } else if (savedExists) {
      const snapshot = JSON.parse(await fs.readFile(path.join(intent.saved,'run.json'),'utf8')) as RunState;
      if (snapshot.loop_id!==id) throw new Error('Invalid loop preparation snapshot');
      return snapshot;
    }
  }
  const state = await readRunState(workspace);
  if (!state && await fs.access(path.join(workspace,'.symphony','run.json')).then(()=>true,()=>false)) throw new Error(`Invalid scheduled loop state: ${id}`);
  if (state && state.loop_id !== id) throw new Error(`Scheduled loop state belongs to another invocation: ${id}`);
  return state;
}
export async function scanLoopStates(config: WorkflowConfig): Promise<RunState[]> {
  const states = await Promise.all(config.loops.map(loop => readLoopState(config,loop.id)));
  return states.filter((state):state is RunState=>state!==null);
}

/** Local, idempotent reply storage; scheduled invocations do not own a GitHub issue. */
export async function recordLoopInput(config:WorkflowConfig,id:string,session:string|null,marker:string,text:string):Promise<number> {
  const {updateRunState}=await import('../status/runState.js');
  let commentId=0;
  await updateRunState(loopWorkspace(config,id),current=>{
    if (!current || current.loop_id!==id || current.session_id!==session) throw new Error('Scheduled loop invocation changed');
    const inputs=current.loop_inputs ?? [], existing=inputs.find(input=>input.marker===marker);
    commentId=existing?.comment_id ?? Math.max(Date.now(),...inputs.map(input=>input.comment_id+1));
    return existing?current:{...current,loop_inputs:[...inputs,{marker,text,comment_id:commentId}],updated_at:new Date().toISOString()};
  });
  return commentId;
}
export async function requestLoopResume(config:WorkflowConfig,id:string,session:string|null):Promise<boolean> {
  if (!config.loops.some(loop=>loop.id===id && loop.enabled)) return false;
  const {updateRunState}=await import('../status/runState.js');
  let resumed=false;
  await updateRunState(loopWorkspace(config,id),current=>{
    if (!current || current.loop_id!==id || current.session_id!==session || !['paused','completed','failed'].includes(current.status)) return current;
    resumed=true;
    return {...current,status:'retry-wait',pause_reason:null,loop_resume_requested:true,
      attempt:current.status==='paused'?current.attempt:1,preparation_failure_count:0,
      retry_not_before:new Date().toISOString(),retry_reason:'authorized user reply',updated_at:new Date().toISOString()};
  });
  return resumed;
}
