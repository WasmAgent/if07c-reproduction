#!/usr/bin/env node
// Build ARTIFACTS.json (format v2) and SHA256SUMS for the IF-07c
// independent reproduction pack.
//
// Records, deterministically:
//   - the exact published npm versions installed in the verification
//     directory (default: ./pack-verify), with registry integrity and the
//     SHA256 of the downloaded tarball;
//   - the SHA256 of every frozen pack file (runner, fixtures, profile,
//     expected-results, docs, scripts, package.json, package-lock.json) —
//     ARTIFACTS.json excludes itself;
//   - the pack's own identity (repo, content tag) and the published-source
//     identity of the pinned npm packages (the wasmagent-js release commit
//     and merge that carried these versions);
//   - the case-set identity read from expected-results.json;
//   - the node/npm versions used.
//
// Then writes SHA256SUMS: a flat `<sha256>  <path>` index of the frozen set
// PLUS ARTIFACTS.json itself (SHA256SUMS never lists itself; ARTIFACTS.json
// never lists SHA256SUMS — no circularity, see README "Verifying a run").
//
// Usage:
//   npm ci                       # in a copy of the pack, per README
//   node runner/run.mjs
//   node scripts/build-artifacts.mjs --prefix ./pack-verify
//
// Re-running is deterministic apart from generatedAtUtc.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

const PACK_ROOT = new URL("..", import.meta.url).pathname;
const PACKAGES = ["@wasmagent/core", "@wasmagent/mcp-firewall", "@wasmagent/mcp-gateway"];
const SKIP_DIRS = new Set(["node_modules", "pack-verify", "repro-run", "runs", ".git"]);

// Published-source identity of the pinned npm packages: the wasmagent-js
// commit that carried the version bumps (changesets release commit) and the
// merge that landed it on main (PR #487). Maintained by the pack author;
// independently verifiable in the wasmagent-js repository history.
const PUBLISHED_SOURCE = {
  repo: "WasmAgent/wasmagent-js",
  releaseCommit: "13bce5e43f4b38730add5c01b0b72699a35be336",
  releaseCommitMessage: "chore: release packages (core 3.9.0, mcp-firewall 2.3.0, mcp-gateway 0.2.0)",
  releaseMergeCommit: "25045ef2984ff3fac0ad30f074a3a4cf5d8af4d7",
  releaseMerge: "PR #487 (changeset-release/main)",
  note: "The npm tarballs are the root identity (packages{} above); this block records which source commit they correspond to. Verify via the wasmagent-js git history.",
};

// This pack's own publication identity: the content tag that freezes this
// exact file set. Governance files outside the frozen set are protected by
// the repository's git history instead (see README).
const PACK_IDENTITY = {
  repo: "WasmAgent/if07c-reproduction",
  contentTag: "v1.2.0",
  previousFrozenTag: "v1.1.0",
  note: "External-tag publication model: the tag freezes this file set; no manifest can or should contain its own final hash.",
};

function parseArgs(argv) {
  const out = { prefix: join(PACK_ROOT, "pack-verify") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prefix") out.prefix = argv[++i];
    else {
      console.error(`unknown argument ${argv[i]}`);
      process.exit(2);
    }
  }
  return out;
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every frozen pack file under PACK_ROOT except generated/verification dirs. */
function packFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const rel = relative(PACK_ROOT, full);
      if (statSync(full).isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        walk(full);
      } else if (entry !== "ARTIFACTS.json" && entry !== "SHA256SUMS" && entry !== "results.json") {
        out.push(rel);
      }
    }
  };
  walk(PACK_ROOT);
  return out;
}

function main() {
  const { prefix } = parseArgs(process.argv.slice(2));
  if (!existsSync(join(prefix, "node_modules"))) {
    console.error(`error: ${prefix}/node_modules not found — install the pinned packages first (see README)`);
    return 2;
  }

  const packages = {};
  const tmp = mkdtempSync(join(tmpdir(), "repro-artifacts-"));
  try {
    for (const name of PACKAGES) {
      const pkgJson = JSON.parse(readFileSync(join(prefix, "node_modules", name, "package.json"), "utf8"));
      const version = pkgJson.version;
      const integrity = sh("npm", ["view", `${name}@${version}`, "dist.integrity"]);
      const tarballPath = join(tmp, `${name.replace("@", "").replace("/", "-")}-${version}.tgz`);
      sh("npm", ["pack", `${name}@${version}`, "--pack-destination", tmp]);
      // npm pack names the file scope-name-version.tgz
      const files = readdirSync(tmp).filter((f) => f.endsWith(".tgz") && f.includes(version));
      const tgz = files.find((f) => f.startsWith(name.replace("@", "").replace("/", "-"))) ?? files[0];
      if (!tgz) throw new Error(`npm pack produced no tarball for ${name}@${version}`);
      execFileSync("mv", [join(tmp, tgz), tarballPath]);
      packages[name] = {
        version,
        integrity,
        tarballSha256: sha256File(tarballPath),
      };
      console.log(`  ${name}@${version}  integrity ${integrity.slice(0, 20)}…  tarball sha256 recorded`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const files = {};
  for (const rel of packFiles()) {
    files[rel] = sha256File(join(PACK_ROOT, rel));
  }

  const expected = JSON.parse(readFileSync(join(PACK_ROOT, "expected-results.json"), "utf8"));
  const caseSet = {
    id: expected.caseSet?.id ?? "unknown",
    caseIds: Object.keys(expected.claims ?? {}).sort(),
    caseCount: Object.keys(expected.claims ?? {}).length,
    note: "Authoritative case-set identity; per-case kinds live in fixtures/*.json, assertions in expected-results.json.",
  };

  const doc = {
    format: "if07c-independent-reproduction/artifacts/v2",
    generatedAtUtc: new Date().toISOString(),
    toolchain: {
      node: process.versions.node,
      npm: sh("npm", ["--version"]),
    },
    packIdentity: PACK_IDENTITY,
    packages,
    publishedSource: PUBLISHED_SOURCE,
    caseSet,
    files,
    verification: {
      installDirectory: relative(PACK_ROOT, prefix) || ".",
      runnerCommand: "node runner/run.mjs",
      note: "A third party re-running this pack must compare the files{} hashes against their copy, then re-verify packages{} against the registry (npm view dist.integrity / tarball sha256) before trusting a run record.",
    },
  };

  const out = join(PACK_ROOT, "ARTIFACTS.json");
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${out} (${Object.keys(files).length} files, ${Object.keys(packages).length} packages, case set ${caseSet.id})`);

  const sumsPath = join(PACK_ROOT, "SHA256SUMS");
  const sumsEntries = [
    ...Object.entries(files).map(([rel, hash]) => `${hash}  ${rel}`),
    `${sha256File(out)}  ARTIFACTS.json`,
  ];
  sumsEntries.sort((a, b) => a.split("  ")[1].localeCompare(b.split("  ")[1]));
  writeFileSync(sumsPath, `${sumsEntries.join("\n")}\n`);
  console.log(`wrote ${sumsPath} (${sumsEntries.length} entries; excludes itself)`);
  return 0;
}

process.exit(main());
