import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const feature = readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/archive-original-canary-baseline/hidden-short-access.feature', import.meta.url), 'utf8');
const guardStart = feature.indexOf('const checkStartingDocuments =');
const guardEnd = feature.indexOf('const sampleDocument =', guardStart);
assert.ok(guardStart >= 0 && guardEnd > guardStart);
const classificationStart = feature.indexOf('const frameworkEmptyInput =');
const classificationEnd = feature.indexOf(';', classificationStart);
assert.ok(classificationStart >= 0 && classificationEnd > classificationStart);
const classify = runInNewContext(`document => (${feature.slice(
	classificationStart + 'const frameworkEmptyInput ='.length,
	classificationEnd,
)})`);
const hash = text => createHash('sha256').update(text).digest('hex');

function document(uri = 'file:///C:/protected.kqlx', text = 'protected') {
	return {
		uri: { toString: () => uri },
		languageId: 'plaintext',
		version: 1,
		isDirty: false,
		isClosed: false,
		text,
		getText() { return this.text; },
	};
}

function harness(initial, current) {
	const entry = {
		document: initial,
		uri: initial.uri.toString(),
		version: initial.version,
		dirty: initial.isDirty,
		bufferSha256: hash(initial.getText()),
		frameworkEmptyInput: classify(initial),
	};
	const outcome = { damage: [] };
	let disk = initial.getText();
	const check = runInNewContext(`${feature.slice(guardStart, guardEnd)}; checkStartingDocuments`, {
		startingDocuments: [entry],
		vscode: { workspace: { textDocuments: current } },
		outcome,
		hash,
		fs: { readFileSync: () => disk },
	});
	return { check, entry, outcome, setDisk: text => { disk = text; } };
}

test('allows replacement or retirement of the exact initially empty framework chat input', () => {
	for (const replaced of [true, false]) {
		const initial = document('chatSessionInput:input-0', '');
		const replacement = document('chatSessionInput:input-0', '');
		replacement.version = 2;
		const state = harness(initial, replaced ? [replacement] : []);
		initial.isClosed = true;

		assert.equal(state.entry.frameworkEmptyInput, true);
		assert.equal(state.check('framework-replacement'), true);
		assert.equal(state.outcome.damage.length, 0);
	}
});

for (const change of ['text', 'dirty', 'language']) {
	test(`rejects unexpected ${change} in a replacement framework input`, () => {
		const initial = document('chatSessionInput:input-0', '');
		const replacement = document('chatSessionInput:input-0', '');
		if (change === 'text') replacement.text = 'user draft';
		if (change === 'dirty') replacement.isDirty = true;
		if (change === 'language') replacement.languageId = 'kql';
		const state = harness(initial, [replacement]);

		assert.equal(state.check('unexpected-input'), false);
		assert.equal(state.outcome.damage[0].reason, 'framework-input-content-changed');
	});
}

test('does not exempt a nonempty chat input or a different chat input identity', () => {
	for (const initial of [document('chatSessionInput:input-0', 'user draft'), document('chatSessionInput:input-1', '')]) {
		const replacement = document(initial.uri.toString(), initial.getText());
		const state = harness(initial, [replacement]);

		assert.equal(state.entry.frameworkEmptyInput, false);
		assert.equal(state.check('replacement'), false);
	}
});

test('preserves the original document identity check for empty user files', () => {
	const initial = document('file:///C:/empty.kqlx', '');
	const replacement = document('file:///C:/empty.kqlx', '');
	const state = harness(initial, [replacement]);

	assert.equal(state.entry.frameworkEmptyInput, false);
	assert.equal(state.check('replacement'), false);
});

test('still rejects changed durable bytes when the original document remains unchanged', () => {
	const initial = document();
	const state = harness(initial, [initial]);
	state.entry.file = 'protected.kqlx';
	state.entry.fileSha256 = hash(initial.getText());
	assert.equal(state.check('baseline'), true);

	state.setDisk('changed externally');

	assert.equal(state.check('disk-change'), false);
	assert.equal(state.outcome.damage[0].reason, 'starting-document-changed');
});
