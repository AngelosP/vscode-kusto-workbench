import fs from 'node:fs/promises';
import path from 'node:path';

const TOC_URL = 'https://learn.microsoft.com/en-us/kusto/toc.json?view=azure-data-explorer';
const KUSTO_BASE_URL = 'https://learn.microsoft.com/en-us/kusto/';
const DOCS_VIEW = 'azure-data-explorer';
const OUT_FILE = path.resolve('media/queryEditor/functions.generated.js');

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

const extractFunctionNameFromHref = (href) => {
	try {
		const h = String(href || '').trim();
		if (!h.startsWith('query/')) return null;
		const noHash = h.split('#')[0].split('?')[0].replace(/\/+$/, '');
		const slug = noHash.slice('query/'.length);
		if (!slug) return null;

		const AGG_SUFFIX = '-aggregation-function';
		const FN_SUFFIX = '-function';
		let base = null;
		if (slug.endsWith(AGG_SUFFIX)) {
			base = slug.slice(0, -AGG_SUFFIX.length);
		} else if (slug.endsWith(FN_SUFFIX)) {
			base = slug.slice(0, -FN_SUFFIX.length);
		}
		if (!base) return null;

		// Learn uses hyphens in slugs for functions that are underscores in KQL.
		const name = base.replace(/-/g, '_');
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
		return { name, href: noHash };
	} catch {
		return null;
	}
};

const collectFunctionEntries = (node, out) => {
	if (!node) return;
	if (Array.isArray(node)) {
		for (const n of node) collectFunctionEntries(n, out);
		return;
	}
	if (!isObject(node)) return;

	const href = String(node.href ?? '').trim();
	if (href) {
		const extracted = extractFunctionNameFromHref(href);
		if (extracted) out.push([extracted.name, extracted.href]);
	}

	if (Array.isArray(node.items)) collectFunctionEntries(node.items, out);
	if (Array.isArray(node.children)) collectFunctionEntries(node.children, out);
};

const decodeHtml = (s) => {
	try {
		return String(s || '')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&amp;/g, '&');
	} catch {
		return String(s || '');
	}
};

const stripTags = (html) => {
	try {
		return decodeHtml(String(html || '')
			.replace(/<[^>]+>/g, ' ')
			.replace(/\s+/g, ' ')
			.trim());
	} catch {
		return '';
	}
};

const parseSignatureToArgs = (signature) => {
	try {
		const s = String(signature || '');
		const open = s.indexOf('(');
		const close = s.lastIndexOf(')');
		if (open < 0 || close < 0 || close <= open) return [];
		const inside = s.slice(open + 1, close);
		if (!inside.trim()) return [];
		const parts = inside.split(',');
		const args = [];
		for (let raw of parts) {
			raw = String(raw || '').trim();
			if (!raw) continue;
			const optional = raw.includes('[') || raw.includes(']');
			raw = raw.replace(/[\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
			const m = raw.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:=.*)?$/);
			if (!m || !m[1]) continue;
			args.push(optional ? `${m[1]}?` : m[1]);
		}
		return args;
	} catch {
		return [];
	}
};

const extractFromLearnHtml = (html) => {
	const h = String(html || '');

	// Best-effort description: first paragraph after the <h1>.
	let description = '';
	try {
		const h1Idx = h.search(/<h1\b/i);
		if (h1Idx >= 0) {
			const afterH1 = h.slice(h1Idx);
			const pMatch = afterH1.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
			if (pMatch && pMatch[1]) {
				description = stripTags(pMatch[1]);
			}
		}
	} catch {
		// ignore
	}

	// Best-effort syntax: look for a "Syntax" section then the first code/pre block after it.
	let signature = '';
	try {
		const syntaxIdx = h.search(/<h2\b[^>]*>\s*Syntax\s*<\/h2>/i);
		if (syntaxIdx >= 0) {
			const after = h.slice(syntaxIdx);
			const codeMatch = after.match(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/i);
			if (codeMatch && codeMatch[1]) {
				signature = stripTags(codeMatch[1]);
			}
		}
	} catch {
		// ignore
	}

	return { signature, description };
};

const asyncPool = async (limit, items, worker) => {
	const results = new Array(items.length);
	let nextIndex = 0;
	const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
		while (true) {
			const idx = nextIndex++;
			if (idx >= items.length) return;
			results[idx] = await worker(items[idx], idx);
		}
	});
	await Promise.all(runners);
	return results;
};

const main = async () => {
	const res = await fetch(TOC_URL, { headers: { accept: 'application/json' } });
	if (!res.ok) {
		throw new Error(`Failed to fetch TOC: ${res.status} ${res.statusText}`);
	}
	const root = await res.json();
	const items = Array.isArray(root?.items) ? root.items : [];

	const entries = [];
	collectFunctionEntries(items, entries);

	// Dedupe by function name.
	const byLower = new Map();
	for (const [name, href] of entries) {
		const key = String(name).toLowerCase();
		if (byLower.has(key)) continue;
		byLower.set(key, [name, href]);
	}
	const deduped = Array.from(byLower.values()).sort((a, b) => String(a[0]).localeCompare(String(b[0])));

	// Fetch per-function docs (best-effort) from official Microsoft Learn pages.
	const docsByName = {};
	await asyncPool(8, deduped, async ([name, href]) => {
		try {
			const url = new URL(String(href || ''), KUSTO_BASE_URL);
			url.searchParams.set('view', DOCS_VIEW);
			const res2 = await fetch(url.toString(), {
				headers: {
					accept: 'text/html,application/xhtml+xml'
				}
			});
			if (!res2.ok) {
				console.warn(`WARN: ${name} doc fetch failed: ${res2.status} ${res2.statusText}`);
				return null;
			}
			const html = await res2.text();
			const { signature, description } = extractFromLearnHtml(html);
			const args = parseSignatureToArgs(signature);
			docsByName[String(name)] = {
				signature: signature || undefined,
				description: description || undefined,
				args: args.length ? args : undefined,
				docUrl: url.toString()
			};
			return null;
		} catch (e) {
			console.warn(`WARN: ${name} doc parse failed: ${String(e && e.message ? e.message : e)}`);
			return null;
		}
	});

	const banner = [
		'// AUTO-GENERATED FILE. DO NOT EDIT BY HAND.',
		'// Generated by: node scripts/generate-kusto-functions.mjs',
		''
	].join('\n');

	const payload = `${banner}(function(){\n\twindow.__kustoFunctionEntries = ${JSON.stringify(deduped)};\n\twindow.__kustoFunctionDocs = ${JSON.stringify(docsByName)};\n})();\n`;
	await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
	await fs.writeFile(OUT_FILE, payload, 'utf8');

	console.log(`Wrote ${deduped.length} entries to ${path.relative(process.cwd(), OUT_FILE)}`);
};

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
