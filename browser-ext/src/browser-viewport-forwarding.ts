export type BrowserViewportMessage = Readonly<{
	type: 'kusto-workbench-viewport';
	scrollTop: number;
	viewportHeight: number;
}>;

interface BrowserViewportTarget {
	innerHeight: number;
	addEventListener(type: 'scroll' | 'resize', listener: EventListener, options?: AddEventListenerOptions | boolean): void;
	removeEventListener(type: 'scroll' | 'resize', listener: EventListener, options?: EventListenerOptions | boolean): void;
}

export function installBrowserViewportForwarding(
	target: BrowserViewportTarget,
	getIframeTop: () => number,
	send: (message: BrowserViewportMessage) => void,
	isCurrent: () => boolean,
): () => void {
	let disposed = false;
	const sendViewportInfo: EventListener = () => {
		if (disposed || !isCurrent()) return;
		send({
			type: 'kusto-workbench-viewport',
			scrollTop: Math.max(0, -getIframeTop()),
			viewportHeight: target.innerHeight,
		});
	};
	const options: AddEventListenerOptions = { passive: true };
	target.addEventListener('scroll', sendViewportInfo, options);
	target.addEventListener('resize', sendViewportInfo, options);
	sendViewportInfo(new Event('scroll'));

	return () => {
		if (disposed) return;
		disposed = true;
		target.removeEventListener('scroll', sendViewportInfo, options);
		target.removeEventListener('resize', sendViewportInfo, options);
	};
}