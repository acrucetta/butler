# YNAB (You Need A Budget)

## Purpose
Use this skill to check budget status, review account balances, query transactions, and manage category allocations in YNAB.

## Usage
Run `ynab --help` to see all available commands. Common examples:

```bash
# List all budgets
ynab list-budgets

# Get budget summary for current month
ynab budget-summary

# Get unapproved transactions
ynab get-unapproved-transactions

# Create a transaction
ynab create-transaction --account-id <id> --date 2026-02-24 --amount 10.99 --payee-name "Store"
```

## Constraints
- Always confirm before creating or deleting transactions.
- Monetary amounts returned are in **milliunits** (divide by 1000 for display: 294230 → $294.23).
- Respect the 200 requests/hour rate limit — prefer batch queries when possible.

## Setup
- Set `YNAB_API_TOKEN` to your YNAB Personal Access Token.
- Enable and sync:
  - `npm run butler -- skills enable ynab`
  - `npm run butler -- skills sync --target ynab`
