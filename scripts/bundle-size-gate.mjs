/**
 * Bundle size gate — fails if any bundle exceeds its recorded baseline + buffer.
 *
 * Usage:  node scripts/bundle-size-gate.mjs
 *
 * Reads the production dist/ output and exits 1 if any tracked bundle grew
 * beyond the allowed threshold. Run after `node esbuild.js --production`.
 *
 * To update baselines after intentional growth, change the KB values below.
 */
import { statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'dist');

// ── Baselines (KB) — updated 2026-04-16 after STS integration + pre-existing webview growth ──
const BASELINES = {
	'extension.js':                                        1106,
	'webview/webview.bundle.js':                           1824,
	'queryEditor/vendor/echarts/echarts.webview.js':        586,
	'queryEditor/vendor/toastui-editor/toastui-editor.webview.js': 603,
	'monaco/':                                            10963,
};
const BUFFER_KB = 50; // allow up to 50 KB growth per entry before failing

// ── Helpers ───────────────────────────────────────────────────────────────────
function dirSize(dir) {
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		total += entry.isDirectory() ? dirSize(p) : statSync(p).size;
	}
	return total;
}

function sizeKB(rel) {
	const full = join(DIST, rel);
	return rel.endsWith('/')
		? dirSize(full) / 1024
		: statSync(full).size / 1024;
}

function fmtKB(kb) {
	return kb.toFixed(1) + ' KB';
}

// ── Gate ───────────────────────────────────────────────────────────────────────
let failed = false;
console.log('\nBundle size gate:');
console.log('─'.repeat(70));
console.log(
	`  ${'Bundle'.padEnd(55)} ${'Actual'.padStart(10)}  ${'Limit'.padStart(10)}`
);
console.log('─'.repeat(70));

for (const [rel, baselineKB] of Object.entries(BASELINES)) {
	const limitKB = baselineKB + BUFFER_KB;
	let actualKB;
	try {
		actualKB = sizeKB(rel);
	} catch {
		console.log(`  ${rel.padEnd(55)} ${'MISSING'.padStart(10)}  ${fmtKB(limitKB).padStart(10)}`);
		failed = true;
		continue;
	}

	const marker = actualKB > limitKB ? '❌' : '✅';
	console.log(
		`${marker} ${rel.padEnd(55)} ${fmtKB(actualKB).padStart(10)}  ${fmtKB(limitKB).padStart(10)}`
	);

	if (actualKB > limitKB) {
		failed = true;
	}
}

console.log('─'.repeat(70));
console.log(`  Buffer: ${BUFFER_KB} KB per entry.\n`);

if (failed) {
	console.error('❌  Bundle size gate FAILED — one or more bundles exceeded the limit.');
	console.error('    If the growth is intentional, update BASELINES in scripts/bundle-size-gate.mjs.');
	process.exit(1);
}

console.log('✅  Bundle size gate passed — all bundles within limits.');
