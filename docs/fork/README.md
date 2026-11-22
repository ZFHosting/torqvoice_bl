# Fork kit: how to use it

Copy this kit into the root of your fork, so `docs/fork/` and `.claude/` land beside `AGENTS.md`.

```
docs/fork/FORK.md            rules Claude Code loads every session (via CLAUDE.md)
docs/fork/PLAN.md            the plan: architecture, milestones, order, risks, open questions
docs/fork/MAPPING.md         Shopmonkey → Torqvoice, field by field, with schema extensions X1–X6
docs/fork/API.md             the public API contract
docs/fork/milestones/*.md    one brief per milestone (M0–M9 import, A1–A6 API)
.claude/commands/milestone.md   /milestone <id>: starts a milestone from its brief
.claude/agents/migration-reviewer.md   pre-PR review against the brief and rules
```

First run:

1. `git checkout -b fork/M0-setup`
2. Open Claude Code in the repo and run `/milestone M0`. M0 wires `FORK.md` into `CLAUDE.md`, adds the
   license notice and upstream remote, and runs the Shopmonkey spikes. The spike scripts need a Shopmonkey
   API key in `SHOPMONKEY_API_KEY`, created by a Shopmonkey admin. Keys carry their creator's
   permissions and there's no read-only key type, so the read-only guarantee comes from the client code,
   which refuses writes.
3. Review `docs/fork/spikes/RESULTS.md`, answer the open questions in `PLAN.md` §6, merge.
4. Then M1. After M1, run the import track (M2→M8) and the API track (A1→A6) in parallel.

Every milestone ends with: ask the `migration-reviewer` agent to review the branch, then a PR.

## Unattended run (`/autopilot`)

`/autopilot` (`.claude/commands/autopilot.md`) builds every milestone in order without waiting for
approval, using `docs/fork/PROGRESS.md` as its memory. The Stop hook in `.claude/settings.json`
(`.claude/hooks/keep-going.sh`) refuses to let Claude stop while any milestone is `todo` or
`in_progress`. It lets Claude stop when:
- everything is `done`, `provisional` or `blocked`;
- you `touch .claude/STOP`; or
- three stop attempts in a row made no progress (same ledger, commit and working tree).

Run it in tmux so you can check in:

    claude --permission-mode auto -n bluelabel-autopilot
    > /autopilot

or headless, with a spend cap (print mode only):

    claude -p "Read .claude/commands/autopilot.md and follow it exactly." \
      --permission-mode auto --max-budget-usd <cap> \
      --output-format stream-json --verbose > autopilot.log

Rerunning either command resumes from `PROGRESS.md`. Upstream ignores `.claude/`; M0 un-ignores the kit
folders so they're versioned.
