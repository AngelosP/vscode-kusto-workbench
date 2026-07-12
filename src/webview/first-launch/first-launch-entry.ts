import './kw-first-launch-setup.js';
import { OverlayScrollbars } from 'overlayscrollbars';
import { osLibrarySheet } from '../shared/os-library-styles.js';
import { osThemeSheet } from '../shared/os-theme-styles.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, osLibrarySheet, osThemeSheet];

const scrollHost = document.getElementById('first-launch-scroll');
if (scrollHost) {
	const scrollbars = OverlayScrollbars(scrollHost, {
		scrollbars: {
			visibility: 'auto',
			autoHide: 'move',
			autoHideDelay: 800,
			autoHideSuspend: true,
		},
		overflow: {
			x: 'hidden',
			y: 'scroll',
		},
	});
	const setup = scrollHost.querySelector<HTMLElement>('kw-first-launch-setup');
	const refreshScrollbars = (): void => {
		try { scrollbars.update(true); } catch (error) { console.error('[kusto]', error); }
	};
	setup?.addEventListener('first-launch-layout-change', refreshScrollbars);
	if (setup && typeof ResizeObserver !== 'undefined') {
		new ResizeObserver(refreshScrollbars).observe(setup);
	}
	refreshScrollbars();
}