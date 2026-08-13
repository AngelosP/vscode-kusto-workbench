import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
	clearNextDevelopmentCsvSaveTarget,
	setNextDevelopmentCsvSaveTarget,
	showCsvSaveDialogWithDevelopmentTarget,
} from '../../../src/host/developmentCsvSaveTarget';

describe('development CSV save target', () => {
	afterEach(() => {
		clearNextDevelopmentCsvSaveTarget();
		vi.restoreAllMocks();
	});

	it('resolves a file name in the temp directory and consumes it once', async () => {
		const fallbackUri = vscode.Uri.file(path.join(os.tmpdir(), 'fallback.csv'));
		const pickerSpy = vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(fallbackUri as any);
		const targetUri = setNextDevelopmentCsvSaveTarget('e2e-results.csv');
		const options = { filters: { CSV: ['csv'] } };

		expect(targetUri.fsPath).toBe(path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'e2e-results.csv'));
		expect(await showCsvSaveDialogWithDevelopmentTarget(options)).toBe(targetUri);
		expect(pickerSpy).not.toHaveBeenCalled();
		expect(await showCsvSaveDialogWithDevelopmentTarget(options)).toBe(fallbackUri);
		expect(pickerSpy).toHaveBeenCalledOnce();
	});

	it('accepts an absolute target path', async () => {
		const absolutePath = path.resolve(os.tmpdir(), 'absolute-results.csv');
		const targetUri = setNextDevelopmentCsvSaveTarget(absolutePath);

		expect((await showCsvSaveDialogWithDevelopmentTarget({}))?.fsPath).toBe(absolutePath);
	});

	it('rejects relative directories and dot paths', () => {
		for (const target of [path.join('nested', 'results.csv'), '.', '..']) {
			expect(() => setNextDevelopmentCsvSaveTarget(target))
				.toThrow('must be an absolute path or a file name');
		}
	});
});