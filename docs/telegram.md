# Telegram communication bridge

TaskDrop creates GitHub captures with `requires-grooming`. Symphony grooms them before implementation. Telegram can also create captures with `/new <repo> <task>`. This optional bridge sends action-required alerts and a concise daily activity brief to a private Telegram chat. Replies become GitHub issue comments and eligible tasks are requeued. It runs alongside Symphony on the **same host**, using the same workflows and workspace roots; it does not start coding agents itself.

## Setup

1. Create a bot through Telegram's official [@BotFather](https://t.me/BotFather), using `/newbot`.
2. Save its token in an owner-readable file outside the repository, for example `~/.config/symphony/telegram-token`. Set its permissions with `chmod 600`. Alternatively, set `SYMPHONY_TELEGRAM_BOT_TOKEN` in the bridge process environment. Do not put tokens in command arguments, Git, screenshots, or chat messages.
3. Build Symphony with `yarn install --frozen-lockfile && yarn build`.
4. Pair your Telegram account. Run this on the Symphony host (expand paths for your installation):

```sh
node bin/symphony.js telegram-pair \
  --token-file "$HOME/.config/symphony/telegram-token" \
  --state-dir "$HOME/.config/symphony/telegram-state"
```

Open the bot link printed in the terminal and send the exact `/start <one-time-code>` message it prints. Pairing expires after five minutes. This saves your numeric chat/user IDs locally; only that user in that private chat will be accepted. Keep the code private. Pair before starting the bridge, and run only one polling process per bot. Bots configured with a webhook must have that webhook removed before long polling can work.

5. Start the bridge alongside your existing orchestrator:

```sh
node bin/symphony.js telegram \
  --config /absolute/path/to/symphony.config.yml \
  --token-file "$HOME/.config/symphony/telegram-token" \
  --state-dir "$HOME/.config/symphony/telegram-state"
```

For a single repository, replace `--config` with `--workflow /absolute/path/to/WORKFLOW.md`. Workflows use the same GitHub credentials as Symphony. Explicit `--chat-id` and `--user-id` can replace pairing. The state directory is bound to the bot, authorized account, and config path. Retain it across restarts; use a different directory for another bot/configuration. Restart the bridge after changing repository configuration.

For macOS background operation, adapt [`ops/com.mangoappstudio.symphony-telegram.plist.example`](../ops/com.mangoappstudio.symphony-telegram.plist.example) with absolute paths. Install it on the host running Symphony, under `~/Library/LaunchAgents/`, then load it with `launchctl bootstrap gui/$(id -u) /absolute/path/to/the.plist`. Create its log directory first. Keep the existing Symphony service running.

## Use

- `/repos` lists enabled repository IDs, their GitHub repositories, and aliases.
- `/new taskdrop Improve the capture screen` creates a GitHub issue in that configured repository. Replace `taskdrop` with a name or alias from `/repos`. Names are case-insensitive. Unique substrings also work; ambiguous matches list the candidates without creating an issue. Exact names take precedence. Multiword aliases need no quotes, for example `/new camera coach Improve framing tips`. Multiline requests are supported, up to 8000 characters; the first line becomes the title (up to 180 characters), and the entire request is preserved in the body.
- Short names: `mdedit`, `pdfkit` → `pdfkit.app`, `camera coach` → `ai-photographer`, `taskdrop`, `ratelens`, `aarti` → `myaarti`, and `calculator` → `freecalculator`. Aliases only apply to enabled, configured repositories. `markdownlist` remains available.
- Captures receive only `requires-grooming`. When the orchestrator runs, it gathers context, asks clarification questions if necessary, and adds readiness/routing labels through the existing grooming flow. The bridge itself does not launch agents. Reply to the capture confirmation with more text or images, even before grooming starts.
- `/intakes` shows the last ten Telegram captures and checks any unconfirmed creations again.

- `/questions` sends current questions again, including any that existed before the bridge started.
- Reply directly to a question to record your answer and requeue the paused issue.
- Reply to an outcome with follow-up instructions to request another run of an open, eligible issue.
- `/status` lists known task statuses. `/help` explains the available commands.
- Questions and intervention-required failures notify immediately. Routine completions, cancellations, automatic retries, and recovery are collected for the daily brief. Existing historical outcomes are baselined on first observation. Completed runs and merged PRs are reported separately; completing a run does not imply its PR merged.

The repository ID and issue number are attached to every task message. Replies use persisted message IDs, so identical issue numbers in different repositories cannot be confused. Unknown replies and stale question replies are rejected. Only the explicit `/new` command creates issues; ordinary unthreaded messages do not.

Instructions sent while an agent runs are saved immediately and queued after the active run finishes. They are **not live steering**. The bridge checks the agent's last-consumed GitHub comment ID before requesting another run. Closed, blocked, ignored, and interactive tasks are not automatically resumed. Existing workflow concurrency, dependencies, retry limits, and review policies still apply. A queued task may therefore wait or require manual attention.

Questions raised during intake grooming use the same reply flow. The `requires-grooming` gate is retained while awaiting clarification; answering requeues grooming, and only successful grooming can queue implementation. Grooming completion appears in the daily brief; the enriched issue remains available on GitHub.

## Images

Send a photo (or a JPEG, PNG, GIF, or WebP image file) with a caption such as `/new pdfkit Fix this layout`. The issue includes the caption text and embedded image links. For multiple screenshots, send an album with one `/new` caption: the bridge buffers the album before creating one issue. Album processing may take roughly one polling cycle after the last photo (about 30 seconds). A delayed album photo is appended as an issue comment.

Reply with images to a capture confirmation, agent question, or task outcome to add context to that exact issue. A photo-only reply is supported; a caption can provide instructions. Replies to running tasks follow the existing deferred-follow-up behavior. A photo without `/new` or a known task reply is rejected before downloading or uploading it. Unsupported files and images larger than **8 MiB each** are rejected. Albums support up to ten images.

Images use TaskDrop's shared Cloudflare Worker/R2 service. The R2 bucket stays private; the Worker serves public, high-entropy image URLs so GitHub can render them. This also means images linked from private issues are publicly accessible to anyone who has the image URL, matching TaskDrop's attachment model. New uploads do not create GitHub branches or commits, and the bridge only needs GitHub issue permissions for publishing issue context.

The bridge reads `attachments.json` inside `--state-dir`, or the path supplied through `--attachment-config`. For the current host:

```json
{"url":"https://taskdrop-api.maskaravivek.workers.dev","tokenFile":"../taskdrop-upload-token"}
```

The upload token is shared only between the Worker secret and an owner-only local file (`chmod 600`); it is never posted to GitHub or embedded in an image URL. The TaskDrop apps authenticate using their GitHub user tokens instead. Server deployment is documented in TaskDrop's `backend/README.md`. When attachment configuration is absent, text commands continue working and image uploads report that configuration is needed.

The bridge downloads files through Telegram's [getFile API](https://core.telegram.org/bots/api#getfile), checks image signatures and size, and uploads with stable hashed IDs. The Worker verifies byte content on replay and prevents overwriting existing image paths with different data. The bridge verifies the public image bytes before publishing the issue/comment. Telegram bot-token URLs are never posted or persisted, and Cloudflare image URLs remain usable after Telegram download links expire. An interrupted publication can leave an unreferenced object; retry reuses the same ID. Pending albums and intake preparation survive restarts.

Stored images are durable issue context and are not automatically expired. Historical image links remain unchanged. The old Supabase project's images cannot currently be copied or verified because the project is inactive; new uploads have no Supabase dependency.

## Recovery and delivery

The bridge persists Telegram update cursors, message-to-task mappings, outcome fingerprints, and deferred follow-ups with owner-only file permissions. GitHub comments have stable update-specific markers, allowing retry without creating duplicate comments. Issue creation records a durable intent before posting, using an opaque marker in the issue body. On replay, the bridge searches GitHub's issue listing across open and closed issues for that marker. An interrupted or ambiguous issue POST is never automatically repeated. Interrupted image preparation can retry safely before issue posting starts. If creation remains unconfirmed, use `/intakes` to reconcile and check GitHub before submitting a new command. Keep the marker in the issue body for recovery. The bridge does not modify agent run-state files.

Run only one bridge per bot and state directory; a local process lock prevents duplicate instances using the same directory. Telegram sends and local state writes are not transactional: a crash after sending but before saving can duplicate a notification. Use `/questions` to recover question routing. Do not delete state to fix connectivity problems, since doing so loses routing and replay protection. GitHub/Telegram outage cycles retry after ten seconds without logging private message bodies or token-bearing URLs.

Telegram receives the task titles, links, questions, and final summaries sent through this bridge. Keep it limited to a bot and private account you control.


## Notification policy

The bridge sends immediate, concise messages only when you need to act: agent questions, interactive handoffs/decisions, credential failures, exhausted agent retries, and low/unavailable storage. Questions include a GitHub link and up to three short choices; reply as before to answer and resume. Credential alerts are deduplicated across automatic retries. Automatic setup retries, setup recovery, ordinary completions, cancellations, and storage recovery no longer generate individual messages. Commands and intake/reply acknowledgments still respond immediately to your requests.

At **9 a.m. America/Toronto** the bridge sends one brief grouped by repository, containing only repositories with new activity since the previous brief: merged PRs, completed runs, linked follow-ups, new failures or questions, setup retries, and storage updates. Quiet days produce no message. The message contains counts and a small number of GitHub links, never full agent output or logs. Use `/status` and `/questions` for on-demand detail.

Brief cursors and pending activity persist in the private Telegram state. Symphony's durable episode history preserves completion/merge activity even after workspace cleanup. Existing history is baselined when this policy is first enabled, rather than replayed as a backlog. If the bridge is offline at the scheduled hour, it sends one catch-up brief when it returns; Toronto calendar handling follows daylight saving changes. A failed send keeps the pending brief for retry. As with Telegram updates generally, a crash after Telegram accepts a message but before the state write can duplicate that message.

Override the schedule with `--brief-hour 9 --brief-timezone America/Toronto` on the `telegram` command. The hour must be 0–23 and the time zone a valid IANA zone. This schedule runs inside the existing Telegram bridge; keep that service running.

Successful replies that are saved on GitHub and requeued receive a 👍 reaction on your reply instead of a new acknowledgment message. Replies that cannot resume a task still receive the explanation, and follow-ups to an active worker still explain that the instruction has not reached the running agent yet. A failed reaction does not undo or repeat the successful resume.

## Scheduled loop questions and outcomes

Scheduled invocations appear as `<repo>#loop:<id>` in `/status` and `/questions`. A loop can pause with `SYMPHONY_PAUSE`; answer its Telegram message to queue the same invocation with your reply included in its next prompt. Successful resumes receive the same 👍 acknowledgment. Replies are stored privately on the Symphony host because a scheduled loop has no backing GitHub issue. Old questions cannot resume a newer session, and disabled loops cannot be requeued. Agent failures and setup failures retry with separate bounded budgets; exhausted failures ask for intervention. Ordinary retries stay silent and appear in the daily brief alongside loop completions, failures, questions and linked follow-ups.
