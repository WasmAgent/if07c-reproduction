# IF-07c independent reproduction pack (v1)

Anyone can run this pack against **published npm artifacts** — no wasmagent-js
monorepo code, no test helpers, no internal assertion implementation. It
executes three POSITIVE security claims and four NEGATIVE boundary claims,
and prints one verdict per claim (deliberately **no** aggregate
"secure/insecure" conclusion — see `CLAIM-BOUNDARY.md`).

```text
C1  unlabeled benign flow → no interference                      (positive)
C2  labeled read → later deny-sink call → denied automatically   (positive)
C3  labeled result transformed inside a labeled tool → renamed
    forward → still denied via provenance/identity               (positive)
N1  unwired agent → gate does not auto-fire                      (negative)
N2  no resultTaintLabels profile → runtime invents no labels     (negative)
N3  cross-run reuse → previous run's ledger does not survive     (negative)
N4  model-side transform → identity rule does not fire
    (NOT_ESTABLISHED boundary, pinned as executable)             (negative)
```

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
node runner/run.mjs        # per-claim verdicts; exit 0 = all matched

# 4. (maintainer) re-freeze ARTIFACTS.json after any pack edit
node scripts/build-artifacts.mjs --prefix .
```

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

- `PASS` on C1–C3: the security properties held on these fixtures.
- `BOUNDARY-HELD` on N1–N4: the gate did not exceed its documented ceiling.
- Anything else: the run diverges from the claims — record the full output,
  the artifact versions, and the `ARTIFACTS.json` you verified against.

The claim boundary (including what a green run does NOT prove — adaptive
adversarial completeness, default-on behavior, DLP, production
false-positive rate, independent certification) lives in
`CLAIM-BOUNDARY.md`. The planted secret is the harness constant
`smoke-secret-value-4021-alpha`; fixtures reference it symbolically via
`__derive__`, so fixture hashes do not embed it.

## Layout

```text
runner/run.mjs                single-file runner (mechanism + verdicts)
fixtures/*.json               inputs only (call scripts; no expectations inside)
expected-results.json         the single source of assertions
profile.json                  operator-authoritative labels/sinks declarations
CLAIM-BOUNDARY.md             proves / does-not-prove / verdict vocabulary
scripts/build-artifacts.mjs   regenerates ARTIFACTS.json (hashes, tarballs)
scripts/prepublish-audit.mjs  maintainer pre-release closure audit
scripts/outsider-repro.sh     maintainer clean-room outsider rehearsal
docs/V1.0.0-EXTERNAL-FINDINGS.md  frozen record of v1.0.0 external findings
ARTIFACTS.json                frozen artifact + file hash record
runs/                         archived run records
```

## Scope ceilings (unchanged)

Run-scoped ledger only (N3); opt-in wiring only (N1); no DLP (N2, N4);
CodeAgent loop out of scope; no production false-positive data; independent
security certification is not established by this or any pack.

## Frozen set vs governance files

`ARTIFACTS.json` freezes the pack **as of tag `v1.0.2`**. All files listed
under Layout above are part of the frozen input set.

## v1.0.0 defect record

`v1.0.0` had two publication-layer defects found by an outside operator:
`smoke.mjs` was listed in `ARTIFACTS.json` but absent from the tagged tree,
and `zod` was not pinned in the install command or the packages record.
The per-claim results (C1–C3 PASS, N1–N4 BOUNDARY-HELD) were not affected.
Full record: `docs/V1.0.0-EXTERNAL-FINDINGS.md`.
