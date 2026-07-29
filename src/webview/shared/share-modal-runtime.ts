let activeOwnerBoxId = '';
let closeActiveModal: (() => void) | undefined;

export function registerActiveShareModal(boxId: unknown, close: () => void): void {
	activeOwnerBoxId = String(boxId || '').trim();
	closeActiveModal = activeOwnerBoxId ? close : undefined;
}

export function clearActiveShareModal(boxId?: unknown): void {
	const expected = boxId === undefined ? activeOwnerBoxId : String(boxId || '').trim();
	if (expected && expected !== activeOwnerBoxId) return;
	activeOwnerBoxId = '';
	closeActiveModal = undefined;
}

export function closeShareModalForOwner(boxId: unknown): void {
	const id = String(boxId || '').trim();
	if (!id || id !== activeOwnerBoxId) return;
	closeActiveModal?.();
}
