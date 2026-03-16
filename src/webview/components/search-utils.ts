// Shared search utilities used by kw-data-table, kw-object-viewer, and cellViewer.

import { html, type TemplateResult } from 'lit';

export type SearchMode = 'wildcard' | 'regex';
export type SearchMatch = { row: number; col: number };

function escapeRegex(s: string): string {
	return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Build a RegExp from a user query string and search mode.
 * Wildcard: splits on '*', escapes literal segments, joins with '.*?'.
 * Regex: uses pattern as-is.
 * Returns `{ regex: null, error: null }` if query is empty.
 * Returns `{ regex: null, error: '...' }` if regex is invalid or matches empty string.
 */
export function buildSearchRegex(query: string, mode: SearchMode): { regex: RegExp | null; error: string | null } {
	const t = query.trim();
	if (!t) return { regex: null, error: null };
	const p = mode === 'regex' ? t : t.split('*').map(escapeRegex).join('.*?');
	try {
		const r = new RegExp(p, 'gi');
		if (new RegExp(r.source, r.flags.replace(/g/g, '')).test('')) {
			return { regex: null, error: 'Pattern matches empty text' };
		}
		return { regex: r, error: null };
	} catch {
		return { regex: null, error: 'Invalid regex' };
	}
}

/**
 * Simple debounce wrapper. Returns trigger() and cancel() functions.
 * Default delay: 200ms.
 */
export function createDebouncedSearch(fn: () => void, delayMs = 200): { trigger: () => void; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | null = null;
	return {
		trigger(): void {
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(() => { timer = null; fn(); }, delayMs);
		},
		cancel(): void {
			if (timer !== null) { clearTimeout(timer); timer = null; }
		},
	};
}

/**
 * Navigate match index with circular wrapping.
 * direction: 'next' increments, 'prev' decrements.
 * Returns 0 if matchCount is 0 or 1.
 */
export function navigateMatch(currentIndex: number, matchCount: number, direction: 'next' | 'prev'): number {
	if (matchCount <= 1) return 0;
	if (direction === 'next') return (currentIndex + 1) % matchCount;
	return (currentIndex - 1 + matchCount) % matchCount;
}

/**
 * Regex cache: returns cached regex if query+mode unchanged, otherwise builds new one.
 */
export function createRegexCache(): { get: (query: string, mode: SearchMode) => { regex: RegExp | null; error: string | null } } {
	let cached: { query: string; mode: SearchMode; result: { regex: RegExp | null; error: string | null } } | null = null;
	return {
		get(query: string, mode: SearchMode): { regex: RegExp | null; error: string | null } {
			if (cached && cached.query === query && cached.mode === mode) return cached.result;
			const result = buildSearchRegex(query, mode);
			cached = { query, mode, result };
			return result;
		},
	};
}

/**
 * Render text with regex matches wrapped in <mark> elements.
 * Returns a Lit TemplateResult with highlighted substrings.
 * `cls` is the CSS class applied to each <mark> element.
 */
export function highlightMatches(text: string, regex: RegExp, cls: string): TemplateResult {
	regex.lastIndex = 0;
	const parts: TemplateResult[] = [];
	let lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = regex.exec(text)) !== null) {
		if (!m[0]) { regex.lastIndex++; continue; }
		if (m.index > lastIndex) parts.push(html`${text.slice(lastIndex, m.index)}`);
		const matched = m[0];
		parts.push(html`<mark class="${cls}">${matched}</mark>`);
		lastIndex = m.index + matched.length;
	}
	if (lastIndex < text.length) parts.push(html`${text.slice(lastIndex)}`);
	if (parts.length === 0) return html`${text}`;
	return html`${parts}`;
}
