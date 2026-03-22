// Drag-and-drop section reorder — extracted from main.ts
// Self-invoking: installs DnD handlers on #queries-container on import.
import { schedulePersist } from './persistence';
import { pState } from '../shared/persistence-state';
import { __kustoRefreshAllDataSourceDropdowns } from '../modules/extraBoxes';
import { queryEditors, setQueryBoxes } from './state';
import { markdownBoxes, markdownEditors } from '../sections/kw-markdown-section';
import { pythonBoxes, urlBoxes } from '../modules/extraBoxes';
import { safeRun } from '../shared/safe-run';

// Drag-and-drop reorder for sections in .kqlx.
// Reorders DOM children of #queries-container, then persistence saves the new order.
(function __kustoInstallSectionReorder() {
	const tryInstall = () => {
		const container = document.getElementById('queries-container');
		if (!container) {
			setTimeout(tryInstall, 50);
			return;
		}
		try {
			if (container.dataset && container.dataset.kustoSectionReorder === 'true') {
				return;
			}
			if (container.dataset) {
				container.dataset.kustoSectionReorder = 'true';
			}
		} catch (e) { console.error('[kusto]', e); }

		let draggingId = '';
		let draggingOriginalNextSibling: any = null;
		let draggingDidDrop = false;
		let globalDnDGuardsInstalled = false;

		// While reordering, prevent the browser (and editors like Monaco) from treating this as a text drop.
		// Without this, dropping over an input/textarea/editor surface can insert the drag payload and create
		// a real edit, which then correctly leaves the document dirty.
		const ensureGlobalDnDGuards = () => {
			if (globalDnDGuardsInstalled) return;
			globalDnDGuardsInstalled = true;
			try {
					const isInContainer = (eventTarget: any) => {
						try {
							return !!(container && eventTarget && container.contains && container.contains(eventTarget));
						} catch {
							return false;
						}
					};
					document.addEventListener('dragenter', (e: any) => {
						if (!draggingId) return;
						try { e.preventDefault(); } catch (e) { console.error('[kusto]', e); }
						// Only suppress drag events outside the container, so live reordering still works.
						if (isInContainer(e.target)) return;
						try { e.stopPropagation(); } catch (e) { console.error('[kusto]', e); }
						try { if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation(); } catch (e) { console.error('[kusto]', e); }
					}, true);
				document.addEventListener('dragover', (e: any) => {
					if (!draggingId) return;
					try { e.preventDefault(); } catch (e) { console.error('[kusto]', e); }
						// Allow container dragover to run so we can live-reorder.
						if (isInContainer(e.target)) return;
						try { e.stopPropagation(); } catch (e) { console.error('[kusto]', e); }
						try { if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation(); } catch (e) { console.error('[kusto]', e); }
				}, true);
				document.addEventListener('drop', (e: any) => {
					if (!draggingId) return;
						// If the drop is inside the container, let the container's drop handler finish the reorder.
						if (isInContainer(e.target)) return;
						try { e.preventDefault(); } catch (e) { console.error('[kusto]', e); }
						try { e.stopPropagation(); } catch (e) { console.error('[kusto]', e); }
						try { if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation(); } catch (e) { console.error('[kusto]', e); }
				}, true);
			} catch (e) { console.error('[kusto]', e); }
		};

		const resyncArraysFromDom = () => {
			try {
				const ids = Array.from(container.children || [])
					.map((el: any) => (el && el.id ? String(el.id) : ''))
					.filter(Boolean);
				try { setQueryBoxes(ids.filter((id: any) => id.startsWith('query_'))); } catch (e) { console.error('[kusto]', e); }
				try { const mdIds = ids.filter((id: any) => id.startsWith('markdown_')); markdownBoxes.length = 0; markdownBoxes.push(...mdIds); } catch (e) { console.error('[kusto]', e); }
				try { const pyIds = ids.filter((id: any) => id.startsWith('python_')); pythonBoxes.length = 0; pythonBoxes.push(...pyIds); } catch (e) { console.error('[kusto]', e); }
				try { const urlIds = ids.filter((id: any) => id.startsWith('url_')); urlBoxes.length = 0; urlBoxes.push(...urlIds); } catch (e) { console.error('[kusto]', e); }
			} catch (e) { console.error('[kusto]', e); }
		};

		const bestEffortRelayoutMovedEditors = (boxId: any) => {
			try {
				const q = queryEditors ? queryEditors[boxId] : null;
				const md = markdownEditors ? markdownEditors[boxId] : null;
				const py = (typeof window.__kustoPythonEditors !== 'undefined' && window.__kustoPythonEditors) ? window.__kustoPythonEditors[boxId] : null;
				const editors = [q, md, py].filter(Boolean);
				if (!editors.length) return;
				setTimeout(() => {
					for (const ed of editors) {
						try { if (ed && typeof ed.layout === 'function') ed.layout(); } catch (e) { console.error('[kusto]', e); }
					}
				}, 0);
			} catch (e) { console.error('[kusto]', e); }
		};

		// ── Reorder Popup: intercept drag-handle mousedown to open the minimap popup ──
		// A mousedown + small mousemove on any .section-drag-handle triggers the popup
		// instead of the native HTML5 drag. Works across shadow DOM boundaries.
		(function installReorderPopupTrigger() {
			let pending = false;
			let startX = 0;
			let startY = 0;
			let targetSectionId = '';
			const MOVE_THRESHOLD = 3; // px — avoid opening on accidental clicks

			const findSectionFromHandle = (handle: HTMLElement): HTMLElement | null => {
				// Walk from the handle's shadow host up to find a direct child of container.
				// Supports nested shadow DOM (e.g. handle inside kw-section-shell inside kw-python-section).
				try {
					let el: any = (handle.getRootNode?.() as any)?.host;
					while (el) {
						if (el.parentElement === container && el.id) return el;
						if (el.parentElement) {
							el = el.parentElement;
						} else {
							// Cross shadow boundary: parentElement is null when inside
							// another shadow root — walk to the outer host.
							el = (el.getRootNode?.() as any)?.host ?? null;
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				return null;
			};

			const onMouseMove = (e: MouseEvent) => {
				if (!pending) return;
				const dx = e.clientX - startX;
				const dy = e.clientY - startY;
				if (Math.abs(dx) + Math.abs(dy) < MOVE_THRESHOLD) return;
				// Threshold met — open the popup
				cleanup();
				try {
					const popup = document.getElementById('sectionReorderPopup') as any;
					if (popup && typeof popup.open === 'function' && !popup.isOpen) {
						popup.open(targetSectionId);
					}
				} catch (e) { console.error('[kusto]', e); }
			};

			const onMouseUp = () => {
				cleanup();
			};

			const cleanup = () => {
				pending = false;
				targetSectionId = '';
				document.removeEventListener('mousemove', onMouseMove, true);
				document.removeEventListener('mouseup', onMouseUp, true);
			};

			document.addEventListener('mousedown', (e: MouseEvent) => {
				if (pending) return;
				// Check compatibility mode
				try { if (pState.compatibilityMode) return; } catch (e) { console.error('[kusto]', e); }
				// Find handle across shadow DOM
				const path = e.composedPath?.() ?? [];
				let handle: HTMLElement | null = null;
				for (const el of path) {
					if ((el as HTMLElement).classList?.contains('section-drag-handle')) {
						handle = el as HTMLElement;
						break;
					}
				}
				if (!handle) return;
				const section = findSectionFromHandle(handle);
				if (!section) return;
				pending = true;
				startX = e.clientX;
				startY = e.clientY;
				targetSectionId = section.id;
				document.addEventListener('mousemove', onMouseMove, true);
				document.addEventListener('mouseup', onMouseUp, true);
			}, true);
		})();

		container.addEventListener('dragstart', (e: any) => {
			ensureGlobalDnDGuards();
			try {
				// Only allow reordering in .kqlx mode.
				if (pState.compatibilityMode) {
					try { e.preventDefault(); } catch (e) { console.error('[kusto]', e); }
					try { e.stopPropagation(); } catch (e) { console.error('[kusto]', e); }
					return;
				}
			} catch (e) { console.error('[kusto]', e); }

			// Check composedPath() first for shadow DOM drag handles, then fallback to e.target.closest.
			let handle: any = null;
			try {
				const path = e.composedPath ? e.composedPath() : [];
				for (const el of path) {
					if (el && el.classList && el.classList.contains('section-drag-handle')) {
						handle = el;
						break;
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			if (!handle) {
				handle = e && e.target && e.target.closest ? e.target.closest('.section-drag-handle') : null;
			}
			if (!handle) {
				return;
			}

			// Find the section host: walk composedPath for any direct child of the container.
			let box: any = null;
			try {
				const path = e.composedPath ? e.composedPath() : [];
				for (const el of path) {
					if (el && el.parentElement === container && el.id) {
						box = el;
						break;
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			// Fallback: walk from the handle's host element
			if (!box) {
				try {
					let el = handle.getRootNode?.()?.host;
					while (el) {
						if (el.parentElement === container && el.id) {
							box = el;
							break;
						}
						if (el.parentElement) {
							el = el.parentElement;
						} else {
							el = (el.getRootNode?.() as any)?.host ?? null;
						}
					}
				} catch (e) { console.error('[kusto]', e); }
			}
			if (!box || !box.id) {
				return;
			}

			// Open the reorder popup instead of doing an inline drag.
			try { e.preventDefault(); } catch (e) { console.error('[kusto]', e); }
			try {
				const popup = document.getElementById('sectionReorderPopup') as any;
				if (popup && typeof popup.open === 'function') {
					if (!popup.isOpen) {
						popup.open(String(box.id));
					}
					return;
				}
			} catch (e) { console.error('[kusto]', e); }

			// Fallback to legacy inline drag if popup is unavailable.
			draggingId = String(box.id);
			draggingDidDrop = false;
			try {
				// Remember original position so we can revert if the drag is cancelled.
				draggingOriginalNextSibling = box.nextElementSibling || null;
			} catch {
				draggingOriginalNextSibling = null;
			}
			try {
				if (e.dataTransfer) {
					e.dataTransfer.effectAllowed = 'move';
					// Keep the text payload empty so dropping over an editor/input can't insert meaningful text.
					try { e.dataTransfer.setData('text/plain', ''); } catch (e) { console.error('[kusto]', e); }
					try { e.dataTransfer.setData('application/x-kusto-section-reorder', draggingId); } catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
		});

		container.addEventListener('dragover', (e: any) => {
			if (!draggingId) {
				return;
			}
			try {
				e.preventDefault();
				if (e.dataTransfer) {
					e.dataTransfer.dropEffect = 'move';
				}
			} catch (e) { console.error('[kusto]', e); }

			// Live reorder as the mouse moves.
			try {
				const dragged = document.getElementById(draggingId) as any;
				if (!dragged) return;
				const y = typeof e.clientY === 'number' ? e.clientY : null;
				if (y === null) return;
				const boxes = Array.from(container.children || [])
					.filter((el: any) => el && el.classList && el.classList.contains('query-box') && el !== dragged);
				if (boxes.length === 0) return;

				let insertBeforeEl: any = null;
				for (const box of boxes as any[]) {
					let rect;
					try { rect = box.getBoundingClientRect(); } catch { rect = null; }
					if (!rect) continue;
					const midY = rect.top + (rect.height / 2);
					if (y < midY) {
						insertBeforeEl = box;
						break;
					}
				}
				if (insertBeforeEl) {
					if (dragged.nextElementSibling !== insertBeforeEl) {
						container.insertBefore(dragged, insertBeforeEl);
					}
				} else {
					if (container.lastElementChild !== dragged) {
						container.appendChild(dragged);
					}
				}
			} catch (e) { console.error('[kusto]', e); }
		});

		container.addEventListener('drop', (e: any) => {
			if (!draggingId) {
				return;
			}
			try { e.preventDefault(); } catch (e) { console.error('[kusto]', e); }
			draggingDidDrop = true;
			const dragged = document.getElementById(draggingId) as any;
			if (!dragged) {
				draggingId = '';
				return;
			}

			// Compute insertion point based on the drop Y position.
			// This is much more reliable when dropping in whitespace above the first or below the last section.
			try {
				const dropY = typeof e.clientY === 'number' ? e.clientY : null;
				const boxes = Array.from(container.children || [])
					.filter((el: any) => el && el.classList && el.classList.contains('query-box') && el !== dragged);

				if (boxes.length === 0) {
					container.appendChild(dragged);
				} else if (dropY === null) {
					container.appendChild(dragged);
				} else {
					let inserted = false;
					for (const box of boxes as any[]) {
						let rect;
						try { rect = box.getBoundingClientRect(); } catch { rect = null; }
						if (!rect) continue;
						const midY = rect.top + (rect.height / 2);
						if (dropY < midY) {
							container.insertBefore(dragged, box);
							inserted = true;
							break;
						}
					}
					if (!inserted) {
						container.appendChild(dragged);
					}
				}
			} catch {
				try { container.appendChild(dragged); } catch (e) { console.error('[kusto]', e); }
			}

			resyncArraysFromDom();
			bestEffortRelayoutMovedEditors(draggingId);
			try { schedulePersist && schedulePersist('reorder'); } catch (e) { console.error('[kusto]', e); }
			// Refresh Data dropdowns in Chart/Transformation sections to update position labels
			try { __kustoRefreshAllDataSourceDropdowns(); } catch (e) { console.error('[kusto]', e); }
			draggingId = '';
			draggingOriginalNextSibling = null;
		});

		container.addEventListener('dragend', () => {
			try {
				if (draggingId && !draggingDidDrop) {
					const dragged = document.getElementById(draggingId) as any;
					if (dragged) {
						if (draggingOriginalNextSibling && draggingOriginalNextSibling.parentElement === container) {
							container.insertBefore(dragged, draggingOriginalNextSibling);
						} else {
							container.appendChild(dragged);
						}
						resyncArraysFromDom();
						bestEffortRelayoutMovedEditors(draggingId);
						// Important: if the drop landed outside the container (e.g. over an editor/input),
						// the container 'drop' handler may not fire. Persist the reverted DOM order so
						// users can drag back to the original ordering and clear the dirty state.
						try { schedulePersist && schedulePersist('reorder'); } catch (e) { console.error('[kusto]', e); }
						// Refresh Data dropdowns in Chart/Transformation sections to update position labels
						try { __kustoRefreshAllDataSourceDropdowns(); } catch (e) { console.error('[kusto]', e); }
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			draggingId = '';
			draggingOriginalNextSibling = null;
			draggingDidDrop = false;
		});
	};

	tryInstall();
})();
