// Monaco editor writability guards — extracted from monaco.ts (Phase 6 decomposition).
// Forces Monaco textareas to remain writable despite VS Code webview timing glitches.

const _win = window;

const __kustoWritableGuardsByEditor = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;

export function __kustoNormalizeTextareasWritable(root: any) {
	try {
		if (!root || typeof root.querySelectorAll !== 'function') {
			return;
		}
		const textareas = root.querySelectorAll('textarea');
		if (!textareas || !textareas.length) {
			return;
		}
		for (const ta of textareas) {
			if (!ta) continue;
			try { ta.readOnly = false; } catch (e) { console.error('[kusto]', e); }
			try { ta.disabled = false; } catch (e) { console.error('[kusto]', e); }
			try { ta.removeAttribute && ta.removeAttribute('readonly'); } catch (e) { console.error('[kusto]', e); }
			try { ta.removeAttribute && ta.removeAttribute('disabled'); } catch (e) { console.error('[kusto]', e); }
			// Some environments can set aria-disabled; clear it to avoid AT/DOM locking.
			try { ta.removeAttribute && ta.removeAttribute('aria-disabled'); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoForceEditorWritable(editor: any) {
	try {
		if (!editor) return;
		try {
			if (typeof editor.updateOptions === 'function') {
				editor.updateOptions({ readOnly: false, domReadOnly: false });
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			const dom = typeof editor.getDomNode === 'function' ? editor.getDomNode() : null;
			if (!dom) return;
			// Monaco can have multiple textareas (inputarea, find widget, etc.).
			// Ensure none of them are stuck readonly/disabled.
			__kustoNormalizeTextareasWritable(dom);
		} catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoInstallWritableGuard(editor: any) {
	try {
		if (!editor) return;
		if (typeof MutationObserver === 'undefined') return;
		if (__kustoWritableGuardsByEditor && __kustoWritableGuardsByEditor.get(editor)) {
			return;
		}
		const dom = (typeof editor.getDomNode === 'function') ? editor.getDomNode() : null;
		if (!dom || typeof dom.querySelector !== 'function') {
			return;
		}

		let pending = false;
		const schedule = () => {
			if (pending) return;
			pending = true;
			setTimeout(() => {
				pending = false;
				try { __kustoForceEditorWritable(editor); } catch (e) { console.error('[kusto]', e); }
			}, 0);
		};

		const observer = new MutationObserver((mutations) => {
			try {
				for (const m of mutations || []) {
					if (!m || m.type !== 'attributes') continue;
					const t = m.target;
					if (!t || (t as any).tagName !== 'TEXTAREA') continue;
					const a = String(m.attributeName || '').toLowerCase();
					if (a === 'readonly' || a === 'disabled' || a === 'aria-disabled') {
						schedule();
						return;
					}
				}
			} catch (e) { console.error('[kusto]', e); }
		});

		observer.observe(dom, {
			subtree: true,
			attributes: true,
			attributeFilter: ['readonly', 'disabled', 'aria-disabled']
		});
		if (__kustoWritableGuardsByEditor) {
			__kustoWritableGuardsByEditor.set(editor, observer);
		}
		// Run once right away.
		schedule();
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoEnsureEditorWritableSoon(editor: any) {
	try {
		// Retry a few times; this avoids relying on a single timing point.
		const delays = [0, 50, 250, 1000];
		for (const d of delays) {
			setTimeout(() => {
				try { __kustoForceEditorWritable(editor); } catch (e) { console.error('[kusto]', e); }
			}, d);
		}
		try { __kustoInstallWritableGuard(editor); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoEnsureAllEditorsWritableSoon() {
	try {
		const maps = [];
		try {
			if (typeof _win.queryEditors !== 'undefined' && _win.queryEditors) maps.push(_win.queryEditors);
		} catch (e) { console.error('[kusto]', e); }
		try {
			if (typeof _win.__kustoMarkdownEditors !== 'undefined' && _win.__kustoMarkdownEditors) maps.push(_win.__kustoMarkdownEditors);
		} catch (e) { console.error('[kusto]', e); }
		try {
			if (typeof _win.__kustoPythonEditors !== 'undefined' && _win.__kustoPythonEditors) maps.push(_win.__kustoPythonEditors);
		} catch (e) { console.error('[kusto]', e); }

		for (const m of maps) {
			try {
				for (const ed of Object.values(m || {})) {
					if (!ed) continue;
					try { __kustoEnsureEditorWritableSoon(ed); } catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

// ── Window bridges ──────────────────────────────────────────────────────────
window.__kustoNormalizeTextareasWritable = __kustoNormalizeTextareasWritable;
window.__kustoForceEditorWritable = __kustoForceEditorWritable;
window.__kustoInstallWritableGuard = __kustoInstallWritableGuard;
window.__kustoEnsureEditorWritableSoon = __kustoEnsureEditorWritableSoon;
window.__kustoEnsureAllEditorsWritableSoon = __kustoEnsureAllEditorsWritableSoon;
