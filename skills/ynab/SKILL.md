# YNAB (You Need A Budget)

## Purpose
Use this skill to check budget status, review account balances, query transactions, and manage category allocations in YNAB.

## Capabilities
- **Budgets**: List budgets, get budget summaries and month details.
- **Accounts**: List accounts and balances.
- **Categories**: View category groups, balances, and goals.
- **Transactions**: List, create, update, and delete transactions.
- **Payees**: Look up payees.
- **Scheduled Transactions**: View and manage recurring transactions.
- **Undo**: List recent write operations and reverse them if needed.

## Constraints
- Monetary amounts are in **milliunits** (divide by 1000 for display: 294230 → $294.23).
- Always confirm before creating or deleting transactions.
- Use `last-used` as the budget ID unless the user specifies a different budget.
- Respect the 200 requests/hour rate limit — prefer batch queries when possible.

## Setup
- Set `YNAB_API_TOKEN` to your YNAB Personal Access Token.
- Enable and sync:
  - `npm run butler -- skills enable ynab`
  - `npm run butler -- skills sync --target ynab`
