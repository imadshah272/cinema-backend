#!/usr/bin/env node
"use strict";

/**
 * Autopilot: keeps media_sources filled without anyone running anything.
 * Run by pm2 every 6 hours (see the README section printed by --help):
 *
 *   1. Every run: new movies of the last 60 days, six industries, cinema prints allowed.
 *      A clean print found later is stored next to the CAM and served first.
 *   2. Daily: new series episodes (episodes without Hindi are retried until one appears).
 *      Sundays: 1-year backfill of movies and series, top rated + trending + franchises.
 *   3. Repair: hide wrong film / 4K / wrong season / CAM-with-clean rows, fix episode sizes.
 *   4. Audit summary into the log.
 *
 * Each step is a separate node process so one failure never stops the others.
 * The last run is recorded in scripts/.autopilot-last.json.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SCRIPTS = __dirname;
const STATE_FILE = path.join(SCRIPTS, ".autopilot-last.json");
const STEP_TIMEOUT_MS = 3 * 60 * 60 * 1000;

if (process.argv.includes("--help")) {
  console.log(`Start on the VPS (cd cinema-backend):
  pm2 start scripts/autopilot.js --name autopilot --cron-restart "0 */6 * * *" --no-autorestart
  pm2 save
Logs: pm2 logs autopilot`);
  process.exit(0);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function runStep(name, script, args) {
  const started = Date.now();
  console.log(`\n[autopilot] ${new Date().toISOString()} ▶ ${name}: node ${script} ${args.join(" ")}`);
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    cwd: path.join(SCRIPTS, ".."),
    stdio: "inherit",
    timeout: STEP_TIMEOUT_MS,
  });
  const result = { name, ok: res.status === 0, exitCode: res.status, minutes: Math.round((Date.now() - started) / 600) / 100 };
  console.log(`[autopilot] ${result.ok ? "✓" : "✗"} ${name} (${result.minutes} min)`);
  return result;
}

function main() {
  const state = readState();
  const today = new Date().toISOString().slice(0, 10);
  const daily = state.lastDaily !== today;
  const weekly = new Date().getUTCDay() === 0 && state.lastWeekly !== today;

  // Every run: new movies (cinema prints now, clean prints as soon as they appear).
  const steps = [runStep("new movies", "ingestNewReleasesHindi.js", ["--days=60", "--pages=3"])];
  if (daily) {
    // Once a day: new episodes of shows aired in the last 30 days; episodes still
    // without Hindi are retried every day until a Hindi release appears.
    steps.push(runStep("new series episodes", "ingestSeriesHindi.js", ["--days=30", "--pages=1"]));
  }
  if (weekly) {
    // Once a week: Hindi dubs that arrive months after release, plus the classics.
    steps.push(runStep("movies backfill (1 year)", "ingestNewReleasesHindi.js", ["--days=365", "--pages=5"]));
    steps.push(runStep("series backfill (1 year)", "ingestSeriesHindi.js", ["--days=365", "--pages=2"]));
    steps.push(runStep("top rated + trending + parts", "ingestNewReleasesHindi.js", ["--mode=top", "--count=20", "--with-parts"]));
    steps.push(runStep("franchises", "ingestNewReleasesHindi.js", ["--mode=franchises", "--count=40"]));
  }
  steps.push(runStep("repair", "repairMediaSources.js", ["--apply"]));
  steps.push(runStep("audit", "auditMediaSources.js", []));

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        lastRun: new Date().toISOString(),
        lastDaily: daily ? today : state.lastDaily || null,
        lastWeekly: weekly ? today : state.lastWeekly || null,
        steps,
      },
      null,
      2
    )
  );
  console.log(`\n[autopilot] done: ${steps.filter((s) => s.ok).length}/${steps.length} steps ok`);
}

main();
