export function reconcileProjectedSectionOrder(orderedSectionIds: readonly string[]): void {
	const container = document.getElementById('queries-container');
	if (!container) return;
	const seen = new Set<string>();
	const orderedElements: HTMLElement[] = [];
	for (const rawId of orderedSectionIds) {
		const id = String(rawId || '').trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const element = document.getElementById(id);
		if (element instanceof HTMLElement && element.parentElement === container) {
			orderedElements.push(element);
		}
	}
	let anchor: ChildNode | null = null;
	for (let index = orderedElements.length - 1; index >= 0; index--) {
		const element = orderedElements[index];
		if (element.nextSibling !== anchor) container.insertBefore(element, anchor);
		anchor = element;
	}
}
