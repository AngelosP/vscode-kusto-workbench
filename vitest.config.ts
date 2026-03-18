import { defineConfig } from 'vitest/config';
import { transformWithEsbuild } from 'vite';

export default defineConfig({
	test: {
		environment: 'happy-dom',
		include: ['tests/webview/**/*.test.ts'],
		globals: true,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'text-summary'],
			include: ['src/webview/**/*.ts'],
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
