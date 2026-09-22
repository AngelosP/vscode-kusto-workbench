export interface ExternalMcpHostEnvironment {
	readonly platform: string;
	readonly architecture: string;
	readonly remoteName?: string;
	readonly desktop: boolean;
}

export function isExternalMcpHostEligible(environment: ExternalMcpHostEnvironment): boolean {
	return environment.platform === 'win32'
		&& environment.architecture === 'x64'
		&& environment.remoteName === undefined
		&& environment.desktop;
}