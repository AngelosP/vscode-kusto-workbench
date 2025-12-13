const esbuild = require("esbuild");
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	// Monaco assets are used directly by the webview (not bundled into extension.js).
	// Copy them into dist so they are included in the VSIX (node_modules is excluded).
	const monacoSrc = path.join(__dirname, 'node_modules', 'monaco-editor', 'min', 'vs');
	const monacoDest = path.join(__dirname, 'dist', 'monaco', 'vs');
	try {
		await fs.promises.mkdir(path.dirname(monacoDest), { recursive: true });
		// Node 16+ supports fs.promises.cp
		if (fs.promises.cp) {
			await fs.promises.cp(monacoSrc, monacoDest, { recursive: true, force: true });
		} else {
			console.warn('[watch] fs.promises.cp not available; Monaco assets may be missing');
		}
	} catch (e) {
		console.warn('[watch] failed to copy Monaco assets:', e && e.message ? e.message : e);
	}

	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
