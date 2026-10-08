# External reproduction record — TEMPLATE

> Record-C scaffold. A third party who runs the pack per `INVITATION.md`
> copies this file to `runs/<YYYY-MM-DD>-external-<org-or-name>.md`, fills
> every field, and attaches the raw artifacts. The pack maintainers do NOT
> fill this on the runner's behalf, and an empty template never upgrades any
> gate: R-EXT stays `PENDING-EXTERNAL` until a filled record with raw bytes
> lands here.

```markdown
# IF-07c external reproduction record

- **Runner (person / org):** <name, affiliation; or "anonymous" with a
  contact handle the maintainer can verify>
- **Run date (UTC):** <YYYY-MM-DDThh:mm:ssZ>
- **Pack version / tag:** <e.g. v1.2.0> — pack repo commit you ran: <sha>
- **Case set:** <from ARTIFACTS.json → caseSet.id>
- **OS / arch:** <e.g. Ubuntu 24.04, arm64>
- **Node:** <node --version> **npm:** <npm --version>
- **Install method:** <"npm ci" from the pack lockfile / other — describe>
- **npm ls output (paste):**
  ```
  <npm ls @wasmagent/core @wasmagent/mcp-firewall @wasmagent/mcp-gateway zod>
  ```
- **Independently fetched integrity** (npm view <pkg>@<ver> dist.integrity):
  - @wasmagent/core: <sha512-…>
  - @wasmagent/mcp-firewall: <sha512-…>
  - @wasmagent/mcp-gateway: <sha512-…>
- **SHA256SUMS check:** <"sha256sum -c SHA256SUMS" output summary — N OK / 0 fail>
- **Runner command:** <exact command line>
- **Exit code:** <0 / other>
- **Per-claim results (paste the runner's `# claims executed:` line):**
- **results.json:** <attach the file the runner generated>
- **Raw stdout/stderr:** <attach, unedited>
- **Deviations from the procedure:** <any — or "none">
- **Statement:** <e.g. "I ran the unmodified pack from tag v1.2.0 and report
  the unedited output above.">
```

## Maintainer intake checklist (do this before linking the record anywhere)

1. Recompute the pack file hashes against the tag the runner cites.
2. Re-verify the package integrity values against the registry yourself.
3. Check the per-claim line matches `expected-results.json`'s case set and
   that the exit code agrees with the per-claim verdicts.
4. Record the verdict level as **externally-reproduced** only — never
   "independently verified" (that requires a separately designed test or
   analysis; see CLAIM-BOUNDARY.md) and never as any form of certification.
5. Link the record from the repo's release notes or the coordination issue;
   do not rewrite earlier run records.
