export function retireBrowserViewerElement<T extends HTMLElement>(
	element: T | null,
	beforeRemove?: (element: T) => void,
): null {
	if (!element) return null;
	beforeRemove?.(element);
	if (element.parentNode) element.parentNode.removeChild(element);
	return null;
}