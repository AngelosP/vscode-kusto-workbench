export type BrowserCompanionState =
	| Readonly<{ status: 'missing' }>
	| Readonly<{ status: 'loaded'; content: string }>
	| Readonly<{ status: 'error'; error: string }>;

export async function loadBrowserCompanion(
	sidecarUrl: string | undefined,
	fetchText: (url: string) => Promise<string>,
): Promise<BrowserCompanionState> {
	if (!sidecarUrl) return { status: 'missing' };
	try {
		return { status: 'loaded', content: await fetchText(sidecarUrl) };
	} catch (error) {
		const status = typeof error === 'object' && error !== null && 'status' in error
			? Number(error.status)
			: undefined;
		if (status === 404) return { status: 'missing' };
		return { status: 'error', error: error instanceof Error ? error.message : String(error) };
	}
}