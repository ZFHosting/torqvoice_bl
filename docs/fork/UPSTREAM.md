# Merging upstream Torqvoice

The fork pulls upstream regularly, at the **start** of a milestone, so fork work is always built on a
recent upstream. Fork code lives in its own folders (`FORK.md`, "Keeping upstream mergeable"), so most
merges are clean.

## One-time setup

```bash
git remote add upstream https://github.com/Torqvoice/torqvoice.git
git fetch upstream
```

## The routine

```bash
git checkout fork/integration
git fetch upstream
git log --oneline HEAD..upstream/main      # what's new; read anything touching prisma/ or an Actions/ file
git merge upstream/main                    # never rebase: the fork's history is shared
```

If the merge stops on conflicts:

1. **Resolve the `/// fork:` lines first.** They mark every fork column and back-relation added to an
   upstream Prisma model (and `// fork:` comments mark fork edits in upstream TypeScript). Keep upstream's
   version of the model and re-add the fork lines beneath their markers.
2. **Never edit an applied migration.** If upstream added migrations, keep them all; fork migrations
   (`fork_*`) are separate folders and don't conflict. If both sides changed the same model, check
   that the fork's migration still applies after upstream's (`npx prisma migrate dev` on a scratch DB).
3. **Server actions moved into domain services (A2).** If upstream changed an action whose body the fork
   moved into `src/features/<domain>/Lib/<domain>Service.server.ts`, apply upstream's change to the
   service, and keep the action's name and input exactly as upstream has them.
4. Anything you can't resolve cleanly: `git merge --abort`, raise it in `docs/fork/PROGRESS.md` under
   **Blockers**, and carry on without the merge.

After the merge (clean or resolved):

```bash
npm ci                                     # upstream may have changed dependencies
npx prisma generate                        # the client must match the merged schema
npx prisma migrate dev                     # apply upstream's new migrations to the dev database
npx tsx scripts/generate-tenancy-schema.ts # if upstream or the fork changed any model
```

Then run the definition of done from `FORK.md` (`npm run check`, `npm test`, `tsc`, `npm run test:db`)
and commit the merge on its own, with the upstream commit range in the message.

## What not to do

- Don't reformat upstream files, and don't fix upstream lint in a merge commit.
- Don't `prisma migrate deploy` or `prisma db push` anywhere but a production deploy.
- Don't force-push `fork/integration`.
