---
description: Start or continue a fork milestone (M0–M9, A1–A6) from its brief
argument-hint: <milestone id, e.g. M3 or A1>
---

You are working on milestone **$ARGUMENTS** of the BlueLabel fork of Torqvoice.

1. Read, in this order: `AGENTS.md`, `docs/fork/FORK.md`, `docs/fork/PLAN.md` §3, the brief at
   `docs/fork/milestones/$ARGUMENTS-*.md`, and every file listed under "Read first" in that brief.
   Also read `docs/fork/MAPPING.md` for M-milestones and `docs/fork/API.md` for A-milestones.
2. Check prerequisites: the milestones this one depends on (PLAN.md §3) are merged, and for M-milestones
   no **[M0]** marker that this milestone relies on is still open in `MAPPING.md`. If something is
   missing, stop and say what.
3. Run `git fetch upstream && git log --oneline HEAD..upstream/main | head` and tell me if upstream has
   moved since the last merge (don't merge without asking).
4. Propose a plan: the files you will create or change, the tests you will write first, and any
   question the brief leaves open. **Wait for my approval before writing code.**
5. Work test-first where the brief lists acceptance tests. Keep fork code in the fork folders and
   mark upstream edits with `/// fork:` (Prisma) or a `// fork:` comment (TypeScript).
6. Before saying you're done: run the definition of done from `FORK.md`. Then list the brief's
   acceptance items with ✅ or ❌ and evidence (test names, command output). Update `MAPPING.md` /
   `API.md` if the code changed what they say.
