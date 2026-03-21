// Lazy loaders for heavy vendor scripts (ECharts, TOAST UI Editor).
// Each loader injects a <script> tag on first call and returns a cached promise.
// Multiple calls return the same promise (idempotent).

const _win = window as any;

// ── ECharts ──────────────────────────────────────────────────────────────────

let _echartsPromise: Promise<void> | null = null;

/**
 * Ensures ECharts is loaded. Returns immediately if already available.
 * Injects a `<script>` tag on first call and resolves when `window.echarts` is available.
 */
export function ensureEchartsLoaded(): Promise<void> {
	if (_win.echarts && typeof _win.echarts.init === 'function') return Promise.resolve();
	if (_echartsPromise) return _echartsPromise;

	const url = _win.__kustoQueryEditorConfig?.echartsUrl;
	if (!url) return Promise.resolve();

	_echartsPromise = new Promise<void>((resolve, reject) => {
		const el = document.createElement('script');
		el.src = url;
		el.onload = () => resolve();
		el.onerror = () => {
			_echartsPromise = null; // allow retry
			reject(new Error('Failed to load ECharts'));
		};
		(document.head || document.documentElement).appendChild(el);
	});
	return _echartsPromise;
}

// ── TOAST UI Editor ──────────────────────────────────────────────────────────

let _toastUiPromise: Promise<void> | null = null;
let _toastUiCssInjected = false;

/**
 * Ensures TOAST UI Editor is loaded. Returns immediately if already available.
 * Injects CSS `<link>` tags (once) and a `<script>` tag on first call.
 * Temporarily disables AMD detection for the UMD sub-bundles inside TOAST UI.
 */
export function ensureToastUiLoaded(): Promise<void> {
	if (_win.toastui?.Editor) return Promise.resolve();
	if (_toastUiPromise) return _toastUiPromise;

	const cfg = _win.__kustoQueryEditorConfig;
	const url = cfg?.toastUiEditorUrl;
	if (!url) return Promise.resolve();

	// Inject CSS files once (before JS so styles are ready when editor renders).
	if (!_toastUiCssInjected) {
		_toastUiCssInjected = true;
		const cssUrls: string[] = cfg?.toastUiCssUrls || [];
		for (const cssUrl of cssUrls) {
			const link = document.createElement('link');
			link.rel = 'stylesheet';
			link.href = cssUrl;
			(document.head || document.documentElement).appendChild(link);
		}
	}

	_toastUiPromise = new Promise<void>((resolve, reject) => {
		// TOAST UI embeds tui-color-picker which is a UMD bundle containing
		// `define.amd` checks. Temporarily disable AMD so it takes the globals path.
		let restore: (() => void) | null = null;
		try {
			const saved = {
				defineAmd: _win.define?.amd,
				module: _win.module,
				exports: _win.exports,
			};
			try { if (_win.define?.amd) _win.define.amd = undefined; } catch { /* ignore */ }
			try { _win.module = undefined; _win.exports = undefined; } catch { /* ignore */ }
			restore = () => {
				try { if (_win.define) _win.define.amd = saved.defineAmd; } catch { /* ignore */ }
				try { _win.module = saved.module; _win.exports = saved.exports; } catch { /* ignore */ }
			};
		} catch { restore = null; }

		const el = document.createElement('script');
		el.src = url;
		el.onload = () => {
			try { restore?.(); } catch { /* ignore */ }
			resolve();
		};
		el.onerror = () => {
			try { restore?.(); } catch { /* ignore */ }
			_toastUiPromise = null; // allow retry
			reject(new Error('Failed to load TOAST UI Editor'));
		};
		(document.head || document.documentElement).appendChild(el);
	});
	return _toastUiPromise;
}
