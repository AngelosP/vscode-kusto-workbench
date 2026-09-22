export interface ManagedExternalMcpProvider {
	start(): Promise<void>;
	stop(): Promise<void>;
	dispose(): Promise<void>;
}

export class ExternalMcpProviderStateCoordinator<TProvider extends ManagedExternalMcpProvider> {
	private provider: TProvider | undefined;
	private providerPromise: Promise<TProvider> | undefined;
	private lifecycleTail: Promise<void> = Promise.resolve();
	private generation = 0;
	private disposed = false;
	private disposalComplete = false;

	constructor(private readonly loadProvider: () => Promise<TProvider>) {}

	setEnabled(enabled: boolean): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const generation = ++this.generation;
		return this.enqueue(async () => {
			if (this.disposed || generation !== this.generation) return;
			if (!enabled) {
				await this.provider?.stop();
				return;
			}
			const provider = await this.getProvider();
			if (this.disposed || generation !== this.generation) {
				await provider.stop();
				return;
			}
			await provider.start();
			if (this.disposed || generation !== this.generation) await provider.stop();
		});
	}

	dispose(): Promise<void> {
		if (this.disposalComplete) return Promise.resolve();
		if (!this.disposed) {
			this.disposed = true;
			this.generation++;
		}
		return this.enqueue(async () => {
			let provider = this.provider;
			if (!provider && this.providerPromise) provider = await this.providerPromise.catch(() => undefined);
			await provider?.dispose();
			this.provider = undefined;
			this.providerPromise = undefined;
			this.disposalComplete = true;
		});
	}

	private getProvider(): Promise<TProvider> {
		if (this.provider) return Promise.resolve(this.provider);
		if (!this.providerPromise) {
			const loading = this.loadProvider().then(provider => {
				this.provider = provider;
				return provider;
			});
			const tracked = loading.catch(error => {
				if (this.providerPromise === tracked) this.providerPromise = undefined;
				throw error;
			});
			this.providerPromise = tracked;
		}
		return this.providerPromise;
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const current = this.lifecycleTail.catch(() => undefined).then(operation);
		this.lifecycleTail = current.catch(() => undefined);
		return current;
	}
}
