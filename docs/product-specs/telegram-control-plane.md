# Telegram Control Plane

## Goal
Provide a safe, owner-governed Telegram interface for task execution and status tracking.

## Commands
- `/task <request>`: queue a normal task.
- `/run <command>`: queue a command job that requires approval.
- `/approve <jobId>`: approve a pending command job.
- `/abort <jobId>`: abort an owned or authorized job.
- `/status <jobId>`: view job status and recent progress.
- `/panic [status|on|off]`: owner control to pause/resume worker claims.

## Policy
- Unknown users must complete pairing before they can submit tasks.
- Owners are defined via `TG_OWNER_IDS`.
- `/run` is owner-only by default and requires explicit approval.
- Non-owner visibility is limited to same-chat, same-requester jobs.

## Acceptance Criteria
- Paired users can submit `/task` and receive status updates.
- Unpaired users are given pairing instructions and blocked from execution.
- `/run` jobs never execute without approval.
- Panic mode prevents new claims until resumed.
