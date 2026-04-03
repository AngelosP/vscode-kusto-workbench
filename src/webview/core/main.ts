// Main module — initialization orchestrator.
// Keyboard shortcuts, message handling, and drag-reorder are in their own modules.
import { pState } from '../shared/persistence-state';
import { postMessageToHost } from '../shared/webview-messages';
import { closeAllMenus as _closeAllDropdownMenus } from './dropdown';
import { __kustoCloseShareModal, __kustoShareCopyToClipboard } from '../sections/kw-query-toolbar';
import { __kustoRequestAddSection, schedulePersist } from './persistence';
import { queryEditors } from './state';

// Side-effect imports — register event handlers on import.
import './keyboard-shortcuts';
import './message-handler';
import './drag-reorder';

export {};

// Request connections on load (only in the query editor webview, not side-panel webviews
// like cached-values or connection-manager that also load the bundle).
if (window.vscode) {
	postMessageToHost({ type: 'getConnections' });
	// Global Copilot capability check (for add-controls Copilot button)
	try { postMessageToHost({ type: 'checkCopilotAvailability', boxId: '__kusto_global__' }); } catch (e) { console.error('[kusto]', e); }
	// Request document state on load (.kqlx custom editor)
	try { postMessageToHost({ type: 'requestDocument' }); } catch (e) { console.error('[kusto]', e); }
}

// Initial content is now driven by the .kqlx document state.

// ==========================================================================
// RESPONSIVE TOOLBAR LAYOUT
// ==========================================================================
// The query header toolbar now uses CSS Container Queries for responsive layout.
// This is more reliable than JS-based measurement which could race with layout
// when new sections are added (causing incorrect minimal/ultra-compact states).
//
// See queryEditor*.css for the @container rules that handle:
//   - Minimal mode: dropdowns collapse to icon-only at <= 420px
//   - Ultra-compact: hide refresh/favorite/schema buttons at <= 200px
//
// The legacy is-minimal and is-ultra-compact classes are still supported in CSS
// for backwards compatibility, but are no longer added by JavaScript.
// ==========================================================================

// ==========================================================================
// ADD SECTION DROPDOWN (for narrow viewports)
// ==========================================================================
// Toggle the "Add Section" dropdown menu (shown at narrow widths < 465px).
function __kustoToggleAddSectionDropdown( event: any) {
	try {
		if (event) {
			event.stopPropagation();
		}
		const btn = document.getElementById('addSectionDropdownBtn') as any;
		const menu = document.getElementById('addSectionDropdownMenu') as any;
		if (!btn || !menu) return;

		const wasOpen = menu.style.display === 'block';

		// Close all other dropdowns first.
		try {
			_closeAllDropdownMenus();
		} catch (e) { console.error('[kusto]', e); }

		if (wasOpen) {
			menu.style.display = 'none';
			btn.setAttribute('aria-expanded', 'false');
			return;
		}

		menu.style.display = 'block';
		btn.setAttribute('aria-expanded', 'true');

		// Apply visibility based on allowed section kinds.
		__kustoUpdateAddSectionDropdownVisibility();

	} catch (e) { console.error('[kusto]', e); }
}

// Called when a dropdown item is selected.
function __kustoAddSectionFromDropdown( kind: any) {
	try {
		// Close the dropdown.
		const btn = document.getElementById('addSectionDropdownBtn') as any;
		const menu = document.getElementById('addSectionDropdownMenu') as any;
		if (menu) menu.style.display = 'none';
		if (btn) btn.setAttribute('aria-expanded', 'false');

		// Add the section.
		__kustoRequestAddSection(kind);
	} catch (e) { console.error('[kusto]', e); }
}

// Update dropdown item visibility based on allowed section kinds (mirrors __kustoApplyDocumentCapabilities logic).
function __kustoUpdateAddSectionDropdownVisibility() {
	try {
		const allowed = Array.isArray(pState.allowedSectionKinds)
			? pState.allowedSectionKinds.map((v: any) => String(v))
			: ['query', 'chart', 'transformation', 'markdown', 'python', 'url', 'html'];

		const items = document.querySelectorAll('.add-controls-dropdown-item[data-add-kind]');
		for (const item of items as any) {
			const kind = item.getAttribute('data-add-kind');
			if (allowed.length === 0 || allowed.includes(kind)) {
				item.style.display = '';
			} else {
				item.style.display = 'none';
			}
		}
	} catch (e) { console.error('[kusto]', e); }
}

// Close dropdown when clicking outside.
document.addEventListener('click', (event: any) => {
	try {
		const menu = document.getElementById('addSectionDropdownMenu') as any;
		const btn = document.getElementById('addSectionDropdownBtn') as any;
		if (!menu || menu.style.display !== 'block') return;

		const target = event.target;
		if (target && typeof target.closest === 'function') {
			if (target.closest('.add-controls-dropdown')) {
				return; // Click inside dropdown, don't close.
			}
		}

		menu.style.display = 'none';
		if (btn) btn.setAttribute('aria-expanded', 'false');
	} catch (e) { console.error('[kusto]', e); }
});

// Close dropdown on Escape key.
document.addEventListener('keydown', (event: any) => {
	try {
		if (event.key !== 'Escape') return;
		const menu = document.getElementById('addSectionDropdownMenu') as any;
		const btn = document.getElementById('addSectionDropdownBtn') as any;
		if (!menu || menu.style.display !== 'block') return;

		menu.style.display = 'none';
		if (btn) btn.setAttribute('aria-expanded', 'false');
	} catch (e) { console.error('[kusto]', e); }
});

// ==========================================================================
// EVENT LISTENERS for static HTML elements (replace inline onclick handlers)
// ==========================================================================

// Add section buttons — delegated from .add-controls container using data-add-kind attribute.
try {
	const addControlsEl = document.querySelector('.add-controls');
	if (addControlsEl) {
		addControlsEl.addEventListener('click', (event: any) => {
			try {
				const dropdownBtn = event.target?.closest?.('.add-controls-dropdown-btn');
				if (dropdownBtn) {
					__kustoToggleAddSectionDropdown(event);
					return;
				}

				const btn = event.target?.closest?.('[data-add-kind]');
				if (!btn) return;
				const kind = btn.getAttribute('data-add-kind');
				if (!kind) return;
				// Dropdown items go through the dropdown handler.
				if (btn.classList.contains('add-controls-dropdown-item')) {
					__kustoAddSectionFromDropdown(kind);
				} else {
					__kustoRequestAddSection(kind);
				}
			} catch (e) { console.error('[kusto]', e); }
		});
	}
} catch (e) { console.error('[kusto]', e); }

// Share modal — event listeners replacing inline onclick handlers.
try {
	const shareModal = document.getElementById('shareModal');
	if (shareModal) {
		// Backdrop click closes the modal.
		shareModal.addEventListener('click', (event: any) => {
			try { __kustoCloseShareModal(event); } catch (e) { console.error('[kusto]', e); }
		});
		// Stop propagation on content area.
		const content = document.getElementById('shareModalContent');
		if (content) content.addEventListener('click', (event: any) => event.stopPropagation());
		// Close button.
		const closeBtn = document.getElementById('shareModalCloseBtn');
		if (closeBtn) closeBtn.addEventListener('click', () => { try { __kustoCloseShareModal(); } catch (e) { console.error('[kusto]', e); } });
		// Copy button.
		const copyBtn = document.getElementById('shareModalCopyBtn');
		if (copyBtn) copyBtn.addEventListener('click', () => { try { __kustoShareCopyToClipboard(); } catch (e) { console.error('[kusto]', e); } });
	}
} catch (e) { console.error('[kusto]', e); }

// ==========================================================================
// BATCH SECTION VISIBILITY (Ctrl+Click / Ctrl+Shift+Click on Show/Hide)
// ==========================================================================

function batchSetSectionExpanded(filterTag: string | null, expanded: boolean): void {
	const container = document.getElementById('queries-container');
	if (!container) return;
	const children = Array.from(container.children);
	for (const child of children) {
		if (!(child instanceof HTMLElement)) continue;
		if (filterTag && child.tagName.toLowerCase() !== filterTag) continue;
		if (typeof (child as any).setExpanded !== 'function') continue;
		// Query sections: sync legacy global state
		if (child.id.startsWith('query_')) {
			try {
				if (!window.__kustoQueryExpandedByBoxId || typeof window.__kustoQueryExpandedByBoxId !== 'object') {
					window.__kustoQueryExpandedByBoxId = {};
				}
				window.__kustoQueryExpandedByBoxId[child.id] = expanded;
			} catch (e) { console.error('[kusto]', e); }
		}
		try { (child as any).setExpanded(expanded); } catch (e) { console.error('[kusto]', e); }
		// Monaco layout pass for query sections when expanding
		if (expanded && child.id.startsWith('query_')) {
			try {
				const boxId = child.id;
				setTimeout(() => {
					try {
						const ed = queryEditors[boxId];
						if (ed && typeof ed.layout === 'function') ed.layout();
					} catch (e) { console.error('[kusto]', e); }
				}, 0);
			} catch (e) { console.error('[kusto]', e); }
		}
	}
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

// Ctrl+Click on Show/Hide: toggle ALL sections.
document.addEventListener('toggle-all-sections', (e: Event) => {
	try {
		const detail = (e as CustomEvent).detail;
		batchSetSectionExpanded(null, !!detail?.targetExpanded);
	} catch (e) { console.error('[kusto]', e); }
});

// Ctrl+Shift+Click on Show/Hide: toggle sections of the same type.
document.addEventListener('toggle-type-sections', (e: Event) => {
	try {
		const detail = (e as CustomEvent).detail;
		const path = (e as CustomEvent).composedPath?.() || [];
		const originSection = path.find((el: any) =>
			el?.tagName?.startsWith?.('KW-') && el?.tagName?.endsWith?.('-SECTION')
		);
		if (!originSection) return;
		batchSetSectionExpanded((originSection as Element).tagName.toLowerCase(), !!detail?.targetExpanded);
	} catch (e) { console.error('[kusto]', e); }
});

// Diff button click: request the host to open a section diff view.
document.addEventListener('show-section-diff', (e: Event) => {
	try {
		const detail = (e as CustomEvent).detail;
		const boxId = typeof detail?.boxId === 'string' ? String(detail.boxId) : '';
		if (boxId) {
			postMessageToHost({ type: 'showSectionDiff', sectionId: boxId });
		}
	} catch (e2) { console.error('[kusto]', e2); }
});


// ── Window bridges for remaining legacy callers ──
window.__kustoToggleAddSectionDropdown = __kustoToggleAddSectionDropdown;
window.__kustoAddSectionFromDropdown = __kustoAddSectionFromDropdown;
window.__kustoUpdateAddSectionDropdownVisibility = __kustoUpdateAddSectionDropdownVisibility;
