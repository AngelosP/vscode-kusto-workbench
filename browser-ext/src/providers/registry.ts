import { FileSourceProvider } from './types';
import { GitHubProvider } from './github';
import { AzureDevOpsProvider } from './azure-devops';
import { RawUrlProvider } from './raw-url';

/**
 * Registry of all file source providers.
 * Providers are tested in order — first match wins.
 * More specific providers (GitHub, ADO) should come before generic ones (raw URL).
 */
const providers: FileSourceProvider[] = [
	new GitHubProvider(),
	new AzureDevOpsProvider(),
	new RawUrlProvider(), // must be last — catches any raw file URL
];

/** Find the first provider that can handle the given URL, or null. */
export function findProvider(url: URL): FileSourceProvider | null {
	for (const provider of providers) {
		if (provider.canHandle(url)) {
			return provider;
		}
	}
	return null;
}

/** Get all registered providers. */
export function getAllProviders(): readonly FileSourceProvider[] {
	return providers;
}
