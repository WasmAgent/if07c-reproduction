# IF-07c Assurance Ledger

## Implementation

| Item | Status |
|---|---|
| IF-07c implementation | CLOSED |

## Reproduction evidence

| Item | Status |
|---|---|
| v1.0.0 outside-operator claim reproduction | ESTABLISHED WITH MANIFEST EXCEPTION |
| C1 (benign-unlabeled: no block) | OUTSIDE-OPERATOR REPRODUCED |
| C2 (labeled read-to-sink: block) | OUTSIDE-OPERATOR REPRODUCED |
| C3 (labeled transform-rename-to-sink: block) | OUTSIDE-OPERATOR REPRODUCED |
| N1 (unwired-agent: no block) | OUTSIDE-OPERATOR BOUNDARY-REPRODUCED |
| N2 (no-profile-no-invention: no block) | OUTSIDE-OPERATOR BOUNDARY-REPRODUCED |
| N3 (cross-run-ledger-non-survival: no block) | OUTSIDE-OPERATOR BOUNDARY-REPRODUCED |
| N4 (model-side-transform-not-established: no block) | OUTSIDE-OPERATOR BOUNDARY-REPRODUCED |

## Pack quality record

| Item | Status |
|---|---|
| v1.0.0 manifest completeness | FAILED / 14-of-15 verifiable (smoke.mjs listed, absent) |
| v1.0.0 dependency closure | PARTIAL / zod unpinned in install procedure |
| v1.0.1 manifest closure | ESTABLISHED — prepublish-audit.mjs sections A–G passed |
| v1.0.1 dependency closure | ESTABLISHED — zod@4.6.5 pinned, all packages declared |
| v1.0.1 outsider rehearsal | FAILED — see docs/V1.0.1-PREPUBLISH-GATE-FAILURE.md |
| v1.0.1 publication closure | NOT ESTABLISHED — rehearsal failed; release sequencing defect |
| v1.0.1 independent reproduction | NOT YET ESTABLISHED |
| v1.0.2 manifest closure | ESTABLISHED |
| v1.0.2 dependency closure | ESTABLISHED |
| v1.0.2 maintainer outsider rehearsal | ESTABLISHED |
| v1.0.2 pre-tag release gate | ESTABLISHED |
| v1.0.2 publication closure | ESTABLISHED |
| v1.0.2 independent reproduction | NOT YET ESTABLISHED |

## Assurance limits

| Item | Status |
|---|---|
| independent security verification | NOT ESTABLISHED |
| certification | NOT ESTABLISHED |

## External run record

v1.0.0 run by outside operator:
https://github.com/aeoess/agent-governance-vocabulary/issues/177#issuecomment-5988754066

Runner commit: ef5dee36042e7ac378c536a44503ae899082602a

Findings: C1 PASS, C2 PASS, C3 PASS, N1–N4 BOUNDARY-HELD, exit 0.
Exception: smoke.mjs listed in ARTIFACTS.json but absent from tagged tree; zod resolved to 4.6.5 unpinned.
