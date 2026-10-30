import { parsePauseRequest } from '../orchestrator/pauseProtocol.js';
import type { BridgeTask } from './bridge.js';

export interface Activity {
  repo: string;
  key: string;
  kind: 'completed' | 'merged' | 'failed' | 'cancelled' | 'paused' | 'followup' | 'notice' | 'retrying' | 'loop_completed' | 'loop_failed' | 'loop_paused' | 'loop_retrying';
  url?: string;
  detail?: string;
}
export interface ActivityBatch { repo: string; cursor: number; activities: Activity[] }
export interface NotificationState {
  cursors: Record<string, number>;
  observed?: Record<string, string>;
  startedAt?: string;
  pending: Record<string, Activity>;
  lastBriefDate: string;
}
export interface NotificationOptions { now?: () => Date; timeZone?: string; hour?: number }

export function localSchedule(now: Date, timeZone = 'America/Toronto') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hourCycle:'h23' }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return { date: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) };
}
export const short = (text: string, limit: number) => text.replace(/\s+/g, ' ').trim().slice(0, limit);
export const repoFor = (key: string) => key.slice(0, key.lastIndexOf('#'));

export function questionText(task: BridgeTask): string {
  const pause = parsePauseRequest(task.lastMessage);
  return `${pause ? short(pause.question, 400) : 'The agent needs input. See the GitHub issue for the question.'}${pause?.options.length
    ? '\n' + pause.options.slice(0, 3).map(option => `• ${short(option, 90)}`).join('\n') : ''}\nReply here to answer and resume.${(pause?.options.length ?? 0) > 3 ? ' More choices are on GitHub.' : ''}`;
}
export function requiredAction(task: BridgeTask): { key: string; text: string; question: boolean } | null {
  if (task.state.status === 'paused') {
    if (task.state.pause_reason === 'needs-info') return { key:`question:${task.state.session_id}:${task.lastMessage}`, text:questionText(task), question:true };
    return { key:`paused:${task.state.session_id}`, text:'Human attention needed. Open the GitHub issue to handle the handoff or decision.', question:false };
  }
  const credentialFailure = /invalid api key|bad credentials|authentication failed|not authenticated|token (?:has )?expired|(?:please|must) (?:log|sign) in/i.test(
    `${task.state.last_error ?? ''}\n${task.state.retry_reason ?? ''}\n${task.lastMessage}`);
  if (['failed','retry-wait'].includes(task.state.status) && credentialFailure) return {
    key:'credentials', text:`${short(task.state.agent_provider ?? 'Agent', 40)} authentication needs attention. Fix its login or credentials, then reply here to retry.`, question:false,
  };
  if (task.state.status === 'failed' && (!task.state.preparation_incomplete || task.state.loop_id)) return {
    key:`failed:${task.state.session_id}`, text:'Task stopped after automatic retries. Check the GitHub issue and reply with follow-up instructions.', question:false,
  };
  return null;
}

export function recordActivity(state: NotificationState, activity: Activity): void {
  if (activity.kind === 'loop_completed') for (const kind of ['loop_failed','loop_paused','loop_retrying']) delete state.pending[`${activity.repo}:${kind}:${activity.key}`];
  if (activity.kind === 'completed') delete state.pending[`${activity.repo}:failed:${activity.key}`];
  state.pending[`${activity.repo}:${activity.kind}:${activity.key}`] = activity;
}
export function taskActivities(task: BridgeTask): Activity[] {
  const repo = repoFor(task.key), kind = task.state.status;
  if (task.state.loop_id) {
    const status = ({completed:'loop_completed',failed:'loop_failed',paused:'loop_paused','retry-wait':'loop_retrying'} as Record<string,Activity['kind']>)[kind];
    return status ? [{repo,key:task.key,kind:status,detail:task.state.loop_id}] : [];
  }
  if (kind === 'retry-wait' && task.state.preparation_incomplete && (task.state.preparation_failure_count ?? 0) > 0) return [{repo,key:task.key,kind:'retrying',url:task.state.issue_url ?? undefined}];
  if (!['completed','failed','cancelled','paused'].includes(kind)) return [];
  const result: Activity[] = [{repo, key:task.key, kind:kind as Activity['kind'], url:task.state.issue_url ?? undefined}];
  if (kind === 'completed' && /follow.up/i.test(task.lastMessage)) {
    for (const url of new Set(task.lastMessage.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+/g) ?? [])) {
      if (url !== task.state.issue_url) result.push({repo, key:url, kind:'followup', url});
    }
  }
  return result;
}

/** One bounded message; raw agent output and logs never enter the brief. */
export function formatBrief(pending: Activity[], date: string): string {
  const groups = new Map<string, Activity[]>();
  for (const activity of pending) groups.set(activity.repo, [...groups.get(activity.repo) ?? [], activity]);
  const labels: Record<Activity['kind'], string> = {merged:'PRs merged',completed:'runs completed',failed:'failures',cancelled:'cancelled',paused:'awaiting input',followup:'follow-ups',notice:'storage updates',retrying:'setup retries',loop_completed:'scheduled passes completed',loop_failed:'scheduled failures',loop_paused:'scheduled questions',loop_retrying:'scheduled retries'};
  const sections: string[] = [`Symphony daily brief · ${date}`];
  for (const [repo, activities] of [...groups].sort(([a],[b]) => a.localeCompare(b))) {
    const counts = new Map<Activity['kind'], number>();
    for (const a of activities) counts.set(a.kind,(counts.get(a.kind) ?? 0)+1);
    const summary = `${short(repo, 60)}\n${[...counts].map(([kind,count]) => `${count} ${labels[kind]}`).join(' · ')}`;
    if (sections.join('\n\n').length + summary.length > 2700) { sections.push('Additional repository activity is available on GitHub.'); break; }
    const loopDetails = activities.filter(a=>a.kind.startsWith('loop_')).slice(0,3).map(a=>`${short(a.detail ?? a.key,70)}: ${a.kind.slice(5).replace('retrying','retry scheduled')}`);
    const links = [...new Set(activities.sort((a,b) => (a.kind === 'merged' ? -1 : 1)-(b.kind === 'merged' ? -1 : 1)).map(a => a.url).filter((url):url is string => Boolean(url)))].slice(0,2);
    sections.push(`${summary}${loopDetails.length ? '\n'+loopDetails.join(' · ') : ''}${links.length ? '\n'+links.map(url => short(url,180)).join('\n') : ''}`);
  }
  return sections.join('\n\n');
}
