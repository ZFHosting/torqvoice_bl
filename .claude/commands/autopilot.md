---
description: Build the whole fork plan unattended, milestone after milestone, until every milestone is done or blocked on a human
---

You are the autonomous builder for the BlueLabel fork of Torqvoice. Work through the entire plan in
`docs/fork/PLAN.md` without waiting for me, and keep going until every row of the Milestones table in
`docs/fork/PROGRESS.md` is `done`, `provisional` or `blocked`. I'm not watching. Don't ask me questions
in chat: record them as blockers and move on to work that isn't blocked.

## Every time you start, resume or come back from a context compaction
1. Read `docs/fork/PROGRESS.md` first. It's your memory. Then `AGENTS.md`, `docs/fork/FORK.md`, and
   `docs/fork/PLAN.md` §3.
2. Continue from **Current step**. Never redo work the ledger marks done.

## Choosing what to do next
Take the first `todo` or `in_progress` row in the Milestones table whose dependencies (PLAN.md §3) are
`done` or `provisional`. If the next row is blocked or waiting on a dependency, skip to the next one that
isn't. The API track (A*) doesn't depend on Shopmonkey, so it's always available once M1 is done.

## How to run a milestone (this overrides `/milestone`'s "wait for approval")
1. `git checkout fork/integration` (create it from the current default branch if it doesn't exist),
   then `git checkout -b fork/<id>-<slug>`.
2. Read the brief `docs/fork/milestones/<id>-*.md` and everything under its "Read first". Write your plan
   into **Current step** in `PROGRESS.md` instead of asking me to approve it. Set the row to `in_progress`.
3. Build it test-first against the brief's acceptance list. Commit in small steps with clear messages.
   Update **Current step** in `PROGRESS.md` after each meaningful step, so a fresh session could carry on.
4. Run the definition of done from `FORK.md`. Fix failures until it passes. If you're truly stuck on a
   single failure after 3 different approaches, write it up as a blocker, mark the row `blocked`, and move on.
5. Run the `migration-reviewer` subagent on the branch. Fix every must-fix item, then run it again until
   it says **ready for PR**.
6. Merge into `fork/integration` with `git merge --no-ff`. If `origin` exists, push both the milestone
   branch and `fork/integration` to it. Never push to the default branch, never force-push, never
   merge pull requests.
7. Set the row to `done` (or `provisional`, see below), record the branch, clear **Current step**, and
   add any decisions to the **Decisions log**. Commit the ledger on `fork/integration`. Then go straight
   to the next milestone.

## When something needs a human
These need me. Don't fake them, just route around them:
- **No `SHOPMONKEY_API_KEY` in the environment:** do M0's hygiene and the Torqvoice spikes (T1–T7). For the
  Shopmonkey spikes, build **synthetic** fixtures from the shapes in `MAPPING.md` and shopmonkey.dev,
  in `src/__tests__/features/integrations/fixtures/shopmonkey/synthetic/`, clearly labelled as synthetic.
  Mark every code path that relies on an unconfirmed **[M0]** fact with a `// PROVISIONAL(M0:Sx)` comment,
  and list them under **Re-verify with real Shopmonkey data**. Mark M0 and every milestone built on those
  fixtures `provisional`, not `done`, and raise a blocker asking for the key.
- **Open questions in PLAN.md §6, status-to-stage mappings, staff logins, licensing:** take the
  conservative default the docs describe. Record it in the **Decisions log** and raise a blocker so I
  can confirm.
- **Anything irreversible or outside the dev environment** is never done by you: running a load against
  any database other than the local dev or test database, running `cutover` against a real connection,
  writing to Shopmonkey, deleting branches, changing the default branch, `prisma migrate deploy`,
  `prisma db push`, or sending real email or SMS. Build and test these against the mock server and the
  test database only.

## Rules that always apply
- Everything in `FORK.md` and `AGENTS.md`. Shopmonkey is read-only. No real customer data or secrets in
  commits, logs or the ledger. Fork code stays in fork folders.
- Don't weaken a test to make it pass. Don't skip, delete or `.only` tests. Don't mark an acceptance item
  done without evidence (test name or command output) noted in the ledger.
- Merge upstream only at the start of a milestone, and only if `git merge upstream/main` is clean. If it
  conflicts, abort the merge, raise a blocker, and carry on without it.
- If you notice the plan is wrong (a brief contradicts the code), fix the brief or `MAPPING.md` in the
  same branch and log it under **Decisions log**. Don't silently diverge.

## When to stop
Only when no row is `todo` or `in_progress`. Then write a final summary at the top of `PROGRESS.md`:
what's done, what's provisional and why, every blocker with exactly what you need from me, and the
commands to run to verify. Commit it.
