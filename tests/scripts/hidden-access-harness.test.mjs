import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
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

const activationOracleStart = feature.indexOf('const firstNativeActivationOracle =');
const notesOracleStart = feature.indexOf('const notesOracle =', activationOracleStart);
const dashboardOracleStart = feature.indexOf('const dashboardOracle =', notesOracleStart);
assert.ok(activationOracleStart >= 0 && notesOracleStart > activationOracleStart && dashboardOracleStart > notesOracleStart);
const firstActivationOracle = runInNewContext(`${feature.slice(activationOracleStart, notesOracleStart)}; firstNativeActivationOracle`);
const expectedCanaryNotes = [{ id: 'original-note', text: 'unchanged' }];
const notesOracle = runInNewContext(`${feature.slice(notesOracleStart, dashboardOracleStart)}; notesOracle`, {
	equal: isDeepStrictEqual,
	expectedNotes: expectedCanaryNotes,
});
const targetUri = 'file:///C:/replay/history/past/azure-mcp-vs-tool-calls-investigation.kqlx';

function coldActivation() {
	return {
		complete: true,
		value: { success: true, isLiveWorkbench: true, isReadOnlyFallback: false, fileKind: 'kqlx', uri: targetUri, openFileId: 'opaque-file-id' },
		tabsBefore: [],
		tabsAfter: [{ uri: targetUri, viewType: 'kusto.kqlxEditor', active: true, groupActive: true, dirty: false }],
	};
}

test('recognizes a first live activation without treating an older copy as the same URI', () => {
	const record = coldActivation();
	record.tabsBefore.push({ uri: targetUri.replace('/replay/', '/older-replay/') });
	assert.equal(firstActivationOracle(record, targetUri), true);
});

test('rejects the reported target88 bridge failure even though its native tab is active', () => {
	const record = coldActivation();
	record.elapsedMs = 30736.5833;
	record.value.success = false;
	record.value.isLiveWorkbench = false;
	record.value.error = 'The targeted Kusto Workbench editor could not restore its live section bridge.';
	assert.equal(firstActivationOracle(record, targetUri), false);
});

for (const [name, change] of [
	['warmed target', record => record.tabsBefore.push({ uri: targetUri })],
	['non-live metadata', record => { record.value.isLiveWorkbench = false; }],
	['read-only fallback', record => { record.value.isReadOnlyFallback = true; }],
	['wrong URI', record => { record.value.uri = 'file:///C:/other.kqlx'; }],
	['missing file identity', record => { delete record.value.openFileId; }],
	['missing native tab', record => { record.tabsAfter = []; }],
	['inactive native tab', record => { record.tabsAfter[0].active = false; }],
	['dirty native tab', record => { record.tabsAfter[0].dirty = true; }],
	['transport failure', record => { record.transportError = 'disconnected'; }],
	['invalid response JSON', record => { record.parseError = 'invalid JSON'; }],
]) {
	test(`does not qualify target88 first activation with ${name}`, () => {
		const record = coldActivation();
		change(record);
		assert.equal(firstActivationOracle(record, targetUri), false);
	});
}

test('distinguishes successful empty notes from an unavailable snapshot and preserves the canary oracle', () => {
	assert.equal(notesOracle({ value: { success: true, notes: [] } }, []), true);
	assert.equal(notesOracle({ value: { success: false } }, []), false);
	assert.equal(notesOracle({ value: { success: false, notes: [], error: 'snapshot unavailable' } }, []), false);
	assert.equal(notesOracle({ value: { success: true } }, []), false);
	assert.equal(notesOracle({ value: { success: true, notes: [] } }), false);
	assert.equal(notesOracle({ value: { success: true, notes: expectedCanaryNotes } }), true);
});
