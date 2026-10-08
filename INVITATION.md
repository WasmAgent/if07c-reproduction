# Independent reproduction ask — IF-07c provenance gate v1.1.0

You are invited to independently run the **IF-07c reproduction pack v1.2.0**
on the pinned published npm artifacts. This is a narrow ask: please do
**not** review WasmAgent security generally, and do not audit the
implementation. Only run the fixed pack and report what you observe.

## What you run

The pack in this repository at tag `v1.1.0` (see `ARTIFACTS.json` and the
release notes for the frozen hashes; the earlier 7-case set remains frozen
at `v1.0.0`). It drives nine positive claims and nine negative boundary
claims through a scripted agent loop and direct gateway-API probes built
entirely on published `@wasmagent/core`, `@wasmagent/mcp-firewall`, and
`@wasmagent/mcp-gateway` packages — no monorepo code, no test helpers.

## Procedure

1. Verify your copy: recompute the SHA256 of every file listed in
   `ARTIFACTS.json` → `files{}` and compare. **Do not trust
   `ARTIFACTS.json` alone** — independently fetch npm metadata
   (`npm view <pkg>@<version> dist.integrity`) and the tarballs, and compare
   against `packages{}`.
2. In a clean directory, install exact pinned versions:
   ```bash
   npm install \
     zod@4.6.5 \
     @wasmagent/core@3.9.0 \
     @wasmagent/mcp-firewall@2.3.0 \
     @wasmagent/mcp-gateway@0.2.0
   ```
   (or the versions recorded in `ARTIFACTS.json` → `packages{}`).
3. Run `node runner/run.mjs`.
4. Record everything listed under "Report format" below.

## Report format (per claim only)

Report exactly these fields for each of the 24 claims (C1–C4, D1–D3b, L1,
N1–N4, S1–S3, E1–E2, P1–P4b):

- `runner commit` — the commit SHA of this repository you ran
- `OS / Node version` — your environment
- `npm-resolved versions` — what npm actually installed (`npm ls @wasmagent/core`)
- `tarball integrity` — the `dist.integrity` you independently fetched
- `per-claim result` — PASS / FAIL for positive claims, BOUNDARY-HELD /
  BOUNDARY-BROKEN for negative claims, exactly as the runner prints them
- `raw output` — the complete, unedited runner output, plus the
  `results.json` it generated

## Please do NOT

- Do not summarize the result as "secure" / "passed security" — the pack
  deliberately emits no aggregate verdict, and neither should the report.
- Do not modify the fixtures, expected-results.json, or the runner before
  the run. If you believe a fixture is wrong, run it unmodified first and
  file the observation separately.
- Do not re-run with edited claims and present it as a reproduction — that
  is a new experiment, not a reproduction.

## What a green run does and does not mean

See `CLAIM-BOUNDARY.md` for the full vocabulary. In short: a full green run
reproduces the pinned claims and ceilings on the pinned artifacts — it does
not establish adaptive adversarial completeness, process-wide taint
tracking, default-on behavior, DLP, protection of same-batch dataflow by
taint policy, unbounded-run taint integrity, production false-positive
rates, or any independent security certification.
