// Markdown box creation, Toast UI editor setup, markdown themes.
// Extracted from extraBoxes.ts (Phase 6 decomposition).

const _win = window as unknown as Record<string, any>;

// Access shared state from window (set by extraBoxes.ts).
// Initialize on window if not already present, so load order doesn't matter.
(window as any).__kustoMarkdownBoxes = (window as any).__kustoMarkdownBoxes || [];
let markdownBoxes: any[] = (window as any).__kustoMarkdownBoxes;
(window as any).__kustoMarkdownEditors = (window as any).__kustoMarkdownEditors || {};
let markdownEditors = (window as any).__kustoMarkdownEditors;
let markdownViewers: any = {};
(window as any).__kustoPythonEditors = (window as any).__kustoPythonEditors || {};
let pythonEditors: any = (window as any).__kustoPythonEditors;
export let __kustoPendingMarkdownRevealByBoxId: any = {};

export function __kustoTryApplyPendingMarkdownReveal( boxId: any) {
	try {
		const pending = __kustoPendingMarkdownRevealByBoxId && __kustoPendingMarkdownRevealByBoxId[boxId];
		if (!pending) {
			return;
		}
		try { delete __kustoPendingMarkdownRevealByBoxId[boxId]; } catch { /* ignore */ }
		try {
			if (typeof (window as any).__kustoRevealMarkdownRangeInBox === 'function') {
				(window as any).__kustoRevealMarkdownRangeInBox(boxId, pending);
			}
		} catch { /* ignore */ }
	} catch {
		// ignore
	}
}

// Called by main.js when the extension host asks us to reveal a range.
// For .md compatibility mode, there is exactly one markdown section; reveal in that first box.
try {
	if (typeof (window as any).__kustoRevealTextRangeFromHost !== 'function') {
		(window as any).__kustoRevealTextRangeFromHost = (message: any) => {
			try {
				const kind = String((window as any).__kustoDocumentKind || '');
				if (kind !== 'md') {
					return;
				}
				const start = message && message.start ? message.start : null;
				const end = message && message.end ? message.end : null;
				const sl = start && typeof start.line === 'number' ? start.line : 0;
				const sc = start && typeof start.character === 'number' ? start.character : 0;
				const el = end && typeof end.line === 'number' ? end.line : sl;
				const ec = end && typeof end.character === 'number' ? end.character : sc;
				const matchText = message && typeof message.matchText === 'string' ? String(message.matchText) : '';
				const startOffset = message && typeof message.startOffset === 'number' ? message.startOffset : undefined;
				const endOffset = message && typeof message.endOffset === 'number' ? message.endOffset : undefined;

				const boxId = (markdownBoxes && markdownBoxes.length) ? String(markdownBoxes[0] || '') : '';
				if (!boxId) {
					return;
				}
				const payload = { startLine: sl, startChar: sc, endLine: el, endChar: ec, matchText, startOffset, endOffset };
				const api = markdownEditors && markdownEditors[boxId] ? markdownEditors[boxId] : null;
				if (!api || !api._toastui) {
					try {
						if (typeof _win.vscode !== 'undefined' && _win.vscode && typeof (_win.vscode as any).postMessage === 'function') {
							(_win.vscode as any).postMessage({
								type: 'debugMdSearchReveal',
								phase: 'markdownReveal(queued)',
								detail: `${String((window as any).__kustoDocumentUri || '')} boxId=${boxId} ${sl}:${sc}-${el}:${ec} matchLen=${matchText ? matchText.length : 0}`
							});
						}
					} catch { /* ignore */ }
					__kustoPendingMarkdownRevealByBoxId[boxId] = payload;
					return;
				}
				try {
					if (typeof _win.vscode !== 'undefined' && _win.vscode && typeof (_win.vscode as any).postMessage === 'function') {
						(_win.vscode as any).postMessage({
							type: 'debugMdSearchReveal',
							phase: 'markdownReveal(apply)',
							detail: `${String((window as any).__kustoDocumentUri || '')} boxId=${boxId} ${sl}:${sc}-${el}:${ec} matchLen=${matchText ? matchText.length : 0}`
						});
					}
				} catch { /* ignore */ }
				if (typeof (window as any).__kustoRevealMarkdownRangeInBox === 'function') {
					(window as any).__kustoRevealMarkdownRangeInBox(boxId, payload);
				}
			} catch {
				// ignore
			}
		};
	}
} catch {
	// ignore
}

// Reveal a markdown range inside a specific markdown box, by switching to markdown mode
// (so line/character mapping is stable) and then using ToastUI's selection API.
try {
	if (typeof (window as any).__kustoRevealMarkdownRangeInBox !== 'function') {
		(window as any).__kustoRevealMarkdownRangeInBox = (boxId: any, payload: any) => {
			const id = String(boxId || '');
			if (!id) return;
			const sl = payload && typeof payload.startLine === 'number' ? payload.startLine : 0;
			const sc = payload && typeof payload.startChar === 'number' ? payload.startChar : 0;
			const el = payload && typeof payload.endLine === 'number' ? payload.endLine : sl;
			const ec = payload && typeof payload.endChar === 'number' ? payload.endChar : sc;
			const matchText = payload && typeof payload.matchText === 'string' ? String(payload.matchText) : '';
			const startOffset = payload && typeof payload.startOffset === 'number' ? payload.startOffset : undefined;
			const endOffset = payload && typeof payload.endOffset === 'number' ? payload.endOffset : undefined;
			const desiredUiMode = (typeof (window as any).__kustoGetMarkdownMode === 'function')
				? String((window as any).__kustoGetMarkdownMode(id) || 'wysiwyg')
				: 'wysiwyg';

			try {
				const boxEl = document.getElementById(id) as any;
				if (boxEl && typeof boxEl.scrollIntoView === 'function') {
					boxEl.scrollIntoView({ block: 'center' });
				}
			} catch { /* ignore */ }

			const api = markdownEditors && markdownEditors[id] ? markdownEditors[id] : null;
			const toast = api && api._toastui ? api._toastui : null;
			if (!toast || typeof toast.setSelection !== 'function' || typeof toast.changeMode !== 'function') {
				__kustoPendingMarkdownRevealByBoxId[id] = { startLine: sl, startChar: sc, endLine: el, endChar: ec, matchText, startOffset, endOffset };
				return;
			}

			// IMPORTANT:
			// - In markdown mode, ToastUI selection takes [line, char].
			// - In WYSIWYG mode, ToastUI selection takes ProseMirror positions (numbers).
			// ToastUI provides convertPosToMatchEditorMode() which can convert a markdown position
			// into the corresponding WYSIWYG ProseMirror position.
			// Prefer a stable, mode-agnostic strategy:
			// - Find the match text in the editor's markdown content.
			// - Use the host-provided offsets to pick the correct occurrence.
			// - Convert to the appropriate selection coordinates for the current mode.
			const mdText = (() => {
				try {
					if (typeof toast.getMarkdown === 'function') {
						return String(toast.getMarkdown() || '');
					}
				} catch { /* ignore */ }
				try {
					if (typeof api.getValue === 'function') {
						return String(api.getValue() || '');
					}
				} catch { /* ignore */ }
				return '';
			})();

			const findText = (matchText && matchText.trim()) ? matchText : '';
			const computeLineChar1Based = (text: any, offset0: any) => {
				try {
					const t = String(text || '');
					const off = Math.max(0, Math.min(t.length, Math.floor(offset0)));
					const before = t.slice(0, off);
					const line = before.split('\n').length; // 1-based
					const lastNl = before.lastIndexOf('\n');
					const ch = off - (lastNl >= 0 ? (lastNl + 1) : 0) + 1; // 1-based
					return [Math.max(1, line), Math.max(1, ch)];
				} catch {
					return [1, 1];
				}
			};

			const computeOccurrenceIndex = (text: any, needle: any, atIndex: any) => {
				try {
					if (!needle) return 0;
					let occ = 0;
					let i = 0;
					while (true) {
						const next = text.indexOf(needle, i);
						if (next < 0 || next >= atIndex) break;
						occ++;
						i = next + Math.max(1, needle.length);
					}
					return occ;
				} catch {
					return 0;
				}
			};

			let foundStart = 0;
			let foundEnd = 0;
			let occurrence = 0;
			if (findText) {
				const preferred = (typeof startOffset === 'number' && Number.isFinite(startOffset)) ? Math.max(0, Math.floor(startOffset)) : undefined;
				let idx = -1;
				try {
					if (typeof preferred === 'number' && mdText.startsWith(findText, preferred)) {
						idx = preferred;
					} else if (typeof preferred === 'number') {
						const forward = mdText.indexOf(findText, preferred);
						const back = mdText.lastIndexOf(findText, preferred);
						if (forward < 0) {
							idx = back;
						} else if (back < 0) {
							idx = forward;
						} else {
							idx = (Math.abs(forward - preferred) <= Math.abs(preferred - back)) ? forward : back;
						}
					} else {
						idx = mdText.indexOf(findText);
					}
				} catch {
					idx = -1;
				}
			}

			// Hoist mdStart/mdEnd so both applySelectionNow and applySelectionInDesiredMode can see them.
			const mdStart: any = (findText && foundEnd > foundStart)
				? computeLineChar1Based(mdText, foundStart)
				: (payload.__kustoMdStartFallback || [Math.max(1, sl + 1), Math.max(1, sc + 1)]);
			const mdEnd: any = (findText && foundEnd > foundStart)
				? computeLineChar1Based(mdText, foundEnd)
				: (payload.__kustoMdEndFallback || [Math.max(1, el + 1), Math.max(1, ec + 1)]);

			const applySelectionNow = () => {
				// If we're in preview mode, highlight + scroll using the rendered DOM.
				if (desiredUiMode === 'preview') {
					try {
						const viewerHost = document.getElementById(id + '_md_viewer') as any;
						if (!viewerHost) return;
						if (!findText) return;
						const selectInPreviewByOccurrence = () => {
							try {
								const root = viewerHost;
								const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
								let seen = 0;
								while (walker.nextNode()) {
									const n = walker.currentNode;
									const text = n && typeof n.nodeValue === 'string' ? n.nodeValue : '';
									if (!text) continue;
									let i = 0;
									while (true) {
										const at = text.indexOf(findText, i);
										if (at < 0) break;
										if (seen === occurrence) {
											const range = document.createRange();
											range.setStart(n, at);
											range.setEnd(n, at + findText.length);
											try {
												const sel = window.getSelection && window.getSelection();
												if (sel) {
													sel.removeAllRanges();
													sel.addRange(range);
												}
											} catch { /* ignore */ }
											try {
												const el2 = range.startContainer && range.startContainer.parentElement ? range.startContainer.parentElement : null;
												if (el2 && typeof el2.scrollIntoView === 'function') {
													el2.scrollIntoView({ block: 'center' });
												}
											} catch { /* ignore */ }
											return true;
										}
										seen++;
										i = at + Math.max(1, findText.length);
									}
								}
							} catch {
								// ignore
							}
							return false;
						};
						setTimeout(() => {
							const ok = selectInPreviewByOccurrence();
							if (!ok) {
								try { (window as any).find && (window as any).find(findText); } catch { /* ignore */ }
							}
						}, 0);
					} catch { /* ignore */ }
					return;
				}

				// Editor modes: keep the current mode; apply selection in a mode-appropriate way.
				// (mdStart/mdEnd hoisted to outer scope)

				try {
					if (desiredUiMode === 'wysiwyg') {
						let from = 0;
						let to = 0;
						try {
							if (typeof toast.convertPosToMatchEditorMode === 'function') {
								const converted = toast.convertPosToMatchEditorMode(mdStart, mdEnd, 'wysiwyg');
								if (converted && typeof converted[0] === 'number' && typeof converted[1] === 'number') {
									from = converted[0];
									to = converted[1];
								}
							}
						} catch { /* ignore */ }
						try { toast.setSelection(from, to); } catch { /* ignore */ }
					} else {
						try { toast.setSelection(mdStart, mdEnd); } catch { /* ignore */ }
					}
				} catch { /* ignore */ }
				try { if (typeof toast.focus === 'function') toast.focus(); } catch { /* ignore */ }
			};

			// Apply now, and retry a couple times in case the editor is still settling.
			try {
				applySelectionNow();
				setTimeout(applySelectionNow, 50);
				setTimeout(applySelectionNow, 150);
			} catch { /* ignore */ }
			const applySelectionInDesiredMode = () => {
				const mode = (desiredUiMode === 'markdown' || desiredUiMode === 'wysiwyg') ? desiredUiMode : 'wysiwyg';
				try { toast.changeMode(mode, true); } catch { /* ignore */ }
				try {
					setTimeout(() => {
						try {
							if (mode === 'wysiwyg') {
								let from = 0;
								let to = 0;
								try {
									if (typeof toast.convertPosToMatchEditorMode === 'function') {
										const converted = toast.convertPosToMatchEditorMode(mdStart, mdEnd, 'wysiwyg');
										if (converted && typeof converted[0] === 'number' && typeof converted[1] === 'number') {
											from = converted[0];
											to = converted[1];
										}
									}
								} catch { /* ignore */ }
								try { toast.setSelection(from, to); } catch { /* ignore */ }
							} else {
								try { toast.setSelection(mdStart, mdEnd); } catch { /* ignore */ }
							}
						} catch { /* ignore */ }
						try { if (typeof toast.focus === 'function') toast.focus(); } catch { /* ignore */ }
					}, 0);
				} catch { /* ignore */ }
			};

			try {
				// Ensure we are not in preview mode; preview hides the editor surface.
				if (desiredUiMode === 'preview' && typeof (window as any).__kustoSetMarkdownMode === 'function') {
					(window as any).__kustoSetMarkdownMode(id, 'wysiwyg');
				}
			} catch { /* ignore */ }
			applySelectionInDesiredMode();
		};
	}
} catch {
	// ignore
}

let toastUiThemeObserverStarted = false;
let lastAppliedToastUiIsDarkTheme: any = null;

let markdownMarkedResolvePromise: any = null;

export function __kustoIsDarkTheme() {
	// Prefer the body classes VS Code toggles on theme change.
	try {
		const cls = document && document.body && document.body.classList;
		if (cls) {
			if (cls.contains('vscode-light') || cls.contains('vscode-high-contrast-light')) {
				return false;
			}
			if (cls.contains('vscode-dark') || cls.contains('vscode-high-contrast')) {
				return true;
			}
		}
	} catch {
		// ignore
	}

	// Fall back to luminance of the editor background.
	const parseCssColorToRgb = (value: any) => {
		const v = String(value || '').trim();
		if (!v) return null;
		let m = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
		if (m) {
			return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) };
		}
		m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
		if (m) {
			const hex = m[1];
			if (hex.length === 3) {
				const r = parseInt(hex[0] + hex[0], 16);
				const g = parseInt(hex[1] + hex[1], 16);
				const b = parseInt(hex[2] + hex[2], 16);
				return { r, g, b };
			}
			const r = parseInt(hex.slice(0, 2), 16);
			const g = parseInt(hex.slice(2, 4), 16);
			const b = parseInt(hex.slice(4, 6), 16);
			return { r, g, b };
		}
		return null;
	};

	let bg = '';
	try {
		bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
		if (!bg) {
			bg = getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background').trim();
		}
	} catch {
		bg = '';
	}
	const rgb = parseCssColorToRgb(bg);
	if (!rgb) {
		return true;
	}
	const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
	return luminance < 0.5;
}

export function __kustoApplyToastUiThemeToHost( hostEl: any, isDark: any) {
	if (!hostEl || !hostEl.querySelectorAll) {
		return;
	}
	try {
		const roots = hostEl.querySelectorAll('.toastui-editor-defaultUI');
		for (const el of roots) {
			try {
				if (el && el.classList) {
					el.classList.toggle('toastui-editor-dark', !!isDark);
				}
			} catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
}

export function __kustoApplyToastUiThemeAll() {
	let isDark = true;
	try { isDark = __kustoIsDarkTheme(); } catch { isDark = true; }
	if (lastAppliedToastUiIsDarkTheme === isDark) {
		return;
	}
	lastAppliedToastUiIsDarkTheme = isDark;

	try {
		for (const boxId of markdownBoxes || []) {
			const editorHost = document.getElementById(String(boxId) + '_md_editor');
			const viewerHost = document.getElementById(String(boxId) + '_md_viewer');
			__kustoApplyToastUiThemeToHost(editorHost, isDark);
			__kustoApplyToastUiThemeToHost(viewerHost, isDark);
		}
	} catch {
		// ignore
	}
}

export function __kustoStartToastUiThemeObserver() {
	if (toastUiThemeObserverStarted) {
		return;
	}
	toastUiThemeObserverStarted = true;

	// Apply once now.
	try { __kustoApplyToastUiThemeAll(); } catch { /* ignore */ }

	let pending = false;
	const schedule = () => {
		if (pending) return;
		pending = true;
		setTimeout(() => {
			pending = false;
			try { __kustoApplyToastUiThemeAll(); } catch { /* ignore */ }
		}, 0);
	};

	try {
		const observer = new MutationObserver(() => schedule());
		if (document && document.body) {
			observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
		}
		if (document && document.documentElement) {
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
		}
	} catch {
		// ignore
	}
}

export function __kustoMaximizeMarkdownBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const editorHost = document.getElementById(id + '_md_editor') as any;
	const viewerHost = document.getElementById(id + '_md_viewer') as any;
	const wrapper = editorHost && editorHost.closest ? editorHost.closest('.query-editor-wrapper') : null;
	if (!wrapper) return;
	const FIT_SLACK_PX = 5;

	const tryComputeDesiredWrapperHeight = (mode: any) => {
		try {
			const container = editorHost;
			const ui = container && container.querySelector ? container.querySelector('.toastui-editor-defaultUI') : null;
			if (!ui) return undefined;
			const toolbar = ui.querySelector('.toastui-editor-defaultUI-toolbar');
			const toolbarH = toolbar && toolbar.getBoundingClientRect ? toolbar.getBoundingClientRect().height : 0;

			let contentH = 0;
			const m = String(mode || '').toLowerCase();
			if (m === 'wysiwyg') {
				// IMPORTANT: measure intrinsic content height, not a scroll container's scrollHeight.
				// scrollHeight is >= clientHeight, which prevents shrinking when the wrapper is oversized.
				const prose = ui.querySelector('.toastui-editor-ww-container .ProseMirror');
				if (prose) {
					try {
						// Preferred: compute from layout offsets so the result is NOT affected by the
						// current scroll position or viewport size.
						let minTop = Infinity;
						let maxBottom = 0;
						const kids = prose.children ? Array.from(prose.children) as any[] : [];
						for (const child of kids) {
							try {
								if (!child || child.nodeType !== 1) continue;
								const top = (typeof child.offsetTop === 'number') ? child.offsetTop : 0;
								const h = (typeof child.offsetHeight === 'number') ? child.offsetHeight : 0;
								let mt = 0;
								let mb = 0;
								try {
									const cs = getComputedStyle(child);
									mt = parseFloat(cs.marginTop || '0') || 0;
									mb = parseFloat(cs.marginBottom || '0') || 0;
								} catch { /* ignore */ }
								minTop = Math.min(minTop, Math.max(0, top - mt));
								maxBottom = Math.max(maxBottom, Math.max(0, top + h + mb));
							} catch { /* ignore */ }
						}
						let docH = 0;
						if (Number.isFinite(minTop) && maxBottom > minTop) {
							docH = Math.max(0, maxBottom - minTop);
						}
						try {
							const cs = getComputedStyle(prose);
							docH += (parseFloat(cs.paddingTop || '0') || 0) + (parseFloat(cs.paddingBottom || '0') || 0);
						} catch { /* ignore */ }
						if (docH && Number.isFinite(docH)) {
							contentH = Math.max(contentH, Math.ceil(docH));
						}
					} catch { /* ignore */ }
					// Fallback: only use scrollHeight if it actually indicates overflow content;
					// otherwise it will just mirror the viewport height and create a feedback loop.
					if (!contentH) {
						try {
							if (typeof prose.scrollHeight === 'number' && typeof prose.clientHeight === 'number') {
								if (prose.scrollHeight > prose.clientHeight + 1) {
									contentH = Math.max(contentH, prose.scrollHeight);
								}
							}
						} catch { /* ignore */ }
					}
				}
				// Fallback: if ProseMirror isn't found, use any contents node's scrollHeight.
				if (!contentH) {
					const wwContents = ui.querySelector('.toastui-editor-ww-container .toastui-editor-contents');
					if (wwContents && typeof wwContents.scrollHeight === 'number' && typeof wwContents.clientHeight === 'number') {
						if (wwContents.scrollHeight > wwContents.clientHeight + 1) {
							contentH = Math.max(contentH, wwContents.scrollHeight);
						}
					}
				}
			} else {
				// Markdown mode uses CodeMirror.
				// Prefer the sizer height (intrinsic document height) so Fit can shrink.
				const cmSizer = ui.querySelector('.toastui-editor-md-container .CodeMirror .CodeMirror-sizer');
				if (cmSizer) {
					try {
						const oh = (typeof cmSizer.offsetHeight === 'number') ? cmSizer.offsetHeight : 0;
						if (oh && Number.isFinite(oh)) contentH = Math.max(contentH, oh);
					} catch { /* ignore */ }
					try {
						const rh = cmSizer.getBoundingClientRect ? (cmSizer.getBoundingClientRect().height || 0) : 0;
						if (rh && Number.isFinite(rh)) contentH = Math.max(contentH, rh);
					} catch { /* ignore */ }
				}
				// Fallback to scrollHeight if the sizer isn't available.
				if (!contentH) {
					const cmScroll = ui.querySelector('.toastui-editor-md-container .CodeMirror .CodeMirror-scroll');
					if (cmScroll && typeof cmScroll.scrollHeight === 'number') {
						contentH = Math.max(contentH, cmScroll.scrollHeight);
					}
				}
				// Fallback: any visible contents area.
				const mdContents = ui.querySelector('.toastui-editor-md-container .toastui-editor-contents');
				if (mdContents && typeof mdContents.scrollHeight === 'number') {
					contentH = Math.max(contentH, mdContents.scrollHeight);
				}
			}
			// Last-ditch fallback (may include hidden containers, so keep it last).
			if (!contentH) {
				const anyContents = ui.querySelector('.toastui-editor-contents');
				if (anyContents && typeof anyContents.scrollHeight === 'number') {
					contentH = Math.max(contentH, anyContents.scrollHeight);
				}
			}
			if (!contentH) return undefined;

			const resizerH = 12;
			// Reduced by 30px to account for removed top padding in preview mode CSS, plus mode-specific adjustments
			const padding = (m === 'wysiwyg') ? -1 : 13; // WYSIWYG: -7+6, Markdown: -7+20
			const minH = 120;
			return Math.max(minH, Math.ceil(toolbarH + contentH + resizerH + padding + FIT_SLACK_PX));
		} catch {
			return undefined;
		}
	};

	const mode = __kustoGetMarkdownMode(id);
	if (mode === 'preview') {
		// Max for preview is the full rendered content: use auto-expand.
		try {
			wrapper.style.height = '';
			if (wrapper.dataset) {
				try { delete wrapper.dataset.kustoUserResized; } catch { /* ignore */ }
				try { delete wrapper.dataset.kustoPrevHeightMd; } catch { /* ignore */ }
			}
		} catch { /* ignore */ }
		try { __kustoUpdateMarkdownPreviewSizing(id); } catch { /* ignore */ }
		try {
			// Ensure viewer is up-to-date before measuring/laying out.
			if (viewerHost && viewerHost.style && viewerHost.style.display !== 'none') {
				const md = markdownEditors && markdownEditors[id] ? String(markdownEditors[id].getValue() || '') : '';
				initMarkdownViewer(id, md);
			}
		} catch { /* ignore */ }
		try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
		return;
	}

	// Markdown/WYSIWYG: max is the editing cap.
	const modeForMeasure = (() => {
		try { return __kustoGetMarkdownMode(id); } catch { return 'wysiwyg'; }
	})();
	const applyOnce = () => {
		try {
			// No max cap for markdown/wysiwyg: grow to fit the current content.
			const desired = tryComputeDesiredWrapperHeight(modeForMeasure);
			if (typeof desired === 'number' && Number.isFinite(desired) && desired > 0) {
				wrapper.style.height = Math.round(desired) + 'px';
			} else {
				// Fallback: if we can't measure, do not change height (avoid runaway growth).
				return;
			}
		} catch { /* ignore */ }
		try {
			const ed = markdownEditors && markdownEditors[id] ? markdownEditors[id] : null;
			if (ed && typeof ed.layout === 'function') {
				ed.layout();
			}
		} catch { /* ignore */ }
	};
	// WYSIWYG layout/scrollHeight can settle a tick later; retry a few times.
	try {
		applyOnce();
		setTimeout(applyOnce, 50);
		setTimeout(applyOnce, 150);
		setTimeout(applyOnce, 350);
	} catch { /* ignore */ }
	try { if (wrapper.dataset) wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

export function __kustoAutoExpandMarkdownBoxToContent( boxId: any) {
	try {
		if (String((window as any).__kustoDocumentKind || '') !== 'md') {
			return;
		}
		const id = String(boxId || '').trim();
		if (!id) return;
		const editorHost = document.getElementById(id + '_md_editor') as any;
		const wrapper = editorHost && editorHost.closest ? editorHost.closest('.query-editor-wrapper') : null;
		if (!wrapper) return;

		const computeDesired = () => {
			try {
				const ui = editorHost.querySelector ? editorHost.querySelector('.toastui-editor-defaultUI') : null;
				if (!ui) return undefined;
				const toolbar = ui.querySelector('.toastui-editor-defaultUI-toolbar');
				const toolbarH = toolbar && toolbar.getBoundingClientRect ? toolbar.getBoundingClientRect().height : 0;
				const mode = (typeof __kustoGetMarkdownMode === 'function') ? String(__kustoGetMarkdownMode(id) || '') : 'wysiwyg';
				let contentH = 0;
				if (mode === 'wysiwyg') {
					const prose = ui.querySelector('.toastui-editor-ww-container .ProseMirror');
					if (prose) {
						try {
							const r = prose.getBoundingClientRect ? prose.getBoundingClientRect() : null;
							const top = r ? (r.top || 0) : 0;
							let maxBottom = 0;
							const kids = prose.children ? Array.from(prose.children) as any[] : [];
							for (const child of kids) {
								try {
									const cr = child.getBoundingClientRect ? child.getBoundingClientRect() : null;
									const b = cr ? (cr.bottom || 0) : 0;
									if (b && Number.isFinite(b)) maxBottom = Math.max(maxBottom, b);
								} catch { /* ignore */ }
							}
							let docH = 0;
							if (maxBottom > top) {
								docH = Math.max(0, maxBottom - top);
							}
							try {
								const cs = getComputedStyle(prose);
								docH += (parseFloat(cs.paddingTop || '0') || 0) + (parseFloat(cs.paddingBottom || '0') || 0);
							} catch { /* ignore */ }
							if (docH && Number.isFinite(docH)) {
								contentH = Math.max(contentH, Math.ceil(docH));
							}
						} catch { /* ignore */ }
						if (!contentH) {
							try {
								if (typeof prose.scrollHeight === 'number') {
									contentH = Math.max(contentH, prose.scrollHeight);
								}
							} catch { /* ignore */ }
						}
					}
					if (!contentH) {
						const wwContents = ui.querySelector('.toastui-editor-ww-container .toastui-editor-contents');
						if (wwContents && typeof wwContents.scrollHeight === 'number') {
							contentH = Math.max(contentH, wwContents.scrollHeight);
						}
					}
				} else if (mode === 'markdown') {
					const cmSizer = ui.querySelector('.toastui-editor-md-container .CodeMirror .CodeMirror-sizer');
					if (cmSizer) {
						try {
							const oh = (typeof cmSizer.offsetHeight === 'number') ? cmSizer.offsetHeight : 0;
							if (oh && Number.isFinite(oh)) contentH = Math.max(contentH, oh);
						} catch { /* ignore */ }
						try {
							const rh = cmSizer.getBoundingClientRect ? (cmSizer.getBoundingClientRect().height || 0) : 0;
							if (rh && Number.isFinite(rh)) contentH = Math.max(contentH, rh);
						} catch { /* ignore */ }
					}
					if (!contentH) {
						const cmScroll = ui.querySelector('.toastui-editor-md-container .CodeMirror .CodeMirror-scroll');
						if (cmScroll && typeof cmScroll.scrollHeight === 'number') {
							contentH = Math.max(contentH, cmScroll.scrollHeight);
						}
					}
					const mdContents = ui.querySelector('.toastui-editor-md-container .toastui-editor-contents');
					if (mdContents && typeof mdContents.scrollHeight === 'number') {
						contentH = Math.max(contentH, mdContents.scrollHeight);
					}
				}
				if (!contentH) {
					const anyContents = ui.querySelector('.toastui-editor-contents');
					if (anyContents && typeof anyContents.scrollHeight === 'number') {
						contentH = Math.max(contentH, anyContents.scrollHeight);
					}
				}
				if (!contentH) return undefined;
				const padding = 18;
				return Math.max(120, Math.ceil(toolbarH + contentH + padding));
			} catch {
				return undefined;
			}
		};

		const apply = () => {
			try {
				const desired = computeDesired();
				if (typeof desired === 'number' && Number.isFinite(desired) && desired > 0) {
					wrapper.style.height = Math.round(desired) + 'px';
					// Do NOT mark user resized; this is automatic.
					try {
						const ed = markdownEditors && markdownEditors[id] ? markdownEditors[id] : null;
						if (ed && typeof ed.layout === 'function') {
							ed.layout();
						}
					} catch { /* ignore */ }
				}
			} catch { /* ignore */ }
		};

		apply();
		setTimeout(apply, 50);
		setTimeout(apply, 150);
		setTimeout(apply, 350);
	} catch {
		// ignore
	}
}

export function __kustoScheduleMdAutoExpand( boxId: any) {
	try {
		if (String((window as any).__kustoDocumentKind || '') !== 'md') {
			return;
		}
		const id = String(boxId || '').trim();
		if (!id) return;
		(window as any).__kustoMdAutoExpandTimersByBoxId = (window as any).__kustoMdAutoExpandTimersByBoxId || {};
		const map = (window as any).__kustoMdAutoExpandTimersByBoxId;
		if (map[id]) {
			try { clearTimeout(map[id]); } catch { /* ignore */ }
		}
		map[id] = setTimeout(() => {
			try { __kustoAutoExpandMarkdownBoxToContent(id); } catch { /* ignore */ }
		}, 80);
	} catch {
		// ignore
	}
}

export function __kustoMaximizePythonBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const editorEl = document.getElementById(id + '_py_editor') as any;
	const wrapper = editorEl && editorEl.closest ? editorEl.closest('.query-editor-wrapper') : null;
	if (!wrapper) return;
	const applyFitToContent = () => {
		try {
			const ed = (typeof pythonEditors === 'object' && pythonEditors) ? pythonEditors[id] : null;
			if (!ed) return;

			// IMPORTANT: use content height, not scroll height.
			// Monaco's getScrollHeight is often >= the viewport height, which prevents shrinking.
			let contentHeight = 0;
			try {
				const ch = (typeof ed.getContentHeight === 'function') ? ed.getContentHeight() : 0;
				if (ch && Number.isFinite(ch)) contentHeight = Math.max(contentHeight, ch);
			} catch { /* ignore */ }
			if (!contentHeight || !Number.isFinite(contentHeight) || contentHeight <= 0) return;

			let chrome = 0;
			try {
				for (const child of Array.from(wrapper.children || []) as any[]) {
					if (!child || child === editorEl) continue;
					try {
						const cs = getComputedStyle(child);
						if (cs && cs.display === 'none') continue;
					} catch { /* ignore */ }
					chrome += (child.getBoundingClientRect ? (child.getBoundingClientRect().height || 0) : 0);
				}
			} catch { /* ignore */ }
			try {
				const csw = getComputedStyle(wrapper);
				chrome += (parseFloat(csw.paddingTop || '0') || 0) + (parseFloat(csw.paddingBottom || '0') || 0);
				chrome += (parseFloat(csw.borderTopWidth || '0') || 0) + (parseFloat(csw.borderBottomWidth || '0') || 0);
			} catch { /* ignore */ }

			const desired = Math.max(120, Math.min(20000, Math.ceil(chrome + contentHeight)));
			try {
				wrapper.style.height = desired + 'px';
				wrapper.style.minHeight = '0';
			} catch { /* ignore */ }
			try { if (wrapper.dataset) wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
			try { if (typeof ed.layout === 'function') ed.layout(); } catch { /* ignore */ }
		} catch { /* ignore */ }
	};

	try {
		applyFitToContent();
		setTimeout(applyFitToContent, 50);
		setTimeout(applyFitToContent, 150);
	} catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

export function __kustoEnsureMarkdownModeMap() {
	try {
		if (!(window as any).__kustoMarkdownModeByBoxId || typeof (window as any).__kustoMarkdownModeByBoxId !== 'object') {
			(window as any).__kustoMarkdownModeByBoxId = {};
		}
	} catch {
		// ignore
	}
	return (window as any).__kustoMarkdownModeByBoxId;
}

export function __kustoGetMarkdownMode( boxId: any) {
	try {
		const map = __kustoEnsureMarkdownModeMap();
		const v = map && boxId ? String(map[boxId] || '') : '';
		if (v === 'preview' || v === 'markdown' || v === 'wysiwyg') {
			return v;
		}
	} catch {
		// ignore
	}
	return 'wysiwyg';
}

export function __kustoSetMarkdownMode( boxId: any, mode: any) {
	const m = (String(mode || '').toLowerCase() === 'preview')
		? 'preview'
		: (String(mode || '').toLowerCase() === 'markdown')
			? 'markdown'
			: 'wysiwyg';
	try {
		const map = __kustoEnsureMarkdownModeMap();
		map[boxId] = m;
	} catch {
		// ignore
	}
	try { __kustoApplyMarkdownEditorMode(boxId); } catch { /* ignore */ }
	try { __kustoScheduleMdAutoExpand(boxId); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

export function __kustoUpdateMarkdownModeButtons( boxId: any) {
	const mode = __kustoGetMarkdownMode(boxId);
	const ids: any = {
		preview: boxId + '_md_mode_preview',
		markdown: boxId + '_md_mode_markdown',
		wysiwyg: boxId + '_md_mode_wysiwyg'
	};
	for (const key of Object.keys(ids)) {
		const btn = document.getElementById(ids[key]) as any;
		if (!btn) continue;
		const active = key === mode;
		try { btn.classList.toggle('is-active', active); } catch { /* ignore */ }
		try { btn.setAttribute('aria-selected', active ? 'true' : 'false'); } catch { /* ignore */ }
	}
	// Update the dropdown text for narrow widths
	try {
		const dropdownText = document.getElementById(boxId + '_md_mode_dropdown_text') as any;
		if (dropdownText) {
			const labels = { wysiwyg: 'WYSIWYG', markdown: 'Markdown', preview: 'Preview' };
			dropdownText.textContent = labels[mode] || 'Mode';
		}
	} catch { /* ignore */ }
}

// Toggle the markdown mode dropdown menu visibility
export function __kustoToggleMdModeDropdown( boxId: any, ev: any) {
	try {
		// Stop propagation to prevent the document click handler from closing the menu
		if (ev && typeof ev.stopPropagation === 'function') {
			ev.stopPropagation();
		}
		const menu = document.getElementById(boxId + '_md_mode_dropdown_menu') as any;
		const btn = document.getElementById(boxId + '_md_mode_dropdown_btn') as any;
		if (!menu || !btn) return;
		const isOpen = menu.style.display !== 'none';
		// Close all other dropdowns first
		try { (window as any).__kustoDropdown && (window as any).__kustoDropdown.closeAllMenus(); } catch { /* ignore */ }
		if (isOpen) {
			menu.style.display = 'none';
			btn.setAttribute('aria-expanded', 'false');
		} else {
			menu.style.display = 'block';
			btn.setAttribute('aria-expanded', 'true');
		}
	} catch { /* ignore */ }
}

// Close the markdown mode dropdown menu
export function __kustoCloseMdModeDropdown( boxId: any) {
	try {
		const menu = document.getElementById(boxId + '_md_mode_dropdown_menu') as any;
		const btn = document.getElementById(boxId + '_md_mode_dropdown_btn') as any;
		if (menu) menu.style.display = 'none';
		if (btn) btn.setAttribute('aria-expanded', 'false');
	} catch { /* ignore */ }
}

// Close all md-mode dropdowns when clicking outside
try {
	document.addEventListener('click', (ev: any) => {
		try {
			const target = ev.target;
			if (!target) return;
			// Check if the click was inside any md-mode dropdown
			const inDropdown = target.closest && target.closest('.md-mode-dropdown');
			if (!inDropdown) {
				// Close all md-mode dropdown menus
				const menus = document.querySelectorAll('.md-mode-dropdown-menu');
				const btns = document.querySelectorAll('.md-mode-dropdown-btn');
				for (const m of menus as any) {
					try { m.style.display = 'none'; } catch { /* ignore */ }
				}
				for (const b of btns) {
					try { b.setAttribute('aria-expanded', 'false'); } catch { /* ignore */ }
				}
			}
		} catch { /* ignore */ }
	});
} catch { /* ignore */ }

// Width thresholds for responsive mode buttons
const __kustoMdModeNarrowThreshold = 450;
const __kustoMdModeVeryNarrowThreshold = 250;

// Track ResizeObservers for markdown sections
const __kustoMdModeResizeObservers: any = {};

// Check if a markdown section should show the dropdown vs buttons
export function __kustoUpdateMdModeResponsive( boxId: any) {
	try {
		const box = document.getElementById(boxId) as any;
		if (!box) return;
		const width = box.offsetWidth || 0;
		const isNarrow = width > 0 && width < __kustoMdModeNarrowThreshold;
		const isVeryNarrow = width > 0 && width < __kustoMdModeVeryNarrowThreshold;
		box.classList.toggle('is-md-narrow', isNarrow);
		box.classList.toggle('is-md-very-narrow', isVeryNarrow);
	} catch { /* ignore */ }
}

// Set up ResizeObserver for a markdown section to handle responsive mode buttons
export function __kustoSetupMdModeResizeObserver( boxId: any) {
	try {
		if (__kustoMdModeResizeObservers[boxId]) return; // Already set up
		const box = document.getElementById(boxId) as any;
		if (!box) return;
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(() => {
			try { __kustoUpdateMdModeResponsive(boxId); } catch { /* ignore */ }
		});
		observer.observe(box);
		__kustoMdModeResizeObservers[boxId] = observer;
		// Initial check
		__kustoUpdateMdModeResponsive(boxId);
	} catch { /* ignore */ }
}

// Clean up ResizeObserver when a markdown section is removed
export function __kustoCleanupMdModeResizeObserver( boxId: any) {
	try {
		const observer = __kustoMdModeResizeObservers[boxId];
		if (observer && typeof observer.disconnect === 'function') {
			observer.disconnect();
		}
		delete __kustoMdModeResizeObservers[boxId];
	} catch { /* ignore */ }
}

// ============================================================================
// Generic section mode dropdown (for Chart and Transformation sections)
// ============================================================================

// Toggle the section mode dropdown menu visibility

export function __kustoUpdateMarkdownPreviewSizing( boxId: any) {
	const box = document.getElementById(boxId) as any;
	const editorHost = document.getElementById(boxId + '_md_editor') as any;
	if (!box || !editorHost) {
		return;
	}
	const mode = __kustoGetMarkdownMode(boxId);
	if (mode !== 'preview') {
		try { box.classList.remove('is-md-preview-auto'); } catch { /* ignore */ }
		try { box.classList.remove('is-md-preview-fixed'); } catch { /* ignore */ }
		return;
	}
	let wrapper = null;
	try {
		wrapper = editorHost.closest ? editorHost.closest('.query-editor-wrapper') : null;
	} catch {
		wrapper = null;
	}
	if (!wrapper) {
		return;
	}

	let userResized = false;
	let hasInlinePx = false;
	try {
		userResized = !!(wrapper.dataset && wrapper.dataset.kustoUserResized === 'true');
	} catch { /* ignore */ }
	try {
		const h = String(wrapper.style && wrapper.style.height ? wrapper.style.height : '').trim();
		hasInlinePx = /^\d+px$/i.test(h);
	} catch { /* ignore */ }

	// Treat an explicit inline px height as a fixed size (even if dataset isn't set yet).
	const fixed = userResized || hasInlinePx;
	try { box.classList.toggle('is-md-preview-fixed', fixed); } catch { /* ignore */ }
	try { box.classList.toggle('is-md-preview-auto', !fixed); } catch { /* ignore */ }
}

export function __kustoApplyMarkdownEditorMode( boxId: any) {
	__kustoUpdateMarkdownModeButtons(boxId);

	const box = document.getElementById(boxId) as any;
	const editorHost = document.getElementById(boxId + '_md_editor') as any;
	const viewerHost = document.getElementById(boxId + '_md_viewer') as any;
	if (!box || !editorHost || !viewerHost) {
		return;
	}

	const mode = __kustoGetMarkdownMode(boxId);
	const isPreview = mode === 'preview';

	// Preview sizing behavior:
	// - if user has resized (or we have an explicit px height), keep it fixed and make the viewer scroll
	// - otherwise, clear inline height so it can auto-expand to full content
	try {
		const wrapper = editorHost.closest ? editorHost.closest('.query-editor-wrapper') : null;
		if (wrapper && wrapper.style) {
			if (isPreview) {
				let fixed = false;
				try {
					fixed = !!(wrapper.dataset && wrapper.dataset.kustoUserResized === 'true');
				} catch { /* ignore */ }
				if (!fixed) {
					try {
						const h = String(wrapper.style.height || '').trim();
						fixed = /^\d+px$/i.test(h);
						// If it was set via restore or older flows, mark as user-resized so behavior stays consistent.
						if (fixed) {
							try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
						}
					} catch { /* ignore */ }
				}
				if (!fixed) {
					// Auto-expand: remove inline height so CSS can size to content.
					wrapper.style.height = '';
				}
			}
		}
	} catch {
		// ignore
	}

	try { box.classList.toggle('is-md-preview', isPreview); } catch { /* ignore */ }
	try { viewerHost.style.display = isPreview ? '' : 'none'; } catch { /* ignore */ }
	try { editorHost.style.display = isPreview ? 'none' : ''; } catch { /* ignore */ }
	try { __kustoUpdateMarkdownPreviewSizing(boxId); } catch { /* ignore */ }

	if (isPreview) {
		let md = '';
		try {
			md = markdownEditors && markdownEditors[boxId] ? String(markdownEditors[boxId].getValue() || '') : '';
		} catch {
			md = '';
		}
		try { initMarkdownViewer(boxId, md); } catch { /* ignore */ }

		// After switching to Preview, auto-run "Fit to contents" so the user
		// immediately sees the full rendered markdown without needing to click.
		// Use a couple retries to handle async preview rendering/layout.
		try {
			const fitToContents = () => {
				try {
					if (typeof __kustoMaximizeMarkdownBox === 'function') {
						__kustoMaximizeMarkdownBox(boxId);
					}
				} catch { /* ignore */ }
			};
			fitToContents();
			setTimeout(fitToContents, 50);
			setTimeout(fitToContents, 150);
			setTimeout(fitToContents, 350);
		} catch { /* ignore */ }

		// In .md files, reset scroll position to prevent layout shift.
		try {
			if (document.body && document.body.dataset && document.body.dataset.kustoDocumentKind === 'md') {
				document.body.scrollTop = 0;
				document.documentElement.scrollTop = 0;
			}
		} catch { /* ignore */ }
		return;
	}

	// Editor modes (Markdown/WYSIWYG)
	let toastEditor = null;
	try {
		toastEditor = markdownEditors && markdownEditors[boxId] ? markdownEditors[boxId]._toastui : null;
	} catch {
		toastEditor = null;
	}
	if (!toastEditor || typeof toastEditor.changeMode !== 'function') {
		return;
	}
	try {
		toastEditor.changeMode(mode, true);
	} catch { /* ignore */ }
	try {
		if (markdownEditors[boxId] && typeof markdownEditors[boxId].layout === 'function') {
			markdownEditors[boxId].layout();
		}
	} catch { /* ignore */ }

	// In .md files, the body shouldn't scroll but Toast UI's changeMode may trigger
	// scrollIntoView internally. Reset scroll position to prevent layout shift.
	try {
		if (document.body && document.body.dataset && document.body.dataset.kustoDocumentKind === 'md') {
			document.body.scrollTop = 0;
			document.documentElement.scrollTop = 0;
		}
	} catch { /* ignore */ }
}

export function isLikelyDarkTheme() {
	try {
		const value = getComputedStyle(document.documentElement)
			.getPropertyValue('--vscode-editor-background')
			.trim();
		if (!value) {
			return false;
		}
		let r, g, b;
		if (value.startsWith('#')) {
			const hex = value.slice(1);
			if (hex.length === 3) {
				r = parseInt(hex[0] + hex[0], 16);
				g = parseInt(hex[1] + hex[1], 16);
				b = parseInt(hex[2] + hex[2], 16);
			} else if (hex.length === 6) {
				r = parseInt(hex.slice(0, 2), 16);
				g = parseInt(hex.slice(2, 4), 16);
				b = parseInt(hex.slice(4, 6), 16);
			} else {
				return false;
			}
		} else {
			const m = value.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
			if (!m) {
				return false;
			}
			r = parseInt(m[1], 10);
			g = parseInt(m[2], 10);
			b = parseInt(m[3], 10);
		}
		const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		return luma < 128;
	} catch {
		return false;
	}
}

export function getToastUiPlugins( ToastEditor: any) {
	try {
		const colorSyntax = ToastEditor && ToastEditor.plugin && typeof ToastEditor.plugin.colorSyntax === 'function'
			? ToastEditor.plugin.colorSyntax
			: null;
		if (colorSyntax) {
			return [[colorSyntax, {}]];
		}
	} catch {
		// ignore
	}
	return [];
}

export function ensureMarkedGlobal() {
	// Marked may have registered itself as an AMD module (because Monaco installs `define.amd`)
	// instead of attaching to `window.marked`. Preview rendering expects `marked` to exist,
	// so if it's missing, try to resolve it from the AMD loader.
	try {
		if (typeof (_win.marked as any) !== 'undefined' && (_win.marked as any)) {
			return Promise.resolve((_win.marked as any));
		}
	} catch {
		// ignore
	}

	if (markdownMarkedResolvePromise) {
		return markdownMarkedResolvePromise;
	}

	markdownMarkedResolvePromise = new Promise((resolve: any) => {
		try {
			if (typeof require === 'function') {
				(require as any)(
					['marked'],
					(m: any) => {
						try {
							if (typeof (_win.marked as any) === 'undefined' || !(_win.marked as any)) {
								// Best-effort: make it available as a global for the existing renderer.
								(window as any).marked = m;
							}
						} catch {
							// ignore
						}
						resolve(m);
					},
					() => resolve(null)
				);
				return;
			}
		} catch {
			// ignore
		}
		resolve(null);
	});

	return markdownMarkedResolvePromise;
}

export function addMarkdownBox( options: any) {
	const id = (options && options.id) ? String(options.id) : ('markdown_' + Date.now());
	markdownBoxes.push(id);

	// Allow restore/persistence to set an initial mode before the editor/viewer initializes.
	try {
		const rawMode = options && typeof options.mode !== 'undefined' ? String(options.mode || '').toLowerCase() : '';
		if (rawMode === 'preview' || rawMode === 'markdown' || rawMode === 'wysiwyg') {
			const map = __kustoEnsureMarkdownModeMap();
			map[id] = rawMode;
		}
	} catch {
		// ignore
	}

	// Ensure initial markdown text is available before TOAST UI initializes.
	try {
		const initialText = options && typeof options.text === 'string' ? options.text : undefined;
		if (typeof initialText === 'string') {
			(window as any).__kustoPendingMarkdownTextByBoxId = (window as any).__kustoPendingMarkdownTextByBoxId || {};
			(window as any).__kustoPendingMarkdownTextByBoxId[id] = initialText;
		}
	} catch {
		// ignore
	}

	const container = document.getElementById('queries-container') as any;
	if (!container) {
		return;
	}

	const litEl = document.createElement('kw-markdown-section');
	litEl.id = id;
	litEl.setAttribute('box-id', id);

	// For plain .md files, enable full-page mode (no section chrome).
	try {
		if (String((window as any).__kustoDocumentKind || '') === 'md' || (options && options.mdAutoExpand)) {
			litEl.setAttribute('plain-md', '');
		}
	} catch { /* ignore */ }

	// Pass initial text if available.
	const pendingText = (window as any).__kustoPendingMarkdownTextByBoxId && (window as any).__kustoPendingMarkdownTextByBoxId[id];
	if (typeof pendingText === 'string') {
		litEl.setAttribute('initial-text', pendingText);
	}

	// Create light-DOM containers that TOAST UI will render into (via <slot>).
	const editorDiv = document.createElement('div');
	editorDiv.className = 'kusto-markdown-editor';
	editorDiv.id = id + '_md_editor';
	editorDiv.slot = 'editor';
	litEl.appendChild(editorDiv);

	const viewerDiv = document.createElement('div');
	viewerDiv.className = 'markdown-viewer';
	viewerDiv.id = id + '_md_viewer';
	viewerDiv.slot = 'viewer';
	viewerDiv.style.display = 'none';
	litEl.appendChild(viewerDiv);

	// Handle remove event from the Lit component.
	litEl.addEventListener('section-remove', function (e: any) {
		try { removeMarkdownBox(e.detail.boxId); } catch { /* ignore */ }
	});

	container.appendChild(litEl);

	// Apply persisted height.
	try {
		const h = options && typeof options.editorHeightPx === 'number' ? options.editorHeightPx : undefined;
		const isPlainMd = String((window as any).__kustoDocumentKind || '') === 'md';
		if (!isPlainMd && typeof h === 'number' && Number.isFinite(h) && h > 0) {
			litEl.setAttribute('editor-height-px', String(h));
		}
	} catch { /* ignore */ }

	// Apply persisted mode.
	try {
		const rawMode = options && typeof options.mode !== 'undefined' ? String(options.mode || '').toLowerCase() : '';
		if (rawMode === 'preview' || rawMode === 'markdown' || rawMode === 'wysiwyg') {
			if (typeof litEl.setMarkdownMode === 'function') {
				litEl.setMarkdownMode(rawMode);
			}
		}
	} catch { /* ignore */ }

	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
	try {
		const isPlainMd = String((window as any).__kustoDocumentKind || '') === 'md';
		if (!isPlainMd) {
			const controls = document.querySelector('.add-controls');
			if (controls && typeof controls.scrollIntoView === 'function') {
				controls.scrollIntoView({ block: 'end' });
			}
		}
	} catch {
		// ignore
	}
	return id;
}

export function __kustoAutoFitMarkdownBoxHeight( boxId: any) {
	const tryFit = () => {
		try {
			const container = document.getElementById(boxId + '_md_editor') as any;
			if (!container || !container.closest) {
				return false;
			}
			const wrapper = container.closest('.query-editor-wrapper');
			if (!wrapper) {
				return false;
			}
			// Never override user resizing.
			try {
				if (wrapper.dataset && wrapper.dataset.kustoUserResized === 'true') {
					return true;
				}
			} catch { /* ignore */ }

			const ui = container.querySelector('.toastui-editor-defaultUI');
			if (!ui) {
				return false;
			}
			const toolbar = ui.querySelector('.toastui-editor-defaultUI-toolbar');
			const toolbarH = toolbar && toolbar.getBoundingClientRect ? toolbar.getBoundingClientRect().height : 0;

			let contentH = 0;
			const prose = ui.querySelector('.toastui-editor-main .ProseMirror');
			if (prose && typeof prose.scrollHeight === 'number') {
				contentH = prose.scrollHeight;
			}
			if (!contentH) {
				const contents = ui.querySelector('.toastui-editor-contents');
				if (contents && typeof contents.scrollHeight === 'number') {
					contentH = contents.scrollHeight;
				}
			}
			if (!contentH) {
				return false;
			}

			const resizerH = 12;
			const minH = 120;
			const maxH = (() => {
				try {
					const vh = typeof window !== 'undefined' ? (window.innerHeight || 0) : 0;
					if (vh > 0) {
						return Math.max(240, Math.min(640, Math.floor(vh * 0.7)));
					}
				} catch { /* ignore */ }
				return 520;
			})();

			// Add a small padding to avoid clipping the last line.
			const padding = 18;
			const desired = Math.min(maxH, Math.max(minH, Math.ceil(toolbarH + contentH + resizerH + padding)));
			wrapper.style.height = desired + 'px';
			return true;
		} catch {
			return false;
		}
	};

	// Toast UI initializes asynchronously; retry a few times.
	let attempt = 0;
	const delays = [0, 50, 150, 300, 600, 1200];
	const step = () => {
		attempt++;
		const ok = tryFit();
		if (ok) {
			return;
		}
		if (attempt >= delays.length) {
			return;
		}
		try {
			setTimeout(step, delays[attempt]);
		} catch {
			// ignore
		}
	};
	step();
}

export function removeMarkdownBox( boxId: any) {
	if (markdownEditors[boxId]) {
		try { markdownEditors[boxId].dispose(); } catch { /* ignore */ }
		delete markdownEditors[boxId];
	}
	if (markdownViewers[boxId]) {
		try { markdownViewers[boxId].dispose(); } catch { /* ignore */ }
		delete markdownViewers[boxId];
	}
	try { __kustoCleanupMdModeResizeObserver(boxId); } catch { /* ignore */ }
	markdownBoxes = markdownBoxes.filter((id: any) => id !== boxId);
	const box = document.getElementById(boxId) as any;
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
	try {
		if ((window as any).__kustoMarkdownModeByBoxId && typeof (window as any).__kustoMarkdownModeByBoxId === 'object') {
			delete (window as any).__kustoMarkdownModeByBoxId[boxId];
		}
	} catch { /* ignore */ }
}

export function __kustoUpdateMarkdownVisibilityToggleButton( boxId: any) {
	const btn = document.getElementById(boxId + '_toggle') as any;
	if (!btn) {
		return;
	}
	let expanded = true;
	try {
		expanded = !((window as any).__kustoMarkdownExpandedByBoxId && (window as any).__kustoMarkdownExpandedByBoxId[boxId] === false);
	} catch { /* ignore */ }
	btn.classList.toggle('is-active', expanded);
	btn.setAttribute('aria-selected', expanded ? 'true' : 'false');
	btn.title = expanded ? 'Hide' : 'Show';
	btn.setAttribute('aria-label', expanded ? 'Hide' : 'Show');
}

export function __kustoApplyMarkdownBoxVisibility( boxId: any) {
	const box = document.getElementById(boxId) as any;
	if (!box) {
		return;
	}
	let expanded = true;
	try {
		expanded = !((window as any).__kustoMarkdownExpandedByBoxId && (window as any).__kustoMarkdownExpandedByBoxId[boxId] === false);
	} catch { /* ignore */ }
	try {
		box.classList.toggle('is-collapsed', !expanded);
	} catch { /* ignore */ }
	if (expanded) {
		try {
			setTimeout(() => {
				try {
					const ed = (typeof markdownEditors === 'object' && markdownEditors) ? markdownEditors[boxId] : null;
					if (ed && typeof ed.layout === 'function') {
						ed.layout();
					}
				} catch { /* ignore */ }
			}, 0);
		} catch { /* ignore */ }
	}
}

export function toggleMarkdownBoxVisibility( boxId: any) {
	try {
		if (!(window as any).__kustoMarkdownExpandedByBoxId || typeof (window as any).__kustoMarkdownExpandedByBoxId !== 'object') {
			(window as any).__kustoMarkdownExpandedByBoxId = {};
		}
		const current = !((window as any).__kustoMarkdownExpandedByBoxId[boxId] === false);
		(window as any).__kustoMarkdownExpandedByBoxId[boxId] = !current;
	} catch { /* ignore */ }
	try { __kustoUpdateMarkdownVisibilityToggleButton(boxId); } catch { /* ignore */ }
	try { __kustoApplyMarkdownBoxVisibility(boxId); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

export function initMarkdownViewer( boxId: any, initialValue: any) {
	const container = document.getElementById(boxId + '_md_viewer') as any;
	if (!container) {
		return;
	}

	// If a viewer exists, ensure it's still attached to this container.
	try {
		const existing = markdownViewers && markdownViewers[boxId] ? markdownViewers[boxId] : null;
		if (existing) {
			const attached = !!(container.querySelector && container.querySelector('.toastui-editor-contents'));
			if (attached) {
				if (typeof initialValue === 'string' && typeof existing.setValue === 'function') {
					try { existing.setValue(initialValue); } catch { /* ignore */ }
				}
				return;
			}
			try { existing.dispose && existing.dispose(); } catch { /* ignore */ }
			try { delete markdownViewers[boxId]; } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}

	let ToastEditor = null;
	try {
		ToastEditor = ((window as any).toastui && (window as any).toastui.Editor) ? (window as any).toastui.Editor : null;
	} catch {
		ToastEditor = null;
	}

	if (!ToastEditor) {
		// Webview scripts load sequentially, but keep a small retry loop for safety.
		let attempt = 0;
		try {
			(window as any).__kustoToastUiViewerInitRetryCountByBoxId = (window as any).__kustoToastUiViewerInitRetryCountByBoxId || {};
			attempt = ((window as any).__kustoToastUiViewerInitRetryCountByBoxId[boxId] || 0) + 1;
			(window as any).__kustoToastUiViewerInitRetryCountByBoxId[boxId] = attempt;
		} catch {
			attempt = 1;
		}

		const delays = [50, 250, 1000, 2000, 4000];
		const delay = delays[Math.min(attempt - 1, delays.length - 1)];
		if (attempt <= delays.length) {
			try {
				setTimeout(() => {
					try { initMarkdownViewer(boxId, initialValue); } catch { /* ignore */ }
				}, delay);
			} catch {
				// ignore
			}
		} else {
			try { console.error('TOAST UI Editor is not available (markdown viewer).'); } catch { /* ignore */ }
		}
		return;
	}

	// Ensure a clean mount point.
	try { container.textContent = ''; } catch { /* ignore */ }

	let instance = null;
	try {
		const opts: any = {
			usageStatistics: false,
			initialValue: typeof initialValue === 'string' ? initialValue : '',
			plugins: getToastUiPlugins(ToastEditor),
			events: {
				afterPreviewRender: () => {
					try { __kustoRewriteToastUiImagesInContainer(container); } catch { /* ignore */ }
				}
			}
		};
		if (isLikelyDarkTheme()) {
			opts.theme = 'dark';
		}
		instance = (typeof ToastEditor.factory === 'function') ? ToastEditor.factory(opts) : new ToastEditor(opts);
	} catch (e: any) {
		try { console.error('Failed to initialize TOAST UI Editor (markdown viewer).', e); } catch { /* ignore */ }
		return;
	}

	try { __kustoRewriteToastUiImagesInContainer(container); } catch { /* ignore */ }

	markdownViewers[boxId] = {
		setValue: (value: any) => {
			try {
				if (instance && typeof instance.setMarkdown === 'function') {
					instance.setMarkdown(String(value || ''));
				}
			} catch {
				// ignore
			}
		},
		dispose: () => {
			try {
				if (instance && typeof instance.destroy === 'function') {
					instance.destroy();
				}
			} catch {
				// ignore
			}
		}
	};

	// Ensure theme switches (dark/light) are reflected without recreating the viewer.
	try { __kustoStartToastUiThemeObserver(); } catch { /* ignore */ }
	try { __kustoApplyToastUiThemeAll(); } catch { /* ignore */ }
}

export function initMarkdownEditor( boxId: any) {
	const container = document.getElementById(boxId + '_md_editor') as any;
	const viewer = document.getElementById(boxId + '_md_viewer') as any;
	if (!container || !viewer) {
		return;
	}

	const isLikelyDarkTheme = () => {
		try {
			const value = getComputedStyle(document.documentElement)
				.getPropertyValue('--vscode-editor-background')
				.trim();
			if (!value) {
				return false;
			}
			let r, g, b;
			if (value.startsWith('#')) {
				const hex = value.slice(1);
				if (hex.length === 3) {
					r = parseInt(hex[0] + hex[0], 16);
					g = parseInt(hex[1] + hex[1], 16);
					b = parseInt(hex[2] + hex[2], 16);
				} else if (hex.length === 6) {
					r = parseInt(hex.slice(0, 2), 16);
					g = parseInt(hex.slice(2, 4), 16);
					b = parseInt(hex.slice(4, 6), 16);
				} else {
					return false;
				}
			} else {
				const m = value.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
				if (!m) {
					return false;
				}
				r = parseInt(m[1], 10);
				g = parseInt(m[2], 10);
				b = parseInt(m[3], 10);
			}
			const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			return luma < 128;
		} catch {
			return false;
		}
	};

	// If an editor exists, ensure it's still attached to this container.
	try {
		const existing = markdownEditors && markdownEditors[boxId] ? markdownEditors[boxId] : null;
		if (existing) {
			const attached = !!(container.querySelector && container.querySelector('.toastui-editor-defaultUI'));
			if (attached) {
				return;
			}
			try { existing.dispose && existing.dispose(); } catch { /* ignore */ }
			try { delete markdownEditors[boxId]; } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}

	let ToastEditor = null;
	try {
		ToastEditor = ((window as any).toastui && (window as any).toastui.Editor) ? (window as any).toastui.Editor : null;
	} catch {
		ToastEditor = null;
	}

	if (!ToastEditor) {
		// Webview scripts load sequentially, but keep a small retry loop for safety.
		let attempt = 0;
		try {
			(window as any).__kustoToastUiInitRetryCountByBoxId = (window as any).__kustoToastUiInitRetryCountByBoxId || {};
			attempt = ((window as any).__kustoToastUiInitRetryCountByBoxId[boxId] || 0) + 1;
			(window as any).__kustoToastUiInitRetryCountByBoxId[boxId] = attempt;
		} catch {
			attempt = 1;
		}

		const delays = [50, 250, 1000, 2000, 4000];
		const delay = delays[Math.min(attempt - 1, delays.length - 1)];
		if (attempt <= delays.length) {
			try {
				setTimeout(() => {
					try { initMarkdownEditor(boxId); } catch { /* ignore */ }
				}, delay);
			} catch {
				// ignore
			}
		} else {
			try { console.error('TOAST UI Editor is not available (markdown editor).'); } catch { /* ignore */ }
		}
		return;
	}

	container.style.minHeight = '0';
	container.style.minWidth = '0';

	// Avoid setMarkdown() during init; pass initial value into the constructor.
	let initialValue = '';
	try {
		const pending = (window as any).__kustoPendingMarkdownTextByBoxId && (window as any).__kustoPendingMarkdownTextByBoxId[boxId];
		if (typeof pending === 'string') {
			initialValue = pending;
			try { delete (window as any).__kustoPendingMarkdownTextByBoxId[boxId]; } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}

	try {
		// Ensure a clean mount point.
		container.textContent = '';
	} catch {
		// ignore
	}

	// Create undo/redo toolbar button elements.
	// These are custom toolbar items that trigger ProseMirror's undo/redo commands.
	let undoButton = null;
	let redoButton = null;
	let toastEditorRef: any = null; // Will be set after editor creation
	try {
		// Undo button
		undoButton = document.createElement('button');
		undoButton.type = 'button';
		undoButton.className = 'toastui-editor-toolbar-icons undo';
		undoButton.setAttribute('aria-label', 'Undo');
		undoButton.title = 'Undo (Ctrl+Z)';
		undoButton.style.backgroundImage = 'none';
		undoButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>';
		undoButton.addEventListener('click', () => {
			try {
				if (toastEditorRef) {
					const modeEditor = toastEditorRef.getCurrentModeEditor ? toastEditorRef.getCurrentModeEditor() : null;
					if (modeEditor && modeEditor.commands && typeof modeEditor.commands.undo === 'function') {
						modeEditor.commands.undo();
					}
				}
			} catch { /* ignore */ }
		});

		// Redo button
		redoButton = document.createElement('button');
		redoButton.type = 'button';
		redoButton.className = 'toastui-editor-toolbar-icons redo';
		redoButton.setAttribute('aria-label', 'Redo');
		redoButton.title = 'Redo (Ctrl+Y)';
		redoButton.style.backgroundImage = 'none';
		redoButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>';
		redoButton.addEventListener('click', () => {
			try {
				if (toastEditorRef) {
					const modeEditor = toastEditorRef.getCurrentModeEditor ? toastEditorRef.getCurrentModeEditor() : null;
					if (modeEditor && modeEditor.commands && typeof modeEditor.commands.redo === 'function') {
						modeEditor.commands.redo();
					}
				}
			} catch { /* ignore */ }
		});
	} catch { /* ignore */ }

	let toastEditor = null;
	try {
		// Build the toolbarItems array with undo/redo as the first group
		const toolbarItemsConfig = [];
		
		// First group: undo/redo buttons (custom elements)
		if (undoButton && redoButton) {
			toolbarItemsConfig.push([
				{ name: 'undo', el: undoButton, tooltip: 'Undo (Ctrl+Z)' },
				{ name: 'redo', el: redoButton, tooltip: 'Redo (Ctrl+Y)' }
			]);
		}
		
		// Default toolbar groups
		toolbarItemsConfig.push(
			['heading', 'bold', 'italic', 'strike'],
			['hr', 'quote'],
			['ul', 'ol', 'task', 'indent', 'outdent'],
			['table', 'image', 'link'],
			['code', 'codeblock']
		);

		const editorOptions: any = {
			el: container,
			height: '100%',
			initialEditType: 'wysiwyg',
			previewStyle: 'vertical',
			hideModeSwitch: true,
			usageStatistics: false,
			initialValue,
			toolbarItems: toolbarItemsConfig,
			plugins: getToastUiPlugins(ToastEditor),
			events: {
				change: () => {
					try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
					try { __kustoScheduleMdAutoExpand && __kustoScheduleMdAutoExpand(boxId); } catch { /* ignore */ }
				},
				afterPreviewRender: () => {
					try { __kustoRewriteToastUiImagesInContainer(container); } catch { /* ignore */ }
				}
			}
		};
		if (isLikelyDarkTheme()) {
			editorOptions.theme = 'dark';
		}

		toastEditor = new ToastEditor({
			...editorOptions
		});
		
		// Set the reference so toolbar buttons can access the editor
		toastEditorRef = toastEditor;
	} catch (e: any) {
		try { console.error('Failed to initialize TOAST UI Editor (markdown editor).', e); } catch { /* ignore */ }
		return;
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Keyboard shortcut conflict resolution for VS Code webview.
	//
	// VS Code intercepts certain keyboard shortcuts globally (e.g., Ctrl+B toggles sidebar).
	// When editing markdown, we want shortcuts like Ctrl+B (bold), Ctrl+I (italic), etc.
	// to be handled by the markdown editor, not VS Code.
	//
	// IMPORTANT: We only intercept shortcuts when the markdown editor is FOCUSED.
	// When focus is elsewhere (Monaco editor, results table, etc.), VS Code shortcuts
	// continue to work normally.
	//
	// Strategy:
	// - For markdown formatting shortcuts (Ctrl+B, Ctrl+I, Ctrl+U, etc.): prevent VS Code
	//   from seeing them by stopping propagation and letting ToastUI handle them.
	// - For Ctrl+S (save): intercept it from ToastUI (which uses it for strikethrough)
	//   and re-dispatch to VS Code for file save functionality.
	// - For Ctrl+Z/Y (undo/redo) and Ctrl+V (paste): prevent VS Code from performing
	//   document-level undo/redo/paste which would cause a full editor reload.
	// ─────────────────────────────────────────────────────────────────────────────
	try {
		// Shortcuts that the markdown editor should handle (not VS Code).
		// Ctrl+B = bold (VS Code: toggle sidebar)
		// Ctrl+I = italic
		// Ctrl+U = underline (VS Code: view source in some contexts)
		// Ctrl+E = code (VS Code: quick open recent)
		// Ctrl+K = link (VS Code: chord starter for many commands)
		// Ctrl+L = ordered list (VS Code: select line)
		// Ctrl+Shift+L = unordered list
		// Ctrl+D = strikethrough in some editors (VS Code: add selection to next find match)
		const markdownFormattingKeys = new Set(['b', 'i', 'u', 'e', 'k', 'l', 'd']);

		// Helper to check if focus is inside the markdown editor.
		// ToastUI uses ProseMirror which creates contenteditable elements.
		const isMarkdownEditorFocused = () => {
			try {
				const active = document.activeElement;
				if (!active) return false;
				// Check if focus is inside this ToastUI container.
				// ToastUI's editable area has class 'ProseMirror' or is inside '.toastui-editor'.
				return container.contains(active) && (
					active.classList.contains('ProseMirror') ||
					active.closest('.ProseMirror') ||
					active.closest('.toastui-editor-contents') ||
					(active as any).isContentEditable
				);
			} catch { return false; }
		};

		// Capture phase handler - intercepts keyboard shortcuts before they reach VS Code.
		// For undo/redo, we intercept and then let the event continue to ToastUI's ProseMirror.
		container.addEventListener('keydown', (ev: any) => {
			try {
				const key = ev.key.toLowerCase();
				const hasCtrlOrMeta = ev.ctrlKey || ev.metaKey;

				if (!hasCtrlOrMeta) {
					return; // Not a shortcut we care about
				}

				// Only intercept shortcuts when the markdown editor is focused.
				// This ensures VS Code shortcuts work normally when focus is elsewhere
				// (e.g., Monaco editor, results table, schema panel, etc.).
				if (!isMarkdownEditorFocused()) {
					return;
				}

				// Special case: Ctrl+S - redirect to VS Code for file save.
				// ToastUI/ProseMirror uses Ctrl+S for strikethrough, which conflicts.
				if (key === 's') {
					// Stop ToastUI from receiving this event entirely.
					ev.stopPropagation();
					ev.stopImmediatePropagation();
					ev.preventDefault();
					
					// Re-dispatch to document level so VS Code can handle save.
					try {
						const newEvent = new KeyboardEvent('keydown', {
							key: ev.key,
							code: ev.code,
							keyCode: ev.keyCode,
							which: ev.which,
							ctrlKey: ev.ctrlKey,
							metaKey: ev.metaKey,
							shiftKey: ev.shiftKey,
							altKey: ev.altKey,
							bubbles: true,
							cancelable: true
						});
						document.dispatchEvent(newEvent);
					} catch { /* ignore */ }
					return;
				}

				// Handle Ctrl+Z (undo) - execute via ToastUI commands API, block VS Code
				if (key === 'z' && !ev.shiftKey) {
					ev.stopPropagation();
					ev.stopImmediatePropagation();
					ev.preventDefault();
					// Execute undo directly via ToastUI's commands API
					try {
						const modeEditor = toastEditor && toastEditor.getCurrentModeEditor ? toastEditor.getCurrentModeEditor() : null;
						if (modeEditor && modeEditor.commands && typeof modeEditor.commands.undo === 'function') {
							modeEditor.commands.undo();
						}
					} catch { /* ignore */ }
					return;
				}

				// Handle Ctrl+Shift+Z (redo) - execute via ToastUI commands API, block VS Code
				if (key === 'z' && ev.shiftKey) {
					ev.stopPropagation();
					ev.stopImmediatePropagation();
					ev.preventDefault();
					// Execute redo directly via ToastUI's commands API
					try {
						const modeEditor = toastEditor && toastEditor.getCurrentModeEditor ? toastEditor.getCurrentModeEditor() : null;
						if (modeEditor && modeEditor.commands && typeof modeEditor.commands.redo === 'function') {
							modeEditor.commands.redo();
						}
					} catch { /* ignore */ }
					return;
				}

				// Handle Ctrl+Y (redo) - execute via ToastUI commands API, block VS Code
				// Note: ProseMirror uses Ctrl+Shift+Z for redo, but users expect Ctrl+Y to work too
				if (key === 'y' && !ev.shiftKey) {
					ev.stopPropagation();
					ev.stopImmediatePropagation();
					ev.preventDefault();
					// Execute redo directly via ToastUI's commands API
					try {
						const modeEditor = toastEditor && toastEditor.getCurrentModeEditor ? toastEditor.getCurrentModeEditor() : null;
						if (modeEditor && modeEditor.commands && typeof modeEditor.commands.redo === 'function') {
							modeEditor.commands.redo();
						}
					} catch { /* ignore */ }
					return;
				}

				// Markdown formatting shortcuts - let ToastUI handle them, block VS Code.
				// These are shortcuts where the user intends to format text, not trigger
				// VS Code commands like toggling the sidebar.
				if (markdownFormattingKeys.has(key)) {
					// Stop the event from bubbling to VS Code's webview keyboard handler.
					// This prevents VS Code from seeing Ctrl+B, Ctrl+I, etc.
					ev.stopPropagation();
					// Note: We do NOT call preventDefault() here - ToastUI needs to handle the key.
					// We also do NOT call stopImmediatePropagation() - ToastUI's handlers should run.
				}

				// Block cut/paste from reaching VS Code (let ToastUI handle via default behavior)
				if (key === 'v' || key === 'x') {
					ev.stopPropagation();
				}
			} catch { /* ignore */ }
		}, true); // capture phase - fires before propagation to parent (VS Code)
	} catch { /* ignore */ }

	// Initial pass (in case the preview has already rendered by the time the hook is attached).
	try { __kustoRewriteToastUiImagesInContainer(container); } catch { /* ignore */ }

	const api = {
		getValue: () => {
			try { return toastEditor && typeof toastEditor.getMarkdown === 'function' ? String(toastEditor.getMarkdown() || '') : ''; } catch { return ''; }
		},
		setValue: (value: any) => {
			try {
				if (toastEditor && typeof toastEditor.setMarkdown === 'function') {
					toastEditor.setMarkdown(String(value || ''));
				}
			} catch { /* ignore */ }
		},
		// Undo the last edit in the ToastUI editor.
		// Calls the ProseMirror undo command directly via ToastUI's commands API.
		undo: () => {
			try {
				if (!toastEditor) return false;
				const modeEditor = toastEditor.getCurrentModeEditor ? toastEditor.getCurrentModeEditor() : null;
				if (!modeEditor) return false;
				// ToastUI exposes ProseMirror commands via the commands property
				if (modeEditor.commands && typeof modeEditor.commands.undo === 'function') {
					modeEditor.commands.undo();
					return true;
				}
				return false;
			} catch { return false; }
		},
		// Redo the last undone edit in the ToastUI editor.
		// Calls the ProseMirror redo command directly via ToastUI's commands API.
		redo: () => {
			try {
				if (!toastEditor) return false;
				const modeEditor = toastEditor.getCurrentModeEditor ? toastEditor.getCurrentModeEditor() : null;
				if (!modeEditor) return false;
				// ToastUI exposes ProseMirror commands via the commands property
				if (modeEditor.commands && typeof modeEditor.commands.redo === 'function') {
					modeEditor.commands.redo();
					return true;
				}
				return false;
			} catch { return false; }
		},
		layout: () => {
			try {
				if (!toastEditor || typeof toastEditor.setHeight !== 'function') {
					return;
				}
				const wrapper = container.closest ? container.closest('.query-editor-wrapper') : null;
				const resizer = document.getElementById(boxId + '_md_resizer') as any;
				if (!wrapper) {
					return;
				}
				let h = wrapper.getBoundingClientRect().height;
				try {
					if (resizer) {
						h -= resizer.getBoundingClientRect().height;
					}
				} catch { /* ignore */ }
				h = Math.max(120, h);
				toastEditor.setHeight(Math.round(h) + 'px');
			} catch { /* ignore */ }
		},
		dispose: () => {
			try {
				if (toastEditor && typeof toastEditor.destroy === 'function') {
					toastEditor.destroy();
				}
			} catch { /* ignore */ }
			try { container.textContent = ''; } catch { /* ignore */ }
		},
		_toastui: toastEditor
	};

	markdownEditors[boxId] = api;
	
	// Check for any pending text that might have been set during async initialization
	// (e.g., if toolUpdateMarkdownSection was called while we were creating the editor)
	try {
		const latePending = (window as any).__kustoPendingMarkdownTextByBoxId && (window as any).__kustoPendingMarkdownTextByBoxId[boxId];
		if (typeof latePending === 'string') {
			api.setValue(latePending);
			try { delete (window as any).__kustoPendingMarkdownTextByBoxId[boxId]; } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
	
	try { __kustoApplyMarkdownEditorMode(boxId); } catch { /* ignore */ }
	try { __kustoTryApplyPendingMarkdownReveal(boxId); } catch { /* ignore */ }

	// For multi-section files (.kqlx, .mdx), fix the double-border issue by removing
	// the Toast UI's border (the section wrapper already provides the border).
	try {
		const isPlainMd = String((window as any).__kustoDocumentKind || '') === 'md';
		if (!isPlainMd) {
			const defaultUI = container.querySelector('.toastui-editor-defaultUI');
			if (defaultUI) {
				defaultUI.style.setProperty('border', 'none', 'important');
				defaultUI.style.setProperty('border-radius', '0', 'important');
			}
			const toolbar = container.querySelector('.toastui-editor-defaultUI-toolbar');
			if (toolbar) {
				// Use negative margin to overlap the wrapper border
				toolbar.style.setProperty('margin', '-1px -1px 0 -1px', 'important');
				toolbar.style.setProperty('border-radius', '0', 'important');
			}
		}
	} catch (e: any) { /* ignore border fix error */ }

	// Ensure theme switches (dark/light) are reflected without recreating the editor.
	try { __kustoStartToastUiThemeObserver(); } catch { /* ignore */ }
	try { __kustoApplyToastUiThemeAll(); } catch { /* ignore */ }

	// Drag handle resize (same pattern as the KQL editor).
	try {
		const wrapper = container.closest ? container.closest('.query-editor-wrapper') : null;
		const resizer = document.getElementById(boxId + '_md_resizer') as any;
		if (wrapper && resizer) {
			resizer.addEventListener('mousedown', (e: any) => {
				try {
					e.preventDefault();
					e.stopPropagation();
				} catch {
					// ignore
				}
				try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }

				resizer.classList.add('is-dragging');
				const previousCursor = document.body.style.cursor;
				const previousUserSelect = document.body.style.userSelect;
				document.body.style.cursor = 'ns-resize';
				document.body.style.userSelect = 'none';

				const startPageY = e.clientY + (typeof _win.__kustoGetScrollY === 'function' ? _win.__kustoGetScrollY() : 0);
				const startHeight = wrapper.getBoundingClientRect().height;

				const onMove = (moveEvent: any) => {
					try {
						if (typeof _win.__kustoMaybeAutoScrollWhileDragging === 'function') {
							_win.__kustoMaybeAutoScrollWhileDragging(moveEvent.clientY);
						}
					} catch { /* ignore */ }
					const pageY = moveEvent.clientY + (typeof _win.__kustoGetScrollY === 'function' ? _win.__kustoGetScrollY() : 0);
					const delta = pageY - startPageY;
					let nextHeight = 0;
					try {
						const mode = (typeof __kustoGetMarkdownMode === 'function') ? __kustoGetMarkdownMode(boxId) : 'wysiwyg';
						// Preview mode can auto-expand; markdown/wysiwyg has no max height cap.
						nextHeight = Math.max(120, startHeight + delta);
						if (mode === 'preview') {
							// keep same behavior
						}
					} catch {
						nextHeight = Math.max(120, startHeight + delta);
					}
					wrapper.style.height = nextHeight + 'px';
					try { __kustoUpdateMarkdownPreviewSizing(boxId); } catch { /* ignore */ }
					try { api.layout(); } catch { /* ignore */ }
				};
				const onUp = () => {
					document.removeEventListener('mousemove', onMove, true);
					document.removeEventListener('mouseup', onUp, true);
					resizer.classList.remove('is-dragging');
					document.body.style.cursor = previousCursor;
					document.body.style.userSelect = previousUserSelect;
					try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
				};

				document.addEventListener('mousemove', onMove, true);
				document.addEventListener('mouseup', onUp, true);
			});

			// Double-click to fit editor to contents - delegate to the button's function
			// which already handles all modes (wysiwyg, markdown, preview) correctly with
			// proper fallbacks and retries for async layout settling.
			resizer.addEventListener('dblclick', (e: any) => {
				try {
					e.preventDefault();
					e.stopPropagation();
					if (typeof __kustoMaximizeMarkdownBox === 'function') {
						__kustoMaximizeMarkdownBox(boxId);
					}
				} catch { /* ignore */ }
			});
		}
	} catch {
		// ignore
	}

	// Ensure correct initial sizing.
	try { api.layout(); } catch { /* ignore */ }
}

export function __kustoRewriteToastUiImagesInContainer( rootEl: any) {
	try {
		if (!rootEl || !rootEl.querySelectorAll) {
			return;
		}
		const baseUri = (() => {
			try {
				return (typeof (window as any).__kustoDocumentUri === 'string') ? String((window as any).__kustoDocumentUri) : '';
			} catch {
				return '';
			}
		})();
		if (!baseUri) {
			return;
		}

		// Cache across renders to avoid spamming the extension host.
		(window as any).__kustoResolvedImageSrcCache = (window as any).__kustoResolvedImageSrcCache || {};
		const cache = (window as any).__kustoResolvedImageSrcCache;

		const imgs = rootEl.querySelectorAll('img');
		for (const img of imgs) {
			try {
				if (!img || !img.getAttribute) {
					continue;
				}
				const src = String(img.getAttribute('src') || '').trim();
				if (!src) {
					continue;
				}
				const lower = src.toLowerCase();
				if (
					lower.startsWith('http://') ||
					lower.startsWith('https://') ||
					lower.startsWith('blob:') ||
					lower.startsWith('vscode-webview://') ||
					lower.startsWith('vscode-resource:')
				) {
					continue;
				}
				// If ToastUI already rewrote it or we already processed it, skip.
				try {
					if (img.dataset && img.dataset.kustoResolvedSrc === src) {
						continue;
					}
				} catch { /* ignore */ }

				const key = baseUri + '::' + src;
				if (cache && typeof cache[key] === 'string' && cache[key]) {
					img.setAttribute('src', cache[key]);
					try { if (img.dataset) img.dataset.kustoResolvedSrc = src; } catch { /* ignore */ }
					continue;
				}

				const resolver = (window as any).__kustoResolveResourceUri;
				if (typeof resolver !== 'function') {
					continue;
				}

				// Fire-and-forget async resolve; preview is re-rendered frequently.
				resolver({ path: src, baseUri }).then((resolved: any) => {
					try {
						if (!resolved || typeof resolved !== 'string') {
							return;
						}
						cache[key] = resolved;
						img.setAttribute('src', resolved);
						try { if (img.dataset) img.dataset.kustoResolvedSrc = src; } catch { /* ignore */ }
					} catch { /* ignore */ }
				});
			} catch {
				// ignore
			}
		}
	} catch {
		// ignore
	}
}

// ── Window bridges ──────────────────────────────────────────────────────────
(window as any).__kustoTryApplyPendingMarkdownReveal = __kustoTryApplyPendingMarkdownReveal;
(window as any).__kustoIsDarkTheme = __kustoIsDarkTheme;
(window as any).__kustoApplyToastUiThemeToHost = __kustoApplyToastUiThemeToHost;
(window as any).__kustoApplyToastUiThemeAll = __kustoApplyToastUiThemeAll;
(window as any).__kustoStartToastUiThemeObserver = __kustoStartToastUiThemeObserver;
(window as any).__kustoMaximizeMarkdownBox = __kustoMaximizeMarkdownBox;
(window as any).__kustoAutoExpandMarkdownBoxToContent = __kustoAutoExpandMarkdownBoxToContent;
(window as any).__kustoScheduleMdAutoExpand = __kustoScheduleMdAutoExpand;
(window as any).__kustoEnsureMarkdownModeMap = __kustoEnsureMarkdownModeMap;
(window as any).__kustoGetMarkdownMode = __kustoGetMarkdownMode;
(window as any).__kustoSetMarkdownMode = __kustoSetMarkdownMode;
(window as any).__kustoUpdateMarkdownModeButtons = __kustoUpdateMarkdownModeButtons;
(window as any).__kustoToggleMdModeDropdown = __kustoToggleMdModeDropdown;
(window as any).__kustoCloseMdModeDropdown = __kustoCloseMdModeDropdown;
(window as any).__kustoUpdateMdModeResponsive = __kustoUpdateMdModeResponsive;
(window as any).__kustoSetupMdModeResizeObserver = __kustoSetupMdModeResizeObserver;
(window as any).__kustoCleanupMdModeResizeObserver = __kustoCleanupMdModeResizeObserver;
(window as any).__kustoUpdateMarkdownPreviewSizing = __kustoUpdateMarkdownPreviewSizing;
(window as any).__kustoApplyMarkdownEditorMode = __kustoApplyMarkdownEditorMode;
(window as any).isLikelyDarkTheme = isLikelyDarkTheme;
(window as any).getToastUiPlugins = getToastUiPlugins;
(window as any).ensureMarkedGlobal = ensureMarkedGlobal;
(window as any).addMarkdownBox = addMarkdownBox;
(window as any).__kustoAutoFitMarkdownBoxHeight = __kustoAutoFitMarkdownBoxHeight;
(window as any).removeMarkdownBox = removeMarkdownBox;
(window as any).__kustoUpdateMarkdownVisibilityToggleButton = __kustoUpdateMarkdownVisibilityToggleButton;
(window as any).__kustoApplyMarkdownBoxVisibility = __kustoApplyMarkdownBoxVisibility;
(window as any).toggleMarkdownBoxVisibility = toggleMarkdownBoxVisibility;
(window as any).initMarkdownViewer = initMarkdownViewer;
(window as any).initMarkdownEditor = initMarkdownEditor;
(window as any).__kustoRewriteToastUiImagesInContainer = __kustoRewriteToastUiImagesInContainer;

