# Telegram Control Plane

## Goal
Provide a safe, owner-governed Telegram interface for task execution and status tracking.

## Commands
- `/task <request>`: queue a normal task.
- `/run <command>`: queue a command job that requires approval.
- `/approve <jobId>`: approve a pending command job.
- `/abort <jobId>`: abort an owned or authorized job.
- `/status`: view gateway status plus current chat/thread session context.
- `/status <jobId>`: view job status and recent progress.
- `/context`: show current chat/thread session key, generation, and timestamps.
- `/new [prompt]`: rotate session context for this chat/thread; optionally run a prompt in the new session.
- `/reset [prompt]`: alias for `/new`.
- `/panic [status|on|off]`: owner control to pause/resume worker claims.
- Voice notes, audio files, and photos: converted to text context in gateway and queued as normal tasks.

## Policy
- Unknown users must complete pairing before they can submit tasks.
- Owners are defined via `TG_OWNER_IDS`.
- `/run` is owner-only by default and requires explicit approval.
- Non-owner visibility is limited to same-chat, same-requester jobs.
- Session context is isolated by `chatId + threadId`.
- `TG_ONLY_AGENT_OUTPUT=true` is the default and suppresses non-essential queue/ops chatter for normal task completions.
- `TG_MEDIA_ENABLED=true` is the default; when enabled, `OPENAI_API_KEY` is required for voice/photo understanding.

## Acceptance Criteria
- Paired users can submit `/task` and receive status updates.
- Unpaired users are given pairing instructions and blocked from execution.
- `/run` jobs never execute without approval.
- `/status` returns both admin pause state and current session identity for the active chat/thread.
- `/new` and `/reset` always increment session generation and change the resulting `sessionKey`.
- Panic mode prevents new claims until resumed.
- Paired users can submit voice notes/audio files/photos and have them processed as tasks.
