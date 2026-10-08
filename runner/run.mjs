#!/usr/bin/env node
// IF-07c independent reproduction runner (v2).
//
// Runs against PUBLISHED npm artifacts only: @wasmagent/core,
// @wasmagent/mcp-firewall, @wasmagent/mcp-gateway (+ zod). It imports no
// monorepo code, no test helpers, and no internal assertion implementation.
// Inputs come from profile.json + fixtures/*.json; assertions come from
// expected-results.json — the runner contains no claim of its own.
//
// Two fixture modes:
//   mode "agent"         — scripted model drives ToolCallingAgent (default).
//   mode "gateway-probe" — drives the RunPolicyGateway API directly
//                          (evaluateBeforeCall / observeResult) to pin
//                          ledger-capacity and eviction semantics without
//                          a model in the loop.
//
// Output: one verdict line per claim, plus a machine-readable results.json
// (path overridable via IF07C_RESULTS_PATH) containing the observed
// behavior, execution counts, and every problem line. kind=positive →
// PASS/FAIL (security property held). kind=negative → BOUNDARY-HELD/
// BOUNDARY-BROKEN (the gate behaved exactly as the documented claim ceiling
// says it does). Deliberately NO aggregate "secure"/"insecure" verdict — a
// full green run supports the pinned claims and nothing more.
//
// Exit code 0 = every fixture matched its expected result.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { z } from "zod";
import { InMemoryCheckpointer, ToolCallingAgent } from "@wasmagent/core";
import {
  buildServerCard,
  buildVettingCacheKey,
  CapabilityRegistry,
  computeToolSnapshotHash,
  createRequestIdentity,
  hashArgScope,
  InMemoryToolSecurityProfileRegistry,
  MCPGateway,
} from "@wasmagent/mcp-firewall";
import { createAgentPolicyGateway } from "@wasmagent/mcp-gateway";

// ── Harness constants (mechanism, not claims) ───────────────────────────────

/** The secret the harness plants. Recorded in README.md; fixtures reference
 * it only via __derive__, so changing it does not invalidate fixture hashes. */
const SECRET = "smoke-secret-value-4021-alpha";

const HERE = new URL(".", import.meta.url).pathname;
const PACK_ROOT = new URL("..", import.meta.url).pathname;

const DENY_RULE_IDS = ["sink-tainted-provenance-deny", "sink-tainted-identity-deny"];

// ── Load operator declarations, expectations, fixtures ──────────────────────

const profile = JSON.parse(readFileSync(join(HERE, "..", "profile.json"), "utf8"));
const expected = JSON.parse(readFileSync(join(HERE, "..", "expected-results.json"), "utf8"));
const fixtureFiles = readdirSync(join(HERE, "..", "fixtures"))
  .filter((f) => f.endsWith(".json"))
  .sort();
const fixtures = fixtureFiles.map((file) => ({
  file,
  fixture: JSON.parse(readFileSync(join(HERE, "..", "fixtures", file), "utf8")),
}));

// ── Derive-value support: fixtures reference the planted secret symbolically
// (__derive__), so fixture hashes do not embed the secret itself. ────────────

function resolveInput(value) {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof value.__derive__ === "object" &&
    value.__derive__ !== null
  ) {
    const { from, transform } = value.__derive__;
    if (from !== "SECRET") throw new Error(`unknown __derive__ source: ${from}`);
    if (transform === "identity") return SECRET;
    if (transform === "base64") return Buffer.from(SECRET, "utf8").toString("base64");
    if (transform === "reverse") return [...SECRET].reverse().join("");
    throw new Error(`unknown __derive__ transform: ${transform}`);
  }
  // Deep resolution: __derive__ nodes may be nested (e.g. C4 wraps the secret
  // inside an object argument to prove the identity walk reaches it).
  if (Array.isArray(value)) return value.map(resolveInput);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveInput(v)]));
  }
  return value;
}

function resolveArgs(args) {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, resolveInput(v)]));
}

// ── Tool implementations (mechanism): what each tool DOES when executed ────

const counts = {
  search_docs: 0,
  send_report: 0,
  transform_text: 0,
  plain_echo: 0,
  internal_docs: 0,
  unprofiled_echo: 0,
  structured_sink: 0,
};

function forwardFor(name) {
  switch (name) {
    case "search_docs":
      return async () => {
        counts.search_docs++;
        return SECRET;
      };
    case "transform_text":
      return async ({ data }) => {
        counts.transform_text++;
        return Buffer.from(data, "utf8").toString("base64");
      };
    case "send_report":
      return async ({ body }) => {
        counts.send_report++;
        return `sent:${body}`;
      };
    case "plain_echo":
      return async ({ text }) => {
        counts.plain_echo++;
        return text;
      };
    case "internal_docs":
      return async () => {
        counts.internal_docs++;
        return "internal-project-alpha";
      };
    case "unprofiled_echo":
      return async ({ text }) => {
        counts.unprofiled_echo++;
        return text;
      };
    case "structured_sink":
      return async (args) => {
        counts.structured_sink++;
        return `ingested:${JSON.stringify(args?.body ?? null)}`;
      };
    default:
      throw new Error(`harness has no implementation for tool ${name}`);
  }
}

// ── Profile loading (operator-authoritative; descriptorOnly skips profile
// registration; no-labels set strips labels) ─────────────────────────────────

function buildProfiles(profileSet) {
  const names = profile.profileSets[profileSet];
  if (!names) throw new Error(`unknown profileSet: ${profileSet}`);
  const stripLabels = profileSet === "no-labels";
  const registry = new InMemoryToolSecurityProfileRegistry();
  const descriptors = [];
  for (const name of names) {
    const decl = profile.tools[name];
    if (!decl) throw new Error(`profile.json has no declaration for tool ${name}`);
    const entry = {
      name,
      description: decl.description,
      inputSchema: decl.inputSchema,
    };
    if (!decl.descriptorOnly) {
      const declared = { ...decl.profile };
      if (stripLabels) delete declared.resultTaintLabels;
      registry.register({
        toolSnapshotHash: computeToolSnapshotHash(entry, profile.serverId),
        ...declared,
      });
    }
    descriptors.push(entry);
  }
  return { registry, descriptors };
}

function zodInputFor(name) {
  const decl = profile.tools[name];
  const shape = Object.fromEntries(
    Object.entries(decl.inputSchema.properties ?? {}).map(([k, spec]) => [
      k,
      spec?.type === "object" ? z.any() : z.string(),
    ])
  );
  return z.object(shape);
}

function buildToolset(descriptors, receivedArgs) {
  return descriptors.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: zodInputFor(d.name),
    outputSchema: z.string(),
    readOnly: d.name !== "send_report" && d.name !== "structured_sink",
    idempotent:
      d.name === "plain_echo" ||
      d.name === "search_docs" ||
      d.name === "transform_text" ||
      d.name === "internal_docs" ||
      d.name === "unprofiled_echo",
    forward: async (args) => {
      receivedArgs[d.name] = JSON.parse(JSON.stringify(args ?? {}));
      return await forwardFor(d.name)(args);
    },
  }));
}

// ── Permission-probe mode: drive MCPGateway.evaluate directly with full
// GatewayRequest control (tenant, identity, capability grants, server cards,
// operator rules, consent) to pin permission-model pairs. Operator intent
// (grants, rules, consent scopes) is declared in the fixture; the runner is
// mechanism only. ─────────────────────────────────────────────────────────────

/** Interpret a declarative operator rule from the fixture. */
function makeOperatorRule(spec) {
  if (spec.kind === "path-prefix-deny") {
    return {
      policyId: spec.policyId,
      evaluate(_toolName, args) {
        for (const v of deepStringValuesShallow(args)) {
          if (v.startsWith(spec.prefix)) return "deny";
        }
        return undefined;
      },
    };
  }
  throw new Error(`unknown operator rule kind: ${spec.kind}`);
}

/** Collect string leaves of args (bounded, same discipline as the gate walk). */
function deepStringValuesShallow(value, out = [], depth = 0) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value) && depth < 8) for (const v of value) deepStringValuesShallow(v, out, depth + 1);
  else if (value !== null && typeof value === "object" && depth < 8)
    for (const v of Object.values(value)) deepStringValuesShallow(v, out, depth + 1);
  return out;
}

async function runPermissionProbe({ profileSet, probe }) {
  const { registry, descriptors } = buildProfiles(profileSet);
  const descriptorMap = new Map(descriptors.map((d) => [d.name, d]));

  const gwOpts = { profileRegistry: registry };
  let capabilityRegistry;
  if (probe.gateway?.capabilityRegistry) {
    capabilityRegistry = new CapabilityRegistry();
    gwOpts.capabilityRegistry = capabilityRegistry;
  }
  if (probe.gateway?.tenantEnforcement) gwOpts.tenantEnforcement = true;
  if (probe.gateway?.unprofiledToolPolicy) gwOpts.unprofiledToolPolicy = probe.gateway.unprofiledToolPolicy;
  if (probe.gateway?.rules) gwOpts.rules = probe.gateway.rules.map(makeOperatorRule);
  if (probe.gateway?.serverCardVerified !== undefined) {
    gwOpts.serverCards = [
      buildServerCard({
        serverId: profile.serverId,
        tools: descriptors,
        operatorVerified: probe.gateway.serverCardVerified,
      }),
    ];
  }
  const gw = new MCPGateway(gwOpts);

  const identity = createRequestIdentity({
    principal: probe.principal ?? profile.principal,
    sessionId: probe.session ?? "perm-probe",
  });

  for (const g of probe.grants ?? []) {
    capabilityRegistry.grant({
      principal: identity.principalHash,
      tenant: g.tenant,
      capability: g.capability,
    });
  }

  for (const c of probe.consents ?? []) {
    const tool = descriptorMap.get(c.tool);
    if (!tool) throw new Error(`consent for unknown tool ${c.tool}`);
    gw.addConsentRecord({
      toolName: c.tool,
      userIdHash: identity.principalHash,
      toolSnapshotHash: buildVettingCacheKey(tool, profile.serverId),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...(c.argScope !== undefined ? { argScopeDigest: hashArgScope(resolveArgs(c.argScope)) } : {}),
      ...(c.boundToSession === false ? {} : { boundToSession: identity.sessionId }),
    });
  }

  const legs = [];
  for (const [i, leg] of (probe.legs ?? []).entries()) {
    const tool = descriptorMap.get(leg.request.tool);
    if (!tool) throw new Error(`leg ${i}: unknown tool ${leg.request.tool}`);
    const decision = gw.evaluate({
      identity,
      serverId: profile.serverId,
      tool,
      args: resolveArgs(leg.request.args ?? {}),
      ...(leg.request.tenant ? { tenant: leg.request.tenant } : {}),
    });
    legs.push({
      name: leg.name ?? `leg-${i}`,
      role: leg.role ?? "legit",
      decision: decision.invocation.decision,
      matchedPolicyIds: [...decision.invocation.matchedPolicyIds].sort(),
      userConsentRef: decision.invocation.userConsentRef ?? null,
    });
  }
  return { legs };
}

// ── Agent mode: run one scripted run() against a (possibly unwired) agent ──

async function runScriptedRun({ wiring, profileSet, steps, runIndex, scheduler, checkpointerPolicy }) {
  resetCounts();
  const receivedArgs = {};
  const { registry, descriptors } = buildProfiles(profileSet);
  const gateway = new MCPGateway({ profileRegistry: registry });
  const factory = createAgentPolicyGateway({
    gateway,
    toolDescriptors: descriptors,
    serverId: profile.serverId,
    principal: profile.principal,
  });

  const tools = buildToolset(descriptors, receivedArgs);

  // A FRESH port instance per run() — the same factory, a new run-scoped
  // ledger. This is the exact property fixture N3 pins.
  const policyGateway = wiring === "wired" ? factory({ traceId: `repro-run-${runIndex}` }) : undefined;

  let checkpointer;
  if (checkpointerPolicy) checkpointer = new InMemoryCheckpointer();

  const agent = new ToolCallingAgent({
    model: scriptedModel(steps),
    tools,
    maxSteps: 12,
    ...(policyGateway ? { policyGateway } : {}),
    ...(checkpointer ? { checkpointer } : {}),
    ...(scheduler ? { scheduler } : {}),
  });

  let finalAnswerEmitted = false;
  let awaitHumanInputCount = 0;
  let humanReviewDenied = false;
  const denyRuleIds = new Set();
  const errorEvents = [];
  const toolErrors = [];
  for await (const e of agent.run("repro")) {
    if (e.event === "final_answer") finalAnswerEmitted = true;
    if (e.event === "await_human_input") {
      awaitHumanInputCount++;
      if (checkpointerPolicy === "approve-first") {
        await checkpointer.respond(e.traceId, e.data.promptId, "yes");
      } else if (checkpointerPolicy === "reject-first") {
        await checkpointer.respond(e.traceId, e.data.promptId, "no");
      }
    }
    if (e.event === "error") {
      const text = typeof e.data?.error === "string" ? e.data.error : JSON.stringify(e.data ?? {});
      errorEvents.push(text);
      if (text.includes("denied by human reviewer")) humanReviewDenied = true;
    }
    if (e.event === "tool_result" && e.data?.error) {
      toolErrors.push({ callId: e.data.callId, toolName: e.data.toolName, code: e.data.error.code ?? "unknown" });
    }
    // Exact ruleIds from the policy_denied status event…
    if (e.event === "status" && e.data?.phase === "policy_denied") {
      for (const rule of e.data.ruleIds ?? []) denyRuleIds.add(rule);
    }
    // …plus the tool_result error text (belt and braces; same set).
    if (e.event === "tool_result") {
      const text = JSON.stringify(e.data ?? {});
      for (const rule of DENY_RULE_IDS) {
        if (text.includes(rule)) denyRuleIds.add(rule);
      }
    }
  }
  return {
    executions: { ...counts },
    denyRuleIds: [...denyRuleIds].sort(),
    finalAnswerEmitted,
    awaitHumanInputCount,
    humanReviewDenied,
    errorEvents,
    toolErrors,
    receivedArgs,
  };
}

function scriptedModel(steps) {
  let i = 0;
  return {
    providerId: "external-repro/mock",
    async *generate() {
      const s = steps[i++] ?? { text: "(script exhausted)" };
      for (const c of s.calls ?? []) {
        yield {
          type: "tool_call",
          toolCall: {
            type: "tool_use",
            id: c.id,
            name: c.name,
            input: resolveArgs(c.input ?? {}),
          },
        };
      }
      if (s.text) yield { type: "text_delta", delta: s.text };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

// ── Gateway-probe mode: pin ledger capacity/eviction via the public
// RunPolicyGateway API (no model in the loop) ─────────────────────────────────

async function runGatewayProbe({ profileSet, probe }) {
  const { registry, descriptors } = buildProfiles(profileSet);
  const gateway = new MCPGateway({ profileRegistry: registry });
  const factory = createAgentPolicyGateway({
    gateway,
    toolDescriptors: descriptors,
    serverId: profile.serverId,
    principal: profile.principal,
  });
  const gw = factory({ traceId: `probe-${probe.label ?? "ledger"}` });

  let mintIndex = 0;
  const minted = [];
  for (const mint of probe.mints) {
    for (let i = 0; i < mint.count; i++) {
      const callId = `mint-${mintIndex++}`;
      const output = (mint.outputs ?? [])[i] ?? mint.template.replace("{i}", String(i));
      const decision = gw.evaluateBeforeCall({ callId, toolName: mint.tool, args: { key: "k" } });
      if (decision.action !== "allow") {
        throw new Error(`probe mint ${callId} (${mint.tool}) did not evaluate to allow: ${JSON.stringify(decision)}`);
      }
      gw.observeResult({ callId, toolName: mint.tool, output, isError: false });
      minted.push(output);
    }
  }

  const checks = [];
  for (const [j, check] of (probe.checks ?? []).entries()) {
    const callId = `check-${j}`;
    const decision = gw.evaluateBeforeCall({
      callId,
      toolName: check.toolName,
      args: resolveArgs(check.args ?? {}),
    });
    checks.push({
      callId,
      toolName: check.toolName,
      action: decision.action,
      ruleIds: [...(decision.ruleIds ?? [])].sort(),
    });
  }
  return { mintedCount: minted.length, checks };
}

// ── Assertion comparison (mechanism: expected-results.json is the truth) ───

function resetCounts() {
  for (const k of Object.keys(counts)) counts[k] = 0;
}

function compareExecution(expectedExec, actualExec) {
  const problems = [];
  for (const [tool, n] of Object.entries(expectedExec)) {
    if ((actualExec[tool] ?? 0) !== n) {
      problems.push(`${tool}: expected ${n} execution(s), observed ${actualExec[tool] ?? 0}`);
    }
  }
  return problems;
}

function compareRunExpectation(exp, actual) {
  const problems = [];
  problems.push(...compareExecution(exp.executions ?? {}, actual.executions));
  const expRules = [...(exp.denyRuleIds ?? [])].sort();
  if (JSON.stringify(expRules) !== JSON.stringify(actual.denyRuleIds)) {
    problems.push(
      `denyRuleIds: expected [${expRules.join(", ")}], observed [${actual.denyRuleIds.join(", ")}]`
    );
  }
  if (!!exp.finalAnswerEmitted !== actual.finalAnswerEmitted) {
    problems.push(`finalAnswerEmitted: expected ${exp.finalAnswerEmitted}, observed ${actual.finalAnswerEmitted}`);
  }
  if (exp.awaitHumanInputCount !== undefined && exp.awaitHumanInputCount !== actual.awaitHumanInputCount) {
    problems.push(`awaitHumanInputCount: expected ${exp.awaitHumanInputCount}, observed ${actual.awaitHumanInputCount}`);
  }
  if (exp.humanReviewDenied !== undefined && !!exp.humanReviewDenied !== actual.humanReviewDenied) {
    problems.push(`humanReviewDenied: expected ${exp.humanReviewDenied}, observed ${actual.humanReviewDenied}`);
  }
  if (exp.receivedArgsContains !== undefined) {
    for (const [tool, wantSecret] of Object.entries(exp.receivedArgsContains)) {
      const got = JSON.stringify(actual.receivedArgs?.[tool] ?? null);
      const has = got.includes(SECRET);
      if (wantSecret !== has) {
        problems.push(`receivedArgsContains[${tool}]: secret ${wantSecret ? "missing" : "unexpectedly present"} in ${got.slice(0, 140)}`);
      }
    }
  }
  if (exp.toolErrors !== undefined) {
    const expKey = JSON.stringify(exp.toolErrors);
    const actKey = JSON.stringify(actual.toolErrors);
    if (expKey !== actKey) {
      problems.push(`toolErrors: expected ${expKey}, observed ${actKey}`);
    }
  }
  return problems;
}

function comparePermissionExpectation(exp, actual) {
  const problems = [];
  const expLegs = exp.legs ?? [];
  if (expLegs.length !== actual.legs.length) {
    problems.push(`leg count: expected ${expLegs.length}, observed ${actual.legs.length}`);
  }
  for (const [i, legExp] of expLegs.entries()) {
    const observed = actual.legs[i];
    if (!observed) {
      problems.push(`leg ${i}: no observed decision`);
      continue;
    }
    const label = `leg ${i} (${observed.name})`;
    if (legExp.decision !== observed.decision) {
      problems.push(`${label}: decision expected ${legExp.decision}, observed ${observed.decision}`);
    }
    if (legExp.matchedPolicyIds !== undefined) {
      const expRules = [...legExp.matchedPolicyIds].sort();
      if (JSON.stringify(expRules) !== JSON.stringify(observed.matchedPolicyIds)) {
        problems.push(
          `${label}: matchedPolicyIds expected [${expRules.join(", ")}], observed [${observed.matchedPolicyIds.join(", ")}]`
        );
      }
    }
    if (legExp.matchedPolicyIdPrefix !== undefined) {
      if (
        observed.matchedPolicyIds.length !== 1 ||
        !observed.matchedPolicyIds[0].startsWith(legExp.matchedPolicyIdPrefix)
      ) {
        problems.push(
          `${label}: expected exactly one policy id with prefix "${legExp.matchedPolicyIdPrefix}", observed [${observed.matchedPolicyIds.join(", ")}]`
        );
      }
    }
    if (legExp.userConsentRefPresent !== undefined) {
      const present = observed.userConsentRef !== null;
      if (!!legExp.userConsentRefPresent !== present) {
        problems.push(`${label}: userConsentRefPresent expected ${legExp.userConsentRefPresent}, observed ${present}`);
      }
    }
  }
  return problems;
}

function compareProbeExpectation(exp, actual) {
  const problems = [];
  if (exp.mintedCount !== undefined && exp.mintedCount !== actual.mintedCount) {
    problems.push(`mintedCount: expected ${exp.mintedCount}, observed ${actual.mintedCount}`);
  }
  for (const [j, checkExp] of (exp.checks ?? []).entries()) {
    const observed = actual.checks[j];
    if (!observed) {
      problems.push(`check ${j}: no observed decision`);
      continue;
    }
    if (checkExp.action !== observed.action) {
      problems.push(`check ${j} (${observed.toolName}): action expected ${checkExp.action}, observed ${observed.action}`);
    }
    const expRules = [...(checkExp.ruleIds ?? [])].sort();
    if (JSON.stringify(expRules) !== JSON.stringify(observed.ruleIds)) {
      problems.push(
        `check ${j} (${observed.toolName}): ruleIds expected [${expRules.join(", ")}], observed [${observed.ruleIds.join(", ")}]`
      );
    }
  }
  return problems;
}

// ── Execute every fixture and emit per-claim verdicts ──────────────────────

const require = createRequire(import.meta.url);
const pkgVersion = (name) => {
  try {
    return require(`${name}/package.json`).version;
  } catch {
    try {
      // Some packages do not export ./package.json — read it off disk.
      return JSON.parse(
        readFileSync(join(PACK_ROOT, "node_modules", name, "package.json"), "utf8")
      ).version;
    } catch {
      return "unknown";
    }
  }
};

console.log("# IF-07c independent reproduction runner (v2)");
console.log(`# artifacts: @wasmagent/core@${pkgVersion("@wasmagent/core")} | ` +
  `@wasmagent/mcp-firewall@${pkgVersion("@wasmagent/mcp-firewall")} | ` +
  `@wasmagent/mcp-gateway@${pkgVersion("@wasmagent/mcp-gateway")}`);
console.log("# Per-claim verdicts only — this runner intentionally prints NO");
console.log("# aggregate secure/insecure conclusion.");

let failures = 0;
const verdicts = [];
const resultsOut = {
  format: "if07c-independent-reproduction/results/v2",
  generatedAtUtc: new Date().toISOString(),
  artifacts: {
    "@wasmagent/core": pkgVersion("@wasmagent/core"),
    "@wasmagent/mcp-firewall": pkgVersion("@wasmagent/mcp-firewall"),
    "@wasmagent/mcp-gateway": pkgVersion("@wasmagent/mcp-gateway"),
  },
  cases: [],
  permissionStats: { gateHits: 0, confirmedViolations: 0, legitBlocked: 0, allowedDecisions: 0 },
};

for (const { file, fixture } of fixtures) {
  const exp = expected.claims[fixture.id];
  if (!exp) {
    console.log(`${fixture.id}: FAIL — no expected-results.json entry for fixture ${file}`);
    failures++;
    resultsOut.cases.push({ id: fixture.id, fixture: file, verdict: "FAIL", problems: ["no expected-results.json entry"] });
    continue;
  }
  resetCounts();
  const observed = [];
  let problems = [];
  const caseRecord = {
    id: fixture.id,
    fixture: file,
    kind: fixture.kind,
    mode: fixture.mode ?? "agent",
    claim: exp.claim,
    runs: [],
  };
  try {
    if ((fixture.mode ?? "agent") === "gateway-probe") {
      const actual = await runGatewayProbe({ profileSet: fixture.profileSet, probe: fixture.probe });
      observed.push(actual);
      caseRecord.runs.push(actual);
      problems.push(...compareProbeExpectation(exp.expect, actual));
    } else if (fixture.mode === "permission-probe") {
      const actual = await runPermissionProbe({ profileSet: fixture.profileSet, probe: fixture.probe });
      observed.push(actual);
      caseRecord.runs.push(actual);
      problems.push(...comparePermissionExpectation(exp.expect, actual));
      for (const leg of actual.legs) {
        if (leg.matchedPolicyIds.length > 0) resultsOut.permissionStats.gateHits++;
        if (leg.role === "violating" && leg.decision === "deny") resultsOut.permissionStats.confirmedViolations++;
        if (leg.role === "legit" && leg.decision !== "allow") resultsOut.permissionStats.legitBlocked++;
        if (leg.role === "legit" && leg.decision === "allow") resultsOut.permissionStats.allowedDecisions++;
      }
    } else {
      for (let i = 0; i < fixture.runs.length; i++) {
        const run = fixture.runs[i];
        const actual = await runScriptedRun({
          wiring: fixture.wiring,
          profileSet: fixture.profileSet,
          steps: run.steps,
          runIndex: i,
          scheduler: fixture.scheduler,
          checkpointerPolicy: fixture.checkpointerPolicy,
        });
        observed.push(actual);
        caseRecord.runs.push(actual);
        const runExp = fixture.runs.length > 1 ? exp.expect.perRun[i] : exp.expect;
        problems.push(
          ...compareRunExpectation(runExp, actual).map((p) => `run ${i + 1}: ${p}`)
        );
      }
    }
  } catch (err) {
    problems.push(`harness error: ${err?.message ?? err}`);
  }
  const held = problems.length === 0;
  const verdict =
    fixture.kind === "positive" ? (held ? "PASS" : "FAIL") : held ? "BOUNDARY-HELD" : "BOUNDARY-BROKEN";
  if (!held) failures++;
  verdicts.push(`${fixture.id}: ${verdict}`);
  caseRecord.verdict = verdict;
  caseRecord.problems = problems;
  resultsOut.cases.push(caseRecord);
  console.log(`${fixture.id}: ${verdict} — ${exp.claim}`);
  for (const p of problems) console.log(`    ${fixture.id}: ${p}`);
}

console.log("# claims executed: " + verdicts.join(" | "));
resultsOut.summary = { failures, verdicts: verdicts.map((v) => v.split(": ")[1]) };

const resultsPath = process.env.IF07C_RESULTS_PATH ?? join(PACK_ROOT, "results.json");
writeFileSync(resultsPath, `${JSON.stringify(resultsOut, null, 2)}\n`);
console.log(`# results written to ${resultsPath}`);
process.exit(failures === 0 ? 0 : 1);
