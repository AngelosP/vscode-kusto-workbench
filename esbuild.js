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
	// ── Copy webview runtime assets from src/webview/ to dist/webview/ ──
	// Source files live under src/ (excluded from VSIX). The build copies them
	// to dist/ so they ship at runtime.
	const webviewSrcDir = path.join(__dirname, 'src', 'webview');
	const webviewDistDir = path.join(__dirname, 'dist', 'webview');
	try {
		// Legacy JS scripts
		const legacySrc = path.join(webviewSrcDir, 'legacy');
		const legacyDest = path.join(webviewDistDir, 'legacy');
		await fs.promises.mkdir(legacyDest, { recursive: true });
		if (fs.promises.cp) {
			await fs.promises.cp(legacySrc, legacyDest, { recursive: true, force: true });
		}

		// CSS
		const stylesSrc = path.join(webviewSrcDir, 'styles');
		const stylesDest = path.join(webviewDistDir, 'styles');
		await fs.promises.mkdir(stylesDest, { recursive: true });
		if (fs.promises.cp) {
			await fs.promises.cp(stylesSrc, stylesDest, { recursive: true, force: true });
		}

		// Vendor libs (marked, purify, toastui CSS — skip dead toastui-editor.js UMD build)
		const vendorSrc = path.join(webviewSrcDir, 'vendor');
		const vendorDest = path.join(webviewDistDir, 'vendor');
		await fs.promises.mkdir(vendorDest, { recursive: true });
		if (fs.promises.cp) {
			await fs.promises.cp(vendorSrc, vendorDest, {
				recursive: true,
				force: true,
				filter: (src) => path.basename(src) !== 'toastui-editor.js'
			});
		}

		// HTML template + bootstrap loader
		await fs.promises.copyFile(
			path.join(webviewSrcDir, 'queryEditor.html'),
			path.join(webviewDistDir, 'queryEditor.html')
		);
		await fs.promises.copyFile(
			path.join(webviewSrcDir, 'queryEditor.js'),
			path.join(webviewDistDir, 'queryEditor.js')
		);
	} catch (e) {
		console.warn('[watch] failed to copy webview runtime assets:', e && e.message ? e.message : e);
	}

	// Monaco assets are used directly by the webview (not bundled into extension.js).
	// Copy them into dist so they are included in the VSIX (node_modules is excluded).
	// Skip unused language workers (css, html, json, ts) — only editor.worker is needed for KQL.
	const monacoSrc = path.join(__dirname, 'node_modules', 'monaco-editor', 'min', 'vs');
	const monacoDest = path.join(__dirname, 'dist', 'monaco', 'vs');
	const unusedWorkerPattern = /^(css|html|json|ts)\.worker\.[0-9a-f]+\.js$/i;
	try {
		await fs.promises.mkdir(path.dirname(monacoDest), { recursive: true });
		// Node 16+ supports fs.promises.cp with a filter
		if (fs.promises.cp) {
			await fs.promises.cp(monacoSrc, monacoDest, {
				recursive: true,
				force: true,
				filter: (src) => !unusedWorkerPattern.test(path.basename(src))
			});
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
	// Copy CSS to src/webview/vendor/ (source, will be copied to dist/ by the webview asset step above).
	// Bundle JS to dist/ directly.
	const toastuiSrcDir = path.join(__dirname, 'node_modules', '@toast-ui', 'editor', 'dist');
	const toastuiDestDir = path.join(__dirname, 'src', 'webview', 'vendor', 'toastui-editor');
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

	// Webview Lit components bundle (browser target, ESM → IIFE for <script> usage).
	try {
		const webviewCtx = await esbuild.context({
			entryPoints: ['src/webview/index.ts'],
			bundle: true,
			format: 'iife',
			platform: 'browser',
			target: 'es2022',
			minify: production,
			sourcemap: !production,
			sourcesContent: false,
			outfile: 'dist/webview/webview.bundle.js',
			tsconfig: 'tsconfig.webview.json',
			logLevel: 'silent',
			plugins: [esbuildProblemMatcherPlugin],
		});
		if (watch) {
			await webviewCtx.watch();
		} else {
			await webviewCtx.rebuild();
			await webviewCtx.dispose();
		}
	} catch (e) {
		console.warn('[watch] failed to bundle webview Lit components:', e && e.message ? e.message : e);
	}

	const ctx = await esbuild.context({
		entryPoints: [
			'src/host/extension.ts'
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

		// ── Watch non-bundled webview assets and re-copy on change ──
		// Legacy JS, CSS, queryEditor.js/html are copied once at startup but
		// need to be re-copied when edited during development.
		const watchCopyTargets = [
			{ src: path.join(webviewSrcDir, 'legacy'), dest: path.join(webviewDistDir, 'legacy') },
			{ src: path.join(webviewSrcDir, 'styles'), dest: path.join(webviewDistDir, 'styles') },
		];
		const singleFileCopyTargets = [
			{ src: path.join(webviewSrcDir, 'queryEditor.js'), dest: path.join(webviewDistDir, 'queryEditor.js') },
			{ src: path.join(webviewSrcDir, 'queryEditor.html'), dest: path.join(webviewDistDir, 'queryEditor.html') },
		];
		for (const { src, dest } of watchCopyTargets) {
			try {
				fs.watch(src, { recursive: true }, async (eventType, filename) => {
					try {
						await fs.promises.cp(src, dest, { recursive: true, force: true });
						console.log(`[watch] re-copied ${path.basename(src)}/ (${filename} ${eventType})`);
					} catch (e) {
						console.warn(`[watch] failed to re-copy ${path.basename(src)}/:`, e && e.message ? e.message : e);
					}
				});
			} catch { /* ignore if fs.watch not supported */ }
		}
		for (const { src, dest } of singleFileCopyTargets) {
			try {
				fs.watch(src, async (eventType) => {
					try {
						await fs.promises.copyFile(src, dest);
						console.log(`[watch] re-copied ${path.basename(src)} (${eventType})`);
					} catch (e) {
						console.warn(`[watch] failed to re-copy ${path.basename(src)}:`, e && e.message ? e.message : e);
					}
				});
			} catch { /* ignore if fs.watch not supported */ }
		}
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
