# Reliability

## Reliability Targets
- Orchestrator health endpoint responds successfully during normal operation.
- Worker honors abort requests via heartbeat checks while jobs are running.
- State persistence remains recoverable after process restarts.
- Panic mode prevents workers from claiming new jobs.
- Proactive runtime enqueues heartbeat/cron/webhook jobs without duplicating active runs per trigger.
- Worker model routing can fail over to alternate profiles on retryable model/provider errors.

## Failure Modes
- Invalid or missing env configuration blocks service startup.
- Orchestrator state file corruption can reset queue state.
- Worker runtime errors can fail a job before completion.
- Telegram/API connectivity issues can delay command processing.
- Invalid proactive config blocks orchestrator startup to avoid silent misfires.
- Invalid model routing profile/env mapping can block worker startup.
- Invalid tool policy config can block worker startup.

## Operational Checks
- Startup checks: `npm run doctor`
- Harness + build checks: `npm run verify:harness`
- Smoke run (mock mode): `npm run up`

## Recovery Patterns
- Use `/panic on` before risky maintenance.
- Restart only affected service first, then run `/status` for control-plane health or `/status <jobId>` for a specific job.
- If state persistence is suspected, inspect `.data/orchestrator/state.json` and events.
