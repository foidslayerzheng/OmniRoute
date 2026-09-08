#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiFetch } from "../../bin/cli/api.mjs";

const RESULT_MARKER = "@@HERMES_OFFLINE_EVALS@@";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const manifestPath = path.join(repoRoot, "src/lib/evals/evalRunner/hermesOfflineSuites.json");
const collectorPath = path.join(scriptDir, "collect-hermes-offline.py");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const submit = process.argv.includes("--submit");
const hermesRoot = path.resolve(option("--hermes-root", "/home/louis/.hermes/hermes-agent"));
const python = option(
  "--python",
  fs.existsSync(path.join(hermesRoot, ".venv/bin/python"))
    ? path.join(hermesRoot, ".venv/bin/python")
    : "python3"
);

const collected = spawnSync(
  python,
  [collectorPath, "--manifest", manifestPath, "--hermes-root", hermesRoot],
  {
    cwd: hermesRoot,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  }
);
if (collected.error) throw collected.error;
process.stderr.write(collected.stderr || "");
const markerLine = (collected.stdout || "")
  .split(/\r?\n/)
  .findLast((line) => line.startsWith(RESULT_MARKER));
if (!markerLine) {
  throw new Error("Hermes collector did not return a result payload");
}
const result = JSON.parse(markerLine.slice(RESULT_MARKER.length));
if (collected.status !== 0 || result.error) {
  throw new Error(result.error || `Hermes collector exited with ${collected.status}`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const summaries = [];
for (const suite of manifest.suites) {
  const outputs = result.suites[suite.id];
  if (!outputs || Object.keys(outputs).length !== suite.cases.length) {
    throw new Error(`Collector output did not match suite "${suite.id}"`);
  }
  const passed = Object.values(outputs).filter((status) => status === "passed").length;
  const summary = {
    suiteId: suite.id,
    total: suite.cases.length,
    passed,
    failed: suite.cases.length - passed,
    submitted: false,
  };

  if (submit) {
    const response = await apiFetch("/api/evals", {
      method: "POST",
      body: { suiteId: suite.id, outputs },
      timeout: 120_000,
      retry: false,
    });
    const body = await response.json();
    if (!response.ok) {
      const message = body?.error?.message || body?.error || `HTTP ${response.status}`;
      throw new Error(`Failed to ingest suite "${suite.id}": ${message}`);
    }
    summary.submitted = true;
    summary.runId = body.runId;
    summary.passRate = body.summary?.passRate;
  }
  summaries.push(summary);
}

console.log(
  JSON.stringify(
    {
      mode: submit ? "submit" : "dry-run",
      pytestExitCode: result.pytestExitCode,
      suites: summaries,
    },
    null,
    2
  )
);
