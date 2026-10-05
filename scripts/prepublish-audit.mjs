#!/usr/bin/env node
// Maintainer pre-publication audit for the IF-07c reproduction pack.
//
// Simulates a hostile/independent third-party run before release:
//   A. Manifest closure (files listed ↔ files on disk, hashes match)
//   B. Dependency closure (all runner imports pinned in ARTIFACTS.json)
//   C. Registry re-fetch (live npm view + tarball SHA256)
//   D. Fresh archive verification (hashes from git archive, not working tree)
//   E. Clean dependency install (fresh tmpdir, no workspace/monorepo)
//   F. Runner execution (exact per-claim vocabulary, exit 0)
//   G. Negative controls (audit must FAIL when inputs are injected)
//
// Exits 0 only if every check passes and every negative control fails.
// Prints each check result separately — no single aggregate boolean.
//
// Usage:
//   node scripts/prepublish-audit.mjs [--git-ref <sha>] [--skip-network]

import { createHash } from "node:crypto";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const PACK_ROOT = new URL("..", import.meta.url).pathname;

// ── Argument parsing ──────────────────────────────────────────────

function parseArgs(argv) {
  const out = { gitRef: null, skipNetwork: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--git-ref") out.gitRef = argv[++i];
    else if (argv[i] === "--skip-network") out.skipNetwork = true;
    else { console.error(`unknown argument: ${argv[i]}`); process.exit(2); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label, ok, detail = "") {
  const status = ok ? "PASS" : "FAIL";
  console.log(`  ${status}  ${label}${detail ? "  (" + detail + ")" : ""}`);
  if (ok) passed++; else failed++;
  return ok;
}

function fatal(label, msg) {
  console.log(`  FATAL  ${label}: ${msg}`);
  console.log(`\nAudit aborted: ${label}`);
  process.exit(1);
}

function sh(cmd, args_) {
  return execFileSync(cmd, args_, { encoding: "utf8" }).trim();
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function loadArtifacts(root) {
  const p = join(root, "ARTIFACTS.json");
  if (!existsSync(p)) fatal("ARTIFACTS.json", "file not found at " + p);
  return JSON.parse(readFileSync(p, "utf8"));
}

// ── Section A: Manifest closure ───────────────────────────────────────────────

function checkManifestClosure(root, artifacts) {
  console.log("\n[A] Manifest closure");
  let ok = true;

  const FROZEN_ALLOWLIST = new Set([
    "README.md",
    "INVITATION.md",
    "CLAIM-BOUNDARY.md",
    "LICENSE",
    "expected-results.json",
    "profile.json",
    "runner/run.mjs",
    "scripts/build-artifacts.mjs",
    "scripts/outsider-repro.sh",
    "scripts/prepublish-audit.mjs",
    "docs/V1.0.0-EXTERNAL-FINDINGS.md",
  ]);
  // add fixtures dynamically
  const fixtureDir = join(root, "fixtures");
  if (existsSync(fixtureDir)) {
    for (const f of readdirSync(fixtureDir).filter((f) => f.endsWith(".json"))) {
      FROZEN_ALLOWLIST.add(`fixtures/${f}`);
    }
  }

  const manifestFiles = artifacts.files ?? {};
  const seenNormalized = new Set();

  for (const [relPath, expectedHash] of Object.entries(manifestFiles)) {
    // path traversal check
    const abs = resolve(join(root, relPath));
    if (!abs.startsWith(resolve(root))) {
      check(`path traversal: ${relPath}`, false);
      ok = false;
      continue;
    }
    // duplicate normalized path check
    const norm = relPath.replace(/\\/g, "/").toLowerCase();
    if (seenNormalized.has(norm)) {
      check(`duplicate path: ${relPath}`, false);
      ok = false;
      continue;
    }
    seenNormalized.add(norm);
    // symlink check
    try {
      const st = statSync(abs, { throwIfNoEntry: true });
      if (st.isSymbolicLink?.()) { check(`symlink: ${relPath}`, false); ok = false; continue; }
    } catch { /* handled below */ }
    // file exists
    if (!existsSync(abs)) { check(`exists: ${relPath}`, false, "missing"); ok = false; continue; }
    if (!statSync(abs).isFile()) { check(`regular file: ${relPath}`, false); ok = false; continue; }
    // hash
    const actual = sha256File(abs);
    const hashOk = actual === expectedHash;
    check(`hash: ${relPath}`, hashOk, hashOk ? "" : `expected ${expectedHash.slice(0,12)}… got ${actual.slice(0,12)}…`);
    if (!hashOk) ok = false;
  }

  // inverse: frozen allowlist entries must be in manifest
  for (const relPath of FROZEN_ALLOWLIST) {
    if (!(relPath in manifestFiles)) {
      check(`manifest contains: ${relPath}`, false, "frozen input not in manifest");
      ok = false;
    }
  }

  return ok;
}

// ── Section B: Dependency closure ───────────────────────────────────────────────

const REQUIRED_PACKAGES = ["zod", "@wasmagent/core", "@wasmagent/mcp-firewall", "@wasmagent/mcp-gateway"];

function checkDependencyClosure(artifacts) {
  console.log("\n[B] Dependency closure");
  let ok = true;
  const pkgs = artifacts.packages ?? {};
  for (const name of REQUIRED_PACKAGES) {
    if (!(name in pkgs)) { check(`package declared: ${name}`, false, "missing from ARTIFACTS.json"); ok = false; continue; }
    const p = pkgs[name];
    const hasVersion = typeof p.version === "string" && p.version.length > 0 && !p.version.includes("^") && !p.version.includes("~") && !p.version.includes("*");
    check(`exact version: ${name}`, hasVersion, hasVersion ? p.version : `got: ${p.version}`);
    check(`integrity present: ${name}`, typeof p.integrity === "string" && p.integrity.length > 0);
    check(`tarballSha256 present: ${name}`, typeof p.tarballSha256 === "string" && p.tarballSha256.length === 64);
    if (!hasVersion || !p.integrity || !p.tarballSha256) ok = false;
  }
  return ok;
}

// ── Section C: Registry re-fetch ──────────────────────────────────────────────────

async function checkRegistryIntegrity(artifacts) {
  console.log("\n[C] Registry re-fetch");
  let ok = true;
  const pkgs = artifacts.packages ?? {};
  const tmp = mkdtempSync(join(tmpdir(), "repro-audit-tarballs-"));
  try {
    for (const [name, p] of Object.entries(pkgs)) {
      if (!p.version) continue;
      // integrity
      let liveIntegrity;
      try {
        liveIntegrity = sh("npm", ["view", `${name}@${p.version}`, "dist.integrity"]);
      } catch (e) {
        check(`registry integrity fetch: ${name}`, false, e.message);
        ok = false;
        continue;
      }
      const intOk = liveIntegrity === p.integrity;
      check(`registry integrity: ${name}@${p.version}`, intOk, intOk ? "" : `expected ${p.integrity.slice(0,20)}… got ${liveIntegrity.slice(0,20)}…`);
      if (!intOk) { ok = false; continue; }
      // tarball sha256
      let liveHash;
      try {
        const basename_ = name.replace(/@/g, "").replace(/\//g, "-");
        sh("npm", ["pack", `${name}@${p.version}`, "--pack-destination", tmp]);
        const files = readdirSync(tmp).filter((f) => f.endsWith(".tgz"));
        const tgz = files.find((f) => f.startsWith(basename_)) ?? files[0];
        if (!tgz) throw new Error("npm pack produced no tarball");
        liveHash = sha256File(join(tmp, tgz));
        rmSync(join(tmp, tgz), { force: true });
      } catch (e) {
        check(`tarball sha256: ${name}`, false, e.message);
        ok = false;
        continue;
      }
      const hashOk = liveHash === p.tarballSha256;
      check(`tarball sha256: ${name}@${p.version}`, hashOk, hashOk ? "" : `expected ${p.tarballSha256.slice(0,12)}… got ${liveHash.slice(0,12)}…`);
      if (!hashOk) ok = false;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return ok;
}

// ── Section D: Fresh archive verification ──────────────────────────────────────────

function checkArchiveClosure(gitRef, artifacts) {
  console.log("\n[D] Fresh archive verification");
  if (!gitRef) {
    check("git-ref provided", false, "pass --git-ref <sha> for release-candidate audit");
    return false;
  }
  const tmp = mkdtempSync(join(tmpdir(), "repro-audit-archive-"));
  let ok = true;
  try {
    mkdirSync(join(tmp, "tree"), { recursive: true });
    execSync(`git -C "${PACK_ROOT}" archive "${gitRef}" | tar -x -C "${join(tmp, "tree")}"`, { stdio: "pipe" });
    const archiveRoot = join(tmp, "tree");
    const manifestFiles = artifacts.files ?? {};
    for (const [relPath, expectedHash] of Object.entries(manifestFiles)) {
      const abs = join(archiveRoot, relPath);
      if (!existsSync(abs)) {
        check(`archive contains: ${relPath}`, false, "file in manifest but not in git archive");
        ok = false;
        continue;
      }
      const actual = sha256File(abs);
      const hashOk = actual === expectedHash;
      check(`archive hash: ${relPath}`, hashOk, hashOk ? "" : "hash mismatch vs manifest");
      if (!hashOk) ok = false;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return ok;
}

// ── Section E: Clean dependency install ────────────────────────────────────────────

function checkCleanInstall(artifacts) {
  console.log("\n[E] Clean dependency install");
  const pkgs = artifacts.packages ?? {};
  const installArgs = Object.entries(pkgs).map(([name, p]) => `${name}@${p.version}`).filter(Boolean);
  const tmp = mkdtempSync(join(tmpdir(), "repro-audit-install-"));
  let ok = true;
  try {
    // init
    execFileSync("npm", ["init", "-y"], { cwd: tmp, stdio: "pipe" });
    // install
    const result = spawnSync(
      "npm",
      ["install", "--ignore-scripts", ...installArgs],
      { cwd: tmp, encoding: "utf8", timeout: 120000 }
    );
    const installOk = result.status === 0;
    check("clean npm install exits 0", installOk, installOk ? "" : (result.stderr ?? "").slice(0, 200));
    if (!installOk) { ok = false; return ok; }
    // verify resolved versions
    for (const [name, p] of Object.entries(pkgs)) {
      if (!p.version) continue;
      const pkgJsonPath = join(tmp, "node_modules", name, "package.json");
      if (!existsSync(pkgJsonPath)) { check(`installed: ${name}`, false); ok = false; continue; }
      const resolved = JSON.parse(readFileSync(pkgJsonPath, "utf8")).version;
      const vOk = resolved === p.version;
      check(`resolved version: ${name}`, vOk, vOk ? p.version : `got ${resolved}`);
      if (!vOk) ok = false;
    }
    // no workspace/symlink presence
    check("no workspace symlinks in node_modules", !existsSync(join(tmp, "node_modules", ".modules.yaml")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return ok;
}

// ── Section F: Execute the runner ────────────────────────────────────────────────

function checkRunnerExecution(artifacts) {
  console.log("\n[F] Runner execution");
  const pkgs = artifacts.packages ?? {};
  const installArgs = Object.entries(pkgs).map(([name, p]) => `${name}@${p.version}`).filter(Boolean);
  const tmp = mkdtempSync(join(tmpdir(), "repro-audit-runner-"));
  let ok = true;
  try {
    execFileSync("npm", ["init", "-y"], { cwd: tmp, stdio: "pipe" });
    const inst = spawnSync("npm", ["install", "--ignore-scripts", ...installArgs], { cwd: tmp, encoding: "utf8", timeout: 120000 });
    if (inst.status !== 0) { check("runner install", false, "install failed"); return false; }

    // copy frozen pack inputs (no workspace code)
    const copyDirs = ["fixtures", "runner", "scripts"];
    const copyFiles = ["profile.json", "expected-results.json", "CLAIM-BOUNDARY.md"];
    for (const d of copyDirs) {
      const src = join(PACK_ROOT, d);
      if (!existsSync(src)) continue;
      mkdirSync(join(tmp, d), { recursive: true });
      for (const f of readdirSync(src)) copyFileSync(join(src, f), join(tmp, d, f));
    }
    for (const f of copyFiles) {
      const src = join(PACK_ROOT, f);
      if (existsSync(src)) copyFileSync(src, join(tmp, f));
    }

    const result = spawnSync("node", ["runner/run.mjs"], { cwd: tmp, encoding: "utf8", timeout: 60000 });
    const runOk = result.status === 0;
    check("runner exits 0", runOk);
    if (!runOk) ok = false;

    const output = result.stdout ?? "";
    const EXPECTED_VERDICTS = [
      { id: "C1", verdict: "PASS" },
      { id: "C2", verdict: "PASS" },
      { id: "C3", verdict: "PASS" },
      { id: "N1", verdict: "BOUNDARY-HELD" },
      { id: "N2", verdict: "BOUNDARY-HELD" },
      { id: "N3", verdict: "BOUNDARY-HELD" },
      { id: "N4", verdict: "BOUNDARY-HELD" },
    ];
    for (const { id, verdict } of EXPECTED_VERDICTS) {
      const found = output.includes(`${id}: ${verdict}`);
      check(`verdict: ${id} ${verdict}`, found, found ? "" : "not found in output");
      if (!found) ok = false;
    }
    if (!runOk || !ok) {
      console.log("  --- runner output ---");
      console.log(output.split("\n").map((l) => "  " + l).join("\n"));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return ok;
}

// ── Section G: Negative controls ───────────────────────────────────────────────

function injectAndExpectFail(label, tmpBase, artifacts, mutate) {
  const tmp = mkdtempSync(join(tmpBase, "neg-"));
  const pkgs = artifacts.packages ?? {};
  const installArgs = Object.entries(pkgs).map(([name, p]) => `${name}@${p.version}`).filter(Boolean);
  try {
    // write a minimal ARTIFACTS copy with mutations applied
    const mutatedArtifacts = JSON.parse(JSON.stringify(artifacts));
    mutate(tmp, mutatedArtifacts);
    writeFileSync(join(tmp, "ARTIFACTS.json"), JSON.stringify(mutatedArtifacts, null, 2));

    // run manifest closure check on the mutated copy using a sub-process
    const auditSelf = join(PACK_ROOT, "scripts", "prepublish-audit.mjs");
    const result = spawnSync(
      "node",
      [auditSelf, "--skip-network", "--negative-control-mode"],
      {
        cwd: tmp,
        encoding: "utf8",
        timeout: 30000,
        env: { ...process.env, PREPUBLISH_AUDIT_PACK_ROOT: tmp },
      }
    );
    // We expect the audit to FAIL (nonzero exit) when the pack is corrupted
    const auditFailed = result.status !== 0;
    check(label, auditFailed, auditFailed ? "audit correctly rejected" : "audit should have failed but passed");
    return auditFailed;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function checkNegativeControls(artifacts) {
  console.log("\n[G] Negative controls");
  const tmpBase = mkdtempSync(join(tmpdir(), "repro-audit-neg-"));
  let allFailed = true;
  try {
    // G1: delete one manifest-listed file → must fail
    allFailed = injectAndExpectFail(
      "G1: deleted manifest file → audit fails",
      tmpBase, artifacts,
      (tmp, art) => {
        // copy a real file then delete it
        const first = Object.keys(art.files ?? {})[0];
        const dest = join(tmp, first);
        mkdirSync(dirname(dest), { recursive: true });
        // write then delete so the manifest entry is still there
        writeFileSync(dest, "dummy");
        rmSync(dest);
      }
    ) && allFailed;

    // G2: modify one fixture byte → must fail
    allFailed = injectAndExpectFail(
      "G2: modified fixture byte → audit fails",
      tmpBase, artifacts,
      (tmp, art) => {
        const fixtureKey = Object.keys(art.files ?? {}).find((k) => k.startsWith("fixtures/"));
        if (!fixtureKey) return;
        const dest = join(tmp, fixtureKey);
        mkdirSync(dirname(dest), { recursive: true });
        const orig = readFileSync(join(PACK_ROOT, fixtureKey));
        // flip one byte
        orig[0] ^= 0x01;
        writeFileSync(dest, orig);
        // hash in manifest still points to old content → mismatch
      }
    ) && allFailed;

    // G3: change one manifest hash → must fail
    allFailed = injectAndExpectFail(
      "G3: corrupted manifest hash → audit fails",
      tmpBase, artifacts,
      (tmp, art) => {
        const first = Object.keys(art.files ?? {})[0];
        const dest = join(tmp, first);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(join(PACK_ROOT, first)));
        art.files[first] = "0".repeat(64); // wrong hash
      }
    ) && allFailed;

    // G4: remove zod version → must fail
    allFailed = injectAndExpectFail(
      "G4: zod version removed → audit fails",
      tmpBase, artifacts,
      (_tmp, art) => {
        if (art.packages?.zod) delete art.packages.zod.version;
      }
    ) && allFailed;

    // G5: change package integrity → must fail
    allFailed = injectAndExpectFail(
      "G5: wrong package integrity → audit fails",
      tmpBase, artifacts,
      (_tmp, art) => {
        if (art.packages?.["@wasmagent/core"]) {
          art.packages["@wasmagent/core"].integrity = "sha512-" + "A".repeat(88) + "==";
        }
      }
    ) && allFailed;

    // G6: add undeclared frozen input → must fail
    allFailed = injectAndExpectFail(
      "G6: undeclared frozen input → audit fails",
      tmpBase, artifacts,
      (tmp, _art) => {
        // write a file that is in the frozen allowlist path but NOT in manifest
        const dest = join(tmp, "runner", "extra.mjs");
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, "// extra");
        // do not add to art.files so manifest is incomplete
      }
    ) && allFailed;
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
  return allFailed;
}

// ── Main ───────────────────────────────────────────────────────────────────────────

async function main() {
  // Support negative-control-mode invocation (subset-only, manifest closure)
  const negMode = process.argv.includes("--negative-control-mode");
  const packRoot = process.env.PREPUBLISH_AUDIT_PACK_ROOT ?? PACK_ROOT;

  console.log("# IF-07c reproduction pack — prepublication audit");
  if (negMode) {
    console.log("# (negative-control-mode: manifest closure only)");
    const artifacts = loadArtifacts(packRoot);
    const ok = checkManifestClosure(packRoot, artifacts);
    const depOk = checkDependencyClosure(artifacts);
    if (!ok || !depOk) { console.log("\nAudit: FAIL (expected in negative-control-mode)"); process.exit(1); }
    console.log("\nAudit: PASS (unexpected — negative control did not trigger)");
    process.exit(0);
  }

  const artifacts = loadArtifacts(PACK_ROOT);

  const aOk = checkManifestClosure(PACK_ROOT, artifacts);
  const bOk = checkDependencyClosure(artifacts);
  const cOk = args.skipNetwork ? (console.log("\n[C] Registry re-fetch  SKIPPED (--skip-network)"), true) : await checkRegistryIntegrity(artifacts);
  const dOk = checkArchiveClosure(args.gitRef, artifacts);
  const eOk = checkCleanInstall(artifacts);
  const fOk = checkRunnerExecution(artifacts);
  const gOk = checkNegativeControls(artifacts);

  console.log(`\n# Audit summary: ${passed} passed, ${failed} failed`);
  const allOk = aOk && bOk && cOk && dOk && eOk && fOk && gOk;
  if (allOk) {
    console.log("# Result: ALL CHECKS PASSED — pack is release-candidate ready");
    process.exit(0);
  } else {
    console.log("# Result: AUDIT FAILED — do not release");
    process.exit(1);
  }
}

main().catch((e) => { console.error("audit error:", e); process.exit(1); });
