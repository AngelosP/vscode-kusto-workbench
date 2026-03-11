/**
 * Build script for the Kusto Workbench browser extension.
 *
 * Produces a loadable unpacked extension at browser-ext/dist/ by:
 * 1. Bundling src/content-script.ts → dist/content-script.js
 * 2. Copying static files (viewer.html, viewer-boot.js, etc.)
 * 3. Copying shared media assets from the repo root's media/ folder
 * 4. Copying built dist assets from the repo root's dist/ folder
 *    (Monaco, ECharts, TOAST UI — must be built first via `npm run package` at root)
 * 5. Copying manifest.json
 *
 * Prerequisites:
 *   - Run `npm ci && npm run package` at the repo root to build shared assets
 *   - Run `npm install` in browser-ext/ to install esbuild
 *
 * Usage:
 *   node esbuild.js              # development build
 *   node esbuild.js --production # minified build
 *   node esbuild.js --watch      # watch mode (content script only)
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isProduction = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');

const DIST = path.resolve(__dirname, 'dist');
const ROOT = path.resolve(__dirname, '..');

// ---- Helpers ----

function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

function copyFileSync(src, dest) {
	ensureDir(path.dirname(dest));
	fs.copyFileSync(src, dest);
}

function copyDirSync(src, dest, filter) {
	if (!fs.existsSync(src)) {
		console.warn(`  [skip] ${path.relative(ROOT, src)} — not found`);
		return;
	}
	ensureDir(dest);
	const entries = fs.readdirSync(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirSync(srcPath, destPath, filter);
		} else if (!filter || filter(entry.name, srcPath)) {
			fs.copyFileSync(srcPath, destPath);
		}
	}
}

function copyIfExists(src, dest) {
	if (fs.existsSync(src)) {
		copyFileSync(src, dest);
	} else {
		console.warn(`  [skip] ${path.relative(ROOT, src)} — not found`);
	}
}

// ---- Clean ----

console.log('Cleaning dist/...');
fs.rmSync(DIST, { recursive: true, force: true });
ensureDir(DIST);

// ---- 1. Bundle content script ----

console.log('Bundling content-script.ts...');
const contentScriptBuild = esbuild.buildSync({
	entryPoints: [path.resolve(__dirname, 'src/content-script.ts')],
	bundle: true,
	outfile: path.join(DIST, 'content-script.js'),
	platform: 'browser',
	target: 'es2022',
	format: 'iife',
	minify: isProduction,
	sourcemap: !isProduction,
	logLevel: 'info',
});

// ---- 2. Copy static files ----

console.log('Copying static files...');
const staticFiles = [
	'viewer.html',
	'viewer-standalone.html',
	'viewer-standalone-boot.js',
	'viewer-boot.js',
	'background.js',
	'queryEditor-loader.js',
	'manifest.json',
];
for (const file of staticFiles) {
	copyFileSync(
		path.join(__dirname, file),
		path.join(DIST, file)
	);
}

// Copy vscode-shim.js (local copy)
copyFileSync(
	path.join(__dirname, 'vscode-shim.js'),
	path.join(DIST, 'vscode-shim.js')
);

// Copy read-only-overrides.css (local copy)
copyFileSync(
	path.join(__dirname, 'read-only-overrides.css'),
	path.join(DIST, 'read-only-overrides.css')
);

// ---- 3. Copy shared webview assets ----

// These must be built first via `npm run package` at the repo root.
const rootDist = path.join(ROOT, 'dist');

if (!fs.existsSync(rootDist)) {
	console.error('\n*** ERROR: Root dist/ not found!');
	console.error('*** Run `npm ci && npm run package` at the repo root first.\n');
	process.exit(1);
}

console.log('Copying dist/webview/...');
copyDirSync(
	path.join(rootDist, 'webview'),
	path.join(DIST, 'dist', 'webview'),
	(name) => !name.endsWith('.map')
);

console.log('Copying media/images/...');
copyDirSync(
	path.join(ROOT, 'media', 'images'),
	path.join(DIST, 'media', 'images')
);

// ---- 4. Copy built dist assets (Monaco, ECharts, TOAST UI) ----

console.log('Copying dist/monaco/...');
copyDirSync(
	path.join(rootDist, 'monaco'),
	path.join(DIST, 'dist', 'monaco'),
	// Skip .map files to reduce size
	(name) => !name.endsWith('.map')
);

console.log('Copying dist/queryEditor/vendor/...');
copyDirSync(
	path.join(rootDist, 'queryEditor', 'vendor'),
	path.join(DIST, 'dist', 'queryEditor', 'vendor'),
	(name) => !name.endsWith('.map')
);

// ---- 5. Replace vscode.js with the shim ----

// The queryEditor-loader.js loads legacy/vscode.js first.
// We need to replace it with our shim so the webview code gets the stub.
console.log('Replacing dist/webview/legacy/vscode.js with vscode-shim.js...');
copyIfExists(
	path.join(__dirname, 'vscode-shim.js'),
	path.join(DIST, 'dist', 'webview', 'legacy', 'vscode.js')
);

// ---- Done ----

// Calculate size
function getDirSize(dir) {
	let size = 0;
	if (!fs.existsSync(dir)) return 0;
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			size += getDirSize(fullPath);
		} else {
			size += fs.statSync(fullPath).size;
		}
	}
	return size;
}

const totalSize = getDirSize(DIST);
console.log(`\nDone! Output: browser-ext/dist/`);
console.log(`Total size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
console.log(`\nTo load in Chrome/Edge:`);
console.log(`  1. Go to chrome://extensions (or edge://extensions)`);
console.log(`  2. Enable "Developer mode"`);
console.log(`  3. Click "Load unpacked" and select: ${DIST}`);

// ---- Watch mode ----

if (isWatch) {
	console.log('\nWatching for content script changes...');
	const ctx = esbuild.context({
		entryPoints: [path.resolve(__dirname, 'src/content-script.ts')],
		bundle: true,
		outfile: path.join(DIST, 'content-script.js'),
		platform: 'browser',
		target: 'es2022',
		format: 'iife',
		sourcemap: true,
		logLevel: 'info',
	});
	ctx.then(c => c.watch());
}
