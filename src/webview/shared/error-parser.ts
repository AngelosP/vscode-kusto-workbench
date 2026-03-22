// Pure error parsing utilities — no DOM, no component dependencies.
// Extracted from modules/errorUtils.ts during Session 7 restructure.

// ── Types ────────────────────────────────────────────────────────────────────

export interface ErrorLocation {
	line: number;
	col: number;
	token: string;
}

export interface ErrorUxModel {
	kind: 'none' | 'badrequest' | 'json' | 'text';
	message?: string;
	pretty?: string;
	text?: string;
	location?: ErrorLocation | null;
	autoFindTerm?: string | null;
}

// ── Error parsing helpers ────────────────────────────────────────────────────

export function __kustoTryExtractJsonFromErrorText(raw: any) {
	const text = String(raw || '');
	const firstObj = text.indexOf('{');
	const firstArr = text.indexOf('[');
	let start = -1;
	let end = -1;
	if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) {
		start = firstObj;
		end = text.lastIndexOf('}');
	} else if (firstArr >= 0) {
		start = firstArr;
		end = text.lastIndexOf(']');
	}
	if (start < 0 || end < 0 || end <= start) {
		return null;
	}
	const candidate = text.slice(start, end + 1);
	try {
		return JSON.parse(candidate);
	} catch {
		try {
			const trimmed = candidate.trim();
			return JSON.parse(trimmed);
		} catch (e) { console.error('[kusto]', e); }
		return null;
	}
}

export function __kustoExtractLinePosition(text: any) {
	const s = String(text || '');
	const m = s.match(/\[line:position\s*=\s*(\d+)\s*:\s*(\d+)\s*\]/i);
	if (!m) {
		return null;
	}
	const line = parseInt(m[1], 10);
	const col = parseInt(m[2], 10);
	if (!isFinite(line) || !isFinite(col) || line <= 0 || col <= 0) {
		return null;
	}
	return { line, col, token: `[line:position=${line}:${col}]` };
}

export function __kustoNormalizeBadRequestInnerMessage(msg: any) {
	let s = String(msg || '').trim();
	s = s.replace(/^Request is invalid[^:]*:\s*/i, '');
	s = s.replace(/^(Semantic error:|Syntax error:)\s*/i, '');
	return s.trim();
}

export function __kustoStripLinePositionTokens(text: any) {
	let s = String(text || '');
	s = s.replace(/\s*\[line:position\s*=\s*\d+\s*:\s*\d+\s*\]\s*/gi, ' ');
	s = s.replace(/\s{2,}/g, ' ').trim();
	return s;
}

export function __kustoTryExtractAutoFindTermFromMessage(message: any) {
	try {
		const msg = String(message || '');
		if (!msg.trim()) return null;
		// Kusto common pitfall: calling notempty() with no args.
		try {
			const lower = msg.toLowerCase();
			const looksLikeSem0219 = lower.includes('sem0219');
			const looksLikeArity1 = lower.includes('function expects 1 argument');
			const mentionsNotEmpty = /\bnotempty\b/i.test(msg);
			if ((looksLikeSem0219 || looksLikeArity1) && mentionsNotEmpty) {
				return 'notempty';
			}
		} catch (e) { console.error('[kusto]', e); }
		let m = msg.match(/\bSEM0139\b\s*:\s*Failed\s+to\s+resolve\s+expression\s*(['"])(.*?)\1/i);
		if (!m) {
			m = msg.match(/\bSEM0260\b\s*:\s*Unknown\s+function\s*:\s*(['"])(.*?)\1/i);
		}
		if (!m) {
			m = msg.match(/\bnamed\s*(['"])(.*?)\1/i);
		}
		if (!m) {
			m = msg.match(/\bSEM\d{4}\b[^\n\r]*?(['"])(.*?)\1/i);
		}
		if (m && m[2]) {
			const t = String(m[2]);
			if (t.length > 0 && t.length <= 400) {
				return t;
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	return null;
}

// ── Error model builder ──────────────────────────────────────────────────────

export function __kustoBuildErrorUxModel(rawError: any): ErrorUxModel {
	const raw = (rawError === null || rawError === undefined) ? '' : String(rawError);
	if (!raw.trim()) {
		return { kind: 'none' };
	}

	const json = __kustoTryExtractJsonFromErrorText(raw);
	if (json && json.error && typeof json.error === 'object') {
		const code = String(json.error.code || '').trim();
		if (code === 'General_BadRequest') {
			const inner = (json.error.innererror && typeof json.error.innererror === 'object') ? json.error.innererror : null;
			const candidateMsg =
				(inner && (inner['@message'] || inner.message)) ||
				(json.error['@message'] || json.error.message) ||
				raw;
			const normalized = __kustoNormalizeBadRequestInnerMessage(candidateMsg);
			let loc = __kustoExtractLinePosition(candidateMsg) || __kustoExtractLinePosition(normalized) || __kustoExtractLinePosition(raw);
			if (!loc && inner) {
				try {
					const line = parseInt(inner['@line'] || inner.line || '', 10);
					const col = parseInt(inner['@pos'] || inner.pos || '', 10);
					if (isFinite(line) && isFinite(col) && line > 0 && col > 0) {
						loc = { line, col, token: `[line:position=${line}:${col}]` };
					}
				} catch (e) { console.error('[kusto]', e); }
			}
			const autoFindTerm = __kustoTryExtractAutoFindTermFromMessage(String(normalized || candidateMsg || ''));
			return { kind: 'badrequest', message: normalized || raw, location: loc || null, autoFindTerm };
		}

		try {
			return { kind: 'json', pretty: JSON.stringify(json, null, 2) };
		} catch (e) { console.error('[kusto]', e); }
	}

	return {
		kind: 'text',
		text: raw,
		autoFindTerm: __kustoTryExtractAutoFindTermFromMessage(raw)
	};
}
