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

	// Monaco-Kusto assets provide the official Kusto language service (completions, diagnostics, etc.).
	// Copy them into dist/monaco/vs/language/kusto so they can be loaded as AMD modules.
	const monacoKustoSrc = path.join(__dirname, 'node_modules', '@kusto', 'monaco-kusto', 'release', 'min');
	const monacoKustoDest = path.join(__dirname, 'dist', 'monaco', 'vs', 'language', 'kusto');
	try {
		await fs.promises.mkdir(monacoKustoDest, { recursive: true });
		if (fs.promises.cp) {
			await fs.promises.cp(monacoKustoSrc, monacoKustoDest, { recursive: true, force: true });
		} else {
			console.warn('[watch] fs.promises.cp not available; Monaco-Kusto assets may be missing');
		}
	} catch (e) {
		console.warn('[watch] failed to copy Monaco-Kusto assets:', e && e.message ? e.message : e);
	}

	// TOAST UI Editor assets are used directly by the webview.
	// Copy/bundle them into media so they are included in the VSIX (node_modules is excluded).
	const toastuiSrcDir = path.join(__dirname, 'node_modules', '@toast-ui', 'editor', 'dist');
	const toastuiDestDir = path.join(__dirname, 'media', 'queryEditor', 'vendor', 'toastui-editor');
	const toastuiWebviewJsDestDir = path.join(__dirname, 'dist', 'queryEditor', 'vendor', 'toastui-editor');
	try {
		await fs.promises.mkdir(toastuiDestDir, { recursive: true });
		await fs.promises.mkdir(toastuiWebviewJsDestDir, { recursive: true });
		await fs.promises.copyFile(
			path.join(toastuiSrcDir, 'toastui-editor.css'),
			path.join(toastuiDestDir, 'toastui-editor.css')
		);
		await fs.promises.copyFile(
			path.join(toastuiSrcDir, 'theme', 'toastui-editor-dark.css'),
			path.join(toastuiDestDir, 'toastui-editor-dark.css')
		);

		// TOAST UI Editor plugins/assets
		await fs.promises.copyFile(
			path.join(__dirname, 'node_modules', '@toast-ui', 'editor-plugin-color-syntax', 'dist', 'toastui-editor-plugin-color-syntax.css'),
			path.join(toastuiDestDir, 'toastui-editor-plugin-color-syntax.css')
		);
		await fs.promises.copyFile(
			path.join(__dirname, 'node_modules', 'tui-color-picker', 'dist', 'tui-color-picker.css'),
			path.join(toastuiDestDir, 'tui-color-picker.css')
		);

		// The package's dist/toastui-editor.js is a UMD build with external dependencies
		// (prosemirror-*). It is not directly usable via <script> in our webview.
		// Bundle a browser-ready script that attaches `window.toastui.Editor`.
		await esbuild.build({
			entryPoints: [path.join(__dirname, 'scripts', 'toastui-editor-webview-entry.js')],
			bundle: true,
			platform: 'browser',
			format: 'iife',
			minify: production,
			sourcemap: false,
			outfile: path.join(toastuiWebviewJsDestDir, 'toastui-editor.webview.js'),
			logLevel: 'silent'
		});
	} catch (e) {
		console.warn('[watch] failed to copy TOAST UI Editor assets:', e && e.message ? e.message : e);
	}

	// ECharts is used by the webview for Chart sections.
	// Bundle a browser-ready script that attaches `window.echarts`.
	const echartsWebviewJsDestDir = path.join(__dirname, 'dist', 'queryEditor', 'vendor', 'echarts');
	try {
		await fs.promises.mkdir(echartsWebviewJsDestDir, { recursive: true });
		await esbuild.build({
			entryPoints: [path.join(__dirname, 'scripts', 'echarts-webview-entry.js')],
			bundle: true,
			platform: 'browser',
			format: 'iife',
			minify: production,
			sourcemap: false,
			outfile: path.join(echartsWebviewJsDestDir, 'echarts.webview.js'),
			logLevel: 'silent'
		});
	} catch (e) {
		console.warn('[watch] failed to bundle ECharts:', e && e.message ? e.message : e);
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
