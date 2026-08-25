import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = JSON.parse(
  readFileSync(new URL("../.github/ci-known-test-failures.json", import.meta.url), "utf8"),
);
const outputDir = mkdtempSync(join(tmpdir(), "hermes-ci-tests-"));
const reportPath = join(outputDir, "vitest.json");

try {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 50 * 1024 * 1024,
    },
  );

  if (result.error) {
    console.error(`Unable to execute Vitest: ${result.error.message}`);
    process.exitCode = 1;
  } else {
    let report;
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      console.error("Vitest did not produce a readable JSON report.");
      process.exitCode = 1;
    }

    if (report) {
      const assertions = report.testResults.flatMap((file) => file.assertionResults ?? []);
      const actualFailures = new Set(
        assertions
          .filter((assertion) => assertion.status === "failed")
          .map((assertion) => assertion.fullName || assertion.title),
      );
      const knownFailures = new Set(baseline.knownFailureNames);
      const unexpected = [...actualFailures].filter((name) => !knownFailures.has(name)).sort();
      const resolved = [...knownFailures].filter((name) => !actualFailures.has(name)).sort();
      const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
      const normalizeFile = (name) => name.replaceAll("\\", "/").replace(`${normalizedRoot}/`, "");
      const actualFileFailures = new Set(
        report.testResults
          .filter(
            (file) =>
              file.status === "failed" &&
              !(file.assertionResults ?? []).some((test) => test.status === "failed"),
          )
          .map((file) => normalizeFile(file.name)),
      );
      const knownFileFailures = new Set(baseline.knownFailureFiles);
      const unexpectedFiles = [...actualFileFailures]
        .filter((name) => !knownFileFailures.has(name))
        .sort();
      const resolvedFiles = [...knownFileFailures]
        .filter((name) => !actualFileFailures.has(name))
        .sort();
      const testFileCount = report.testResults.length;
      const tooFewFiles = testFileCount < baseline.minimumTestFiles;
      const tooFewTests = report.numTotalTests < baseline.minimumTests;

      console.log(
        `Vitest: ${testFileCount} files, ${report.numTotalTests} tests, ` +
          `${report.numPassedTests} passed, ${report.numFailedTests} known-or-new failures.`,
      );
      console.log(
        `Debt baseline: ${actualFailures.size - unexpected.length} known assertions and ` +
          `${actualFileFailures.size - unexpectedFiles.length} known file failures remain; ` +
          `${resolved.length + resolvedFiles.length} resolved.`,
      );

      if (resolved.length > 0 || resolvedFiles.length > 0) {
        console.log("Resolved baseline entries (remove these in the same PR):");
        for (const name of resolved) console.log(`- ${name}`);
        for (const name of resolvedFiles) console.log(`- ${name}`);
      }
      if (unexpected.length > 0) {
        console.error("Unexpected failures:");
        for (const name of unexpected) console.error(`- ${name}`);
      }
      if (unexpectedFiles.length > 0) {
        console.error("Unexpected file-level failures:");
        for (const name of unexpectedFiles) console.error(`- ${name}`);
      }
      if (tooFewFiles || tooFewTests) {
        console.error(
          `Suite-size guard failed: expected at least ${baseline.minimumTestFiles} files and ` +
            `${baseline.minimumTests} tests.`,
        );
      }

      if (unexpected.length > 0 || unexpectedFiles.length > 0 || tooFewFiles || tooFewTests) {
        process.exitCode = 1;
      }
    }
  }
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
