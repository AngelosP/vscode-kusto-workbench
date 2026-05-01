import { describe, expect, it } from 'vitest';
import {
	searchTutorials,
	validateTutorialCatalog,
	isExtensionVersionCompatible,
	type TutorialCatalog,
} from '../../../src/shared/tutorials/tutorialCatalog.js';

function catalog(overrides: Partial<TutorialCatalog> = {}): TutorialCatalog {
	return {
		schemaVersion: 1,
		generatedAt: '2026-05-01T00:00:00.000Z',
		categories: [{ id: 'agent', title: 'Agent', sortOrder: 1 }],
		tutorials: [{
			id: 'agent-start',
			title: 'Agent start',
			summary: 'Build a chart with the agent',
			categoryId: 'agent',
			contentUrl: 'content/agent-start.md',
			minExtensionVersion: '0.0.0',
			updateToken: 'agent-start-v1',
			tags: ['chart'],
		}],
		...overrides,
	};
}

describe('tutorial catalog validation', () => {
	it('accepts a valid catalog', () => {
		const result = validateTutorialCatalog(catalog(), '0.0.0-placeholder');
		expect(result.errors).toEqual([]);
		expect(result.catalog?.tutorials).toHaveLength(1);
	});

	it('requires minExtensionVersion and updateToken', () => {
		const input = catalog({ tutorials: [{ ...catalog().tutorials[0], minExtensionVersion: '', updateToken: '' }] });
		const result = validateTutorialCatalog(input, '1.0.0');
		expect(result.catalog).toBeNull();
		expect(result.errors.join(' ')).toContain('minExtensionVersion');
		expect(result.errors.join(' ')).toContain('updateToken');
	});

	it('blocks unsafe content URLs', () => {
		const input = catalog({
			tutorials: [{
				...catalog().tutorials[0],
				contentUrl: 'command:kusto.openQueryEditor',
			}],
		});
		const result = validateTutorialCatalog(input, '1.0.0');
		expect(result.catalog).toBeNull();
		expect(result.errors.join(' ')).toContain('unsafe contentUrl');
	});

	it('blocks arbitrary commands', () => {
		const input = catalog({
			tutorials: [{
				...catalog().tutorials[0],
				actions: [{ id: 'bad', title: 'Bad', command: 'workbench.action.reloadWindow' }],
			}],
		});
		const result = validateTutorialCatalog(input, '1.0.0');
		expect(result.catalog).toBeNull();
		expect(result.errors.join(' ')).toContain('blocked command');
	});

	it('rejects invalid minExtensionVersion values', () => {
		const input = catalog({ tutorials: [{ ...catalog().tutorials[0], minExtensionVersion: 'soon' }] });
		const result = validateTutorialCatalog(input, '1.0.0');
		expect(result.catalog).toBeNull();
		expect(result.errors.join(' ')).toContain('invalid minExtensionVersion');
	});

	it('drops catalog action args from viewer-safe actions', () => {
		const input = catalog({
			tutorials: [{
				...catalog().tutorials[0],
				actions: [{ id: 'open', title: 'Open', command: 'kusto.openQueryEditor', args: ['ignored'] } as any],
			}],
		});
		const result = validateTutorialCatalog(input, '1.0.0');
		expect(result.errors).toEqual([]);
		expect(result.catalog?.tutorials[0].actions?.[0]).toEqual({ id: 'open', title: 'Open', command: 'kusto.openQueryEditor' });
	});

	it('marks future tutorials incompatible without rejecting the catalog', () => {
		const input = catalog({ tutorials: [{ ...catalog().tutorials[0], minExtensionVersion: '99.0.0' }] });
		const result = validateTutorialCatalog(input, '1.0.0');
		expect(result.catalog).not.toBeNull();
		expect(result.incompatibleTutorialIds).toEqual(['agent-start']);
	});

	it('treats placeholder extension versions as permissive', () => {
		expect(isExtensionVersionCompatible('0.0.0-placeholder', '99.0.0')).toBe(true);
	});
});

describe('tutorial search', () => {
	it('searches title, summary, tags, and category title', () => {
		const result = validateTutorialCatalog(catalog(), '1.0.0');
		const tutorials = result.catalog!.tutorials.map(tutorial => ({ ...tutorial, tags: tutorial.tags ?? [], actions: [], compatible: true }));
		expect(searchTutorials(tutorials, result.catalog!.categories, 'chart', null)).toHaveLength(1);
		expect(searchTutorials(tutorials, result.catalog!.categories, 'agent', 'agent')).toHaveLength(1);
		expect(searchTutorials(tutorials, result.catalog!.categories, 'missing', null)).toHaveLength(0);
	});
});
