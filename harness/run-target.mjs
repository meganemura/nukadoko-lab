#!/usr/bin/env node
// Responsibility: drive one target through nukadoko directly — the corpus's
// own `npm test`/`cucumber-js` bin is never invoked; this script always
// calls `nuka` on the corpus's features itself, since nukadoko ships no
// `cucumber-js`-named binary for a corpus's own scripts to find. One
// invocation = one target, one track:
//
//   node harness/run-target.mjs <target-name> --track=npm|main
//
// Steps: copy the corpus subpath to a scratch working copy -> rewrite its
// `@cucumber/cucumber` imports (harness/rewrite-import.mjs) -> install
// nukadoko into that copy (npm track: `npm install nukadoko@<latest>`; main
// track: build a local clone of github.com/meganemura/nukadoko and symlink
// it in) -> run `nuka run`/`check`/`tend` against the copy -> write one
// result JSON to results/<target-id>/<file>.json.
//
// `nuka run` is invoked without `--json`, unlike `check`/`tend` here: it
// (see nukadoko src/cli/run-cli.ts's `runCommand` builder) has no `--json`
// option — only `check`/`tend` do. Passing `--json` to `run` fails yargs'
// `.strict()` parse (exit 1, nothing runs) rather than requesting JSON.
// `nuka run` already writes one JSON scenario record per line to stdout
// unconditionally (src/cli/run.ts), so that stream is captured and parsed
// the same way `--json` output from `check`/`tend` is, and `run` is invoked
// without the flag. Recorded here rather than guessed past silently.
//
// A door named "playwright" runs a different sequence: the corpus is a
// Playwright Test suite with no cucumber-js import to rewrite, so instead
// of `rewrite-import.mjs`, a hand-written overlay under `overlays/<target-
// id>/` is copied onto the working copy. That target's own `playwright
// test` is run twice: once against the untouched corpus (baseline), and
// again once nukadoko is installed and the overlay applied. A baseline
// failure never reaches nukadoko at all, since this target's suite reaches
// an externally hosted demo site; that failure is recorded as
// `corpusUnavailable` rather than a FAIL this project's own commit caused.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rewriteImports } from "./rewrite-import.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS_PATH = path.join(REPO_ROOT, "harness", "targets.json");
const CORPORA_DIR = path.join(REPO_ROOT, "corpora");
const RESULTS_DIR = path.join(REPO_ROOT, "results");
const WORK_DIR = path.join(REPO_ROOT, ".nukadoko-work");
const MAIN_CLONE_DIR = path.join(REPO_ROOT, ".nukadoko-main-clone");
const MAIN_REPO_URL = "https://github.com/meganemura/nukadoko.git";

function parseArgs(argv) {
  let name = null;
  let track = null;
  for (const arg of argv) {
    if (arg.startsWith("--track=")) {
      track = arg.slice("--track=".length);
    } else if (arg === "--track") {
      throw new Error("use --track=npm or --track=main (no space form)");
    } else if (!arg.startsWith("-")) {
      name = arg;
    }
  }
  if (!name) throw new Error("usage: node harness/run-target.mjs <target-name> --track=npm|main");
  if (track !== "npm" && track !== "main") {
    throw new Error(`--track must be "npm" or "main", got ${JSON.stringify(track)}`);
  }
  return { name, track };
}

function loadTargets() {
  return JSON.parse(readFileSync(TARGETS_PATH, "utf8")).targets;
}

function targetId(target) {
  return `${target.submodule}--${target.subpath.replace(/\//g, "-")}`;
}

// Minimal resolver for the one glob shape targets.json actually uses
// (`<dir>/**/*.<ext>`) — not a general glob implementation. Splits at the
// first `**` segment for the search root, and matches file names by the
// suffix after the last `*`.
function resolveFeatureFiles(workDir, glob) {
  const starIndex = glob.indexOf("*");
  const rootSegment = starIndex === -1 ? glob : glob.slice(0, starIndex).replace(/\/$/, "");
  const suffix = glob.slice(glob.lastIndexOf("*") + 1);
  const root = path.join(workDir, rootSegment);
  const found = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        found.push(path.relative(workDir, full));
      }
    }
  };
  walk(root);
  return found.sort();
}

function copyCorpusSubpath(target) {
  const source = path.join(CORPORA_DIR, target.submodule, target.subpath);
  if (!existsSync(source)) {
    throw new Error(
      `corpus subpath not found: ${source} (is the submodule initialized? git submodule update --init)`,
    );
  }
  return source;
}

function prepareWorkingCopy(target, track) {
  const source = copyCorpusSubpath(target);
  const workDir = path.join(WORK_DIR, targetId(target), track);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  cpDir(source, workDir, new Set(["node_modules", ".git"]));

  // Harness scaffolding, not a corpus patch (spec: "コーパスは無改変で使う"
  // covers the submodule; this is the working copy's own package.json,
  // replacing the corpus's original one). A fresh minimal file avoids the
  // corpus's own package-lock.json / devDependencies interfering with
  // installing nukadoko below, while keeping "type": "module" — required
  // for Node to load the corpus's own `.js` step files as ESM (they use
  // `import`/`export` syntax; nukadoko's discover-steps.ts loads them via
  // dynamic `import()`, which resolves module type from the nearest
  // package.json).
  rmSync(path.join(workDir, "package-lock.json"), { force: true });
  writeFileSync(
    path.join(workDir, "package.json"),
    JSON.stringify({ name: `${targetId(target)}-${track}-work`, private: true, type: "module" }, null, 2) + "\n",
  );

  // nuka init's own template (src/cli/init.ts's configTemplate) with every
  // field left at its default — esm-node's own layout already matches
  // nukadoko's default `featuresDir: "features"` (docs/migration.md "Stage
  // 0"), and this target makes no baseURL-reaching calls. `target.featuresDir`
  // is an optional targets.json field for a corpus whose features/step-
  // definitions/hooks/world/env live in separate top-level directories
  // rather than under a single conventional `features/` tree (e.g.
  // cucumber7-ts-starter) — only written into the generated config when the
  // target actually sets it, so every other target keeps getting the plain
  // `defineConfig({})` it always has.
  const configBody = target.featuresDir === undefined ? "{}" : `{\n  featuresDir: ${JSON.stringify(target.featuresDir)},\n}`;
  writeFileSync(
    path.join(workDir, "nukadoko.config.ts"),
    `import { defineConfig } from "nukadoko";\n\nexport default defineConfig(${configBody});\n`,
  );

  const changedFiles = rewriteImports(workDir);

  return { workDir, changedFiles };
}

function cpDir(source, dest, skipNames) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      cpDir(from, to, skipNames);
    } else if (entry.isFile()) {
      writeFileSync(to, readFileSync(from));
    }
  }
}

function npmLatestVersion() {
  return execFileSync("npm", ["view", "nukadoko", "version"], { encoding: "utf8" }).trim();
}

// Skips downloading Chromium/Firefox/WebKit binaries during `npm install`
// (playwright is one of nukadoko's own `dependencies`) — none of this
// target's steps call `openPage()`/`openRequest()` (docs/migration.md "The
// measured upgrade"), so no browser is ever launched; downloading one would
// only slow this harness down for nothing it exercises.
const NO_BROWSER_DOWNLOAD_ENV = { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" };

// `--min-release-age=0` applies to this one install and nothing else in
// this harness. A machine that sets npm's `min-release-age` refuses a
// version published inside that window, which is the correct default for a
// project taking on a dependency and the wrong one here: this row exists to
// say what a release does, so the harness has to be able to install the
// exact version it is measuring, including one published today. Every other
// install this harness runs (a corpus's own dependencies) keeps whatever
// policy the machine has, since those are ordinary third-party packages
// being taken on rather than the subject of the measurement.
function installNpmTrack(workDir) {
  const version = npmLatestVersion();
  const result = spawnSync(
    "npm",
    [
      "install",
      `nukadoko@${version}`,
      "--min-release-age=0",
      "--no-save",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: workDir, encoding: "utf8", env: NO_BROWSER_DOWNLOAD_ENV },
  );
  if (result.status !== 0) {
    throw new Error(`npm install nukadoko@${version} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return { nukadokoVersion: version };
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", env: NO_BROWSER_DOWNLOAD_ENV });
  if (result.status !== 0 && result.error) throw result.error;
  return result;
}

function ensureMainClone() {
  if (!existsSync(MAIN_CLONE_DIR)) {
    run("git", ["clone", MAIN_REPO_URL, MAIN_CLONE_DIR], REPO_ROOT);
  } else {
    run("git", ["fetch", "origin", "main"], MAIN_CLONE_DIR);
    run("git", ["reset", "--hard", "origin/main"], MAIN_CLONE_DIR);
  }
  const install = run("npm", ["install", "--no-audit", "--no-fund"], MAIN_CLONE_DIR);
  if (install.status !== 0) {
    throw new Error(`npm install in main clone failed:\n${install.stdout}\n${install.stderr}`);
  }
  const build = run("npm", ["run", "build"], MAIN_CLONE_DIR);
  if (build.status !== 0) {
    throw new Error(`npm run build in main clone failed:\n${build.stdout}\n${build.stderr}`);
  }
  const commitSha = execFileSync("git", ["-C", MAIN_CLONE_DIR, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  return commitSha;
}

function installMainTrack(workDir) {
  const commitSha = ensureMainClone();
  const nodeModules = path.join(workDir, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  const link = path.join(nodeModules, "nukadoko");
  rmSync(link, { force: true });
  symlinkSync(MAIN_CLONE_DIR, link, "dir");
  return { commitSha };
}

function nukaCliPath(workDir) {
  return path.join(workDir, "node_modules", "nukadoko", "dist", "cli.js");
}

function runNuka(cliPath, args, cwd) {
  const result = spawnSync("node", [cliPath, ...args], { cwd, encoding: "utf8" });
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

// `nuka run` has no `--json` (see this file's own header) — its stdout is
// already one JSON scenario record per line unconditionally.
function parseRunStdout(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function parseJsonStdout(stdout) {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function resultsPathFor(id, track, versionInfo) {
  const fileName = track === "npm" ? `${versionInfo.nukadokoVersion}.json` : "main.json";
  return path.join(RESULTS_DIR, id, fileName);
}

function runCompatDoor(target, id, track) {
  // npm track only: `<semver>.json` is persistent, one per released
  // version, written the first time that version is seen and never
  // regenerated after, so a row stays the measurement that version
  // actually got rather than one taken later against a corpus or a
  // machine that has moved on. main track's own `main.json` always
  // overwrites (checked further down, after the commitSha is known)
  // since it tracks a moving target.
  if (track === "npm") {
    const version = npmLatestVersion();
    const existingPath = resultsPathFor(id, track, { nukadokoVersion: version });
    if (existsSync(existingPath)) {
      console.log(`${existingPath} already exists for nukadoko@${version}; not regenerating.`);
      return;
    }
  }

  const { workDir, changedFiles } = prepareWorkingCopy(target, track);
  console.log(`working copy: ${workDir}`);
  console.log(`rewritten imports in: ${changedFiles.join(", ") || "(none)"}`);

  const versionInfo = track === "npm" ? installNpmTrack(workDir) : installMainTrack(workDir);
  const cliPath = nukaCliPath(workDir);
  if (!existsSync(cliPath)) {
    throw new Error(`nukadoko CLI not found at ${cliPath} after install`);
  }

  const featureFiles = resolveFeatureFiles(workDir, target.featureGlob);
  if (featureFiles.length !== 1) {
    throw new Error(
      `expected exactly one feature file matching ${target.featureGlob} in ${workDir}, found ${featureFiles.length}: ${featureFiles.join(", ")}`,
    );
  }
  const [featureFile] = featureFiles;

  const runResult = runNuka(cliPath, ["run", featureFile], workDir);
  const scenarios = runResult.exitCode === 0 || runResult.stdout.length > 0 ? parseRunStdout(runResult.stdout) : [];
  const scenarioCount = scenarios.length;
  const runPass = runResult.exitCode === 0 && scenarioCount >= target.expectedScenarioCount;

  const checkResult = runNuka(cliPath, ["check", "--json"], workDir);
  const tendResult = runNuka(cliPath, ["tend", "--json"], workDir);

  const result = {
    targetId: id,
    targetName: target.name,
    door: target.door,
    track,
    generatedAt: new Date().toISOString(),
    ...versionInfo,
    featureFile,
    expectedScenarioCount: target.expectedScenarioCount,
    run: {
      command: `nuka run ${featureFile}`,
      note: "no --json (run has none — see this file's own header); stdout is one JSON scenario record per line, parsed below",
      exitCode: runResult.exitCode,
      scenarioCount,
      scenarios,
      stderr: runResult.stderr,
      pass: runPass,
    },
    check: {
      command: "nuka check --json",
      exitCode: checkResult.exitCode,
      json: parseJsonStdout(checkResult.stdout),
      stderr: checkResult.stderr,
      pass: checkResult.exitCode === 0,
    },
    tend: {
      command: "nuka tend --json",
      exitCode: tendResult.exitCode,
      json: parseJsonStdout(tendResult.stdout),
      stderr: tendResult.stderr,
      pass: tendResult.exitCode === 0,
    },
  };
  result.pass = result.run.pass && result.check.pass && result.tend.pass;

  const outPath = resultsPathFor(id, track, versionInfo);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`wrote ${outPath}`);
  console.log(
    `run: exit=${runResult.exitCode} scenarios=${scenarioCount}/${target.expectedScenarioCount} pass=${runPass}`,
  );
  console.log(`check: exit=${checkResult.exitCode} pass=${result.check.pass}`);
  console.log(`tend: exit=${tendResult.exitCode} pass=${result.tend.pass}`);
}

const OVERLAYS_DIR = path.join(REPO_ROOT, "overlays");
// Files in an overlay's own top level that describe the overlay itself
// rather than belonging to the working copy it gets applied to.
const OVERLAY_META_FILES = new Set(["LICENSE", "NOTICE", "README.md"]);

// Pinned rather than left to whatever `npm install` would resolve today:
// 1.61.1 is nukadoko's own `playwright` dependency version (package.json),
// so the chromium already downloaded for nukadoko's own install is reused
// here too, and no second browser download is triggered.
const PLAYWRIGHT_TEST_VERSION = "1.61.1";
// The version the overlay's own package.json already names as its floor
// (`"dotenv": "^17.2.3"`), pinned exactly for a reproducible install.
const DOTENV_VERSION = "17.2.3";

function preparePlaywrightWorkingCopy(target, track) {
  const source = copyCorpusSubpath(target);
  const workDir = path.join(WORK_DIR, targetId(target), track);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  // No package.json/config scaffolding and no import rewrite here (unlike
  // `prepareWorkingCopy` above): the baseline run right after this needs
  // the corpus exactly as published, since a scaffolding change could be
  // mistaken for the overlay's own effect.
  cpDir(source, workDir, new Set(["node_modules", ".git"]));
  return workDir;
}

function copyOverlayDir(source, dest, isRoot) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (isRoot && OVERLAY_META_FILES.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyOverlayDir(from, to, false);
    } else if (entry.isFile()) {
      writeFileSync(to, readFileSync(from));
    }
  }
}

function applyOverlay(target, workDir) {
  const overlayDir = path.join(OVERLAYS_DIR, targetId(target));
  if (!existsSync(overlayDir)) {
    throw new Error(`overlay not found: ${overlayDir}`);
  }
  copyOverlayDir(overlayDir, workDir, true);
}

function installPlaywrightTestDeps(workDir) {
  const result = spawnSync(
    "npm",
    [
      "install",
      `@playwright/test@${PLAYWRIGHT_TEST_VERSION}`,
      `dotenv@${DOTENV_VERSION}`,
      "--no-save",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: workDir, encoding: "utf8", env: NO_BROWSER_DOWNLOAD_ENV },
  );
  if (result.status !== 0) {
    throw new Error(
      `npm install @playwright/test@${PLAYWRIGHT_TEST_VERSION} dotenv@${DOTENV_VERSION} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
}

function tail(text, maxChars = 4000) {
  if (!text) return "";
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

// `--reporter=json` overrides the corpus's own `playwright.config.ts`
// (which lists `html` + `list`), so this always gets one JSON object on
// stdout to parse rather than a mix of an HTML report directory and
// terminal-formatted lines.
function runPlaywrightTestSuite(workDir) {
  const result = spawnSync("npx", ["playwright", "test", "--project=chromium", "--reporter=json"], {
    cwd: workDir,
    encoding: "utf8",
    env: NO_BROWSER_DOWNLOAD_ENV,
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = parseJsonStdout(result.stdout);
  const stats = parsed?.stats ?? null;
  const testCount = stats ? stats.expected + stats.unexpected + stats.skipped + (stats.flaky ?? 0) : null;
  return {
    command: "npx playwright test --project=chromium --reporter=json",
    exitCode: result.status ?? 1,
    stats,
    testCount,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
  };
}

// Every `import ... from "specifier"` in a file, value or type-only alike
// (a type-only import still names the module it wants). Good enough for
// this door's own overlay files, not a general parser.
function extractImportSpecifiers(source) {
  const specifiers = [];
  const re = /import\s+(?:[^'";]+?)\s+from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g;
  let match;
  while ((match = re.exec(source))) {
    specifiers.push(match[1] ?? match[2]);
  }
  return specifiers;
}

function collectFiles(dir, predicate, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, predicate, found);
    } else if (entry.isFile() && predicate(full)) {
      found.push(full);
    }
  }
  return found;
}

// The arrow this door has to prove one way every run: the Playwright side
// never imports nukadoko, and its one shared layer imports nothing but
// Playwright and zod. Checked mechanically here rather than trusted from
// the overlay's own README, since the overlay is exactly what gets edited
// if this ever needs to change.
function checkArrows(workDir) {
  const violations = [];
  const testsDir = path.join(workDir, "tests");

  const specFiles = collectFiles(testsDir, (file) => file.endsWith(".spec.ts"));
  const fixturesFile = path.join(testsDir, "fixtures.ts");
  const mustNotImportNukadoko = existsSync(fixturesFile) ? [...specFiles, fixturesFile] : specFiles;
  for (const file of mustNotImportNukadoko) {
    if (extractImportSpecifiers(readFileSync(file, "utf8")).includes("nukadoko")) {
      violations.push(`${path.relative(workDir, file)} imports "nukadoko"`);
    }
  }

  const sharedLib = path.join(testsDir, "lib", "todo.ts");
  if (!existsSync(sharedLib)) {
    violations.push("tests/lib/todo.ts not found");
  } else {
    const allowed = new Set(["@playwright/test", "zod"]);
    for (const specifier of extractImportSpecifiers(readFileSync(sharedLib, "utf8"))) {
      if (!allowed.has(specifier)) {
        violations.push(`tests/lib/todo.ts imports ${JSON.stringify(specifier)} (only @playwright/test and zod are allowed)`);
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

function runPlaywrightDoor(target, id, track) {
  // The npm track's result file name needs the resolved version up front:
  // baseline can fail before nukadoko is ever installed, and the
  // `corpusUnavailable` result still has to land at the path a passing run
  // would use.
  let versionInfo = track === "npm" ? { nukadokoVersion: npmLatestVersion() } : {};

  if (track === "npm") {
    const existingPath = resultsPathFor(id, track, versionInfo);
    if (existsSync(existingPath)) {
      console.log(`${existingPath} already exists for nukadoko@${versionInfo.nukadokoVersion}; not regenerating.`);
      return;
    }
  }

  const workDir = preparePlaywrightWorkingCopy(target, track);
  console.log(`working copy: ${workDir}`);

  installPlaywrightTestDeps(workDir);

  const baseline = runPlaywrightTestSuite(workDir);
  console.log(`baseline playwright test: exit=${baseline.exitCode} tests=${baseline.testCount}`);

  // This target's suite reaches an externally hosted demo site
  // (https://demo.playwright.dev/todomvc). nukadoko is not installed yet
  // at this point, so a baseline failure here cannot be this project's own
  // doing; it is recorded as `corpusUnavailable` and no PASS/FAIL line is
  // written, rather than charging a dead demo site to nukadoko's account.
  if (baseline.exitCode !== 0) {
    const result = {
      targetId: id,
      targetName: target.name,
      door: target.door,
      track,
      generatedAt: new Date().toISOString(),
      corpusUnavailable: true,
      note:
        "baseline `playwright test` failed against the unmodified corpus, before nukadoko was installed. " +
        "Recorded as corpusUnavailable, not a nukadoko-caused FAIL, since this target reaches an externally " +
        "hosted demo site (https://demo.playwright.dev/todomvc).",
      playwrightBaseline: baseline,
    };
    const outPath = resultsPathFor(id, track, versionInfo);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
    console.log(`corpusUnavailable: wrote ${outPath} (no PASS/FAIL line; baseline could not reach the demo site)`);
    return;
  }

  applyOverlay(target, workDir);

  const installed = track === "npm" ? installNpmTrack(workDir) : installMainTrack(workDir);
  versionInfo = { ...versionInfo, ...installed };
  const cliPath = nukaCliPath(workDir);
  if (!existsSync(cliPath)) {
    throw new Error(`nukadoko CLI not found at ${cliPath} after install`);
  }

  const afterOverlay = runPlaywrightTestSuite(workDir);
  const suitePass = afterOverlay.exitCode === 0 && afterOverlay.testCount === baseline.testCount;
  console.log(`overlay playwright test: exit=${afterOverlay.exitCode} tests=${afterOverlay.testCount} pass=${suitePass}`);

  const runResult = runNuka(cliPath, ["run", "features"], workDir);
  const scenarios = runResult.exitCode === 0 || runResult.stdout.length > 0 ? parseRunStdout(runResult.stdout) : [];
  const scenarioCount = scenarios.length;
  const runPass = runResult.exitCode === 0 && scenarioCount >= target.expectedScenarioCount;

  const checkResult = runNuka(cliPath, ["check", "--json"], workDir);
  const tendResult = runNuka(cliPath, ["tend", "--json"], workDir);

  const arrows = checkArrows(workDir);

  const result = {
    targetId: id,
    targetName: target.name,
    door: target.door,
    track,
    generatedAt: new Date().toISOString(),
    ...versionInfo,
    featuresDir: "features",
    expectedScenarioCount: target.expectedScenarioCount,
    expectedPlaywrightTests: target.expectedPlaywrightTests,
    playwrightBaseline: baseline,
    playwrightAfterOverlay: { ...afterOverlay, pass: suitePass },
    arrows,
    run: {
      command: "nuka run features",
      note: "no --json (run has none, see this file's own header); stdout is one JSON scenario record per line, parsed below",
      exitCode: runResult.exitCode,
      scenarioCount,
      scenarios,
      stderr: runResult.stderr,
      pass: runPass,
    },
    check: {
      command: "nuka check --json",
      exitCode: checkResult.exitCode,
      json: parseJsonStdout(checkResult.stdout),
      stderr: checkResult.stderr,
      pass: checkResult.exitCode === 0,
    },
    tend: {
      command: "nuka tend --json",
      exitCode: tendResult.exitCode,
      json: parseJsonStdout(tendResult.stdout),
      stderr: tendResult.stderr,
      pass: tendResult.exitCode === 0,
    },
  };
  result.pass = suitePass && arrows.ok && result.run.pass && result.check.pass && result.tend.pass;

  const outPath = resultsPathFor(id, track, versionInfo);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`wrote ${outPath}`);
  console.log(`arrows: ok=${arrows.ok}${arrows.ok ? "" : ` violations=${arrows.violations.join("; ")}`}`);
  console.log(
    `run: exit=${runResult.exitCode} scenarios=${scenarioCount}/${target.expectedScenarioCount} pass=${runPass}`,
  );
  console.log(`check: exit=${checkResult.exitCode} pass=${result.check.pass}`);
  console.log(`tend: exit=${tendResult.exitCode} pass=${result.tend.pass}`);
}

function main() {
  const { name, track } = parseArgs(process.argv.slice(2));
  const targets = loadTargets();
  const target = targets.find((candidate) => candidate.name === name);
  if (!target) {
    throw new Error(`unknown target "${name}" (see harness/targets.json)`);
  }
  const id = targetId(target);

  if (target.door === "playwright") {
    runPlaywrightDoor(target, id, track);
    return;
  }

  // Only the compat door has a mechanical transform this script can apply
  // on its own (rewrite one import specifier); the playwright door is
  // handled above. Any other declared door is refused by name rather than
  // silently run through the compat path, which would write a result row
  // claiming a measurement that never ran.
  if (target.door !== "compat") {
    throw new Error(
      `target "${name}" declares door ${JSON.stringify(target.door)}; this harness only runs the "compat" and "playwright" doors`,
    );
  }

  runCompatDoor(target, id, track);
}

main();
