# Telegram communication bridge

TaskDrop creates GitHub captures with `requires-grooming`. Symphony grooms them before implementation. This optional bridge forwards Symphony questions and outcomes to a private Telegram chat. Replies become GitHub issue comments and eligible tasks are requeued. It runs alongside Symphony on the **same host**, using the same workflows and workspace roots; it does not start coding agents itself.

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

- `/questions` sends current questions again, including any that existed before the bridge started.
- Reply directly to a question to record your answer and requeue the paused issue.
- Reply to an outcome with follow-up instructions to request another run of an open, eligible issue.
- `/status` lists known task statuses. `/help` explains the available commands.
- The bridge forwards new completion, failure, cancellation, and pause transitions. Historical outcomes are baselined on first observation, avoiding a backlog of old alerts. Existing questions are sent immediately. Completion messages include the agent's final output, which may contain a PR link; completion alone does not mean a PR was merged.

The repository ID and issue number are attached to every task message. Replies use persisted message IDs, so identical issue numbers in different repositories cannot be confused. Unknown replies and stale question replies are rejected. Plain unthreaded messages do not create issues.

Instructions sent while an agent runs are saved immediately and queued after the active run finishes. They are **not live steering**. The bridge checks the agent's last-consumed GitHub comment ID before requesting another run. Closed, blocked, ignored, and interactive tasks are not automatically resumed. Existing workflow concurrency, dependencies, retry limits, and review policies still apply. A queued task may therefore wait or require manual attention.

Questions raised during intake grooming use the same reply flow. The `requires-grooming` gate is retained while awaiting clarification; answering requeues grooming, and only successful grooming can queue implementation. A grooming completion notification contains the enriched brief and is distinct from implementation completion.

## Recovery and delivery

The bridge persists Telegram update cursors, message-to-task mappings, outcome fingerprints, and deferred follow-ups with owner-only file permissions. GitHub comments have stable update-specific markers, allowing retry without creating duplicate comments. It does not modify agent run-state files.

Run only one bridge per bot and state directory; a local process lock prevents duplicate instances using the same directory. Telegram sends and local state writes are not transactional: a crash after sending but before saving can duplicate a notification. Use `/questions` to recover question routing. Do not delete state to fix connectivity problems, since doing so loses routing and replay protection. GitHub/Telegram outage cycles retry after ten seconds without logging private message bodies or token-bearing URLs.

Telegram receives the task titles, links, questions, and final summaries sent through this bridge. Keep it limited to a bot and private account you control.
