# Gmail

## Purpose
Use this skill to search, summarize, draft, and send email.

## Constraints
- Treat send/delete/archive actions as high-impact.
- Confirm recipients and subject before sending.

## Setup
- Install OpenClaw's Google CLI (`gog`) on the worker host.
- Authenticate once with:
  - `gog auth login`
  - `gog auth list`
- For headless droplet deployment, run login on a machine with a browser, then copy `~/.gog/` to the droplet user home.
- Optional account pinning:
  - `gog --account "<email-or-alias>" gmail --query "in:inbox newer_than:7d"`

## Common Commands
- `gog gmail --query "in:inbox newer_than:7d" --limit 20`
- `gog gmail --query "subject:\"invoice\" OR from:billing@" --max 10`
- `gog gmail --query "label:hey" --thread`
