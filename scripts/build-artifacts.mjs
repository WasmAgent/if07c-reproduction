#!/usr/bin/env node
// Build ARTIFACTS.json for the IF-07c independent reproduction pack.
//
// Records, deterministically:
//   - the exact published npm versions installed in the verification
//     directory (default: ./pack-verify), with registry integrity and the
//     SHA256 of the downloaded tarball;
//   - the SHA256 of every frozen pack file;
//   - the node/npm versions used.
//
// Usage (normal — hashes working tree):
//   npm install zod@4.6.5 @wasmagent/core@X @wasmagent/mcp-firewall@Y @wasmagent/mcp-gateway@Z
//   node runner/run.mjs
//   node scripts/build-artifacts.mjs --prefix ./pack-verify
//
// Usage (release mode — hashes the exact committed tree, recommended before tagging):
//   node scripts/build-artifacts.mjs --prefix ./pack-verify --git-ref <sha-or-tag>
//
// Re-running is deterministic apart from generatedAtUtc.

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

const PACK_ROOT = new URL("..", import.meta.url).pathname;
const PACKAGES = ["zod", "@wasmagent/core", "@wasmagent/mcp-firewall", "@wasmagent/mcp-gateway"];
const SKIP_DIRS = new Set(["node_modules", "pack-verify", "repro-run", "runs", ".git", ".github"]);

// Published-source identity of the pinned npm packages: the wasmagent-js
// commit that carried the version bumps (changesets release commit) and the
// merge that landed it on main (PR WasmAgent/wasmagent-js#487). Maintained by
// the pack author; independently verifiable in the wasmagent-js git history.
const PUBLISHED_SOURCE = {
  repo: "WasmAgent/wasmagent-js",
  releaseCommit: "13bce5e43f4b38730add5c01b0b72699a35be336",
  releaseCommitMessage: "chore: release packages (core 3.9.0, mcp-firewall 2.3.0, mcp-gateway 0.2.0)",
  releaseMergeCommit: "25045ef2984ff3fac0ad30f074a3a4cf5d8af4d7",
  releaseMerge: "PR #487 (changeset-release/main)",
  note: "The npm tarballs are the root identity (packages{} above); this block records which source commit they correspond to.",
};

// This pack's own publication identity: the content tag that freezes this
// exact file set. Updated per content version; the tag itself is created by
// the human maintainer only after the release-candidate-audit gate passes.
const PACK_IDENTITY = {
  repo: "WasmAgent/if07c-reproduction",
  contentTag: "v1.2.0",
  previousFrozenTag: "v1.1.0",
  note: "External-tag publication model: the tag freezes this file set; no manifest can or should contain its own final hash.",
};

function parseArgs(argv) {
  const out = { prefix: join(PACK_ROOT, "pack-verify"), gitRef: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prefix") out.prefix = argv[++i];
    else if (argv[i] === "--git-ref") out.gitRef = argv[++i];
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

function sha256Buf(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Extract the committed tree at gitRef into a temp dir and return its path. */
function materializeGitArchive(gitRef, tmpBase) {
  const archiveDir = join(tmpBase, "archive");
  execSync(`mkdir -p ${archiveDir}`, { stdio: "inherit" });
  execSync(`git -C "${PACK_ROOT}" archive "${gitRef}" | tar -x -C "${archiveDir}"`, { stdio: "inherit" });
  return archiveDir;
}

/** Every pack file under root except generated/verification dirs. */
function packFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const rel = relative(root, full);
      if (statSync(full).isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        walk(full);
      } else if (entry !== "ARTIFACTS.json" && entry !== "results.json" && entry !== "SHA256SUMS") {
        out.push(rel);
      }
    }
  };
  walk(root);
  return out;
}

function main() {
  const { prefix, gitRef } = parseArgs(process.argv.slice(2));
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
      // npm pack names the file based on the package, handling scoped names
      const tmpTgz = join(tmp, `${name.replace(/@/g, "").replace(/\//g, "-")}-${version}.tgz`);
      sh("npm", ["pack", `${name}@${version}`, "--pack-destination", tmp]);
      const files = readdirSync(tmp).filter((f) => f.endsWith(".tgz") && f.includes(version));
      const basename_ = name.replace(/@/g, "").replace(/\//g, "-");
      const tgz = files.find((f) => f.startsWith(basename_)) ?? files[0];
      if (!tgz) throw new Error(`npm pack produced no tarball for ${name}@${version}`);
      execFileSync("mv", [join(tmp, tgz), tmpTgz]);
      packages[name] = {
        version,
        integrity,
        tarballSha256: sha256File(tmpTgz),
      };
      console.log(`  ${name}@${version}  integrity ${integrity.slice(0, 20)}…  tarball sha256 recorded`);
      // clean up tgz before next package to avoid stale matches
      rmSync(tmpTgz, { force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // Determine the root to hash files from
  let hashRoot = PACK_ROOT;
  let archiveTmp = null;
  if (gitRef) {
    console.log(`  materializing git archive at ${gitRef} …`);
    archiveTmp = mkdtempSync(join(tmpdir(), "repro-gitarchive-"));
    hashRoot = materializeGitArchive(gitRef, archiveTmp);
    console.log(`  archive extracted to ${hashRoot}`);
  }

  const files = {};
  let caseSetSource;
  try {
    for (const rel of packFiles(hashRoot)) {
      files[rel] = sha256File(join(hashRoot, rel));
    }
    // read from the hashed tree (working tree, or the materialized archive
    // in --git-ref mode) BEFORE the finally-block removes the archive
    caseSetSource = JSON.parse(readFileSync(join(hashRoot, "expected-results.json"), "utf8"));
  } finally {
    if (archiveTmp) rmSync(archiveTmp, { recursive: true, force: true });
  }

  const doc = {
    format: "if07c-independent-reproduction/artifacts/v2",
    version: PACK_IDENTITY.contentTag.replace(/^v/, ""),
    generatedAtUtc: new Date().toISOString(),
    toolchain: {
      node: process.versions.node,
      npm: sh("npm", ["--version"]),
    },
    ...(gitRef ? { gitRef } : {}),
    packIdentity: PACK_IDENTITY,
    packages,
    publishedSource: PUBLISHED_SOURCE,
    caseSet: {
      id: caseSetSource.caseSet?.id ?? "unknown",
      caseIds: Object.keys(caseSetSource.claims ?? {}).sort(),
      caseCount: Object.keys(caseSetSource.claims ?? {}).length,
      note: "Authoritative case-set identity; per-case kinds live in fixtures/*.json, assertions in expected-results.json.",
    },
    files,
    verification: {
      installDirectory: relative(PACK_ROOT, prefix) || ".",
      runnerCommand: "node runner/run.mjs",
      note: "A third party re-running this pack must compare the files{} hashes against their copy, then re-verify packages{} against the registry (npm view dist.integrity / tarball sha256) before trusting a run record.",
    },
  };

  const out = join(PACK_ROOT, "ARTIFACTS.json");
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);

  // SHA256SUMS: flat index of every declared frozen file PLUS ARTIFACTS.json
  // itself. Present in the pack tree but NOT declared in ARTIFACTS.json
  // files{} (and it never lists itself), so the pair is not circular and
  // regenerating one never invalidates the other.
  const sumsEntries = [
    ...Object.entries(files).map(([rel, hash]) => `${hash}  ${rel}`),
    `${sha256File(out)}  ARTIFACTS.json`,
  ];
  sumsEntries.sort((a, b) => a.split("  ")[1].localeCompare(b.split("  ")[1]));
  writeFileSync(join(PACK_ROOT, "SHA256SUMS"), `${sumsEntries.join("\n")}\n`);
  console.log(`wrote ${out} (${Object.keys(files).length} files, ${Object.keys(packages).length} packages)`);
  return 0;
}

process.exit(main());
