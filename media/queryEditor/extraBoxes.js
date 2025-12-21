// Additional section types for the Kusto Query Editor webview:
// - Markdown: Monaco editor while focused; rendered markdown viewer on blur
// - Python: Monaco editor + Run button; output viewer
// - URL: URL input + expand/collapse content viewer; content fetched by extension host

let markdownBoxes = [];
let pythonBoxes = [];
let urlBoxes = [];

let markdownEditors = {};
let markdownViewers = {};
let pythonEditors = {};

// Pending reveal requests from the extension host (e.g., Search result click).
// Keyed by markdown boxId.
let __kustoPendingMarkdownRevealByBoxId = {};

function __kustoTryApplyPendingMarkdownReveal(boxId) {
	try {
		const pending = __kustoPendingMarkdownRevealByBoxId && __kustoPendingMarkdownRevealByBoxId[boxId];
		if (!pending) {
			return;
		}
		try { delete __kustoPendingMarkdownRevealByBoxId[boxId]; } catch { /* ignore */ }
		try {
			if (typeof window.__kustoRevealMarkdownRangeInBox === 'function') {
				window.__kustoRevealMarkdownRangeInBox(boxId, pending);
			}
		} catch { /* ignore */ }
	} catch {
		// ignore
	}
}

// Called by main.js when the extension host asks us to reveal a range.
// For .md compatibility mode, there is exactly one markdown section; reveal in that first box.
try {
	if (typeof window.__kustoRevealTextRangeFromHost !== 'function') {
		window.__kustoRevealTextRangeFromHost = (message) => {
			try {
				const kind = String(window.__kustoDocumentKind || '');
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
						if (typeof vscode !== 'undefined' && vscode && typeof vscode.postMessage === 'function') {
							vscode.postMessage({
								type: 'debugMdSearchReveal',
								phase: 'markdownReveal(queued)',
								detail: `${String(window.__kustoDocumentUri || '')} boxId=${boxId} ${sl}:${sc}-${el}:${ec} matchLen=${matchText ? matchText.length : 0}`
							});
						}
					} catch { /* ignore */ }
					__kustoPendingMarkdownRevealByBoxId[boxId] = payload;
					return;
				}
				try {
					if (typeof vscode !== 'undefined' && vscode && typeof vscode.postMessage === 'function') {
						vscode.postMessage({
							type: 'debugMdSearchReveal',
							phase: 'markdownReveal(apply)',
							detail: `${String(window.__kustoDocumentUri || '')} boxId=${boxId} ${sl}:${sc}-${el}:${ec} matchLen=${matchText ? matchText.length : 0}`
						});
					}
				} catch { /* ignore */ }
				if (typeof window.__kustoRevealMarkdownRangeInBox === 'function') {
					window.__kustoRevealMarkdownRangeInBox(boxId, payload);
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
	if (typeof window.__kustoRevealMarkdownRangeInBox !== 'function') {
		window.__kustoRevealMarkdownRangeInBox = (boxId, payload) => {
			const id = String(boxId || '');
			if (!id) return;
			const sl = payload && typeof payload.startLine === 'number' ? payload.startLine : 0;
			const sc = payload && typeof payload.startChar === 'number' ? payload.startChar : 0;
			const el = payload && typeof payload.endLine === 'number' ? payload.endLine : sl;
			const ec = payload && typeof payload.endChar === 'number' ? payload.endChar : sc;
			const matchText = payload && typeof payload.matchText === 'string' ? String(payload.matchText) : '';
			const startOffset = payload && typeof payload.startOffset === 'number' ? payload.startOffset : undefined;
			const endOffset = payload && typeof payload.endOffset === 'number' ? payload.endOffset : undefined;
			const desiredUiMode = (typeof window.__kustoGetMarkdownMode === 'function')
				? String(window.__kustoGetMarkdownMode(id) || 'wysiwyg')
				: 'wysiwyg';

			try {
				const boxEl = document.getElementById(id);
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
			const computeLineChar1Based = (text, offset0) => {
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

			const computeOccurrenceIndex = (text, needle, atIndex) => {
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
				if (idx < 0) {
					// Fall back to the host-provided (line,char) if we can't find the text.
					const mdStartFallback = [Math.max(1, sl + 1), Math.max(1, sc + 1)];
					const mdEndFallback = [Math.max(1, el + 1), Math.max(1, ec + 1)];
					foundStart = 0;
					foundEnd = 0;
					occurrence = 0;
					try {
						// Apply fallback below.
						payload.__kustoMdStartFallback = mdStartFallback;
						payload.__kustoMdEndFallback = mdEndFallback;
					} catch { /* ignore */ }
				} else {
					foundStart = idx;
					foundEnd = idx + findText.length;
					occurrence = computeOccurrenceIndex(mdText, findText, idx);
				}
			}

			const applySelectionNow = () => {
				// If we're in preview mode, highlight + scroll using the rendered DOM.
				if (desiredUiMode === 'preview') {
					try {
						const viewerHost = document.getElementById(id + '_md_viewer');
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
								try { window.find && window.find(findText); } catch { /* ignore */ }
							}
						}, 0);
					} catch { /* ignore */ }
					return;
				}

				// Editor modes: keep the current mode; apply selection in a mode-appropriate way.
				const mdStart = (findText && foundEnd > foundStart)
					? computeLineChar1Based(mdText, foundStart)
					: (payload.__kustoMdStartFallback || [Math.max(1, sl + 1), Math.max(1, sc + 1)]);
				const mdEnd = (findText && foundEnd > foundStart)
					? computeLineChar1Based(mdText, foundEnd)
					: (payload.__kustoMdEndFallback || [Math.max(1, el + 1), Math.max(1, ec + 1)]);

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
				if (desiredUiMode === 'preview' && typeof window.__kustoSetMarkdownMode === 'function') {
					window.__kustoSetMarkdownMode(id, 'wysiwyg');
				}
			} catch { /* ignore */ }
			applySelectionInDesiredMode();
		};
	}
} catch {
	// ignore
}

let toastUiThemeObserverStarted = false;
let lastAppliedToastUiIsDarkTheme = null;

let urlStateByBoxId = {}; // { url, expanded, loading, loaded, content, error, kind, contentType, status, dataUri, body, truncated }

let markdownMarkedResolvePromise = null;

function __kustoIsDarkTheme() {
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
	const parseCssColorToRgb = (value) => {
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

function __kustoApplyToastUiThemeToHost(hostEl, isDark) {
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

function __kustoApplyToastUiThemeAll() {
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

function __kustoStartToastUiThemeObserver() {
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

function __kustoMaximizeMarkdownBox(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const editorHost = document.getElementById(id + '_md_editor');
	const viewerHost = document.getElementById(id + '_md_viewer');
	const wrapper = editorHost && editorHost.closest ? editorHost.closest('.query-editor-wrapper') : null;
	if (!wrapper) return;

	const tryComputeDesiredWrapperHeight = (mode) => {
		try {
			const container = editorHost;
			const ui = container && container.querySelector ? container.querySelector('.toastui-editor-defaultUI') : null;
			if (!ui) return undefined;
			const toolbar = ui.querySelector('.toastui-editor-defaultUI-toolbar');
			const toolbarH = toolbar && toolbar.getBoundingClientRect ? toolbar.getBoundingClientRect().height : 0;

			let contentH = 0;
			const m = String(mode || '').toLowerCase();
			if (m === 'wysiwyg') {
				// In WYSIWYG the scroll container is inside the ww container.
				const wwContents = ui.querySelector('.toastui-editor-ww-container .toastui-editor-contents');
				if (wwContents && typeof wwContents.scrollHeight === 'number') {
					contentH = Math.max(contentH, wwContents.scrollHeight);
				}
				const prose = ui.querySelector('.toastui-editor-ww-container .ProseMirror');
				if (prose && typeof prose.scrollHeight === 'number') {
					contentH = Math.max(contentH, prose.scrollHeight);
				}
			} else {
				// Markdown mode uses CodeMirror.
				const cmScroll = ui.querySelector('.toastui-editor-md-container .CodeMirror .CodeMirror-scroll');
				if (cmScroll && typeof cmScroll.scrollHeight === 'number') {
					contentH = Math.max(contentH, cmScroll.scrollHeight);
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
			const padding = 18;
			const minH = 120;
			return Math.max(minH, Math.ceil(toolbarH + contentH + resizerH + padding));
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
		try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
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
				// Fallback: bump the current height upward.
				const current = wrapper.getBoundingClientRect ? wrapper.getBoundingClientRect().height : 0;
				wrapper.style.height = Math.max(120, Math.round(current + 400)) + 'px';
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
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoAutoExpandMarkdownBoxToContent(boxId) {
	try {
		if (String(window.__kustoDocumentKind || '') !== 'md') {
			return;
		}
		const id = String(boxId || '').trim();
		if (!id) return;
		const editorHost = document.getElementById(id + '_md_editor');
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
					const wwContents = ui.querySelector('.toastui-editor-ww-container .toastui-editor-contents');
					if (wwContents && typeof wwContents.scrollHeight === 'number') {
						contentH = Math.max(contentH, wwContents.scrollHeight);
					}
					const prose = ui.querySelector('.toastui-editor-ww-container .ProseMirror');
					if (prose && typeof prose.scrollHeight === 'number') {
						contentH = Math.max(contentH, prose.scrollHeight);
					}
				} else if (mode === 'markdown') {
					const cmScroll = ui.querySelector('.toastui-editor-md-container .CodeMirror .CodeMirror-scroll');
					if (cmScroll && typeof cmScroll.scrollHeight === 'number') {
						contentH = Math.max(contentH, cmScroll.scrollHeight);
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

function __kustoScheduleMdAutoExpand(boxId) {
	try {
		if (String(window.__kustoDocumentKind || '') !== 'md') {
			return;
		}
		const id = String(boxId || '').trim();
		if (!id) return;
		window.__kustoMdAutoExpandTimersByBoxId = window.__kustoMdAutoExpandTimersByBoxId || {};
		const map = window.__kustoMdAutoExpandTimersByBoxId;
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

function __kustoMaximizePythonBox(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const editorEl = document.getElementById(id + '_py_editor');
	const wrapper = editorEl && editorEl.closest ? editorEl.closest('.query-editor-wrapper') : null;
	if (!wrapper) return;
	try { wrapper.style.height = '900px'; } catch { /* ignore */ }
	try { if (wrapper.dataset) wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
	try {
		const ed = (typeof pythonEditors === 'object' && pythonEditors) ? pythonEditors[id] : null;
		if (ed && typeof ed.layout === 'function') {
			ed.layout();
		}
	} catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoMaximizeUrlBox(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const wrapper = document.getElementById(id + '_wrapper');
	if (!wrapper) return;
	try {
		wrapper.style.height = '900px';
		if (wrapper.dataset) wrapper.dataset.kustoUserResized = 'true';
	} catch { /* ignore */ }
	// If this is a URL CSV section, clamp slack once layout settles.
	try {
		setTimeout(() => {
			try {
				if (typeof window.__kustoClampUrlCsvWrapperHeight === 'function') {
					window.__kustoClampUrlCsvWrapperHeight(id);
				}
			} catch { /* ignore */ }
		}, 0);
	} catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoEnsureMarkdownModeMap() {
	try {
		if (!window.__kustoMarkdownModeByBoxId || typeof window.__kustoMarkdownModeByBoxId !== 'object') {
			window.__kustoMarkdownModeByBoxId = {};
		}
	} catch {
		// ignore
	}
	return window.__kustoMarkdownModeByBoxId;
}

function __kustoGetMarkdownMode(boxId) {
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

function __kustoSetMarkdownMode(boxId, mode) {
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
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoUpdateMarkdownModeButtons(boxId) {
	const mode = __kustoGetMarkdownMode(boxId);
	const ids = {
		preview: boxId + '_md_mode_preview',
		markdown: boxId + '_md_mode_markdown',
		wysiwyg: boxId + '_md_mode_wysiwyg'
	};
	for (const key of Object.keys(ids)) {
		const btn = document.getElementById(ids[key]);
		if (!btn) continue;
		const active = key === mode;
		try { btn.classList.toggle('is-active', active); } catch { /* ignore */ }
		try { btn.setAttribute('aria-selected', active ? 'true' : 'false'); } catch { /* ignore */ }
	}
}

function __kustoUpdateMarkdownPreviewSizing(boxId) {
	const box = document.getElementById(boxId);
	const editorHost = document.getElementById(boxId + '_md_editor');
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

function __kustoApplyMarkdownEditorMode(boxId) {
	__kustoUpdateMarkdownModeButtons(boxId);

	const box = document.getElementById(boxId);
	const editorHost = document.getElementById(boxId + '_md_editor');
	const viewerHost = document.getElementById(boxId + '_md_viewer');
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
}

function isLikelyDarkTheme() {
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

function getToastUiPlugins(ToastEditor) {
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

function ensureMarkedGlobal() {
	// Marked may have registered itself as an AMD module (because Monaco installs `define.amd`)
	// instead of attaching to `window.marked`. Preview rendering expects `marked` to exist,
	// so if it's missing, try to resolve it from the AMD loader.
	try {
		if (typeof marked !== 'undefined' && marked) {
			return Promise.resolve(marked);
		}
	} catch {
		// ignore
	}

	if (markdownMarkedResolvePromise) {
		return markdownMarkedResolvePromise;
	}

	markdownMarkedResolvePromise = new Promise((resolve) => {
		try {
			if (typeof require === 'function') {
				require(
					['marked'],
					(m) => {
						try {
							if (typeof marked === 'undefined' || !marked) {
								// Best-effort: make it available as a global for the existing renderer.
								window.marked = m;
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

function autoSizeInputToValue(inputEl, minPx, maxPx) {
	if (!inputEl) {
		return;
	}
	try {
		inputEl.style.width = '1px';
		const pad = 2;
		const w = Math.max(minPx, Math.min(maxPx, (inputEl.scrollWidth || 0) + pad));
		inputEl.style.width = w + 'px';
	} catch {
		// ignore
	}
}

function onUrlNameInput(boxId) {
	const input = document.getElementById(boxId + '_name');
	let minPx = 25;
	try {
		const v = input ? String(input.value || '') : '';
		if (!v.trim()) {
			minPx = 140;
		}
	} catch {
		// ignore
	}
	autoSizeInputToValue(input, minPx, 250);
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoUpdateUrlToggleButton(boxId) {
	const btn = document.getElementById(boxId + '_toggle');
	const st = urlStateByBoxId[boxId];
	if (!btn || !st) {
		return;
	}
	const expanded = !!st.expanded;
	btn.classList.toggle('is-active', expanded);
	btn.setAttribute('aria-selected', expanded ? 'true' : 'false');
	btn.title = expanded ? 'Hide' : 'Show';
	btn.setAttribute('aria-label', expanded ? 'Hide' : 'Show');
}

function addMarkdownBox(options) {
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
			window.__kustoPendingMarkdownTextByBoxId = window.__kustoPendingMarkdownTextByBoxId || {};
			window.__kustoPendingMarkdownTextByBoxId[id] = initialText;
		}
	} catch {
		// ignore
	}

	const container = document.getElementById('queries-container');
	if (!container) {
		return;
	}

	const closeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M4 4l8 8"/>' +
		'<path d="M12 4L4 12"/>' +
		'</svg>';

	const previewIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z" />' +
		'<circle cx="8" cy="8" r="2.1" />' +
		'</svg>';

	const maximizeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 6V3h3" />' +
		'<path d="M13 10v3h-3" />' +
		'<path d="M6 3H3v3" opacity="0" />' +
		'<path d="M3 3l4 4" />' +
		'<path d="M13 13l-4-4" />' +
		'</svg>';

	const boxHtml =
		'<div class="query-box" id="' + id + '">' +
		'<div class="query-header">' +
		'<div class="query-header-row query-header-row-top">' +
		'<div class="query-name-group">' +
		'<button type="button" class="section-drag-handle" draggable="true" title="Drag to reorder" aria-label="Reorder section"><span class="section-drag-handle-glyph" aria-hidden="true">⋮</span></button>' +
		'<input type="text" class="query-name" placeholder="Markdown name (optional)" id="' + id + '_name" oninput="try{schedulePersist&&schedulePersist()}catch{}" />' +
		'</div>' +
		'<div class="section-actions">' +
		'<div class="md-tabs" role="tablist" aria-label="Markdown visibility">' +
		'<button class="md-tab md-mode-btn" id="' + id + '_md_mode_wysiwyg" type="button" role="tab" aria-selected="false" onclick="__kustoSetMarkdownMode(\'' + id + '\', \'wysiwyg\')" title="WYSIWYG" aria-label="WYSIWYG">WYSIWYG</button>' +
		'<button class="md-tab md-mode-btn" id="' + id + '_md_mode_markdown" type="button" role="tab" aria-selected="false" onclick="__kustoSetMarkdownMode(\'' + id + '\', \'markdown\')" title="Markdown" aria-label="Markdown">Markdown</button>' +
		'<button class="md-tab md-mode-btn" id="' + id + '_md_mode_preview" type="button" role="tab" aria-selected="false" onclick="__kustoSetMarkdownMode(\'' + id + '\', \'preview\')" title="Preview" aria-label="Preview">Preview</button>' +
		'<span class="md-tabs-divider" aria-hidden="true"></span>' +
		'<button class="md-tab md-max-btn" id="' + id + '_md_max" type="button" onclick="__kustoMaximizeMarkdownBox(\'' + id + '\')" title="Maximize" aria-label="Maximize">' + maximizeIconSvg + '</button>' +
		'<button class="md-tab" id="' + id + '_toggle" type="button" role="tab" aria-selected="false" onclick="toggleMarkdownBoxVisibility(\'' + id + '\')" title="Hide" aria-label="Hide">' + previewIconSvg + '</button>' +
		'</div>' +
		'<button class="refresh-btn close-btn" type="button" onclick="removeMarkdownBox(\'' + id + '\')" title="Remove" aria-label="Remove">' + closeIconSvg + '</button>' +
		'</div>' +
		'</div>' +
		'</div>' +
		'<div class="query-editor-wrapper">' +
		'<div class="query-editor kusto-markdown-editor" id="' + id + '_md_editor"></div>' +
		'<div class="markdown-viewer" id="' + id + '_md_viewer" style="display:none;"></div>' +
		'<div class="query-editor-resizer" id="' + id + '_md_resizer" title="Drag to resize"></div>' +
		'</div>' +
		'</div>';

	container.insertAdjacentHTML('beforeend', boxHtml);
	// Do not auto-assign a name; section names are user-defined.

	// Apply any persisted height before initializing the editor/mode.
	try {
		const h = options && typeof options.editorHeightPx === 'number' ? options.editorHeightPx : undefined;
		// For plain .md files we use a fixed viewport layout (internal editor scrolling),
		// so ignore any persisted wrapper height.
		const isPlainMd = String(window.__kustoDocumentKind || '') === 'md';
		if (!isPlainMd && typeof h === 'number' && Number.isFinite(h) && h > 0) {
			const editorEl = document.getElementById(id + '_md_editor');
			const wrapper = editorEl && editorEl.closest ? editorEl.closest('.query-editor-wrapper') : null;
			if (wrapper) {
				wrapper.style.height = Math.round(h) + 'px';
				try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
			}
		}
	} catch {
		// ignore
	}

	initMarkdownEditor(id);
	try { __kustoApplyMarkdownEditorMode(id); } catch { /* ignore */ }
	try { __kustoUpdateMarkdownVisibilityToggleButton(id); } catch { /* ignore */ }
	try { __kustoApplyMarkdownBoxVisibility(id); } catch { /* ignore */ }
	// Plain .md files: do not auto-expand the box to content; keep the toolbar visible and
	// scroll inside the editor surface instead.
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
	try {
		const isPlainMd = String(window.__kustoDocumentKind || '') === 'md';
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

function __kustoAutoFitMarkdownBoxHeight(boxId) {
	const tryFit = () => {
		try {
			const container = document.getElementById(boxId + '_md_editor');
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

function removeMarkdownBox(boxId) {
	if (markdownEditors[boxId]) {
		try { markdownEditors[boxId].dispose(); } catch { /* ignore */ }
		delete markdownEditors[boxId];
	}
	if (markdownViewers[boxId]) {
		try { markdownViewers[boxId].dispose(); } catch { /* ignore */ }
		delete markdownViewers[boxId];
	}
	markdownBoxes = markdownBoxes.filter(id => id !== boxId);
	const box = document.getElementById(boxId);
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
	try {
		if (window.__kustoMarkdownModeByBoxId && typeof window.__kustoMarkdownModeByBoxId === 'object') {
			delete window.__kustoMarkdownModeByBoxId[boxId];
		}
	} catch { /* ignore */ }
}

function __kustoUpdateMarkdownVisibilityToggleButton(boxId) {
	const btn = document.getElementById(boxId + '_toggle');
	if (!btn) {
		return;
	}
	let expanded = true;
	try {
		expanded = !(window.__kustoMarkdownExpandedByBoxId && window.__kustoMarkdownExpandedByBoxId[boxId] === false);
	} catch { /* ignore */ }
	btn.classList.toggle('is-active', expanded);
	btn.setAttribute('aria-selected', expanded ? 'true' : 'false');
	btn.title = expanded ? 'Hide' : 'Show';
	btn.setAttribute('aria-label', expanded ? 'Hide' : 'Show');
}

function __kustoApplyMarkdownBoxVisibility(boxId) {
	const box = document.getElementById(boxId);
	if (!box) {
		return;
	}
	let expanded = true;
	try {
		expanded = !(window.__kustoMarkdownExpandedByBoxId && window.__kustoMarkdownExpandedByBoxId[boxId] === false);
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

function toggleMarkdownBoxVisibility(boxId) {
	try {
		if (!window.__kustoMarkdownExpandedByBoxId || typeof window.__kustoMarkdownExpandedByBoxId !== 'object') {
			window.__kustoMarkdownExpandedByBoxId = {};
		}
		const current = !(window.__kustoMarkdownExpandedByBoxId[boxId] === false);
		window.__kustoMarkdownExpandedByBoxId[boxId] = !current;
	} catch { /* ignore */ }
	try { __kustoUpdateMarkdownVisibilityToggleButton(boxId); } catch { /* ignore */ }
	try { __kustoApplyMarkdownBoxVisibility(boxId); } catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function initMarkdownViewer(boxId, initialValue) {
	const container = document.getElementById(boxId + '_md_viewer');
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
		ToastEditor = (window.toastui && window.toastui.Editor) ? window.toastui.Editor : null;
	} catch {
		ToastEditor = null;
	}

	if (!ToastEditor) {
		// Webview scripts load sequentially, but keep a small retry loop for safety.
		let attempt = 0;
		try {
			window.__kustoToastUiViewerInitRetryCountByBoxId = window.__kustoToastUiViewerInitRetryCountByBoxId || {};
			attempt = (window.__kustoToastUiViewerInitRetryCountByBoxId[boxId] || 0) + 1;
			window.__kustoToastUiViewerInitRetryCountByBoxId[boxId] = attempt;
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
		const opts = {
			el: container,
			viewer: true,
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
	} catch (e) {
		try { console.error('Failed to initialize TOAST UI Editor (markdown viewer).', e); } catch { /* ignore */ }
		return;
	}

	try { __kustoRewriteToastUiImagesInContainer(container); } catch { /* ignore */ }

	markdownViewers[boxId] = {
		setValue: (value) => {
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

function initMarkdownEditor(boxId) {
	const container = document.getElementById(boxId + '_md_editor');
	const viewer = document.getElementById(boxId + '_md_viewer');
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
		ToastEditor = (window.toastui && window.toastui.Editor) ? window.toastui.Editor : null;
	} catch {
		ToastEditor = null;
	}

	if (!ToastEditor) {
		// Webview scripts load sequentially, but keep a small retry loop for safety.
		let attempt = 0;
		try {
			window.__kustoToastUiInitRetryCountByBoxId = window.__kustoToastUiInitRetryCountByBoxId || {};
			attempt = (window.__kustoToastUiInitRetryCountByBoxId[boxId] || 0) + 1;
			window.__kustoToastUiInitRetryCountByBoxId[boxId] = attempt;
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
		const pending = window.__kustoPendingMarkdownTextByBoxId && window.__kustoPendingMarkdownTextByBoxId[boxId];
		if (typeof pending === 'string') {
			initialValue = pending;
			try { delete window.__kustoPendingMarkdownTextByBoxId[boxId]; } catch { /* ignore */ }
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

	let toastEditor = null;
	try {
		const editorOptions = {
			el: container,
			height: '100%',
			initialEditType: 'wysiwyg',
			previewStyle: 'vertical',
			hideModeSwitch: true,
			usageStatistics: false,
			initialValue,
			plugins: getToastUiPlugins(ToastEditor),
			events: {
				change: () => {
					try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
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
	} catch (e) {
		try { console.error('Failed to initialize TOAST UI Editor (markdown editor).', e); } catch { /* ignore */ }
		return;
	}

	// Initial pass (in case the preview has already rendered by the time the hook is attached).
	try { __kustoRewriteToastUiImagesInContainer(container); } catch { /* ignore */ }

	const api = {
		getValue: () => {
			try { return toastEditor && typeof toastEditor.getMarkdown === 'function' ? String(toastEditor.getMarkdown() || '') : ''; } catch { return ''; }
		},
		setValue: (value) => {
			try {
				if (toastEditor && typeof toastEditor.setMarkdown === 'function') {
					toastEditor.setMarkdown(String(value || ''));
				}
			} catch { /* ignore */ }
		},
		layout: () => {
			try {
				if (!toastEditor || typeof toastEditor.setHeight !== 'function') {
					return;
				}
				const wrapper = container.closest ? container.closest('.query-editor-wrapper') : null;
				const resizer = document.getElementById(boxId + '_md_resizer');
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
	try { __kustoApplyMarkdownEditorMode(boxId); } catch { /* ignore */ }
	try { __kustoTryApplyPendingMarkdownReveal(boxId); } catch { /* ignore */ }

	// Ensure theme switches (dark/light) are reflected without recreating the editor.
	try { __kustoStartToastUiThemeObserver(); } catch { /* ignore */ }
	try { __kustoApplyToastUiThemeAll(); } catch { /* ignore */ }

	// Drag handle resize (same pattern as the KQL editor).
	try {
		const wrapper = container.closest ? container.closest('.query-editor-wrapper') : null;
		const resizer = document.getElementById(boxId + '_md_resizer');
		if (wrapper && resizer) {
			resizer.addEventListener('mousedown', (e) => {
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

				const startPageY = e.clientY + (typeof __kustoGetScrollY === 'function' ? __kustoGetScrollY() : 0);
				const startHeight = wrapper.getBoundingClientRect().height;

				const onMove = (moveEvent) => {
					try {
						if (typeof __kustoMaybeAutoScrollWhileDragging === 'function') {
							__kustoMaybeAutoScrollWhileDragging(moveEvent.clientY);
						}
					} catch { /* ignore */ }
					const pageY = moveEvent.clientY + (typeof __kustoGetScrollY === 'function' ? __kustoGetScrollY() : 0);
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
					try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
				};

				document.addEventListener('mousemove', onMove, true);
				document.addEventListener('mouseup', onUp, true);
			});
		}
	} catch {
		// ignore
	}

	// Ensure correct initial sizing.
	try { api.layout(); } catch { /* ignore */ }
}

function __kustoRewriteToastUiImagesInContainer(rootEl) {
	try {
		if (!rootEl || !rootEl.querySelectorAll) {
			return;
		}
		const baseUri = (() => {
			try {
				return (typeof window.__kustoDocumentUri === 'string') ? String(window.__kustoDocumentUri) : '';
			} catch {
				return '';
			}
		})();
		if (!baseUri) {
			return;
		}

		// Cache across renders to avoid spamming the extension host.
		window.__kustoResolvedImageSrcCache = window.__kustoResolvedImageSrcCache || {};
		const cache = window.__kustoResolvedImageSrcCache;

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
					lower.startsWith('data:') ||
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

				const resolver = window.__kustoResolveResourceUri;
				if (typeof resolver !== 'function') {
					continue;
				}

				// Fire-and-forget async resolve; preview is re-rendered frequently.
				resolver({ path: src, baseUri }).then((resolved) => {
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

function addPythonBox(options) {
	const id = (options && options.id) ? String(options.id) : ('python_' + Date.now());
	pythonBoxes.push(id);

	const container = document.getElementById('queries-container');
	if (!container) {
		return;
	}

	const closeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M4 4l8 8"/>' +
		'<path d="M12 4L4 12"/>' +
		'</svg>';

	const maximizeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 6V3h3" />' +
		'<path d="M13 10v3h-3" />' +
		'<path d="M3 3l4 4" />' +
		'<path d="M13 13l-4-4" />' +
		'</svg>';

	const boxHtml =
		'<div class="query-box" id="' + id + '">' +
		'<div class="section-header-row">' +
		'<button type="button" class="section-drag-handle" draggable="true" title="Drag to reorder" aria-label="Reorder section"><span class="section-drag-handle-glyph" aria-hidden="true">⋮</span></button>' +
		'<div class="section-title">Python</div>' +
		'<div class="section-actions">' +
		'<div class="md-tabs" role="tablist" aria-label="Python controls">' +
		'<button class="md-tab md-max-btn" id="' + id + '_max" type="button" onclick="__kustoMaximizePythonBox(\'' + id + '\')" title="Maximize" aria-label="Maximize">' + maximizeIconSvg + '</button>' +
		'</div>' +
		'<button class="section-btn" type="button" onclick="runPythonBox(\'' + id + '\')" title="Run Python">▶ Run</button>' +
		'<button class="section-btn" type="button" onclick="removePythonBox(\'' + id + '\')" title="Remove" aria-label="Remove">' + closeIconSvg + '</button>' +
		'</div>' +
		'</div>' +
		'<div class="query-editor-wrapper">' +
		'<div class="query-editor" id="' + id + '_py_editor"></div>' +
		'<div class="query-editor-resizer" id="' + id + '_py_resizer" title="Drag to resize editor"></div>' +
		'</div>' +
		'<div class="python-output" id="' + id + '_py_output" aria-label="Python output"></div>' +
		'</div>';

	container.insertAdjacentHTML('beforeend', boxHtml);
	// Do not auto-assign a name; this section type does not use names.
	initPythonEditor(id);
	setPythonOutput(id, '');
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
	try {
		const controls = document.querySelector('.add-controls');
		if (controls && typeof controls.scrollIntoView === 'function') {
			controls.scrollIntoView({ block: 'end' });
		}
	} catch {
		// ignore
	}
	return id;
}

function removePythonBox(boxId) {
	if (pythonEditors[boxId]) {
		try { pythonEditors[boxId].dispose(); } catch { /* ignore */ }
		delete pythonEditors[boxId];
	}
	pythonBoxes = pythonBoxes.filter(id => id !== boxId);
	const box = document.getElementById(boxId);
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function initPythonEditor(boxId) {
	return ensureMonaco().then(monaco => {
		const container = document.getElementById(boxId + '_py_editor');
		if (!container) {
			return;
		}

		// If an editor exists, ensure it's still attached to this container.
		try {
			const existing = pythonEditors && pythonEditors[boxId] ? pythonEditors[boxId] : null;
			if (existing) {
				const dom = (typeof existing.getDomNode === 'function') ? existing.getDomNode() : null;
				const attached = !!(dom && dom.isConnected && container.contains(dom));
				if (attached) {
					return;
				}
				try { existing.dispose(); } catch { /* ignore */ }
				try { delete pythonEditors[boxId]; } catch { /* ignore */ }
			}
		} catch {
			// ignore
		}

		container.style.minHeight = '0';
		container.style.minWidth = '0';

		// Avoid editor.setValue() during init; pass initial value into create() to reduce timing races.
		let initialValue = '';
		try {
			const pending = window.__kustoPendingPythonCodeByBoxId && window.__kustoPendingPythonCodeByBoxId[boxId];
			if (typeof pending === 'string') {
				initialValue = pending;
				try { delete window.__kustoPendingPythonCodeByBoxId[boxId]; } catch { /* ignore */ }
			}
		} catch {
			// ignore
		}

		const editor = monaco.editor.create(container, {
			value: initialValue,
			language: 'python',
			readOnly: false,
			domReadOnly: false,
			automaticLayout: true,
			fixedOverflowWidgets: true,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			fontFamily: getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family'),
			fontSize: 13,
			lineNumbers: 'on',
			renderLineHighlight: 'none'
		});

		// Mark this as the active Monaco editor for global key handlers (paste, etc.).
		try {
			if (typeof editor.onDidFocusEditorText === 'function') {
				editor.onDidFocusEditorText(() => {
					try { activeMonacoEditor = editor; } catch { /* ignore */ }
					try {
						if (typeof __kustoForceEditorWritable === 'function') {
							__kustoForceEditorWritable(editor);
						}
					} catch { /* ignore */ }
				});
			}
			if (typeof editor.onDidFocusEditorWidget === 'function') {
				editor.onDidFocusEditorWidget(() => {
					try { activeMonacoEditor = editor; } catch { /* ignore */ }
					try {
						if (typeof __kustoForceEditorWritable === 'function') {
							__kustoForceEditorWritable(editor);
						}
					} catch { /* ignore */ }
				});
			}
		} catch {
			// ignore
		}

		pythonEditors[boxId] = editor;
		// Work around sporadic webview timing issues where Monaco input can end up stuck readonly.
		try {
			if (typeof __kustoEnsureEditorWritableSoon === 'function') {
				__kustoEnsureEditorWritableSoon(editor);
			}
		} catch {
			// ignore
		}
		try {
			if (typeof __kustoInstallWritableGuard === 'function') {
				__kustoInstallWritableGuard(editor);
			}
		} catch {
			// ignore
		}
		// If the editor is stuck non-interactive on click, force writable before focusing.
		try {
			container.addEventListener('mousedown', () => {
				try {
					if (typeof __kustoForceEditorWritable === 'function') {
						__kustoForceEditorWritable(editor);
					}
				} catch { /* ignore */ }
				try { editor.focus(); } catch { /* ignore */ }
			}, true);
		} catch {
			// ignore
		}
		// Auto-resize editor to show full content, until the user manually resizes.
		try {
			if (typeof __kustoAttachAutoResizeToContent === 'function') {
				__kustoAttachAutoResizeToContent(editor, container);
			}
		} catch {
			// ignore
		}
		try {
			editor.onDidChangeModelContent(() => {
				try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
			});
		} catch {
			// ignore
		}

		// Drag handle resize (copied from KQL editor behavior).
		try {
			const wrapper = container.closest ? container.closest('.query-editor-wrapper') : null;
			const resizer = document.getElementById(boxId + '_py_resizer');
			if (wrapper && resizer) {
				resizer.addEventListener('mousedown', (e) => {
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

						const startPageY = e.clientY + (typeof __kustoGetScrollY === 'function' ? __kustoGetScrollY() : 0);
					const startHeight = wrapper.getBoundingClientRect().height;

					const onMove = (moveEvent) => {
							try {
								if (typeof __kustoMaybeAutoScrollWhileDragging === 'function') {
									__kustoMaybeAutoScrollWhileDragging(moveEvent.clientY);
								}
							} catch { /* ignore */ }
							const pageY = moveEvent.clientY + (typeof __kustoGetScrollY === 'function' ? __kustoGetScrollY() : 0);
							const delta = pageY - startPageY;
						const nextHeight = Math.max(120, Math.min(900, startHeight + delta));
						wrapper.style.height = nextHeight + 'px';
						try { editor.layout(); } catch { /* ignore */ }
					};
					const onUp = () => {
						document.removeEventListener('mousemove', onMove, true);
						document.removeEventListener('mouseup', onUp, true);
						resizer.classList.remove('is-dragging');
						document.body.style.cursor = previousCursor;
						document.body.style.userSelect = previousUserSelect;
						try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
					};

					document.addEventListener('mousemove', onMove, true);
					document.addEventListener('mouseup', onUp, true);
				});
			}
		} catch {
			// ignore
		}
	}).catch((e) => {
		try {
			if (pythonEditors && pythonEditors[boxId]) {
				return;
			}
		} catch {
			// ignore
		}

		let attempt = 0;
		try {
			window.__kustoMonacoInitRetryCountByBoxId = window.__kustoMonacoInitRetryCountByBoxId || {};
			attempt = (window.__kustoMonacoInitRetryCountByBoxId[boxId] || 0) + 1;
			window.__kustoMonacoInitRetryCountByBoxId[boxId] = attempt;
		} catch {
			attempt = 1;
		}

		const delays = [50, 250, 1000, 2000, 4000];
		const delay = delays[Math.min(attempt - 1, delays.length - 1)];
		if (attempt > delays.length) {
			try { console.error('Monaco init failed (python editor).', e); } catch { /* ignore */ }
			return;
		}
		try {
			setTimeout(() => {
				try { initPythonEditor(boxId); } catch { /* ignore */ }
			}, delay);
		} catch {
			// ignore
		}
	});
}

function setPythonOutput(boxId, text) {
	const out = document.getElementById(boxId + '_py_output');
	if (!out) {
		return;
	}
	out.textContent = String(text || '');
}

function runPythonBox(boxId) {
	const editor = pythonEditors[boxId];
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	const code = model ? model.getValue() : '';
	setPythonOutput(boxId, 'Running…');
	try {
		vscode.postMessage({ type: 'executePython', boxId, code });
	} catch (e) {
		setPythonOutput(boxId, 'Failed to send run request.');
	}
}

function onPythonResult(message) {
	const boxId = message && message.boxId ? String(message.boxId) : '';
	if (!boxId) {
		return;
	}
	const stdout = String(message.stdout || '');
	const stderr = String(message.stderr || '');
	const exitCode = (typeof message.exitCode === 'number') ? message.exitCode : null;
	let out = '';
	if (stdout.trim()) {
		out += stdout;
	}
	if (stderr.trim()) {
		if (out) out += '\n\n';
		out += stderr;
	}
	if (!out) {
		out = (exitCode === 0) ? '' : 'No output.';
	}
	setPythonOutput(boxId, out);
}

function onPythonError(message) {
	const boxId = message && message.boxId ? String(message.boxId) : '';
	if (!boxId) {
		return;
	}
	setPythonOutput(boxId, String(message.error || 'Python execution failed.'));
}

function addUrlBox(options) {
	const id = (options && options.id) ? String(options.id) : ('url_' + Date.now());
	urlBoxes.push(id);
	// Default to collapsed (view off) so a new URL section is as small as possible.
	urlStateByBoxId[id] = { url: '', expanded: false, loading: false, loaded: false, content: '', error: '', kind: '', contentType: '', status: null, dataUri: '', body: '', truncated: false };

	const container = document.getElementById('queries-container');
	if (!container) {
		return;
	}

	const closeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M4 4l8 8"/>' +
		'<path d="M12 4L4 12"/>' +
		'</svg>';

	const previewIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z" />' +
		'<circle cx="8" cy="8" r="2.1" />' +
		'</svg>';

	const maximizeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 6V3h3" />' +
		'<path d="M13 10v3h-3" />' +
		'<path d="M3 3l4 4" />' +
		'<path d="M13 13l-4-4" />' +
		'</svg>';

	const boxHtml =
		'<div class="query-box url-box" id="' + id + '">' +
		'<div class="section-header-row url-section-header">' +
		'<button type="button" class="section-drag-handle" draggable="true" title="Drag to reorder" aria-label="Reorder section"><span class="section-drag-handle-glyph" aria-hidden="true">⋮</span></button>' +
		'<input class="query-name url-name" id="' + id + '_name" type="text" placeholder="URL name (optional)" oninput="onUrlNameInput(\'' + id + '\')" />' +
		'<input class="url-input" id="' + id + '_input" type="text" placeholder="https://example.com" oninput="onUrlChanged(\'' + id + '\')" />' +
		'<div class="section-actions">' +
		'<div class="md-tabs" role="tablist" aria-label="URL visibility">' +
		'<button class="md-tab md-max-btn" id="' + id + '_max" type="button" onclick="__kustoMaximizeUrlBox(\'' + id + '\')" title="Maximize" aria-label="Maximize">' + maximizeIconSvg + '</button>' +
		'<button class="md-tab" id="' + id + '_toggle" type="button" role="tab" aria-selected="false" onclick="toggleUrlBox(\'' + id + '\')" title="Show" aria-label="Show">' + previewIconSvg + '</button>' +
		'</div>' +
		'<button class="refresh-btn close-btn" type="button" onclick="removeUrlBox(\'' + id + '\')" title="Remove" aria-label="Remove">' + closeIconSvg + '</button>' +
		'</div>' +
		'</div>' +
		'<div class="url-output-wrapper" id="' + id + '_wrapper">' +
		'<div class="url-output" id="' + id + '_content" aria-label="URL content"></div>' +
		'<div class="query-editor-resizer" id="' + id + '_url_resizer" title="Drag to resize"></div>' +
		'</div>' +
		'</div>';

	container.insertAdjacentHTML('beforeend', boxHtml);
	try { __kustoUpdateUrlToggleButton(id); } catch { /* ignore */ }
	try { updateUrlContent(id); } catch { /* ignore */ }
	try { onUrlNameInput(id); } catch { /* ignore */ }

	// Ensure an explicit minimum height is present so it round-trips through persistence.
	// (When collapsed, the wrapper is display:none so it doesn't affect layout.)
	try {
		const wrapper = document.getElementById(id + '_wrapper');
		if (wrapper && (!wrapper.style.height || wrapper.style.height === 'auto')) {
			wrapper.style.height = '120px';
		}
	} catch { /* ignore */ }

	// Drag handle resize for URL output.
	try {
		const wrapper = document.getElementById(id + '_wrapper');
		const resizer = document.getElementById(id + '_url_resizer');
		if (wrapper && resizer) {
			resizer.addEventListener('mousedown', (e) => {
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

				const startPageY = e.clientY + (typeof __kustoGetScrollY === 'function' ? __kustoGetScrollY() : 0);
				const startHeight = wrapper.getBoundingClientRect().height;
				// If the wrapper was auto-sized (e.g. URL CSV fitting its contents), freeze the
				// current pixel height so resizing doesn't immediately jump.
				try {
					wrapper.style.height = Math.max(0, Math.ceil(startHeight)) + 'px';
				} catch { /* ignore */ }

				let minH = 120;
				let maxH = 900;
				let csvMaxH = null;
				try {
					const contentEl = document.getElementById(id + '_content');
					const isCsvMode = !!(contentEl && contentEl.classList && contentEl.classList.contains('url-csv-mode'));
					if (isCsvMode) {
						// Prevent a resize "jump" when auto-sized smaller than 120px, but still allow
						// shrinking below the current height when the content is tall.
						minH = Math.max(0, Math.min(120, Math.ceil(startHeight)));
						// Also clamp the maximum height to the natural content height to avoid
						// blank slack below short CSV results.
						try {
							const tableContainer = contentEl.querySelector ? contentEl.querySelector('.table-container') : null;
							if (tableContainer && typeof tableContainer.scrollHeight === 'number') {
								const overheadPx = Math.max(0, Math.ceil(wrapper.getBoundingClientRect().height) - (tableContainer.clientHeight || 0));
								const desiredPx = Math.max(0, Math.ceil(overheadPx + tableContainer.scrollHeight + 10));
								if (desiredPx > 0) {
									csvMaxH = desiredPx;
									maxH = Math.min(maxH, desiredPx);
								}
							}
						} catch { /* ignore */ }
					}
				} catch { /* ignore */ }

				const onMove = (moveEvent) => {
					try {
						if (typeof __kustoMaybeAutoScrollWhileDragging === 'function') {
							__kustoMaybeAutoScrollWhileDragging(moveEvent.clientY);
						}
					} catch { /* ignore */ }
					const pageY = moveEvent.clientY + (typeof __kustoGetScrollY === 'function' ? __kustoGetScrollY() : 0);
					const delta = pageY - startPageY;
					const nextHeight = Math.max(minH, Math.min(maxH, startHeight + delta));
					wrapper.style.height = nextHeight + 'px';
					// Best-effort: keep CSV wrappers from ever being taller than contents.
					try {
						if (csvMaxH && nextHeight > (csvMaxH + 1) && typeof window.__kustoClampUrlCsvWrapperHeight === 'function') {
							window.__kustoClampUrlCsvWrapperHeight(id);
						}
					} catch { /* ignore */ }
				};
				const onUp = () => {
					document.removeEventListener('mousemove', onMove, true);
					document.removeEventListener('mouseup', onUp, true);
					resizer.classList.remove('is-dragging');
					document.body.style.cursor = previousCursor;
					document.body.style.userSelect = previousUserSelect;
					try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
				};

				document.addEventListener('mousemove', onMove, true);
				document.addEventListener('mouseup', onUp, true);
			});
		}
	} catch {
		// ignore
	}

	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
	try {
		const controls = document.querySelector('.add-controls');
		if (controls && typeof controls.scrollIntoView === 'function') {
			controls.scrollIntoView({ block: 'end' });
		}
	} catch {
		// ignore
	}
	return id;
}

function removeUrlBox(boxId) {
	delete urlStateByBoxId[boxId];
	urlBoxes = urlBoxes.filter(id => id !== boxId);
	const box = document.getElementById(boxId);
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function onUrlChanged(boxId) {
	const input = document.getElementById(boxId + '_input');
	if (!input) {
		return;
	}
	const url = String(input.value || '').trim();
	if (!urlStateByBoxId[boxId]) {
		urlStateByBoxId[boxId] = { url: '', expanded: false, loading: false, loaded: false, content: '', error: '', kind: '', contentType: '', status: null, dataUri: '', body: '', truncated: false };
	}
	urlStateByBoxId[boxId].url = url;
	urlStateByBoxId[boxId].loaded = false;
	urlStateByBoxId[boxId].content = '';
	urlStateByBoxId[boxId].error = '';
	urlStateByBoxId[boxId].kind = '';
	urlStateByBoxId[boxId].contentType = '';
	urlStateByBoxId[boxId].status = null;
	urlStateByBoxId[boxId].dataUri = '';
	urlStateByBoxId[boxId].body = '';
	urlStateByBoxId[boxId].truncated = false;
	try { urlStateByBoxId[boxId].__hasFetchedOnce = false; } catch { /* ignore */ }
	try { urlStateByBoxId[boxId].__autoSizeImagePending = false; } catch { /* ignore */ }
	try { urlStateByBoxId[boxId].__autoSizedImageOnce = false; } catch { /* ignore */ }
	updateUrlContent(boxId);
	if (urlStateByBoxId[boxId].expanded && url) {
		requestUrlContent(boxId);
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function toggleUrlBox(boxId) {
	if (!urlStateByBoxId[boxId]) {
		urlStateByBoxId[boxId] = { url: '', expanded: true, loading: false, loaded: false, content: '', error: '', kind: '', contentType: '', status: null, dataUri: '', body: '', truncated: false };
	}
	urlStateByBoxId[boxId].expanded = !urlStateByBoxId[boxId].expanded;
	try { __kustoUpdateUrlToggleButton(boxId); } catch { /* ignore */ }
	updateUrlContent(boxId);
	if (urlStateByBoxId[boxId].expanded && urlStateByBoxId[boxId].url) {
		requestUrlContent(boxId);
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoClearElement(el) {
	try {
		while (el && el.firstChild) {
			el.removeChild(el.firstChild);
		}
	} catch {
		// ignore
	}
}

function __kustoParseCsv(text) {
	// Minimal CSV parser (RFC 4180-ish): supports quoted fields, commas, and newlines.
	const rows = [];
	let row = [];
	let field = '';
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (inQuotes) {
			if (ch === '"' && next === '"') {
				field += '"';
				i++;
				continue;
			}
			if (ch === '"') {
				inQuotes = false;
				continue;
			}
			field += ch;
			continue;
		}
		if (ch === '"') {
			inQuotes = true;
			continue;
		}
		if (ch === ',') {
			row.push(field);
			field = '';
			continue;
		}
		if (ch === '\r') {
			continue;
		}
		if (ch === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
			continue;
		}
		field += ch;
	}
	row.push(field);
	rows.push(row);
	return rows;
}

// Clamp the URL CSV output wrapper height so it cannot be taller than its contents.
// This avoids blank slack below short CSV results while still allowing the user to
// resize smaller than contents (scrolling).
function __kustoClampUrlCsvWrapperHeight(boxId) {
	try {
		const id = String(boxId || '').trim();
		if (!id) return;
		const wrapper = document.getElementById(id + '_wrapper');
		const contentEl = document.getElementById(id + '_content');
		if (!wrapper || !contentEl) return;
		if (!(contentEl.classList && contentEl.classList.contains('url-csv-mode'))) return;
		const tableContainer = contentEl.querySelector ? contentEl.querySelector('.table-container') : null;
		if (!tableContainer) return;

		const wrapperH = Math.max(0, Math.ceil(wrapper.getBoundingClientRect().height || 0));
		const tcClientH = Math.max(0, (tableContainer.clientHeight || 0));
		const tcScrollH = Math.max(0, (tableContainer.scrollHeight || 0));
		if (!tcScrollH) return;

		const overheadPx = Math.max(0, wrapperH - tcClientH);
		const desiredPx = Math.max(0, Math.ceil(overheadPx + tcScrollH + 10));
		if (!desiredPx) return;

		if (wrapperH > (desiredPx + 1)) {
			wrapper.style.height = desiredPx + 'px';
			wrapper.style.minHeight = '0';
			try {
				if (wrapper.dataset && wrapper.dataset.kustoUserResized === 'true') {
					wrapper.dataset.kustoPrevHeight = wrapper.style.height;
				}
			} catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
}

try {
	window.__kustoClampUrlCsvWrapperHeight = __kustoClampUrlCsvWrapperHeight;
} catch { /* ignore */ }

function __kustoRenderUrlContent(contentEl, st) {
	try {
		__kustoClearElement(contentEl);
		// Default for rich render.
		try { contentEl.style.whiteSpace = 'normal'; } catch { /* ignore */ }
		// Reset any mode-specific layout from previous renders.
		try { contentEl.classList.remove('url-csv-mode'); } catch { /* ignore */ }
		try { contentEl.style.overflow = ''; } catch { /* ignore */ }
		try { contentEl.style.display = ''; } catch { /* ignore */ }
		try { contentEl.style.flexDirection = ''; } catch { /* ignore */ }

		const kind = String(st.kind || '').toLowerCase();
		if (kind === 'image' && st.dataUri) {
			const img = document.createElement('img');
			// If this is the first fetch and the user hasn't resized, auto-size the wrapper to fit the image.
			const boxId = (() => {
				try {
					const id = contentEl && contentEl.id ? String(contentEl.id) : '';
					return id.endsWith('_content') ? id.slice(0, -('_content'.length)) : '';
				} catch {
					return '';
				}
			})();
			try {
				if (boxId && st.__autoSizeImagePending && !st.__autoSizedImageOnce) {
					img.addEventListener('load', () => {
						try {
							const wrapper = document.getElementById(boxId + '_wrapper');
							if (!wrapper) return;

							// Only auto-expand when the wrapper is still at the minimum height.
							// This intentionally also covers "restored" heights that equal the minimum.
							let currentH = 0;
							try { currentH = wrapper.getBoundingClientRect().height; } catch { /* ignore */ }
							const minH = 120;
							if (currentH && currentH > (minH + 1)) {
								st.__autoSizeImagePending = false;
								st.__autoSizedImageOnce = true;
								return;
							}

							// Ensure layout is up to date before measuring.
							setTimeout(() => {
								try {
									const resizer = document.getElementById(boxId + '_url_resizer');
									const resizerH = resizer ? resizer.getBoundingClientRect().height : 12;
									const imgH = img.getBoundingClientRect().height;
									if (!imgH || !isFinite(imgH)) return;
									const maxH = 3000;
									const nextH = Math.max(minH, Math.min(maxH, Math.ceil(imgH + resizerH)));
									wrapper.style.height = nextH + 'px';
									try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
									st.__autoSizeImagePending = false;
									st.__autoSizedImageOnce = true;
									try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
								} catch { /* ignore */ }
							}, 0);
						} catch { /* ignore */ }
					}, { once: true });
				}
			} catch {
				// ignore
			}

			img.src = String(st.dataUri);
			img.alt = 'Image';
			img.style.maxWidth = '100%';
			img.style.height = 'auto';
			img.style.display = 'block';
			contentEl.appendChild(img);
			return;
		}

		if (kind === 'csv' && typeof st.body === 'string') {
			// Match the query-results UX: summary row stays fixed; table scrolls.
			try {
				contentEl.classList.add('url-csv-mode');
			} catch { /* ignore */ }
			const boxId = (() => {
				try {
					const id = contentEl && contentEl.id ? String(contentEl.id) : '';
					return id.endsWith('_content') ? id.slice(0, -('_content'.length)) : '';
				} catch {
					return '';
				}
			})();

			const csvRows = __kustoParseCsv(st.body);
			let columns = [];
			let dataRows = [];
			if (csvRows.length > 0) {
				columns = Array.isArray(csvRows[0]) ? csvRows[0].map((c) => String(c ?? '')) : [];
				dataRows = csvRows.slice(1);
			}

			// Normalize ragged rows and ensure we have enough columns.
			let maxCols = columns.length;
			for (const r of dataRows) {
				if (Array.isArray(r) && r.length > maxCols) {
					maxCols = r.length;
				}
			}
			for (let i = columns.length; i < maxCols; i++) {
				columns.push('Column ' + (i + 1));
			}
			dataRows = dataRows.map((r) => {
				const row = Array.isArray(r) ? r : [];
				const out = new Array(maxCols);
				for (let i = 0; i < maxCols; i++) {
					out[i] = String(row[i] ?? '');
				}
				return out;
			});

			// Reuse the same tabular control as Kusto query results.
			if (boxId && typeof displayResultForBox === 'function') {
				const resultsDiv = document.createElement('div');
				resultsDiv.className = 'results visible';
				resultsDiv.id = boxId + '_results';
				contentEl.appendChild(resultsDiv);

				displayResultForBox(
					{ columns: columns, rows: dataRows, metadata: {} },
					boxId,
					{ label: 'CSV', showExecutionTime: false, resultsDiv: resultsDiv }
				);

				// Ensure only the table scrolls (not the whole URL output), just like query results.
				try {
					const tc = resultsDiv.querySelector('.table-container');
					if (tc && tc.style) {
						tc.style.maxHeight = 'none';
						tc.style.overflow = 'auto';
					}
				} catch { /* ignore */ }

				// If a persisted/manual height is larger than the CSV contents, clamp it.
				try {
					setTimeout(() => {
						try {
							if (typeof window.__kustoClampUrlCsvWrapperHeight === 'function') {
								window.__kustoClampUrlCsvWrapperHeight(boxId);
							}
						} catch { /* ignore */ }
					}, 0);
				} catch { /* ignore */ }
				return;
			}

			// Fallback: simple table if the tabular module isn't available.
			const wrapper = document.createElement('div');
			wrapper.className = 'url-table-container';
			const table = document.createElement('table');
			const thead = document.createElement('thead');
			const tbody = document.createElement('tbody');

			const headerRow = document.createElement('tr');
			for (const h of columns) {
				const th = document.createElement('th');
				th.textContent = String(h ?? '');
				headerRow.appendChild(th);
			}
			thead.appendChild(headerRow);

			for (const r of dataRows) {
				const tr = document.createElement('tr');
				for (const cell of r) {
					const td = document.createElement('td');
					td.textContent = String(cell ?? '');
					tr.appendChild(td);
				}
				tbody.appendChild(tr);
			}

			table.appendChild(thead);
			table.appendChild(tbody);
			wrapper.appendChild(table);
			contentEl.appendChild(wrapper);
			return;
		}

		if (kind === 'html' && typeof st.body === 'string') {
			// Render the page in an iframe using srcdoc, sanitized via DOMPurify if available.
			let html = String(st.body);
			try {
				const base = st.url ? ('<base href="' + String(st.url).replace(/"/g, '&quot;') + '">') : '';
				html = base + html;
			} catch { /* ignore */ }
			try {
				if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
					html = window.DOMPurify.sanitize(html, {
						ADD_TAGS: ['base'],
						ADD_ATTR: ['href', 'target', 'rel']
					});
				}
			} catch {
				// ignore
			}
			const iframe = document.createElement('iframe');
			iframe.style.width = '100%';
			iframe.style.height = '300px';
			iframe.style.border = 'none';
			iframe.setAttribute('sandbox', '');
			iframe.setAttribute('referrerpolicy', 'no-referrer');
			iframe.srcdoc = html;
			contentEl.appendChild(iframe);
			return;
		}

		// Default: show as text.
		try { contentEl.style.whiteSpace = 'pre-wrap'; } catch { /* ignore */ }
		const pre = document.createElement('pre');
		pre.style.whiteSpace = 'pre-wrap';
		pre.style.margin = '0';
		pre.textContent = String(st.body || st.content || '');
		contentEl.appendChild(pre);
	} catch {
		// ignore
	}
}

function updateUrlContent(boxId) {
	const boxEl = document.getElementById(boxId);
	const wrapperEl = document.getElementById(boxId + '_wrapper');
	const contentEl = document.getElementById(boxId + '_content');
	const st = urlStateByBoxId[boxId];
	if (!wrapperEl || !contentEl || !st) {
		return;
	}
	try {
		if (boxEl && boxEl.classList) {
			boxEl.classList.toggle('is-url-collapsed', !st.expanded);
		}
	} catch { /* ignore */ }
	wrapperEl.classList.toggle('url-collapsed', !st.expanded);
	if (!st.expanded) {
		return;
	}
	if (st.loading) {
		try { contentEl.style.whiteSpace = 'pre-wrap'; } catch { /* ignore */ }
		contentEl.textContent = 'Loading…';
		return;
	}
	if (st.error) {
		try { contentEl.style.whiteSpace = 'pre-wrap'; } catch { /* ignore */ }
		contentEl.textContent = st.error;
		return;
	}
	if (st.loaded) {
		__kustoRenderUrlContent(contentEl, st);
		return;
	}
	try { contentEl.style.whiteSpace = 'pre-wrap'; } catch { /* ignore */ }
	contentEl.textContent = st.url ? 'Ready to load.' : 'Enter a URL above.';
}

function requestUrlContent(boxId) {
	const st = urlStateByBoxId[boxId];
	if (!st || st.loading || st.loaded) {
		return;
	}
	const url = String(st.url || '').trim();
	if (!url) {
		return;
	}
	st.loading = true;
	st.error = '';
	updateUrlContent(boxId);
	try {
		vscode.postMessage({ type: 'fetchUrl', boxId, url });
	} catch {
		st.loading = false;
		st.error = 'Failed to request URL.';
		updateUrlContent(boxId);
	}
}

function onUrlContent(message) {
	const boxId = message && message.boxId ? String(message.boxId) : '';
	if (!boxId || !urlStateByBoxId[boxId]) {
		return;
	}
	const st = urlStateByBoxId[boxId];
	st.loading = false;
	st.loaded = true;
	st.error = '';
	st.url = String(message.url || st.url || '');
	st.contentType = String(message.contentType || st.contentType || '');
	st.status = (typeof message.status === 'number') ? message.status : (st.status ?? null);
	st.kind = String(message.kind || '').toLowerCase();
	st.truncated = !!message.truncated;
	st.dataUri = String(message.dataUri || '');
	st.body = (typeof message.body === 'string') ? message.body : '';
	// Track first successful fetch; used for one-time auto-sizing of images.
	try {
		if (!st.__hasFetchedOnce) {
			st.__hasFetchedOnce = true;
			if (st.kind === 'image') {
				st.__autoSizeImagePending = true;
			}
		}
	} catch { /* ignore */ }
	// Keep a simple fallback string for older rendering.
	st.content = st.body || '';
	updateUrlContent(boxId);
}

function onUrlError(message) {
	const boxId = message && message.boxId ? String(message.boxId) : '';
	if (!boxId || !urlStateByBoxId[boxId]) {
		return;
	}
	const st = urlStateByBoxId[boxId];
	st.loading = false;
	st.loaded = false;
	st.content = '';
	st.error = String(message.error || 'Failed to load URL.');
	updateUrlContent(boxId);
}
