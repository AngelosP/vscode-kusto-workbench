import { describe, expect, it } from 'vitest';
import { isExternalMcpHostEligible } from '../../../src/shared/externalMcpHostEligibility';

describe('external MCP host eligibility', () => {
	it.each([
		['win32', 'x64', undefined, true, true],
		['linux', 'x64', undefined, true, false],
		['darwin', 'x64', undefined, true, false],
		['win32', 'arm64', undefined, true, false],
		['win32', 'x64', 'wsl', true, false],
		['win32', 'x64', 'ssh-remote', true, false],
		['win32', 'x64', 'dev-container', true, false],
		['win32', 'x64', undefined, false, false],
	])('classifies platform=%s architecture=%s remote=%s desktop=%s', (
		platform,
		architecture,
		remoteName,
		desktop,
		expected,
	) => {
		expect(isExternalMcpHostEligible({ platform, architecture, remoteName, desktop })).toBe(expected);
	});
});