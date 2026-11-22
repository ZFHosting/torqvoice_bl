# Notice: this is a modified version of Torqvoice

This repository is a **modified copy** of [Torqvoice](https://github.com/Torqvoice/torqvoice), which is
licensed under the [Elastic License 2.0](LICENSE). It is not the original software and is not
published or supported by Torqvoice's authors.

- **Changed by:** ZF Hosting ([github.com/ZFHosting](https://github.com/ZFHosting)), for the BlueLabel
  build of Torqvoice.
- **Based on:** Torqvoice `main`, merged regularly from upstream (see `docs/fork/UPSTREAM.md`).

## What was changed

1. **A Shopmonkey importer.** A connector that copies a shop's full history out of Shopmonkey
   (read-only) into Torqvoice, keeps it in sync until cutover, and reports on whether anything was lost
   (`src/integrations/shopmonkey/`, `src/features/shopmonkey-import/`).
2. **A public REST API.** Key-authenticated endpoints under `/api/v1/` so other systems can read and
   write the workshop's data (`src/features/public-api/`).
3. **Schema additions** that support both (`prisma/schema/fork.prisma`, and nullable columns on a few
   upstream models marked `/// fork:`).

The plan and the rules for these changes are in `docs/fork/`.

## Licensing

Torqvoice's licence, copyright and other notices are kept unchanged. The [Elastic License 2.0](LICENSE)
applies to this modified copy as it does to the original, including its limitations on providing the
software to third parties as a hosted or managed service and on circumventing license-key
functionality.
