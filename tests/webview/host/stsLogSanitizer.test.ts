import { describe, expect, it } from 'vitest';
import { sanitizeStsLogText } from '../../../src/host/sql/stsLogSanitizer';

describe('sanitizeStsLogText', () => {
	it('redacts bearer tokens, JWTs, credentials, and URL userinfo', () => {
		const jwt = 'eyJabcdefghij.abcdefghijk.abcdefghijk';
		const sanitized = sanitizeStsLogText(
			`Bearer secret ${jwt} password=hunter2 "azureAccountToken":"token-value" https://user:pass@example.com/path`,
		);
		expect(sanitized).not.toContain('secret');
		expect(sanitized).not.toContain(jwt);
		expect(sanitized).not.toContain('hunter2');
		expect(sanitized).not.toContain('token-value');
		expect(sanitized).not.toContain('user:pass');
		expect(sanitized).toContain('[redacted]');
	});
});