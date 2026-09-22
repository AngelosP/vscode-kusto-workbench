export async function releaseLockPreservingError(
	release: () => Promise<void>,
	operationError: unknown,
	message: string,
): Promise<void> {
	try {
		await release();
	} catch (releaseError) {
		if (operationError !== undefined) {
			throw new AggregateError([operationError, releaseError], message);
		}
		throw releaseError;
	}
}