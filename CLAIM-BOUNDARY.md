# Claim boundary — what a green run of this pack proves, and what it does not

This pack executes nine POSITIVE claims and nine NEGATIVE boundary claims
against published npm artifacts. Read this file before citing any result.

## Proves (on the pinned fixtures, with the pinned artifact versions)

```text
C1  an unlabeled benign flow runs without interference — the gate does not
    deny what no operator ever labeled;
C2  a labeled read followed by a deny-sink call is denied automatically —
    no caller-side provenance threading;
C3  a labeled result transformed INSIDE a labeled tool and forwarded under a
    renamed argument is still denied — the deny keys on provenance labels +
    content identity, not on value shape;
C4  the verbatim secret nested inside a structured sink argument is still
    caught by the identity rule's bounded arg walk;
D1  a tool with no registered descriptor is refused fail-closed
    (descriptor-unavailable) — the gateway never guesses;
D2  a gateway ask_user escalation with no approval facility wired degrades
    to a fail-closed deny (consent-unavailable) — consent cannot be
    silently skipped;
D3a/D3b the same escalation through the supported checkpointer API:
    approval executes the call exactly once; rejection executes nothing and
    ends the run without a final answer;
L1  a tainted run is not a frozen run — benign non-sink tools keep
    executing; only declared deny-sinks are blocked.
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
S1/S2 whole-run threading is scheduler-independent: the same later-step
    read→sink script is denied under both the default DAG scheduler and the
    parallel scheduler. No batch-internal happens-before is asserted or
    assumed anywhere in this pack.
S3  same-batch $ref dataflow is OUTSIDE the threading protection: policy
    decisions for a batch are evaluated before the batch dispatches, so the
    dependent sink's gate sees an empty ledger and no provenance rule fires.
    The pinned artifact then fails the call on typing (the $ref substitution
    passes the read's raw result object; a string-input sink rejects it), so
    no effect occurs — but that is schema typing, not taint policy. A sink
    whose schema accepted objects would not be spared by typing. Guidance:
    submit dependent sinks in later steps.
E1  the ledger is bounded (default 512 observations). All-sensitive overflow
    evicts the OLDEST entry: identity tracking for the evicted secret
    degrades (the identity rule stops firing for it) while label-based
    containment persists. Bounded-memory identity is a documented ceiling,
    not unbounded-run taint integrity.
E2  eviction prefers non-sensitive entries: a declared non-sensitive label
    ('internal') evicts before any sensitive entry. Declared labels are
    operator facts, not DLP judgments.
```

## Does NOT prove

```text
adaptive adversarial completeness (this is a fixed fixture set, not a
  red-team corpus);
process-wide or cross-run taint tracking (N3 asserts the opposite);
default-on behavior (N1 asserts the opposite: opt-in only);
CodeAgent coverage (the second agent loop is unwired territory);
DLP / model-side transform detection (N4 asserts the opposite);
protection of same-batch $ref dataflow by TAINT POLICY (S3 pins that no
  provenance rule fires there; the observed no-effect comes from input
  typing, and sinks with object-accepting schemas are outside this pack's
  coverage);
unbounded-run taint integrity (E1/E2 pin bounded-memory eviction
  semantics: identity tracking degrades for evicted entries);
production false-positive rate (no real workload is exercised here; L1 is
  a fixture-level legal negative, not a deployment statistic);
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
(e.g. honest sink declarations), exactly as documented in IF-07a. The
threading unit is the EVALUATION, which happens per submitted batch — hence
the S3 ceiling. Only declared deny-sinks are ever gated by it (L1).

## Consent and descriptor fail-closed posture (D1, D2, D3a/D3b)

Two more fail-closed seams are pinned alongside the provenance gate: an
unresolvable descriptor is a denial, never a guess; and a consent
escalation without an approval facility is a denial, never a silent
execution. Approval, when wired, binds to a specific promptId through the
checkpointer API; the pack exercises only the in-process binding (approval
within the same run's event loop) and claims nothing about cross-process
resume semantics.

## Verdict vocabulary

| Verdict | Meaning |
|---|---|
| `PASS` | positive claim: observed behavior matched expected-results.json |
| `FAIL` | positive claim: observed behavior diverged |
| `BOUNDARY-HELD` | negative claim: the gate did not exceed its documented ceiling |
| `BOUNDARY-BROKEN` | negative claim: the gate did something its ceiling says it does not do — a claim-language bug at minimum, a security regression at worst |
