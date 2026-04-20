// Active section tracker.
//
// Maintains the `is-active-section` class on exactly one section host element
// at a time, based on `focusin` events at the document level.
//
// Why not use `:focus-within` directly?
//   `:focus-within` toggles off and back on whenever focus briefly leaves a
//   section (e.g. clicking a button that doesn't retain focus, brief DOM
//   swaps during typing, etc.). Each toggle cancels and restarts any CSS
//   animation gated on it, so the pulsating "unsaved changes" glow never
//   completes a full cycle while the user is working.
//
// Behavior:
//   - On `focusin`, walk up to the nearest section host (id starts with one
//     of the known section prefixes). If found and it isn't already the
//     active section, remove `is-active-section` from the previously active
//     element and add it to this one. Otherwise do nothing.
//   - On `focusout`, do nothing. The class only switches when focus enters
//     a *different* section. This keeps the animation stable while the user
//     interacts inside the current section.

// Section hosts are custom elements named `kw-<kind>-section`. We match by
// tag name rather than id prefix because many inner descendants (e.g.
// `<div id="query_abc_query_editor">`, `<div id="query_abc_results_wrapper">`)
// also have ids starting with a section kind prefix. An id-based walk would
// stop at those inner divs and toggle `is-active-section` on them instead of
// on the true section host, breaking the `.query-box…is-active-section` glow
// selector whenever focus entered one of those inner elements (notably the
// Monaco editor container).
const SECTION_TAG_SUFFIX = '-SECTION';
const SECTION_TAG_PREFIX = 'KW-';

const ACTIVE_CLASS = 'is-active-section';

function isSectionHost(el: Element | null): el is HTMLElement {
	if (!el || !(el instanceof HTMLElement)) return false;
	const tag = el.tagName;
	return tag.startsWith(SECTION_TAG_PREFIX) && tag.endsWith(SECTION_TAG_SUFFIX);
}

function findSectionHost(start: Element | null): HTMLElement | null {
	let cur: Element | null = start;
	while (cur) {
		if (isSectionHost(cur)) return cur;
		cur = cur.parentElement;
	}
	return null;
}

function setActiveSection(section: HTMLElement): void {
	if (section.classList.contains(ACTIVE_CLASS)) return; // Already active — no-op.
	// Defensive: clear the class from any element that has it, in case a prior
	// swap was interrupted (DOM removal, etc.) and left a stale active marker.
	document.querySelectorAll('.' + ACTIVE_CLASS).forEach((el) => {
		if (el !== section) el.classList.remove(ACTIVE_CLASS);
	});
	section.classList.add(ACTIVE_CLASS);
}

function onFocusIn(ev: FocusEvent): void {
	try {
		// `event.target` is retargeted to the shadow host when focus enters an
		// open shadow root, so a single ancestor walk handles both cases.
		const target = ev.target as Element | null;
		const section = findSectionHost(target);
		if (!section) return; // Focus left all sections — keep current active one.
		setActiveSection(section);
	} catch (e) {
		// Defensive: never let focus tracking throw into the host.
		console.error('[kusto]', e);
	}
}

// Self-install on import.
document.addEventListener('focusin', onFocusIn, true);

// Seed from the current active element so a section that was already focused
// at install time (e.g. Monaco auto-focus during boot) becomes the active
// section without requiring an extra user interaction.
try {
	const section = findSectionHost(document.activeElement);
	if (section) setActiveSection(section);
} catch (e) {
	console.error('[kusto]', e);
}

export {};
