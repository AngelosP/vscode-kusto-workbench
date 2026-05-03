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
		content: [{
			id: 'agent-start',
			categoryId: 'agent',
			contentUrl: 'content/agent-start.md',
			minExtensionVersion: '0.0.0',
			updateToken: 'agent-start-v1',
		}],
		...overrides,
	};
}

describe('tutorial catalog validation', () => {
	it('accepts a valid catalog', () => {
		const result = validateTutorialCatalog(catalog(), '0.0.0-placeholder');
		expect(result.errors).toEqual([]);
		expect(result.catalog?.content).toHaveLength(1);
	});

	it('requires minExtensionVersion and updateToken', () => {
		const input = catalog({ content: [{ ...catalog().content[0], minExtensionVersion: '', updateToken: '' }] });
		const result = validateTutorialCatalog(input, '1.0.0');
		expect(result.catalog).toBeNull();
		expect(result.errors.join(' ')).toContain('minExtensionVersion');
		expect(result.errors.join(' ')).toContain('updateToken');
	});

	it('blocks unsafe content URLs', () => {
		const input = catalog({
			content: [{
				...catalog().content[0],
				contentUrl: 'command:kusto.openQueryEditor',
			}],
		});
		const result = validateTutorialCatalog(input, '1.0.0');
		expect(result.catalog).toBeNull();
		expect(result.errors.join(' ')).toContain('unsafe contentUrl');
	});

	it('strips legacy tutorial metadata fields', () => {
		const input = catalog({
			content: [{
				...catalog().content[0],
				title: 'Legacy title',
				summary: 'Legacy summary',
				tags: ['legacy'],
				sortOrder: 1,
				nativeWalkthroughId: 'legacy.walkthrough',
				actions: [{ id: 'bad', title: 'Bad', command: 'workbench.action.reloadWindow' }],
			} as any],
		} as any);
		const result = validateTutorialCatalog(input, '1.0.0');
		expect(result.errors).toEqual([]);
		expect((result.catalog?.content[0] as any).title).toBeUndefined();
		expect((result.catalog?.content[0] as any).summary).toBeUndefined();
		expect((result.catalog?.content[0] as any).tags).toBeUndefined();
		expect((result.catalog?.content[0] as any).sortOrder).toBeUndefined();
		expect((result.catalog?.content[0] as any).nativeWalkthroughId).toBeUndefined();
		expect((result.catalog?.content[0] as any).actions).toBeUndefined();
	});

	it('rejects invalid minExtensionVersion values', () => {
		const input = catalog({ content: [{ ...catalog().content[0], minExtensionVersion: 'soon' }] });
		const result = validateTutorialCatalog(input, '1.0.0');
		expect(result.catalog).toBeNull();
		expect(result.errors.join(' ')).toContain('invalid minExtensionVersion');
	});

	it('marks future tutorials incompatible without rejecting the catalog', () => {
		const input = catalog({ content: [{ ...catalog().content[0], minExtensionVersion: '99.0.0' }] });
		const result = validateTutorialCatalog(input, '1.0.0');
		expect(result.catalog).not.toBeNull();
		expect(result.incompatibleTutorialIds).toEqual(['agent-start']);
	});

	it('treats placeholder extension versions as permissive', () => {
		expect(isExtensionVersionCompatible('0.0.0-placeholder', '99.0.0')).toBe(true);
	});
});

describe('tutorial search', () => {
	it('searches derived display name, id, and category title', () => {
		const result = validateTutorialCatalog(catalog(), '1.0.0');
		const tutorials = result.catalog!.content.map(tutorial => ({ id: tutorial.id, displayName: 'Agent start', contentText: 'Searchable markdown body', categoryId: tutorial.categoryId, minExtensionVersion: tutorial.minExtensionVersion, compatible: true, unseen: true }));
		expect(searchTutorials(tutorials, result.catalog!.categories, 'start', null)).toHaveLength(1);
		expect(searchTutorials(tutorials, result.catalog!.categories, 'markdown body', null)).toHaveLength(1);
		expect(searchTutorials(tutorials, result.catalog!.categories, 'agent', 'agent')).toHaveLength(1);
		expect(searchTutorials(tutorials, result.catalog!.categories, 'missing', null)).toHaveLength(0);
	});
});
