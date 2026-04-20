/**
 * Typed helpers for accessing Lit section components and HTML elements from the DOM.
 * Replaces the pattern: `document.getElementById(boxId) as any` → typed element with known methods.
 */

import type { KwQuerySection } from '../sections/kw-query-section.js';
import type { KwQueryToolbar } from '../sections/kw-query-toolbar.js';
import type { KwChartSection } from '../sections/kw-chart-section.js';
import type { KwMarkdownSection } from '../sections/kw-markdown-section.js';
import type { KwPythonSection } from '../sections/kw-python-section.js';
import type { KwTransformationSection } from '../sections/kw-transformation-section.js';
import type { KwUrlSection } from '../sections/kw-url-section.js';

// ── Section element getters ────────────────────────────────────────────────

export function getQuerySection(boxId: string): KwQuerySection | null {
	return document.getElementById(boxId) as KwQuerySection | null;
}

export function getQueryToolbar(boxId: string): KwQueryToolbar | null {
	return document.querySelector(`kw-query-toolbar[box-id="${boxId}"]`) as KwQueryToolbar | null;
}

export function getChartSection(boxId: string): KwChartSection | null {
	return document.getElementById(boxId) as KwChartSection | null;
}

export function getMarkdownSection(boxId: string): KwMarkdownSection | null {
	return document.getElementById(boxId) as KwMarkdownSection | null;
}

export function getPythonSection(boxId: string): KwPythonSection | null {
	return document.getElementById(boxId) as KwPythonSection | null;
}

export function getTransformationSection(boxId: string): KwTransformationSection | null {
	return document.getElementById(boxId) as KwTransformationSection | null;
}

export function getUrlSection(boxId: string): KwUrlSection | null {
	return document.getElementById(boxId) as KwUrlSection | null;
}

// ── Common section interface (duck-typed contract all sections implement) ──

/** Minimal contract that all section elements satisfy for external callers. */
export interface SectionElement extends HTMLElement {
	serialize(): unknown;
	getName(): string;
	setName(name: string): void;
}

export function getSectionElement(boxId: string): SectionElement | null {
	return document.getElementById(boxId) as SectionElement | null;
}

// ── HTML element getters ───────────────────────────────────────────────────

export function getInputElement(id: string): HTMLInputElement | null {
	return document.getElementById(id) as HTMLInputElement | null;
}

export function getSelectElement(id: string): HTMLSelectElement | null {
	return document.getElementById(id) as HTMLSelectElement | null;
}

export function getButtonElement(id: string): HTMLButtonElement | null {
	return document.getElementById(id) as HTMLButtonElement | null;
}

export function getHtmlElement(id: string): HTMLElement | null {
	return document.getElementById(id);
}
