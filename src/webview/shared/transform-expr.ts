// Pure transformation expression engine — extracted from extraBoxes-transformation.ts.
// No DOM access, no window globals. Importable by both Lit components and bridge modules.

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExprToken {
	t: 'num' | 'str' | 'col' | 'op' | 'id' | 'fn';
	v: any;
}

// ── Number / Date parsing ─────────────────────────────────────────────────────

export function tryParseFiniteNumber(v: unknown): number | null {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

export function tryParseDate(v: unknown): Date | null {
	if (v === null || v === undefined) return null;
	if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
	const d = new Date(v as string | number);
	return isNaN(d.getTime()) ? null : d;
}

export function formatDate(d: Date, fmt: string): string | null {
	if (!d || !(d instanceof Date)) return null;
	const pad = (n: number, len = 2) => String(n).padStart(len, '0');
	return fmt
		.replace(/yyyy/g, String(d.getFullYear()))
		.replace(/yy/g, String(d.getFullYear()).slice(-2))
		.replace(/MM/g, pad(d.getMonth() + 1))
		.replace(/M/g, String(d.getMonth() + 1))
		.replace(/dd/g, pad(d.getDate()))
		.replace(/d/g, String(d.getDate()))
		.replace(/HH/g, pad(d.getHours()))
		.replace(/H/g, String(d.getHours()))
		.replace(/hh/g, pad(d.getHours() % 12 || 12))
		.replace(/h/g, String(d.getHours() % 12 || 12))
		.replace(/mm/g, pad(d.getMinutes()))
		.replace(/m/g, String(d.getMinutes()))
		.replace(/ss/g, pad(d.getSeconds()))
		.replace(/s/g, String(d.getSeconds()));
}

// ── Raw cell value extraction ─────────────────────────────────────────────────

export function getRawCellValue(cell: unknown): unknown {
	if (cell && typeof cell === 'object') {
		if ('full' in (cell as Record<string, unknown>)) return (cell as Record<string, unknown>).full;
		if ('display' in (cell as Record<string, unknown>)) return (cell as Record<string, unknown>).display;
	}
	return cell;
}

// ── Tokenizer ─────────────────────────────────────────────────────────────────

export function tokenizeExpr(text: string): ExprToken[] {
	const s = String(text || '');
	const tokens: ExprToken[] = [];
	let i = 0;
	const isWs = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
	const isDigit = (ch: string) => ch >= '0' && ch <= '9';
	const isIdentStart = (ch: string) => (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
	const isIdent = (ch: string) => isIdentStart(ch) || isDigit(ch);
	while (i < s.length) {
		const ch = s[i];
		if (isWs(ch)) { i++; continue; }
		if (ch === '(' || ch === ')' || ch === ',' || ch === '+' || ch === '-' || ch === '*' || ch === '/') {
			tokens.push({ t: 'op', v: ch });
			i++;
			continue;
		}
		if (ch === '[') {
			let j = i + 1;
			let name = '';
			while (j < s.length && s[j] !== ']') {
				name += s[j];
				j++;
			}
			if (j >= s.length) throw new Error('Unclosed [column] reference');
			tokens.push({ t: 'col', v: name.trim() });
			i = j + 1;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const quote = ch;
			let j = i + 1;
			let out = '';
			while (j < s.length) {
				const c = s[j];
				if (c === '\\' && j + 1 < s.length) {
					out += s[j + 1];
					j += 2;
					continue;
				}
				if (c === quote) break;
				out += c;
				j++;
			}
			if (j >= s.length) throw new Error('Unclosed string literal');
			tokens.push({ t: 'str', v: out });
			i = j + 1;
			continue;
		}
		if (isDigit(ch) || (ch === '.' && i + 1 < s.length && isDigit(s[i + 1]))) {
			let j = i;
			let num = '';
			while (j < s.length) {
				const c = s[j];
				if (isDigit(c) || c === '.') {
					num += c;
					j++;
					continue;
				}
				break;
			}
			const n = Number(num);
			if (!Number.isFinite(n)) throw new Error('Invalid number: ' + num);
			tokens.push({ t: 'num', v: n });
			i = j;
			continue;
		}
		if (isIdentStart(ch)) {
			let j = i;
			let id = '';
			while (j < s.length && isIdent(s[j])) {
				id += s[j];
				j++;
			}
			tokens.push({ t: 'id', v: id });
			i = j;
			continue;
		}
		throw new Error('Unexpected character: ' + ch);
	}
	return tokens;
}

// ── Parser (Shunting-yard → RPN) ──────────────────────────────────────────────

export function parseExprToRpn(tokens: ExprToken[]): ExprToken[] {
	const output: ExprToken[] = [];
	const stack: ExprToken[] = [];
	const prec: Record<string, number> = { 'u-': 4, '*': 3, '/': 3, '+': 2, '-': 2 };
	const rightAssoc: Record<string, boolean> = { 'u-': true };
	const isOp = (v: string) => v === '+' || v === '-' || v === '*' || v === '/' || v === 'u-';
	let prev: ExprToken | null = null;
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok.t === 'num' || tok.t === 'str' || tok.t === 'col') {
			output.push(tok);
			prev = tok;
			continue;
		}
		if (tok.t === 'id') {
			const next = tokens[i + 1];
			if (next && next.t === 'op' && next.v === '(') {
				stack.push({ t: 'fn', v: tok.v });
				prev = tok;
				continue;
			}
			output.push({ t: 'col', v: tok.v });
			prev = tok;
			continue;
		}
		if (tok.t === 'op') {
			if (tok.v === ',') {
				while (stack.length && !(stack[stack.length - 1].t === 'op' && stack[stack.length - 1].v === '(')) {
					output.push(stack.pop()!);
				}
				continue;
			}
			if (tok.v === '(') {
				stack.push(tok);
				prev = tok;
				continue;
			}
			if (tok.v === ')') {
				while (stack.length && !(stack[stack.length - 1].t === 'op' && stack[stack.length - 1].v === '(')) {
					output.push(stack.pop()!);
				}
				if (!stack.length) throw new Error('Mismatched )');
				stack.pop();
				if (stack.length && stack[stack.length - 1].t === 'fn') {
					output.push(stack.pop()!);
				}
				prev = tok;
				continue;
			}
			let op = tok.v;
			if (op === '-') {
				const prevIsValue = prev && (prev.t === 'num' || prev.t === 'str' || prev.t === 'col' || (prev.t === 'op' && prev.v === ')'));
				if (!prevIsValue) op = 'u-';
			}
			if (!isOp(op)) throw new Error('Unsupported operator: ' + op);
			while (stack.length) {
				const top = stack[stack.length - 1];
				if (top.t !== 'op' || !isOp(top.v)) break;
				const p1 = prec[op] || 0;
				const p2 = prec[top.v] || 0;
				if ((rightAssoc[op] && p1 < p2) || (!rightAssoc[op] && p1 <= p2)) {
					output.push(stack.pop()!);
					continue;
				}
				break;
			}
			stack.push({ t: 'op', v: op });
			prev = tok;
			continue;
		}
		throw new Error('Unexpected token');
	}
	while (stack.length) {
		const top = stack.pop()!;
		if (top.t === 'op' && (top.v === '(' || top.v === ')')) throw new Error('Mismatched parentheses');
		output.push(top);
	}
	return output;
}

// ── Evaluator ─────────────────────────────────────────────────────────────────

export function evalRpn(rpn: ExprToken[], env: Record<string, unknown>): unknown {
	const stack: unknown[] = [];
	const getCol = (name: string): unknown => {
		const key = String(name || '');
		if (!key) return null;
		if (env && Object.prototype.hasOwnProperty.call(env, key)) return env[key];
		const lower = key.toLowerCase();
		if (env && Object.prototype.hasOwnProperty.call(env, lower)) return env[lower];
		return null;
	};
	const callFn = (fnName: string, args: unknown[]): unknown => {
		const f = String(fnName || '').toLowerCase();
		if (f === 'coalesce') {
			for (const a of args) {
				if (a !== null && a !== undefined && String(a) !== '') return a;
			}
			return null;
		}
		if (f === 'tostring') return (args.length ? String(args[0] ?? '') : '');
		if (f === 'tonumber') return tryParseFiniteNumber(args.length ? args[0] : null);
		if (f === 'len') return String(args.length ? args[0] ?? '' : '').length;
		if (f === 'round') {
			const val = tryParseFiniteNumber(args.length ? args[0] : null);
			if (val === null) return null;
			const digits = args.length > 1 ? tryParseFiniteNumber(args[1]) : 0;
			if (digits === null || digits < 0 || !Number.isInteger(digits)) return Math.round(val);
			const factor = Math.pow(10, digits);
			return Math.round(val * factor) / factor;
		}
		if (f === 'floor') {
			const val = tryParseFiniteNumber(args.length ? args[0] : null);
			return val === null ? null : Math.floor(val);
		}
		if (f === 'ceiling' || f === 'ceil') {
			const val = tryParseFiniteNumber(args.length ? args[0] : null);
			return val === null ? null : Math.ceil(val);
		}
		if (f === 'abs') {
			const val = tryParseFiniteNumber(args.length ? args[0] : null);
			return val === null ? null : Math.abs(val);
		}
		if (f === 'trim') return String(args.length ? args[0] ?? '' : '').trim();
		if (f === 'toupper' || f === 'upper') return String(args.length ? args[0] ?? '' : '').toUpperCase();
		if (f === 'tolower' || f === 'lower') return String(args.length ? args[0] ?? '' : '').toLowerCase();
		if (f === 'substring') {
			const text = String(args.length ? args[0] ?? '' : '');
			const start = args.length > 1 ? tryParseFiniteNumber(args[1]) : 0;
			const len = args.length > 2 ? tryParseFiniteNumber(args[2]) : undefined;
			if (start === null) return null;
			if (len !== undefined && len !== null) return text.substring(start, start + len);
			return text.substring(start);
		}
		if (f === 'replace') {
			const text = String(args.length ? args[0] ?? '' : '');
			const oldStr = String(args.length > 1 ? args[1] ?? '' : '');
			const newStr = String(args.length > 2 ? args[2] ?? '' : '');
			return text.split(oldStr).join(newStr);
		}
		if (f === 'indexof') {
			const text = String(args.length ? args[0] ?? '' : '');
			const search = String(args.length > 1 ? args[1] ?? '' : '');
			return text.indexOf(search);
		}
		if (f === 'now') return new Date();
		if (f === 'datetime') {
			const val = args.length ? args[0] : null;
			if (val === null || val === undefined) return null;
			if (val instanceof Date) return val;
			const d = new Date(val as string | number);
			return isNaN(d.getTime()) ? null : d;
		}
		if (f === 'getyear') { const d = tryParseDate(args.length ? args[0] : null); return d ? d.getFullYear() : null; }
		if (f === 'getmonth') { const d = tryParseDate(args.length ? args[0] : null); return d ? (d.getMonth() + 1) : null; }
		if (f === 'getday') { const d = tryParseDate(args.length ? args[0] : null); return d ? d.getDate() : null; }
		if (f === 'dayofweek') { const d = tryParseDate(args.length ? args[0] : null); return d ? d.getDay() : null; }
		if (f === 'format_datetime') {
			const d = tryParseDate(args.length ? args[0] : null);
			if (!d) return null;
			const fmt = String(args.length > 1 ? args[1] ?? '' : 'yyyy-MM-dd');
			return formatDate(d, fmt);
		}
		if (f === 'datetime_add') {
			const unit = String(args.length ? args[0] ?? '' : '').toLowerCase();
			const amount = args.length > 1 ? tryParseFiniteNumber(args[1]) : 0;
			const d = tryParseDate(args.length > 2 ? args[2] : null);
			if (!d || amount === null) return null;
			const result = new Date(d.getTime());
			if (unit === 'year') result.setFullYear(result.getFullYear() + amount);
			else if (unit === 'month') result.setMonth(result.getMonth() + amount);
			else if (unit === 'day') result.setDate(result.getDate() + amount);
			else if (unit === 'hour') result.setHours(result.getHours() + amount);
			else if (unit === 'minute') result.setMinutes(result.getMinutes() + amount);
			else if (unit === 'second') result.setSeconds(result.getSeconds() + amount);
			else return null;
			return result;
		}
		if (f === 'datetime_diff') {
			const unit = String(args.length ? args[0] ?? '' : '').toLowerCase();
			const d1 = tryParseDate(args.length > 1 ? args[1] : null);
			const d2 = tryParseDate(args.length > 2 ? args[2] : null);
			if (!d1 || !d2) return null;
			const diffMs = d1.getTime() - d2.getTime();
			if (unit === 'year') return Math.floor(diffMs / (365.25 * 24 * 60 * 60 * 1000));
			if (unit === 'month') return Math.floor(diffMs / (30.44 * 24 * 60 * 60 * 1000));
			if (unit === 'day') return Math.floor(diffMs / (24 * 60 * 60 * 1000));
			if (unit === 'hour') return Math.floor(diffMs / (60 * 60 * 1000));
			if (unit === 'minute') return Math.floor(diffMs / (60 * 1000));
			if (unit === 'second') return Math.floor(diffMs / 1000);
			return null;
		}
		if (f === 'startofday') {
			const d = tryParseDate(args.length ? args[0] : null);
			if (!d) return null;
			return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
		}
		if (f === 'startofweek') {
			const d = tryParseDate(args.length ? args[0] : null);
			if (!d) return null;
			const result = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
			result.setDate(result.getDate() - result.getDay());
			return result;
		}
		if (f === 'startofmonth') {
			const d = tryParseDate(args.length ? args[0] : null);
			if (!d) return null;
			return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
		}
		if (f === 'startofyear') {
			const d = tryParseDate(args.length ? args[0] : null);
			if (!d) return null;
			return new Date(d.getFullYear(), 0, 1, 0, 0, 0, 0);
		}
		throw new Error('Unknown function: ' + fnName);
	};

	// Function arity table
	const fnArgCounts: Record<string, number> = {
		'len': 1, 'tostring': 1, 'tonumber': 1, 'round': 2, 'floor': 1,
		'ceiling': 1, 'ceil': 1, 'abs': 1, 'trim': 1,
		'toupper': 1, 'upper': 1, 'tolower': 1, 'lower': 1,
		'substring': 3, 'replace': 3, 'indexof': 2,
		'now': 0, 'datetime': 1, 'getyear': 1, 'getmonth': 1, 'getday': 1,
		'dayofweek': 1, 'startofday': 1, 'startofweek': 1, 'startofmonth': 1,
		'startofyear': 1, 'format_datetime': 2, 'datetime_add': 3, 'datetime_diff': 3,
	};

	for (const tok of rpn) {
		if (tok.t === 'num' || tok.t === 'str') { stack.push(tok.v); continue; }
		if (tok.t === 'col') { stack.push(getCol(tok.v)); continue; }
		if (tok.t === 'op') {
			if (tok.v === 'u-') {
				const a = stack.pop();
				const n = tryParseFiniteNumber(a);
				stack.push((n === null) ? null : (-n));
				continue;
			}
			const b = stack.pop();
			const a = stack.pop();
			if (tok.v === '+') {
				const an = tryParseFiniteNumber(a);
				const bn = tryParseFiniteNumber(b);
				if (an !== null && bn !== null) stack.push(an + bn);
				else stack.push(String(a ?? '') + String(b ?? ''));
				continue;
			}
			if (tok.v === '-') {
				const an = tryParseFiniteNumber(a); const bn = tryParseFiniteNumber(b);
				stack.push((an === null || bn === null) ? null : (an - bn));
				continue;
			}
			if (tok.v === '*') {
				const an = tryParseFiniteNumber(a); const bn = tryParseFiniteNumber(b);
				stack.push((an === null || bn === null) ? null : (an * bn));
				continue;
			}
			if (tok.v === '/') {
				const an = tryParseFiniteNumber(a); const bn = tryParseFiniteNumber(b);
				stack.push((an === null || bn === null || bn === 0) ? null : (an / bn));
				continue;
			}
			throw new Error('Unsupported operator: ' + tok.v);
		}
		if (tok.t === 'fn') {
			const lower = String(tok.v || '').toLowerCase();
			const argc = fnArgCounts[lower] ?? 1;
			const args: unknown[] = [];
			for (let k = 0; k < argc; k++) args.unshift(stack.pop());
			stack.push(callFn(tok.v, args));
			continue;
		}
		throw new Error('Unexpected token in eval');
	}
	return stack.length ? stack[stack.length - 1] : null;
}
