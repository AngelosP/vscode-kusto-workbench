// Global Escape-key dismissal stack.
// Components push a callback when they open a dismissable UI (popup, toolbar, modal).
// A single document-level listener dismisses only the top-of-stack item on Escape.
// This ensures Escape closes one thing at a time in LIFO order — no hard-coded
// relationships between components, works for any nesting depth or combination.

type DismissCallback = () => void;

const stack: DismissCallback[] = [];
let installed = false;

function onEscape(e: KeyboardEvent): void {
	if (e.key !== 'Escape' || stack.length === 0) return;
	e.preventDefault();
	e.stopImmediatePropagation();
	const top = stack.pop()!;
	top();
}

function ensureListener(): void {
	if (installed) return;
	document.addEventListener('keydown', onEscape, true);
	installed = true;
}

/** Push a dismiss callback. Called when a dismissable UI opens. */
export function pushDismissable(cb: DismissCallback): void {
	ensureListener();
	stack.push(cb);
}

/** Remove a specific callback (e.g., when the UI is closed by other means). */
export function removeDismissable(cb: DismissCallback): void {
	const idx = stack.indexOf(cb);
	if (idx !== -1) stack.splice(idx, 1);
}
