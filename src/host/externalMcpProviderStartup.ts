export interface ExternalMcpClosable {
	close(): Promise<void>;
}

export async function completeExternalMcpProviderStartup<
	TBridge extends ExternalMcpClosable,
	TDiscovery extends ExternalMcpClosable,
>(
	bridge: TBridge,
	startDiscovery: () => Promise<TDiscovery>,
	onBridgeCleanupSucceeded?: (bridge: TBridge) => void,
): Promise<{ bridge: TBridge; discovery: TDiscovery }> {
	try {
		const discovery = await startDiscovery();
		return { bridge, discovery };
	} catch (error) {
		const cleanup = await Promise.allSettled([bridge.close()]);
		const failures = cleanup
			.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
			.map(result => result.reason);
		if (failures.length > 0) {
			throw new AggregateError([error, ...failures], 'External MCP provider startup and cleanup failed.');
		}
		onBridgeCleanupSucceeded?.(bridge);
		throw error;
	}
}