// Monaco auto-resize — extracted from monaco.ts (Phase 6 decomposition).
// Resizes Monaco editor wrappers so full content is visible (no inner scrollbars).

import { pState } from '../shared/persistence-state';
import { queryEditors } from '../core/state';
const _win = window;

export function __kustoAutoSizeEditor(boxId: unknown, persist: () => void = () => {}): void {
	const id = String(boxId || '').trim();
	if (!id) return;
	const editorEl = document.getElementById(id + '_query_editor') as any;
	const wrapper = editorEl && editorEl.closest ? editorEl.closest('.query-editor-wrapper') : null;
	if (!wrapper) return;
	const apply = () => {
		try {
			const editor = queryEditors[id];
			if (!editor) return;
			const contentHeight = Number(editor.getContentHeight?.() || 0);
			if (!Number.isFinite(contentHeight) || contentHeight <= 0) return;
			const visibleHeight = (element: any): number => {
				try {
					if (!element) return 0;
					const style = getComputedStyle(element);
					if (style.display === 'none') return 0;
					const height = Number(element.getBoundingClientRect?.().height || 0);
					const margin = (parseFloat(style.marginTop || '0') || 0) + (parseFloat(style.marginBottom || '0') || 0);
					return Math.max(0, Math.ceil(height + margin));
				} catch {
					return 0;
				}
			};
			let chrome = visibleHeight(wrapper.querySelector?.('.query-editor-toolbar'));
			try {
				const style = getComputedStyle(wrapper);
				chrome += (parseFloat(style.paddingTop || '0') || 0) + (parseFloat(style.paddingBottom || '0') || 0);
				chrome += (parseFloat(style.borderTopWidth || '0') || 0) + (parseFloat(style.borderBottomWidth || '0') || 0);
			} catch (e) { console.error('[kusto]', e); }
			let clipExtras = 0;
			try {
				const clip = editorEl.closest ? editorEl.closest('.qe-editor-clip') : null;
				for (const child of Array.from(clip?.children || []) as any[]) {
					if (child !== editorEl) clipExtras += visibleHeight(child);
				}
				if (clip) {
					const style = getComputedStyle(clip);
					clipExtras += (parseFloat(style.paddingTop || '0') || 0) + (parseFloat(style.paddingBottom || '0') || 0);
					clipExtras += (parseFloat(style.borderTopWidth || '0') || 0) + (parseFloat(style.borderBottomWidth || '0') || 0);
				}
			} catch (e) { console.error('[kusto]', e); }
			const desired = Math.max(120, Math.min(400, Math.ceil(chrome + clipExtras + contentHeight + 5)));
			wrapper.style.height = desired + 'px';
			wrapper.style.minHeight = '0';
			try {
				if (wrapper.dataset) {
					wrapper.dataset.kustoUserResized = 'true';
					delete wrapper.dataset.kustoAutoResized;
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				pState.manualQueryEditorHeightPxByBoxId ||= {};
				pState.manualQueryEditorHeightPxByBoxId[id] = desired;
			} catch (e) { console.error('[kusto]', e); }
			try { editor.layout?.(); } catch (e) { console.error('[kusto]', e); }
		} catch (e) { console.error('[kusto]', e); }
	};
	const applyAndPersist = () => {
		apply();
		try { persist(); } catch (e) { console.error('[kusto]', e); }
	};
	try {
		applyAndPersist();
		setTimeout(applyAndPersist, 50);
		setTimeout(applyAndPersist, 150);
	} catch (e) { console.error('[kusto]', e); }
}

// Auto-resize Monaco editor wrappers so the full content is visible (no inner scrollbars).
// This only applies while the wrapper has NOT been manually resized by the user.
// User resize is tracked via wrapper.dataset.kustoUserResized === 'true'.
export function __kustoAttachAutoResizeToContent(editor: any, containerEl: any) {
	try {
		if (!editor || !containerEl || !containerEl.closest) {
			return;
		}
		const wrapper = containerEl.closest('.query-editor-wrapper');
		if (!wrapper) {
			return;
		}

		const FIT_SLACK_PX = 5;
		const addVisibleRectHeight = (el: any) => {
			try {
				if (!el) return 0;
				try {
					const cs = getComputedStyle(el);
					if (cs && cs.display === 'none') return 0;
					const h = (el.getBoundingClientRect ? (el.getBoundingClientRect().height || 0) : 0);
					let margin = 0;
					try {
						margin += parseFloat(cs.marginTop || '0') || 0;
						margin += parseFloat(cs.marginBottom || '0') || 0;
					} catch (e) { console.error('[kusto]', e); }
					return Math.max(0, Math.ceil(h + margin));
				} catch (e) { console.error('[kusto]', e); }
				const h = (el.getBoundingClientRect ? (el.getBoundingClientRect().height || 0) : 0);
				return Math.max(0, Math.ceil(h));
			} catch {
				return 0;
			}
		};

		const apply = () => {
			try {
				if (wrapper.dataset && wrapper.dataset.kustoUserResized === 'true') {
					return;
				}
				// If this wrapper is in markdown preview mode, the editor is hidden and wrapper is auto.
				try {
					const box = wrapper.closest ? wrapper.closest('.query-box') : null;
					if (box && box.classList && box.classList.contains('is-md-preview')) {
						return;
					}
				} catch (e) { console.error('[kusto]', e); }

				// Skip auto-resize if Copilot chat is visible for this box.
				// The chat panel adds content that would cause the section to keep growing;
				// instead, we rely on internal scrolling within the chat.
				try {
					const box = wrapper.closest ? wrapper.closest('.query-box') : null;
					if (box && box.id) {
						const boxId = box.id.replace(/_box$/, '');
						const kwEl = _win.__kustoGetQuerySectionElement ? _win.__kustoGetQuerySectionElement(boxId) : null;
						if (kwEl && typeof kwEl.getCopilotChatVisible === 'function' && kwEl.getCopilotChatVisible()) {
							return;
						}
					}
				} catch (e) { console.error('[kusto]', e); }

				// Skip auto-resize if the editor content is blank (empty or whitespace-only).
				// This preserves the default height for newly created sections.
				try {
					const value = (typeof editor.getValue === 'function') ? editor.getValue() : '';
					if (!value || !value.trim()) {
						return;
					}
				} catch (e) { console.error('[kusto]', e); }

				const contentHeight = (typeof editor.getContentHeight === 'function') ? editor.getContentHeight() : 0;
				if (!contentHeight || !Number.isFinite(contentHeight) || contentHeight <= 0) {
					return;
				}

				// Wrapper total = fixed chrome (toolbars/resizers/banners) + Monaco content height.
				// IMPORTANT: Do NOT count the editor clip container height as chrome; it tracks the wrapper
				// height and causes a feedback loop (each resize makes the next one bigger).
				let chrome = 0;
				try {
					const csw = getComputedStyle(wrapper);
					chrome += (parseFloat(csw.paddingTop || '0') || 0) + (parseFloat(csw.paddingBottom || '0') || 0);
					chrome += (parseFloat(csw.borderTopWidth || '0') || 0) + (parseFloat(csw.borderBottomWidth || '0') || 0);
				} catch (e) { console.error('[kusto]', e); }

				let extras = 0;
				try {
					const clip = containerEl.closest('.qe-editor-clip');
					if (clip) {
						// Count wrapper children except the clip itself (toolbar, etc.).
						try {
							for (const child of Array.from(wrapper.children || [])) {
								if (!child || child === clip) continue;
								chrome += addVisibleRectHeight(child);
							}
						} catch (e) { console.error('[kusto]', e); }
						// Count visible clip children except the editor container (resizer, banners, placeholders).
						try {
							for (const child of Array.from(clip.children || [])) {
								if (!child || child === containerEl) continue;
								extras += addVisibleRectHeight(child);
							}
						} catch (e) { console.error('[kusto]', e); }
						// Clip padding/borders.
						try {
							const csc = getComputedStyle(clip);
							extras += (parseFloat(csc.paddingTop || '0') || 0) + (parseFloat(csc.paddingBottom || '0') || 0);
							extras += (parseFloat(csc.borderTopWidth || '0') || 0) + (parseFloat(csc.borderBottomWidth || '0') || 0);
						} catch (e) { console.error('[kusto]', e); }
					} else {
						// No clip (e.g. Python box): count wrapper children other than the editor container.
						try {
							for (const child of Array.from(wrapper.children || [])) {
								if (!child || child === containerEl) continue;
								chrome += addVisibleRectHeight(child);
							}
						} catch (e) { console.error('[kusto]', e); }
					}
				} catch (e) { console.error('[kusto]', e); }

				const next = Math.max(120, Math.min(750, Math.ceil(chrome + extras + contentHeight + FIT_SLACK_PX)));

				// Only grow — never shrink below the current wrapper height.
				// This prevents a jarring collapse when the user types a short query
				// (e.g. selects an autocomplete item on a fresh section with one line of content).
				const currentH = wrapper.getBoundingClientRect ? Math.ceil(wrapper.getBoundingClientRect().height || 0) : 0;
				if (next <= currentH) {
					return;
				}

				wrapper.style.height = next + 'px';
				try {
					if (wrapper.dataset) {
						wrapper.dataset.kustoAutoResized = 'true';
					}
				} catch (e) { console.error('[kusto]', e); }
				try {
					// Ensure Monaco re-layouts after the container changes.
					editor.layout();
				} catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
		};

		// Apply once soon, and then on every content size change.
		try {
			requestAnimationFrame(() => apply());
		} catch {
			setTimeout(() => apply(), 0);
		}
		try {
			if (typeof editor.onDidContentSizeChange === 'function') {
				editor.onDidContentSizeChange(() => apply());
			}
		} catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}
