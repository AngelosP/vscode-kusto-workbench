import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../../src/shared/sha256.js';

describe('sha256Hex', () => {
	it.each([
		['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
		['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
		['Kusto Workbench', 'd851064d342b282330c268bb19616258faf5002101f54acc2dc7a391f1ea7e09'],
	])('matches the SHA-256 vector for %j', (input, expected) => {
		expect(sha256Hex(input)).toBe(expected);
	});
});