import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDir = join(__dirname, '..', '..');

describe('VSIX packaging ignore rules', () => {
	it('keeps required marketplace metadata files in the packaged extension', () => {
		const ignoreText = readFileSync(join(rootDir, '.vscodeignore'), 'utf8');
		const ignoredEntries = ignoreText
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line && !line.startsWith('#'));

		expect(ignoredEntries).not.toContain('README.md');
		expect(ignoredEntries).not.toContain('CHANGELOG.md');
		expect(ignoredEntries).not.toContain('LICENSE');
	});
});