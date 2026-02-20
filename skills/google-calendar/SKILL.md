# Google Calendar

## Purpose
Use this skill to read availability, create events, and update schedules.

## Constraints
- Confirm before creating, deleting, or moving events.
- Respect user timezone and use ISO timestamps.

## Setup
- Install OpenClaw's Google CLI (`gog`) on the worker host.
- Authenticate once with:
  - `gog auth login`
  - `gog auth list`
- For headless droplet deployment, run login on a machine with a browser, then copy `~/.gog/` to the droplet user home.
- Optional account pinning:
  - `gog --account "<email-or-alias>" cal --days 7`

## Common Commands
- `gog cal --days 7`
- `gog cal --from 2026-02-20 --to 2026-02-27`
- `gog cal work` (query a specific calendar by name)
