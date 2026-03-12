// Monaco auto-resize — extracted from monaco.ts (Phase 6 decomposition).
// Resizes Monaco editor wrappers so full content is visible (no inner scrollbars).

const _win = window as unknown as Record<string, any>;
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
					} catch { /* ignore */ }
					return Math.max(0, Math.ceil(h + margin));
				} catch { /* ignore */ }
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
				} catch {
					// ignore
				}

				// Skip auto-resize if Copilot chat is visible for this box.
				// The chat panel adds content that would cause the section to keep growing;
				// instead, we rely on internal scrolling within the chat.
				try {
					const box = wrapper.closest ? wrapper.closest('.query-box') : null;
					if (box && box.id) {
						const boxId = box.id.replace(/_box$/, '');
						if (typeof _win.__kustoGetCopilotChatVisible === 'function' && _win.__kustoGetCopilotChatVisible(boxId)) {
							return;
						}
					}
				} catch {
					// ignore
				}

				// Skip auto-resize if the editor content is blank (empty or whitespace-only).
				// This preserves the default height for newly created sections.
				try {
					const value = (typeof editor.getValue === 'function') ? editor.getValue() : '';
					if (!value || !value.trim()) {
						return;
					}
				} catch {
					// ignore
				}

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
				} catch { /* ignore */ }

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
						} catch { /* ignore */ }
						// Count visible clip children except the editor container (resizer, banners, placeholders).
						try {
							for (const child of Array.from(clip.children || [])) {
								if (!child || child === containerEl) continue;
								extras += addVisibleRectHeight(child);
							}
						} catch { /* ignore */ }
						// Clip padding/borders.
						try {
							const csc = getComputedStyle(clip);
							extras += (parseFloat(csc.paddingTop || '0') || 0) + (parseFloat(csc.paddingBottom || '0') || 0);
							extras += (parseFloat(csc.borderTopWidth || '0') || 0) + (parseFloat(csc.borderBottomWidth || '0') || 0);
						} catch { /* ignore */ }
					} else {
						// No clip (e.g. Python box): count wrapper children other than the editor container.
						try {
							for (const child of Array.from(wrapper.children || [])) {
								if (!child || child === containerEl) continue;
								chrome += addVisibleRectHeight(child);
							}
						} catch { /* ignore */ }
					}
				} catch { /* ignore */ }

				const next = Math.max(120, Math.ceil(chrome + extras + contentHeight + FIT_SLACK_PX));
				wrapper.style.height = next + 'px';
				try {
					if (wrapper.dataset) {
						wrapper.dataset.kustoAutoResized = 'true';
					}
				} catch { /* ignore */ }
				try {
					// Ensure Monaco re-layouts after the container changes.
					editor.layout();
				} catch {
					// ignore
				}
			} catch {
				// ignore
			}
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
		} catch {
			// ignore
		}
	} catch {
		// ignore
	}
}

// ── Window bridges ──────────────────────────────────────────────────────────
(window as any).__kustoAttachAutoResizeToContent = __kustoAttachAutoResizeToContent;
