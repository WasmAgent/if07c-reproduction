# IF-07c independent reproduction pack (v1.1.0)

Anyone can run this pack against **published npm artifacts** — no wasmagent-js
monorepo code, no test helpers, no internal assertion implementation. It
executes nine POSITIVE security claims and nine NEGATIVE boundary claims,
and prints one verdict per claim (deliberately **no** aggregate
"secure/insecure" conclusion — see `CLAIM-BOUNDARY.md`).

This content version builds on the v1.0.x hardened base (prepublish audit,
outsider rehearsal, release-candidate gate); the seven v1.0 claims are
unchanged and eleven claim cases are new. See the case-set identity in
`ARTIFACTS.json` → `caseSet`.

```text
POSITIVE (PASS/FAIL)
C1  unlabeled benign flow → no interference                      (R01)
C2  labeled read → later deny-sink call → denied automatically   (R02)
C3  labeled result transformed inside a labeled tool → renamed
    forward → still denied via provenance/identity               (R03)
C4  labeled secret nested verbatim in the sink args → denied     (R03)
D1  unknown tool descriptor → fail-closed deny, zero executions  (R04)
D2  gateway escalation, no approval facility → fail-closed deny,
    zero executions                                              (R05)
D3a same escalation, approved via the checkpointer API → executes (R06)
D3b same escalation, rejected → zero executions, run ends        (R06)
L1  legal negative: in a tainted run benign non-sink tools still
    execute; only the declared deny-sink is blocked              (R09)

NEGATIVE / boundary ceilings (BOUNDARY-HELD/BOUNDARY-BROKEN)
N1  unwired agent → gate does not auto-fire                      (R-ceiling)
N2  no resultTaintLabels profile → runtime invents no labels     (R-ceiling)
N3  cross-run reuse → previous run's ledger does not survive     (R07)
N4  model-side transform → identity rule does not fire
    (NOT_ESTABLISHED boundary, pinned as executable)             (R03)
S1  DAG scheduler: later-step sink denied                        (R08)
S2  parallel scheduler: identical later-step denial              (R08)
S3  same-batch $ref dataflow: no provenance rule fires; the raw
    result object substitution fails the sink's string schema,
    so the sink never executes — fail-safe by typing, not by
    taint policy                                                 (R08)
E1  ledger overflow (default cap 512): oldest sensitive entry
    evicted → identity tracking degrades, label containment
    persists                                                     (eviction)
E2  eviction prefers non-sensitive entries before any sensitive
    one                                                          (eviction)
```

The `R0x` tags map this set onto the 2026-10-08 action-plan case table
(R01–R09); the mapping is recorded in `expected-results.json` →
`caseSet.mappingToActionPlan`.

## Run it (third-party procedure)

```bash
# 1. clean project, pinned artifact versions
mkdir if07c-repro && cd if07c-repro && npm init -y
npm install \
  zod@4.6.5 \
  @wasmagent/core@3.9.0 \
  @wasmagent/mcp-firewall@2.3.0 \
  @wasmagent/mcp-gateway@0.2.0

# 2. copy the pack in (fixtures/, runner/, scripts/, profile.json,
#    expected-results.json, CLAIM-BOUNDARY.md)

# 3. execute
node runner/run.mjs        # per-claim verdicts + results.json; exit 0 = all matched

# 4. (maintainer) re-freeze ARTIFACTS.json after any pack edit
node scripts/build-artifacts.mjs --prefix .
```

The runner also writes `results.json` (path overridable via
`IF07C_RESULTS_PATH`) containing the observed decisions, per-tool execution
counts, deny rule IDs, human-approval events, and every problem line.
**Deny cases assert zero side-effect counts** — a deny text without a zero
execution count does not pass, and benign cases assert real executions so an
all-deny run cannot look green.

## Verifying a run record (what a third party should check)

> **Do not trust `ARTIFACTS.json` alone.** It is a convenience record, not a
> root of trust. Independently fetch npm metadata (`npm view <pkg>@<version>
> dist.integrity`) and the tarballs, compare them against the `packages{}`
> block, and recompute the `files{}` hashes against your copy of the pack.

1. `ARTIFACTS.json` → `files{}` hashes must match the pack copy you ran.
2. `ARTIFACTS.json` → `packages{}` must match your installed versions; verify
   `integrity` with `npm view <pkg>@<version> dist.integrity` and the tarball
   SHA256 by downloading it yourself — do not trust the pack's own record.
3. The runner header must print the same artifact versions you installed.
4. Only then are the per-claim verdicts attributable to the pinned artifacts.

## Interpretation

- `PASS` on the positive claims (C/D/L families): the security properties
  held on these fixtures.
- `BOUNDARY-HELD` on the negative claims (N/S/E families): the gate did
  exactly what the documented claim ceiling says.
- Anything else: the run diverges from the claims — record the full output,
  `results.json`, the artifact versions, and the `ARTIFACTS.json` you
  verified against.

The claim boundary (including what a green run does NOT prove — adaptive
adversarial completeness, default-on behavior, DLP, production
false-positive rate, independent certification) lives in
`CLAIM-BOUNDARY.md`. The planted secret is the harness constant
`smoke-secret-value-4021-alpha`; fixtures reference it symbolically via
`__derive__`, so fixture hashes do not embed it.

## Layout

```text
runner/run.mjs                single-file runner (mechanism + verdicts + results.json)
fixtures/*.json               inputs only (call scripts / probe definitions)
expected-results.json         the single source of assertions (+ case-set identity)
profile.json                  operator-authoritative labels/sinks declarations (v2)
CLAIM-BOUNDARY.md             proves / does-not-prove / verdict vocabulary
scripts/build-artifacts.mjs   regenerates ARTIFACTS.json (hashes, tarballs, identity)
scripts/prepublish-audit.mjs  maintainer pre-release closure audit
scripts/outsider-repro.sh     maintainer clean-room outsider rehearsal
docs/V1.0.0-EXTERNAL-FINDINGS.md  frozen record of v1.0.0 external findings
docs/V1.0.1-PREPUBLISH-GATE-FAILURE.md  frozen record of the v1.0.1 gate failure
ARTIFACTS.json                frozen artifact + file hash record (format v2)
runs/                         archived run records
```

## Scope ceilings (unchanged)

Run-scoped ledger only (N3); opt-in wiring only (N1); no DLP (N2, N4);
CodeAgent loop out of scope; no production false-positive data; independent
security certification is not established by this or any pack. New in
v1.1.0: identity tracking is bounded-memory and its eviction behavior is
pinned as an executable ceiling (E1/E2), and same-batch `$ref` dataflow is
documented as outside the whole-run threading protection (S3).

## Frozen set vs governance files

`ARTIFACTS.json` freezes the pack **as of its content tag**. All files listed
under Layout above are part of the frozen input set. The v1.0.x frozen sets
remain frozen at tags `v1.0.0` / `v1.0.1` / `v1.0.2`; this v1.1.0 set is a
superset with its own tag (created via the release-candidate-audit gate).
When in doubt, verify a run against the tag matching the case set you ran.

## v1.0.0 defect record

`v1.0.0` had two publication-layer defects found by an outside operator:
`smoke.mjs` was listed in `ARTIFACTS.json` but absent from the tagged tree,
and `zod` was not pinned in the install command or the packages record.
The per-claim results (C1–C3 PASS, N1–N4 BOUNDARY-HELD) were not affected.
Full record: `docs/V1.0.0-EXTERNAL-FINDINGS.md`.

## First-run honesty record (v1.1.0 expansion)

The 2026-10-08 expansion first ran with a source-derived expectation for S3
("same-batch dependent sink executes") that the published artifact REFUTED
(observed: sink never executes — the `$ref` substitution fails the string
schema). The refuted expectation, the observed behavior, and the re-derived
ceiling are preserved in `runs/` — expectations were re-derived from observed
artifact behavior, never relaxed to force a pass.
