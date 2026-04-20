// section-insert-zone.ts — Insert-section affordance on the bottom edge of sections.
// A small "+" button appears anchored next to the cursor when hovering a section's
// bottom-edge resizer (the same gesture that thickens the resize line). Clicking "+"
// expands a picker with section types. The new section is inserted after the hovered one.

import { pState } from '../shared/persistence-state';
import { __kustoRequestAddSection } from './persistence';

// ── Constants ────────────────────────────────────────────────────────────────
/**
 * How close (px) to the section's bottom border the cursor must be.
 * Matches the resizer ::after hit-area (±3px around the 1px line).
 */
const EDGE_HIT_PX = 4;
/** Dismiss when scrolling more than this many pixels. */
const SCROLL_DISMISS_PX = 20;

// ── State ────────────────────────────────────────────────────────────────────
let activeBoxId: string | null = null;
let plusEl: HTMLElement | null = null;
let pickerEl: HTMLElement | null = null;
let scrollAtOpen: number | null = null;
let isPlusVisible = false;
let isExpanded = false;
/** True while the user is dragging a resizer. */
let isResizing = false;
/** The resizer element that has `is-dragging` forced on to keep the thick line visible. */
let activeResizer: HTMLElement | null = null;
/** The clientY of the section's bottom edge when the "+" was placed. */
let anchoredBottomY: number | null = null;

// ── DOM construction (one-time) ──────────────────────────────────────────────

function ensureDOM(): { plus: HTMLElement; picker: HTMLElement } {
	if (plusEl && pickerEl) return { plus: plusEl, picker: pickerEl };

	// The "+" circle — anchored next to the cursor on the section's bottom edge.
	plusEl = document.createElement('button');
	plusEl.className = 'insert-zone-plus';
	(plusEl as HTMLButtonElement).type = 'button';
	plusEl.title = 'Insert section here';
	plusEl.setAttribute('aria-label', 'Insert section here');
	plusEl.textContent = '+';
	document.body.appendChild(plusEl);

	// The section-kind picker — replaces the "+" on click.
	pickerEl = document.createElement('div');
	pickerEl.className = 'insert-zone-picker';
	pickerEl.setAttribute('role', 'toolbar');
	pickerEl.setAttribute('aria-label', 'Choose section type');
	document.body.appendChild(pickerEl);

	// "+" click → expand into picker.
	plusEl.addEventListener('click', (e: Event) => {
		e.stopPropagation();
		expand();
	});

	// Delegated click handler on the picker buttons.
	pickerEl.addEventListener('click', (e: Event) => {
		const target = (e.target as HTMLElement)?.closest?.('[data-insert-kind]') as HTMLElement | null;
		if (!target) return;
		const kind = target.getAttribute('data-insert-kind');
		// Read afterBoxId from the picker element — it was stamped there in expand().
		// This is immune to timing races that might clear activeBoxId before the click.
		const afterId = pickerEl!.getAttribute('data-after-box-id') || activeBoxId;
		if (!kind || !afterId) return;
		dismiss();
		__kustoRequestAddSection(kind, afterId);
	});

	// Keep visible while hovering either element.
	plusEl.addEventListener('mouseenter', () => { cancelDismissTimer(); });
	pickerEl.addEventListener('mouseenter', () => { cancelDismissTimer(); });
	plusEl.addEventListener('mouseleave', () => {
		// If the picker just opened, don't dismiss — the picker's own leave handles that.
		if (!isExpanded) scheduleDismiss();
	});
	pickerEl.addEventListener('mouseleave', () => { scheduleDismiss(); });

	return { plus: plusEl, picker: pickerEl };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function cancelDismissTimer() {
	if (dismissTimer !== null) { clearTimeout(dismissTimer); dismissTimer = null; }
}

function scheduleDismiss() {
	cancelDismissTimer();
	dismissTimer = setTimeout(() => { dismiss(); }, isExpanded ? 350 : 150);
}

function getAllowedKinds(): string[] {
	const defaults = ['query', 'chart', 'transformation', 'python', 'url', 'markdown'];
	try {
		const allowed = Array.isArray(pState.allowedSectionKinds)
			? pState.allowedSectionKinds.map((v: any) => String(v))
			: defaults;
		return allowed.length > 0 ? allowed : defaults;
	} catch { return defaults; }
}

function kindLabel(kind: string): string {
	switch (kind) {
		case 'query': return 'Kusto';
		case 'chart': return 'Chart';
		case 'transformation': return 'Transformation';
		case 'markdown': return 'Markdown';
		case 'python': return 'Python';
		case 'url': return 'URL';
		case 'html': return 'HTML';
		case 'sql': return 'SQL';
		default: return kind.charAt(0).toUpperCase() + kind.slice(1);
	}
}

function dismiss() {
	cancelDismissTimer();
	activeBoxId = null;
	scrollAtOpen = null;
	anchoredBottomY = null;
	isPlusVisible = false;
	isExpanded = false;
	if (plusEl) plusEl.classList.remove('visible');
	if (pickerEl) pickerEl.classList.remove('visible');
	deactivateResizer();
}

/** Expand the "+" into the section-kind picker. */
function expand() {
	if (!pickerEl || !plusEl) return;
	isExpanded = true;

	// Rebuild buttons (allowed kinds may have changed).
	pickerEl.innerHTML = '';
	const kinds = getAllowedKinds();
	for (const kind of kinds) {
		const btn = document.createElement('button');
		btn.className = 'insert-zone-btn';
		btn.setAttribute('data-insert-kind', kind);
		btn.textContent = kindLabel(kind);
		btn.type = 'button';
		pickerEl.appendChild(btn);
	}

	// Stamp the target section ID on the picker so the click handler can always
	// read it, even if a dismiss timer or edge-drift check clears activeBoxId.
	if (activeBoxId) {
		pickerEl.setAttribute('data-after-box-id', activeBoxId);
	}

	// Position picker centered on the "+"'s position.
	const plusRect = plusEl.getBoundingClientRect();
	const scrollY = window.scrollY || window.pageYOffset || 0;
	const centerX = plusRect.left + plusRect.width / 2;
	const topY = plusRect.top + scrollY;

	plusEl.classList.remove('visible');
	pickerEl.classList.add('visible');

	// Measure picker width, then center it.
	const pickerW = pickerEl.offsetWidth;
	let left = centerX - pickerW / 2;
	// Clamp to viewport.
	const vw = document.documentElement.clientWidth || window.innerWidth;
	if (left < 8) left = 8;
	if (left + pickerW > vw - 8) left = vw - 8 - pickerW;

	pickerEl.style.left = left + 'px';
	pickerEl.style.top = (topY - pickerEl.offsetHeight / 2) + 'px';

	// Cancel any pending dismiss from the plus's mouseleave, and start a generous
	// safety timeout — the user has plenty of time to reach the picker.
	cancelDismissTimer();
	dismissTimer = setTimeout(() => { dismiss(); }, 3000);
}

// ── Bottom-edge detection ────────────────────────────────────────────────────

interface EdgeInfo {
	boxId: string;
	bottomY: number; // clientY of the section's bottom border
}

function findBottomEdge(clientY: number): EdgeInfo | null {
	const container = document.getElementById('queries-container');
	if (!container) return null;

	const children = Array.from(container.children) as HTMLElement[];
	if (children.length < 1) return null;

	for (let i = 0; i < children.length; i++) {
		const el = children[i];
		if (!el.id) continue;
		const rect = el.getBoundingClientRect();
		if (rect.height === 0) continue;

		const bottomY = rect.bottom;
		if (clientY >= bottomY - EDGE_HIT_PX && clientY <= bottomY + EDGE_HIT_PX) {
			return { boxId: el.id, bottomY };
		}
	}
	return null;
}

// ── Resizer thick-line management ────────────────────────────────────────────
// Keep the resizer's thick highlight visible while the "+" or picker is active.
// Reuses the existing `is-dragging` class which already has CSS in both light
// DOM (queryEditor.css) and shadow DOM (.resizer styles) to show `height: 6px`.

function findBottomResizer(boxId: string): HTMLElement | null {
	const sectionEl = document.getElementById(boxId);
	if (!sectionEl) return null;

	// Light DOM resizers (query sections have results + editor resizers; chart has chart_resizer).
	for (const suffix of ['_results_resizer', '_chart_resizer', '_query_resizer']) {
		const el = document.getElementById(boxId + suffix);
		if (!el) continue;
		try { if (getComputedStyle(el).display === 'none') continue; } catch { continue; }
		return el;
	}

	// Shadow DOM resizers (python, markdown, url, transformation).
	try {
		const resizer = sectionEl.shadowRoot?.querySelector('.resizer') as HTMLElement | null;
		if (resizer) return resizer;
	} catch { /* no shadow root */ }

	return null;
}

function activateResizer(boxId: string): void {
	deactivateResizer();
	const resizer = findBottomResizer(boxId);
	if (resizer) {
		resizer.classList.add('is-dragging');
		activeResizer = resizer;
	}

	// Adopt the section's glow accent on the "+" button so it matches the sash.
	if (plusEl) {
		const sectionEl = document.getElementById(boxId);
		const status = sectionEl?.getAttribute('has-changes') || '';
		if (status) {
			const accent = getComputedStyle(sectionEl!).getPropertyValue('--kw-sash-accent').trim();
			if (accent) {
				plusEl.style.background = accent;
			}
		} else {
			plusEl.style.background = '';
		}
	}
}

function deactivateResizer(): void {
	if (activeResizer) {
		activeResizer.classList.remove('is-dragging');
		activeResizer = null;
	}
	if (plusEl) {
		plusEl.style.background = '';
	}
}

// ── Position the "+" ─────────────────────────────────────────────────────────

function showPlus(edge: EdgeInfo) {
	const { plus } = ensureDOM();
	const scrollY = window.scrollY || window.pageYOffset || 0;
	const topY = edge.bottomY + scrollY;

	// Center the "+" horizontally on the section.
	const sectionEl = document.getElementById(edge.boxId);
	const sectionRect = sectionEl?.getBoundingClientRect();
	const centerX = sectionRect ? (sectionRect.left + sectionRect.width / 2) : 0;
	plus.style.left = centerX + 'px';
	plus.style.top = topY + 'px';

	// Force-restart the CSS animation (and its delay) when switching sections.
	// Removing + re-adding .visible in the same frame is a no-op for the browser,
	// so we remove first, force a reflow, then re-add.
	if (plus.classList.contains('visible')) {
		plus.classList.remove('visible');
		void plus.offsetWidth; // reflow — resets the animation
	}
	plus.classList.add('visible');

	scrollAtOpen = scrollY;
	anchoredBottomY = edge.bottomY;
	isPlusVisible = true;

	// Force the resizer's thick highlight to stay visible.
	activateResizer(edge.boxId);
}

// ── Event listeners ──────────────────────────────────────────────────────────

function onMouseMove(e: MouseEvent) {
	if (isResizing) {
		// During resize, keep the "+" tracking the edge instead of hiding it.
		if (isPlusVisible || isExpanded) checkEdgeDrift();
		return;
	}

	// If the picker is expanded, don't move things around.
	if (isExpanded) {
		checkEdgeDrift();
		return;
	}

	// If the "+" is visible, check whether the section's bottom edge has moved
	// (e.g. user grabbed the resizer — shadow DOM resizers stopPropagation so we
	// can't always detect the mousedown).
	if (isPlusVisible) {
		checkEdgeDrift();
	}

	// If hovering over the plus or picker, don't dismiss — let their listeners handle it.
	if (plusEl?.matches(':hover')) return;
	if (pickerEl?.matches(':hover')) return;

	const edge = findBottomEdge(e.clientY);
	if (!edge) {
		// Not on any section's bottom edge.
		if (isPlusVisible && !isExpanded) {
			scheduleDismiss();
		}
		activeBoxId = null;
		return;
	}

	cancelDismissTimer();

	if (edge.boxId === activeBoxId && isPlusVisible) {
		// Same section edge, "+" already anchored — don't move it.
		return;
	}

	// New section edge (or first appearance) — show "+" centered on section.
	activeBoxId = edge.boxId;
	showPlus(edge);
}

function onScroll() {
	if ((!isPlusVisible && !isExpanded) || scrollAtOpen === null) return;
	const scrollY = window.scrollY || window.pageYOffset || 0;
	if (Math.abs(scrollY - scrollAtOpen) > SCROLL_DISMISS_PX) {
		dismiss();
	}
}

// ── Edge-drift detection ─────────────────────────────────────────────────────
// If the section's bottom edge has moved since we placed the "+", the user is
// resizing — reposition the "+" to track the new edge so it stays visible.

function repositionToEdge(newBottomY: number): void {
	if (!plusEl) return;
	const scrollY = window.scrollY || window.pageYOffset || 0;
	plusEl.style.top = (newBottomY + scrollY) + 'px';
	anchoredBottomY = newBottomY;
	scrollAtOpen = scrollY;
	// If the picker is expanded, reposition it too.
	if (isExpanded && pickerEl) {
		const plusRect = plusEl.getBoundingClientRect();
		pickerEl.style.top = (plusRect.top + scrollY - pickerEl.offsetHeight / 2) + 'px';
	}
}

function checkEdgeDrift(): void {
	if (anchoredBottomY === null || !activeBoxId) return;
	const el = document.getElementById(activeBoxId);
	if (!el) { dismiss(); return; }
	const currentBottom = el.getBoundingClientRect().bottom;
	if (Math.abs(currentBottom - anchoredBottomY) > 2) {
		repositionToEdge(currentBottom);
	}
}

// ── Resize-drag detection ────────────────────────────────────────────────────

function onResizeStart() {
	isResizing = true;
	// Keep the "+" visible — it will follow the edge via checkEdgeDrift.
}

function onResizeEnd() {
	isResizing = false;
}

// ── Initialization ───────────────────────────────────────────────────────────

try {
	document.addEventListener('mousemove', onMouseMove, { passive: true });
	window.addEventListener('scroll', onScroll, { passive: true });

	// Dismiss on Escape.
	document.addEventListener('keydown', (e: KeyboardEvent) => {
		if (e.key === 'Escape' && (isPlusVisible || isExpanded)) dismiss();
	});

	// Dismiss when clicking outside.
	document.addEventListener('mousedown', (e: MouseEvent) => {
		if (!isPlusVisible && !isExpanded) return;
		if (plusEl?.contains(e.target as Node)) return;
		if (pickerEl?.contains(e.target as Node)) return;
		dismiss();
	});

	// Dismiss when the mouse leaves the webview or the window loses focus —
	// mouseleave on the plus/picker only fires when moving to another element
	// inside the page, not when the cursor exits the window entirely.
	document.documentElement.addEventListener('mouseleave', () => {
		if (isPlusVisible || isExpanded) dismiss();
	});
	window.addEventListener('blur', () => {
		if (isPlusVisible || isExpanded) dismiss();
	});

	// Detect resize-drag start on any resizer element.
	// Check composedPath()[0] to pierce shadow DOM retargeting — shadow-DOM
	// resizers use class `.resizer` / `.resizer-v` which are invisible on the
	// retargeted host element.
	document.addEventListener('mousedown', (e: MouseEvent) => {
		const target = e.target as HTMLElement | null;
		if (!target) return;
		const origin = (e.composedPath?.()[0] ?? target) as HTMLElement;
		if (origin.classList?.contains('resizer') ||
			origin.classList?.contains('resizer-v') ||
			origin.classList?.contains('query-editor-resizer') ||
			origin.classList?.contains('chart-bottom-resizer') ||
			origin.classList?.contains('input-resizer') ||
			origin.closest?.('.query-editor-resizer')) {
			onResizeStart();
			const clear = () => { onResizeEnd(); document.removeEventListener('mouseup', clear, true); };
			document.addEventListener('mouseup', clear, true);
		}
	}, true);
} catch (e) { console.error('[kusto]', e); }
