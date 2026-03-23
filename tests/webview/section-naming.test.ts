import { describe, it, expect } from 'vitest';
import { pickNextAvailableAlphaName } from '../../src/webview/core/section-factory';

// ── pickNextAvailableAlphaName ────────────────────────────────────────────────

describe('pickNextAvailableAlphaName', () => {
	it('returns A when no names are used', () => {
		expect(pickNextAvailableAlphaName(new Set())).toBe('A');
	});

	it('returns B when A is used', () => {
		expect(pickNextAvailableAlphaName(new Set(['A']))).toBe('B');
	});

	it('returns D when A, B, C are used', () => {
		expect(pickNextAvailableAlphaName(new Set(['A', 'B', 'C']))).toBe('D');
	});

	it('returns A when B is used (first available)', () => {
		expect(pickNextAvailableAlphaName(new Set(['B']))).toBe('A');
	});

	it('returns B when A and C are used (fills gap)', () => {
		expect(pickNextAvailableAlphaName(new Set(['A', 'C']))).toBe('B');
	});

	it('returns AA when all 26 letters are used', () => {
		const all26 = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
		expect(pickNextAvailableAlphaName(all26)).toBe('AA');
	});

	it('returns AB when A-Z and AA are used', () => {
		const used = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
		used.add('AA');
		expect(pickNextAvailableAlphaName(used)).toBe('AB');
	});

	it('returns Z when A-Y are used', () => {
		const used = new Set('ABCDEFGHIJKLMNOPQRSTUVWXY'.split(''));
		expect(pickNextAvailableAlphaName(used)).toBe('Z');
	});

	it('handles set with lowercase entries (candidates are uppercase, no match)', () => {
		// Set contains lowercase 'a', but candidates are uppercase 'A'
		expect(pickNextAvailableAlphaName(new Set(['a']))).toBe('A');
	});

	it('returns A when used set is very large but does not contain A', () => {
		const used = new Set(['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']);
		expect(pickNextAvailableAlphaName(used)).toBe('A');
	});

	it('skips multiple contiguous used names', () => {
		const used = new Set(['A', 'B', 'C', 'D', 'E']);
		expect(pickNextAvailableAlphaName(used)).toBe('F');
	});

	it('returns A for empty set (fallback)', () => {
		// Even if the loop fails to find anything in 5000 iterations (impossible with empty set),
		// the fallback is A — but with empty set, first iteration returns A.
		expect(pickNextAvailableAlphaName(new Set())).toBe('A');
	});

	it('handles non-contiguous gaps in double-letter range', () => {
		const used = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
		used.add('AA');
		used.add('AC'); // skip AB
		expect(pickNextAvailableAlphaName(used)).toBe('AB');
	});

	it('returns BA when all single and AA-AZ are used', () => {
		const used = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
		for (let i = 0; i < 26; i++) {
			used.add('A' + String.fromCharCode(65 + i));
		}
		expect(pickNextAvailableAlphaName(used)).toBe('BA');
	});
});
