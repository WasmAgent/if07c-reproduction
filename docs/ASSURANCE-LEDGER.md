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
| v1.1.0 integrated 18-case set (2026-10-08) | PENDING RELEASE GATE — prepublish-audit A–G passed on the integration commit (120/120, local); release-candidate-audit workflow + maintainer pre-tag approval outstanding |
| v1.2.0 24-case set with permission pairs | RELEASED — release-candidate-audit run 37740151346 passed; maintainer tagged v1.2.0 at bde67ed (tree == audited candidate) |
| v1.2.0 outsider rehearsal failure propagation | FIXED in v1.2.1 — embedded check blocks now exit nonzero on any failed item; negative controls added (wrong integrity / download failure / version mismatch) |
| v1.2.1 delivery completeness | package.json + package-lock.json + SHA256SUMS added to the frozen set; install procedure unified on `npm ci` |
| v1.2.1 release-candidate verdicts | derived from the case set with exact-coverage assertion (no missing, no duplicates, nothing extra) |
| v1.2.1 | PENDING RELEASE GATE — this revision; tag only after the release-candidate-audit workflow passes on the candidate |
| v1.3.0 S4 object-sink same-batch leak | PINNED AS EXECUTABLE DEFECT — measured on 2026-10-08 (secret reached a declared network_send sink, no policy events); fix tracked by wasmagent-js RFC #505; assertion MUST flip to deny when a fixed version ships |
| premature tags (pre-gate v1.1.0/v1.2.0) | REMOVED with maintainer bypass — re-tagging only after the release-candidate gate |
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
