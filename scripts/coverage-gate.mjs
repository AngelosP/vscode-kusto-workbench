/**
 * Coverage gate — fails if statement coverage drops below the recorded baseline.
 *
 * Usage:  node scripts/coverage-gate.mjs
 *
 * Runs `vitest run --coverage`, reads the json-summary output, and exits 1 if
 * the statements percentage is below (BASELINE - BUFFER).
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// ── Configuration ─────────────────────────────────────────────────────────────
const BASELINE_STATEMENTS = 28.07; // recorded 2026-03-22 — critical path regression tests
const BUFFER = 0.5; // allow this much drop before failing
const THRESHOLD = BASELINE_STATEMENTS - BUFFER;

// ── Run coverage ──────────────────────────────────────────────────────────────
try {
	execSync('npx vitest run --coverage', { cwd: root, stdio: 'inherit' });
} catch {
	console.error('\n❌  Vitest exited with errors — coverage gate cannot proceed.');
	process.exit(1);
}

// ── Parse json-summary ────────────────────────────────────────────────────────
const summaryPath = resolve(root, 'coverage', 'coverage-summary.json');
let summary;
try {
	summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
} catch (e) {
	console.error(`\n❌  Could not read ${summaryPath}.`);
	console.error('    Make sure vitest.config.ts includes "json-summary" in coverage.reporter.');
	process.exit(1);
}

const stmtPct = summary?.total?.statements?.pct;
if (typeof stmtPct !== 'number') {
	console.error('\n❌  Could not read statements.pct from coverage summary.');
	process.exit(1);
}

// ── Gate ───────────────────────────────────────────────────────────────────────
console.log(`\n📊  Statement coverage: ${stmtPct.toFixed(2)}%  (baseline: ${BASELINE_STATEMENTS}%, threshold: ${THRESHOLD}%)`);

if (stmtPct < THRESHOLD) {
	console.error(`\n❌  Coverage gate FAILED — statements ${stmtPct.toFixed(2)}% is below threshold ${THRESHOLD}%.`);
	console.error('    Possible causes: deleted tests, removed source coverage, or a new un-tested file.');
	process.exit(1);
}

console.log('✅  Coverage gate passed.');
