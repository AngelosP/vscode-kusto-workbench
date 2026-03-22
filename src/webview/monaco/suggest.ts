// Monaco suggest widget management — extracted from monaco.ts (Phase 6 decomposition).
// Handles suggest widget visibility, cursor-word detection, preselect, and smart sizing.

import { queryEditors } from './state';

let _suggestWidgetScrollDismissInstalled = false;
let _suggestWidgetViewportListenersInstalled = false;
let _clampAllSuggestWidgets: (() => void) | null = null;
export function __kustoIsElementVisibleForSuggest(el: any) {
	try {
		if (!el) return false;
		// Most Monaco builds keep `aria-hidden` in sync.
		try {
			const ariaHidden = String((el.getAttribute && el.getAttribute('aria-hidden')) || '').toLowerCase();
			if (ariaHidden === 'true') return false;
		} catch (e) { console.error('[kusto]', e); }
		try {
			const cs = (typeof getComputedStyle === 'function') ? getComputedStyle(el) : null;
			if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')) return false;
		} catch (e) { console.error('[kusto]', e); }
		try {
			if (el.getClientRects && el.getClientRects().length === 0) return false;
		} catch (e) { console.error('[kusto]', e); }
		return true;
	} catch {
		return false;
	}
}

export function __kustoGetWordNearCursor(ed: any) {
	try {
		if (!ed) return '';
		const model = ed.getModel && ed.getModel();
		const pos = (typeof ed.getPosition === 'function') ? ed.getPosition() : null;
		if (!model || !pos) return '';

		const lineNumber = Number(pos.lineNumber) || 0;
		const column = Number(pos.column) || 0;
		if (lineNumber <= 0 || column <= 0) return '';

		const tryWordAtColumn = (col: any) => {
			try {
				const c = Number(col) || 0;
				if (c <= 0) return '';
				if (typeof model.getWordAtPosition !== 'function') return '';
				const w = model.getWordAtPosition({ lineNumber, column: c });
				const word = w && typeof w.word === 'string' ? w.word : '';
				return String(word || '').trim();
			} catch {
				return '';
			}
		};

		// Normal case: caret is inside a word.
		let word = tryWordAtColumn(column);
		if (word) return word;

		// Boundary case: caret is right *before* the first character of a word.
		word = tryWordAtColumn(column + 1);
		if (word) return word;

		// Boundary case: caret is right *after* the last character of a word.
		word = tryWordAtColumn(column - 1);
		if (word) return word;

		// Robust fallback: inspect the line text (fast and avoids Monaco quirks at boundaries).
		try {
			if (typeof model.getLineContent !== 'function') return '';
			const line = String(model.getLineContent(lineNumber) || '');
			if (!line) return '';

			const isWordCh = (c: any) => /[A-Za-z0-9_]/.test(String(c || ''));
			let idx = Math.max(0, column - 1);
			if (idx >= line.length) idx = line.length - 1;
			if (idx < 0) return '';

			// If we're sitting on whitespace, allow a small bounded lookahead (covers "caret before word"
			// including cases with multiple spaces/tabs).
			try {
				if (!isWordCh(line[idx]) && /\s/.test(String(line[idx] || ''))) {
					let j = idx;
					while (j < line.length && /\s/.test(String(line[j] || '')) && (j - idx) < 24) j++;
					if (j < line.length) idx = j;
				}
			} catch (e) { console.error('[kusto]', e); }

			// If char under idx isn't a word char but the left char is, treat it as end-of-word.
			if (!isWordCh(line[idx]) && idx > 0 && isWordCh(line[idx - 1])) {
				idx = idx - 1;
			}
			if (!isWordCh(line[idx])) return '';

			let start = idx;
			let end = idx;
			while (start > 0 && isWordCh(line[start - 1])) start--;
			while (end + 1 < line.length && isWordCh(line[end + 1])) end++;
			return String(line.slice(start, end + 1) || '').trim();
		} catch {
			return '';
		}
	} catch {
		return '';
	}
}

export function __kustoFindSuggestWidgetForEditor(ed: any, opts: any) {
	try {
		const options = opts || {};
		const requireVisible = options.requireVisible !== false;
		const maxDistancePx = (typeof options.maxDistancePx === 'number') ? options.maxDistancePx : 320;

		const root = (ed && typeof ed.getDomNode === 'function') ? ed.getDomNode() : null;
		const editorHost = (() => {
			try {
				if (!root) return null;
				// Prefer the actual Monaco root so we can scope queries when multiple editors exist.
				return (root.closest && root.closest('.monaco-editor')) ? root.closest('.monaco-editor') : root;
			} catch {
				return root;
			}
		})();
		const doc = (root && root.ownerDocument) ? root.ownerDocument : (typeof document !== 'undefined' ? document : null);
		if (!doc || typeof doc.querySelectorAll !== 'function') return null;

		// Compute a client point near the caret for "which widget is mine" selection.
		let anchorX = 0;
		let anchorY = 0;
		try {
			const r = root && root.getBoundingClientRect ? root.getBoundingClientRect() : null;
			anchorX = r ? (r.left + Math.max(0, (r.width || 0) / 2)) : 0;
			anchorY = r ? (r.top + Math.max(0, (r.height || 0) / 2)) : 0;
			const pos = (ed && typeof ed.getPosition === 'function') ? ed.getPosition() : null;
			const rel = (pos && typeof ed.getScrolledVisiblePosition === 'function') ? ed.getScrolledVisiblePosition(pos) : null;
			if (r && rel && typeof rel.left === 'number' && typeof rel.top === 'number') {
				anchorX = r.left + rel.left + 8;
				anchorY = r.top + rel.top + (typeof rel.height === 'number' ? rel.height : 0) + 2;
			}
		} catch (e) { console.error('[kusto]', e); }

		// IMPORTANT:
		// With multiple editors on the same page, querying the whole document can pick the wrong
		// suggest widget (e.g. from another editor) and cause preselect/auto-hide logic to behave
		// inconsistently. Prefer scoping to this editor's DOM subtree first.
		let widgets = null;
		try {
			if (editorHost && typeof editorHost.querySelectorAll === 'function') {
				widgets = editorHost.querySelectorAll('.suggest-widget');
			}
		} catch { widgets = null; }
		if (!widgets || !widgets.length) {
			try {
				widgets = doc.querySelectorAll('.suggest-widget');
			} catch { widgets = null; }
		}
		if (!widgets || !widgets.length) return null;
		let best = null;
		let bestDist2 = Infinity;
		for (const w of widgets) {
			if (!w || !w.getBoundingClientRect) continue;
			// If we had to fall back to a document-wide scan, try to keep the selection within
			// the current editor's Monaco root when possible.
			try {
				if (editorHost && w.closest) {
					const wHost = w.closest('.monaco-editor');
					if (wHost && wHost !== editorHost) continue;
				}
			} catch (e) { console.error('[kusto]', e); }
			if (requireVisible && !__kustoIsElementVisibleForSuggest(w)) continue;
			const rect = w.getBoundingClientRect();
			// distance from point to rect (0 if inside)
			const dx = (anchorX < rect.left) ? (rect.left - anchorX) : (anchorX > rect.right) ? (anchorX - rect.right) : 0;
			const dy = (anchorY < rect.top) ? (rect.top - anchorY) : (anchorY > rect.bottom) ? (anchorY - rect.bottom) : 0;
			const d2 = (dx * dx) + (dy * dy);
			if (d2 < bestDist2) {
				bestDist2 = d2;
				best = w;
			}
		}
		if (!best) return null;
		if (isFinite(bestDist2) && maxDistancePx > 0) {
			const max2 = maxDistancePx * maxDistancePx;
			if (bestDist2 > max2) return null;
		}
		return best;
	} catch {
		return null;
	}
}

export function __kustoRegisterGlobalSuggestMutationHandler(doc: any, handler: any) {
	try {
		if (!doc || !handler) return () => { };
		const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
		if (!win) return () => { };

		if (!win.__kustoSuggestMutationHub) {
			const hub: any = {
				handlers: new Set(),
				mo: null,
				scheduled: false,
				schedule() {
					if (hub.scheduled) return;
					hub.scheduled = true;
					const run = () => {
						hub.scheduled = false;
						try {
							for (const h of Array.from(hub.handlers)) {
								try { (h as any)(); } catch (e) { console.error('[kusto]', e); }
							}
						} catch (e) { console.error('[kusto]', e); }
					};
					try {
						requestAnimationFrame(run);
					} catch {
						setTimeout(run, 0);
					}
				}
			};
			try {
				if (typeof MutationObserver !== 'undefined' && doc.body) {
					(hub as any).mo = new MutationObserver(() => hub.schedule());
					(hub as any).mo.observe(doc.body, {
						subtree: true,
						childList: true,
						attributes: true,
						attributeFilter: ['aria-hidden', 'class', 'style']
					});
				}
			} catch { hub.mo = null; }
			win.__kustoSuggestMutationHub = hub;
		}

		const hub = win.__kustoSuggestMutationHub;
		try { hub.handlers.add(handler); } catch (e) { console.error('[kusto]', e); }
		try { hub.schedule(); } catch (e) { console.error('[kusto]', e); }

		return () => {
			try { hub.handlers.delete(handler); } catch (e) { console.error('[kusto]', e); }
			try {
				if (hub.handlers.size === 0 && hub.mo) {
					hub.mo.disconnect();
					hub.mo = null;
				}
			} catch (e) { console.error('[kusto]', e); }
		};
	} catch {
		return () => { };
	}
}

export function __kustoInstallSmartSuggestWidgetSizing(editor: any) {
	try {
		if (!editor) return () => { };

		// Minimal behavior: when suggest becomes visible, preselect the matching item once.
		// After that, do not interact with the suggest list/widget at all; let Monaco own it.
		// This avoids destabilizing Monaco suggest rendering across multiple editors.
		const minimalDispose = (() => {
			const safeTrigger = (ed: any, commandId: any) => {
				try {
					if (!ed || !commandId) return;
					const result = ed.trigger('keyboard', commandId, {});
					if (result && typeof result.then === 'function') {
						result.catch(() => { /* ignore */ });
					}
				} catch (e) { console.error('[kusto]', e); }
			};

			const getEditorDomMinimal = () => {
				try {
					return (typeof editor.getDomNode === 'function') ? editor.getDomNode() : null;
				} catch {
					return null;
				}
			};

			// Keep existing call sites safe, but intentionally no-op.
			try { editor.__kustoScheduleSuggestClamp = () => { }; } catch (e) { console.error('[kusto]', e); }
			// IMPORTANT: keep existing call sites safe, but prevent preselect from being
			// retriggered on arrow/cursor navigation.
			try { editor.__kustoScheduleSuggestPreselect = () => { }; } catch (e) { console.error('[kusto]', e); }

			let didPreselectThisOpen = false;
			let lastVisible = false;
			let preselectScheduled = false;
			let preselectAttemptsRemaining = 0;
			let targetWordAtOpen = '';

			const getWordAtCursor = () => {
				try {
					return __kustoGetWordNearCursor(editor);
				} catch {
					return '';
				}
			};

			const tryPreselectNow = () => {
				try {
					if (didPreselectThisOpen) return;
					if (typeof editor.__kustoPreselectExactWordInSuggestIfPresent !== 'function') {
						didPreselectThisOpen = true;
						return;
					}
					const did = !!editor.__kustoPreselectExactWordInSuggestIfPresent(targetWordAtOpen);
					if (did) {
						didPreselectThisOpen = true;
						return;
					}
					if (preselectAttemptsRemaining > 0) {
						preselectAttemptsRemaining--;
						schedulePreselectAttempt();
						return;
					}
					didPreselectThisOpen = true;
				} catch {
					didPreselectThisOpen = true;
				}
			};

			const schedulePreselectAttempt = () => {
				try {
					if (didPreselectThisOpen) return;
					if (preselectScheduled) return;
					preselectScheduled = true;
					requestAnimationFrame(() => {
						preselectScheduled = false;
						tryPreselectNow();
					});
				} catch {
					preselectScheduled = false;
					setTimeout(() => {
						preselectScheduled = false;
						tryPreselectNow();
					}, 0);
				}
			};

			const scheduleDelayedPreselectSweep = () => {
				// Some Monaco builds populate the suggest list asynchronously (and slower when unfiltered),
				// which disproportionately affects the "caret at start of word" scenario.
				// Do a few delayed sweeps, but stop as soon as we succeed.
				try {
					if (didPreselectThisOpen) return;
					setTimeout(() => { try { if (!didPreselectThisOpen) tryPreselectNow(); } catch (e) { console.error('[kusto]', e); } }, 60);
					setTimeout(() => { try { if (!didPreselectThisOpen) tryPreselectNow(); } catch (e) { console.error('[kusto]', e); } }, 160);
					setTimeout(() => { try { if (!didPreselectThisOpen) tryPreselectNow(); } catch (e) { console.error('[kusto]', e); } }, 320);
					setTimeout(() => { try { if (!didPreselectThisOpen) tryPreselectNow(); } catch (e) { console.error('[kusto]', e); } }, 650);
				} catch (e) { console.error('[kusto]', e); }
			};

			const checkSuggestVisibilityTransition = () => {
				try {
					const widget = __kustoFindSuggestWidgetForEditor(editor, { requireVisible: false, maxDistancePx: 320 });
					let visible = !!(widget && __kustoIsElementVisibleForSuggest(widget));
					if (!visible) {
						lastVisible = false;
						didPreselectThisOpen = false;
						targetWordAtOpen = '';
						preselectAttemptsRemaining = 0;
						return;
					}
					if (!lastVisible) {
						lastVisible = true;
						targetWordAtOpen = getWordAtCursor();
						// Allow multiple frames + a few delayed sweeps for async suggest providers to populate rows.
						preselectAttemptsRemaining = 24;
						schedulePreselectAttempt();
						scheduleDelayedPreselectSweep();
					}
				} catch (e) { console.error('[kusto]', e); }
			};

			const scheduleHideSuggestIfTrulyBlurred = () => {
				try {
					setTimeout(() => {
						try {
							const hasWidgetFocus = typeof editor.hasWidgetFocus === 'function' ? editor.hasWidgetFocus() : false;
							const hasTextFocus = typeof editor.hasTextFocus === 'function' ? editor.hasTextFocus() : false;
							if (hasWidgetFocus || hasTextFocus) return;
						} catch (e) { console.error('[kusto]', e); }
						safeTrigger(editor, 'hideSuggestWidget');
					}, 150);
				} catch (e) { console.error('[kusto]', e); }
			};

			let disposables: any[] = [];
			const safeOn = (fn: any) => {
				try { if (fn && typeof fn.dispose === 'function') disposables.push(fn); } catch (e) { console.error('[kusto]', e); }
			};
			try { safeOn(editor.onDidBlurEditorText(() => scheduleHideSuggestIfTrulyBlurred())); } catch (e) { console.error('[kusto]', e); }
			try { safeOn(editor.onDidBlurEditorWidget(() => scheduleHideSuggestIfTrulyBlurred())); } catch (e) { console.error('[kusto]', e); }

			// Helper to check if the suggest widget is showing "No suggestions" message
			const isSuggestWidgetShowingNoSuggestions = () => {
				try {
					const widget = __kustoFindSuggestWidgetForEditor(editor, { requireVisible: true, maxDistancePx: 320 });
					if (!widget) return false;
					// Monaco shows "No suggestions." in a message element when there are no completions
					const messageEl = widget.querySelector('.message');
					if (messageEl && __kustoIsElementVisibleForSuggest(messageEl)) {
						const text = (messageEl.textContent || '').toLowerCase();
						if (text.includes('no suggestion')) return true;
					}
					return false;
				} catch {
					return false;
				}
			};

			// Hide "No suggestions" widget immediately on any user interaction
			const hideNoSuggestionsOnInteraction = () => {
				try {
					if (isSuggestWidgetShowingNoSuggestions()) {
						safeTrigger(editor, 'hideSuggestWidget');
					}
				} catch (e) { console.error('[kusto]', e); }
			};

			// Attach interaction listeners to dismiss "No suggestions" quickly
			let interactionListenersAttached = false;
			const attachInteractionListeners = () => {
				if (interactionListenersAttached) return;
				interactionListenersAttached = true;
				try {
					const root = getEditorDomMinimal();
					if (root) {
						root.addEventListener('keydown', hideNoSuggestionsOnInteraction, true);
						root.addEventListener('mousedown', hideNoSuggestionsOnInteraction, true);
					}
				} catch (e) { console.error('[kusto]', e); }
			};
			const detachInteractionListeners = () => {
				if (!interactionListenersAttached) return;
				interactionListenersAttached = false;
				try {
					const root = getEditorDomMinimal();
					if (root) {
						root.removeEventListener('keydown', hideNoSuggestionsOnInteraction, true);
						root.removeEventListener('mousedown', hideNoSuggestionsOnInteraction, true);
					}
				} catch (e) { console.error('[kusto]', e); }
			};
			// Attach once on setup
			try { attachInteractionListeners(); } catch (e) { console.error('[kusto]', e); }

			let mo: any = null;
			let unregister: any = null;
			try {
				const root = getEditorDomMinimal();
				const doc = (root && root.ownerDocument) ? root.ownerDocument : (typeof document !== 'undefined' ? document : null);
				unregister = __kustoRegisterGlobalSuggestMutationHandler(doc, checkSuggestVisibilityTransition);
			} catch {
				mo = null;
				unregister = null;
			}

			try { checkSuggestVisibilityTransition(); } catch (e) { console.error('[kusto]', e); }

			// Dismiss suggest widgets on outer (notebook/body) scroll — ephemeral per dismiss-on-scroll policy.
			try {
				if (!_suggestWidgetScrollDismissInstalled) {
					_suggestWidgetScrollDismissInstalled = true;
					window.addEventListener('scroll', (ev: any) => {
						try {
							const target = ev && ev.target;
							// If scroll originated inside a Monaco editor or suggest widget, ignore.
							if (target && target !== document && target !== document.documentElement && target !== document.body) {
								try {
									if (target.closest && (target.closest('.monaco-editor') || target.closest('.suggest-widget'))) {
										return;
									}
								} catch (e) { console.error('[kusto]', e); }
							}
							// Outer scroll — dismiss all suggest widgets.
							if (!queryEditors) return;
							for (const id of Object.keys(queryEditors)) {
								const ed = queryEditors[id];
								if (!ed) continue;
								try {
									const r = ed.trigger('keyboard', 'hideSuggestWidget', {});
									if (r && typeof r.then === 'function') r.catch(() => { /* ignore */ });
								} catch (e) { console.error('[kusto]', e); }
							}
						} catch (e) { console.error('[kusto]', e); }
					}, true);
				}
			} catch (e) { console.error('[kusto]', e); }

			const dispose = () => {
				try { if (mo) mo.disconnect(); } catch (e) { console.error('[kusto]', e); }
				try { mo = null; } catch (e) { console.error('[kusto]', e); }
				try { if (typeof unregister === 'function') unregister(); } catch (e) { console.error('[kusto]', e); }
				try { unregister = null; } catch (e) { console.error('[kusto]', e); }
				try { detachInteractionListeners(); } catch (e) { console.error('[kusto]', e); }
				try {
					for (const d of disposables) {
						try { d && d.dispose && d.dispose(); } catch (e) { console.error('[kusto]', e); }
					}
				} catch (e) { console.error('[kusto]', e); }
				disposables = [];
				try { delete editor.__kustoScheduleSuggestClamp; } catch (e) { console.error('[kusto]', e); }
				try { delete editor.__kustoScheduleSuggestPreselect; } catch (e) { console.error('[kusto]', e); }
			};

			try {
				if (typeof editor.onDidDispose === 'function') {
					editor.onDidDispose(() => dispose());
				}
			} catch (e) { console.error('[kusto]', e); }

			return dispose;
		})();

		return minimalDispose;

		// NOTE: All code below this return is unreachable (dead code from legacy sizing approach).
		// It is kept for reference but never executes.

		const __kustoSafeEditorTrigger = (ed: any, commandId: any) => {
			try {
				if (!ed || !commandId) return;
				const result = ed.trigger('keyboard', commandId, {});
				// Some Monaco commands return a Promise; avoid unhandled rejections.
				if (result && typeof result.then === 'function') {
					result.catch(() => { /* ignore */ });
				}
			} catch (e) { console.error('[kusto]', e); }
		};
		const getEditorDom = () => {
			try {
				return (typeof editor.getDomNode === 'function') ? editor.getDomNode() : null;
			} catch {
				return null;
			}
		};
		const getWrapperDom = () => {
			try {
				const dom = getEditorDom();
				return (dom && dom.closest) ? dom.closest('.query-editor-wrapper') : null;
			} catch {
				return null;
			}
		};
		const getBoundsDom = () => {
			try {
				if (typeof editor.getContainerDomNode === 'function') {
					return editor.getContainerDomNode();
				}
			} catch (e) { console.error('[kusto]', e); }
			const dom = getEditorDom();
			return dom ? (dom.parentElement || dom) : null;
		};

		const getRowHeightPx = (suggestWidget: any) => {
			try {
				const row = suggestWidget && suggestWidget.querySelector
					? suggestWidget.querySelector('.monaco-list-row')
					: null;
				if (row) {
					const r = row.getBoundingClientRect();
					const h = Math.round(r.height || 0);
					if (h > 0) return h;
					const cs = getComputedStyle(row);
					const lh = Math.round(parseFloat(cs.height || cs.lineHeight || '0') || 0);
					if (lh > 0) return lh;
				}
			} catch (e) { console.error('[kusto]', e); }
			// Monaco defaults are typically ~22px per row; keep a safe fallback.
			return 22;
		};

		// Use Monaco's supported configuration for suggest height when possible.
		// Fall back to DOM clamp + internal relayout poke only when needed.
		const DEFAULT_MAX_VISIBLE = 12;
		let lastApplied: any = { availablePx: null, rowHeightPx: null, maxVisible: null };
		let pendingAdjustTimer: any = null;
		let rafScheduled = false;
		let lastRelayoutAt = 0;
		const clearInjectedSuggestStyles = (suggest: any) => {
			try {
				if (!suggest) return;
				// Clear any DOM sizing we might have applied in fallback mode.
				suggest.style.maxHeight = '';
				suggest.style.height = '';
				suggest.style.overflow = '';
				try {
					const injected = suggest.querySelectorAll
						? suggest.querySelectorAll('[data-kusto-suggest-clamp="1"]')
						: [];
					for (const el of injected) {
						try {
							(el as any).style.height = '';
							(el as any).style.maxHeight = '';
							(el as any).style.overflowY = '';
							delete (el as any).dataset.kustoSuggestClamp;
						} catch (e) { console.error('[kusto]', e); }
					}
				} catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
		};

		const applyDomClampFallback = (suggest: any, availablePx: any) => {
			try {
				if (!suggest) return;
				const avail = Math.max(0, Math.floor(Number(availablePx) || 0));
				if (!avail) return;
				// Keep this non-destructive: setting a hard `height` + `overflow:hidden` can
				// cause Monaco's internal list to render as an empty/blank box.
				suggest.style.maxHeight = avail + 'px';
				suggest.style.height = '';
				suggest.style.overflow = '';
				try {
					if (suggest.dataset) suggest.dataset.kustoSuggestClamp = '1';
				} catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
		};

		const applyListViewportClampFallback = (suggest: any, availablePx: any) => {
			// Some Monaco builds can end up with a visible suggest widget whose internal list viewport
			// collapses (scrollbar present but rows not painted). Apply a height to the list container
			// as a last-resort recovery.
			try {
				if (!suggest) return;
				const avail = Math.max(0, Math.floor(Number(availablePx) || 0));
				if (!avail) return;
				const overheadPx = 14;
				const h = Math.max(1, avail - overheadPx);
				let list = null;
				try { list = suggest.querySelector && suggest.querySelector('.monaco-list'); } catch { list = null; }
				if (!list) {
					try {
						const rows = suggest.querySelector && suggest.querySelector('.monaco-list-rows');
						list = rows && rows.parentElement ? rows.parentElement : null;
					} catch { list = null; }
				}
				if (!list) return;
				list.style.height = h + 'px';
				list.style.maxHeight = h + 'px';
				try { if (list.dataset) list.dataset.kustoSuggestClamp = '1'; } catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
		};

		const scheduleHideSuggestIfTrulyBlurred = () => {
			try {
				// Avoid closing suggest during Monaco's internal focus churn while opening/closing widgets.
				setTimeout(() => {
					try {
						const hasWidgetFocus = typeof editor.hasWidgetFocus === 'function' ? editor.hasWidgetFocus() : false;
						const hasTextFocus = typeof editor.hasTextFocus === 'function' ? editor.hasTextFocus() : false;
						if (hasWidgetFocus || hasTextFocus) {
							return;
						}
					} catch (e) { console.error('[kusto]', e); }
					__kustoSafeEditorTrigger(editor, 'hideSuggestWidget');
				}, 150);
			} catch (e) { console.error('[kusto]', e); }
		};

		let lastSuggestVisible = false;
		let suggestListObserver: any = null;
		let suggestPreselectRaf = false;
		let lastPreselectAt = 0;
		let lastPreselectTargetLower = '';
		let lastPreselectFocusedLower = '';
		let cursorClampTimer: any = null;
		let lastCursorClampAt = 0;
		const debugSuggest = (eventName: any, data: any) => {
			try {
				const enabled = !!(window && (window.__kustoSuggestDebug || (window.localStorage && window.localStorage.getItem('kustoSuggestDebug') === '1')));
				if (!enabled) return;
				console.debug('[kusto][suggest]', String(eventName || ''), data || {}, { boxId: editor && editor.__kustoBoxId });
			} catch (e) { console.error('[kusto]', e); }
		};
		const normalizeSuggestLabel = (s: any) => {
			try {
				let x = String(s || '').trim();
				x = x.replace(/^(\[|\(|\{|"|')+/, '').replace(/(\]|\)|\}|"|')+$/, '');
				x = x.split(/[\s,\(]/g).filter(Boolean)[0] || x;
				return String(x || '').trim();
			} catch {
				return String(s || '').trim();
			}
		};
		const getFocusedSuggestRowLabelLower = () => {
			try {
				const root = getEditorDom();
				if (!root || typeof root.querySelector !== 'function') return '';
				const widget = root.querySelector('.suggest-widget');
				if (!widget || typeof widget.querySelector !== 'function') return '';
				const ariaHidden = String((widget.getAttribute && widget.getAttribute('aria-hidden')) || '').toLowerCase();
				if (ariaHidden === 'true') return '';
				const row = widget.querySelector('.monaco-list-row.focused') || widget.querySelector('.monaco-list-row[aria-selected="true"]');
				if (!row) return '';
				let label = '';
				try {
					const labelName = row.querySelector && row.querySelector('.label-name');
					if (labelName && typeof labelName.textContent === 'string') {
						label = labelName.textContent;
					}
				} catch (e) { console.error('[kusto]', e); }
				if (!label) {
					try {
						label = String((row.getAttribute && row.getAttribute('aria-label')) || '');
					} catch (e) { console.error('[kusto]', e); }
				}
				label = normalizeSuggestLabel(label);
				return String(label || '').toLowerCase();
			} catch {
				return '';
			}
		};
		const scheduleSuggestPreselect = () => {
			if (suggestPreselectRaf) return;
			// Throttle: repeated DOM mutations + cursor moves can happen during filtering.
			const now = Date.now();
			if (now - lastPreselectAt < 60) return;
			lastPreselectAt = now;
			suggestPreselectRaf = true;
			try {
				requestAnimationFrame(() => {
					suggestPreselectRaf = false;
					try {
						if (!editor || typeof editor.__kustoPreselectExactWordInSuggestIfPresent !== 'function') return;
						// Skip if the focused item already matches the current target.
						let focusedLower = '';
						try { focusedLower = getFocusedSuggestRowLabelLower(); } catch { focusedLower = ''; }
						if (focusedLower) {
							lastPreselectFocusedLower = focusedLower;
						}
						// If focus hasn't changed and last target is the same, don't touch Monaco.
						if (focusedLower && lastPreselectTargetLower && focusedLower === lastPreselectTargetLower) {
							return;
						}
						const did = !!editor.__kustoPreselectExactWordInSuggestIfPresent();
						if (did) {
							// Refresh focused label cache after we changed it.
							try { lastPreselectFocusedLower = getFocusedSuggestRowLabelLower(); } catch (e) { console.error('[kusto]', e); }
						}
					} catch (e) { console.error('[kusto]', e); }
				});
			} catch {
				suggestPreselectRaf = false;
				setTimeout(() => {
					try {
						if (!editor || typeof editor.__kustoPreselectExactWordInSuggestIfPresent !== 'function') return;
						const focusedLower = getFocusedSuggestRowLabelLower();
						if (focusedLower && lastPreselectTargetLower && focusedLower === lastPreselectTargetLower) {
							return;
						}
						const did = !!editor.__kustoPreselectExactWordInSuggestIfPresent();
						if (did) {
							try { lastPreselectFocusedLower = getFocusedSuggestRowLabelLower(); } catch (e) { console.error('[kusto]', e); }
						}
					} catch (e) { console.error('[kusto]', e); }
				}, 0);
			}
		};
		try { editor.__kustoScheduleSuggestPreselect = scheduleSuggestPreselect; } catch (e) { console.error('[kusto]', e); }

		const tryRelayoutSuggestWidget = (availablePx: any) => {
			// Best-effort poke of Monaco internals so keyboard navigation uses the updated height.
			// All accesses are optional and guarded.
			try {
				const now = Date.now();
				if (now - lastRelayoutAt < 16) return;
				lastRelayoutAt = now;
			} catch (e) { console.error('[kusto]', e); }
			try {
				if (!editor || typeof editor.getContribution !== 'function') return;
				const ctrl = editor.getContribution('editor.contrib.suggestController');
				if (!ctrl) return;

				const candidates = [];
				try { if (ctrl._widget) candidates.push(ctrl._widget); } catch (e) { console.error('[kusto]', e); }
				try { if (ctrl.widget) candidates.push(ctrl.widget); } catch (e) { console.error('[kusto]', e); }
				try { if (ctrl._suggestWidget) candidates.push(ctrl._suggestWidget); } catch (e) { console.error('[kusto]', e); }
				try { if (ctrl.suggestWidget) candidates.push(ctrl.suggestWidget); } catch (e) { console.error('[kusto]', e); }

				const avail = Math.max(0, Math.floor(Number(availablePx) || 0));
				for (const w0 of candidates) {
					const w = (w0 && w0.value) ? w0.value : w0;
					if (!w) continue;
					try {
						if (typeof w.layout === 'function') {
							// Some implementations accept (dimension) or no args.
							try { w.layout(); } catch (e) { console.error('[kusto]', e); }
							try { if (avail) w.layout({ height: avail }); } catch (e) { console.error('[kusto]', e); }
							try { if (avail) w.layout(avail); } catch (e) { console.error('[kusto]', e); }
						}
					} catch (e) { console.error('[kusto]', e); }
					try { if (typeof w._layout === 'function') w._layout(); } catch (e) { console.error('[kusto]', e); }
					try { if (typeof w._resize === 'function') w._resize(); } catch (e) { console.error('[kusto]', e); }
					try { if (w._tree && typeof w._tree.layout === 'function' && avail) w._tree.layout(avail); } catch (e) { console.error('[kusto]', e); }
					try { if (w._list && typeof w._list.layout === 'function' && avail) w._list.layout(avail); } catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
		};

		const applyMaxVisibleSuggestions = (maxVisible: any) => {
			try {
				const mv = Math.max(1, Math.floor(Number(maxVisible) || 0));
				if (lastApplied.maxVisible === mv) {
					return;
				}
				lastApplied.maxVisible = mv;
				// Monaco supports nested updateOptions for suggest.
				// Keep other suggest config untouched.
				editor.updateOptions({ suggest: { maxVisibleSuggestions: mv } });
			} catch (e) { console.error('[kusto]', e); }
		};

		const computeMaxVisibleFromAvailablePx = (availablePx: any, rowHeightPx: any) => {
			try {
				const avail = Math.max(0, Math.floor(Number(availablePx) || 0));
				const rh = Math.max(1, Math.floor(Number(rowHeightPx) || 0));
				// Suggest widget has borders/padding/header; subtract a small constant overhead.
				const overhead = 12;
				const usable = Math.max(0, avail - overhead);
				return Math.max(1, Math.floor(usable / rh));
			} catch {
				return 1;
			}
		};

		const schedulePostLayoutAdjust = (root: any, boundsDom: any, suggest: any) => {
			try {
				if (pendingAdjustTimer) return;
				pendingAdjustTimer = setTimeout(() => {
					pendingAdjustTimer = null;
					try {
						if (!root || !boundsDom || !suggest) return;
						const ariaHidden = String((suggest.getAttribute && suggest.getAttribute('aria-hidden')) || '').toLowerCase();
						if (ariaHidden === 'true') return;
						const boundsRect = boundsDom.getBoundingClientRect();
						const suggestRect = suggest.getBoundingClientRect();
						const pad = 4;
						// Handle bottom overflow.
						const overflow = Math.ceil((suggestRect.bottom || 0) - ((boundsRect.bottom || 0) - pad));
						// Handle top overflow (common when Monaco chooses above-caret placement).
						const topOverflow = Math.ceil(((boundsRect.top || 0) + pad) - (suggestRect.top || 0));

						if ((!isFinite(overflow) || overflow <= 0) && (!isFinite(topOverflow) || topOverflow <= 0)) {
							return;
						}

						const rowHeight = getRowHeightPx(suggest);
						let next = lastApplied.maxVisible || DEFAULT_MAX_VISIBLE;
						try {
							if (isFinite(overflow) && overflow > 0) {
								const reduceBy = Math.max(1, Math.ceil(overflow / Math.max(1, rowHeight)));
								next = Math.max(1, next - reduceBy);
							}
							if (isFinite(topOverflow) && topOverflow > 0) {
								const reduceByTop = Math.max(1, Math.ceil(topOverflow / Math.max(1, rowHeight)));
								next = Math.max(1, next - reduceByTop);
							}
						} catch (e) { console.error('[kusto]', e); }
						applyMaxVisibleSuggestions(next);
						// If Monaco still overflows, apply DOM clamp and relayout as a fallback.
						try {
							const boundsRect2 = boundsDom.getBoundingClientRect();
							const suggestRect2 = suggest.getBoundingClientRect();
							let availablePx = Math.floor((boundsRect2.bottom || 0) - (suggestRect2.top || 0) - pad);
							// If it's anchored above the caret, clamp to available space above instead.
							if (isFinite(topOverflow) && topOverflow > 0) {
								availablePx = Math.floor((suggestRect2.bottom || 0) - (boundsRect2.top || 0) - pad);
							}
							if (isFinite(availablePx) && availablePx > 0 && (suggestRect2.height || 0) > availablePx + 2) {
								applyDomClampFallback(suggest, availablePx);
								tryRelayoutSuggestWidget(availablePx);
							}
						} catch (e) { console.error('[kusto]', e); }
					} catch (e) { console.error('[kusto]', e); }
				}, 0);
			} catch {
				pendingAdjustTimer = null;
			}
		};

		const clampNow = () => {
			rafScheduled = false;
			try {
				const root = getEditorDom();
				if (!root || typeof root.querySelector !== 'function') return;
				const boundsDom = getBoundsDom();
				if (!boundsDom || typeof boundsDom.getBoundingClientRect !== 'function') return;
				const suggest = root.querySelector('.suggest-widget');
				if (!suggest || typeof suggest.getBoundingClientRect !== 'function') return;

				// Only apply when visible.
				const ariaHidden = String((suggest.getAttribute && suggest.getAttribute('aria-hidden')) || '').toLowerCase();
				const isVisible = ariaHidden !== 'true';
				if (!isVisible) {
					try { lastSuggestVisible = false; } catch (e) { console.error('[kusto]', e); }
					try { if (suggestListObserver) suggestListObserver.disconnect(); } catch (e) { console.error('[kusto]', e); }
					try { suggestListObserver = null; } catch (e) { console.error('[kusto]', e); }
					// When hidden, clear any fallback styles we may have applied.
					clearInjectedSuggestStyles(suggest);
					// When hidden, keep lastApplied.maxVisible; we'll recompute on next open.
					return;
				}

				// The moment suggest becomes visible (or its rows change), try to preselect immediately.
				try {
					if (!lastSuggestVisible) {
						lastSuggestVisible = true;
						try { lastPreselectTargetLower = ''; } catch (e) { console.error('[kusto]', e); }
						try { lastPreselectFocusedLower = ''; } catch (e) { console.error('[kusto]', e); }
						scheduleSuggestPreselect();
					}
					// Observe list population/updates while visible; preselect is throttled + guarded.
					if (!suggestListObserver && typeof MutationObserver !== 'undefined') {
						suggestListObserver = new MutationObserver(() => {
							scheduleSuggestPreselect();
						});
						// Watch for list population/updates; avoid attribute watching to prevent hover flicker.
						suggestListObserver.observe(suggest, { subtree: true, childList: true });
					}
				} catch (e) { console.error('[kusto]', e); }

				// Clear any fallback styles only if we previously applied them.
				try {
					const hadClamp = (suggest.dataset && suggest.dataset.kustoSuggestClamp === '1')
						|| !!(suggest.querySelector && suggest.querySelector('[data-kusto-suggest-clamp="1"]'));
					if (hadClamp) {
						clearInjectedSuggestStyles(suggest);
					}
				} catch (e) { console.error('[kusto]', e); }

				const boundsRect = boundsDom.getBoundingClientRect();
				const suggestRect = suggest.getBoundingClientRect();
				const pad = 4;
				const topOverflow = Math.ceil(((boundsRect.top || 0) + pad) - (suggestRect.top || 0));
				let availablePx = 0;
				// If Monaco chose above-caret placement and it overflows at the top of the editor,
				// clamp based on the available space ABOVE (bounds.top .. suggest.bottom).
				if (isFinite(topOverflow) && topOverflow > 0) {
					availablePx = Math.floor((suggestRect.bottom || 0) - (boundsRect.top || 0) - pad);
				} else {
					// Default: clamp based on the available space below the widget's top.
					availablePx = Math.floor((boundsRect.bottom || 0) - (suggestRect.top || 0) - pad);
				}
				if (!isFinite(availablePx) || availablePx <= 0) {
					return;
				}

				// If the internal list viewport collapsed (common "empty but scrollable" crash), recover before sizing.
				try {
					const list = suggest.querySelector && (suggest.querySelector('.monaco-list') || (suggest.querySelector('.monaco-list-rows') && suggest.querySelector('.monaco-list-rows').parentElement));
					if (list) {
						const clientH = Math.floor(list.clientHeight || 0);
						const scrollH = Math.floor(list.scrollHeight || 0);
						if (scrollH > 0 && clientH <= 1) {
							debugSuggest('listViewportCollapsed', { clientH, scrollH });
							applyListViewportClampFallback(suggest, availablePx);
							tryRelayoutSuggestWidget(availablePx);
						}
					}
				} catch (e) { console.error('[kusto]', e); }

				const rowHeightPx = getRowHeightPx(suggest);
				const maxVisible = computeMaxVisibleFromAvailablePx(availablePx, rowHeightPx);
				if (lastApplied.availablePx !== availablePx || lastApplied.rowHeightPx !== rowHeightPx) {
					lastApplied.availablePx = availablePx;
					lastApplied.rowHeightPx = rowHeightPx;
				}
				applyMaxVisibleSuggestions(maxVisible);
				// If applying maxVisibleSuggestions doesn't affect actual widget height in this Monaco build,
				// clamp the DOM as a fallback and force a relayout so keyboard navigation uses the new viewport.
				try {
					if ((suggestRect.height || 0) > availablePx + 2) {
						applyDomClampFallback(suggest, availablePx);
						tryRelayoutSuggestWidget(availablePx);
					}
				} catch (e) { console.error('[kusto]', e); }
				// After Monaco applies the option, validate we didn't still overflow and reduce if needed.
				schedulePostLayoutAdjust(root, boundsDom, suggest);
			} catch (e) { console.error('[kusto]', e); }
		};

		const scheduleClamp = () => {
			if (rafScheduled) return;
			rafScheduled = true;
			try {
				requestAnimationFrame(clampNow);
			} catch {
				setTimeout(clampNow, 0);
			}
		};

		let mo: any = null;
				try {
					const root = getEditorDom();
					if (root && typeof MutationObserver !== 'undefined') {
						mo = new MutationObserver(() => scheduleClamp());
						// Only watch aria-hidden so hover/selection class changes don't cause clamp loops.
						mo.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-hidden'] });
					}
				} catch {
			mo = null;
		}

		let disposables: any[] = [];
		const safeOn = (fn: any) => {
			try {
				if (fn && typeof fn.dispose === 'function') disposables.push(fn);
			} catch (e) { console.error('[kusto]', e); }
		};
		try { safeOn(editor.onDidLayoutChange(() => scheduleClamp())); } catch (e) { console.error('[kusto]', e); }
		try { safeOn(editor.onDidScrollChange(() => scheduleClamp())); } catch (e) { console.error('[kusto]', e); }
		try {
			safeOn(editor.onDidChangeCursorPosition(() => {
				try {
					// Cursor moves can happen for every arrow keypress; avoid thrashing Monaco suggest layout.
					if (cursorClampTimer) return;
					const now = Date.now();
					if (now - lastCursorClampAt < 120) return;
					cursorClampTimer = setTimeout(() => {
						cursorClampTimer = null;
						lastCursorClampAt = Date.now();
						try {
							const root = getEditorDom();
							const widget = root && root.querySelector ? root.querySelector('.suggest-widget') : null;
							const ariaHidden = String((widget && widget.getAttribute && widget.getAttribute('aria-hidden')) || '').toLowerCase();
							const isVisible = widget && ariaHidden !== 'true';
							if (isVisible) scheduleClamp();
						} catch (e) { console.error('[kusto]', e); }
					}, 120);
				} catch (e) { console.error('[kusto]', e); }
			}));
		} catch (e) { console.error('[kusto]', e); }
		try { safeOn(editor.onDidFocusEditorWidget(() => scheduleClamp())); } catch (e) { console.error('[kusto]', e); }
		try { safeOn(editor.onDidFocusEditorText(() => scheduleClamp())); } catch (e) { console.error('[kusto]', e); }
		// Prevent a suggest widget in one editor from lingering and stealing clicks/focus.
		try { safeOn(editor.onDidBlurEditorText(() => scheduleHideSuggestIfTrulyBlurred())); } catch (e) { console.error('[kusto]', e); }
		try { safeOn(editor.onDidBlurEditorWidget(() => scheduleHideSuggestIfTrulyBlurred())); } catch (e) { console.error('[kusto]', e); }

		// Install one global viewport listener to update all visible suggest widgets across editors.
		try {
			if (!_suggestWidgetViewportListenersInstalled) {
				_suggestWidgetViewportListenersInstalled = true;
				_clampAllSuggestWidgets = () => {
					try {
						if (!queryEditors) return;
						for (const id of Object.keys(queryEditors)) {
							const ed = queryEditors[id];
							if (ed && typeof ed.__kustoScheduleSuggestClamp === 'function') {
								ed.__kustoScheduleSuggestClamp();
							}
						}
					} catch (e) { console.error('[kusto]', e); }
				};
				window.addEventListener('resize', () => {
					try { _clampAllSuggestWidgets && _clampAllSuggestWidgets(); } catch (e) { console.error('[kusto]', e); }
				});
				window.addEventListener('scroll', () => {
					try { _clampAllSuggestWidgets && _clampAllSuggestWidgets(); } catch (e) { console.error('[kusto]', e); }
				}, true);
			}
		} catch (e) { console.error('[kusto]', e); }

		// Expose per-editor scheduler so the global listener can update all editors.
		try { editor.__kustoScheduleSuggestClamp = scheduleClamp; } catch (e) { console.error('[kusto]', e); }
		// Clamp once soon (handles cases where suggest widget is already open).
		scheduleClamp();

		const dispose = () => {
			try { if (mo) mo.disconnect(); } catch (e) { console.error('[kusto]', e); }
			try { mo = null; } catch (e) { console.error('[kusto]', e); }
			try { if (suggestListObserver) suggestListObserver.disconnect(); } catch (e) { console.error('[kusto]', e); }
			try { suggestListObserver = null; } catch (e) { console.error('[kusto]', e); }
			try {
				if (cursorClampTimer) {
					clearTimeout(cursorClampTimer);
					cursorClampTimer = null;
				}
			} catch (e) { console.error('[kusto]', e); }
			try { lastApplied = { availablePx: null, rowHeightPx: null, maxVisible: null }; } catch (e) { console.error('[kusto]', e); }
			try {
				if (pendingAdjustTimer) {
					clearTimeout(pendingAdjustTimer);
					pendingAdjustTimer = null;
				}
			} catch (e) { console.error('[kusto]', e); }
			try {
				for (const d of disposables) {
					try { d && d.dispose && d.dispose(); } catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
			disposables = [];
			try { delete editor.__kustoScheduleSuggestClamp; } catch (e) { console.error('[kusto]', e); }
			try { delete editor.__kustoScheduleSuggestPreselect; } catch (e) { console.error('[kusto]', e); }
		};

		try {
			if (typeof editor.onDidDispose === 'function') {
				editor.onDidDispose(() => dispose());
			}
		} catch (e) { console.error('[kusto]', e); }

		return dispose;
	} catch {
		return () => { };
	}
}


// Window bridges removed (D8) — all 5 functions exported at top, consumed via ES imports by monaco.ts.
