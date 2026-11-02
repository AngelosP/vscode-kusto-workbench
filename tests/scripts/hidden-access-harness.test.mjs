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

const notificationCaptureStart = feature.indexOf('const observeMetadataNotifications =');
const notificationCaptureEnd = feature.indexOf('const checkStartingDocuments =', notificationCaptureStart);
assert.ok(notificationCaptureStart >= 0 && notificationCaptureEnd > notificationCaptureStart);
const observeMetadataNotifications = runInNewContext(
	`${feature.slice(notificationCaptureStart, notificationCaptureEnd)}; observeMetadataNotifications`,
);
const supersededMessages = [
	'The KQL metadata snapshot was superseded before admission.',
	'The SQL metadata snapshot was superseded before admission.',
];

test('records targeted metadata errors on the extension SDK and forwards every notification unchanged', () => {
	const forwarded = [];
	const result = Promise.resolve('selected action');
	const controllerWindow = { showErrorMessage() { assert.fail('Must not use the controller SDK'); } };
	const workbenchWindow = {
		showErrorMessage(...args) {
			forwarded.push({ receiver: this, args });
			return result;
		},
	};
	const controllerOriginal = controllerWindow.showErrorMessage;
	const capture = observeMetadataNotifications(workbenchWindow);
	const options = { modal: false };
	const action = { title: 'Retry' };

	for (const message of [...supersededMessages, 'A genuine current failure']) {
		assert.equal(workbenchWindow.showErrorMessage(message, options, action), result);
		assert.deepEqual(forwarded.at(-1), { receiver: workbenchWindow, args: [message, options, action] });
	}
	assert.deepEqual([...capture.messages], supersededMessages);
	assert.equal(controllerWindow.showErrorMessage, controllerOriginal);
	assert.equal(capture.isCurrent(), true);
	assert.equal(capture.dispose(), true);
});

test('notification capture preserves synchronous failures from the original SDK', () => {
	const error = new Error('SDK notification failure');
	const window = { showErrorMessage() { throw error; } };
	const capture = observeMetadataNotifications(window);

	assert.throws(() => window.showErrorMessage(supersededMessages[0]), caught => caught === error);
	assert.deepEqual([...capture.messages], [supersededMessages[0]]);
	assert.equal(capture.dispose(), true);
});

for (const language of ['KQL', 'SQL']) {
	test(`records the ${language} final-snapshot timeout message with phase and time while forwarding it`, () => {
		const message = `Timed out waiting for the final ${language} metadata snapshot.`;
		const forwarded = [];
		const result = Promise.resolve(undefined);
		const window = { showErrorMessage(value) { forwarded.push(value); return result; } };
		const capture = observeMetadataNotifications(window, () => 'warm-3');

		assert.equal(window.showErrorMessage(message), result);
		assert.deepEqual(forwarded, [message]);
		assert.deepEqual([...capture.messages], []);
		assert.equal(capture.timeouts.length, 1);
		assert.equal(capture.timeouts[0].message, message);
		assert.equal(capture.timeouts[0].phase, 'warm-3');
		assert.equal(Number.isFinite(Date.parse(capture.timeouts[0].atUtc)), true);
		assert.match(capture.timeouts[0].stack, /Final metadata snapshot timeout observed/);
		assert.equal(capture.dispose(), true);
	});

	test(`records a prefixed ${language} close timeout rather than treating it as unrelated`, () => {
		const message = `Failed to save companion metadata: Timed out waiting for the final ${language} metadata snapshot.`;
		const forwarded = [];
		const result = Promise.resolve(undefined);
		const window = { showErrorMessage(value) { forwarded.push(value); return result; } };
		const capture = observeMetadataNotifications(window, () => 'cleanup');

		assert.equal(window.showErrorMessage(message), result);
		assert.deepEqual(forwarded, [message]);
		assert.equal(capture.timeouts.length, 1);
		assert.equal(capture.timeouts[0].message, message);
		assert.equal(capture.timeouts[0].phase, 'cleanup');
		assert.equal(capture.dispose(), true);
	});

	for (const prefix of ['', 'Failed to save companion metadata: ']) {
		test(`records ${prefix ? 'close' : 'background'} ${language} capture failure without hiding it`, () => {
			const message = `${prefix}Failed to capture the ${language} metadata snapshot.`;
			const result = Promise.resolve(undefined);
			const window = { showErrorMessage(value) { assert.equal(value, message); return result; } };
			const capture = observeMetadataNotifications(window);

			assert.equal(window.showErrorMessage(message), result);
			assert.deepEqual([...capture.messages], [message]);
			assert.equal(capture.timeouts.length, 0);
			assert.equal(capture.dispose(), true);
		});
	}
}

test('records genuine companion close errors beyond snapshot capture failures', () => {
	const message = 'Failed to save companion metadata: permission denied';
	const result = Promise.resolve(undefined);
	const window = { showErrorMessage(value) { assert.equal(value, message); return result; } };
	const capture = observeMetadataNotifications(window);

	assert.equal(window.showErrorMessage(message), result);
	assert.deepEqual([...capture.messages], [message]);
	assert.equal(capture.timeouts.length, 0);
	assert.equal(capture.dispose(), true);
});

test('keeps notification capture live through the promoted close arrival deadline', async () => {
	let finish;
	const observe = runInNewContext(
		`${feature.slice(notificationCaptureStart, notificationCaptureEnd)}; observeMetadataNotifications`,
		{ setTimeout: (callback, delay) => { assert.equal(delay, 3000); finish = callback; } },
	);
	const forwarded = [];
	const window = { showErrorMessage(message) { forwarded.push(message); } };
	const capture = observe(window, () => 'cleanup');
	let observed = false;
	const pending = capture.observeCloseReplyDeadline().then(() => { observed = true; });
	await Promise.resolve();
	assert.equal(observed, false);
	const message = 'Failed to save companion metadata: Timed out waiting for the final KQL metadata snapshot.';
	window.showErrorMessage(message);
	assert.deepEqual(forwarded, [message]);
	assert.equal(capture.timeouts[0].message, message);
	assert.equal(capture.timeouts[0].phase, 'cleanup');
	assert.equal(capture.isCurrent(), true);
	finish();
	await pending;
	assert.equal(observed, true);
	assert.equal(capture.dispose(), true);
});

test('observes delayed close replies before preservation and observer restoration', () => {
	const close = feature.indexOf('await helper.closeAcceptanceTabs(vscode, owner, [...references.keys()])');
	const wait = feature.indexOf('await notificationCapture?.observeCloseReplyDeadline()', close);
	const preserve = feature.indexOf("preservation('after-cleanup')", close);
	const restore = feature.indexOf('notificationCapture?.dispose()', close);
	assert.ok(close >= 0 && wait > close && preserve > wait && restore > preserve);
});

test('notification capture restores its own hook and stops recording after disposal', () => {
	const forwarded = [];
	const window = { showErrorMessage(message) { forwarded.push(message); } };
	const original = window.showErrorMessage;
	const capture = observeMetadataNotifications(window);
	window.showErrorMessage(supersededMessages[0]);

	assert.equal(capture.dispose(), true);
	assert.equal(window.showErrorMessage, original);
	assert.equal(capture.isCurrent(), false);
	window.showErrorMessage(supersededMessages[1]);
	assert.deepEqual(forwarded, supersededMessages);
	assert.deepEqual([...capture.messages], [supersededMessages[0]]);
});

test('notification capture reports lost ownership without overwriting a successor hook', () => {
	const window = { showErrorMessage() {} };
	const capture = observeMetadataNotifications(window);
	const successor = () => 'successor';
	window.showErrorMessage = successor;

	assert.equal(capture.isCurrent(), false);
	assert.equal(capture.dispose(), false);
	assert.equal(window.showErrorMessage, successor);
});

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
