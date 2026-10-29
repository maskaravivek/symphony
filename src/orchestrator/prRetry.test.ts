import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {EpisodeStore, type RetryRecord} from '../episodes/episodeStore.js';
import {GithubIssueTrackerClient} from '../github/githubClient.js';
import {loadWorkflowFromFile} from '../workflow/loadWorkflow.js';
import type {WorkflowConfig} from '../workflow/types.js';
import type {Issue} from '../domain/issue.js';
import {WorkspaceManager} from '../workspace/workspaceManager.js';
import {Orchestrator} from './orchestrator.js';

async function fixture(t:TestContext, options:{pr?:boolean; closed?:boolean; unavailable?:boolean}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'symphony-pr-retry-'));
  const workflow=path.join(root,'WORKFLOW.md');
  await fs.writeFile(workflow,`---
tracker:
  owner: example
  repo: app
  token: token
  api_base_url: https://api.github.test
  include_pull_requests: false
  epics:
    enabled: false
workspace:
  root: ${path.join(root,'workspaces')}
agents:
  providers:
    codex:
      command: echo unused
---
Prompt.
`);
  const {config}=await loadWorkflowFromFile(workflow);
  const record:RetryRecord={repo_id:'app',issue_id:'I_42',issue_number:42,issue_identifier:'example/app#42',
    attempt:2,reason:'preparation_error: interrupted',next_run_at:new Date(0).toISOString(),workspace_path:null,
    mode:options.pr===false?'autonomous':'pr-review'};
  const store=new EpisodeStore(path.join(config.workspace.root,'.symphony','episodes.sqlite'));
  store.upsertRetry(record);
  const calls:Array<{url:string;method:string}>=[];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input)),method=init?.method??'GET';calls.push({url:url.pathname,method});
    if(url.pathname.endsWith('/issues/42')) return Response.json(options.unavailable?{message:'temporary outage'}:{
      id:42,node_id:'I_42',number:42,title:'Retry feedback',state:options.closed?'closed':'open',
      labels:[{name:'ready-for-agent'}],...(options.pr===false?{}:{pull_request:{}}),
    },{status:options.unavailable?503:200});
    if(url.pathname.endsWith('/pulls/42')) return Response.json({number:42,title:'Retry feedback',state:'open',
      body:'Fixes #17',head:{ref:'symphony-17-fix',sha:'head'},base:{ref:'main',sha:'base'},labels:[]});
    if(url.pathname.endsWith('/comments')) return Response.json([]);
    throw new Error(`Unexpected ${method} ${url}`);
  };
  const orchestrator=new Orchestrator({workflowPath:workflow,repoId:'app'});
  const internals=orchestrator as unknown as {
    loadDurableRetries(config:WorkflowConfig):void;
    reconcileDurableRetries(config:WorkflowConfig,client:GithubIssueTrackerClient):Promise<void>;
    dispatchReadyRetries(config:WorkflowConfig,client:GithubIssueTrackerClient,candidates:Issue[],manager:WorkspaceManager,capacity:{remaining:number}):Promise<void>;
    resolveStackContext:()=>Promise<null>;
    dispatchIssue:(config:WorkflowConfig,issue:Issue,manager:WorkspaceManager,options:{mode:string;attempt:number;prReview?:{pr_number:number}})=>Promise<void>;
  };
  internals.resolveStackContext=async()=>null;
  const dispatched:Array<{issue:Issue;mode:string;attempt:number;prReview?:{pr_number:number}}>=[];
  internals.dispatchIssue=async(_config,issue,_manager,opts)=>{dispatched.push({issue,...opts});};
  internals.loadDurableRetries(config);
  t.after(async()=>{await orchestrator.shutdown('test');store.close();globalThis.fetch=originalFetch;await fs.rm(root,{recursive:true,force:true});});
  return {config,store,internals,client:new GithubIssueTrackerClient(config.tracker),dispatched,calls};
}

test('restart reconciliation preserves an open PR retry when ordinary candidate polling excludes PRs',async t=>{
  const {config,store,internals,client}=await fixture(t);
  await internals.reconcileDurableRetries(config,client);
  assert.equal(store.listRetries('app').length,1,'An open PR is not a missing issue');
});

test('durable PR retry dispatch fetches the PR without requiring it in ordinary issue candidates',async t=>{
  const {config,store,internals,client,dispatched}=await fixture(t);
  await internals.dispatchReadyRetries(config,client,[],new WorkspaceManager(config.workspace),{remaining:1});
  assert.equal(dispatched.length,1,'The restored PR retry must launch');
  assert.equal(dispatched[0]?.mode,'pr-review');
  assert.equal(dispatched[0]?.attempt,2);
  assert.equal(dispatched[0]?.prReview?.pr_number,42);
  assert.equal(store.listRetries('app').length,0);
});

test('closed PR retries are released and unavailable PR lookups retain their retry',async t=>{
  await t.test('closed',async t=>{
    const {config,store,internals,client}=await fixture(t,{closed:true});
    await internals.reconcileDurableRetries(config,client);
    assert.equal(store.listRetries('app').length,0);
  });
  await t.test('unavailable',async t=>{
    const {config,store,internals,client}=await fixture(t,{unavailable:true});
    await internals.reconcileDurableRetries(config,client);
    assert.equal(store.listRetries('app').length,1);
  });
});

test('ordinary issue retries still dispatch with PR polling disabled',async t=>{
  const {config,store,internals,client,dispatched}=await fixture(t,{pr:false});
  await internals.reconcileDurableRetries(config,client);
  await internals.dispatchReadyRetries(config,client,[],new WorkspaceManager(config.workspace),{remaining:1});
  assert.equal(dispatched[0]?.mode,'autonomous');
  assert.equal(store.listRetries('app').length,0);
});
