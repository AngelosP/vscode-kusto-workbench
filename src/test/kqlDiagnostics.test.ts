import * as assert from 'assert';

import { KqlLanguageService } from '../kqlLanguageService/service';


suite('KQL diagnostics', () => {
	test('does not flag closing brace/semicolon after pipe inside let body', () => {
		const text = [
			'let Base = () {',
			'    RawEventsVSCodeExt',
			'    | where ExtensionName == "GitHub.copilot-chat"',
			'};',
			'Base',
			'| where EventName == "github.copilot-chat/response.success"',
			'| take 10',
			''
		].join('\n');

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, null);
		const expectedPipe = diags.filter((d) => d.code === 'KW_EXPECTED_PIPE');
		assert.strictEqual(
			expectedPipe.length,
			0,
			`Expected no KW_EXPECTED_PIPE diagnostics, got: ${JSON.stringify(expectedPipe, null, 2)}`
		);
	});

	test('flags missing pipe after a bare identifier statement start', () => {
		const text = [
			'Base',
			'asdasdsadsa',
			'| take 1',
			''
		].join('\n');

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, null);
		const expectedPipe = diags.filter((d) => d.code === 'KW_EXPECTED_PIPE');
		assert.ok(
			expectedPipe.length >= 1,
			'Expected at least one KW_EXPECTED_PIPE diagnostic for missing pipe'
		);
	});
});
