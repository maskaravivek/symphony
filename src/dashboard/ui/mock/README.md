# Dashboard mock fixtures

Open the UI with `?mock=1` and every API call is answered from this folder
instead of the server. No EventSource is opened; the live indicator shows
"Mock data".

```sh
cd src/dashboard && python3 -m http.server 8765 --bind 127.0.0.1
open 'http://127.0.0.1:8765/ui/index.html?mock=1#/'
```

Serve `src/dashboard` (not `src/dashboard/ui`), because the page references
`/ui/styles.css`, `/ui/app.js` and `/ui/mock/*.json`. Against the real dashboard
server, `http://127.0.0.1:<port>/?mock=1` works too.

## URL to fixture mapping

`lib/mock.js` (`mockCandidates`) tries each candidate in order and uses the
first one that exists. Any 404s you see in the console are those misses.

| API request | Fixture candidates |
| --- | --- |
| `/api/overview` (with or without `?github=1`) | `overview.json` |
| `/api/repos/:id` | `repo-<id>.json`, then `repo.json` |
| `/api/tasks/:repo/:issue` | `task-<repo>-<issue>.json`, then `task.json` |
| `/api/tasks/:repo/loop/:loopId` | `task-<repo>-loop-<loopId>.json`, then `task-loop.json` |
| `/api/history?days=N` | `history-<N>.json`, then `history.json` |
| `/api/events` (no `before`) | `events.json` |
| `/api/events?before=…` | `events-older.json` |
| `/api/agent-log?path=…` (no `after`, or `after=0`) | `agent-log.json` |
| `/api/agent-log?path=…&after=N` (N > 0) | `agent-log-more.json` |
| `/api/artifact?path=/…/<basename>…` | `artifact-<basename>.json`, then `artifact.json` |

Path segments are reduced to `[A-Za-z0-9._-]` (anything else becomes `_`).

## Timestamps

Every fixture is written relative to `MOCK_ANCHOR` (`2026-11-10T15:00:00.000Z`,
also the `generated_at` of each fixture). When a fixture loads, every ISO
timestamp in it is shifted by `now - MOCK_ANCHOR`, so "18m ago", elapsed timers
and "next run in 4m" stay realistic whenever you open the page.

## What the fixtures cover

- `overview.json`: 8 repositories (2 `bad`, 3 `warn`, 1 disabled `unknown`),
  10 attention items across 10 reasons, 3 running tasks with `last_activity` and
  usage, and 4 coordinating epics.
- `repo.json`: `mdedit` with a 5-slot pool (one protected, one retry-wait, one
  idle) plus a loop slot, a 2-entry retry queue (one setup failure), 2 loops,
  3 pull requests, 16 tasks (4 closed), 2 epics with children, and recent events.
- `task.json`: `mdedit#1144` (failed) with a 12-entry timeline, 2 sessions
  (grooming, then autonomous), a grooming result, verification and commands.
- `task-mdedit-1162.json`: a running task. Open its Agent log tab to see Follow
  append `agent-log-more.json` after about 3s.
- `task-loop.json`: a paused loop that asked a question.
- `history.json`: 4 weeks for 3 repositories.
- `events.json` / `events-older.json`: two pages of events. The second page ends
  with `next_before: null`.
- `agent-log.json`: thread, turn, message, reasoning, command (exit 0 and exit 1),
  tool and error items.
- `artifact-*.json`: last message (markdown, including a `<script>` line that
  must render as text), prompt, stderr tail and verification JSON.

All fixtures are type-checked against `src/status/dashboardTypes.ts` by hand
(see the UI agent report). Regenerate or edit them by hand; keep shapes exact.
