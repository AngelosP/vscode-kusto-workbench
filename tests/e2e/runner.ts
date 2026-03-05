import {
	ExTester,
	ReleaseQuality,
} from 'vscode-extension-tester';
import * as path from 'path';

/**
 * Main entry point for running the E2E test suite.
 *
 * Usage:
 *   npm run test:e2e
 *
 * This script:
 *  1. Downloads VS Code (stable) + matching ChromeDriver
 *  2. Packages & installs the extension into the test instance
 *  3. Opens the test workspace
 *  4. Runs Mocha tests from out-e2e/specs/
 */
async function main(): Promise<void> {
	const storageFolder = path.resolve(__dirname, '..', '..', '.vscode-e2e');

	const tester = new ExTester(storageFolder, ReleaseQuality.Stable);

	// Download VS Code + ChromeDriver
	await tester.downloadCode();
	await tester.downloadChromeDriver();

	// Build & install extension
	await tester.installVsix({ useYarn: false });

	const exitCode = await tester.runTests(
		// glob needs forward slashes, even on Windows
		path.resolve(__dirname, 'specs', '*.js').replace(/\\/g, '/'),
		{
			settings: path.resolve(__dirname, '..', '..', 'tests', 'e2e', 'settings.json'),
			resources: [
				path.resolve(__dirname, '..', '..', 'tests', 'e2e', 'test-workspace'),
			],
			config: path.resolve(__dirname, '..', '..', 'tests', 'e2e', '.mocharc.yml'),
		},
	);

	process.exit(exitCode);
}

main().catch((err) => {
	console.error('E2E test runner failed:', err);
	process.exit(1);
});
