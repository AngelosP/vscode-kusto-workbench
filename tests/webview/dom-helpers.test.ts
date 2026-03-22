import { beforeEach, describe, expect, it } from 'vitest';
import {
	getButtonElement,
	getChartSection,
	getHtmlElement,
	getInputElement,
	getMarkdownSection,
	getPythonSection,
	getQuerySection,
	getQueryToolbar,
	getSectionElement,
	getSelectElement,
	getTransformationSection,
	getUrlSection,
} from '../../src/webview/shared/dom-helpers.js';

describe('dom-helpers', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	it('returns section elements by id', () => {
		const query = document.createElement('div');
		query.id = 'query_1';
		const chart = document.createElement('div');
		chart.id = 'chart_1';
		const markdown = document.createElement('div');
		markdown.id = 'markdown_1';
		const python = document.createElement('div');
		python.id = 'python_1';
		const transform = document.createElement('div');
		transform.id = 'transformation_1';
		const url = document.createElement('div');
		url.id = 'url_1';

		document.body.append(query, chart, markdown, python, transform, url);

		expect(getQuerySection('query_1')).toBe(query);
		expect(getChartSection('chart_1')).toBe(chart);
		expect(getMarkdownSection('markdown_1')).toBe(markdown);
		expect(getPythonSection('python_1')).toBe(python);
		expect(getTransformationSection('transformation_1')).toBe(transform);
		expect(getUrlSection('url_1')).toBe(url);
	});

	it('returns toolbar by box-id selector', () => {
		const toolbar = document.createElement('kw-query-toolbar');
		toolbar.setAttribute('box-id', 'query_123');
		document.body.appendChild(toolbar);

		expect(getQueryToolbar('query_123')).toBe(toolbar);
		expect(getQueryToolbar('missing')).toBeNull();
	});

	it('returns generic typed html elements', () => {
		const input = document.createElement('input');
		input.id = 'inp';
		const select = document.createElement('select');
		select.id = 'sel';
		const button = document.createElement('button');
		button.id = 'btn';
		const div = document.createElement('div');
		div.id = 'box';
		div.setAttribute('data-kind', 'x');
		document.body.append(input, select, button, div);

		expect(getInputElement('inp')).toBe(input);
		expect(getSelectElement('sel')).toBe(select);
		expect(getButtonElement('btn')).toBe(button);
		expect(getHtmlElement('box')).toBe(div);
	});

	it('returns null when elements are missing', () => {
		expect(getQuerySection('none')).toBeNull();
		expect(getSectionElement('none')).toBeNull();
		expect(getInputElement('none')).toBeNull();
		expect(getSelectElement('none')).toBeNull();
		expect(getButtonElement('none')).toBeNull();
		expect(getHtmlElement('none')).toBeNull();
	});

	it('returns a section element with serialize contract', () => {
		const section = document.createElement('div') as unknown as HTMLElement & {
			serialize: () => unknown;
			getName: () => string;
		};
		section.id = 'query_2';
		section.serialize = () => ({ type: 'query', id: 'query_2' });
		section.getName = () => 'Query 2';
		document.body.appendChild(section);

		const found = getSectionElement('query_2');
		expect(found).toBe(section);
		expect(found?.serialize()).toEqual({ type: 'query', id: 'query_2' });
		expect(found?.getName()).toBe('Query 2');
	});
});
