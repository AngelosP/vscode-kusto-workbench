import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reconcileProjectedSectionOrder } from '../../src/webview/core/section-projection-order.js';

describe('authoritative section projection order', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	it('orders mixed URL and query elements in one stable pass', () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		for (const id of ['query_1', 'url_1', 'url_2']) {
			const element = document.createElement(id.startsWith('url_') ? 'kw-url-section' : 'kw-query-section');
			element.id = id;
			container.appendChild(element);
		}
		document.body.appendChild(container);

		reconcileProjectedSectionOrder(['url_1', 'url_2', 'query_1']);

		expect(Array.from(container.children, element => element.id)).toEqual([
			'url_1', 'url_2', 'query_1',
		]);
	});

	it('preserves unprojected transient elements while ordering projected siblings', () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		for (const id of ['query_1', 'transient', 'url_1']) {
			const element = document.createElement('div');
			element.id = id;
			container.appendChild(element);
		}
		document.body.appendChild(container);

		reconcileProjectedSectionOrder(['url_1', 'query_1']);

		expect(Array.from(container.children, element => element.id)).toEqual([
			'transient', 'url_1', 'query_1',
		]);
	});

	it('does not move elements that already match the projected order', () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		for (const id of ['query_1', 'html_1', 'url_1']) {
			const element = document.createElement('div');
			element.id = id;
			container.appendChild(element);
		}
		document.body.appendChild(container);
		const insertBefore = vi.spyOn(container, 'insertBefore');

		reconcileProjectedSectionOrder(['query_1', 'html_1', 'url_1']);

		expect(insertBefore).not.toHaveBeenCalled();
	});
});
