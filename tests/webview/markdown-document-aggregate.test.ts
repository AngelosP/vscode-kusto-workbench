import { describe, expect, it } from 'vitest';

import { MarkdownDocumentAggregate } from '../../src/shared/markdownDocumentAggregate.js';

function createDocument() {
	const created = MarkdownDocumentAggregate.create({
		sections: [
			{ id: 'markdown_1', type: 'markdown', title: 'One', text: 'before' },
			{ id: 'future_1', type: 'future-section', payload: { keep: true } },
		],
	});
	if (!created.ok) throw new Error(created.error);
	return created.document;
}

describe('MarkdownDocumentAggregate', () => {
	it('applies immutable add, patch, and remove transitions with monotonic revisions', () => {
		const initial = createDocument();
		const added = initial.transition({
			expectedDocumentRevision: 0,
			command: {
				type: 'add', afterSectionId: 'markdown_1',
				section: { id: 'markdown_2', type: 'markdown', text: 'temporary' },
			},
		});
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		expect(added.documentRevision).toBe(1);
		expect(added.sectionRevision).toBe(1);
		expect(initial.snapshot().sections.map(section => section.id)).toEqual(['markdown_1', 'future_1']);

		const patched = added.document.transition({
			expectedDocumentRevision: 1,
			command: {
				type: 'patch', sectionId: 'markdown_1', expectedSectionRevision: 0,
				patch: { text: 'after', editorHeightPx: 300 },
			},
		});
		expect(patched.ok).toBe(true);
		if (!patched.ok) return;
		expect(patched.documentRevision).toBe(2);
		expect(patched.sectionRevision).toBe(1);

		const clearedHeight = patched.document.transition({
			expectedDocumentRevision: 2,
			command: {
				type: 'patch', sectionId: 'markdown_1', expectedSectionRevision: 1,
				patch: { editorHeightPx: null },
			},
		});
		expect(clearedHeight.ok).toBe(true);
		if (!clearedHeight.ok) return;
		expect(clearedHeight.document.snapshot().sections[0]).not.toHaveProperty('editorHeightPx');

		const removed = clearedHeight.document.transition({
			expectedDocumentRevision: 3,
			command: { type: 'remove', sectionId: 'markdown_2', expectedSectionRevision: 1 },
		});
		expect(removed.ok).toBe(true);
		if (!removed.ok) return;
		expect(removed.document.snapshot().sections.map(section => section.id)).toEqual(['markdown_1', 'future_1']);
	});

	it('rejects stale document and section revisions without mutation', () => {
		const initial = createDocument();
		const staleDocument = initial.transition({
			expectedDocumentRevision: 9,
			command: { type: 'patch', sectionId: 'markdown_1', expectedSectionRevision: 0, patch: { text: 'stale' } },
		});
		expect(staleDocument.ok).toBe(false);
		if (staleDocument.ok) return;
		expect(staleDocument.error.code).toBe('stale-document-revision');
		expect(staleDocument.document).toBe(initial);

		const staleSection = initial.transition({
			expectedDocumentRevision: 0,
			command: { type: 'patch', sectionId: 'markdown_1', expectedSectionRevision: 3, patch: { text: 'stale' } },
		});
		expect(staleSection.ok).toBe(false);
		if (staleSection.ok) return;
		expect(staleSection.error.code).toBe('stale-section-revision');
		expect(staleSection.document.snapshot().sections[0].text).toBe('before');
	});

	it('rejects duplicate, missing, malformed, and non-Markdown commands', () => {
		const initial = createDocument();
		const cases = [
			initial.transition({
				expectedDocumentRevision: 0,
				command: { type: 'add', section: { id: 'markdown_1', type: 'markdown', text: 'duplicate' } },
			}),
			initial.transition({
				expectedDocumentRevision: 0,
				command: { type: 'remove', sectionId: 'future_1', expectedSectionRevision: 0 },
			}),
			initial.transition({
				expectedDocumentRevision: 0,
				command: { type: 'add', section: { id: 'markdown_bad', type: 'markdown', expanded: 'yes' } },
			}),
		] as const;
		expect(cases.map(result => result.ok ? 'ok' : result.error.code)).toEqual([
			'duplicate-section-id', 'missing-section', 'invalid-command',
		]);
	});

	it('rejects null editor height when materializing persisted Markdown', () => {
		const created = MarkdownDocumentAggregate.create({
			sections: [{ id: 'markdown_1', type: 'markdown', editorHeightPx: null }],
		});
		expect(created.ok).toBe(false);
		if (!created.ok) expect(created.error).toContain('editorHeightPx');
	});

	it('takes non-Markdown state from the current adapter snapshot', () => {
		const created = MarkdownDocumentAggregate.create({
			sections: [
				{ id: 'query_1', type: 'query', query: 'before', futureQuery: { keep: true } },
				{ id: 'markdown_1', type: 'markdown', text: 'owned' },
			],
		});
		if (!created.ok) throw new Error(created.error);
		const rebased = created.document.withAdapterState({ sections: [
			{ id: 'query_1', type: 'query', query: 'after' },
			{ id: 'markdown_1', type: 'markdown', text: 'stale adapter' },
		] });
		expect(rebased.snapshot().sections).toEqual([
			{ id: 'query_1', type: 'query', query: 'after' },
			{ id: 'markdown_1', type: 'markdown', text: 'owned' },
		]);
	});
});