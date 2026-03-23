import { defineConfig } from 'vitest/config';
import { transformWithEsbuild } from 'vite';
import path from 'path';

export default defineConfig({
	resolve: {
		alias: {
			// Host source files import `vscode` which is only available in the
			// VS Code extension host.  A minimal mock lets Vitest resolve the
			// import without crashing (the tested functions never call vscode APIs).
			vscode: path.resolve(__dirname, 'tests/mocks/vscode.ts'),
		},
	},
	test: {
		environment: 'happy-dom',
		include: ['tests/webview/**/*.test.ts'],
		globals: true,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'text-summary', 'json-summary'],
			include: [
				'src/webview/**/*.ts',
				'src/host/copilotConversationUtils.ts',
				'src/host/queryEditorConnection.ts',
				'src/host/kqlSchemaInference.ts',
				'src/host/kqlxFormat.ts',
				'src/host/schemaIndexUtils.ts',
				'src/host/kqlLanguageService/service.ts',
				'src/host/kustoClientUtils.ts',
				'src/host/queryEditorUtils.ts',
				'src/host/copilotPromptUtils.ts',
			],
			exclude: ['src/webview/vendor/**', 'src/webview/**/*.d.ts'],
		},
	},
	plugins: [
		{
			name: 'esbuild-decorators',
			enforce: 'pre',
			async transform(code, id) {
				if (!id.endsWith('.ts') || id.includes('node_modules')) return;
				// Use esbuild to handle experimentalDecorators
				const result = await transformWithEsbuild(code, id, {
					target: 'es2022',
					loader: 'ts',
					tsconfigRaw: {
						compilerOptions: {
							experimentalDecorators: true,
							useDefineForClassFields: false,
						},
					},
				});
				return { code: result.code, map: result.map };
			},
		},
	],
});
