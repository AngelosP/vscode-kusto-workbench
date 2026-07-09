import { describe, expect, it } from 'vitest';
import { redactRemoteUrlForLog } from '../../../src/host/remoteFileOpener';

describe('redactRemoteUrlForLog', () => {
	it('redacts query and fragment values in logged remote URLs', () => {
		const input = 'GET https://contoso.sharepoint.com/sites/team/file.sqlx?token=abc123&download=1#access_token=secret';
		const output = redactRemoteUrlForLog(input);

		expect(output).toContain('https://contoso.sharepoint.com/sites/team/file.sqlx');
		expect(output).toContain('token=redacted');
		expect(output).toContain('download=redacted');
		expect(output).toContain('#redacted');
		expect(output).not.toContain('abc123');
		expect(output).not.toContain('secret');
	});
});
