import Editor from '@toast-ui/editor';
import colorSyntax from '@toast-ui/editor-plugin-color-syntax';

(function attachToastUiToWindow() {
	try {
		const g = (typeof window !== 'undefined') ? window : (typeof self !== 'undefined' ? self : globalThis);
		g.toastui = g.toastui || {};
		g.toastui.Editor = Editor;
		g.toastui.Editor.plugin = g.toastui.Editor.plugin || {};
		g.toastui.Editor.plugin.colorSyntax = colorSyntax;
	} catch {
		// ignore
	}
})();
