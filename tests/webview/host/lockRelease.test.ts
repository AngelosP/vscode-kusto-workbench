import { describe, expect, it, vi } from 'vitest';
import { releaseLockPreservingError } from '../../../src/host/lockRelease';

describe('releaseLockPreservingError', () => {
	it('retains both the operation and release failures', async () => {
		const operationError = new Error('operation failed');
		const releaseError = new Error('release failed');
		const release = vi.fn(async () => { throw releaseError; });

		await expect(releaseLockPreservingError(release, operationError, 'combined failure'))
			.rejects.toMatchObject({ errors: [operationError, releaseError] });
		expect(release).toHaveBeenCalledOnce();
	});

	it('surfaces a release-only failure without wrapping it', async () => {
		const releaseError = new Error('release failed');
		await expect(releaseLockPreservingError(
			async () => { throw releaseError; }, undefined, 'combined failure',
		)).rejects.toBe(releaseError);
	});
});