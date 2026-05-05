import './kw-tutorial-viewer.js';

const HOST_ID = 'kw-embedded-tutorial-viewer-host';
const STYLE_ID = 'kw-embedded-tutorial-viewer-style';

function ensureOverlayStyle(): void {
	if (document.getElementById(STYLE_ID)) {
		return;
	}
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
		#${HOST_ID} {
			position: fixed;
			inset: 0;
			z-index: 2147483000;
			display: block;
			pointer-events: none;
		}
		#${HOST_ID} kw-tutorial-viewer {
			width: 100%;
			height: 100%;
		}
	`;
	document.head.appendChild(style);
}

export async function showEmbeddedTutorialViewer(): Promise<void> {
	ensureOverlayStyle();
	let host = document.getElementById(HOST_ID);
	if (!host) {
		host = document.createElement('div');
		host.id = HOST_ID;
		host.setAttribute('data-testid', 'embedded-tutorial-viewer-host');
		const viewer = document.createElement('kw-tutorial-viewer');
		viewer.setAttribute('embedded', '');
		host.appendChild(viewer);
		document.body.appendChild(host);
	}
}

export function hideEmbeddedTutorialViewer(): void {
	document.getElementById(HOST_ID)?.remove();
}

window.addEventListener('message', event => {
	const message = event.data;
	if (!message || typeof message !== 'object') {
		return;
	}
	const type = String((message as { type?: unknown }).type ?? '');
	if (type === 'showEmbeddedTutorialViewer') {
		void showEmbeddedTutorialViewer().catch(error => console.error('[kusto] embedded tutorial viewer failed:', error));
	} else if (type === 'hideEmbeddedTutorialViewer') {
		hideEmbeddedTutorialViewer();
	}
});