# Claim boundary — what a green run of this pack proves, and what it does not

This pack executes three POSITIVE claims and four NEGATIVE boundary claims
against published npm artifacts. Read this file before citing any result.

## Proves (on the pinned fixtures, with the pinned artifact versions)

```text
C1  an unlabeled benign flow runs without interference — the gate does not
    deny what no operator ever labeled;
C2  a labeled read followed by a deny-sink call is denied automatically —
    no caller-side provenance threading;
C3  a labeled result transformed INSIDE a labeled tool and forwarded under a
    renamed argument is still denied — the deny keys on provenance labels +
    content identity, not on value shape.
```

## Proves the BOUNDARIES hold (negative group)

A negative claim's `BOUNDARY-HELD` verdict means the gate did exactly what
the documented claim ceiling says — including NOT doing things it never
claimed. These are executable ceiling assertions:

```text
N1  unwired agent  → the provenance gate does not auto-fire. Wiring is
    opt-in; an agent with no policyGateway behaves as before.
N2  no resultTaintLabels profile → the runtime does not invent secret
    labels. No DLP, no heuristic secret scanning.
N3  cross-run reuse → the ledger is run-scoped. A previous run's
    observations do not gate the next run. No process-wide taint ledger.
N4  model-side transform of an in-context secret → the IDENTITY rule does
    not fire. This detection is NOT_ESTABLISHED by design. (In this fixture
    the call is still blocked — by the label rule, because whole-run
    threading gates every later deny-sink call in the same run. The verdict
    pins the ABSENCE of identity-rule attribution, not the send's execution.)
```

## Does NOT prove

```text
adaptive adversarial completeness (this is a fixed fixture set, not a
  red-team corpus);
process-wide or cross-run taint tracking (N3 asserts the opposite);
default-on behavior (N1 asserts the opposite: opt-in only);
CodeAgent coverage (the second agent loop is unwired territory);
DLP / model-side transform detection (N4 asserts the opposite);
production false-positive rate (no real workload is exercised here);
independent security certification (a green run by ANY party — including a
  third party — is a reproduction of pinned claims, not an audit).
```

## Whole-run threading posture (documented, and visible in this pack)

The reference adapter threads the run's whole ledger on every evaluate.
Under IF-07a semantics, threading is the caller's declaration that the call
consumes data derived from those observations — so after a labeled read in a
run, later deny-sink calls are gated by the label rule even when their
arguments carry none of the labeled content (visible in N4). Legitimate
flows that must act on tainted data go through the operator-profile path
(e.g. honest sink declarations), exactly as documented in IF-07a.

## Verdict vocabulary

| Verdict | Meaning |
|---|---|
| `PASS` | positive claim: observed behavior matched expected-results.json |
| `FAIL` | positive claim: observed behavior diverged |
| `BOUNDARY-HELD` | negative claim: the gate did not exceed its documented ceiling |
| `BOUNDARY-BROKEN` | negative claim: the gate did something its ceiling says it does not do — a claim-language bug at minimum, a security regression at worst |
