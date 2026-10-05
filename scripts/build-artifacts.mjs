#!/usr/bin/env node
// Build ARTIFACTS.json for the IF-07c independent reproduction pack.
//
// Records, deterministically:
//   - the exact published npm versions installed in the verification
//     directory (default: ./pack-verify), with registry integrity and the
//     SHA256 of the downloaded tarball;
//   - the SHA256 of every pack file (runner, fixtures, profile,
//     expected-results, docs, this script);
//   - the node/npm versions used.
//
// Usage:
//   npm install zod @wasmagent/core@X @wasmagent/mcp-firewall@Y @wasmagent/mcp-gateway@Z
//   node runner/run.mjs          # in a copy of the pack, per README
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

/** Every pack file under PACK_ROOT except generated/verification dirs. */
function packFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const rel = relative(PACK_ROOT, full);
      if (statSync(full).isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        walk(full);
      } else if (entry !== "ARTIFACTS.json" && entry !== "package.json" && entry !== "package-lock.json") {
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

  const doc = {
    format: "if07c-independent-reproduction/artifacts/v1",
    generatedAtUtc: new Date().toISOString(),
    toolchain: {
      node: process.versions.node,
      npm: sh("npm", ["--version"]),
    },
    packages,
    files,
    verification: {
      installDirectory: relative(PACK_ROOT, prefix) || ".",
      runnerCommand: "node runner/run.mjs",
      note: "A third party re-running this pack must compare the files{} hashes against their copy, then re-verify packages{} against the registry (npm view dist.integrity / tarball sha256) before trusting a run record.",
    },
  };

  const out = join(PACK_ROOT, "ARTIFACTS.json");
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${out} (${Object.keys(files).length} files, ${Object.keys(packages).length} packages)`);
  return 0;
}

process.exit(main());
