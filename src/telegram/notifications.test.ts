import assert from 'node:assert/strict';
import test from 'node:test';
import {formatBrief,localSchedule,type Activity} from './notifications.js';

test('9am Toronto follows daylight saving changes',()=>{
  assert.deepEqual(localSchedule(new Date('2026-10-30T13:00:00Z')),{date:'2026-10-30',hour:9});
  assert.deepEqual(localSchedule(new Date('2026-11-01T13:59:00Z')),{date:'2026-11-01',hour:8});
  assert.deepEqual(localSchedule(new Date('2026-11-01T14:00:00Z')),{date:'2026-11-01',hour:9});
});
test('daily brief remains bounded with many repositories and links',()=>{
 const activities:Activity[]=Array.from({length:80},(_,index)=>({repo:`repo-${index}`,key:`repo-${index}#1`,kind:'completed',url:'https://github.com/owner/repo/issues/123'}));
 const brief=formatBrief(activities,'2026-10-30');
 assert.ok(brief.length<4000);assert.match(brief,/Additional repository activity/);
});
