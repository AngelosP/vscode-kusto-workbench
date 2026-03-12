// KQL Prettification — pure functions extracted from monaco.ts (Phase 6 decomposition).
// No state dependencies, no DOM access. All functions are exported and assigned to window
// so that existing callers (both module imports and window.funcName calls) keep working.

export function __kustoToSingleLineKusto(input: any) {
	try {
		const text = String(input ?? '');
		if (!text.trim()) return '';

		let out = '';
		let inSingle = false;
		let inDouble = false;
		let inLineComment = false;
		let inBlockComment = false;
		let lineCommentBuf = '';
		let lastWasSpace = false;
		const pushSpace = () => {
			if (!lastWasSpace && out && !out.endsWith(' ')) {
				out += ' ';
				lastWasSpace = true;
			}
		};

		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			const next = i + 1 < text.length ? text[i + 1] : '';

			if (inLineComment) {
				if (ch === '\n' || ch === '\r') {
					const c = lineCommentBuf.replace(/^\/\//, '').trim();
					if (c) {
						pushSpace();
						out += `/* ${c} */`;
						lastWasSpace = false;
					}
					lineCommentBuf = '';
					inLineComment = false;
					pushSpace();
				} else {
					lineCommentBuf += ch;
				}
				continue;
			}

			if (!inSingle && !inDouble && !inBlockComment && ch === '/' && next === '/') {
				inLineComment = true;
				lineCommentBuf = '//';
				i++;
				continue;
			}
			if (!inSingle && !inDouble && !inBlockComment && ch === '/' && next === '*') {
				inBlockComment = true;
				out += '/*';
				lastWasSpace = false;
				i++;
				continue;
			}
			if (inBlockComment) {
				out += ch;
				lastWasSpace = false;
				if (ch === '*' && next === '/') {
					out += '/';
					lastWasSpace = false;
					inBlockComment = false;
					i++;
				}
				continue;
			}

			if (!inDouble && ch === "'") {
				const prev = i > 0 ? text[i - 1] : '';
				if (prev !== '\\') {
					inSingle = !inSingle;
				}
				out += ch;
				lastWasSpace = false;
				continue;
			}
			if (!inSingle && ch === '"') {
				const prev = i > 0 ? text[i - 1] : '';
				if (prev !== '\\') {
					inDouble = !inDouble;
				}
				out += ch;
				lastWasSpace = false;
				continue;
			}

			if (!inSingle && !inDouble && /\s/.test(ch)) {
				pushSpace();
				continue;
			}

			out += ch;
			lastWasSpace = false;
		}

		if (inLineComment) {
			const c = lineCommentBuf.replace(/^\/\//, '').trim();
			if (c) {
				pushSpace();
				out += `/* ${c} */`;
			}
		}

		return out.replace(/\s+/g, ' ').trim();
	} catch {
		return String(input ?? '').replace(/\s+/g, ' ').trim();
	}
}

export function __kustoExplodePipesToLines(input: any) {
	try {
		const text = String(input ?? '');
		if (!text) return '';
		let out = '';
		let inSingle = false;
		let inDouble = false;
		let depth = 0;
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (!inDouble && ch === "'") {
				const prev = i > 0 ? text[i - 1] : '';
				if (prev !== '\\') inSingle = !inSingle;
				out += ch;
				continue;
			}
			if (!inSingle && ch === '"') {
				const prev = i > 0 ? text[i - 1] : '';
				if (prev !== '\\') inDouble = !inDouble;
				out += ch;
				continue;
			}
			if (!inSingle && !inDouble) {
				if (ch === '(' || ch === '[' || ch === '{') depth++;
				else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
				if (depth === 0 && ch === '|') {
					// If this pipe isn't already at the start of a line, put it on a new line.
					let k = out.length - 1;
					while (k >= 0 && (out[k] === ' ' || out[k] === '\t')) k--;
					if (k >= 0 && out[k] !== '\n') {
						out += '\n';
					}
				}
			}
			out += ch;
		}
		return out;
	} catch {
		return String(input ?? '');
	}
}

export function __kustoSplitTopLevel(text: any, delimiterChar: any) {
	const parts = [];
	let buf = '';
	let depth = 0;
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = i + 1 < text.length ? text[i + 1] : '';
		if (!inDouble && ch === "'") {
			const prev = i > 0 ? text[i - 1] : '';
			if (prev !== '\\') inSingle = !inSingle;
			buf += ch;
			continue;
		}
		if (!inSingle && ch === '"') {
			const prev = i > 0 ? text[i - 1] : '';
			if (prev !== '\\') inDouble = !inDouble;
			buf += ch;
			continue;
		}
		if (!inSingle && !inDouble) {
			if (ch === '(' || ch === '[' || ch === '{') depth++;
			else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
			if (depth === 0 && ch === delimiterChar) {
				parts.push(buf);
				buf = '';
				continue;
			}
		}
		buf += ch;
	}
	parts.push(buf);
	return parts;
}

export function __kustoFindTopLevelKeyword(text: any, keywordLower: any) {
	try {
		const kw = String(keywordLower || '').toLowerCase();
		if (!kw) return -1;
		let depth = 0;
		let inSingle = false;
		let inDouble = false;
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (!inDouble && ch === "'") {
				const prev = i > 0 ? text[i - 1] : '';
				if (prev !== '\\') inSingle = !inSingle;
				continue;
			}
			if (!inSingle && ch === '"') {
				const prev = i > 0 ? text[i - 1] : '';
				if (prev !== '\\') inDouble = !inDouble;
				continue;
			}
			if (inSingle || inDouble) continue;
			if (ch === '(' || ch === '[' || ch === '{') depth++;
			else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
			if (depth !== 0) continue;

			// Word boundary check for keyword.
			if (i + kw.length <= text.length && text.slice(i, i + kw.length).toLowerCase() === kw) {
				const before = i > 0 ? text[i - 1] : ' ';
				const after = i + kw.length < text.length ? text[i + kw.length] : ' ';
				if (!/[A-Za-z0-9_\-]/.test(before) && !/[A-Za-z0-9_\-]/.test(after)) {
					return i;
				}
			}
		}
		return -1;
	} catch {
		return -1;
	}
}

export function __kustoPrettifyWhereClause(rawAfterWhere: any) {
	const raw = String(rawAfterWhere ?? '');
	let items = [];
	let cond = '';
	let lastNewlineIdx = -1;
	let depth = 0;
	let inSingle = false;
	let inDouble = false;
	let pendingOp: any = null;
	let lastWasSpace = false;
	const pushCondChar = (ch: any) => {
		if (!inSingle && !inDouble && /\s/.test(ch)) {
			if (!lastWasSpace) {
				cond += ' ';
				lastWasSpace = true;
			}
			return;
		}
		cond += ch;
		lastWasSpace = false;
	};
	const flushCond = () => {
		const t = cond.replace(/\s+/g, ' ').trim();
		if (t) items.push({ type: 'cond', op: pendingOp, text: t });
		cond = '';
		lastWasSpace = false;
		pendingOp = null;
	};

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		const next = i + 1 < raw.length ? raw[i + 1] : '';
		if (!inSingle && !inDouble && ch === '/' && next === '/') {
			// Line comment. Keep full-line comments as their own item; keep inline comments attached to the current condition.
			let j = i + 2;
			while (j < raw.length && raw[j] !== '\n' && raw[j] !== '\r') j++;
			const commentText = ('//' + raw.slice(i + 2, j)).replace(/[\r\n]+/g, '').trimRight();

			const sinceNl = raw.slice(lastNewlineIdx + 1, i);
			const isFullLine = /^\s*$/.test(sinceNl);
			if (isFullLine) {
				items.push({ type: 'comment', text: commentText, inline: false });
			} else {
				// Inline comment should remain with the condition it trails.
				// Normalize spacing before the comment.
				cond = cond.replace(/\s+$/g, '');
				cond += ' ' + commentText;
				lastWasSpace = false;
			}
			i = j - 1;
			continue;
		}
		if (!inDouble && ch === "'") {
			const prev = i > 0 ? raw[i - 1] : '';
			if (prev !== '\\') inSingle = !inSingle;
			pushCondChar(ch);
			continue;
		}
		if (!inSingle && ch === '"') {
			const prev = i > 0 ? raw[i - 1] : '';
			if (prev !== '\\') inDouble = !inDouble;
			pushCondChar(ch);
			continue;
		}
		if (!inSingle && !inDouble) {
			if (ch === '\n' || ch === '\r') {
				lastNewlineIdx = i;
			}
			if (ch === '(' || ch === '[' || ch === '{') depth++;
			else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
			if (depth === 0) {
				// Detect top-level 'and' / 'or' keywords.
				const slice3 = i + 3 <= raw.length ? raw.slice(i, i + 3).toLowerCase() : '';
				const slice2 = i + 2 <= raw.length ? raw.slice(i, i + 2).toLowerCase() : '';
				const kw = (slice3 === 'and') ? 'and' : ((slice2 === 'or') ? 'or' : '');
				if (kw) {
					const before = i > 0 ? raw[i - 1] : ' ';
					const after = i + kw.length < raw.length ? raw[i + kw.length] : ' ';
					if (!/[A-Za-z0-9_\-]/.test(before) && !/[A-Za-z0-9_\-]/.test(after)) {
						flushCond();
						pendingOp = kw;
						i += (kw.length - 1);
						continue;
					}
				}
			}
		}
		pushCondChar(ch);
	}
	flushCond();
	return items;
}

export function __kustoPrettifyKusto(input: any) {
	let raw = String(input ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	// If the query is currently single-line (or has multiple pipe clauses on one line), explode pipes
	// back into separate lines before applying the rule-based formatter.
	try {
		raw = __kustoExplodePipesToLines(raw);
	} catch { /* ignore */ }
	const lines = raw.split('\n').map((l) => String(l).replace(/[ \t]+$/g, ''));

	const out = [];
	let i = 0;
	while (i < lines.length) {
		const lineRaw = lines[i];
		const trimmed = lineRaw.trim();
		if (!trimmed) {
			// Collapse large runs of blank lines.
			if (out.length === 0 || out[out.length - 1] === '') {
				i++;
				continue;
			}
			out.push('');
			i++;
			continue;
		}

		const isPipe = trimmed.startsWith('|');
		const isSummarize = /^\|\s*summarize\b/i.test(trimmed);
		const isWhere = /^\|\s*where\b/i.test(trimmed);
		const isCreateFn = /^\s*\.(create|create-or-alter)\s+function\b/i.test(trimmed);

		if (isSummarize) {
			const block = [];
			let j = i;
			for (; j < lines.length; j++) {
				const t = String(lines[j] || '').trim();
				if (j !== i && t.startsWith('|')) break;
				block.push(lines[j]);
			}
			const joined = block.join(' ').replace(/\s+/g, ' ').trim();
			const after = joined.replace(/^\|\s*summarize\b/i, '').trim();
			const byIdx = __kustoFindTopLevelKeyword(after, 'by');
			const aggText = byIdx >= 0 ? after.slice(0, byIdx).trim() : after;
			const byText = byIdx >= 0 ? after.slice(byIdx + 2).trim() : '';

			out.push('| summarize');
			const aggItems = __kustoSplitTopLevel(aggText, ',')
				.map((s) => String(s || '').trim())
				.filter(Boolean)
				.map((s) => s.replace(/^,\s*/, '').replace(/,$/, '').trim());
			for (let k = 0; k < aggItems.length; k++) {
				const comma = (k < aggItems.length - 1) ? ',' : '';
				out.push('    ' + aggItems[k] + comma);
			}

			const byItems = __kustoSplitTopLevel(byText, ',')
				.map((s) => String(s || '').trim())
				.filter(Boolean)
				.map((s) => s.replace(/^,\s*/, '').replace(/,$/, '').trim());
			if (byItems.length) {
				out.push('    by');
				for (let k = 0; k < byItems.length; k++) {
					const comma = (k < byItems.length - 1) ? ',' : '';
					out.push('    ' + byItems[k] + comma);
				}
			}
			i = j;
			continue;
		}

		if (isWhere) {
			const block = [];
			let j = i;
			for (; j < lines.length; j++) {
				const t = String(lines[j] || '').trim();
				if (j !== i && t.startsWith('|')) break;
				block.push(lines[j]);
			}
			const first = String(block[0] || '').trim();
			const after = first.replace(/^\|\s*where\b/i, '').trim();
			const rest = block.slice(1).join('\n');
			const items = __kustoPrettifyWhereClause([after, rest].filter(Boolean).join('\n'));
			let emittedFirst = false;
			const pendingComments: any[] = [];
			const emitPendingComments = () => {
				for (const c of pendingComments.splice(0, pendingComments.length)) {
					out.push('    ' + String(c || '').trim());
				}
			};
			for (const it of items) {
				if (!it) continue;
				if (it.type === 'comment') {
					// Group the comment with the next condition line by emitting it right before the next cond.
					pendingComments.push(String(it.text || '').trim());
					continue;
				}
				if (it.type === 'cond') {
					emitPendingComments();
					if (!emittedFirst) {
						out.push('| where ' + it.text);
						emittedFirst = true;
					} else {
						const op = String((it as any).op || 'and').toLowerCase();
						out.push('    ' + op + ' ' + it.text);
					}
				}
			}
			// If we ended with dangling comments, keep them at the end of the where block.
			emitPendingComments();
			if (!emittedFirst) {
				out.push('| where');
			}
			i = j;
			continue;
		}

		{
			const m = trimmed.match(/^\|\s*(extend|project|project-away|project-keep|project-rename|project-reorder|project-smart|distinct)\b/i);
			if (m) {
				const clause = String(m[1] || '').toLowerCase();
				const block = [];
				let j = i;
				for (; j < lines.length; j++) {
					const t = String(lines[j] || '').trim();
					if (j !== i && t.startsWith('|')) break;
					block.push(lines[j]);
				}
				const joined = block.join(' ').replace(/\s+/g, ' ').trim();
				const after = joined.replace(/^\|\s*[^\s]+\b/i, '').trim();
				const parts = __kustoSplitTopLevel(after, ',')
					.map((s) => String(s || '').trim())
					.map((s) => s.replace(/^,\s*/, '').replace(/,$/, '').trim())
					.filter(Boolean);
				if (parts.length <= 1) {
					const rest = [clause, after].filter(Boolean).join(' ');
					out.push('| ' + rest);
				} else {
					out.push('| ' + clause);
					for (let k = 0; k < parts.length; k++) {
						const comma = (k < parts.length - 1) ? ',' : '';
						out.push('    ' + parts[k] + comma);
					}
				}
				i = j;
				continue;
			}
		}

		if (isCreateFn) {
			// Format the header up to the opening '{' (if present).
			const block = [];
			let j = i;
			let foundBrace = false;
			for (; j < lines.length; j++) {
				block.push(lines[j]);
				if (String(lines[j] || '').includes('{')) {
					foundBrace = true;
					break;
				}
				// Stop at an empty line if we didn't find a brace (avoid eating whole file).
				if (j !== i && !String(lines[j] || '').trim()) break;
			}
			const headerText = block.join('\n');
			const formatted = (() => {
				try {
					const t = headerText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
					// Split at first '{' (outside of quotes) if possible.
					let braceIdx = -1;
					{
						let inS = false, inD = false;
						for (let bi = 0; bi < t.length; bi++) {
							const c = t[bi];
							if (!inD && c === "'") { const p = bi > 0 ? t[bi - 1] : ''; if (p !== '\\') inS = !inS; continue; }
							if (!inS && c === '"') { const p = bi > 0 ? t[bi - 1] : ''; if (p !== '\\') inD = !inD; continue; }
							if (!inS && !inD && c === '{') { braceIdx = bi; break; }
						}
					}
					const beforeBrace = braceIdx >= 0 ? t.slice(0, braceIdx).trim() : t.trim();
					const afterBrace = braceIdx >= 0 ? t.slice(braceIdx).trim() : '';

					// Handle optional with(...) section.
					const withIdx = __kustoFindTopLevelKeyword(beforeBrace, 'with');
					let headLine = beforeBrace;
					let withInner = '';
					let afterWith = '';
					if (withIdx >= 0) {
						const afterWithWord = beforeBrace.slice(withIdx + 4);
						const m = afterWithWord.match(/^\s*\(/);
						if (m) {
							headLine = beforeBrace.slice(0, withIdx).trim() + ' with (';
							// Extract paren contents.
							const rest = afterWithWord.slice(m[0].length);
							let depth = 1;
							let inS = false;
							let inD = false;
							let k = 0;
							for (; k < rest.length; k++) {
								const c = rest[k];
								const prev = k > 0 ? rest[k - 1] : '';
								if (!inD && c === "'") { if (prev !== '\\') inS = !inS; continue; }
								if (!inS && c === '"') { if (prev !== '\\') inD = !inD; continue; }
								if (inS || inD) continue;
								if (c === '(') depth++;
								else if (c === ')') {
									depth--;
									if (depth === 0) { k++; break; }
								}
							}
							withInner = rest.slice(0, Math.max(0, k - 1));
							afterWith = rest.slice(k).trim();
						}
					}

					const outLines = [];
					outLines.push(headLine);
					if (withInner) {
						const props = __kustoSplitTopLevel(withInner, ',')
							.map((s) => String(s || '').trim())
							.filter(Boolean);
						for (let pi = 0; pi < props.length; pi++) {
							const comma = (pi < props.length - 1) ? ',' : '';
							outLines.push('    ' + props[pi].replace(/,$/, '').trim() + comma);
						}
						outLines.push(')');
					}

					// Format function signature (after with-section or directly after header).
					const sigText = String(afterWith || (withIdx < 0 ? beforeBrace : '')).trim();
					if (sigText) {
						// Find name(...)
						const openIdx = sigText.indexOf('(');
						if (openIdx > 0) {
							const name = sigText.slice(0, openIdx).trim();
							const rest = sigText.slice(openIdx + 1);
							// Extract params until matching ')'
							let depth = 1;
							let inS = false;
							let inD = false;
							let k = 0;
							for (; k < rest.length; k++) {
								const c = rest[k];
								const prev = k > 0 ? rest[k - 1] : '';
								if (!inD && c === "'") { if (prev !== '\\') inS = !inS; continue; }
								if (!inS && c === '"') { if (prev !== '\\') inD = !inD; continue; }
								if (inS || inD) continue;
								if (c === '(') depth++;
								else if (c === ')') {
									depth--;
									if (depth === 0) { k++; break; }
								}
							}
							const inner = rest.slice(0, Math.max(0, k - 1));
							outLines.push('    ' + name + '(');
							const params = __kustoSplitTopLevel(inner, ',')
								.map((s) => String(s || '').trim())
								.filter(Boolean);
							for (let pi = 0; pi < params.length; pi++) {
								const comma = (pi < params.length - 1) ? ',' : '';
								outLines.push('        ' + params[pi].replace(/,$/, '').trim() + comma);
							}
							outLines.push('    )');
						} else {
							outLines.push('    ' + sigText);
						}
					}

					if (afterBrace) {
						outLines.push(afterBrace);
					}
					return outLines.join('\n');
				} catch {
					return headerText;
				}
			})();
			out.push(...String(formatted).split('\n').map((l) => String(l).replace(/[ \t]+$/g, '')));
			i = j + 1;
			continue;
		}

		// Default: normalize pipe prefix spacing.
		if (isPipe) {
			out.push('| ' + trimmed.replace(/^\|\s*/, ''));
		} else {
			out.push(trimmed);
		}
		i++;
	}

	// Indent pipeline clauses under the initial expression/table line.
	// Example:
	//   Table
	//       | where ...
	//           and ...
	try {
		const firstIdx = out.findIndex((l) => String(l || '').trim().length > 0);
		if (firstIdx >= 0 && !String(out[firstIdx] || '').trim().startsWith('|')) {
			const baseIndentMatch = String(out[firstIdx] || '').match(/^\s*/);
			const baseIndent = baseIndentMatch ? baseIndentMatch[0] : '';
			const pipeIndent = baseIndent + '    ';
			let inPipeline = false;
			for (let j = firstIdx + 1; j < out.length; j++) {
				const line: any = String(out[j] ?? '');
				const trimmed: any = line.trim();
				if (!trimmed) {
					continue;
				}
				if (trimmed.startsWith('|')) {
					out[j] = pipeIndent + trimmed;
					inPipeline = true;
					continue;
				}
				// Continuation lines emitted by prettifier for where/summarize blocks.
				if (inPipeline && /^ {4}/.test(line)) {
					out[j] = pipeIndent + line;
					continue;
				}
				// New top-level statement.
				inPipeline = false;
			}
		}
	} catch { /* ignore */ }

	// Trim leading/trailing blank lines.
	while (out.length && !String(out[0]).trim()) out.shift();
	while (out.length && !String(out[out.length - 1]).trim()) out.pop();
	return out.join('\n');
}

export function __kustoSplitKustoStatementsBySemicolon(text: any) {
	const raw = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	/** @type {{ statement: string, hasSemicolonAfter: boolean }[]} */
	const segments = [];
	let start = 0;
	let inSingle = false;
	let inDouble = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		const next = (i + 1 < raw.length) ? raw[i + 1] : '';
		const prev = (i > 0) ? raw[i - 1] : '';

		if (inLineComment) {
			if (ch === '\n') {
				inLineComment = false;
			}
			continue;
		}
		if (inBlockComment) {
			if (ch === '*' && next === '/') {
				inBlockComment = false;
				i++;
			}
			continue;
		}

		if (!inSingle && !inDouble) {
			if (ch === '/' && next === '/') {
				inLineComment = true;
				i++;
				continue;
			}
			if (ch === '/' && next === '*') {
				inBlockComment = true;
				i++;
				continue;
			}
		}

		if (!inDouble && ch === "'") {
			if (prev !== '\\') inSingle = !inSingle;
			continue;
		}
		if (!inSingle && ch === '"') {
			if (prev !== '\\') inDouble = !inDouble;
			continue;
		}

		if (!inSingle && !inDouble && ch === ';') {
			segments.push({ statement: raw.slice(start, i), hasSemicolonAfter: true });
			start = i + 1;
		}
	}
	segments.push({ statement: raw.slice(start), hasSemicolonAfter: false });
	return segments;
}

export function __kustoPrettifyKustoTextWithSemicolonStatements(text: any) {
	const raw = String(text ?? '');
	const segments = __kustoSplitKustoStatementsBySemicolon(raw);
	const hasMultipleStatements = segments.some((s) => s && s.hasSemicolonAfter);
	if (!hasMultipleStatements) {
		// Preserve exact behavior for single-statement queries.
		return __kustoPrettifyKusto(raw);
	}

	const outLines = [];
	for (const seg of segments) {
		if (!seg) continue;
		const statementText = String(seg.statement ?? '');
		const formattedStatement = (() => {
			// Avoid calling the formatter on pure-whitespace fragments.
			if (!statementText.trim()) return '';
			try {
				return __kustoPrettifyKusto(statementText);
			} catch {
				return statementText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
			}
		})();
		if (formattedStatement) {
			outLines.push(...String(formattedStatement).split('\n'));
		}
		if (seg.hasSemicolonAfter) {
			outLines.push(';');
		}
	}

	// Trim leading/trailing blank lines.
	while (outLines.length && !String(outLines[0]).trim()) outLines.shift();
	while (outLines.length && !String(outLines[outLines.length - 1]).trim()) outLines.pop();
	return outLines.join('\n');
}

// ── Window bridges ──────────────────────────────────────────────────────────
(window as any).__kustoToSingleLineKusto = __kustoToSingleLineKusto;
(window as any).__kustoExplodePipesToLines = __kustoExplodePipesToLines;
(window as any).__kustoSplitTopLevel = __kustoSplitTopLevel;
(window as any).__kustoFindTopLevelKeyword = __kustoFindTopLevelKeyword;
(window as any).__kustoPrettifyWhereClause = __kustoPrettifyWhereClause;
(window as any).__kustoPrettifyKusto = __kustoPrettifyKusto;
(window as any).__kustoSplitKustoStatementsBySemicolon = __kustoSplitKustoStatementsBySemicolon;
(window as any).__kustoPrettifyKustoTextWithSemicolonStatements = __kustoPrettifyKustoTextWithSemicolonStatements;
