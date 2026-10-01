import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { armsFor, classify, finalizeAttemptEvidence, parseArgs, scanSaveLogs } from '../../scripts/repro-published-notebook.mjs';

const require = createRequire(import.meta.url);
const { createJournal, assertSeparateRoots } = require('../vscode-extension-tester/e2e/default/published-notebook-corruption/lifecycle-journal.cjs');
const makeText = (value = 'original') => JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [
  { id: 'first', type: 'query', query: 'print Value=1', resultJson: JSON.stringify({ columns: [{ name: 'Value', type: 'string' }], rows: [[value]] }), resultArtifact: { id: 'saved-result', revision: 1 } },
  { id: 'second', type: 'query', query: 'print Value=2' },
] } });

for (const name of ['published-notebook-corruption', 'native-save-workflows', 'native-slow-save', 'native-save-close-race']) test(name + ' expressions are valid JavaScript', () => {
  const feature = fs.readFileSync(new URL('../vscode-extension-tester/e2e/default/' + name + '/' + name + '.feature', import.meta.url), 'utf8');
  const inline = [...feature.matchAll(/from (?:extension host|webview) expression "(.*)"/g)].map(match => match[1]);
  const blocks = [...feature.matchAll(/"""\r?\n([\s\S]*?)\r?\n\s*"""/g)].map(match => match[1]);
  const evaluations = [...feature.matchAll(/I evaluate "(.*)" in the webview/g)].map(match => match[1]);
  assert.ok(inline.length > 0);
  assert.equal(inline.length + blocks.length, [...feature.matchAll(/from (?:extension host|webview) expression/g)].length);
  assert.ok(blocks.length > 0);
  for (const expression of [...inline, ...blocks, ...evaluations]) assert.doesNotThrow(() => new Script(expression));
});

test('replay arms are independent ABBA pairs with a fixed budget', () => {
  assert.deepEqual(armsFor({ repeats: 3, autosave: 'both' }).map(arm => arm.autoSave), ['afterDelay', 'off', 'off', 'afterDelay', 'afterDelay', 'off']);
});

test('profile preparation is opt-in and does not imply test execution', () => {
  const input = ['--vsix', 'synthetic.vsix', '--expected-sha', 'a'.repeat(64)];
  assert.equal(parseArgs(input).prepareOnly, false);
  assert.equal(parseArgs([...input, '--prepare-only']).prepareOnly, true);
  assert.equal(parseArgs(input).profileHostCpu, false);
  assert.equal(parseArgs([...input, '--profile-host-cpu']).profileHostCpu, true);
  assert.throws(() => parseArgs([...input, '--profile-host-cpu', '--profile-host-cpu']), /Duplicate/);
  assert.throws(() => parseArgs([...input, '--observation', 'legacy', '--legacy-feature', 'retained.feature', '--profile-host-cpu']), /unavailable/);
  assert.equal(parseArgs([...input, '--cdp-port', '61262']).cdpPort, 61262);
  for (const port of ['9222abc', '1023', '65536', '1.2']) assert.throws(() => parseArgs([...input, '--cdp-port', port]), /cdp-port/);
});

test('Save log classification ignores MSAL scope warnings but retains real listener failures', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-save-log-test-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'exthost.log');
  fs.writeFileSync(log, '[warning] MSAL: offline_access will be ignored as MSAL adds this to requests automatically.\n');
  assert.deepEqual(scanSaveLogs([log]).errors, []);
  fs.appendFileSync(log, '[error] onWillSaveTextDocument-listener from Workbench threw\n[error] Cannot save because pending Markdown commands did not settle.\n[warning] onWillSaveTextDocument-listener will now be IGNORED\n');
  assert.equal(scanSaveLogs([log]).errors.length, 3);
  fs.appendFileSync(log, '[warning] Aborted onWillSaveTextDocument-event after 1750ms\n[warning] Final snapshot unavailable; saving fail-closed state: timeout\n');
  assert.equal(scanSaveLogs([log]).errors.length, 5);
});

test('artifact failures retain CLI execution evidence instead of masquerading as setup failures', () => {
  const cli = { exitCode: 1, durationMs: 7200, timedOut: false };
  const result = finalizeAttemptEvidence({ cli }, () => { throw new Error('Unreadable artifact'); });
  assert.equal(result.primary, 'HARNESS_SUSPECT');
  assert.equal(result.analysisError, 'Unreadable artifact');
  assert.equal(result.evidence.cli, cli);
  assert.equal(result.setupError, undefined);
});

test('runner never credits corruption, data loss, rejected tools, observer stalls or Save errors as passes', () => {
  const clean = () => ({
    cli: { exitCode: 0 }, results: { completed: true, failedSteps: [] },
    summary: { verdict: 'PASS_UNREVIEWED_VISUAL', operations: [] },
    journal: { harnessFailures: [], metrics: {} },
    revisions: { present: true, total: 2, texts: 2, invalid: [], invalidDiskReads: [], preservation: [], rawChanges: [], malformedLines: 0 },
    saveLogs: { errors: [] },
  });
  assert.equal(classify(clean(), false).primary, 'PASS_UNREVIEWED_VISUAL');
  const cases = [
    [value => value.revisions.invalid.push({}), 'CORRUPTION_OBSERVED'],
    [value => value.revisions.invalidDiskReads.push({}), 'HARNESS_SUSPECT'],
    [value => value.revisions.texts = 0, 'HARNESS_BLOCKED'],
    [value => value.revisions.preservation.push({}), 'PRESERVATION_FAILED'],
    [value => value.revisions.rawChanges.push({}), 'PRESERVATION_FAILED'],
    [value => value.summary.operations.push({ name: 'Add', success: false }), 'WORKFLOW_FAILED'],
    [value => value.summary.verdict = 'WORKFLOW_FAILED', 'WORKFLOW_FAILED'],
    [value => value.saveLogs.errors.push('onWillSave failed'), 'WORKFLOW_FAILED'],
    [value => value.journal.metrics.transportMaximumMs = 1001, 'HARNESS_SUSPECT'],
    [value => value.journal.harnessFailures.push('overflow'), 'HARNESS_SUSPECT'],
    [value => value.summary.verdict = 'pass-ish', 'HARNESS_BLOCKED'],
  ];
  for (const [modify, expected] of cases) {
    const evidence = clean();
    modify(evidence);
    assert.equal(classify(evidence, false).primary, expected);
  }
  const legacy = clean();
  legacy.legacy = { trace: { operations: [] } };
  assert.equal(classify(legacy, true).primary, 'LEGACY_OBSERVATION_ONLY');
  const fault = clean();
  fault.summary.verdict = 'FAULT_SCENARIO_BEHAVIOR_CONFIRMED';
  fault.saveLogs.errors.push('Aborted onWillSaveTextDocument-event after 1750ms');
  assert.equal(classify(fault, false).primary, 'EXPECTED_FAULT_CONFIRMED');
  fault.results.completed = false;
  assert.equal(classify(fault, false).primary, 'WORKFLOW_FAILED');
  const related = clean();
  related.relatedRevisions = [{ file: 'linked/revisions.jsonl', invalid: [], preservation: [{}], rawChanges: [], invalidDiskReads: [], malformedLines: 0 }];
  assert.equal(classify(related, false).primary, 'PRESERVATION_FAILED');
  fault.results.completed = true;
  fault.relatedRevisions = related.relatedRevisions;
  assert.notEqual(classify(fault, false).primary, 'EXPECTED_FAULT_CONFIRMED');
  assert.ok(classify(fault, false).flags.includes('PRESERVATION_FAILED'));
});

async function fixture(context, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-journal-test-'));
  const fixtureRoot = path.join(root, 'fixture');
  const evidenceRoot = path.join(root, 'evidence');
  fs.mkdirSync(fixtureRoot);
  fs.mkdirSync(evidenceRoot);
  const journal = await createJournal({ fixtureRoot, evidenceRoot, initialText: makeText(), ...options });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    return journal.close();
  };
  context.after(async () => { await close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { journal, fixtureRoot, evidenceRoot, close };
}

test('captures immutable revisions outside the callback and retains reopen identity', async context => {
  const { journal, evidenceRoot, close } = await fixture(context);
  const metadata = { phase: 'change', openGeneration: 1, documentVersion: 1, changes: [{ offset: 4 }] };
  journal.capture(makeText(), metadata);
  metadata.changes[0].offset = 90;
  journal.capture(makeText(), { phase: 'change', openGeneration: 1, documentVersion: 2 });
  journal.capture(makeText(), { phase: 'open', openGeneration: 2, documentVersion: 1 });
  assert.equal(journal.summary().events.length, 0);
  const result = await close();
  assert.equal(result.events.length, 3);
  assert.equal(result.events[0].changes[0].offset, 4);
  assert.deepEqual(result.events.map(entry => [entry.openGeneration, entry.documentVersion]), [[1, 1], [1, 2], [2, 1]]);
  assert.equal(new Set(result.events.map(entry => entry.sha256)).size, 1);
  assert.equal(fs.readFileSync(path.join(evidenceRoot, 'revisions.jsonl'), 'utf8').trim().split('\n').length, 3);
  assert.deepEqual(result.harnessFailures, []);
});

test('retains the first invalid revision even if later bytes become valid', async context => {
  const { journal, evidenceRoot, close } = await fixture(context);
  const invalid = makeText() + '\r\nrepeated ending';
  journal.capture(invalid, { documentVersion: 2 });
  journal.capture('another invalid revision', { documentVersion: 3 });
  journal.capture(makeText(), { documentVersion: 4 });
  const result = await close();
  assert.deepEqual(result.events.map(entry => entry.valid), [false, false, true]);
  assert.equal(fs.readFileSync(path.join(evidenceRoot, 'first-invalid.kqlx'), 'utf8'), invalid);
});

test('an invalid disk checkpoint is retained separately from buffer corruption', async context => {
  const { journal, evidenceRoot, close } = await fixture(context);
  journal.capture('', { phase: 'disk:save-in-progress', documentVersion: 2 });
  journal.capture(makeText(), { phase: 'buffer:after-save', documentVersion: 2 });
  const result = await close();
  assert.equal(result.events[0].invalidOrigin, 'disk-read');
  assert.equal(result.events[1].valid, true);
  assert.ok(fs.existsSync(path.join(evidenceRoot, 'first-invalid-disk-read.kqlx')));
  assert.equal(fs.existsSync(path.join(evidenceRoot, 'first-invalid.kqlx')), false);
});

test('detects same-count result replacement, loss, attachment changes and reordered identities', async context => {
  const { journal, close } = await fixture(context);
  journal.capture(makeText('replacement'), { phase: 'replacement' });
  const lost = JSON.parse(makeText());
  delete lost.state.sections[0].resultJson;
  journal.capture(JSON.stringify(lost), { phase: 'lost' });
  const changed = JSON.parse(makeText());
  changed.state.sections[0].resultArtifact.revision = 2;
  changed.state.sections.reverse();
  journal.capture(JSON.stringify(changed), { phase: 'changed' });
  const result = await close();
  assert.deepEqual(result.events[0].preservation, ['first:result-content']);
  assert.deepEqual(result.events[1].preservation, ['first:result-content']);
  assert.deepEqual(result.events[2].preservation, ['original-section-order-or-identity', 'first:attachment']);
});

test('distinguishes formatting-only result changes from changed content', async context => {
  const { journal, close } = await fixture(context);
  const changed = JSON.parse(makeText());
  changed.state.sections[0].resultJson = JSON.stringify(JSON.parse(changed.state.sections[0].resultJson), null, 2);
  journal.capture(JSON.stringify(changed), { phase: 'formatting' });
  const result = await close();
  assert.deepEqual(result.events[0].preservation, []);
  assert.deepEqual(result.events[0].rawChanges, ['first']);
});

test('Markdown tool names are checked against the durable title field', async context => {
  const { journal, close } = await fixture(context);
  const changed = JSON.parse(makeText());
  changed.state.sections.push({ id: 'note', type: 'markdown', title: 'Synthetic note', text: 'Note content' });
  journal.capture(JSON.stringify(changed), { phase: 'named-add' });
  const result = await close();
  assert.equal(result.events[0].sections[2].title, 'Synthetic note');
  assert.equal(result.events[0].sections[2].name, null);
  assert.deepEqual(result.events[0].preservation, []);
});

test('an empty serialized result fails preservation without masquerading as invalid notebook JSON', async context => {
  const { journal, close } = await fixture(context);
  const changed = JSON.parse(makeText());
  changed.state.sections[0].resultJson = '';
  journal.capture(JSON.stringify(changed), { phase: 'empty-result' });
  const result = await close();
  assert.equal(result.events[0].valid, true);
  assert.deepEqual(result.events[0].preservation, ['first:result-content']);
});

test('minimal observation records event identities but still validates explicit checkpoints', async context => {
  const { journal, close } = await fixture(context, { mode: 'minimal' });
  journal.capture('not parsed in minimal mode', { documentVersion: 1 });
  const checkpoint = await journal.checkpoint(makeText('changed'), { documentVersion: 2 });
  assert.deepEqual(checkpoint.preservation, ['first:result-content']);
  const result = await close();
  assert.equal(result.events[0].valid, undefined);
  assert.equal(result.events.length, 2);
});

test('overflow is explicit and cannot become a complete pass', async context => {
  const { journal, close } = await fixture(context, { maxPendingCodeUnits: 10 });
  assert.equal(journal.capture(makeText(), { phase: 'overflow', documentVersion: 2 }), null);
  const result = await close();
  assert.match(result.harnessFailures[0], /overflow.*version 2/);
  assert.equal(result.events.length, 0);
});

test('journal write failure settles flush and remains a harness failure', async context => {
  const { journal, evidenceRoot, close } = await fixture(context);
  const target = path.join(evidenceRoot, 'revisions.jsonl');
  fs.unlinkSync(target);
  fs.mkdirSync(target);
  journal.capture(makeText(), { documentVersion: 2 });
  const result = await close();
  assert.equal(result.harnessFailures.length, 1);
  assert.equal(result.events.length, 0);
});

test('evidence survives fixture deletion and nested roots are rejected', async context => {
  const { journal, fixtureRoot, evidenceRoot, close } = await fixture(context);
  const nested = path.join(fixtureRoot, 'nested');
  fs.mkdirSync(nested);
  assert.throws(() => assertSeparateRoots(fixtureRoot, nested), /non-nested/);
  assert.throws(() => assertSeparateRoots(nested, fixtureRoot), /non-nested/);
  assert.throws(() => assertSeparateRoots(fixtureRoot, fixtureRoot), /non-nested/);
  journal.capture(makeText(), { phase: 'saved' });
  await close();
  fs.rmSync(fixtureRoot, { recursive: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'journal-summary.json'), 'utf8')).events.length, 1);
});