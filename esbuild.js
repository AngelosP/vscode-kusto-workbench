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
		await fs.promises.copyFile(
			path.join(webviewSrcDir, 'vscodeApi.js'),
			path.join(webviewDistDir, 'vscodeApi.js')
		);
	} catch (e) {
		console.warn('[watch] failed to copy webview runtime assets:', e && e.message ? e.message : e);
	}

	// Skip unused Monaco assets to reduce bundle size:
	// - Language workers: only editor.worker and html.worker are needed.
	//   (KQL uses its own bundled worker; HTML sections need the HTML worker.)
	// - Language directories (css, json, typescript): we create 'kusto', 'python',
	//   and 'html' models. Kusto comes from @kusto/monaco-kusto (copied separately).
	// - basic-languages: keep only 'python' for syntax highlighting in python sections.
	//   All other 80+ language grammars are unused dead weight.
	// - NLS locale files: Monaco localization is not configured; these are never loaded.

	const monacoSrc = path.join(__dirname, 'node_modules', 'monaco-editor', 'min', 'vs');
	const monacoDest = path.join(__dirname, 'dist', 'monaco', 'vs');
	const unusedWorkerPattern = /^(css|json|ts)\.worker\.[0-9a-f]+\.js$/i;
	const unusedLanguageDirs = new Set(['css', 'json', 'typescript']);
	const keepBasicLanguages = new Set(['python', 'html', 'css', 'javascript', 'sql']);
	try {
		await fs.promises.mkdir(path.dirname(monacoDest), { recursive: true });
		// Node 16+ supports fs.promises.cp with a filter
		if (fs.promises.cp) {
			await fs.promises.cp(monacoSrc, monacoDest, {
				recursive: true,
				force: true,
				filter: (src) => {
					const basename = path.basename(src);
					if (unusedWorkerPattern.test(basename)) return false;
					// Skip NLS locale files (nls.messages.*.js) — localization not used
					if (/^nls\.messages\..+\.js$/.test(basename)) return false;
					const rel = path.relative(monacoSrc, src);
					const parts = rel.split(path.sep);
					if (parts[0] === 'language' && parts.length > 1 && unusedLanguageDirs.has(parts[1])) return false;
					// Keep only the basic-languages we actually use
					if (parts[0] === 'basic-languages' && parts.length > 1 && !keepBasicLanguages.has(parts[1])) return false;
					return true;
				}
			});
		} else {
			console.warn('[watch] fs.promises.cp not available; Monaco assets may be missing');
		}
	} catch (e) {
		console.warn('[watch] failed to copy Monaco assets:', e && e.message ? e.message : e);
	}

	// Clean up stale dirs from previous builds that are now excluded.
	for (const lang of unusedLanguageDirs) {
		const staleDir = path.join(monacoDest, 'language', lang);
		try { await fs.promises.rm(staleDir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
	// Clean up stale basic-languages and NLS files from previous builds.
	try {
		const blDir = path.join(monacoDest, 'basic-languages');
		for (const entry of await fs.promises.readdir(blDir, { withFileTypes: true })) {
			if (entry.isDirectory() && !keepBasicLanguages.has(entry.name)) {
				await fs.promises.rm(path.join(blDir, entry.name), { recursive: true, force: true });
			}
		}
	} catch { /* ignore */ }
	try {
		for (const entry of await fs.promises.readdir(monacoDest)) {
			if (/^nls\.messages\..+\.js$/.test(entry)) {
				await fs.promises.rm(path.join(monacoDest, entry), { force: true });
			}
		}
	} catch { /* ignore */ }


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

		// Post-copy patches for toastui-editor.css (override upstream defaults).
		{
			const cssPath = path.join(toastuiDestDir, 'toastui-editor.css');
			let css = await fs.promises.readFile(cssPath, 'utf8');
			// Remove default paragraph margin — our notebook sections manage spacing.
			css = css.replace(
				/\.toastui-editor-contents p \{\s*margin:\s*10px 0;/,
				'.toastui-editor-contents p {\n  margin: 0px 0;'
			);
			await fs.promises.writeFile(cssPath, css, 'utf8');
		}

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

	// App CSS bundle — combines all queryEditor-*.css into a single file.
	const cssBundleOutfile = path.join(__dirname, 'dist', 'webview', 'styles', 'queryEditor.bundle.css');
	try {
		const cssCtx = await esbuild.context({
			entryPoints: [path.join(__dirname, 'src', 'webview', 'styles', 'index.css')],
			bundle: true,
			minify: production,
			outfile: cssBundleOutfile,
			logLevel: 'silent',
		});
		if (watch) {
			await cssCtx.watch();
		} else {
			await cssCtx.rebuild();
			await cssCtx.dispose();
		}
	} catch (e) {
		console.warn('[watch] failed to bundle app CSS:', e && e.message ? e.message : e);
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
		external: ['vscode', 'mssql'],
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
		];
		const singleFileCopyTargets = [
			{ src: path.join(webviewSrcDir, 'queryEditor.js'), dest: path.join(webviewDistDir, 'queryEditor.js') },
			{ src: path.join(webviewSrcDir, 'queryEditor.html'), dest: path.join(webviewDistDir, 'queryEditor.html') },
			{ src: path.join(webviewSrcDir, 'vscodeApi.js'), dest: path.join(webviewDistDir, 'vscodeApi.js') },
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

	// ── Bundle size gate (production builds only) ─────────────────────────────
	// Automatically checks that no bundle has grown beyond its baseline + buffer.
	// Runs inline — no extra step to remember.
	if (production) {
		const BASELINES = {
			'extension.js':                                        1127,
			'webview/webview.bundle.js':                           1881,
			'queryEditor/vendor/echarts/echarts.webview.js':        646,
			'queryEditor/vendor/toastui-editor/toastui-editor.webview.js': 603,
			'monaco/':                                            11445,
		};
		const BUFFER_KB = 50;
		const distDir = path.join(__dirname, 'dist');

		function dirSizeBytes(dir) {
			let total = 0;
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, entry.name);
				total += entry.isDirectory() ? dirSizeBytes(p) : fs.statSync(p).size;
			}
			return total;
		}

		console.log('\n📦 Bundle size gate:');
		let failed = false;
		for (const [rel, baselineKB] of Object.entries(BASELINES)) {
			const limitKB = baselineKB + BUFFER_KB;
			let actualKB;
			try {
				const full = path.join(distDir, rel);
				actualKB = (rel.endsWith('/') ? dirSizeBytes(full) : fs.statSync(full).size) / 1024;
			} catch {
				console.log(`   ❌ ${rel} — MISSING`);
				failed = true;
				continue;
			}
			const ok = actualKB <= limitKB;
			const marker = ok ? '✅' : '❌';
			console.log(`   ${marker} ${rel}  ${actualKB.toFixed(0)} KB  (limit ${limitKB.toFixed(0)} KB)`);
			if (!ok) failed = true;
		}
		if (failed) {
			console.error('\n⚠️  Bundle size gate FAILED — update BASELINES in esbuild.js if growth is intentional.\n');
			process.exit(1);
		} else {
			console.log('   All bundles within limits.\n');
		}
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
