#!/usr/bin/env node
// IF-07c independent reproduction runner (v1).
//
// Runs against PUBLISHED npm artifacts only: @wasmagent/core,
// @wasmagent/mcp-firewall, @wasmagent/mcp-gateway (+ zod). It imports no
// monorepo code, no test helpers, and no internal assertion implementation.
// Inputs come from profile.json + fixtures/*.json; assertions come from
// expected-results.json — the runner contains no claim of its own.
//
// Output: one verdict line per claim. kind=positive → PASS/FAIL (security
// property held). kind=negative → BOUNDARY-HELD/BOUNDARY-BROKEN (the gate
// behaved exactly as the documented claim ceiling says it does).
// Deliberately NO aggregate "secure"/"insecure" verdict — a full green run
// supports the pinned claims and nothing more.
//
// Exit code 0 = every fixture matched its expected result.

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { z } from "zod";
import { ToolCallingAgent } from "@wasmagent/core";
import {
  computeToolSnapshotHash,
  InMemoryToolSecurityProfileRegistry,
  MCPGateway,
} from "@wasmagent/mcp-firewall";
import { createAgentPolicyGateway } from "@wasmagent/mcp-gateway";

// ── Harness constants (mechanism, not claims) ───────────────────────────────

/** The secret the harness plants. Recorded in README.md; fixtures reference
 * it only via __derive__, so changing it does not invalidate fixture hashes. */
const SECRET = "smoke-secret-value-4021-alpha";

const HERE = new URL(".", import.meta.url).pathname;

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
  return value;
}

function resolveArgs(args) {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, resolveInput(v)]));
}

// ── Tool implementations (mechanism): what each tool DOES when executed ────

const counts = { search_docs: 0, send_report: 0, transform_text: 0, plain_echo: 0 };

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
    default:
      throw new Error(`harness has no implementation for tool ${name}`);
  }
}

// ── Profile loading (operator-authoritative; no-labels set strips labels) ──

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
    const declared = { ...decl.profile };
    if (stripLabels) delete declared.resultTaintLabels;
    registry.register({
      toolSnapshotHash: computeToolSnapshotHash(entry, profile.serverId),
      ...declared,
    });
    descriptors.push(entry);
  }
  return { registry, descriptors };
}

function zodInputFor(name) {
  const decl = profile.tools[name];
  const shape = Object.fromEntries(
    Object.keys(decl.inputSchema.properties ?? {}).map((k) => [k, z.string()])
  );
  return z.object(shape);
}

// ── Run one scripted run() against a (possibly unwired) agent ──────────────

async function runScriptedRun({ wiring, profileSet, steps, runIndex }) {
  resetCounts();
  const { registry, descriptors } = buildProfiles(profileSet);
  const gateway = new MCPGateway({ profileRegistry: registry });
  const factory = createAgentPolicyGateway({
    gateway,
    toolDescriptors: descriptors,
    serverId: profile.serverId,
    principal: profile.principal,
  });

  const tools = descriptors.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: zodInputFor(d.name),
    outputSchema: z.string(),
    readOnly: d.name !== "send_report",
    idempotent: d.name === "plain_echo" || d.name === "search_docs" || d.name === "transform_text",
    forward: forwardFor(d.name),
  }));

  // A FRESH port instance per run() — the same factory, a new run-scoped
  // ledger. This is the exact property fixture N3 pins.
  const policyGateway = wiring === "wired" ? factory({ traceId: `repro-run-${runIndex}` }) : undefined;

  const agent = new ToolCallingAgent({
    model: scriptedModel(steps),
    tools,
    maxSteps: 12,
    ...(policyGateway ? { policyGateway } : {}),
  });

  let finalAnswerEmitted = false;
  const denyRuleIds = new Set();
  for await (const e of agent.run("repro")) {
    if (e.event === "final_answer") finalAnswerEmitted = true;
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
        readFileSync(join(HERE, "..", "node_modules", name, "package.json"), "utf8")
      ).version;
    } catch {
      return "unknown";
    }
  }
};

console.log("# IF-07c independent reproduction runner (v1)");
console.log(`# artifacts: @wasmagent/core@${pkgVersion("@wasmagent/core")} | ` +
  `@wasmagent/mcp-firewall@${pkgVersion("@wasmagent/mcp-firewall")} | ` +
  `@wasmagent/mcp-gateway@${pkgVersion("@wasmagent/mcp-gateway")}`);
console.log("# Per-claim verdicts only — this runner intentionally prints NO");
console.log("# aggregate secure/insecure conclusion.");

let failures = 0;
const verdicts = [];

for (const { file, fixture } of fixtures) {
  const exp = expected.claims[fixture.id];
  if (!exp) {
    console.log(`${fixture.id}: FAIL — no expected-results.json entry for fixture ${file}`);
    failures++;
    continue;
  }
  resetCounts();
  const observed = [];
  let problems = [];
  try {
    for (let i = 0; i < fixture.runs.length; i++) {
      const run = fixture.runs[i];
      const actual = await runScriptedRun({
        wiring: fixture.wiring,
        profileSet: fixture.profileSet,
        steps: run.steps,
        runIndex: i,
      });
      observed.push(actual);
      const runExp = fixture.runs.length > 1 ? exp.expect.perRun[i] : exp.expect;
      problems.push(
        ...compareRunExpectation(runExp, actual).map((p) => `run ${i + 1}: ${p}`)
      );
    }
  } catch (err) {
    problems.push(`harness error: ${err?.message ?? err}`);
  }
  const held = problems.length === 0;
  const verdict =
    fixture.kind === "positive" ? (held ? "PASS" : "FAIL") : held ? "BOUNDARY-HELD" : "BOUNDARY-BROKEN";
  if (!held) failures++;
  verdicts.push(`${fixture.id}: ${verdict}`);
  console.log(`${fixture.id}: ${verdict} — ${exp.claim}`);
  for (const p of problems) console.log(`    ${fixture.id}: ${p}`);
}

console.log("# claims executed: " + verdicts.join(" | "));
process.exit(failures === 0 ? 0 : 1);