import { describe, it, expect, afterEach } from 'vitest';
import { __kustoShouldDismissSuggestOnScrollTarget } from '../../src/webview/monaco/suggest.js';

function editorWithFocus(textFocus: boolean, widgetFocus = false): Record<string, any> {
	return {
		editor_1: {
			hasTextFocus: () => textFocus,
			hasWidgetFocus: () => widgetFocus,
		},
	};
}

describe('__kustoShouldDismissSuggestOnScrollTarget', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('keeps suggest open for Monaco editor scrolls', () => {
		const editorRoot = document.createElement('div');
		editorRoot.className = 'monaco-editor';
		const scrollTarget = document.createElement('div');
		editorRoot.appendChild(scrollTarget);
		document.body.appendChild(editorRoot);

		expect(__kustoShouldDismissSuggestOnScrollTarget(scrollTarget, {})).toBe(false);
	});

	it('keeps suggest open for suggest widget scrolls', () => {
		const widgetRoot = document.createElement('div');
		widgetRoot.className = 'suggest-widget';
		const scrollTarget = document.createElement('div');
		widgetRoot.appendChild(scrollTarget);
		document.body.appendChild(widgetRoot);

		expect(__kustoShouldDismissSuggestOnScrollTarget(scrollTarget, {})).toBe(false);
	});

	it('dismisses for legacy document scroll targets', () => {
		expect(__kustoShouldDismissSuggestOnScrollTarget(document, editorWithFocus(true))).toBe(true);
		expect(__kustoShouldDismissSuggestOnScrollTarget(document.documentElement, editorWithFocus(true))).toBe(true);
		expect(__kustoShouldDismissSuggestOnScrollTarget(document.body, editorWithFocus(true))).toBe(true);
	});

	it('keeps suggest open for body OverlayScrollbars viewport scroll while editor is focused', () => {
		const scrollViewport = document.createElement('div');
		scrollViewport.className = 'kw-scroll-viewport';
		document.body.appendChild(scrollViewport);

		expect(__kustoShouldDismissSuggestOnScrollTarget(scrollViewport, editorWithFocus(true))).toBe(false);
	});

	it('keeps suggest open for OverlayScrollbars internal viewport scroll while editor is focused', () => {
		const scrollViewport = document.createElement('div');
		scrollViewport.className = 'kw-scroll-viewport';
		const osViewport = document.createElement('div');
		osViewport.className = 'os-viewport';
		scrollViewport.appendChild(osViewport);
		document.body.appendChild(scrollViewport);

		expect(__kustoShouldDismissSuggestOnScrollTarget(osViewport, editorWithFocus(false, true))).toBe(false);
	});

	it('keeps suggest open for the marked page scroll element while editor is focused', () => {
		const scrollViewport = document.createElement('div');
		scrollViewport.className = 'kw-scroll-viewport';
		const scrollElement = document.createElement('div');
		scrollElement.setAttribute('data-kw-page-scroll-element', 'true');
		scrollViewport.appendChild(scrollElement);
		document.body.appendChild(scrollViewport);

		expect(__kustoShouldDismissSuggestOnScrollTarget(scrollElement, editorWithFocus(true))).toBe(false);
	});

	it('dismisses body OverlayScrollbars viewport scroll after editor focus is gone', () => {
		const scrollViewport = document.createElement('div');
		scrollViewport.className = 'kw-scroll-viewport';
		document.body.appendChild(scrollViewport);

		expect(__kustoShouldDismissSuggestOnScrollTarget(scrollViewport, editorWithFocus(false))).toBe(true);
	});

	it('does not ignore arbitrary descendants inside the page viewport', () => {
		const scrollViewport = document.createElement('div');
		scrollViewport.className = 'kw-scroll-viewport';
		const innerScrollTarget = document.createElement('div');
		scrollViewport.appendChild(innerScrollTarget);
		document.body.appendChild(scrollViewport);

		expect(__kustoShouldDismissSuggestOnScrollTarget(innerScrollTarget, editorWithFocus(true))).toBe(true);
	});
});