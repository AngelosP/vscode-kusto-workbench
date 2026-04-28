import * as vscode from 'vscode';
import { parseKqlxText, type KqlxSectionV1, type DevNoteEntry } from './kqlxFormat';

// ── Noise fields ─────────────────────────────────────────────────────────────

/**
 * Keys stripped from state comparison (dirty-detection, persist flow).
 * Only truly ephemeral UI state — pixel dimensions are intentionally excluded
 * so that height / width changes are detected and persisted to disk.
 */
export const COMPARISON_NOISE_KEYS = new Set([
	'resultJson',
	'copilotChatVisible', 'resultsVisible', 'favoritesMode',
]);

/** Keys stripped from human-readable diff views — superset of COMPARISON_NOISE_KEYS.
 * Content keys (query, text, code) are excluded because they get their own
 * dedicated diff tab.  Heights are intentionally kept so layout changes are
 * visible in the settings diff. */
export const DIFF_NOISE_KEYS = new Set([
	'resultJson',
	'query', 'text', 'code',
	'copilotChatVisible', 'resultsVisible', 'favoritesMode',
]);

// ── Smart diff formatter ─────────────────────────────────────────────────────

/**
 * Transform a raw `.kqlx` JSON string into a human-readable text format
 * optimised for side-by-side diffing.
 *
 * - Noise fields (resultJson, pixel heights, ephemeral UI state) are stripped.
 * - Query / markdown / code text is rendered as-is (no JSON escaping).
 * - Falls back to the raw input when parsing fails.
 *
 * Pure function — deterministic, no side effects.
 */
export function formatKqlxForDiff(raw: string): string {
	const parsed = parseKqlxText(raw, { allowedKinds: ['kqlx', 'mdx', 'sqlx'] });
	if (!parsed.ok) return raw;

	const { file } = parsed;
	const sections = Array.isArray(file.state.sections) ? file.state.sections : [];
	const caretDocs = file.state.caretDocsEnabled !== false ? 'enabled' : 'disabled';
	const lines: string[] = [
		`${file.kind} v${file.version} | Caret docs: ${caretDocs} | ${sections.length} section${sections.length !== 1 ? 's' : ''}`,
		'────────────────────────────────────────────',
	];

	for (const section of sections) {
		lines.push('');
		lines.push(...formatSection(section));
	}

	// Trailing newline to match stringifyKqlxFile convention.
	lines.push('');
	return lines.join('\n');
}

// ── Per-section formatters ───────────────────────────────────────────────────

function formatSection(section: KqlxSectionV1): string[] {
	const s = section as Record<string, unknown>;
	const rawType = String(s.type ?? '');
	// normalizeSection maps copilotQuery → query; mirror that for display.
	const displayType = rawType === 'copilotQuery' ? 'query' : rawType;

	switch (displayType) {
		case 'query': return formatQuerySection(s);
		case 'markdown': return formatMarkdownSection(s);
		case 'python': return formatPythonSection(s);
		case 'html': return formatHtmlSection(s);
		case 'sql': return formatSqlSection(s);
		case 'url': return formatUrlSection(s);
		case 'chart': return formatChartSection(s);
		case 'transformation': return formatTransformationSection(s);
		case 'devnotes': return formatDevnotesSection(s);
		default: return formatUnknownSection(s, displayType);
	}
}

function sectionHeader(type: string, name: unknown): string {
	const label = typeof name === 'string' && name ? name : '';
	return label
		? `══ [${type}] ${label} ══`
		: `══ [${type}] ══`;
}

function kvLine(key: string, value: unknown): string | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	return `${key}: ${value}`;
}

function formatQuerySection(s: Record<string, unknown>): string[] {
	const lines: string[] = [sectionHeader('Kusto', s.name)];

	pushIfDefined(lines, kvLine('Cluster', s.clusterUrl));
	pushIfDefined(lines, kvLine('Database', s.database));

	// Run mode + cache on one line when both present.
	const parts: string[] = [];
	if (s.runMode) parts.push(`Run mode: ${s.runMode}`);
	if (s.cacheEnabled) {
		const v = s.cacheValue ?? '';
		const u = s.cacheUnit ?? '';
		parts.push(`Cache: ${v} ${u}`.trim());
	}
	if (parts.length) lines.push(parts.join(' | '));

	if (typeof s.linkedQueryPath === 'string' && s.linkedQueryPath) {
		lines.push(`Linked query: ${s.linkedQueryPath}`);
	}

	// Show expanded state only when explicitly false (collapsed).
	if (s.expanded === false) lines.push('Collapsed: yes');

	// Raw query text — the most important part.
	const query = typeof s.query === 'string' ? s.query : '';
	if (query) {
		lines.push('');
		lines.push(...query.split('\n'));
	}

	return lines;
}

function formatMarkdownSection(s: Record<string, unknown>): string[] {
	const lines: string[] = [sectionHeader('Markdown', s.name ?? s.title)];
	const text = typeof s.text === 'string' ? s.text : '';
	if (s.mode) lines.push(`Mode: ${s.mode}`);
	if (text) {
		lines.push('');
		lines.push(...text.split('\n'));
	}
	return lines;
}

function formatPythonSection(s: Record<string, unknown>): string[] {
	const lines: string[] = [sectionHeader('Python', s.name)];
	const code = typeof s.code === 'string' ? s.code : '';
	if (code) {
		lines.push('');
		lines.push(...code.split('\n'));
	}
	return lines;
}

function formatHtmlSection(s: Record<string, unknown>): string[] {
	const lines: string[] = [sectionHeader('HTML', s.name)];
	if (s.mode) lines.push(`Mode: ${s.mode}`);
	const code = typeof s.code === 'string' ? s.code : '';
	if (code) {
		lines.push('');
		lines.push(...code.split('\n'));
	}
	return lines;
}

function formatSqlSection(s: Record<string, unknown>): string[] {
	const lines: string[] = [sectionHeader('SQL', s.name)];
	pushIfDefined(lines, kvLine('Server', s.serverUrl));
	pushIfDefined(lines, kvLine('Database', s.database));
	const query = typeof s.query === 'string' ? s.query : '';
	if (query) {
		lines.push('');
		lines.push(...query.split('\n'));
	}
	return lines;
}

function formatUrlSection(s: Record<string, unknown>): string[] {
	const lines: string[] = [sectionHeader('URL', s.name)];
	if (typeof s.url === 'string' && s.url) {
		lines.push(s.url);
	}
	return lines;
}

function formatChartSection(s: Record<string, unknown>): string[] {
	const lines: string[] = [sectionHeader('Chart', s.name)];
	pushIfDefined(lines, kvLine('Type', s.chartType));
	pushIfDefined(lines, kvLine('Data source', s.dataSourceId));

	// Axis columns on one compact line.
	const axisParts: string[] = [];
	if (s.xColumn) axisParts.push(`X: ${s.xColumn}`);
	if (Array.isArray(s.yColumns) && s.yColumns.length) axisParts.push(`Y: ${s.yColumns.join(', ')}`);
	else if (s.yColumn) axisParts.push(`Y: ${s.yColumn}`);
	if (axisParts.length) lines.push(axisParts.join(' | '));

	pushIfDefined(lines, kvLine('Legend', s.legendColumn ?? (s.legendSettings as any)?.position));
	pushIfDefined(lines, kvLine('Stack', s.stackMode ?? (s.legendSettings as any)?.stackMode));
	pushIfDefined(lines, kvLine('Label column', s.labelColumn));
	pushIfDefined(lines, kvLine('Value column', s.valueColumn));
	pushIfDefined(lines, kvLine('Source column', s.sourceColumn));
	pushIfDefined(lines, kvLine('Target column', s.targetColumn));
	pushIfDefined(lines, kvLine('Sort', s.sortColumn ? `${s.sortColumn} ${s.sortDirection ?? ''}`.trim() : undefined));
	pushIfDefined(lines, kvLine('Title', s.chartTitle));
	pushIfDefined(lines, kvLine('Subtitle', s.chartSubtitle));

	// Emit nested settings objects as compact key-value groups.
	emitNestedSettings(lines, 'X-axis', s.xAxisSettings);
	emitNestedSettings(lines, 'Y-axis', s.yAxisSettings);
	emitNestedSettings(lines, 'Legend settings', s.legendSettings);
	emitNestedSettings(lines, 'Heatmap', s.heatmapSettings);

	return lines;
}

function formatTransformationSection(s: Record<string, unknown>): string[] {
	const lines: string[] = [sectionHeader('Transformation', s.name)];
	pushIfDefined(lines, kvLine('Type', s.transformationType));
	pushIfDefined(lines, kvLine('Data source', s.dataSourceId));

	// Type-specific details.
	if (s.distinctColumn) lines.push(`Distinct column: ${s.distinctColumn}`);
	if (Array.isArray(s.groupByColumns) && s.groupByColumns.length) {
		lines.push(`Group by: ${s.groupByColumns.join(', ')}`);
	}
	if (Array.isArray(s.aggregations) && s.aggregations.length) {
		const aggs = (s.aggregations as Array<Record<string, unknown>>)
			.map(a => a.name ? `${a.function}(${a.column}) as ${a.name}` : `${a.function}(${a.column})`)
			.join(', ');
		lines.push(`Aggregations: ${aggs}`);
	}
	if (Array.isArray(s.deriveColumns) && s.deriveColumns.length) {
		for (const d of s.deriveColumns as Array<Record<string, unknown>>) {
			lines.push(`Derive: ${d.name} = ${d.expression}`);
		}
	}
	// Back-compat single derive.
	if (s.deriveColumnName && !Array.isArray(s.deriveColumns)) {
		lines.push(`Derive: ${s.deriveColumnName} = ${s.deriveExpression ?? ''}`);
	}
	// Pivot config.
	if (s.pivotRowKeyColumn) {
		lines.push(`Pivot: row=${s.pivotRowKeyColumn}, col=${s.pivotColumnKeyColumn ?? ''}, val=${s.pivotValueColumn ?? ''}, agg=${s.pivotAggregation ?? ''}`);
		if (s.pivotMaxColumns) lines.push(`Pivot max columns: ${s.pivotMaxColumns}`);
	}
	// Join config.
	if (s.joinKind) {
		lines.push(`Join: ${s.joinKind} with ${s.joinRightDataSourceId ?? '?'}`);
		if (Array.isArray(s.joinKeys)) {
			for (const k of s.joinKeys as Array<Record<string, unknown>>) {
				lines.push(`  Key: ${k.left} = ${k.right}`);
			}
		}
		if (s.joinOmitDuplicateColumns) lines.push('Omit duplicate columns: yes');
	}

	return lines;
}

function formatDevnotesSection(s: Record<string, unknown>): string[] {
	const lines: string[] = [sectionHeader('Dev Notes', undefined)];
	const entries = Array.isArray(s.entries) ? s.entries as DevNoteEntry[] : [];
	for (const e of entries) {
		const ts = e.updated || e.created || '';
		lines.push(`[${e.category}] ${ts} — ${e.content}`);
	}
	return lines;
}

function formatUnknownSection(s: Record<string, unknown>, type: string): string[] {
	const lines: string[] = [sectionHeader(type, s.name)];
	// Strip noise, pretty-print the rest.
	const cleaned: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(s)) {
		if (!DIFF_NOISE_KEYS.has(k)) cleaned[k] = v;
	}
	lines.push(JSON.stringify(cleaned, null, 2));
	return lines;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pushIfDefined(lines: string[], line: string | undefined): void {
	if (line !== undefined) lines.push(line);
}

function emitNestedSettings(lines: string[], label: string, obj: unknown): void {
	if (!obj || typeof obj !== 'object') return;
	const entries = Object.entries(obj as Record<string, unknown>)
		.filter(([, v]) => v !== undefined && v !== null && v !== '');
	if (!entries.length) return;
	lines.push(`${label}:`);
	for (const [k, v] of entries) {
		lines.push(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
	}
}

// ── Webview diff renderer ────────────────────────────────────────────────────

/**
 * Renders a Monaco-based diff viewer in a webview panel.
 * 
 * For `.kqlx` files, provides a human-readable "smart" view by default (with
 * a toggle to switch to raw JSON). Other file types show raw content only.
 */
export async function renderDiffInWebview(
	webviewPanel: vscode.WebviewPanel,
	extensionUri: vscode.Uri,
	originalUri: vscode.Uri
): Promise<void> {
	// Get the original (historical) content
	let originalContent = '';
	try {
		const originalDoc = await vscode.workspace.openTextDocument(originalUri);
		originalContent = originalDoc.getText();
	} catch {
		originalContent = '// Could not load original content';
	}

	// Get the working copy content
	let modifiedContent = originalContent;
	try {
		const workingCopyUri = vscode.Uri.file(originalUri.fsPath);
		const workingCopyBytes = await vscode.workspace.fs.readFile(workingCopyUri);
		modifiedContent = new TextDecoder('utf-8').decode(workingCopyBytes);
	} catch {
		// If we can't read the working copy, show just the original
	}

	// Determine the language for syntax highlighting
	const language = getLanguageFromUri(originalUri);
	const fileName = originalUri.path.split('/').pop() || 'file';

	// For .kqlx files, build a human-readable smart view alongside the raw JSON.
	const isKqlx = /\.(kqlx|mdx|sqlx)$/i.test(originalUri.path);
	const originalSmart = isKqlx ? formatKqlxForDiff(originalContent) : undefined;
	const modifiedSmart = isKqlx ? formatKqlxForDiff(modifiedContent) : undefined;

	webviewPanel.webview.options = {
		enableScripts: true,
		localResourceRoots: [extensionUri]
	};

	webviewPanel.webview.html = getDiffHtml({
		originalContent,
		modifiedContent,
		originalSmart,
		modifiedSmart,
		language,
		fileName,
	});
}

function getLanguageFromUri(uri: vscode.Uri): string {
	const path = uri.path.toLowerCase();
	if (path.endsWith('.kql') || path.endsWith('.csl') || path.endsWith('.kqlx') || path.endsWith('.sqlx')) {
		return 'plaintext'; // Monaco doesn't have kusto/sql built-in
	}
	if (path.endsWith('.md') || path.endsWith('.mdx')) {
		return 'markdown';
	}
	if (path.endsWith('.json')) {
		return 'json';
	}
	return 'plaintext';
}

export interface DiffHtmlOptions {
	originalContent: string;
	modifiedContent: string;
	/** Human-readable smart view of the original (`.kqlx` only). */
	originalSmart?: string;
	/** Human-readable smart view of the modified (`.kqlx` only). */
	modifiedSmart?: string;
	language: string;
	fileName: string;
}

export function serializeForInlineScript(value: string): string {
	return JSON.stringify(value)
		.replace(/</g, '\\u003C')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}

function escapeHtmlText(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

export function getDiffHtml(opts: DiffHtmlOptions): string {

	const hasSmart = opts.originalSmart !== undefined && opts.modifiedSmart !== undefined;

	// When a smart view is available, start in smart mode.
	const primaryOriginal = hasSmart ? opts.originalSmart! : opts.originalContent;
	const primaryModified = hasSmart ? opts.modifiedSmart! : opts.modifiedContent;
	const primaryLang = hasSmart ? 'plaintext' : opts.language;
	const rawLang = hasSmart ? 'json' : opts.language;

	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'unsafe-inline' https://cdn.jsdelivr.net; worker-src blob:; font-src https://cdn.jsdelivr.net data:; connect-src https://cdn.jsdelivr.net; img-src https://cdn.jsdelivr.net data:;">
	<title>Diff: ${escapeHtmlText(opts.fileName)}</title>
	<style>
		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}
		html, body {
			height: 100%;
			width: 100%;
			overflow: hidden;
			background: var(--vscode-editor-background, #1e1e1e);
		}
		#diff-container {
			width: 100%;
			height: 100%;
			display: flex;
			flex-direction: column;
		}
		.diff-header {
			display: flex;
			justify-content: space-between;
			padding: 8px 16px;
			background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
			border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, #1e1e1e);
			font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
			font-size: 12px;
			color: var(--vscode-foreground, #cccccc);
			flex-shrink: 0;
			align-items: center;
		}
		.diff-header-sides {
			display: flex;
			flex: 1;
			min-width: 0;
		}
		.diff-header-side {
			flex: 1;
			text-align: center;
			padding: 4px 8px;
		}
		.diff-header-side.original {
			background: rgba(255, 100, 100, 0.15);
			border-radius: 4px 0 0 4px;
			margin-right: 2px;
		}
		.diff-header-side.modified {
			background: rgba(100, 255, 100, 0.15);
			border-radius: 0 4px 4px 0;
			margin-left: 2px;
		}
		#toggle-btn {
			margin-left: 12px;
			padding: 3px 10px;
			border: 1px solid var(--vscode-button-border, rgba(255,255,255,0.12));
			border-radius: 3px;
			background: var(--vscode-button-secondaryBackground, #3a3d41);
			color: var(--vscode-button-secondaryForeground, #cccccc);
			font-family: inherit;
			font-size: 11px;
			cursor: pointer;
			white-space: nowrap;
			flex-shrink: 0;
		}
		#toggle-btn:hover {
			background: var(--vscode-button-secondaryHoverBackground, #45494e);
		}
		#editor-container {
			flex: 1;
			width: 100%;
			min-height: 0;
		}
		.loading {
			display: flex;
			align-items: center;
			justify-content: center;
			height: 100%;
			color: var(--vscode-foreground, #cccccc);
			font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
		}
		.error {
			color: var(--vscode-errorForeground, #f48771);
			padding: 20px;
			font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
		}
	</style>
</head>
<body>
	<div id="diff-container">
		<div class="diff-header">
			<div class="diff-header-sides">
				<div class="diff-header-side original">Original (HEAD)</div>
				<div class="diff-header-side modified">Working Copy</div>
			</div>
			${hasSmart ? '<button id="toggle-btn" type="button" title="Switch between smart (human-readable) and raw JSON views">Smart View</button>' : ''}
		</div>
		<div id="editor-container">
			<div class="loading">Loading diff viewer...</div>
		</div>
	</div>

	<script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js"></script>
	<script>
		(function() {
			var smartOriginal = ${serializeForInlineScript(primaryOriginal)};
			var smartModified = ${serializeForInlineScript(primaryModified)};
			var rawOriginal = ${serializeForInlineScript(opts.originalContent)};
			var rawModified = ${serializeForInlineScript(opts.modifiedContent)};
			var smartLang = ${serializeForInlineScript(primaryLang)};
			var rawLang = ${serializeForInlineScript(rawLang)};
			var hasSmart = ${hasSmart ? 'true' : 'false'};
			var isSmart = hasSmart; // start in smart mode when available

			require.config({
				paths: {
					'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs'
				}
			});

			require(['vs/editor/editor.main'], function() {
				var container = document.getElementById('editor-container');
				container.innerHTML = '';

				var bodyClasses = document.body.className || '';
				var isDark = bodyClasses.includes('vscode-dark') || 
					bodyClasses.includes('vscode-high-contrast') ||
					!bodyClasses.includes('vscode-light');

				var diffEditor = monaco.editor.createDiffEditor(container, {
					theme: isDark ? 'vs-dark' : 'vs',
					automaticLayout: true,
					readOnly: true,
					renderSideBySide: true,
					enableSplitViewResizing: true,
					ignoreTrimWhitespace: false,
					renderIndicators: true,
					originalEditable: false,
					minimap: { enabled: true },
					scrollBeyondLastLine: false,
					fontSize: 13,
					lineNumbers: 'on',
					glyphMargin: true,
					folding: true,
					lineDecorationsWidth: 10,
					renderLineHighlight: 'all',
					scrollbar: {
						verticalScrollbarSize: 10,
						horizontalScrollbarSize: 10
					}
				});

				function setModels(original, modified, lang) {
					var origModel = monaco.editor.createModel(original, lang);
					var modModel = monaco.editor.createModel(modified, lang);
					diffEditor.setModel({ original: origModel, modified: modModel });
				}

				setModels(
					isSmart ? smartOriginal : rawOriginal,
					isSmart ? smartModified : rawModified,
					isSmart ? smartLang : rawLang
				);

				// Toggle button wiring.
				var toggleBtn = document.getElementById('toggle-btn');
				if (toggleBtn && hasSmart) {
					toggleBtn.addEventListener('click', function() {
						// Dispose previous models to avoid leaks.
						var prev = diffEditor.getModel();
						if (prev) {
							if (prev.original) prev.original.dispose();
							if (prev.modified) prev.modified.dispose();
						}
						isSmart = !isSmart;
						toggleBtn.textContent = isSmart ? 'Smart View' : 'Raw JSON';
						setModels(
							isSmart ? smartOriginal : rawOriginal,
							isSmart ? smartModified : rawModified,
							isSmart ? smartLang : rawLang
						);
					});
				}

				// Theme change observer.
				var observer = new MutationObserver(function(mutations) {
					mutations.forEach(function(mutation) {
						if (mutation.attributeName === 'class') {
							var classes = document.body.className || '';
							var nowDark = classes.includes('vscode-dark') || 
								classes.includes('vscode-high-contrast') ||
								!classes.includes('vscode-light');
							monaco.editor.setTheme(nowDark ? 'vs-dark' : 'vs');
						}
					});
				});
				observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

			}, function(err) {
				var container = document.getElementById('editor-container');
				var errDiv = document.createElement('div');
				errDiv.className = 'error';
				errDiv.textContent = 'Failed to load diff viewer: ' + (err.message || err);
				container.innerHTML = '';
				container.appendChild(errDiv);
				console.error('Monaco load error:', err);
			});
		})();
	</script>
</body>
</html>`;
}
