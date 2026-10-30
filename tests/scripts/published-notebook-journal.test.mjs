import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createContext, Script } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { armsFor, classify, finalizeAttemptEvidence, parseArgs, scanSaveLogs } from '../../scripts/repro-published-notebook.mjs';
import * as acceptanceHarness from '../../scripts/repro-published-notebook.mjs';

const require = createRequire(import.meta.url);
const { createJournal, assertSeparateRoots } = require('../vscode-extension-tester/e2e/default/published-notebook-corruption/lifecycle-journal.cjs');
const makeText = (value = 'original') => JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [
  { id: 'first', type: 'query', query: 'print Value=1', resultJson: JSON.stringify({ columns: [{ name: 'Value', type: 'string' }], rows: [[value]] }), resultArtifact: { id: 'saved-result', revision: 1 } },
  { id: 'second', type: 'query', query: 'print Value=2' },
] } });

function nativeSaveParticipantAdapter(enabled = true, sideEffects = { logging: 0, files: 0 }) {
  const typescript = require('typescript');
  const source = typescript.createSourceFile('kqlSidecar.test.ts', fs.readFileSync(new URL('../integration/kqlSidecar.test.ts', import.meta.url), 'utf8'), typescript.ScriptTarget.ES2022, true);
  const matches = source.statements.filter(statement => typescript.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => declaration.name.getText(source) === 'createNativeSaveParticipantTrace'));
  assert.equal(matches.length, 1, 'Extract the actual diagnostic factory, not a duplicated implementation');
  const code = typescript.transpileModule(matches[0].getText(source), { compilerOptions: { target: typescript.ScriptTarget.ES2022 } }).outputText;
  const unexpected = kind => () => { sideEffects[kind]++; throw new Error('Unexpected diagnostic ' + kind); };
  const context = createContext({ performance, utilTypes: require('node:util').types,
    console: { log: unexpected('logging'), warn: unexpected('logging'), error: unexpected('logging') },
    fs: { readFileSync: unexpected('files'), writeFileSync: unexpected('files'), appendFileSync: unexpected('files') } });
  return new Script(code + '\ncreateNativeSaveParticipantTrace;').runInContext(context)(enabled);
}

test('native Save participant trace preserves registration, callback receiver, arguments, event and return identity', () => {
  const trace = nativeSaveParticipantAdapter(), workspace = {}, thisArg = {}, extra = {}, subscriptions = [], subscription = { dispose() {} };
  const event = { document: { uri: {} }, waitUntil() {} }, descriptor = Object.getOwnPropertyDescriptor(event, 'waitUntil');
  let registered, returnThenReads = 0;
  const returned = { get then() { returnThenReads++; throw new Error('Callback returns must never be observed'); } };
  trace.beginTest('creator');
  const register = trace.wrap(function (...args) { assert.equal(this, workspace); registered = args; return subscription; }, 'willSave');
  const handler = function (...args) { assert.equal(this, thisArg); assert.equal(args[0], event); assert.equal(args[1], extra); return returned; };
  assert.equal(Reflect.apply(register, workspace, [handler, thisArg, subscriptions, extra]), subscription);
  assert.notEqual(registered[0], handler);
  assert.equal(registered[1], thisArg); assert.equal(registered[2], subscriptions); assert.equal(registered[3], extra);
  assert.equal(Reflect.apply(registered[0], thisArg, [event, extra]), returned);
  assert.deepEqual(Object.getOwnPropertyDescriptor(event, 'waitUntil'), descriptor);
  subscription.dispose(); trace.retire(subscription);
  const batch = trace.flush();
  assert.equal(batch.testName, 'creator'); assert.equal(batch.outstanding.length, 0);
  assert.deepEqual(Array.from(batch.entries, entry => entry.kind), ['listener.registered', 'callback.enter', 'callback.exit', 'listener.retired']);
  assert.equal(batch.entries[2].status, 'returned'); assert.equal(batch.entries[1].uriId, batch.entries[2].uriId);
  assert.ok(batch.entries.every(entry => entry.creatorTest === 'creator' && entry.currentTest === 'creator'));
  assert.equal(returnThenReads, 0); assert.equal(batch.gaps.observerError ?? 0, 0);
});

test('native Save participant trace preserves callback and registration throws despite metadata errors', () => {
  const trace = nativeSaveParticipantAdapter(), failure = new Error('original'), subscription = { dispose() {} };
  let callback;
  trace.beginTest('throwing');
  trace.wrap(handler => { callback = handler; return subscription; }, 'willSave')(() => { throw failure; });
  const event = { get document() { throw new Error('metadata unavailable'); } };
  assert.throws(() => callback(event), error => error === failure);
  assert.throws(() => trace.wrap(() => { throw failure; }, 'didSave')(() => {}), error => error === failure);
  trace.retire(subscription);
  const batch = trace.flush();
  assert.equal(batch.gaps.observerError, 1); assert.equal(batch.outstanding.length, 0);
  assert.equal(batch.entries.find(entry => entry.kind === 'callback.exit').status, 'threw');
});

test('native Save participant trace disabled factory leaves registration unhooked and emits nothing', () => {
  const trace = nativeSaveParticipantAdapter(false), callback = () => {}, subscription = { dispose() {} };
  let observed;
  const register = handler => { observed = handler; return subscription; };
  assert.equal(trace, undefined);
  const effective = trace?.wrap(register, 'willSave') ?? register;
  assert.equal(effective, register); assert.equal(effective(callback), subscription); assert.equal(observed, callback);
});

for (const shape of ['fulfilled', 'rejected', 'cross-realm', 'unknown thenable']) test(`native Save participant trace observes only accepted native promises (${shape})`, async () => {
  const trace = nativeSaveParticipantAdapter(), subscription = { dispose() {} }, receiver = {}, extra = {}, nativeReturn = {};
  let callback, resolve, reject, getterReads = 0, nativeCalls = 0;
  let promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  if (shape === 'cross-realm') ({ promise, resolve, reject } = new Script('(() => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; })()').runInNewContext());
  if (shape === 'unknown thenable') promise = {};
  Object.defineProperty(promise, 'then', { get() { getterReads++; throw new Error('must not read then'); } });
  trace.beginTest(shape);
  const event = { document: { uri: {} }, waitUntil(...args) {
    nativeCalls++; assert.equal(this, receiver); assert.equal(args[0], promise); assert.equal(args[1], extra);
    trace.record('native.waitUntil.return'); return nativeReturn;
  } };
  const descriptor = Object.getOwnPropertyDescriptor(event, 'waitUntil');
  trace.wrap(handler => { callback = handler; return subscription; }, 'willSave')(value => {
    assert.equal(value.waitUntil.call(receiver, promise, extra), nativeReturn);
  });
  callback(event);
  assert.deepEqual(Object.getOwnPropertyDescriptor(event, 'waitUntil'), descriptor);
  assert.equal(nativeCalls, 1); assert.equal(getterReads, 0);
  trace.retire(subscription);
  const before = trace.flush();
  if (shape === 'unknown thenable') {
    assert.equal(before.outstanding.length, 0); assert.equal(before.gaps.unknownThenable, 1);
    assert.equal(before.entries.some(entry => entry.kind.startsWith('waitUntil.')), false);
  } else {
    assert.equal(before.outstanding.length, 1); assert.equal(before.outstanding[0].retired, true);
    assert.ok(before.entries.findIndex(entry => entry.kind === 'native.waitUntil.return') < before.entries.findIndex(entry => entry.kind === 'waitUntil.accepted'));
    trace.beginTest('settlement');
    if (shape === 'rejected') reject(new Error('PRIVATE_REJECTION_BODY')); else resolve({ secret: 'PRIVATE_RESULT_BODY' });
    await Promise.resolve(); await Promise.resolve();
    const after = trace.flush();
    assert.equal(after.outstanding.length, 0);
    assert.equal(after.entries[0].status, shape === 'rejected' ? 'rejected' : 'fulfilled');
    assert.equal(after.entries[0].creatorTest, shape); assert.equal(after.entries[0].currentTest, 'settlement');
    assert.equal(JSON.stringify(after).includes('PRIVATE_'), false);
  }
  assert.equal(getterReads, 0);
});

for (const shape of ['own constructor getter', 'own constructor undefined', 'own custom constructor', 'prototype constructor getter',
  'proxy prototype', 'proxy constructor', 'proxy promise', 'custom species getter', 'proxy species getter', 'custom species constructor',
  'inherited species getter', 'subclass species constructor']) test(`native Save participant trace rejects unsafe promise observation (${shape})`, async () => {
  const effects = { constructorReads: 0, speciesReads: 0, constructions: 0, proxyTraps: 0, thenReads: 0 };
  const expected = { ...effects }, trace = nativeSaveParticipantAdapter(), nativeReturn = {}, extra = {}, receiver = {};
  const realm = new Script('(() => { let resolve; const promise = new Promise(complete => { resolve = complete; }); return { promise, resolve, constructor: Promise }; })()').runInNewContext();
  let promise = realm.promise, callback, nativeCalls = 0;
  const constructorGetter = () => { effects.constructorReads++; throw new Error('PRIVATE_CONSTRUCTOR'); };
  const speciesGetter = () => { effects.speciesReads++; throw new Error('PRIVATE_SPECIES'); };
  class CustomSpecies extends Promise {
    constructor(executor) { effects.constructions++; super(executor); }
  }
  const traps = { get() { effects.proxyTraps++; throw new Error('PRIVATE_PROXY'); },
    getOwnPropertyDescriptor() { effects.proxyTraps++; throw new Error('PRIVATE_DESCRIPTOR'); },
    getPrototypeOf() { effects.proxyTraps++; throw new Error('PRIVATE_PROTOTYPE'); },
    apply() { effects.proxyTraps++; throw new Error('PRIVATE_APPLY'); } };
  if (shape === 'own constructor getter') Object.defineProperty(promise, 'constructor', { get: constructorGetter });
  if (shape === 'own constructor undefined') Object.defineProperty(promise, 'constructor', { value: undefined });
  if (shape === 'own custom constructor') Object.defineProperty(promise, 'constructor', { value: CustomSpecies });
  if (shape === 'prototype constructor getter') Object.setPrototypeOf(promise, Object.defineProperty({}, 'constructor', { get: constructorGetter }));
  if (shape === 'proxy prototype') Object.setPrototypeOf(promise, new Proxy(realm.constructor.prototype, traps));
  if (shape === 'proxy constructor') Object.setPrototypeOf(promise, { constructor: new Proxy(realm.constructor, traps) });
  if (shape === 'custom species getter') Object.defineProperty(realm.constructor, Symbol.species, { get: speciesGetter });
  if (shape === 'proxy species getter') Object.defineProperty(realm.constructor, Symbol.species, { get: new Proxy(Object.getOwnPropertyDescriptor(realm.constructor, Symbol.species).get, traps) });
  if (shape === 'custom species constructor') Object.defineProperty(realm.constructor, Symbol.species, { value: CustomSpecies });
  if (shape === 'inherited species getter') {
    delete realm.constructor[Symbol.species];
    Object.setPrototypeOf(realm.constructor, Object.defineProperty({}, Symbol.species, { get: speciesGetter }));
  }
  if (shape === 'subclass species constructor') {
    class CustomPromise extends Promise { static get [Symbol.species]() { effects.speciesReads++; return CustomSpecies; } }
    promise = new CustomPromise(() => {});
  }
  Object.defineProperty(promise, 'then', { get() { effects.thenReads++; throw new Error('PRIVATE_THEN'); } });
  if (shape === 'proxy promise') promise = new Proxy(promise, traps);
  const event = { document: { uri: {} }, waitUntil(...args) {
    nativeCalls++; assert.equal(this, receiver); assert.equal(args[0], promise); assert.equal(args[1], extra); return nativeReturn;
  } };
  const descriptor = Object.getOwnPropertyDescriptor(event, 'waitUntil');
  trace.beginTest(shape);
  trace.wrap(handler => { callback = handler; return { dispose() {} }; }, 'willSave')(value => value.waitUntil.call(receiver, promise, extra));
  assert.equal(callback(event), nativeReturn);
  const beforeFlush = { ...effects }, batch = trace.flush();
  await Promise.resolve();
  assert.deepEqual(beforeFlush, expected, 'Observation must reject unsafe shapes before any user code runs');
  assert.deepEqual(effects, expected, 'Flushing must not trigger deferred user code');
  assert.equal(nativeCalls, 1); assert.deepEqual(Object.getOwnPropertyDescriptor(event, 'waitUntil'), descriptor);
  assert.equal(batch.outstanding.length, 0); assert.equal(batch.entries.some(entry => entry.kind.startsWith('waitUntil.')), false);
  const gap = shape === 'proxy promise' ? 'unknownThenable' : 'unsupportedPromise';
  assert.equal(batch.gaps[gap], 1); assert.equal(batch.gaps.observerError ?? 0, 0);
  assert.equal(trace.flush().cumulativeGaps[gap], 1);
  assert.equal(JSON.stringify(batch).includes('PRIVATE_'), false);
});

for (const shape of ['null', 'undefined', 'native constructor', 'native constructor with unsafe chain species']) test(`native Save participant trace accepts safe own species data (${shape})`, async () => {
  const trace = nativeSaveParticipantAdapter();
  const realm = new Script('(() => { let resolve; const promise = new Promise(complete => { resolve = complete; }); return { promise, resolve, constructor: Promise }; })()').runInNewContext();
  const otherConstructor = new Script('Promise').runInNewContext();
  let speciesReads = 0, callback;
  if (shape === 'native constructor with unsafe chain species') Object.defineProperty(otherConstructor, Symbol.species, { get() { speciesReads++; throw new Error('Do not observe the derived chain'); } });
  const species = shape === 'null' ? null : shape === 'undefined' ? undefined : otherConstructor;
  Object.defineProperty(realm.constructor, Symbol.species, { value: species });
  trace.beginTest(shape);
  trace.wrap(handler => { callback = handler; return { dispose() {} }; }, 'willSave')(event => event.waitUntil(realm.promise));
  callback({ document: { uri: {} }, waitUntil() {} });
  const before = trace.flush();
  realm.resolve(); await Promise.resolve(); await Promise.resolve();
  const after = trace.flush();
  assert.equal(speciesReads, 0); assert.equal(before.outstanding.length, 1); assert.equal(after.outstanding.length, 0);
  assert.equal(after.entries.filter(entry => entry.kind === 'waitUntil.settled').length, 1);
  assert.equal(before.gaps.promiseObservationFailed ?? 0, 0); assert.equal(before.gaps.observerError ?? 0, 0);
});

test('native Save participant trace does not inspect native callback return promises', () => {
  const trace = nativeSaveParticipantAdapter(), returned = new Promise(() => {});
  let callback, constructorReads = 0, thenReads = 0;
  Object.defineProperty(returned, 'constructor', { get() { constructorReads++; throw new Error('Do not observe callback returns'); } });
  Object.defineProperty(returned, 'then', { get() { thenReads++; throw new Error('Do not inspect callback returns'); } });
  trace.wrap(handler => { callback = handler; return { dispose() {} }; }, 'willSave')(() => returned);
  assert.equal(callback({ document: { uri: {} }, waitUntil() {} }), returned);
  const batch = trace.flush();
  assert.equal(constructorReads, 0); assert.equal(thenReads, 0); assert.equal(batch.outstanding.length, 0);
  assert.equal(batch.entries.some(entry => entry.kind.startsWith('waitUntil.')), false);
  assert.equal(batch.gaps.observerError ?? 0, 0);
});

test('native Save participant trace does not observe a promise rejected by native waitUntil', () => {
  const trace = nativeSaveParticipantAdapter(), failure = new Error('native failure'), promise = Promise.resolve();
  let callback;
  const event = { document: { uri: {} }, waitUntil() { throw failure; } }, descriptor = Object.getOwnPropertyDescriptor(event, 'waitUntil');
  trace.beginTest('native throw');
  trace.wrap(handler => { callback = handler; return { dispose() {} }; }, 'willSave')(value => value.waitUntil(promise));
  assert.throws(() => callback(event), error => error === failure);
  assert.deepEqual(Object.getOwnPropertyDescriptor(event, 'waitUntil'), descriptor);
  const batch = trace.flush();
  assert.equal(batch.outstanding.length, 0); assert.equal(batch.entries.some(entry => entry.kind.startsWith('waitUntil.')), false);
});

for (const shape of ['immutable', 'accessor', 'inherited', 'configurable readonly', 'writable nonconfigurable']) test(`native Save participant trace respects exact waitUntil descriptors (${shape})`, async () => {
  const trace = nativeSaveParticipantAdapter(), nativeWait = () => {}, event = { document: { uri: {} } };
  let callback, getterReads = 0;
  if (shape === 'inherited') Object.setPrototypeOf(event, { waitUntil: nativeWait });
  else Object.defineProperty(event, 'waitUntil', shape === 'accessor'
    ? { configurable: true, get() { getterReads++; return nativeWait; } }
    : { value: nativeWait, configurable: shape === 'configurable readonly', writable: shape === 'writable nonconfigurable', enumerable: false });
  const descriptor = Object.getOwnPropertyDescriptor(event, 'waitUntil'), allowed = shape.includes('configurable') && shape !== 'accessor';
  trace.beginTest(shape);
  trace.wrap(handler => { callback = handler; return { dispose() {} }; }, 'willSave')(value => {
    if (allowed) { assert.notEqual(value.waitUntil, nativeWait); value.waitUntil(Promise.resolve()); }
  });
  callback(event);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(Object.getOwnPropertyDescriptor(event, 'waitUntil'), descriptor); assert.equal(getterReads, 0);
  const batch = trace.flush();
  assert.equal(batch.gaps.waitUntilDescriptor ?? 0, allowed ? 0 : 1);
  assert.equal(batch.entries.filter(entry => entry.kind === 'waitUntil.settled').length, allowed ? 1 : 0);
});

test('native Save participant trace preserves an external replacement and didSave callback returns', () => {
  const trace = nativeSaveParticipantAdapter(), replacement = () => {}, returned = {}, thisArg = {}, document = { uri: {} };
  let callback;
  const event = { document, waitUntil() {} };
  trace.beginTest('replacement');
  trace.wrap(handler => { callback = handler; return { dispose() {} }; }, 'willSave')(value => { value.waitUntil = replacement; });
  callback(event); assert.equal(event.waitUntil, replacement);
  trace.wrap(handler => { callback = handler; return { dispose() {} }; }, 'didSave')(function (saved) {
    assert.equal(this, thisArg); assert.equal(saved, document); return returned;
  });
  assert.equal(callback.call(thisArg, document), returned);
  const batch = trace.flush();
  assert.equal(batch.gaps.waitUntilReplaced, 1); assert.equal(batch.gaps.waitUntilDescriptor, undefined);
  assert.equal(batch.entries.filter(entry => entry.kind === 'callback.exit').length, 2);
});

for (const shape of ['writable', 'enumerable', 'configurable', 'nonconfigurable writable', 'accessor', 'deleted']) {
  for (const outcome of ['return', 'throw']) test(`native Save participant trace preserves external descriptor drift (${shape}, ${outcome})`, () => {
    const trace = nativeSaveParticipantAdapter(), returned = {}, failure = new Error('exact callback failure');
    const event = { document: { uri: {} } };
    Object.defineProperty(event, 'waitUntil', { value() {}, writable: true, enumerable: true, configurable: shape !== 'nonconfigurable writable' });
    let callback, expected, getterReads = 0;
    trace.beginTest(shape);
    trace.wrap(handler => { callback = handler; return { dispose() {} }; }, 'willSave')(value => {
      const installed = Object.getOwnPropertyDescriptor(value, 'waitUntil');
      if (shape === 'deleted') delete value.waitUntil;
      else if (shape === 'accessor') Object.defineProperty(value, 'waitUntil', { get() { getterReads++; throw new Error('Do not read replacement accessor'); }, set: undefined });
      else Object.defineProperty(value, 'waitUntil', { ...installed, [shape === 'nonconfigurable writable' ? 'writable' : shape]: false });
      expected = Object.getOwnPropertyDescriptor(value, 'waitUntil');
      if (outcome === 'throw') throw failure;
      return returned;
    });
    if (outcome === 'throw') assert.throws(() => callback(event), error => error === failure);
    else assert.equal(callback(event), returned);
    assert.deepEqual(Object.getOwnPropertyDescriptor(event, 'waitUntil'), expected, 'Restoration must preserve every external descriptor change');
    const batch = trace.flush();
    assert.equal(getterReads, 0); assert.equal(batch.gaps.waitUntilReplaced, 1); assert.equal(batch.gaps.observerError ?? 0, 0);
    assert.equal(batch.entries.at(-1).status, outcome === 'throw' ? 'threw' : 'returned');
    assert.equal(batch.outstanding.length, 0);
  });
}

test('native Save participant trace reentrant callbacks forward each wait exactly once and restore the descriptor', async () => {
  const trace = nativeSaveParticipantAdapter(), promise = Promise.resolve(), thisArg = {};
  let callback, depth = 0, nativeCalls = 0;
  const event = { document: { uri: {} }, waitUntil(value) { assert.equal(this, event); assert.equal(value, promise); nativeCalls++; } };
  const descriptor = Object.getOwnPropertyDescriptor(event, 'waitUntil');
  trace.beginTest('reentrant');
  trace.wrap(handler => { callback = handler; return { dispose() {} }; }, 'willSave')(function (value) {
    assert.equal(this, thisArg); value.waitUntil(promise);
    if (!depth) { depth++; callback.call(thisArg, value); depth--; }
    value.waitUntil(promise);
  });
  callback.call(thisArg, event);
  assert.deepEqual(Object.getOwnPropertyDescriptor(event, 'waitUntil'), descriptor); assert.equal(nativeCalls, 4);
  await Promise.resolve(); await Promise.resolve();
  const batch = trace.flush(), waits = batch.entries.filter(entry => entry.kind === 'waitUntil.accepted');
  assert.equal(waits.length, 4); assert.equal(new Set(waits.map(entry => entry.waitId)).size, 4);
  assert.equal(new Set(waits.map(entry => entry.invocationId)).size, 2);
  assert.equal(batch.outstanding.length, 0); assert.equal(batch.gaps.waitUntilReplaced, undefined);
});

test('native Save participant trace retains late prior-test waits across teardown without retaining settled listeners', async () => {
  const trace = nativeSaveParticipantAdapter(), subscription = { dispose() {} };
  let callback, resolveBetween, resolveDuring;
  const between = new Promise(resolve => { resolveBetween = resolve; }), during = new Promise(resolve => { resolveDuring = resolve; });
  trace.beginTest('prior');
  trace.wrap(handler => { callback = handler; return subscription; }, 'willSave')(event => { event.waitUntil(between); event.waitUntil(during); });
  callback({ document: { uri: {} }, waitUntil() {} });
  subscription.dispose();
  const unknownDisposal = trace.flush();
  assert.ok(unknownDisposal.outstanding.every(wait => !wait.retired)); assert.equal(unknownDisposal.gaps.manualDisposeUnknown, 1);
  trace.retire(subscription);
  resolveBetween(); await Promise.resolve();
  trace.beginTest('next');
  resolveDuring(); await Promise.resolve();
  const next = trace.flush(), settlements = next.entries.filter(entry => entry.kind === 'waitUntil.settled');
  assert.equal(next.outstanding.length, 0); assert.equal(settlements.length, 2);
  assert.ok(settlements.every(entry => entry.creatorTest === 'prior'));
  assert.deepEqual(Array.from(settlements, entry => entry.currentTest), ['', 'next']);
  assert.ok(next.entries[0].seq > unknownDisposal.entries.at(-1).seq);
  assert.ok(next.entries.every((entry, index, all) => !index || entry.tMs >= all[index - 1].tMs));
  for (let index = 0; index < 1100; index++) {
    const disposable = trace.wrap(() => ({ dispose() {} }), 'didSave')(() => {});
    disposable.dispose(); trace.retire(disposable);
  }
  assert.equal(trace.flush().gaps.listenerCapacity, undefined);
});

test('native Save participant trace bounds entries, pending work and listener retention while keeping gap counters', async () => {
  const trace = nativeSaveParticipantAdapter(), subscription = { dispose() {} };
  let callback, resolve;
  const promise = new Promise(complete => { resolve = complete; });
  trace.beginTest('capacity');
  trace.wrap(handler => { callback = handler; return subscription; }, 'willSave')(event => {
    for (let index = 0; index < 1100; index++) event.waitUntil(promise);
  });
  callback({ document: { uri: {} }, waitUntil() {} }); trace.retire(subscription);
  const batch = trace.flush();
  assert.equal(batch.entries.length, 1024); assert.equal(batch.outstanding.length, 1023);
  assert.ok(batch.outstanding.every(wait => wait.retired)); assert.ok(batch.dropped > 0);
  assert.equal(batch.gaps.pendingCapacity, 77);
  for (const name of ['preWrapperUnknown', 'manualDisposeUnknown', 'timerUnobserved']) assert.equal(batch.gaps[name], 1);
  resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(trace.flush().outstanding.length, 0);
  const subscriptions = [], observed = [], handler = () => {};
  for (let index = 0; index < 1025; index++) subscriptions.push(trace.wrap(value => { observed.push(value); return { dispose() {} }; }, 'didSave')(handler));
  assert.notEqual(observed[1023], handler); assert.equal(observed[1024], handler);
  const capped = trace.flush(); assert.equal(capped.entries.length, 1024); assert.equal(capped.gaps.listenerCapacity, 1);
  for (const disposable of subscriptions) { disposable.dispose(); trace.retire(disposable); }
  trace.wrap(() => ({ dispose() {} }), 'didSave')(handler);
  const final = trace.flush();
  assert.equal(final.gaps.listenerCapacity, undefined); assert.equal(final.cumulativeGaps.listenerCapacity, 1);
  assert.equal(final.cumulativeGaps.pendingCapacity, 77); assert.ok(final.cumulativeDropped >= batch.dropped);
});

test('native Save participant trace retains cumulative incompleteness while distinct untracked waits remain unresolved', async () => {
  const trace = nativeSaveParticipantAdapter(), subscription = { dispose() {} };
  const waits = Array.from({ length: 1025 }, () => {
    let resolve, settled = false;
    const promise = new Promise(complete => { resolve = complete; });
    promise.then(() => { settled = true; });
    return { promise, resolve, isSettled: () => settled };
  });
  assert.equal(new Set(waits.map(wait => wait.promise)).size, 1025);
  let callback, nativeCalls = 0;
  trace.beginTest('distinct pending');
  trace.wrap(handler => { callback = handler; return subscription; }, 'willSave')(event => {
    for (const wait of waits) event.waitUntil(wait.promise);
  });
  callback({ document: { uri: {} }, waitUntil(promise) { assert.equal(promise, waits[nativeCalls++].promise); } });
  const first = trace.flush(), firstSnapshot = JSON.stringify(first);
  assert.equal(nativeCalls, 1025); assert.equal(first.outstanding.length, 1023); assert.equal(first.entries.length, 1024);
  assert.equal(first.gaps.pendingCapacity, 2); assert.ok(first.dropped > 0);
  subscription.dispose(); trace.retire(subscription);
  const retired = trace.flush(), retiredSnapshot = JSON.stringify(retired);
  for (const wait of first.outstanding) waits[wait.waitId - 1].resolve();
  await Promise.resolve(); await Promise.resolve();
  trace.beginTest('only tracked settled');
  const final = trace.flush(), empty = trace.flush();
  assert.equal(waits.filter(wait => wait.isSettled()).length, 1023);
  assert.ok(waits.slice(1023).every(wait => !wait.isSettled()), 'Untracked native promises must remain unresolved');
  assert.ok(retired.outstanding.every(wait => wait.retired)); assert.equal(final.outstanding.length, 0);
  for (const batch of [first, retired, final, empty]) {
    assert.equal(batch.cumulativeGaps.pendingCapacity, 2); assert.equal(batch.cumulativeDropped, first.dropped);
    for (const name of ['preWrapperUnknown', 'manualDisposeUnknown', 'timerUnobserved']) assert.equal(batch.cumulativeGaps[name], 1);
    assert.ok(batch.entries.length <= 1024); assert.ok(batch.outstanding.length <= 1024);
    assert.ok(batch.outstanding.every(wait => Object.values(wait).every(value => value === undefined || ['string', 'number', 'boolean'].includes(typeof value))));
  }
  assert.equal(final.gaps.pendingCapacity, undefined); assert.equal(final.dropped, 0);
  assert.equal(JSON.stringify(first), firstSnapshot); assert.equal(JSON.stringify(retired), retiredSnapshot);
});

test('native Save participant trace keeps unwrappable and unknown-thenable gaps across empty batches', () => {
  const trace = nativeSaveParticipantAdapter(), subscription = { dispose() {} };
  let callback, thenReads = 0;
  const unknown = { get then() { thenReads++; throw new Error('Do not inspect unknown thenables'); } };
  trace.wrap(handler => { callback = handler; return subscription; }, 'willSave')(event => event.waitUntil(unknown));
  callback({ document: { uri: {} }, waitUntil() {} });
  const immutable = { document: { uri: {} } };
  Object.defineProperty(immutable, 'waitUntil', { value() {} });
  callback(immutable);
  const first = trace.flush(), snapshot = JSON.stringify(first);
  subscription.dispose(); trace.retire(subscription);
  for (const batch of [trace.flush(), trace.flush()]) {
    assert.equal(batch.outstanding.length, 0); assert.equal(batch.gaps.unknownThenable, undefined); assert.equal(batch.gaps.waitUntilDescriptor, undefined);
    assert.equal(batch.cumulativeGaps.unknownThenable, 1); assert.equal(batch.cumulativeGaps.waitUntilDescriptor, 1);
  }
  assert.equal(thenReads, 0); assert.equal(JSON.stringify(first), snapshot);
});

test('native Save participant trace never reads document contents or URI strings and restricts phase status to booleans', () => {
  const sideEffects = { logging: 0, files: 0 }, trace = nativeSaveParticipantAdapter(true, sideEffects);
  let callback, bodyReads = 0, uriReads = 0;
  trace.beginTest('metadata only');
  trace.wrap(handler => { callback = handler; return { dispose() {} }; }, 'willSave')(() => {});
  callback({ document: { uri: {
    get toString() { uriReads++; throw new Error('No URI text'); }, get fsPath() { uriReads++; throw new Error('No URI path'); },
  }, get getText() { bodyReads++; throw new Error('No document content'); } }, waitUntil() {} });
  trace.record('fixture.phase', { error: 'PRIVATE_PAYLOAD' }); trace.record('fixture.boolean', false);
  const batch = JSON.parse(JSON.stringify(trace.flush()));
  assert.equal(bodyReads, 0); assert.equal(uriReads, 0); assert.deepEqual(sideEffects, { logging: 0, files: 0 });
  assert.equal(batch.gaps.observerError ?? 0, 0);
  assert.equal(JSON.stringify(batch).includes('PRIVATE_'), false); assert.equal(batch.entries.at(-1).status, false);
  assert.deepEqual(Object.keys(batch).sort(), ['version', 'testId', 'testName', 'entries', 'outstanding', 'dropped', 'gaps', 'cumulativeDropped', 'cumulativeGaps'].sort());
  const allowed = new Set(['seq', 'tMs', 'kind', 'listenerId', 'invocationId', 'waitId', 'creatorTest', 'currentTest', 'uriId', 'status']);
  assert.ok(batch.entries.every(entry => Object.keys(entry).every(key => allowed.has(key))));
});

function nativeCommitFixture() {
  const typescript = require('typescript');
  const source = typescript.createSourceFile('kqlSidecar.test.ts', fs.readFileSync(new URL('../integration/kqlSidecar.test.ts', import.meta.url), 'utf8'), typescript.ScriptTarget.ES2022, true);
  let body;
  const visit = node => {
    if (typescript.isCallExpression(node) && node.expression.getText(source) === 'test'
      && node.arguments[0]?.getText(source).startsWith('`public Save joins the actual native commit after preparation')) body = node.arguments[1].body;
    typescript.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(body, 'Extract the actual native commit fixture');
  const named = name => statement => typescript.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => declaration.name.getText(source) === name);
  const start = body.statements.findIndex(named('events')), end = body.statements.findIndex(named('subscriptions'));
  assert.ok(start >= 0 && end > start);
  const compile = text => typescript.transpileModule(text, { compilerOptions: { target: typescript.ScriptTarget.ES2022 } }).outputText;
  const nodes = [];
  const collect = node => { nodes.push(node); typescript.forEachChild(node, collect); };
  collect(body);
  return { typescript, source, body, nodes, compile, recorder: compile(body.statements.slice(start, end).map(statement => statement.getText(source)).join('\n')) };
}

test('normal native commit fixture records metadata without timed payload reads or I/O', () => {
  const { typescript, source, body, compile, recorder } = nativeCommitFixture();
  let held;
  const visit = node => {
    if (typescript.isCallExpression(node) && node.expression.getText(source) === 'record' && node.arguments[0]?.text === 'commit.held') held = node;
    typescript.forEachChild(node, visit);
  };
  visit(body);
  assert.ok(held, 'Exercise the actual held-commit detail factory');
  const effects = { payload: 0, reads: 0, writes: 0, logging: 0, serialization: 0 };
  new Script(recorder + '\n' + compile(held.getText(source))).runInNewContext({ nativeSaveTrace: undefined, performance, path, root: '/unused', commits: 1,
    event: { document: { version: 2, isDirty: true, getText() { effects.payload++; return 'PRIVATE_BUFFER'; } } }, uri: { fsPath: '/unused/probe.kqlx' },
    fs: { readFileSync() { effects.reads++; return 'PRIVATE_DISK'; }, appendFileSync() { effects.writes++; } },
    console: { log() { effects.logging++; } }, JSON: { stringify(value) { effects.serialization++; return JSON.stringify(value); } } });
  assert.deepEqual(effects, { payload: 0, reads: 0, writes: 0, logging: 0, serialization: 0 });
});

test('normal native commit fixture caps before detail evaluation and latches metadata failures without I/O', () => {
  const { recorder } = nativeCommitFixture();
  const unexpected = () => assert.fail('No synchronous diagnostic I/O or serialization');
  const fixture = new Script(recorder + '\n({ record, events, counts: () => ({ droppedEvents, recordErrors, recordingError }) });').runInNewContext({
    nativeSaveTrace: undefined, performance, fs: { readFileSync: unexpected, writeFileSync: unexpected, appendFileSync: unexpected },
    console: { log: unexpected, error: unexpected }, JSON: { stringify: unexpected },
  });
  const failure = new Error('metadata failure');
  let factories = 0;
  assert.doesNotThrow(() => fixture.record('factory.failure', () => { factories++; throw failure; }));
  for (let index = 0; index < 128; index++) fixture.record('metadata', () => { factories++; return { version: index, dirty: true }; });
  fixture.record('overflow', () => { factories++; throw new Error('Must not evaluate overflow'); });
  assert.equal(factories, 129); assert.equal(fixture.events.length, 128);
  assert.equal(fixture.counts().droppedEvents, 1); assert.equal(fixture.counts().recordErrors, 1); assert.equal(fixture.counts().recordingError, failure);
  assert.ok(fixture.events.every(entry => typeof entry.at === 'string' && typeof entry.tMs === 'number' && entry.dirty === true));
});

test('normal native commit fixture detail factories read only primitive metadata', () => {
  const { typescript, source, nodes, compile } = nativeCommitFixture();
  const calls = nodes.filter(node => typescript.isCallExpression(node) && node.expression.getText(source) === 'record' && node.arguments[1] && typescript.isArrowFunction(node.arguments[1]));
  assert.ok(calls.some(call => call.arguments[0]?.text === 'failedAttempt.bookkeepingDrained'));
  const unexpected = () => assert.fail('Diagnostic factories must not read payloads, serialize, log, or access files');
  const document = { version: 3, isDirty: true, get getText() { return unexpected(); } };
  const result = { success: false, saved: false, get error() { return unexpected(); } };
  const factories = new Script(compile('[' + calls.map(call => call.arguments[1].getText(source)).join(',') + ']')).runInNewContext({
    document, event: { document }, result, retry: result, returnResult: result, atReturn: { dirty: true }, commits: 1, delegatedNativeSaves: 1, saved: true,
    message: { sourceGeneration: 2 }, failures: [new Error('PRIVATE_FAILURE')], passiveView: {}, readbackView: {}, targetView: {}, heldView: {}, publicationHeld: true,
    returnedBeforePublication: false, closed: true, remainingPanelRegistrations: () => 0,
    fs: { readFileSync: unexpected, writeFileSync: unexpected, appendFileSync: unexpected }, JSON: { parse: unexpected, stringify: unexpected }, console: { log: unexpected },
  });
  for (const factory of factories) assert.ok(Object.values(factory()).every(value => value === undefined || typeof value === 'boolean' || typeof value === 'number'));
});

for (const outcome of ['passing negative', 'assertion failure', 'cleanup failure', 'reply failure', 'metadata failure', 'writer failure', 'event writer failure', 'assertion metadata writer',
  'immediate reply failure', 'assertion immediate reply failure', 'immediate reply capture failure']) {
  test(`normal native commit fixture drains before artifacts and preserves failure identity (${outcome})`, { timeout: 5_000 }, async testContext => {
    const { typescript, source, body, nodes, compile, recorder } = nativeCommitFixture();
    const attempt = body.statements.find(typescript.isTryStatement);
    const capture = nodes.find(node => typescript.isVariableDeclaration(node) && node.name.getText(source) === 'captureReturn');
    const sender = nodes.find(node => typescript.isPropertyAssignment(node) && node.name.getText(source) === 'postMessage');
    assert.ok(attempt?.finallyBlock && capture && sender);
    const originalFailure = new Error('original assertion'), replyFailure = new Error('preparation reply'), metadataFailure = new Error('metadata'), writerFailure = new Error('writer'), captureFailure = new Error('failure capture');
    const immediateClose = outcome.includes('immediate'), replyFails = outcome.includes('reply'), captureFails = outcome === 'immediate reply capture failure';
    const writes = [], removals = [], logs = [], effects = { restoredSave: 0, panels: 0, subscriptions: 0, session: 0, lease: 0, logging: 0 };
    let buffer = 'RETURN_BUFFER', disk = 'RETURN_DISK', drainCalled = false, captureAttempts = 0, releasePreparation, releaseReply, releaseDrain, reachedDrain;
    const preparationGate = new Promise(resolve => { releasePreparation = resolve; });
    const replyGate = new Promise(resolve => { releaseReply = resolve; });
    const drainGate = new Promise(resolve => { releaseDrain = resolve; });
    const drainReached = new Promise(resolve => { reachedDrain = resolve; });
    const original = () => {}, document = { version: 3, isDirty: true, getText: () => buffer };
    const context = createContext({ assert, performance, path, root: '/unused', nativeSaveTrace: undefined, document, commits: 1, scenario: 'post-commit source edit',
      fixtureFailures: [], preparationReplies: new Set(), returnSnapshot: undefined, retiredPublicationStarted: false, publicationHeld: true,
      publicationFinished: new Promise(() => {}), captureTimers: false, timers: [], expiredPreparation: undefined, expiredWaiters: [], nativeSave: Promise.resolve(true), publicSave: undefined, directSave: undefined,
      releasePreparation, releaseCommit() {}, releasePublication() {}, restoreDocumentSave() { effects.restoredSave++; }, saveDocument: undefined, liveDocuments: { retire() {} },
      originalOpenFile: original, originalRealpath: original, originalShowError: original, originalSetLifecycle: original, originalAttachResultSession: original, originalPublish: original,
      originalWillSave: original, originalDidSave: original, originalSetTimeout: original, originalClearTimeout: original, originalTextDocuments: { configurable: true, get: () => [] },
      originalSingleton: { configurable: true, value: original }, KustoWorkbenchToolOrchestrator: {}, prototype: {},
      tokens: [1], orchestrator: { disconnectIfOwner() {} }, disposals: [() => { effects.panels++; }], subscriptions: [{ dispose() { effects.subscriptions++; } }],
      resultSession: { dispose() { effects.session++; } }, resultLease: { release() { effects.lease++; } }, remainingPanelRegistrations: () => 0,
      KqlxEditorProvider: { waitForOpenEditorsClosed() { drainCalled = true; reachedDrain(); return immediateClose ? Promise.resolve(true) : drainGate; } },
      vscode: { workspace: {}, window: { tabGroups: { all: [] } } }, completed: !outcome.startsWith('assertion'), bodyFailed: false, bodyFailure: outcome.startsWith('assertion') ? originalFailure : undefined,
      uri: { fsPath: '/unused/probe.kqlx', toString: () => 'file:///unused/probe.kqlx' }, console: { log(message) { effects.logging++; logs.push(message); } },
      fs: { promises: {}, readFileSync: () => disk, writeFileSync(target, content) { writes.push({ name: path.basename(target), content, failures: [...context.fixtureFailures], pending: context.preparationReplies.size });
        if (outcome.includes('writer') && (outcome !== 'event writer failure' || path.basename(target) === 'events.jsonl')) throw writerFailure; } },
      holdPreparation: true, preparationGate, preparationReached() {}, heldView: undefined, finalPersistView: undefined, failFinalSnapshot: false, state: {}, editRevision: 2,
      view: { projection: { sourceGeneration: 1 }, async receive() { await replyGate; if (replyFails) throw replyFailure; } }, metadataFailure,
    });
    const counters = new Script(recorder + '\n' + compile('let atReturn; const ' + capture.getText(source) + '; captureReturn({ success: false, saved: false }); () => ({ recordErrors, recordingError });')).runInContext(context);
    const deleteReply = context.preparationReplies.delete;
    context.preparationReplies.delete = function (reply) {
      removals.push({ failures: [...context.fixtureFailures], ...counters() });
      return deleteReply.call(this, reply);
    };
    if (captureFails) context.fixtureFailures.push = function (error) {
      if (error === replyFailure) { captureAttempts++; throw captureFailure; }
      return Array.prototype.push.call(this, error);
    };
    assert.equal(writes.length, 0, 'Exact return snapshots must be captured without writing artifacts');
    buffer = 'AFTER_RETURN_BUFFER'; disk = 'AFTER_RETURN_DISK';
    if (outcome.includes('metadata')) new Script("record('metadata.failure', () => { throw metadataFailure; });").runInContext(context);
    let sdkReturn;
    const posted = new Script(compile('(' + sender.initializer.getText(source) + ')({ type: "requestFinalPersist", requestId: "probe" })')).runInContext(context);
    posted.then(value => { sdkReturn = value; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(sdkReturn, true, 'SDK postMessage must not await its preparation reply');
    assert.equal(context.preparationReplies.size, 1, 'Track the actual issued preparation promise');
    const replyObservation = [...context.preparationReplies][0].then(() => ({ status: 'fulfilled', failures: [...context.fixtureFailures], ...counters() }),
      error => ({ status: 'rejected', error, failures: [...context.fixtureFailures], ...counters() }));
    const cleanup = new Script(compile('(async () => { try { if (bodyFailure) throw bodyFailure; } ' + (attempt.catchClause?.getText(source) ?? '') + ' finally ' + attempt.finallyBlock.getText(source) + ' })()')).runInContext(context);
    const observed = cleanup.then(() => ({ error: undefined, failures: [...context.fixtureFailures], pending: context.preparationReplies.size }),
      error => ({ error, failures: [...context.fixtureFailures], pending: context.preparationReplies.size }));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(drainCalled, false); assert.equal(writes.length, 0, 'No artifacts while preparation is held');
    releasePreparation();
    releaseReply();
    await Promise.race([drainReached, observed.then(result => { throw result.error ?? new Error('Cleanup exited before the close drain'); })]);
    if (!immediateClose) {
      assert.equal(writes.length, 0, 'No artifacts while the panel close drain is held');
      releaseDrain(outcome !== 'cleanup failure');
    }
    const result = await observed;
    const observation = await replyObservation;
    if (immediateClose) testContext.diagnostic(JSON.stringify({ immediateClose, capturedBeforeRemoval: removals[0]?.failures[0] === replyFailure,
      captureErrorCount: counters().recordErrors, capturedBeforeArtifacts: writes.every(write => write.failures.includes(captureFails ? captureFailure : replyFailure)),
      exactCleanupError: result.error === (outcome.startsWith('assertion') ? originalFailure : captureFails ? captureFailure : replyFailure),
      trackedObservationStatus: observation.status, pendingAtReturn: result.pending }));
    assert.equal(context.preparationReplies.size, 0);
    assert.deepEqual(effects, { restoredSave: 1, panels: 1, subscriptions: 1, session: 1, lease: 1, logging: 1 });
    assert.equal(context.fs.promises.open, original); assert.equal(context.fs.promises.realpath, original);
    for (const field of ['setWorkbenchFileCloseLifecycle', 'attachKustoResultPersistenceSession', 'publishSqlLeaveNoTraceStateFresh']) assert.equal(context.prototype[field], original);
    assert.equal(context.vscode.workspace.onWillSaveTextDocument, original); assert.equal(context.vscode.workspace.onDidSaveTextDocument, original);
    assert.equal(context.setTimeout, original); assert.equal(context.clearTimeout, original); assert.equal(context.KustoWorkbenchToolOrchestrator.instance, original);
    assert.equal(writes.filter(write => write.name === 'events.jsonl').length, 1, 'Flush normal events exactly once');
    if (outcome.startsWith('assertion')) assert.equal(result.error, originalFailure);
    else if (outcome === 'cleanup failure') assert.match(result.error?.message ?? '', /Native Save work must drain/);
    else assert.equal(result.error, replyFails ? captureFails ? captureFailure : replyFailure : outcome === 'metadata failure' ? metadataFailure : outcome.includes('writer') ? writerFailure : undefined);
    if (immediateClose) {
      const expectedFailure = captureFails ? captureFailure : replyFailure;
      assert.equal(result.pending, 0); assert.deepEqual(result.failures, [expectedFailure], 'Cleanup return must retain the exact rejection');
      assert.ok(writes.length > 0);
      assert.ok(writes.every(write => write.pending === 0 && write.failures[0] === expectedFailure), 'Capture the exact rejection before any artifact finalization');
      assert.equal(removals.length, 1);
      if (captureFails) {
        assert.equal(captureAttempts, 1); assert.equal(removals[0].recordingError, captureFailure); assert.equal(removals[0].recordErrors, 1);
        const receipt = JSON.parse(writes.find(write => write.name === 'events.jsonl').content.trim().split('\n').at(-1));
        assert.equal(receipt.recordErrors, 1); assert.equal(receipt.failures, 1);
        assert.match(logs[0], /errors=1; cleanupFailures=1$/);
      } else assert.deepEqual(removals[0].failures, [replyFailure], 'Record rejection before removing pending work');
      assert.equal(observation.status, 'fulfilled', 'The pending set must track the full contained observation chain, not the original rejected reply');
    }
    const snapshot = writes.find(write => write.name === 'public-return.json');
    if (outcome === 'passing negative') assert.equal(snapshot, undefined, 'Expected success:false is not fixture failure');
    else if (outcome !== 'writer failure') {
      assert.ok(snapshot, 'Body and cleanup failures must retain the exact return-time bytes');
      const captured = JSON.parse(snapshot.content);
      assert.equal(captured.buffer, 'RETURN_BUFFER'); assert.equal(captured.disk, 'RETURN_DISK');
    }
  });
}

test('native Save participant trace fixture bypasses eager payload diagnostics but preserves the return oracle', () => {
  const source = fs.readFileSync(new URL('../integration/kqlSidecar.test.ts', import.meta.url), 'utf8');
  const start = source.indexOf("const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-native-commit-join-'));");
  const recordStart = source.indexOf('const record =', start), recordEnd = source.indexOf('\n\t\tconst subscriptions:', recordStart);
  assert.ok(start >= 0 && recordStart > start && recordEnd > recordStart);
  const typescript = require('typescript'), calls = [];
  const code = typescript.transpileModule(source.slice(recordStart, recordEnd), { compilerOptions: { target: typescript.ScriptTarget.ES2022 } }).outputText;
  const sideEffects = { details: 0, files: 0, logging: 0 };
  const record = new Script(code + '\nrecord;').runInNewContext({ nativeSaveTrace: { record: (...args) => calls.push(args) }, events: [],
    fs: { appendFileSync() { sideEffects.files++; throw new Error('No synchronous diagnostic file I/O'); } },
    console: { log() { sideEffects.logging++; throw new Error('No callback logging'); } }, path, root: '/unused' });
  record('commit.held', () => { sideEffects.details++; throw new Error('No eager buffer/disk detail'); });
  assert.deepEqual(sideEffects, { details: 0, files: 0, logging: 0 });
  assert.deepEqual(calls, [['commit.held', undefined]]);
  const fixture = source.slice(start, source.indexOf('\n\tconst nativeSingleSaveTitle', start));
  assert.ok(fixture.includes("record('commit.held', () => ({ version: event.document.version, dirty: event.document.isDirty, commits }))"));
  assert.ok(fixture.includes("atReturn = { dirty: document!.isDirty, buffer: document!.getText(), disk: fs.readFileSync(uri.fsPath, 'utf8'), commits }"));
  assert.ok(fixture.includes("assert.strictEqual(atReturn.disk, newText, 'The waiting Save must not publish the newer user draft')"));
  assert.ok(fixture.includes('!!passiveView && readbackView === passiveView'));
  const extracted = nativeCommitFixture();
  const oracle = extracted.nodes.find(node => extracted.typescript.isCallExpression(node)
    && node.expression.getText(extracted.source) === 'assert.strictEqual' && node.arguments[2]?.text === 'The waiting Save must not publish the newer user draft');
  assert.ok(oracle);
  assert.throws(() => new Script(extracted.compile(oracle.getText(extracted.source))).runInNewContext({ assert, atReturn: { disk: 'changed' }, newText: 'exact' }),
    error => error.code === 'ERR_ASSERTION');
});

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

test('isolated archive public-activation repro uses real first calls, exact109 order and nonpolling hidden oracles', () => {
  const feature = fs.readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/archive-public-activation-repro/archive-public-activation-repro.feature', import.meta.url), 'utf8');
  const expressions = [...feature.matchAll(/from extension host expression "(.*)"/g)].map(match => match[1]);
  const blocks = [...feature.matchAll(/"""\r?\n([\s\S]*?)\r?\n\s*"""/g)].map(match => match[1]);
  assert.equal(expressions.length + blocks.length, 115);
  for (const expression of [...expressions, ...blocks]) assert.doesNotThrow(() => new Script(expression));
  assert.deepEqual([...feature.matchAll(/__archiveSourceRepro\.activateOne\((\d+)\)/g)].map(match => Number(match[1])), Array.from({ length: 109 }, (_, index) => index));
  assert.equal([...feature.matchAll(/__archiveSourceRepro\.recoverOnce\(\)/g)].length, 1);
  const historicalBody = feature.slice(feature.indexOf('state.activateOne ='), feature.indexOf('state.afterLoad ='));
  assert.ok(historicalBody.includes("invoke('kusto-workbench_activate-workbench-file'"));
  assert.equal(historicalBody.includes('vscode.openWith'), false);
  assert.equal(historicalBody.includes('while ('), false);
  assert.ok(feature.includes("state.oracles('full109-hidden', true)"));
  assert.ok(feature.includes("state.oracles('after-ordinary-activation', false)"));
});

test('original archive baseline checks the actual notebook without seeds, query, Save or warming', () => {
  const feature = fs.readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/archive-original-canary-baseline/archive-original-canary-baseline.feature', import.meta.url), 'utf8');
  const expressions = [...feature.matchAll(/from extension host expression "(.*)"/g)].map(match => match[1]);
  const blocks = [...feature.matchAll(/"""\r?\n([\s\S]*?)\r?\n\s*"""/g)].map(match => match[1]);
  assert.equal(expressions.length + blocks.length, 2);
  for (const expression of [...expressions, ...blocks]) assert.doesNotThrow(() => new Script(expression));
  for (const forbidden of ['preparePersistedResultFixture', 'seedCopilot', 'seedCod2', 'vscode.openWith', 'workbench.action.files.save', 'executeQuery', 'executeSqlQuery']) assert.equal(feature.includes(forbidden), false, forbidden);
  assert.equal([...feature.matchAll(/activation = await invoke\('kusto-workbench_activate-workbench-file'/g)].length, 1);
  assert.ok(feature.includes("notes = await invoke('kusto-workbench_manage-development-notes', { action: 'view', openFileId })"));
  assert.ok(feature.includes('dataSourceCount === 1'));
  assert.ok(feature.includes('outcome.damage.length'));
});

for (const startingState of ['dirty tab', 'dirty document', 'clean']) test(`hidden short trial refuses unsafe starting state (${startingState})`, async () => {
  const feature = fs.readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/archive-original-canary-baseline/hidden-short-access.feature', import.meta.url), 'utf8');
  const expression = [...feature.matchAll(/"""\r?\n([\s\S]*?)\r?\n\s*"""/g)][0][1];
  const manifestPath = path.join(os.tmpdir(), 'hidden-guard-manifest-not-read.json');
  const uri = { scheme: 'file', fsPath: path.join(os.tmpdir(), 'hidden-guard-existing.kqlx'), toString: () => 'file:///existing.kqlx' };
  const document = { uri, version: 3, isDirty: startingState === 'dirty document', getText: () => 'existing content' };
  const tab = { input: { uri, viewType: 'kusto.kqlxEditor' }, isDirty: startingState === 'dirty tab', isActive: true };
  let setupReads = 0;
  let toolCalls = 0;
  const fileSystem = {
    ...fs,
    readFileSync(file) {
      if (file === manifestPath) { setupReads++; throw new Error('known clean setup boundary'); }
      return Buffer.from('existing content');
    },
  };
  const context = createContext({
    process: { platform: process.platform, env: { KW_HIDDEN_SHORT_MANIFEST: manifestPath },
      getBuiltinModule: name => name === 'node:fs' ? fileSystem : process.getBuiltinModule(name) },
    performance, TextDecoder, Buffer, console,
    vscode: {
      version: '1.143.0', LogLevel: { Trace: 1 }, env: { logLevel: 1 },
      extensions: { getExtension: () => ({ isActive: true }) },
      window: { tabGroups: { all: [{ tabs: [tab], isActive: true, viewColumn: 1 }] } },
      workspace: { workspaceFolders: [], textDocuments: [document] },
      lm: { invokeTool: async () => { toolCalls++; throw new Error('unexpected tool call'); } },
    },
  });
  const outcome = await new Script(expression).runInContext(context);
  assert.equal(toolCalls, 0);
  if (startingState === 'clean') {
    assert.equal(setupReads, 1);
    assert.match(outcome.errors[0].message, /known clean setup boundary/);
  } else {
    assert.equal(setupReads, 0, 'dirty starting state must be refused before setup or activation');
    assert.match(outcome.errors[0].message, /dirty starting (tab|document)/i);
  }
});

for (const dirty of [true, false]) test(`first-execution trial protects a tabless starting document (dirty=${dirty})`, () => {
  const feature = fs.readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/background-first-execution/background-first-execution.feature', import.meta.url), 'utf8');
  const setup = feature.slice(feature.indexOf('startingTabs = tabs();'), feature.indexOf('outcome.profileProvenance ='));
  assert.ok(setup.includes('pre-existing dirty file'));
  const document = { uri: { toString: () => 'untitled:existing' }, version: 4, isDirty: dirty };
  let toolCalls = 0;
  const disposable = () => ({ dispose() {} });
  const context = createContext({
    startingTabs: undefined, startingSettings: undefined, startingUris: new Set(), startingModels: new Map(), subscriptions: [], outcome: {},
    tabs: () => [], tabState: () => ({}), activeSurface: () => ({}), inputUris: () => [],
    modelState: model => ({ version: model.version, dirty: model.isDirty }), fileState: () => ({}),
    observeSurface() {}, observeDocument() {}, record() {},
    check: (condition, message) => assert.ok(condition, message),
    manifest: { profilePath: '/isolated-test-profile' }, path, fs: { readFileSync: () => Buffer.from('{}') },
    vscode: {
      Uri: { parse: value => ({ scheme: 'untitled', toString: () => value }) },
      window: { tabGroups: { onDidChangeTabs: disposable, onDidChangeTabGroups: disposable }, onDidChangeActiveTextEditor: disposable },
      workspace: { textDocuments: [document], onDidOpenTextDocument: disposable, onDidChangeTextDocument: disposable,
        onWillSaveTextDocument: disposable, onDidSaveTextDocument: disposable, onDidCloseTextDocument: disposable },
      lm: { invokeTool: () => { toolCalls++; } },
    },
  });
  const script = new Script(setup + '\nvscode.lm.invokeTool();');
  if (dirty) {
    assert.throws(() => script.runInContext(context), /pre-existing dirty file/);
    assert.equal(toolCalls, 0);
  } else {
    script.runInContext(context);
    assert.equal(toolCalls, 1);
    assert.equal(context.startingModels.get('untitled:existing')?.document, document);
    assert.equal(context.startingUris.has('untitled:existing'), true);
  }
});

test('first-execution manifest admits an explicitly named isolated SQL profile with exact provenance', () => {
  const feature = fs.readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/background-first-execution/background-first-execution.feature', import.meta.url), 'utf8');
  const start = feature.indexOf("manifest = JSON.parse(manifestBytes.toString('utf8')"), end = feature.indexOf('// Clean restored tabs', start);
  assert.ok(start >= 0 && end > start);
  const root = path.resolve('owned-profile-root'), name = 'sql-fixture-new';
  const profileDir = path.join(root, 'tests/vscode-extension-tester/profiles', name), userData = path.join(profileDir, 'user-data');
  const manifest = { engine: 'sql', profileName: name, cdpPort: 59434, profilePath: userData, authoritativeProfilePath: userData, extensionRoot: root, evidenceRoot: '/owned-evidence', sqlConnectionId: 'new-id', sqlServerUrl: 'approved.example,1433', sqlDatabase: 'approved-database' };
  const extension = { extensionUri: { fsPath: root }, activate() { assert.fail('Preflight must not activate'); } };
  const context = createContext({ manifest: undefined, extension: undefined, evidenceRoot: undefined, engine: 'sql', path, outcome: {},
    process: { env: { KW_FIRST_EXECUTION_PROFILE_NAME: name } }, manifestBytes: Buffer.from(JSON.stringify(manifest)), hash: () => 'manifest-hash',
    canonical: value => path.resolve(value).toLowerCase(), check: (condition, message) => assert.ok(condition, message),
    fs: { realpathSync: value => value, existsSync: () => true, readFileSync(file) { assert.equal(file, path.join(profileDir, 'profile.json')); return JSON.stringify({ name }); }, mkdtempSync: () => '/owned-evidence/run' },
    vscode: { extensions: { getExtension: () => extension }, lm: { invokeTool() { assert.fail('Preflight must not invoke tools'); } } },
  });
  new Script(feature.slice(start, end)).runInContext(context);
  assert.equal(context.outcome.query, 'SELECT 1 AS Probe'); assert.equal(context.evidenceRoot, '/owned-evidence/run');
});

test('first-execution profile preflight preserves defaults and rejects unsafe named provenance before settings or activation', () => {
  const feature = fs.readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/background-first-execution/background-first-execution.feature', import.meta.url), 'utf8');
  const start = feature.indexOf("manifest = JSON.parse(manifestBytes.toString('utf8')"), end = feature.indexOf('// Clean restored tabs', start);
  assert.ok(start >= 0 && end > start);
  for (const shape of ['sql-default', 'kusto-default', 'explicit-default', 'empty', 'traversal', 'name-mismatch', 'profile-dir', 'sibling-prefix', 'authoritative-mismatch', 'redirect', 'root-mismatch', 'root-redirect', 'metadata-name', 'missing-target']) {
    const engine = shape === 'kusto-default' ? 'kusto' : 'sql', root = path.resolve('owned-profile-root');
    const defaultProfile = shape.endsWith('default'), name = defaultProfile ? `${engine}-auth` : 'sql-fixture-new';
    const profileDir = path.join(root, 'tests/vscode-extension-tester/profiles', name), userData = path.join(profileDir, 'user-data');
    const manifest = { engine, profileName: name, cdpPort: 59434, profilePath: userData, authoritativeProfilePath: userData, extensionRoot: root, evidenceRoot: '/owned-evidence', sqlConnectionId: 'new-id', sqlServerUrl: 'approved.example', sqlDatabase: 'approved' };
    const env = defaultProfile && shape !== 'explicit-default' ? {} : { KW_FIRST_EXECUTION_PROFILE_NAME: name };
    if (shape === 'empty') env.KW_FIRST_EXECUTION_PROFILE_NAME = '';
    if (shape === 'traversal') env.KW_FIRST_EXECUTION_PROFILE_NAME = '../sql-auth';
    if (shape === 'name-mismatch') manifest.profileName = 'sql-other';
    if (shape === 'profile-dir') manifest.profilePath = profileDir;
    if (shape === 'sibling-prefix') manifest.profilePath = userData + '-other';
    if (shape === 'authoritative-mismatch') manifest.authoritativeProfilePath = userData + '-other';
    if (shape === 'root-mismatch') manifest.extensionRoot = root + '-other';
    if (shape === 'missing-target' || defaultProfile) delete manifest.sqlDatabase;
    let created = 0;
    const context = createContext({ manifest: undefined, extension: undefined, evidenceRoot: undefined, engine, path, outcome: {}, process: { env },
      manifestBytes: Buffer.from(JSON.stringify(manifest)), hash: () => 'hash', canonical: value => path.resolve(value).toLowerCase(), check: (condition, message) => assert.ok(condition, message),
      fs: { existsSync: () => true, realpathSync: value => (shape === 'redirect' && value === userData || shape === 'root-redirect' && value === root) ? value + '-redirected' : value,
        readFileSync(file) { assert.equal(file, path.join(profileDir, 'profile.json'), 'No settings read during profile preflight'); return JSON.stringify({ name: shape === 'metadata-name' ? 'wrong' : name }); },
        mkdtempSync() { created++; return '/owned-evidence/run'; } },
      vscode: { extensions: { getExtension: () => ({ extensionUri: { fsPath: root }, activate() { assert.fail('No preflight activation'); } }) }, lm: { invokeTool() { assert.fail('No preflight tool calls'); } } },
    });
    const run = () => new Script(feature.slice(start, end)).runInContext(context);
    if (defaultProfile) { run(); assert.equal(created, 1); }
    else { assert.throws(run, /SETUP_BLOCKED/, shape); assert.equal(created, 0); }
  }
  for (const guard of ['check(!startingTabs.some', 'check(ancestry.some']) {
    const position = feature.indexOf(guard); assert.ok(position > 0);
    assert.ok(position < feature.indexOf('startingSettings = fs.readFileSync'));
    assert.ok(position < feature.indexOf('await extension.activate();'));
  }
});

test('first-execution Windows argument matcher rejects partial and duplicate profile or root flags', context => {
  if (process.platform !== 'win32') { context.skip('Windows-only launcher provenance'); return; }
  const feature = fs.readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/background-first-execution/background-first-execution.feature', import.meta.url), 'utf8');
  const start = feature.indexOf('const exactArgumentFunction ='), end = feature.indexOf('const profileMatch =', start);
  assert.ok(start >= 0 && end > start);
  const helper = new Script('(() => { ' + feature.slice(start, end) + '; return exactArgumentFunction; })()').runInNewContext();
  const cases = [
    ['--user-data-dir="C:/owned profile/user-data"', true], ['--user-data-dir "C:/owned profile/user-data"', true],
    ['"--user-data-dir=C:/owned profile/user-data"', true],
    ['--user-data-dir="C:/owned profile/user-data"-other', false],
    ['--user-data-dir="C:/owned profile/user-data-other"', false], ['--other="C:/owned profile/user-data"', false],
    ['--user-data-dir="C:/owned profile/user-data" --user-data-dir=other', false],
    ['--user-data-dir="C:/owned profile/user-data" --user-data-dir=', false],
    ['--other="--user-data-dir=C:/owned profile/user-data"', false],
    ['--user-data-dir=', false], ['', false],
  ];
  const encoded = Buffer.from(JSON.stringify(cases.map(([line]) => '"C:/Code.exe" ' + line))).toString('base64');
  const script = helper + ` $lines=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))); @($lines | ForEach-Object { Test-ExactPathArgument $_ 'user-data-dir' 'C:/owned profile/user-data' }) | ConvertTo-Json -Compress`;
  const result = process.getBuiltinModule('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15000 });
  assert.deepEqual(JSON.parse(result), cases.map(([, expected]) => expected));
});

test('first-execution named SQL profile cannot mutate when its selected target differs', () => {
  const feature = fs.readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/background-first-execution/background-first-execution.feature', import.meta.url), 'utf8');
  const start = feature.indexOf('const selected = selection.connectionId'), end = feature.indexOf('outcome.target =', start);
  assert.ok(start > 0 && end > start);
  for (const mismatch of ['none', 'default-only', 'favorite-only', 'id', 'server', 'database', 'ambiguous', 'missing']) {
    const connection = { id: 'new-id', serverUrl: 'approved.example' };
    const manifest = { profilePath: '/owned-profile', sqlConnectionId: 'new-id', sqlServerUrl: 'approved.example', sqlDatabase: 'approved' };
    if (mismatch === 'id') manifest.sqlConnectionId = 'old-id';
    if (mismatch === 'server') manifest.sqlServerUrl = 'different.example';
    if (mismatch === 'database') manifest.sqlDatabase = 'different';
    let mutations = 0;
    const context = createContext({ manifest, dedicatedProfile: true, engine: 'sql', path, extension: { id: 'workbench' },
      selection: { connectionId: 'new-id', database: mismatch.endsWith('-only') ? null : 'approved' }, favorites: mismatch === 'favorite-only' ? [{ connectionId: 'new-id', database: 'approved' }] : [],
      fs: { existsSync: () => mismatch === 'default-only', readFileSync(file) {
        assert.equal(file, path.join(manifest.profilePath, 'User/globalStorage', 'workbench', 'sql-connections.v1.json'));
        return JSON.stringify({ schemaVersion: 1, connections: [{ ...connection, database: 'approved' }] });
      } },
      connections: mismatch === 'missing' ? [] : mismatch === 'ambiguous' ? [connection, connection] : [connection],
      check: (condition, message) => assert.ok(condition, message), mutate: () => { mutations++; } });
    const run = () => new Script(feature.slice(start, end) + '\nmutate();').runInContext(context);
    if (['none', 'default-only', 'favorite-only'].includes(mismatch)) { run(); assert.equal(mutations, 1); }
    else { assert.throws(run, /SETUP_BLOCKED/); assert.equal(mutations, 0); }
  }
});

const typeSpecFrameworkMetadata = { uri: 'chatSessionInput:input-0', scheme: 'chatSessionInput', version: 2, dirty: false, languageId: 'plaintext', ownershipClassification: 'framework-chat-input' };
const typeSpecFileMetadata = { uri: 'file:///untabbed.kqlx', scheme: 'file', version: 1, dirty: false, languageId: 'plaintext', ownershipClassification: 'unknown-before-manifest' };

for (const { name, metadata = [typeSpecFrameworkMetadata], reachesManifest = false, tabDirty, drift } of [
  { name: 'dirty tabless', metadata: [{ ...typeSpecFileMetadata, dirty: true }] },
  { name: 'clean tabless', metadata: [typeSpecFileMetadata] },
  { name: 'clean framework', reachesManifest: true },
  { name: 'empty', metadata: [], reachesManifest: true },
  { name: 'dirty framework', metadata: [{ ...typeSpecFrameworkMetadata, dirty: true, ownershipClassification: 'unknown-before-manifest' }] },
  { name: 'unknown chat input', metadata: [{ ...typeSpecFrameworkMetadata, uri: 'chatSessionInput:input-1', ownershipClassification: 'unknown-before-manifest' }] },
  { name: 'wrong language', metadata: [{ ...typeSpecFrameworkMetadata, languageId: 'typescript', ownershipClassification: 'unknown-before-manifest' }] },
  { name: 'wrong scheme', metadata: [{ ...typeSpecFrameworkMetadata, scheme: 'untitled', ownershipClassification: 'unknown-before-manifest' }] },
  { name: 'untitled', metadata: [{ ...typeSpecFileMetadata, uri: 'untitled:existing', scheme: 'untitled' }] },
  { name: 'mixed framework and file', metadata: [typeSpecFrameworkMetadata, typeSpecFileMetadata] },
  { name: 'zero framework version', metadata: [{ ...typeSpecFrameworkMetadata, version: 0, ownershipClassification: 'unknown-before-manifest' }] },
  { name: 'fractional framework version', metadata: [{ ...typeSpecFrameworkMetadata, version: 2.5, ownershipClassification: 'unknown-before-manifest' }] },
  { name: 'later positive framework version', metadata: [{ ...typeSpecFrameworkMetadata, version: 7 }], reachesManifest: true },
  { name: 'clean tab', tabDirty: false },
  { name: 'dirty tab', tabDirty: true },
  { name: 'version drift before owner', reachesManifest: true, drift: 'version' },
  { name: 'disappearance before owner', reachesManifest: true, drift: 'disappearance' },
  { name: 'same-URI replacement before owner', reachesManifest: true, drift: 'replacement' },
]) test(`TypeSpec first-activation guards initial document models (${name})`, async () => {
  const feature = fs.readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/typespec-first-activation/typespec-first-activation.feature', import.meta.url), 'utf8');
  const expression = [...feature.matchAll(/"""\r?\n([\s\S]*?)\r?\n\s*"""/g)][0][1];
  const manifestPath = path.join(os.tmpdir(), 'typespec-guard-manifest-not-read.json');
  let setupReads = 0;
  let fileCalls = 0;
  let bodyReads = 0;
  let settingReads = 0;
  let settingWrites = 0;
  let extensionActivations = 0;
  let commandCalls = 0;
  let toolCalls = 0;
  const makeDocument = expected => ({
    uri: { scheme: expected.scheme, toString: () => expected.uri }, version: expected.version, isDirty: expected.dirty, languageId: expected.languageId,
    get getText() { bodyReads++; throw new Error('Startup metadata must not read document bodies'); },
    get lineCount() { bodyReads++; throw new Error('Startup metadata must not read document lengths'); },
  });
  const documents = metadata.map(makeDocument);
  const originalDocuments = [...documents];
  const startingTabs = tabDirty === undefined ? [] : [{ input: { uri: documents[0].uri }, isDirty: tabDirty, isActive: true }];
  const fileSystem = new Proxy({}, { get: (_target, method) => (...args) => {
    fileCalls++;
    if (method === 'readFileSync' && args[0] === manifestPath) {
      setupReads++;
      if (drift === 'version') documents[0].version++;
      if (drift === 'disappearance') documents.length = 0;
      if (drift === 'replacement') documents[0] = makeDocument(typeSpecFrameworkMetadata);
      throw new Error('known manifest setup boundary');
    }
    throw new Error('Unexpected filesystem access: ' + String(method));
  } });
  const context = createContext({
    process: { platform: process.platform, env: { KW_TYPESPEC_FROZEN_MANIFEST: manifestPath, KW_TYPESPEC_PRESET_ONLY: '1' },
      getBuiltinModule: name => name === 'node:fs' ? fileSystem : process.getBuiltinModule(name) },
    performance, TextDecoder, Buffer, console, setTimeout, clearTimeout,
    vscode: {
      version: '1.143.0', LogLevel: { Trace: 1 }, env: { logLevel: 1 },
      extensions: { getExtension: () => ({ isActive: false, activate() { extensionActivations++; } }) },
      commands: { executeCommand: () => { commandCalls++; } },
      window: { tabGroups: { all: [{ tabs: startingTabs }] } },
      workspace: { workspaceFolders: [], textDocuments: documents, getConfiguration: () => {
        settingReads++;
        return { inspect() { settingReads++; }, get() { settingReads++; }, update() { settingWrites++; } };
      } },
      lm: { invokeTool: () => { toolCalls++; } },
    },
  });
  const outcome = await new Script(expression).runInContext(context);
  assert.equal(extensionActivations, 0);
  assert.equal(commandCalls, 0);
  assert.equal(toolCalls, 0);
  assert.equal(settingReads, 0);
  assert.equal(settingWrites, 0);
  assert.equal(bodyReads, 0);
  assert.equal(setupReads, reachesManifest ? 1 : 0);
  assert.equal(fileCalls, setupReads);
  assert.equal(outcome.classification, drift ? 'PRESERVATION_FAILED' : 'SETUP_BLOCKED');
  assert.equal(outcome.calls.length, 0);
  assert.equal(outcome.models.length, 0);
  assert.equal(outcome.saved.length, 0);
  assert.equal(outcome.configuration.changes.length, 0);
  assert.equal(outcome.evidenceRoot, undefined);
  assert.equal(outcome.damage.length, drift ? 1 : 0);
  if (reachesManifest) {
    assert.match(outcome.errors[0].message, /known manifest setup boundary/);
  } else if (tabDirty !== undefined) {
    assert.match(outcome.errors[0].message, /pre-existing tabs/i);
  } else {
    assert.match(outcome.errors[0].message, /pre-existing document models/i);
  }
  if (tabDirty === undefined) assert.deepEqual(JSON.parse(JSON.stringify(outcome.initialDocuments)), metadata);
  else assert.equal(outcome.initialDocuments, undefined, 'Tabs must be refused before model admission');
  if (drift) {
    const damage = JSON.parse(JSON.stringify(outcome.damage[0]));
    assert.equal(damage.label, 'after-cleanup-and-settings-restore');
    assert.equal(damage.kind, 'framework-chat-input');
    assert.deepEqual(damage.expected, typeSpecFrameworkMetadata);
    assert.equal(damage.sameDocument, drift === 'version');
    assert.deepEqual(damage.actual, drift === 'version' ? { ...typeSpecFrameworkMetadata, version: 3 } : null);
    assert.equal(outcome.errors.some(error => error.phase === 'framework-model-preservation'), true);
  } else {
    assert.equal(documents.length, originalDocuments.length);
    assert.equal(documents.every((document, index) => document === originalDocuments[index]), true);
  }
  assert.equal(startingTabs.length, tabDirty === undefined ? 0 : 1);
  if (startingTabs.length) assert.equal(startingTabs[0].isDirty, tabDirty);
});

for (const { name, stage, mutation, expectedActivations, expectedCalls } of [
  { name: 'unchanged', expectedActivations: 1, expectedCalls: 2 },
  { name: 'async setup version drift', stage: 'setup', mutation: 'version', expectedActivations: 0, expectedCalls: 0 },
  { name: 'async setup URI drift', stage: 'setup', mutation: 'uri', expectedActivations: 0, expectedCalls: 0 },
  { name: 'async setup scheme drift', stage: 'setup', mutation: 'scheme', expectedActivations: 0, expectedCalls: 0 },
  { name: 'extension activation dirties model', stage: 'activation', mutation: 'dirty', expectedActivations: 1, expectedCalls: 0 },
  { name: 'first public call removes model', stage: 'public-call', mutation: 'disappearance', expectedActivations: 1, expectedCalls: 1 },
  { name: 'first public call replaces model', stage: 'public-call', mutation: 'replacement', expectedActivations: 1, expectedCalls: 1 },
  { name: 'last settings restore changes language', stage: 'restore', mutation: 'language', expectedActivations: 1, expectedCalls: 2 },
]) test(`TypeSpec first-activation preserves framework models at actual checkpoints (${name})`, async () => {
  const feature = fs.readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/typespec-first-activation/typespec-first-activation.feature', import.meta.url), 'utf8');
  const extract = (start, end, offset = 0) => {
    const startIndex = feature.indexOf(start, offset);
    const endIndex = feature.indexOf(end, startIndex);
    assert.ok(startIndex >= 0 && endIndex > startIndex, 'Missing actual feature block: ' + start);
    return feature.slice(startIndex, endIndex);
  };
  const declarations = extract('const initialDocumentReferences =', 'const subscriptions =');
  const capture = extract('for (const document of vscode.workspace.textDocuments) initialDocumentReferences.set', 'assert.equal(vscode.workspace.workspaceFolders?.length');
  const activation = extract("phase = 'extension-activation';", "assert.equal(tabs().length, 0, 'Activation setup");
  const publicLoop = extract('for (const reference of references.values()) {', 'assert.equal(tabs().some', feature.indexOf("phase = 'extension-activation';"));
  const publicCall = extract("const raw = await vscode.lm.invokeTool('kusto-workbench_activate-workbench-file'", 'record.raw = raw;');
  const restore = extract('for (const setting of settings.reverse()) {', 'outcome.finalTabs = tabSnapshot();');
  const terminal = extract('if (outcome.damage.length || outcome.saved.length)', "else if (outcome.classification === 'RUNNING')");
  let bodyReads = 0;
  const makeDocument = () => ({
    uri: { scheme: 'chatSessionInput', toString: () => 'chatSessionInput:input-0' }, version: 2, isDirty: false, languageId: 'plaintext',
    get getText() { bodyReads++; throw new Error('Checkpoint must not read document bodies'); },
    get lineCount() { bodyReads++; throw new Error('Checkpoint must not read document lengths'); },
  });
  const document = makeDocument();
  const documents = [document];
  const events = [];
  let extensionActivations = 0;
  let toolCalls = 0;
  const pause = async checkpoint => {
    await Promise.resolve();
    events.push(checkpoint);
    if (stage !== checkpoint) return;
    if (mutation === 'version') document.version++;
    if (mutation === 'uri') document.uri.toString = () => 'chatSessionInput:input-1';
    if (mutation === 'scheme') document.uri.scheme = 'untitled';
    if (mutation === 'dirty') document.isDirty = true;
    if (mutation === 'language') document.languageId = 'typescript';
    if (mutation === 'disappearance') documents.length = 0;
    if (mutation === 'replacement') documents[0] = makeDocument();
  };
  const context = createContext({
    assert, pause, phase: 'setup',
    write: () => undefined, startupCapture: { settle() {} },
    outcome: { initialDocuments: [], damage: [], saved: [], errors: [], checks: {}, configuration: {}, classification: 'SETUP_BLOCKED' },
    references: new Map([[100, { index: 100, uri: 'file:///first.kqlx' }], [101, { index: 101, uri: 'file:///second.kqlx' }]]),
    settings: [{ section: 'files', key: 'autoSave', previous: undefined, previousEffective: 'off' }],
    updateSetting: async (...args) => { assert.equal(args[3], 'restore'); await pause('restore'); },
    extension: { activate: async () => { extensionActivations++; await pause('activation'); } },
    vscode: { workspace: { textDocuments: documents }, lm: { invokeTool: async (tool, options) => {
      assert.equal(tool, 'kusto-workbench_activate-workbench-file');
      assert.equal(options.input.targetFileUri, toolCalls === 0 ? 'file:///first.kqlx' : 'file:///second.kqlx');
      toolCalls++;
      await pause('public-call');
    } } },
  });
  const expression = `(async () => {
    ${declarations}
    ${capture}
    try {
      await pause('setup');
      ${activation}
      ${publicLoop}
        const record = { input: { targetFileUri: reference.uri } };
        ${publicCall}
      }
    } catch (error) { outcome.errors.push({ phase, message: error.message }); }
    finally { await pause('cleanup'); ${restore} }
    ${terminal}
    return outcome;
  })()`;
  const outcome = await new Script(expression).runInContext(context);
  assert.equal(extensionActivations, expectedActivations);
  assert.equal(toolCalls, expectedCalls);
  assert.equal(bodyReads, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.initialDocuments)), [typeSpecFrameworkMetadata]);
  assert.deepEqual(events.slice(-2), ['cleanup', 'restore']);
  assert.equal(outcome.classification, stage ? 'PRESERVATION_FAILED' : 'SETUP_BLOCKED');
  if (stage) {
    const firstLabel = stage === 'setup' ? 'before-extension-activation' : stage === 'activation' ? 'before-public-activation-100' : stage === 'public-call' ? 'before-public-activation-101' : 'after-cleanup-and-settings-restore';
    assert.equal(outcome.damage[0].label, firstLabel);
    assert.equal(outcome.damage.at(-1).label, 'after-cleanup-and-settings-restore');
    assert.equal(outcome.damage.length, stage === 'restore' ? 1 : 2);
    assert.deepEqual(JSON.parse(JSON.stringify(outcome.damage[0].expected)), typeSpecFrameworkMetadata);
    assert.equal(outcome.damage[0].sameDocument, mutation !== 'disappearance' && mutation !== 'replacement');
    assert.equal(outcome.errors.every(error => /Pre-existing framework chat model changed/.test(error.message)), true);
  } else {
    assert.equal(outcome.damage.length, 0);
    assert.equal(outcome.errors.length, 0);
    assert.equal(documents[0], document);
  }
});

test('TypeSpec first-activation expressions retain exact checkpoint ordering and cold notebook gates', () => {
  const feature = fs.readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/typespec-first-activation/typespec-first-activation.feature', import.meta.url), 'utf8');
  const expressions = [...feature.matchAll(/"""\r?\n([\s\S]*?)\r?\n\s*"""/g)].map(match => match[1]);
  assert.equal(expressions.length, 2);
  assert.equal([...feature.matchAll(/from extension host expression/g)].length, expressions.length);
  for (const expression of expressions) assert.doesNotThrow(() => new Script(expression));
  const position = statement => {
    const offset = feature.indexOf(statement);
    assert.ok(offset >= 0, 'Missing actual feature statement: ' + statement);
    return offset;
  };
  const ordered = statements => {
    const offsets = statements.map(position);
    assert.equal(offsets.every((offset, index) => index === 0 || offset > offsets[index - 1]), true, statements.join(' -> '));
  };
  ordered([
    "assert.equal(extension.isActive, false, 'Requires an unused isolated extension host')",
    "assert.equal(tabs().length, 0, 'Preserve pre-existing tabs; never reset them')",
    'for (const document of vscode.workspace.textDocuments) initialDocumentReferences.set(document, initialDocumentMetadata(document))',
    'outcome.initialDocuments = [...initialDocumentReferences.values()]',
    "assert.equal(outcome.initialDocuments.every(metadata => metadata.ownershipClassification === 'framework-chat-input'), true",
    'initialDocumentsAdmitted = true',
    'assert.equal(vscode.workspace.workspaceFolders?.length ?? 0, 0',
    'const manifestBytes = fs.readFileSync(process.env.KW_TYPESPEC_FROZEN_MANIFEST)',
  ]);
  ordered([
    "startupCapture = startPendingTypeSpecCapture({ index: 'startup', uri: '', path: '' })",
    "write('startup-before-observer'",
    "dispatcherObserver.install(workbenchRequire('vscode'))",
    "phase = 'extension-activation';",
    "preserveInitialDocuments('before-extension-activation')",
    "write('startup-before-activation'",
    'await extension.activate();',
    'finally { startupCapture.settle(); }',
    "write('startup-activated'",
  ]);
  assert.match(feature, /for \(const reference of references\.values\(\)\) \{\s*phase = 'first-activation-' \+ reference\.index;\s*preserveInitialDocuments\('before-public-activation-' \+ reference\.index\);/);
  const publicCheckpoint = position("preserveInitialDocuments('before-public-activation-' + reference.index)");
  const publicCall = position("const raw = await vscode.lm.invokeTool('kusto-workbench_activate-workbench-file'");
  assert.ok(publicCheckpoint < publicCall);
  ordered(['await extension.activate();', 'await verifyTypeSpecTrace();', "phase = 'first-activation-' + reference.index;"]);
  assert.ok(position('I capture the output channel "Kusto Workbench"') < position('async function runTypeSpecAcceptance'));
  assert.equal(feature.slice(publicCheckpoint, publicCall).includes('await '), false);
  ordered([
    'await helper.closeAcceptanceTabs(vscode, owner, [...references.keys()])',
    'for (const subscription of subscriptions) {',
    'for (const setting of settings.reverse())',
    "await updateSetting(setting, setting.previous, setting.previousEffective, 'restore')",
    "preserveInitialDocuments('after-cleanup-and-settings-restore')",
    'outcome.finalTabs = tabSnapshot()',
    "if (outcome.damage.length || outcome.saved.length) outcome.classification = 'PRESERVATION_FAILED'",
  ]);
  const frameworkHelpers = feature.slice(position('const initialDocumentReferences ='), position('const subscriptions ='));
  for (const forbidden of ['getText', 'lineCount', 'fs.', 'references.', 'models.', 'write(']) assert.equal(frameworkHelpers.includes(forbidden), false, forbidden);
  assert.equal([...feature.matchAll(/\breferences\.set\(/g)].length, 1);
  assert.equal([...feature.matchAll(/\bmodels\.set\(/g)].length, 1);
  for (const statement of [
    "assert.equal(hash(manifestBytes), process.env.KW_TYPESPEC_FROZEN_SHA, 'Frozen manifest identity changed')",
    'assert.equal(manifest.runtimeStableDuringCopy, true)',
    "assert.equal(canonicalPath(extension.extensionPath), canonicalPath(manifest.extensionRoot), 'Wrong loaded extension root')",
    "assert.notEqual(canonicalPath(extension.extensionPath), canonicalPath(manifest.sourceRoot), 'Do not run against the parent watcher output')",
    'for (const file of manifest.files)',
    "assert.equal(hash(fs.readFileSync(actual)), file.sha256, 'Frozen runtime changed: ' + file.path)",
    'assert.equal(bytes.length, 54487)',
    "assert.equal(hash(bytes), '38c40a018111e2b4dc4fe79424e15f1d44a7f4675203eecd379400301049bf6e')",
    "assert.equal(vscode.workspace.textDocuments.some(document => document.uri.toString() === reference.uri), false, 'Target model was warmed before its first public call')",
    'if (!reference) return;',
    'const text = document.getText();',
    'document.version !== 1 || document.version !== models.get(document).version',
    'assert.equal(record.value?.success, true, record.allText)',
    'assert.equal(record.value.isLiveWorkbench, true, record.allText)',
    'assert.equal(record.value.isReadOnlyFallback, false, record.allText)',
    "assert.equal(record.value.uri, reference.uri, 'First response URI differs')",
    "assert.equal(record.value.openFileId, reference.expectedOpenFileId, 'First response file ID differs')",
    "assert.equal(receipt.classification, 'PASS')",
    'assert.equal(receipt.calls.length, 1)',
    'assert.equal(receipt.calls[0].oraclePassed, true)',
    'assert.equal(receipt.build.mainSha256, outcome.build.mainSha256)',
    'assert.equal(receipt.runtime.vscode, vscode.version)',
    "const selected = outcome.trial === 'standalone' ? [ledger.sweep[103]] : ledger.sweep.slice(99, 104)",
  ]) position(statement);
});

const typeSpecFeatureSource = () => fs.readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/typespec-first-activation/typespec-first-activation.feature', import.meta.url), 'utf8');
const nativeOpenFeatureSource = () => fs.readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/archive-original-canary-baseline/native-first-activation-diagnostic.feature', import.meta.url), 'utf8');
const nativeOpenObserverFactory = () => {
  const source = nativeOpenFeatureSource();
  const first = source.indexOf('const readNativeMessageMetadata =');
  const last = source.indexOf('const outcome =', first);
  assert.ok(first >= 0 && last > first);
  return new Script('(() => { ' + source.slice(first, last) + ' return createNativeOpenObserver; })()').runInNewContext({ process, Promise });
};
const nativeOpenFixture = () => {
  class Uri {
    constructor(scheme, value) { this.scheme = scheme; this.value = value; this.query = ''; this.fragment = ''; }
    toString() { return this.value; }
  }
  const uri = new Uri('file', 'file:///owned/101.kqlx'), listeners = new Map(), calls = [];
  const behavior = { result: Promise.resolve(undefined), clock: 0, phase: 'first-open-101-custom' };
  const event = key => callback => { listeners.set(key, callback); return { dispose() { listeners.delete(key); } }; };
  const original = function (...args) { calls.push({ receiver: this, args }); if (behavior.error) throw behavior.error; return behavior.result; };
  const facade = {
    Uri, commands: { executeCommand: original },
    workspace: Object.fromEntries(['onDidOpenTextDocument', 'onDidCloseTextDocument', 'onWillSaveTextDocument', 'onDidSaveTextDocument', 'onDidChangeTextDocument', 'onDidChangeConfiguration'].map(key => [key, event(key)])),
    window: { registerCustomEditorProvider: original, tabGroups: { onDidChangeTabs: event('tabs') } },
  };
  facade.workspace.openTextDocument = original;
  const observer = nativeOpenObserverFactory()({ facade, references: new Map([[uri.toString(), { index: 101 }]]), initialDocuments: new Map(), clock: () => ++behavior.clock, getPhase: () => behavior.phase });
  return { facade, observer, uri, listeners, behavior, calls, original, event };
};

test('native activation diagnostic parses actual expressions and retains bounded cold control flow', () => {
  const feature = nativeOpenFeatureSource(), blocks = [...feature.matchAll(/"""\r?\n([\s\S]*?)\r?\n\s*"""/g)].map(match => match[1]);
  assert.equal(blocks.length, 2); assert.equal([...feature.matchAll(/\bScenario:/g)].length, 1);
  for (const expression of blocks) assert.doesNotThrow(() => new Script(expression));
  for (const forbidden of ['Promise.race', '.getText(', 'showTextDocument(', 'Start-Sleep', 'executeQuery', 'executeSqlQuery', 'workbench.action.files.save']) assert.equal(feature.includes(forbidden), false, forbidden);
  assert.doesNotMatch(feature, /(?:getConfiguration\([^)]*\)|configuration|config)\.update\(/);
  assert.equal([...feature.matchAll(/await vscode\.lm\.invokeTool\('kusto-workbench_activate-workbench-file'/g)].length, 1);
  assert.equal([...feature.matchAll(/await scoped\.commands\.executeCommand\('vscode.openWith'/g)].length, 1);
  assert.match(feature, /setInterval\([\s\S]*?250\)/); assert.match(feature, /45000\)/);
  const installed = feature.indexOf('observer.install();'), activation = feature.indexOf('await extension.activate();');
  assert.ok(installed >= 0 && activation > installed);
  assert.match(feature, /if \(owner && !pendingCall && !nativePending\)/);
  assert.match(feature, /DIAGNOSTIC_INTERRUPTED/);
});

for (const boundary of ['openTextDocument', 'executeCommand']) test(`native activation diagnostic preserves ${boundary} promise, receiver, arguments and errors`, async () => {
  const fixture = nativeOpenFixture(), { facade, observer, uri, behavior, calls } = fixture;
  const target = boundary === 'openTextDocument' ? facade.workspace : facade.commands;
  const descriptor = Object.getOwnPropertyDescriptor(target, boundary), options = { preview: false };
  const args = boundary === 'openTextDocument' ? [uri, options] : ['vscode.openWith', uri, 'default', options];
  observer.install();
  let resolve;
  behavior.result = new Promise(accept => { resolve = accept; });
  assert.equal(Reflect.apply(target[boundary], target, args), behavior.result);
  assert.equal(calls[0].receiver, target); assert.deepEqual(calls[0].args, args);
  assert.equal(observer.snapshot().pending.length, 1); assert.equal(observer.snapshot().records[0].index, 101);
  resolve(); await behavior.result;
  assert.equal(observer.snapshot().pending.length, 0);
  let forbiddenReads = 0;
  behavior.result = Object.defineProperty({}, 'then', { get() { forbiddenReads++; throw new Error('No thenable adoption'); } });
  assert.equal(Reflect.apply(target[boundary], target, args), behavior.result);
  assert.equal(observer.snapshot().settlementUnavailable, 1);
  behavior.error = Object.defineProperty({}, 'message', { get() { forbiddenReads++; throw new Error('No error inspection'); } });
  assert.throws(() => Reflect.apply(target[boundary], target, args), error => error === behavior.error);
  assert.equal(forbiddenReads, 0);
  observer.restore(); assert.deepEqual(Object.getOwnPropertyDescriptor(target, boundary), descriptor);
  assert.equal(observer.snapshot().restoreFailures, 0); assert.equal(fixture.listeners.size, 0);
});

test('native activation diagnostic validates raw Uri and data-only options without inspecting foreign payloads', async () => {
  const { facade, observer, uri, behavior } = nativeOpenFixture(); observer.install();
  assert.equal(facade.workspace.openTextDocument({ uri }), behavior.result);
  await behavior.result;
  const before = JSON.stringify(observer.snapshot()); let getterReads = 0;
  const accessor = Object.defineProperty({}, 'uri', { get() { getterReads++; throw new Error('Do not inspect option accessors'); } });
  const foreign = new facade.Uri('data', 'data:text/plain,SECRET');
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { getterReads++; throw new Error('No reflection'); } });
  for (const argument of [accessor, foreign, hostile, 'file:///owned/101.kqlx']) assert.equal(facade.workspace.openTextDocument(argument), behavior.result);
  assert.equal(facade.commands.executeCommand('unrelated-command', uri, 'SECRET'), behavior.result);
  assert.equal(JSON.stringify(observer.snapshot()), before); assert.equal(getterReads, 0);
  observer.restore();
});

test('native activation diagnostic records unknown provider entry before URI filtering without changing provider or panel', async () => {
  const fixture = nativeOpenFixture(), { facade, observer, behavior, calls } = fixture;
  const prototype = { resolveCustomTextEditor: fixture.original }, provider = Object.create(prototype);
  const prototypeDescriptor = Object.getOwnPropertyDescriptor(prototype, 'resolveCustomTextEditor');
  const panel = { webview: { onDidReceiveMessage: fixture.event('receive'), postMessage: fixture.original } };
  observer.install();
  const registration = [ 'kusto.kqlxEditor', provider, { retainContextWhenHidden: true } ];
  assert.equal(facade.window.registerCustomEditorProvider(...registration), behavior.result);
  const args = [{ uri: new facade.Uri('data', 'data:text/plain,SECRET') }, panel, {}];
  assert.equal(provider.resolveCustomTextEditor(...args), behavior.result);
  assert.equal(calls[1].receiver, provider); assert.deepEqual(calls[1].args, args);
  await behavior.result;
  const entries = observer.snapshot().records.filter(entry => entry.kind === 'provider.resolveCustomTextEditor.entry');
  assert.equal(entries.length, 1); assert.equal(entries[0].known, false); assert.equal(entries[0].scheme, 'data'); assert.equal(entries[0].uri, null);
  assert.equal(JSON.stringify(observer.snapshot()).includes('SECRET'), false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'resolveCustomTextEditor'), prototypeDescriptor);
  observer.restore(); assert.equal(Object.hasOwn(provider, 'resolveCustomTextEditor'), false); assert.equal(provider.resolveCustomTextEditor, fixture.original);
});

for (const inherited of [false, true]) test(`native activation diagnostic preserves descriptor flags and reports immutable hooks (inherited=${inherited})`, () => {
  const fixture = nativeOpenFixture(), { facade, observer } = fixture;
  const original = { value: fixture.original, configurable: true, writable: false, enumerable: false };
  let owner = facade.workspace;
  if (inherited) { delete facade.workspace.openTextDocument; owner = Object.create(Object.getPrototypeOf(facade.workspace)); Object.setPrototypeOf(facade.workspace, owner); }
  Object.defineProperty(owner, 'openTextDocument', original);
  Object.defineProperty(facade.commands, 'executeCommand', { configurable: false, writable: false });
  observer.install();
  const patched = Object.getOwnPropertyDescriptor(facade.workspace, 'openTextDocument');
  assert.deepEqual({ ...patched, value: fixture.original }, original);
  assert.deepEqual([...observer.snapshot().unavailable], ['executeCommand']);
  observer.restore(); assert.equal(observer.snapshot().restoreFailures, 0);
  assert.deepEqual(Object.getOwnPropertyDescriptor(owner, 'openTextDocument'), original);
  if (inherited) assert.equal(Object.hasOwn(facade.workspace, 'openTextDocument'), false);
});

test('native activation diagnostic caps metadata, preserves pending operations and ignores callbacks after restore', async () => {
  const fixture = nativeOpenFixture(), { facade, observer, behavior, uri } = fixture;
  observer.install(); let resolve;
  behavior.result = new Promise(accept => { resolve = accept; });
  facade.workspace.openTextDocument(uri);
  for (let index = 0; index < 140; index++) { behavior.phase = 'phase-' + index; fixture.listeners.get('onDidOpenTextDocument')({ uri, version: 1, isDirty: false }); }
  assert.equal(observer.snapshot().records.length, 128); assert.ok(observer.snapshot().lost > 0);
  assert.equal(observer.snapshot().pending.length, 1);
  const callback = fixture.listeners.get('onDidChangeTextDocument');
  const final = observer.restore(), before = JSON.stringify(final);
  resolve(); await behavior.result; callback({ document: { uri, version: 2, isDirty: true }, contentChanges: [ {} ] });
  assert.equal(JSON.stringify(observer.snapshot()), before); assert.equal(final.pending.length, 1);
});

test('native activation diagnostic refuses cleanup after public cancellation while an SDK open remains pending', async () => {
  const source = nativeOpenFeatureSource(), first = source.indexOf('const hasPendingNativeOpen ='), last = source.indexOf('const outcome =', first);
  assert.ok(first >= 0 && last > first);
  const hasPending = new Script('(() => { ' + source.slice(first, last) + ' return hasPendingNativeOpen; })()').runInNewContext();
  const fixture = nativeOpenFixture(); fixture.observer.install();
  let resolve; fixture.behavior.result = new Promise(accept => { resolve = accept; });
  fixture.facade.commands.executeCommand('vscode.openWith', fixture.uri, 'default');
  assert.equal(hasPending(fixture.observer.snapshot()), true);
  assert.equal(hasPending({ pending: [{ kind: 'workspace.openTextDocument' }] }), true);
  assert.equal(hasPending({ pending: [{ kind: 'provider.resolveCustomTextEditor' }] }), true);
  assert.equal(hasPending({ pending: [{ kind: 'webview.post' }] }), false);
  resolve(); await fixture.behavior.result;
  assert.equal(hasPending(fixture.observer.snapshot()), false); fixture.observer.restore();
});

test('native activation diagnostic retains transient version and identity damage even after a clean snapshot', () => {
  const fixture = nativeOpenFixture(); fixture.observer.install();
  const document = { uri: fixture.uri, version: 1, isDirty: false };
  fixture.listeners.get('onDidOpenTextDocument')(document);
  document.version = 2;
  fixture.listeners.get('onDidChangeTextDocument')({ document, contentChanges: [] });
  document.version = 1;
  fixture.listeners.get('onDidChangeTextDocument')({ document, contentChanges: [] });
  fixture.listeners.get('onDidOpenTextDocument')({ ...document });
  assert.equal(fixture.observer.snapshot().modelDamage, 2);
  fixture.observer.restore();
});

test('native activation diagnostic aggregates duplicate post settlements without consuming the bounded native record budget', async () => {
  const fixture = nativeOpenFixture(), { observer, facade, behavior, uri } = fixture;
  const provider = { resolveCustomTextEditor: fixture.original };
  const panel = { webview: { onDidReceiveMessage: fixture.event('receive'), postMessage: fixture.original } };
  observer.install(); facade.window.registerCustomEditorProvider('kusto.kqlxEditor', provider);
  provider.resolveCustomTextEditor({ uri }, panel); await behavior.result;
  for (let index = 0; index < 200; index++) {
    const result = panel.webview.postMessage({ type: 'connectionsData', payload: 'DO_NOT_CAPTURE' });
    assert.equal(result, behavior.result); await result;
  }
  const snapshot = observer.snapshot();
  assert.equal(snapshot.lost, 0, 'Repeated settlements must aggregate, not displace later native boundaries');
  assert.equal(snapshot.records.filter(entry => entry.kind.startsWith('webview.post.')).length, 2);
  for (const record of snapshot.records.filter(entry => entry.kind.startsWith('webview.post.'))) {
    assert.equal(record.count, 200); assert.ok(record.lastMs > record.firstMs);
  }
  assert.equal(JSON.stringify(snapshot).includes('DO_NOT_CAPTURE'), false);
  assert.equal(snapshot.pending.length, 0); observer.restore();
});

test('native activation diagnostic captures only own primitive metadata and keeps panel and generation identity', async () => {
  const fixture = nativeOpenFixture(), { observer, facade, behavior, uri, calls } = fixture;
  const provider = { resolveCustomTextEditor: fixture.original };
  const panels = [1, 2].map(index => ({ webview: { onDidReceiveMessage: fixture.event('receive-' + index), postMessage: fixture.original } }));
  observer.install(); facade.window.registerCustomEditorProvider('kusto.kqlxEditor', provider);
  for (const panel of panels) { provider.resolveCustomTextEditor({ uri }, panel); await behavior.result; }
  behavior.result = Promise.resolve(false);
  let forbiddenReads = 0;
  const message = { type: 'documentData', probeId: '', requestId: 'request', viewSessionId: 'session', documentViewSessionId: 'session',
    reloadRequestId: 'reload-1', sourceGeneration: 1, forceReload: false, documentRevision: 0, editRevision: 0, runtimeId: 'runtime', applied: false };
  Object.defineProperty(message, 'body', { get() { forbiddenReads++; throw new Error('No payload'); } });
  Object.defineProperty(message, 'query', { get() { forbiddenReads++; throw new Error('No query'); } });
  for (const panel of panels) for (const metadata of [message, message, { ...message, reloadRequestId: 'reload-2', sourceGeneration: 2 }]) {
    const before = calls.length;
    assert.equal(panel.webview.postMessage(metadata), behavior.result); await behavior.result;
    assert.equal(calls.length, before + 1, 'No synthetic SDK post');
    assert.equal(calls.at(-1).receiver, panel.webview); assert.equal(calls.at(-1).args[0], metadata);
  }
  const accessor = Object.create({ type: 'inherited' });
  Object.defineProperty(accessor, 'applied', { get() { forbiddenReads++; throw new Error('No metadata getter'); } });
  const proxy = new Proxy({}, { get() { forbiddenReads++; throw new Error('No get trap'); }, getOwnPropertyDescriptor() { forbiddenReads++; throw new Error('No reflection'); } });
  for (const value of [accessor, proxy]) fixture.listeners.get('receive-1')(value);
  const snapshot = observer.snapshot(), posts = snapshot.records.filter(entry => entry.kind === 'webview.post.fulfilled');
  assert.deepEqual(Array.from(posts, entry => [entry.panelId, entry.index, entry.sourceGeneration, entry.count, entry.sdkResult]), [[1, 101, 1, 2, false], [1, 101, 2, 1, false], [2, 101, 1, 2, false], [2, 101, 2, 1, false]]);
  for (const [key, value] of Object.entries(message)) assert.equal(posts[0][key], value);
  assert.equal(posts[0].uriSha256, createHash('sha256').update(uri.toString()).digest('hex'));
  assert.equal(forbiddenReads, 0); assert.equal(snapshot.failures, 0);
  assert.ok(snapshot.records.filter(entry => entry.kind === 'webview.receive').every(entry => !Object.hasOwn(entry, 'applied') && !Object.hasOwn(entry, 'type')));
  observer.restore();
});

test('native activation diagnostic preserves SDK boolean, foreign Promise, rejection and thrown identities', async () => {
  const fixture = nativeOpenFixture(), { observer, facade, behavior, uri } = fixture;
  const provider = { resolveCustomTextEditor: fixture.original }, panel = { webview: { onDidReceiveMessage: fixture.event('receive'), postMessage: fixture.original } };
  observer.install(); facade.window.registerCustomEditorProvider('kusto.kqlxEditor', provider);
  provider.resolveCustomTextEditor({ uri }, panel); await behavior.result;
  for (const value of [true, false, 0, undefined]) {
    behavior.result = new Script('Promise.resolve(value)').runInNewContext({ value });
    assert.equal(panel.webview.postMessage({ type: 'documentData', sourceGeneration: 0 }), behavior.result);
    assert.equal(await behavior.result, value);
    const results = observer.snapshot().records.filter(entry => entry.kind === 'webview.post.fulfilled');
    assert.equal(results.at(-1).sdkResult, typeof value === 'boolean' ? value : 'unobserved');
  }
  let reads = 0;
  const failure = Object.defineProperty({}, 'message', { get() { reads++; throw new Error('No error access'); } });
  behavior.result = new Script('Promise.reject(failure)').runInNewContext({ failure });
  assert.equal(panel.webview.postMessage({ type: 'documentData' }), behavior.result);
  await assert.rejects(behavior.result, error => error === failure);
  behavior.error = failure;
  assert.throws(() => panel.webview.postMessage({ type: 'documentData' }), error => error === failure);
  delete behavior.error;
  behavior.result = Object.defineProperty({}, 'then', { get() { reads++; throw new Error('No then getter'); } });
  assert.equal(panel.webview.postMessage({ type: 'documentData' }), behavior.result);
  const snapshot = observer.restore();
  assert.equal(reads, 0);
  for (const [kind, result] of [['rejected', 'rejected'], ['thrown', 'throw'], ['unobserved-return', 'unobserved']]) assert.equal(snapshot.records.find(entry => entry.kind === 'webview.post.' + kind).sdkResult, result);
  const serialized = JSON.stringify(snapshot); await Promise.resolve();
  assert.equal(JSON.stringify(observer.snapshot()), serialized); assert.equal(fixture.listeners.size, 0);
});

test('native activation diagnostic distinguishes extension-host environment from the CLI launch environment', () => {
  const source = nativeOpenFeatureSource(), first = source.indexOf('const inspectNativeHostEnvironment ='), last = source.indexOf('const outcome =', first);
  assert.ok(first >= 0 && last > first);
  for (const value of [undefined, '', '0', '1']) {
    const env = value === undefined ? {} : { ELECTRON_RUN_AS_NODE: value };
    const inspect = new Script('(() => { ' + source.slice(first, last) + ' return inspectNativeHostEnvironment; })()').runInNewContext({ process: { env }, assert });
    assert.equal(inspect().electronRunAsNodePresent, value !== undefined);
    assert.equal(inspect().electronRunAsNodeValue, value ?? null);
    for (const key of ['VSCODE_EXT_TEST_WORKSPACE', 'KUSTO_WORKBENCH_E2E_BYPASS_FIRST_LAUNCH']) {
      env[key] = '';
      assert.throws(inspect, /must be absent/);
      delete env[key];
    }
  }
});

test('native activation diagnostic 45-second checkpoint observes the same pending first call without resolving or retrying it', async () => {
  const source = nativeOpenFeatureSource(), first = source.indexOf("outcome.classification = 'RUNNING';"), last = source.indexOf("outcome.classification = 'PASS';", first);
  assert.ok(first >= 0 && last > first);
  const uri = 'file:///owned/101.kqlx', timers = new Map(), writes = [], nativeTabs = [], documents = [], calls = [];
  let clock = 0, resolve;
  const original = new Promise(accept => { resolve = accept; });
  class TabInputCustom { constructor() { this.uri = { toString: () => uri }; this.viewType = 'kusto.kqlxEditor'; } }
  const context = createContext({ assert, phase: 'setup', pendingCall: undefined, checkpointTimer: undefined,
    outcome: { calls: [], editorMode: 'custom' }, references: new Map([[uri, { index: 101, uri, openFileId: 'wf_exact' }]]),
    performance: { now: () => clock }, tabs: () => nativeTabs, preserve: () => {},
    setTimeout(callback, delay) { assert.equal(delay, 45000); timers.set(1, callback); return 1; },
    clearTimeout(id) { timers.delete(id); },
    metadataSnapshot: () => ({ phase: context.phase, pending: context.pendingCall?.pending === true }),
    write: (name, value) => writes.push({ name, value }),
    vscode: { TabInputCustom, workspace: { textDocuments: documents }, lm: { invokeTool(...args) {
      calls.push(args); nativeTabs.push({ input: new TabInputCustom(), isActive: true }); documents.push({ uri: { toString: () => uri } }); return original;
    } } },
  });
  const running = new Script('(async () => { ' + source.slice(first, last) + ' })()').runInContext(context);
  let settled = false;
  const completion = running.then(() => { settled = true; }, error => { settled = true; throw error; });
  assert.equal(calls.length, 1); assert.equal(context.pendingCall.pending, true); assert.equal(timers.size, 1);
  clock = 45000; timers.get(1)(); await Promise.resolve();
  assert.equal(settled, false); assert.equal(calls.length, 1); assert.equal(context.pendingCall.pending, true);
  const checkpoint = context.outcome.pendingCheckpoint;
  assert.equal(checkpoint.classification, 'FIRST_AWAIT_PENDING'); assert.equal(checkpoint.pending, true); assert.equal(checkpoint.elapsedMs, 45000);
  assert.equal(writes.some(entry => entry.name === 'call-101-45s'), false, 'The pending checkpoint is memory-only');
  resolve({ content: [{ value: JSON.stringify({ success: true, isLiveWorkbench: true, isReadOnlyFallback: false, uri, openFileId: 'wf_exact' }) }] });
  await completion;
  assert.equal(context.outcome.calls[0].oraclePassed, true); assert.equal(context.pendingCall, undefined); assert.equal(timers.size, 0); assert.equal(calls.length, 1);
});

const nativeRendererFactories = () => {
  const source = nativeOpenFeatureSource();
  return new Script('(() => { ' + source.slice(source.indexOf('const readNativeMessageMetadata ='), source.indexOf('const hasPendingNativeOpen =')) + ' return { readNativeMessageMetadata, installNativeRendererProbe, createNativeRendererObserver }; })()')
    .runInNewContext({ process, Promise, setTimeout, clearTimeout, Date });
};

const nativeRendererFixture = ({ initialRoot = {}, publish } = {}) => {
  const factories = nativeRendererFactories(), events = [], listeners = new Set(), registrations = [], intervals = new Map(), timers = new Map(), observers = new Set(), pendingMutations = new Set();
  const document = { documentElement: initialRoot };
  const allowedDocuments = new Set([document]);
  let clock = 0, timerId = 0;
  class MessageEvent { constructor(value) { this.value = value; } get data() { return this.value; } }
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.observing = false; this.disconnects = 0; observers.add(this); }
    observe(target, options) { assert.ok(allowedDocuments.has(target)); assert.deepEqual(JSON.parse(JSON.stringify(options)), { childList: true }); this.target = target; this.observing = true; }
    disconnect() { this.observing = false; this.disconnects++; pendingMutations.delete(this); }
  }
  const mutateRoot = (root, target = sandbox.document) => { target.documentElement = root; for (const observer of observers) if (observer.observing && observer.target === target) pendingMutations.add(observer); };
  const sandbox = createContext({ readMetadata: factories.readNativeMessageMetadata, MessageEvent, MutationObserver, document, Date: { now: () => clock }, performance: { now: () => clock },
    kwNativeDiag_test: payload => { const event = JSON.parse(payload); events.push(event); publish?.(event); },
    addEventListener(name, callback, capture) {
      assert.equal(name, 'message'); assert.equal(capture, true); registrations.push({ name, callback, capture });
      if (![...listeners].some(entry => entry.name === name && entry.callback === callback && entry.capture === capture)) listeners.add({ name, callback, capture });
    },
    removeEventListener(name, callback, capture) { for (const entry of listeners) if (entry.name === name && entry.callback === callback && entry.capture === capture) listeners.delete(entry); },
    setInterval(callback, delay) { assert.equal(delay, 250); const id = ++timerId; intervals.set(id, callback); return id; }, clearInterval(id) { intervals.delete(id); },
    setTimeout(callback, delay) { assert.ok(delay <= 90000); const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
  });
  const install = () => new Script('(' + factories.installNativeRendererProbe.toString() + ')(readMetadata, "kwNativeDiag_test", "__kwNativeDiag_test", 85000)').runInContext(sandbox);
  return { sandbox, events, intervals, timers, listeners, registrations, observers, document, install, mutateRoot, setClock: value => { clock = value; },
    openDocument() { listeners.clear(); mutateRoot(null); },
    replaceDocument(root = {}) { const next = { documentElement: root }; allowedDocuments.add(next); listeners.clear(); sandbox.document = next; return next; },
    flushMutations() { const pending = [...pendingMutations]; pendingMutations.clear(); for (const observer of pending) observer.callback([], observer); },
    message(value) { for (const entry of [...listeners]) if (entry.name === 'message') entry.callback(new MessageEvent(value)); } };
};

test('renderer capture rebinds a replaced Document through its existing timer and cannot resurrect after retirement', () => {
  for (const reason of ['disposed', 'timeout', 'interval']) {
    const fixture = nativeRendererFixture(); fixture.install();
    const probe = fixture.sandbox.__kwNativeDiag_test, observer = [...fixture.observers][0];
    const heartbeat = [...fixture.intervals.values()][0], timeout = [...fixture.timers.values()][0];
    const replacement = fixture.replaceDocument(null);
    fixture.flushMutations(); assert.equal(probe.inspect().sameDocument, false, 'No mutation of the old document occurred');
    fixture.setClock(250); heartbeat();
    fixture.message({ type: 'documentData', viewSessionId: 'exact', reloadRequestId: 'gen1', sourceGeneration: 1 });
    assert.equal(fixture.events.filter(event => event.kind === 'message').length, 1, 'Capture must move to the replacement Document');
    assert.equal(probe.inspect().sameDocument, true); assert.equal(observer.target, replacement); assert.equal(observer.disconnects, 1);
    fixture.mutateRoot({}); fixture.flushMutations();
    const registrations = fixture.registrations.length;
    fixture.mutateRoot({}, fixture.document); fixture.flushMutations(); fixture.setClock(500); heartbeat();
    assert.equal(fixture.registrations.length, registrations, 'Retired documents and unchanged ticks cannot re-register');
    const latest = fixture.replaceDocument(); fixture.setClock(750); heartbeat();
    fixture.message({ type: 'documentData', viewSessionId: 'exact', reloadRequestId: 'gen2', sourceGeneration: 2 });
    assert.equal(observer.target, latest); assert.equal(observer.disconnects, 2); assert.equal(probe.inspect().allEvents, 2);
    assert.equal(fixture.events.filter(event => event.kind === 'message').length, 2); assert.equal(fixture.events.filter(event => event.kind === 'installed').length, 1);
    assert.equal(fixture.intervals.size, 1); assert.equal(fixture.timers.size, 1); assert.equal(fixture.listeners.size, 1);
    if (reason === 'disposed') probe.dispose(); else { fixture.setClock(85000); (reason === 'timeout' ? timeout : heartbeat)(); }
    assert.equal(observer.disconnects, 3); assert.equal(observer.observing, false);
    const eventCount = fixture.events.length, registrationCount = fixture.registrations.length;
    fixture.replaceDocument(); fixture.setClock(86000); heartbeat(); observer.callback([], observer); timeout();
    assert.equal(fixture.events.length, eventCount); assert.equal(fixture.registrations.length, registrationCount);
    assert.equal(fixture.listeners.size + fixture.intervals.size + fixture.timers.size, 0); assert.equal(observer.observing, false);
  }
});

test('renderer capture survives document replacement without duplicating listeners or installation markers', () => {
  for (const initialRoot of [{}, null]) {
    const fixture = nativeRendererFixture({ initialRoot }); assert.equal(fixture.install(), true);
    fixture.message({ type: 'mainWebviewDispatcherProbe', probeId: 'before-replacement' });
    const original = fixture.registrations[0];
    fixture.openDocument(); fixture.mutateRoot({}); fixture.flushMutations();
    fixture.message({ type: 'documentData', viewSessionId: 'exact', reloadRequestId: 'gen1', sourceGeneration: 1 });
    assert.equal(fixture.events.filter(event => event.kind === 'message').length, 2, 'The actual probe must capture gen1 after document.open/write');
    assert.equal(fixture.registrations.length, 2); assert.deepEqual(fixture.registrations[1], original); assert.equal(fixture.listeners.size, 1);
    fixture.mutateRoot(fixture.document.documentElement); fixture.flushMutations();
    assert.equal(fixture.registrations.length, 2, 'An unchanged root must not re-register');
    fixture.openDocument(); fixture.flushMutations(); fixture.mutateRoot({}); fixture.flushMutations();
    fixture.message({ type: 'documentData', viewSessionId: 'exact', reloadRequestId: 'gen2', sourceGeneration: 2 });
    assert.equal(fixture.events.filter(event => event.kind === 'message').length, 3); assert.equal(fixture.listeners.size, 1);
    assert.equal(fixture.events.filter(event => event.kind === 'installed').length, 1);
    assert.ok(fixture.registrations.every(entry => entry.callback === original.callback && entry.capture === original.capture));
    assert.equal(fixture.sandbox.__kwNativeDiag_test.dispose(), true);
    assert.ok([...fixture.observers].every(observer => !observer.observing && observer.disconnects === 1));
  }
});

test('renderer document observers retire on disposal and both expiry paths without queued callback resurrection', () => {
  for (const reason of ['disposed', 'timeout', 'interval']) {
    const fixture = nativeRendererFixture(); fixture.install();
    const observer = [...fixture.observers][0]; assert.ok(observer);
    const interval = [...fixture.intervals.values()][0], timeout = [...fixture.timers.values()][0];
    fixture.openDocument(); fixture.mutateRoot({});
    if (reason === 'disposed') assert.equal(fixture.sandbox.__kwNativeDiag_test.dispose(), true);
    else { fixture.setClock(85000); (reason === 'timeout' ? timeout : interval)(); }
    assert.equal(observer.observing, false); assert.equal(observer.disconnects, 1);
    assert.equal(fixture.listeners.size + fixture.intervals.size + fixture.timers.size, 0);
    const eventCount = fixture.events.length, registrationCount = fixture.registrations.length;
    fixture.flushMutations(); observer.callback([], observer); fixture.message({ type: 'documentData', reloadRequestId: 'late' });
    assert.equal(fixture.events.length, eventCount); assert.equal(fixture.registrations.length, registrationCount);
    assert.equal(Object.hasOwn(fixture.sandbox, '__kwNativeDiag_test'), false);
  }
});

test('renderer passive capture emits installation and first distinct messages immediately without payload or control effects', () => {
  const fixture = nativeRendererFixture(); assert.equal(fixture.install(), true);
  assert.deepEqual(fixture.events.map(event => event.kind), ['installed']);
  let reads = 0;
  const metadata = { type: 'documentData', viewSessionId: 'exact', reloadRequestId: 'gen1', sourceGeneration: 1, applied: false, editRevision: 0 };
  for (const key of ['query', 'rows', 'body', 'auth', 'payload']) Object.defineProperty(metadata, key, { get() { reads++; throw new Error('Forbidden payload'); } });
  Object.defineProperty(metadata, 'runtimeId', { get() { reads++; throw new Error('Forbidden metadata getter'); } });
  fixture.message(metadata); fixture.setClock(16); fixture.message(metadata);
  fixture.message({ ...metadata, reloadRequestId: 'gen2', sourceGeneration: 2, applied: 0 });
  assert.deepEqual(fixture.events.map(event => event.kind), ['installed', 'message', 'message']);
  assert.equal(fixture.events[1].message.applied, false); assert.equal(fixture.events[2].message.applied, 0);
  assert.equal(fixture.events[1].message.editRevision, 0); assert.equal(reads, 0);
  fixture.setClock(1000); [...fixture.intervals.values()][0]();
  assert.equal(fixture.events.at(-2).count, 2); assert.equal(fixture.events.at(-1).kind, 'heartbeat');
  assert.equal(fixture.sandbox.__kwNativeDiag_test.dispose(), true);
  assert.equal(fixture.listeners.size, 0); assert.equal(fixture.intervals.size, 0); assert.equal(fixture.timers.size, 0);
  assert.equal(Object.hasOwn(fixture.sandbox, '__kwNativeDiag_test'), false);
  assert.deepEqual(fixture.events.at(-1), { kind: 'disposed', ticks: 1, maxGapMs: 1000, lost: 0, failures: 0, listenerRemoved: true, timersCleared: true, namespaceRemoved: true, atMs: 1000 });
});

test('renderer message overflow cannot starve heartbeat and the listener self-expires without CDP', () => {
  const fixture = nativeRendererFixture(); fixture.install();
  for (let index = 0; index < 140; index++) fixture.message({ type: 'documentData', reloadRequestId: 'gen-' + index, sourceGeneration: index });
  assert.equal(fixture.events.filter(event => event.kind === 'message').length, 128);
  fixture.setClock(1000); [...fixture.intervals.values()][0]();
  assert.equal(fixture.events.at(-1).kind, 'heartbeat'); assert.equal(fixture.events.at(-1).lost, 12);
  fixture.setClock(85000); [...fixture.timers.values()][0]();
  assert.equal(fixture.events.at(-1).kind, 'expired'); assert.equal(fixture.events.at(-1).namespaceRemoved, true);
  assert.equal(fixture.listeners.size + fixture.intervals.size + fixture.timers.size, 0);
});

test('renderer realm inspection distinguishes untyped events, document identity and a data-only dispatcher marker', () => {
  const fixture = nativeRendererFixture(); fixture.install();
  const probe = fixture.sandbox.__kwNativeDiag_test;
  fixture.message(undefined); fixture.message(null); fixture.message({ channel: 'not-an-application-message' });
  fixture.setClock(1000); [...fixture.intervals.values()][0]();
  assert.equal(fixture.events.filter(event => event.kind === 'message').length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(probe.inspect())), { allEvents: 3, sameDocument: true, hasDispatcher: false });
  let reads = 0;
  Object.defineProperty(fixture.sandbox, '__kustoHostMessageDispatcherReady', { configurable: true, get() { reads++; return true; } });
  assert.equal(probe.inspect().hasDispatcher, false); assert.equal(reads, 0);
  Object.defineProperty(fixture.sandbox, '__kustoHostMessageDispatcherReady', { configurable: true, value: true });
  fixture.sandbox.document = { documentElement: {} };
  assert.deepEqual(JSON.parse(JSON.stringify(probe.inspect())), { allEvents: 3, sameDocument: false, hasDispatcher: true });
  probe.dispose(); fixture.registrations[0].callback(new fixture.sandbox.MessageEvent({ type: 'late' }));
  assert.equal(probe.inspect().allEvents, 3);
});

const nativeCdpFixture = async ({ failArm = false, arm = true } = {}) => {
  const handlers = new Map(), calls = [], timers = new Map(), realms = new Map();
  let clock = 0, timerId = 0;
  const emit = (name, value = {}, session = 'session') => { for (const callback of handlers.get(name) ?? []) callback(value, session); };
  const client = { on(name, callback) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(callback); },
    removeListener(name, callback) { handlers.get(name)?.delete(callback); },
    send(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (failArm && method === 'Target.setAutoAttach') return Promise.reject(new Error('original CDP arm error'));
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return Promise.resolve({ identifier: 'script-' + sessionId });
      if (method === 'Runtime.evaluate' && realms.has(params.uniqueContextId)) return Promise.resolve({ result: { value: new Script(params.expression).runInContext(realms.get(params.uniqueContextId)) } });
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: params.expression === '1' ? 1 : true } });
      return Promise.resolve({});
    },
    close() { calls.push({ method: 'close' }); emit('disconnect'); return Promise.resolve(); },
  };
  const CDP = Object.assign(async options => { assert.deepEqual(JSON.parse(JSON.stringify(options)), { target: 'ws://owned-browser', port: 59442 }); return client; }, {
    Version: async options => { assert.deepEqual(JSON.parse(JSON.stringify(options)), { host: '127.0.0.1', port: 59442 }); return { webSocketDebuggerUrl: 'ws://owned-browser' }; },
  });
  const observer = nativeRendererFactories().createNativeRendererObserver({ CDP, port: 59442, token: 'test', clock: () => ++clock,
    setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimer(id) { timers.delete(id); } });
  if (arm) await observer.arm();
  const attach = async () => { emit('Target.attachedToTarget', { sessionId: 'session', targetInfo: { targetId: 'target', type: 'page', title: 'DO_NOT_CAPTURE', url: 'DO_NOT_CAPTURE' } }, undefined); for (let index = 0; index < 20; index++) await Promise.resolve(); };
  const context = (id, uniqueId) => emit('Runtime.executionContextCreated', { context: { id, uniqueId, auxData: { isDefault: true, frameId: 'frame' }, name: 'DO_NOT_CAPTURE' } });
  const binding = (kind, fields = {}, id = 7) => emit('Runtime.bindingCalled', { name: 'kwNativeDiag_test', executionContextId: id, payload: JSON.stringify({ kind, atMs: clock, ...fields }) });
  const message = (reloadRequestId = 'gen1', sourceGeneration = 1, viewSessionId = 'exact') => binding('message', { message: { type: 'documentData', viewSessionId, reloadRequestId, sourceGeneration }, count: 1, firstMs: clock, lastMs: clock });
  const host = { records: [{ kind: 'webview.post.entry', type: 'documentData', index: 101, panelId: 2, uriSha256: 'a'.repeat(64), viewSessionId: 'exact', reloadRequestId: 'gen1', sourceGeneration: 1 }] };
  return { observer, client, CDP, emit, context, binding, message, host, calls, handlers, timers, realms, attach, setClock: value => { clock = value; } };
};

test('renderer document replacement forwards actual probe emissions into exact-context SDK qualification and cleanup', async () => {
  const fixture = await nativeCdpFixture(); await fixture.attach();
  const neighbor = nativeRendererFixture({ publish: event => fixture.binding(event.kind, event, 7) });
  fixture.realms.set('neighbor-100', neighbor.sandbox); fixture.context(7, 'neighbor-100');
  const prior = { ...fixture.host.records[0], index: 100, panelId: 1, viewSessionId: 'neighbor', reloadRequestId: 'neighbor-gen1' };
  fixture.host.records.unshift(prior);
  neighbor.message({ type: prior.type, viewSessionId: prior.viewSessionId, reloadRequestId: prior.reloadRequestId, sourceGeneration: 1 });
  assert.equal(fixture.observer.snapshot(fixture.host).binding, null);
  const target = nativeRendererFixture({ publish: event => fixture.binding(event.kind, event, 8) });
  fixture.realms.set('exact-101', target.sandbox);
  fixture.context(8, 'exact-101');
  const installedOrder = fixture.observer.snapshot().contexts.find(entry => entry.uniqueContextId === 'exact-101').installedOrder;
  target.replaceDocument(); target.setClock(250); [...target.intervals.values()][0]();
  for (const changed of [{ viewSessionId: 'wrong-session' }, { reloadRequestId: 'wrong-reload' }, { sourceGeneration: 2 }]) {
    target.message({ type: 'documentData', viewSessionId: 'exact', reloadRequestId: 'gen1', sourceGeneration: 1, ...changed });
    assert.equal(fixture.observer.snapshot(fixture.host).binding, null);
    assert.equal(fixture.observer.snapshot(fixture.host).qualification, 'LATE_OR_INCOMPLETE');
  }
  target.message({ type: 'documentData', viewSessionId: 'exact', reloadRequestId: 'gen1', sourceGeneration: 1 });
  fixture.host.records.push({ ...fixture.host.records[1], reloadRequestId: 'gen2', sourceGeneration: 2 });
  target.message({ type: 'documentData', viewSessionId: 'exact', reloadRequestId: 'gen2', sourceGeneration: 2 });
  const observed = fixture.observer.snapshot(fixture.host);
  assert.equal(observed.qualification, 'QUALIFIED'); assert.equal(observed.binding.index, 101); assert.equal(observed.binding.panelId, 2);
  assert.equal(observed.binding.uniqueContextId, 'exact-101'); assert.equal(observed.binding.installedOrder, installedOrder);
  assert.equal(observed.messages.find(entry => entry.reloadRequestId === 'gen2').contextKey, observed.binding.contextKey);
  const beforeInspection = JSON.stringify(fixture.observer.snapshot(fixture.host));
  const inspection = await fixture.observer.inspectRealms();
  assert.equal(inspection.status, 'inspected'); assert.equal(inspection.contexts.length, 2);
  assert.equal(inspection.contexts.find(entry => entry.contextKey === observed.binding.contextKey).allEvents, 5);
  assert.ok(inspection.contexts.every(entry => entry.status === 'available' && entry.sameDocument && !entry.hasDispatcher));
  assert.equal(JSON.stringify(fixture.observer.snapshot(fixture.host)), beforeInspection);
  neighbor.openDocument(); target.openDocument();
  const final = await fixture.observer.dispose(); assert.equal(final.cleanup.pendingContexts.length, 0); assert.equal(final.cleanup.hostShutdownRequired, false);
  assert.ok(final.contexts.every(context => context.cleaned));
  for (const probe of [neighbor, target]) {
    assert.ok([...probe.observers].every(observer => !observer.observing && observer.disconnects === (probe === target ? 2 : 1)));
    assert.equal(probe.listeners.size + probe.intervals.size + probe.timers.size, 0); assert.equal(Object.hasOwn(probe.sandbox, '__kwNativeDiag_test'), false);
    const count = probe.events.length; probe.flushMutations(); assert.equal(probe.events.length, count);
  }
});

test('renderer Document rebind cannot qualify generation one missed before the existing timer runs', async () => {
  const fixture = await nativeCdpFixture(); await fixture.attach();
  const realm = nativeRendererFixture({ publish: event => fixture.binding(event.kind, event) });
  fixture.realms.set('exact', realm.sandbox); fixture.context(7, 'exact');
  realm.replaceDocument();
  realm.message({ type: 'documentData', viewSessionId: 'exact', reloadRequestId: 'gen1', sourceGeneration: 1 });
  realm.setClock(250); [...realm.intervals.values()][0]();
  fixture.host.records.push({ ...fixture.host.records[0], reloadRequestId: 'gen2', sourceGeneration: 2 });
  realm.message({ type: 'documentData', viewSessionId: 'exact', reloadRequestId: 'gen2', sourceGeneration: 2 });
  const snapshot = fixture.observer.snapshot(fixture.host);
  assert.equal(snapshot.binding, null); assert.equal(snapshot.qualification, 'LATE_OR_INCOMPLETE');
  assert.equal(snapshot.messages.length, 1); assert.equal(snapshot.messages[0].sourceGeneration, 2);
  assert.equal((await fixture.observer.inspectRealms()).contexts[0].sameDocument, true);
  assert.equal((await fixture.observer.dispose()).cleanup.hostShutdownRequired, false);
});

test('renderer realm collection keeps unavailable, malformed, exceptional and retired observations separate from qualification', async () => {
  for (const status of ['available', 'unavailable', 'invalid', 'exception', 'rejected', 'retired']) {
    const fixture = await nativeCdpFixture(); await fixture.attach(); fixture.context(7, 'exact'); fixture.binding('installed'); fixture.message();
    await Promise.resolve();
    const originalSend = fixture.client.send;
    fixture.client.send = (method, params, sessionId) => {
      if (method !== 'Runtime.evaluate' || !params.expression.startsWith('(() => { const probe')) return originalSend(method, params, sessionId);
      assert.equal(params.uniqueContextId, 'exact'); assert.equal(sessionId, 'session');
      if (status === 'rejected') return Promise.reject(new Error('inspection only'));
      if (status === 'retired') fixture.emit('Runtime.executionContextDestroyed', { executionContextUniqueId: 'exact' });
      return Promise.resolve(status === 'exception' ? { exceptionDetails: { text: 'inspection only' } } : { result: { value: status === 'unavailable' ? null : {
        allEvents: status === 'invalid' ? -1 : 0, sameDocument: true, hasDispatcher: false,
      } } });
    };
    const inspection = await fixture.observer.inspectRealms();
    assert.equal(inspection.contexts.length, 1); assert.equal(inspection.contexts[0].status, status);
    if (status === 'available') assert.equal(inspection.contexts[0].allEvents, 0);
    else assert.equal(Object.hasOwn(inspection.contexts[0], 'allEvents'), false);
    assert.equal(fixture.observer.snapshot(fixture.host).qualification, 'QUALIFIED'); assert.equal(fixture.observer.snapshot().issues.length, 0);
    const final = await fixture.observer.dispose(); assert.equal(final.cleanup.hostShutdownRequired, false);
    assert.equal((await fixture.observer.inspectRealms()).status, 'unavailable');
  }
});

test('renderer realm collection starts one concurrent bounded sweep and ignores detached sessions and late replies', async () => {
  const fixture = await nativeCdpFixture(); await fixture.attach();
  for (const contextId of [7, 8]) { fixture.context(contextId, 'exact-' + contextId); fixture.binding('installed', {}, contextId); }
  await Promise.resolve();
  const originalSend = fixture.client.send, pending = [];
  fixture.client.send = (method, params, sessionId) => method === 'Runtime.evaluate' && params.expression.startsWith('(() => { const probe')
    ? new Promise(resolve => pending.push({ params, sessionId, resolve })) : originalSend(method, params, sessionId);
  const inspecting = fixture.observer.inspectRealms();
  assert.equal(pending.length, 2); assert.deepEqual(pending.map(entry => entry.params.uniqueContextId), ['exact-7', 'exact-8']);
  const deadlines = [...fixture.timers.values()].filter(timer => timer.delay === 2000); assert.equal(deadlines.length, 2);
  for (const deadline of deadlines) deadline.callback();
  assert.ok((await inspecting).contexts.every(entry => entry.status === 'timeout')); assert.equal(fixture.observer.snapshot().issues.length, 0);
  const beforeLate = JSON.stringify(fixture.observer.snapshot());
  for (const request of pending) request.resolve({ result: { value: { allEvents: 999, sameDocument: true, hasDispatcher: true } } });
  await Promise.resolve(); assert.equal(JSON.stringify(fixture.observer.snapshot()), beforeLate);
  fixture.emit('Target.detachedFromTarget', { sessionId: 'session' });
  assert.equal((await fixture.observer.inspectRealms()).contexts.length, 0); assert.equal(pending.length, 2);
  await fixture.observer.dispose();
});

test('renderer realm collection rejects inherited and accessor probe, method and result properties without invoking getters', async () => {
  for (const boundary of ['namespace', 'method', 'result']) for (const shape of ['missing', 'inherited', 'accessor']) {
    const fixture = await nativeCdpFixture(); await fixture.attach();
    const realm = nativeRendererFixture({ publish: event => fixture.binding(event.kind, event) });
    fixture.realms.set('exact', realm.sandbox); fixture.context(7, 'exact');
    const probe = realm.sandbox.__kwNativeDiag_test, inspect = probe.inspect;
    const namespaceDescriptor = Object.getOwnPropertyDescriptor(realm.sandbox, '__kwNativeDiag_test');
    const methodDescriptor = Object.getOwnPropertyDescriptor(probe, 'inspect');
    const globalObject = new Script('globalThis').runInContext(realm.sandbox);
    const globalPrototype = Object.getPrototypeOf(globalObject), probePrototype = Object.getPrototypeOf(probe);
    let reads = 0;
    const getter = () => { reads++; throw new Error('Inspection must not invoke a getter'); };
    if (boundary === 'result') {
      const result = { allEvents: 0, sameDocument: true, hasDispatcher: false };
      if (shape === 'missing') delete result.sameDocument;
      if (shape === 'inherited') { delete result.allEvents; Object.setPrototypeOf(result, { allEvents: 0 }); }
      if (shape === 'accessor') Object.defineProperty(result, 'allEvents', { configurable: true, get: getter });
      probe.inspect = () => result;
    } else {
      const target = boundary === 'namespace' ? globalObject : probe;
      const key = boundary === 'namespace' ? '__kwNativeDiag_test' : 'inspect';
      const value = boundary === 'namespace' ? probe : inspect;
      Reflect.deleteProperty(target, key);
      if (shape === 'inherited') Object.setPrototypeOf(target, Object.assign(Object.create(Object.getPrototypeOf(target)), { [key]: value }));
      if (shape === 'accessor') Object.defineProperty(target, key, { configurable: true, get: getter });
    }
    try {
      const inspection = await fixture.observer.inspectRealms();
      assert.equal(inspection.contexts[0].status, boundary === 'result' ? 'invalid' : 'unavailable', boundary + '/' + shape);
      assert.equal(Object.hasOwn(inspection.contexts[0], 'allEvents'), false); assert.equal(reads, 0);
      assert.equal(fixture.observer.snapshot().issues.length, 0);
    } finally {
      Object.setPrototypeOf(globalObject, globalPrototype); Object.setPrototypeOf(probe, probePrototype);
      Object.defineProperty(globalObject, '__kwNativeDiag_test', namespaceDescriptor); Object.defineProperty(probe, 'inspect', methodDescriptor);
      await fixture.observer.dispose();
    }
  }
});

test('renderer raw CDP binds only exact SDK gen1 after installation in one unique context, never neighboring panels or reused numeric IDs', async () => {
  const fixture = await nativeCdpFixture(); await fixture.attach(); fixture.context(7, 'unique-original');
  fixture.binding('installed'); fixture.message('neighbor', 1, 'neighbor-100');
  assert.equal(fixture.observer.snapshot(fixture.host).binding, null);
  fixture.message();
  const first = fixture.observer.snapshot(fixture.host);
  assert.equal(first.qualification, 'QUALIFIED'); assert.equal(first.binding.panelId, 2); assert.equal(first.binding.index, 101);
  assert.equal(first.binding.uniqueContextId, 'unique-original'); assert.equal(first.liveness, 'unknown', 'No heartbeat is not a dead-renderer assertion');
  fixture.binding('heartbeat', { ticks: 4, maxGapMs: 250 });
  assert.equal(fixture.observer.snapshot(fixture.host).liveness, 'heartbeat-observed');
  fixture.context(7, 'unique-reused'); fixture.binding('installed'); fixture.message('gen2', 2);
  const reused = fixture.observer.snapshot(fixture.host);
  assert.equal(reused.binding.uniqueContextId, 'unique-original'); assert.equal(reused.contexts.find(entry => entry.uniqueContextId === 'unique-original').destroyed, true);
  assert.notEqual(reused.messages.find(entry => entry.reloadRequestId === 'gen2').contextKey, reused.binding.contextKey);
  const ambiguous = structuredClone(fixture.host); ambiguous.records.push({ ...ambiguous.records[0], index: 100, panelId: 1 });
  assert.equal(fixture.observer.snapshot(ambiguous).binding, null);
  assert.equal(JSON.stringify(reused).includes('DO_NOT_CAPTURE'), false);
  await fixture.observer.dispose();
  assert.ok(fixture.calls.filter(call => call.method === 'Target.setAutoAttach').every(call => call.params.waitForDebuggerOnStart === false && call.params.flatten === true));
});

test('renderer late installation remains incomplete, bounded post-verdict probing and partial disconnect cleanup remain separate', async () => {
  const fixture = await nativeCdpFixture(); await fixture.attach(); fixture.context(7, 'unique'); fixture.message(); fixture.binding('installed');
  assert.equal(fixture.observer.snapshot(fixture.host).qualification, 'LATE_OR_INCOMPLETE');
  assert.equal(fixture.observer.snapshot(fixture.host).binding, null);
  assert.equal((await fixture.observer.afterFailedFirstResult(fixture.host, true)).status, 'not-requested');
  fixture.emit('disconnect');
  const final = await fixture.observer.dispose();
  assert.equal(final.cleanup.hostShutdownRequired, true); assert.ok(final.issues.some(entry => entry.status === 'disconnected'));
  assert.equal([...fixture.handlers.values()].reduce((count, entries) => count + entries.size, 0), 0); assert.equal(fixture.timers.size, 0);
  const stable = JSON.stringify(fixture.observer.snapshot(fixture.host)); fixture.message(); fixture.binding('heartbeat', { ticks: 999 });
  assert.equal(JSON.stringify(fixture.observer.snapshot(fixture.host)), stable);
  const early = await nativeCdpFixture({ failArm: true }); await early.observer.dispose();
  assert.equal(early.observer.snapshot().arm, 'unavailable'); assert.match(early.observer.snapshot().issues[0].message, /original CDP arm error/);
  assert.equal([...early.handlers.values()].reduce((count, entries) => count + entries.size, 0), 0);
});

test('renderer evaluates only the failed exact context after stalled heartbeats and bounds a hung evaluation and incomplete cleanup', async () => {
  const fixture = await nativeCdpFixture(); await fixture.attach(); fixture.context(7, 'unique'); fixture.binding('installed'); fixture.message();
  fixture.host.records.push({ ...fixture.host.records[0], sourceGeneration: 2, reloadRequestId: 'gen2' });
  fixture.binding('heartbeat', { ticks: 4, maxGapMs: 250 });
  assert.equal((await fixture.observer.afterFailedFirstResult(fixture.host, false)).status, 'not-requested');
  assert.equal((await fixture.observer.afterFailedFirstResult(fixture.host, true)).status, 'not-requested');
  assert.equal(fixture.calls.some(call => call.params?.expression === '1'), false);
  fixture.setClock(5000);
  const originalSend = fixture.client.send;
  let finishProbe;
  fixture.client.send = (method, params, sessionId) => {
    if (method === 'Runtime.evaluate' && params.expression === '1') {
      assert.equal(params.uniqueContextId, 'unique'); assert.equal(sessionId, 'session');
      return new Promise(resolve => { finishProbe = resolve; });
    }
    if (method === 'Runtime.evaluate' && params.expression.includes('dispose()')) return Promise.resolve({ result: { value: false } });
    return originalSend(method, params, sessionId);
  };
  const pending = fixture.observer.afterFailedFirstResult(fixture.host, true);
  const deadline = [...fixture.timers.values()].find(timer => timer.delay === 2000); assert.ok(deadline); deadline.callback();
  assert.equal((await pending).status, 'timeout');
  const final = await fixture.observer.dispose();
  assert.equal(final.cleanup.pendingContexts.length, 1); assert.equal(final.cleanup.hostShutdownRequired, true);
  assert.equal(final.cleanup.preloadsRemoved, true); assert.equal(final.cleanup.bindingsRemoved, true);
  const stable = JSON.stringify(fixture.observer.snapshot(fixture.host)); finishProbe({ result: { value: 1 } }); await Promise.resolve();
  assert.equal(JSON.stringify(fixture.observer.snapshot(fixture.host)), stable);
  assert.equal([...fixture.handlers.values()].reduce((count, entries) => count + entries.size, 0), 0);
});

test('native activation diagnostic composed result inspection preserves verdict and cleanup ordering without closing pending native opens', async () => {
  const source = nativeOpenFeatureSource().replaceAll('\r\n', '\n');
  const installStart = source.indexOf('observer = createNativeOpenObserver('), installEnd = source.indexOf('let lastBeat =', installStart);
  const tailStart = source.indexOf('        } catch (error) {\n          outcome.errors.push'), tailEnd = source.indexOf('\n        return outcome;', tailStart);
  assert.ok(installStart > 0 && installEnd > installStart && tailStart > installEnd && tailEnd > tailStart);
  for (const { nativePending, passed, inspectionMode } of [
    { nativePending: false, passed: false }, { nativePending: true, passed: false },
    { nativePending: false, passed: true }, { nativePending: false, passed: true, inspectionMode: 'missing' },
    { nativePending: false, passed: false, inspectionMode: 'throws' },
  ]) {
    const host = nativeOpenFixture(), cdp = await nativeCdpFixture({ failArm: true, arm: false });
    let closes = 0, inspections = 0, resolveNative;
    const first = new Error('original public first failure');
    const outcome = { classification: 'RUNNING', productVerdict: 'NOT_RUN', errors: [], checks: {}, helperSha256: 'hash', archiveSha256: 'hash',
      calls: [{ index: 101, pending: false, value: passed ? { success: true } : { success: false, error: first.message }, uri: host.uri.toString() }] };
    const inspectRealms = cdp.observer.inspectRealms.bind(cdp.observer);
    cdp.observer.inspectRealms = inspectionMode === 'missing' ? undefined : async () => {
      inspections++; assert.equal(closes, 0); assert.equal(outcome.rendererAtVerdict.binding, null);
      assert.equal(outcome.productVerdict, passed ? 'PASS' : 'FIRST_RESULT_OR_PRESERVATION_FAILED');
      if (inspectionMode === 'throws') throw new Error('inspection must not replace first failure');
      return inspectRealms();
    };
    const context = createContext({ assert, outcome, process: { env: { KW_NATIVE_OPEN_CDP_PORT: '59442', APPDATA: process.env.APPDATA }, getBuiltinModule: process.getBuiltinModule.bind(process) },
      modules: { createRequire: () => () => cdp.CDP }, path, performance: { now: () => 1 }, phase: 'first-open-101-custom', observer: undefined, renderer: undefined,
      createNativeOpenObserver: () => host.observer, createNativeRendererObserver: () => cdp.observer, scoped: host.facade,
      references: new Map([[host.uri.toString(), { index: 101 }]]), initialDocuments: new Map(), hasPendingNativeOpen: snapshot => snapshot?.pending.some(entry => entry.kind === 'commands.openWith'),
      first, passed, startPending() { host.behavior.result = new Promise(resolve => { resolveNative = resolve; }); host.facade.commands.executeCommand('vscode.openWith', host.uri, 'default'); },
      nativePendingRequested: nativePending, checkpointTimer: undefined, heartbeatTimer: undefined, clearTimeout, clearInterval, pendingCall: undefined, exitListener: undefined,
      owner: {}, helper: { closeAcceptanceTabs: async () => { closes++; return { survivors: 0 }; } }, vscode: {}, preserve: () => {}, manifest: undefined,
      fs: { readFileSync: () => '' }, hash: () => 'hash', archive: 'archive', write: () => {},
    });
    await new Script('(async () => { try { ' + source.slice(installStart, installEnd) + ' if (nativePendingRequested) startPending(); if (!passed) throw first; outcome.productVerdict = "PASS"; outcome.classification = "PASS"; ' + source.slice(tailStart, tailEnd) + ' })()').runInContext(context);
    if (passed) assert.equal(outcome.errors.length, 0);
    else { assert.equal(outcome.errors[0].message, first.message); assert.equal(outcome.calls[0].value.error, first.message); }
    assert.equal(outcome.productVerdict, passed ? 'PASS' : 'FIRST_RESULT_OR_PRESERVATION_FAILED');
    assert.equal(outcome.classification, nativePending ? 'DIAGNOSTIC_INTERRUPTED' : passed ? 'PASS' : 'FIRST_OPEN_OR_PRESERVATION_FAILED');
    assert.equal(inspections, inspectionMode === 'missing' ? 0 : 1);
    assert.equal(outcome.rendererRealmInspection.status, inspectionMode === 'missing' ? 'unavailable' : inspectionMode === 'throws' ? 'failed' : 'inspected');
    assert.equal(closes, nativePending ? 0 : 1); assert.equal(outcome.observationFlags.incomplete, true);
    assert.ok(outcome.renderer.issues.some(entry => entry.message === 'original CDP arm error'));
    assert.equal(host.listeners.size, 0); assert.equal(outcome.observer.retired, true);
    assert.equal([...cdp.handlers.values()].reduce((count, entries) => count + entries.size, 0), 0);
    const stable = JSON.stringify(host.observer.snapshot()); resolveNative?.(); await Promise.resolve(); assert.equal(JSON.stringify(host.observer.snapshot()), stable);
  }
  const requiredOrder = ['observer.install();', 'await renderer.arm();', 'await extension.activate();', 'await vscode.lm.invokeTool(', 'outcome.rendererAtVerdict =', 'renderer?.inspectRealms?.()', 'renderer?.afterFailedFirstResult(', 'helper.closeAcceptanceTabs(', 'await renderer?.dispose();', 'observer?.restore()'];
  for (let index = 1; index < requiredOrder.length; index++) assert.ok(source.indexOf(requiredOrder[index - 1]) < source.indexOf(requiredOrder[index]), requiredOrder[index]);
});

const typeSpecSlice = (start, end, source = typeSpecFeatureSource()) => {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'Missing actual TypeSpec block: ' + start);
  return source.slice(first, last);
};
test('TypeSpec actual Code identity admits the original manifest without optional code metadata', () => {
  const appRoot = path.resolve(os.tmpdir(), 'typespec-owned-code', 'resources', 'app');
  const execPath = path.resolve(appRoot, '..', '..', 'Code.exe');
  const commit = '2d0b'.padEnd(40, '0');
  const executable = Buffer.from('owned Code executable fixture');
  const files = new Map([
    [path.join(appRoot, 'product.json'), Buffer.from(JSON.stringify({ commit }))],
    [path.join(appRoot, 'package.json'), Buffer.from(JSON.stringify({ version: '1.143.0' }))],
    [execPath, executable],
  ]);
  const allowedPaths = new Set(files.keys());
  const reads = [];
  const canonicalPath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const context = createContext({ assert, path, canonicalPath, manifest: {}, outcome: { checks: {}, errors: [] },
    hash: value => createHash('sha256').update(value).digest('hex'),
    fs: { readFileSync(file, encoding) {
      assert.ok(allowedPaths.has(file), 'Unexpected actual Code read: ' + file);
      assert.ok(files.has(file), 'Missing actual Code metadata: ' + file);
      reads.push(file);
      return encoding ? files.get(file).toString(encoding) : files.get(file);
    } },
    process: { execPath, env: {}, version: 'v24.0.0', versions: {}, pid: 1, ppid: 2 },
    vscode: { version: '1.143.0', env: { appRoot, logLevel: 1 } }, extension: { packageJSON: { version: 'test' } },
  });
  new Script(typeSpecSlice('const readActualCodeIdentity =', 'const readArchive =')).runInContext(context);
  const admission = new Script(typeSpecSlice('outcome.actualCode = readActualCodeIdentity();', 'helperPath = path.join'));
  assert.doesNotThrow(() => admission.runInContext(context), 'Absent optional manifest.code must admit valid independently observed Code identity');
  assert.equal(context.outcome.runtime.codeCommit, commit);
  assert.equal(context.outcome.runtime.codeSha256, createHash('sha256').update(executable).digest('hex'));
  assert.deepEqual(reads, [...allowedPaths]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.outcome.actualCode)), {
    version: '1.143.0', commit, codeBytes: executable.length, codeSha256: context.outcome.runtime.codeSha256,
    execPath: canonicalPath(execPath), appRoot: canonicalPath(appRoot), productPath: canonicalPath(path.join(appRoot, 'product.json')), packagePath: canonicalPath(path.join(appRoot, 'package.json')),
  });
  const expectedCode = { commit, codeBytes: executable.length, codeSha256: context.outcome.runtime.codeSha256 };
  for (const code of [expectedCode, { ...expectedCode, version: '1.143.0' }]) {
    context.manifest = { code };
    assert.doesNotThrow(() => admission.runInContext(context), 'Legacy complete expectations need not include version');
  }
  for (const code of [undefined, null, {}, [], { commit }, { ...expectedCode, commit: 'bad' }, { ...expectedCode, commit: 'a'.repeat(40) },
    { ...expectedCode, codeSha256: 'bad' }, { ...expectedCode, codeSha256: 'a'.repeat(64) }, { ...expectedCode, codeBytes: 0 },
    { ...expectedCode, codeBytes: executable.length + 1 }, { ...expectedCode, version: undefined }, { ...expectedCode, version: '1.142.0' },
    ...Object.keys(expectedCode).map(key => { const code = { ...expectedCode }; delete code[key]; return code; })]) {
    context.manifest = { code };
    assert.throws(() => admission.runInContext(context), 'Present incomplete or mismatched Code expectations must fail');
  }
  context.manifest = {};
  for (const [file, replacement] of [
    ...[...allowedPaths].map(file => [file, undefined]),
    [path.join(appRoot, 'product.json'), Buffer.from(JSON.stringify({ commit: '' }))],
    [path.join(appRoot, 'package.json'), Buffer.from(JSON.stringify({ version: '1.142.0' }))], [execPath, Buffer.alloc(0)],
  ]) {
    const original = files.get(file);
    try {
      if (replacement === undefined) files.delete(file); else files.set(file, replacement);
      assert.throws(() => admission.runInContext(context), 'Absent expectations must not bypass actual metadata validation');
    } finally { files.set(file, original); }
  }
  admission.runInContext(context);
  const preservation = new Script(typeSpecSlice('if (outcome.actualCode) {', '\n          } finally {'));
  preservation.runInContext(context);
  assert.equal(context.outcome.checks.actualCode, true);
  assert.deepEqual(context.outcome.afterActualCode, context.outcome.actualCode);
  for (const [file, replacement] of [
    [path.join(appRoot, 'product.json'), Buffer.from(JSON.stringify({ commit: 'b'.repeat(40) }))],
    [execPath, Buffer.alloc(executable.length, 1)], [execPath, Buffer.concat([executable, Buffer.from('changed')])],
    [path.join(appRoot, 'package.json'), Buffer.from(JSON.stringify({ version: '1.142.0' }))],
  ]) {
    const original = files.get(file);
    try {
      files.set(file, replacement);
      context.outcome.errors.length = 0;
      preservation.runInContext(context);
      assert.equal(context.outcome.checks.actualCode, false, 'Mid-run Code identity drift must block qualification');
      assert.equal(context.outcome.errors[0].phase, 'code-identity-preservation');
    } finally { files.set(file, original); }
  }
});

test('TypeSpec guard contract fingerprints the executing local function independently of trial and source test files', async () => {
  const feature = typeSpecFeatureSource();
  const expression = [...feature.matchAll(/"""\r?\n([\s\S]*?)\r?\n\s*"""/g)][0][1].trim();
  const hashes = [];
  for (const source of [expression, expression.replace('panelRecords.length === 128', 'panelRecords.length === 127'), expression.replace('metadata.version > 0', 'metadata.version > 1'), expression.replace('bytes.length, 54487', 'bytes.length, 54488')]) {
    const expected = createHash('sha256').update(Function.prototype.toString.call(new Script(source.slice(0, -2)).runInNewContext())).digest('hex');
    for (const trial of ['standalone', 'prefix100-103']) {
      let reads = 0;
      const outcome = await new Script(source).runInNewContext({ performance, Buffer, TextDecoder, console,
        process: { platform: process.platform, env: { KW_TYPESPEC_TRIAL: trial, KW_TYPESPEC_FROZEN_MANIFEST: 'memory-only-manifest', KW_TYPESPEC_PRESET_ONLY: '1' },
          getBuiltinModule: name => name === 'node:fs' ? { readFileSync(file) { assert.equal(file, 'memory-only-manifest'); reads++; throw new Error('known fingerprint boundary'); } } : process.getBuiltinModule(name) },
        vscode: { version: '1.143.0', LogLevel: { Trace: 1 }, env: { logLevel: 1 }, extensions: { getExtension: () => ({ isActive: false }) },
          window: { tabGroups: { all: [] } }, workspace: { textDocuments: [], workspaceFolders: [] } },
      });
      assert.equal(reads, 1);
      assert.equal(outcome.classification, 'SETUP_BLOCKED');
      assert.match(outcome.errors[0].message, /known fingerprint boundary/);
      assert.deepEqual(JSON.parse(JSON.stringify(outcome.guardContract)), { version: 'typespec-dispatcher-v3', scriptSha256: expected });
      hashes.push(outcome.guardContract.scriptSha256);
    }
  }
  assert.equal(new Set(hashes).size, 4, 'Observer, eligibility and scenario guards must all affect the runtime fingerprint');
  for (let index = 0; index < hashes.length; index += 2) assert.equal(hashes[index], hashes[index + 1]);
  assert.doesNotMatch(feature, /nodeGuardContract|testSha256|featureSha256/);
  assert.match(feature, /guardContract: outcome\.guardContract, helperSha256: outcome\.helperSha256, actualCode: outcome\.actualCode, afterActualCode: outcome\.afterActualCode/);
});
const typeSpecObserverFactory = () => new Script('(() => { ' + typeSpecSlice('const createTypeSpecDispatcherObserver =', 'const readSetting =') + '; return createTypeSpecDispatcherObserver; })()').runInNewContext({ process, Promise, setTimeout, clearTimeout });
const dispatcherFixture = (timerHooks = {}) => {
  const uri = 'file:///owned/typespec.kqlx';
  const references = new Map([[uri, { index: 104 }]]);
  const calls = { register: [], resolve: [], post: [], routed: [] };
  const behavior = { postResult: true, resolveResult: Promise.resolve('original'), registerResult: {}, phase: 'first-activation-104', ticks: 0 };
  const listeners = new Map();
  const makePanel = () => {
    const callbacks = new Set();
    let subscriptions = 0;
    const panel = { webview: {
      onDidReceiveMessage(callback) {
        const observerListener = subscriptions++ === 0;
        callbacks.add(callback);
        return { dispose() { callbacks.delete(callback); if (observerListener && behavior.disposeThrow) throw behavior.disposeThrow; } };
      },
      postMessage(...args) {
        calls.post.push({ receiver: this, args });
        if (behavior.postThrow) throw behavior.postThrow;
        return behavior.postResult;
      },
    } };
    listeners.set(panel, callbacks);
    return panel;
  };
  const panel = makePanel();
  const provider = { resolveCustomTextEditor(...args) {
    calls.resolve.push({ receiver: this, args });
    args[1].webview.onDidReceiveMessage(message => calls.routed.push(message));
    if (behavior.resolveThrow) throw behavior.resolveThrow;
    return behavior.resolveResult;
  } };
  const facade = { window: { registerCustomEditorProvider(...args) {
    calls.register.push({ receiver: this, args });
    if (behavior.registerThrow) throw behavior.registerThrow;
    return behavior.registerResult;
  } } };
  const originals = [
    [facade.window, 'registerCustomEditorProvider'], [provider, 'resolveCustomTextEditor'], [panel.webview, 'postMessage'],
  ].map(([target, key]) => ({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) }));
  const observer = typeSpecObserverFactory()({ references, getPhase: () => behavior.phase, clock: () => ++behavior.ticks, ...timerHooks });
  const register = () => facade.window.registerCustomEditorProvider('kusto.kqlxEditor', provider, behavior);
  const resolve = (target = panel, targetUri = uri) => provider.resolveCustomTextEditor({ uri: { toString: () => targetUri } }, target, behavior);
  const emit = (message, target = panel) => { for (const listener of [...listeners.get(target)]) listener(message); };
  const assertRestored = () => { for (const { target, key, descriptor } of originals) assert.deepEqual(Object.getOwnPropertyDescriptor(target, key), descriptor); };
  return { uri, references, behavior, calls, facade, panel, provider, observer, register, resolve, emit, makePanel, listeners, originals, assertRestored };
};

test('TypeSpec dispatcher observer drains already-issued native promises before restoring without changing SDK results', async () => {
  const timers = new Map();
  const fixture = dispatcherFixture({ setTimer(callback, delay) { assert.equal(delay, 2000); timers.set(1, callback); return 1; }, clearTimer(id) { timers.delete(id); } });
  fixture.observer.install(fixture.facade); fixture.register(); fixture.resolve();
  const pending = Promise.withResolvers(); fixture.behavior.postResult = pending.promise;
  assert.equal(fixture.panel.webview.postMessage({ type: 'kustoPublicationCommit' }), pending.promise);
  let completed = false;
  try {
    const drain = fixture.observer.waitForPendingPosts(); drain.then(() => { completed = true; });
    await Promise.resolve(); assert.equal(completed, false); assert.equal(timers.size, 1);
    pending.resolve(true);
    const result = await drain;
    assert.equal(result.status, 'settled'); assert.equal(result.initialPending, 1); assert.equal(result.remainingPending, 0); assert.equal(result.timedOut, false);
    assert.equal(timers.size, 0); assert.equal(fixture.observer.restore().complete, true);
  } finally { fixture.observer.restore(); fixture.assertRestored(); }
});

test('TypeSpec dispatcher drain keeps one deadline across new posts, late settlement and restoration', async () => {
  for (const terminal of ['timeout', 'restore']) {
    const timers = new Map(); let allocated = 0;
    const fixture = dispatcherFixture({ setTimer(callback, delay) { assert.equal(delay, 2000); timers.set(++allocated, callback); return allocated; }, clearTimer(id) { timers.delete(id); } });
    fixture.observer.install(fixture.facade); fixture.register(); fixture.resolve();
    const first = Promise.withResolvers(), later = Promise.withResolvers();
    fixture.behavior.postResult = first.promise; fixture.panel.webview.postMessage({ type: 'kustoPublicationCommit' });
    const drain = fixture.observer.waitForPendingPosts(); assert.equal(fixture.observer.waitForPendingPosts(), drain);
    fixture.behavior.postResult = later.promise; fixture.panel.webview.postMessage({ type: 'documentData' });
    first.resolve(false); await first.promise; assert.equal(timers.size, 1); assert.equal(allocated, 1);
    if (terminal === 'timeout') [...timers.values()][0](); else fixture.observer.restore();
    const result = await drain;
    assert.equal(result.status, terminal === 'timeout' ? 'timeout' : 'retired'); assert.equal(result.remainingPending, 1); assert.equal(timers.size, 0);
    const stable = JSON.stringify(result); later.resolve(true); await later.promise;
    assert.equal(JSON.stringify(result), stable); assert.equal(fixture.observer.waitForPendingPosts(), drain);
    const final = fixture.observer.restore(); assert.equal(final.pendingAtRestore, terminal === 'timeout' ? 0 : 1);
    assert.equal(result.timedOut, terminal === 'timeout'); fixture.assertRestored();
  }
});

test('TypeSpec dispatcher drain observes native outcomes without consuming a custom thenable', async () => {
  for (const outcome of ['true', 'false', 'reject', 'foreign', 'custom']) {
    const fixture = dispatcherFixture(); fixture.observer.install(fixture.facade); fixture.register(); fixture.resolve();
    let reads = 0;
    const result = outcome === 'custom' ? Object.defineProperty({}, 'then', { get() { reads++; throw new Error('Do not consume'); } })
      : outcome === 'foreign' ? new Script('Promise.resolve(true)').runInNewContext()
        : outcome === 'reject' ? Promise.reject(new Error('original SDK rejection')) : Promise.resolve(outcome === 'true');
    fixture.behavior.postResult = result; assert.equal(fixture.panel.webview.postMessage({ type: 'documentData' }), result);
    assert.equal((await fixture.observer.waitForPendingPosts()).status, 'settled'); assert.equal(reads, 0);
    const final = fixture.observer.restore(); assert.equal(final.pendingAtRestore, 0); assert.equal(final.complete, outcome !== 'custom');
    if (outcome === 'reject') await assert.rejects(result, /original SDK rejection/);
    fixture.assertRestored();
  }
});

test('TypeSpec dispatcher observer captures state response status without retaining errors or section payloads', () => {
  const fixture = dispatcherFixture(); fixture.observer.install(fixture.facade); fixture.register(); fixture.resolve();
  const cases = [
    [{ sections: [] }, false, 0], [{ error: undefined, sections: [{}] }, false, 1],
    [{ error: '', sections: [] }, false, 0], [{ error: ' ', sections: [] }, true, 0],
    [{ error: 'private-error'.repeat(100), sections: [{ query: 'private-query' }] }, true, 1],
    [{ error: 7, sections: [] }, undefined, 0], [{ error: 'failed', sections: {} }, true, undefined],
    [{}, false, undefined],
  ];
  for (const [fields, hasError, sectionCount] of cases) {
    const message = { type: 'toolStateResponse', requestId: 'same-request', hasError: 'spoof', sectionCount: 'spoof', ...fields };
    fixture.emit(message);
    const entry = fixture.observer.snapshot().records.at(-1);
    assert.equal(entry.type, 'toolStateResponse'); assert.equal(entry.hasError, hasError); assert.equal(entry.sectionCount, sectionCount);
    assert.equal(Object.hasOwn(entry, 'hasError'), hasError !== undefined); assert.equal(Object.hasOwn(entry, 'sectionCount'), sectionCount !== undefined);
    assert.equal(Object.hasOwn(entry, 'error'), false); assert.equal(Object.hasOwn(entry, 'sections'), false);
    assert.equal(fixture.calls.routed.at(-1), message);
  }
  assert.equal(fixture.observer.snapshot().records.length, cases.length, 'Status changes cannot merge lifecycle records');
  assert.equal(JSON.stringify(fixture.observer.snapshot()).includes('private-'), false);
  assert.equal(fixture.observer.restore().complete, true); fixture.assertRestored();
});

test('TypeSpec state response metadata avoids inherited, accessor, proxy and array-content traps', () => {
  for (const shape of ['error-getter', 'sections-getter', 'inherited-error', 'inherited-sections', 'inherited-type', 'proxy-prototype', 'live-proxy', 'revoked-proxy', 'array-proxy', 'revoked-array-proxy', 'sparse-array']) {
    const fixture = dispatcherFixture(); fixture.observer.install(fixture.facade); fixture.register(); fixture.resolve();
    let reads = 0;
    const forbidden = () => { reads++; throw new Error('Payload must remain unread'); };
    const traps = { get: forbidden, getOwnPropertyDescriptor: forbidden, getPrototypeOf: forbidden, ownKeys: forbidden, has: forbidden };
    let message = { type: 'toolStateResponse', requestId: 'exact', sections: [], hasError: true, sectionCount: 99 };
    let expectedError = false, expectedCount = 0;
    if (shape === 'error-getter') { Object.defineProperty(message, 'error', { get: forbidden }); expectedError = undefined; }
    if (shape === 'sections-getter') { Object.defineProperty(message, 'sections', { get: forbidden }); expectedCount = undefined; }
    if (shape === 'inherited-error') { Object.setPrototypeOf(message, { error: 'not-owned' }); expectedError = undefined; }
    if (shape === 'inherited-sections') { delete message.sections; Object.setPrototypeOf(message, { sections: [] }); expectedError = undefined; expectedCount = undefined; }
    if (shape === 'inherited-type') { delete message.type; Object.setPrototypeOf(message, { type: 'toolStateResponse' }); expectedError = undefined; expectedCount = undefined; }
    if (shape === 'proxy-prototype') { Object.setPrototypeOf(message, new Proxy({}, traps)); expectedError = undefined; }
    if (shape === 'live-proxy' || shape === 'revoked-proxy') { const wrapper = Proxy.revocable(message, traps); message = wrapper.proxy; if (shape === 'revoked-proxy') wrapper.revoke(); }
    if (shape === 'array-proxy' || shape === 'revoked-array-proxy') { const wrapper = Proxy.revocable([], traps); message.sections = wrapper.proxy; if (shape === 'revoked-array-proxy') wrapper.revoke(); expectedCount = undefined; }
    if (shape === 'sparse-array') {
      message.sections = new Array(1000000); expectedCount = 1000000;
      for (const key of ['0', 'toJSON', Symbol.iterator]) Object.defineProperty(message.sections, key, { get: forbidden });
    }
    fixture.emit(message);
    assert.equal(fixture.calls.routed[0], message); assert.equal(reads, 0, shape);
    const records = fixture.observer.snapshot().records;
    if (shape === 'live-proxy' || shape === 'revoked-proxy') assert.equal(records.length, 0);
    else {
      assert.equal(records.length, 1); assert.equal(records[0].hasError, expectedError, shape); assert.equal(records[0].sectionCount, expectedCount, shape);
      assert.equal(Object.hasOwn(records[0], 'hasError'), expectedError !== undefined); assert.equal(Object.hasOwn(records[0], 'sectionCount'), expectedCount !== undefined);
      assert.equal(Object.hasOwn(records[0], 'error'), false); assert.equal(Object.hasOwn(records[0], 'sections'), false);
    }
    fixture.observer.restore(); fixture.assertRestored(); assert.equal(reads, 0);
  }
});

for (const enumerable of [true, false]) for (const extensible of [true, false]) test(`TypeSpec dispatcher observer wraps writable non-configurable own postMessage (enumerable=${enumerable}, extensible=${extensible})`, async () => {
  const fixture = dispatcherFixture();
  const { observer, behavior, panel, calls } = fixture;
  const original = fixture.originals.find(entry => entry.target === panel.webview);
  original.descriptor = { ...original.descriptor, configurable: false, writable: true, enumerable };
  Object.defineProperty(panel.webview, 'postMessage', original.descriptor);
  if (!extensible) Object.preventExtensions(panel.webview);
  try {
    observer.install(fixture.facade);
    assert.equal(fixture.register(), behavior.registerResult);
    assert.equal(fixture.resolve(), behavior.resolveResult);
    assert.equal(observer.snapshot().panels[0].postWrapped, true, 'Writable non-configurable own postMessage must be wrapped');
    const patched = Object.getOwnPropertyDescriptor(panel.webview, 'postMessage');
    assert.equal(typeof patched.value, 'function');
    assert.notEqual(patched.value, original.descriptor.value);
    assert.deepEqual({ ...patched, value: original.descriptor.value }, original.descriptor);
    assert.equal(Object.isExtensible(panel.webview), extensible);
    const message = { type: 'mainWebviewDispatcherProbe', probeId: 'writable-own', sourceGeneration: 2 };
    const transfers = [];
    const pending = Promise.withResolvers();
    behavior.postResult = pending.promise;
    assert.equal(panel.webview.postMessage(message, transfers), pending.promise);
    assert.equal(calls.post.length, 1);
    assert.equal(observer.snapshot().records[0].attempts, 1);
    assert.equal(observer.snapshot().records[0].pending, 1);
    const ready = { type: 'mainWebviewDispatcherReady', probeId: 'writable-own', runtimeId: 'runtime' };
    fixture.emit(ready);
    assert.equal(calls.routed[0], ready);
    assert.equal(observer.snapshot().records[1].readyBeforeSettlement, 1);
    pending.resolve(true);
    await pending.promise;
    assert.equal(observer.snapshot().records[0].successTrue, 1);
    behavior.postResult = false;
    assert.equal(panel.webview.postMessage(message, transfers), false);
    let forbiddenReads = 0;
    const failure = Object.defineProperties({}, {
      message: { get() { forbiddenReads++; throw new Error('Do not inspect the original error'); } },
      [Symbol.toPrimitive]: { get() { forbiddenReads++; throw new Error('Do not coerce the original error'); } },
    });
    behavior.postResult = Promise.reject(failure);
    assert.equal(panel.webview.postMessage(message, transfers), behavior.postResult);
    await assert.rejects(behavior.postResult, error => error === failure);
    assert.equal(observer.snapshot().completeCapture, true);
    const custom = Object.defineProperty({}, 'then', { get() { forbiddenReads++; throw new Error('Do not consume a custom thenable'); } });
    behavior.postResult = custom;
    assert.equal(panel.webview.postMessage(message, transfers), custom);
    behavior.postThrow = failure;
    assert.throws(() => panel.webview.postMessage(message, transfers), error => error === failure);
    assert.equal(calls.post.length, 5);
    assert.equal(calls.register.length, 1);
    assert.equal(calls.resolve.length, 1);
    for (const call of calls.post) {
      assert.equal(call.receiver, panel.webview);
      assert.equal(call.args.length, 2);
      assert.equal(call.args[0], message);
      assert.equal(call.args[1], transfers);
    }
    const result = observer.restore();
    assert.equal(result.panels[0].postWrapped, true);
    assert.equal(result.records[0].sourceGeneration, 2);
    for (const key of ['successTrue', 'successFalse', 'rejected', 'thrown', 'settlementUnavailable']) assert.equal(result.records[0][key], 1, key);
    assert.equal(result.records[0].attempts, 5);
    assert.equal(result.records[0].pending, 0);
    for (const key of ['captureFailures', 'boundaryUnavailable', 'restoreMismatch', 'restoreFailures', 'disposeFailures', 'pendingAtRestore']) assert.equal(result[key], 0, key);
    assert.equal(result.restored, true);
    assert.equal(result.complete, false, 'Custom thenables remain unobserved');
    assert.equal(forbiddenReads, 0);
    fixture.assertRestored();
  } finally { observer.restore(); }
});

for (const enumerable of [true, false]) test(`TypeSpec dispatcher observer wraps inherited postMessage without modifying its prototype (enumerable=${enumerable})`, async () => {
  const fixture = dispatcherFixture();
  const { observer, panel, behavior, calls } = fixture;
  const original = fixture.originals.find(entry => entry.target === panel.webview);
  const prototype = Object.create(Object.getPrototypeOf(panel.webview));
  Object.defineProperty(prototype, 'postMessage', { ...original.descriptor, enumerable });
  const prototypeDescriptor = Object.getOwnPropertyDescriptor(prototype, 'postMessage');
  delete panel.webview.postMessage;
  original.descriptor = undefined;
  Object.setPrototypeOf(panel.webview, prototype);
  const peer = Object.create(prototype);
  try {
    observer.install(fixture.facade);
    fixture.register();
    assert.equal(fixture.resolve(), behavior.resolveResult);
    assert.equal(observer.snapshot().panels[0].postWrapped, true);
    assert.equal(Object.hasOwn(panel.webview, 'postMessage'), true);
    assert.equal(Object.hasOwn(peer, 'postMessage'), false);
    assert.equal(peer.postMessage, prototypeDescriptor.value);
    assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'postMessage'), prototypeDescriptor);
    const pending = Promise.withResolvers();
    behavior.postResult = pending.promise;
    const message = { type: 'mainWebviewDispatcherProbe', probeId: 'inherited-method' };
    const transfers = [];
    assert.equal(panel.webview.postMessage(message, transfers), pending.promise);
    assert.equal(calls.post[0].receiver, panel.webview);
    assert.deepEqual(calls.post[0].args, [message, transfers]);
    fixture.emit({ type: 'mainWebviewDispatcherReady', probeId: message.probeId, runtimeId: 'runtime' });
    pending.resolve(true);
    await pending.promise;
    assert.equal(observer.snapshot().records[0].successTrue, 1);
    const failure = new Error('original inherited failure');
    behavior.postThrow = failure;
    assert.throws(() => panel.webview.postMessage(message), error => error === failure);
    assert.equal(observer.restore().complete, true);
    fixture.assertRestored();
    assert.equal(panel.webview.postMessage, prototypeDescriptor.value);
    assert.equal(peer.postMessage, prototypeDescriptor.value);
    assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'postMessage'), prototypeDescriptor);
  } finally { observer.restore(); }
});

test('TypeSpec dispatcher observer diagnoses denied descriptors without reading accessors at each SDK boundary', () => {
  for (const boundary of ['registration', 'provider-resolve', 'panel-post']) for (const shape of ['immutable', 'missing', 'non-function', 'getter', 'setter', 'both', 'immutable-getter', 'immutable-setter', 'immutable-both']) {
    const fixture = dispatcherFixture();
    const { observer, facade, provider, panel } = fixture;
    const [target, key, patchCount] = boundary === 'registration' ? [facade.window, 'registerCustomEditorProvider', 0] : boundary === 'provider-resolve' ? [provider, 'resolveCustomTextEditor', 1] : [panel.webview, 'postMessage', 2];
    const original = fixture.originals.find(entry => entry.target === target);
    let getterReads = 0, setterCalls = 0;
    let rejectionReason;
    if (shape === 'missing') {
      delete target[key];
      rejectionReason = 'DESCRIPTOR_MISSING';
    } else if (shape === 'immutable') {
      Object.defineProperty(target, key, { configurable: false, writable: false });
      Object.preventExtensions(target);
      rejectionReason = 'NON_CONFIGURABLE_NON_WRITABLE';
    } else if (shape === 'non-function') {
      Object.defineProperty(target, key, { value: 42 });
      rejectionReason = 'NON_FUNCTION_VALUE';
    } else {
      const descriptor = { configurable: !shape.startsWith('immutable-'), enumerable: false };
      if (shape.endsWith('getter') || shape.endsWith('both')) descriptor.get = () => { getterReads++; throw new Error('Do not read a boundary getter'); };
      if (shape.endsWith('setter') || shape.endsWith('both')) descriptor.set = () => { setterCalls++; throw new Error('Do not call a boundary setter'); };
      Object.defineProperty(target, key, descriptor);
      rejectionReason = 'ACCESSOR_DESCRIPTOR';
    }
    original.descriptor = Object.getOwnPropertyDescriptor(target, key);
    const descriptor = original.descriptor;
    observer.install(facade);
    if (boundary !== 'registration') assert.equal(fixture.register(), fixture.behavior.registerResult);
    if (boundary === 'panel-post') assert.equal(fixture.resolve(), fixture.behavior.resolveResult);
    if (shape === 'immutable') {
      if (boundary === 'registration') assert.equal(fixture.register(), fixture.behavior.registerResult);
      if (boundary === 'provider-resolve') assert.equal(fixture.resolve(), fixture.behavior.resolveResult);
      if (boundary === 'panel-post') assert.equal(panel.webview.postMessage({ type: 'documentData' }), true);
    }
    const result = observer.restore();
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.observed, false);
    assert.equal(result.complete, false);
    assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.restored, true);
    assert.equal(result.boundaryUnavailable, 1);
    for (const counter of ['captureFailures', 'boundaryDiagnosticOverflow', 'overflow', 'restoreMismatch', 'restoreFailures']) assert.equal(result[counter], 0, boundary + ':' + shape + ':' + counter);
    assert.deepEqual(JSON.parse(JSON.stringify(result.boundaryDiagnostics)), [{
      boundary, panelId: boundary === 'panel-post' ? 1 : null, descriptorFound: !!descriptor, ownerDepth: descriptor ? 0 : null,
      descriptorKind: descriptor ? Object.hasOwn(descriptor, 'value') ? 'data' : 'accessor' : 'missing',
      configurable: descriptor?.configurable ?? null, writable: descriptor?.writable ?? null,
      valueType: descriptor && Object.hasOwn(descriptor, 'value') ? typeof descriptor.value : null,
      hasGetter: typeof descriptor?.get === 'function', hasSetter: typeof descriptor?.set === 'function',
      targetExtensible: shape !== 'immutable', patchCount, rejectionReason,
    }]);
    assert.equal(getterReads, 0);
    assert.equal(setterCalls, 0);
    assert.equal(fixture.calls.register.length, boundary === 'registration' && shape !== 'immutable' ? 0 : 1);
    assert.equal(fixture.calls.resolve.length, boundary === 'panel-post' || boundary === 'provider-resolve' && shape === 'immutable' ? 1 : 0);
    assert.equal(fixture.calls.post.length, boundary === 'panel-post' && shape === 'immutable' ? 1 : 0);
    if (boundary === 'panel-post') assert.equal(fixture.listeners.get(panel).size, 1);
    fixture.assertRestored();
  }
});

test('TypeSpec dispatcher observer retains inherited admission and never patches an immutable prototype', () => {
  for (const { boundary, configurable, writable, extensible, rejectionReason } of [
    { boundary: 'provider-resolve', configurable: false, writable: true, extensible: true, rejectionReason: 'NON_CONFIGURABLE_INHERITED' },
    { boundary: 'provider-resolve', configurable: false, writable: false, extensible: true, rejectionReason: 'NON_CONFIGURABLE_INHERITED' },
    { boundary: 'provider-resolve', configurable: true, writable: true, extensible: false, rejectionReason: 'TARGET_NOT_EXTENSIBLE' },
    { boundary: 'panel-post', configurable: true, writable: true, extensible: false, rejectionReason: 'TARGET_NOT_EXTENSIBLE' },
    { boundary: 'panel-post', configurable: false, writable: true, extensible: true, rejectionReason: 'NON_CONFIGURABLE_INHERITED' },
  ]) {
    const fixture = dispatcherFixture();
    const target = boundary === 'panel-post' ? fixture.panel.webview : fixture.provider;
    const key = boundary === 'panel-post' ? 'postMessage' : 'resolveCustomTextEditor';
    const original = fixture.originals.find(entry => entry.target === target);
    const prototype = Object.create(Object.getPrototypeOf(target));
    Object.defineProperty(prototype, key, { ...original.descriptor, configurable, writable });
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    delete target[key];
    original.descriptor = undefined;
    Object.setPrototypeOf(target, prototype);
    if (!extensible) Object.preventExtensions(target);
    fixture.observer.install(fixture.facade);
    assert.equal(fixture.register(), fixture.behavior.registerResult);
    assert.equal(fixture.resolve(), fixture.behavior.resolveResult);
    assert.equal(fixture.panel.webview.postMessage({ type: 'documentData' }), true);
    const result = fixture.observer.restore();
    assert.equal(result.complete, false);
    assert.equal(result.restored, true);
    assert.equal(result.captureFailures, 0);
    assert.equal(result.boundaryUnavailable, 1);
    assert.equal(result.boundaryDiagnostics.length, 1);
    assert.equal(result.boundaryDiagnostics[0].boundary, boundary);
    assert.equal(result.boundaryDiagnostics[0].rejectionReason, rejectionReason);
    assert.equal(result.boundaryDiagnostics[0].ownerDepth, 1);
    assert.equal(result.boundaryDiagnostics[0].targetExtensible, extensible);
    assert.equal(Object.hasOwn(target, key), false);
    assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, key), descriptor);
    assert.equal(fixture.calls.register.length, 1);
    assert.equal(fixture.calls.resolve.length, 1);
    assert.equal(fixture.calls.post.length, 1);
    fixture.assertRestored();
  }
});

test('TypeSpec dispatcher observer leaves legal writable-to-readonly drift untouched during restoration', () => {
  for (const enumerable of [true, false]) {
    const fixture = dispatcherFixture();
    const { panel, observer } = fixture;
    Object.defineProperty(panel.webview, 'postMessage', { configurable: false, writable: true, enumerable });
    Object.preventExtensions(panel.webview);
    observer.install(fixture.facade);
    fixture.register();
    fixture.resolve();
    assert.equal(observer.snapshot().panels[0].postWrapped, true);
    assert.equal(panel.webview.postMessage({ type: 'documentData', sourceGeneration: 2 }), true);
    Object.defineProperty(panel.webview, 'postMessage', { writable: false });
    const external = Object.getOwnPropertyDescriptor(panel.webview, 'postMessage');
    const result = observer.restore();
    assert.equal(result.restored, false);
    assert.equal(result.restoreMismatch, 1);
    assert.equal(result.complete, false);
    assert.equal(result.completeCapture, true);
    assert.equal(result.boundaryDiagnostics.length, 0);
    for (const key of ['captureFailures', 'boundaryUnavailable', 'boundaryDiagnosticOverflow', 'restoreFailures', 'disposeFailures', 'pendingAtRestore']) assert.equal(result[key], 0, key);
    assert.deepEqual(Object.getOwnPropertyDescriptor(panel.webview, 'postMessage'), external);
    assert.equal(external.configurable, false);
    assert.equal(external.writable, false);
    assert.equal(external.enumerable, enumerable);
    for (const prior of fixture.originals.filter(entry => entry.target !== panel.webview)) assert.deepEqual(Object.getOwnPropertyDescriptor(prior.target, prior.key), prior.descriptor);
    const retained = JSON.stringify(result);
    assert.equal(panel.webview.postMessage({ type: 'documentData', sourceGeneration: 3 }), true);
    assert.equal(fixture.calls.post.length, 2);
    assert.equal(JSON.stringify(observer.snapshot()), retained);
  }
});

test('TypeSpec dispatcher observer contains reflective failures without changing SDK calls or inspecting thrown objects', () => {
  for (const operation of ['registration-descriptor', 'provider-prototype', 'panel-descriptor', 'panel-extensibility', 'panel-define', 'panel-readback']) {
    const fixture = dispatcherFixture();
    const { observer, behavior, facade, panel, calls } = fixture;
    const boundary = operation.startsWith('registration') ? 'registration' : operation.startsWith('provider') ? 'provider-resolve' : 'panel-post';
    const [target, key] = boundary === 'registration' ? [facade.window, 'registerCustomEditorProvider'] : boundary === 'provider-resolve' ? [fixture.provider, 'resolveCustomTextEditor'] : [panel.webview, 'postMessage'];
    let errorReads = 0, armed = true, written = false;
    const failure = Object.defineProperties({}, {
      message: { get() { errorReads++; throw new Error('Do not read reflection errors'); } },
      stack: { get() { errorReads++; throw new Error('Do not read reflection stacks'); } },
      [Symbol.toPrimitive]: { get() { errorReads++; throw new Error('Do not stringify reflection errors'); } },
    });
    if (operation === 'provider-prototype') {
      const original = fixture.originals.find(entry => entry.target === target);
      Object.setPrototypeOf(target, { [key]: original.descriptor.value });
      delete target[key];
      original.descriptor = undefined;
    }
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor(object, property) {
        if (armed && property === key && (operation.endsWith('descriptor') || operation === 'panel-readback' && written)) throw failure;
        return Reflect.getOwnPropertyDescriptor(object, property);
      },
      getPrototypeOf(object) { if (armed && operation === 'provider-prototype') throw failure; return Reflect.getPrototypeOf(object); },
      isExtensible(object) { if (armed && operation === 'panel-extensibility') throw failure; return Reflect.isExtensible(object); },
      defineProperty(object, property, descriptor) {
        const applied = Reflect.defineProperty(object, property, descriptor);
        written = true;
        if (armed && operation === 'panel-define') throw failure;
        return applied;
      },
    });
    if (boundary === 'registration') facade.window = proxy;
    if (boundary === 'panel-post') panel.webview = proxy;
    const provider = boundary === 'provider-resolve' ? proxy : fixture.provider;
    try {
      observer.install(facade);
      assert.equal(facade.window.registerCustomEditorProvider('kusto.kqlxEditor', provider, behavior), behavior.registerResult);
      const document = { uri: { toString: () => fixture.uri } };
      assert.equal(provider.resolveCustomTextEditor(document, panel, behavior), behavior.resolveResult);
      const message = { type: 'mainWebviewDispatcherProbe', probeId: 'reflection-failure' };
      const transfers = [];
      assert.equal(panel.webview.postMessage(message, transfers), true);
      behavior.postThrow = failure;
      assert.throws(() => panel.webview.postMessage(message, transfers), error => error === failure);
      assert.equal(calls.register.length, 1);
      assert.equal(calls.register[0].receiver, facade.window);
      assert.equal(calls.register[0].args[1], provider);
      assert.equal(calls.resolve.length, 1);
      assert.equal(calls.resolve[0].receiver, provider);
      assert.equal(calls.resolve[0].args[0], document);
      assert.equal(calls.post.length, 2);
      for (const call of calls.post) {
        assert.equal(call.receiver, panel.webview);
        assert.equal(call.args[0], message);
        assert.equal(call.args[1], transfers);
      }
      armed = false;
      const result = observer.restore();
      assert.equal(result.captureFailures, 1, operation);
      assert.equal(result.boundaryUnavailable, 1, operation);
      assert.equal(result.boundaryDiagnosticOverflow, 0);
      assert.equal(result.boundaryDiagnostics.length, 1);
      assert.equal(result.boundaryDiagnostics[0].boundary, boundary);
      assert.equal(result.boundaryDiagnostics[0].rejectionReason, 'REFLECTION_FAILED');
      assert.equal(result.restored, true);
      assert.equal(result.complete, false);
      assert.equal(result.status, 'INCOMPLETE');
      assert.equal(errorReads, 0);
      fixture.assertRestored();
    } finally { armed = false; observer.restore(); }
  }
});

test('TypeSpec dispatcher observer caps rejection diagnostics at 16 independently of 128 message records', () => {
  const fixture = dispatcherFixture();
  fixture.observer.install(fixture.facade);
  fixture.register();
  for (let index = 0; index < 17; index++) {
    const panel = index === 0 ? fixture.panel : fixture.makePanel();
    Object.defineProperty(panel.webview, 'postMessage', { configurable: false, writable: false });
    const descriptor = Object.getOwnPropertyDescriptor(panel.webview, 'postMessage');
    if (index === 0) fixture.originals[2].descriptor = descriptor;
    assert.equal(fixture.resolve(panel), fixture.behavior.resolveResult);
    assert.deepEqual(Object.getOwnPropertyDescriptor(panel.webview, 'postMessage'), descriptor);
    const snapshot = fixture.observer.snapshot();
    assert.equal(snapshot.boundaryDiagnostics.length, Math.min(index + 1, 16));
    assert.equal(snapshot.boundaryDiagnosticOverflow, index === 16 ? 1 : 0);
    assert.equal(snapshot.overflow, 0);
    assert.equal(snapshot.records.length, 0);
  }
  for (let index = 0; index < 128; index++) fixture.emit({ type: 'requestDocument', requestId: 'lifecycle-' + index });
  const result = fixture.observer.restore();
  assert.equal(result.records.length, 128);
  assert.equal(result.overflow, 0, 'Boundary diagnostics must not consume the message capacity');
  assert.equal(result.boundaryDiagnostics.length, 16);
  assert.equal(result.boundaryDiagnosticOverflow, 1);
  assert.equal(result.boundaryUnavailable, 17);
  assert.deepEqual(Array.from(result.boundaryDiagnostics, entry => entry.panelId), Array.from({ length: 16 }, (_, index) => index + 1));
  assert.ok(result.boundaryDiagnostics.every(entry => entry.boundary === 'panel-post' && entry.patchCount === 2 && entry.rejectionReason === 'NON_CONFIGURABLE_NON_WRITABLE'));
  assert.equal(result.captureFailures, 0);
  assert.equal(result.complete, false);
  assert.equal(result.completeCapture, false);
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.restored, true);
  fixture.assertRestored();
});

test('TypeSpec dispatcher observer snapshots copy every metadata array and entry and remain stable after retirement', async () => {
  const fixture = dispatcherFixture();
  const { observer, panel } = fixture;
  Object.defineProperty(panel.webview, 'postMessage', { configurable: false, writable: false });
  fixture.originals[2].descriptor = Object.getOwnPropertyDescriptor(panel.webview, 'postMessage');
  observer.install(fixture.facade);
  fixture.register();
  fixture.resolve();
  const writable = fixture.makePanel();
  fixture.resolve(writable);
  const pending = Promise.withResolvers();
  fixture.behavior.postResult = pending.promise;
  assert.equal(writable.webview.postMessage({ type: 'mainWebviewDispatcherProbe', probeId: 'pending' }), pending.promise);
  const callback = [...fixture.listeners.get(writable)][0];
  const snapshot = observer.snapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ['schemaVersion', 'registrationInstalled', 'registrationObserved', 'registrationCalls', 'captureFailures', 'boundaryUnavailable', 'boundaryDiagnosticOverflow', 'boundaryDiagnostics', 'overflow', 'truncated', 'settlementUnavailable', 'restoreMismatch', 'restoreFailures', 'disposeFailures', 'pendingAtRestore', 'restored', 'observed', 'freshPanelObserved', 'completeCapture', 'complete', 'status', 'retired', 'sequence', 'panels', 'records'].sort());
  const retained = JSON.stringify(snapshot);
  for (const key of ['boundaryDiagnostics', 'panels', 'records']) {
    snapshot[key][0].unexpected = { privateReference: true };
    snapshot[key].push({ unexpected: true });
  }
  snapshot.boundaryDiagnosticOverflow = 99;
  assert.equal(JSON.stringify(observer.snapshot()), retained);
  const restored = observer.restore();
  assert.equal(restored.pendingAtRestore, 1);
  assert.equal(restored.captureFailures, 0);
  assert.equal(restored.boundaryDiagnosticOverflow, 0);
  assert.equal(restored.restored, true);
  assert.equal(restored.complete, false);
  const final = JSON.stringify(restored);
  pending.resolve(true);
  await pending.promise;
  callback({ type: 'mainWebviewDispatcherReady', runtimeId: 'late' });
  assert.equal(JSON.stringify(restored), final);
  assert.equal(JSON.stringify(observer.snapshot()), final);
  restored.boundaryDiagnostics[0].rejectionReason = 'changed';
  restored.boundaryDiagnostics.length = 0;
  assert.equal(JSON.stringify(observer.restore()), final);
  fixture.assertRestored();
});

test('TypeSpec dispatcher observer preserves actual SDK receivers, arguments, return objects and thrown identities', () => {
  const fixture = dispatcherFixture();
  const { observer, behavior, facade, provider, panel, calls } = fixture;
  fixture.assertRestored();
  observer.install(facade);
  assert.equal(fixture.register(), behavior.registerResult);
  const originalDocument = { uri: { toString: () => fixture.uri } };
  assert.equal(provider.resolveCustomTextEditor(originalDocument, panel, behavior), behavior.resolveResult);
  assert.equal(calls.resolve[0].args[0], originalDocument);
  const message = { type: 'mainWebviewDispatcherProbe', probeId: 'probe' };
  const transfers = [];
  for (const result of [false, true]) {
    behavior.postResult = result;
    assert.equal(panel.webview.postMessage(message, transfers), result);
    assert.equal(observer.snapshot().records[0].accepted, result);
  }
  const failure = new Error('original SDK failure');
  behavior.postThrow = failure;
  assert.throws(() => panel.webview.postMessage(message, transfers), error => error === failure);
  behavior.resolveThrow = failure;
  assert.throws(() => fixture.resolve(), error => error === failure);
  behavior.registerThrow = failure;
  assert.throws(() => fixture.register(), error => error === failure);
  assert.equal(calls.register.length, 2);
  assert.equal(calls.resolve.length, 2);
  assert.equal(calls.post.length, 3);
  for (const call of calls.register) {
    assert.equal(call.receiver, facade.window);
    assert.equal(call.args[0], 'kusto.kqlxEditor');
    assert.equal(call.args[1], provider);
    assert.equal(call.args[2], behavior);
  }
  for (const call of calls.resolve) { assert.equal(call.receiver, provider); assert.equal(call.args[1], panel); assert.equal(call.args[2], behavior); }
  for (const call of calls.post) { assert.equal(call.receiver, panel.webview); assert.equal(call.args[0], message); assert.equal(call.args[1], transfers); }
  const result = observer.restore();
  assert.equal(result.complete, true);
  assert.equal(result.records[0].attempts, 3);
  assert.equal(result.records[0].successFalse, 1);
  assert.equal(result.records[0].successTrue, 1);
  assert.equal(result.records[0].thrown, 1);
  fixture.assertRestored();
});

test('TypeSpec dispatcher observer is passive before production ingress and never reads bodies or extra payload getters', () => {
  const fixture = dispatcherFixture();
  const { observer, panel, calls } = fixture;
  observer.install(fixture.facade);
  fixture.register();
  fixture.resolve();
  let forbiddenReads = 0;
  const message = { type: 'mainWebviewDispatcherReady', probeId: 'probe', runtimeId: 'runtime' };
  for (const key of ['querySecret', 'query', 'code', 'rows', 'accounts', 'state', 'toJSON']) Object.defineProperty(message, key, { enumerable: true, get() { forbiddenReads++; throw new Error('Forbidden payload getter'); } });
  for (const key of ['html', 'state', 'getState']) Object.defineProperty(panel.webview, key, { get() { forbiddenReads++; throw new Error('Forbidden webview state getter'); } });
  const callbacks = [...fixture.listeners.get(panel)];
  assert.equal(callbacks.length, 2);
  callbacks[0](message);
  assert.equal(observer.snapshot().records[0].type, message.type);
  assert.equal(calls.routed.length, 0);
  callbacks[1](message);
  assert.equal(calls.routed[0], message);
  assert.equal(calls.post.length, 0, 'The observer emits no probes or acknowledgements');
  assert.equal(forbiddenReads, 0);
  const result = observer.restore();
  assert.equal(result.complete, true);
  assert.equal(fixture.listeners.get(panel).size, 1);
  for (const key of ['querySecret', 'query', 'code', 'rows', 'accounts', 'state']) assert.equal(Object.hasOwn(result.records[0], key), false);
  assert.equal(forbiddenReads, 0);
  const failedCapture = dispatcherFixture();
  failedCapture.observer.install(failedCapture.facade);
  failedCapture.register();
  failedCapture.resolve();
  Object.defineProperty(failedCapture.behavior, 'ticks', { get() { throw new Error('Observation clock failed'); } });
  assert.equal(failedCapture.panel.webview.postMessage({ type: 'mainWebviewDispatcherProbe', probeId: 'unobserved' }), true);
  failedCapture.emit(message);
  assert.equal(failedCapture.calls.post.length, 1);
  assert.equal(failedCapture.calls.routed[0], message);
  const incomplete = failedCapture.observer.restore();
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.captureFailures, 2);
  failedCapture.assertRestored();
});

test('TypeSpec dispatcher observer observes native Promise settlements without consuming custom thenables', async () => {
  const fixture = dispatcherFixture();
  const { observer, behavior, panel } = fixture;
  observer.install(fixture.facade);
  fixture.register();
  fixture.resolve();
  const pending = Promise.withResolvers();
  behavior.postResult = pending.promise;
  assert.equal(panel.webview.postMessage({ type: 'mainWebviewDispatcherProbe', probeId: 'pending' }), pending.promise);
  fixture.emit({ type: 'mainWebviewDispatcherReady', probeId: 'pending', runtimeId: 'runtime' });
  const ready = observer.snapshot().records.find(record => record.type === 'mainWebviewDispatcherReady');
  assert.equal(ready.pendingAtReceive, 1);
  assert.equal(ready.readyBeforeSettlement, 1);
  pending.resolve(true);
  await pending.promise;
  const crossRealm = new Script('Promise.resolve(false)').runInNewContext();
  behavior.postResult = crossRealm;
  assert.equal(panel.webview.postMessage({ type: 'documentData', reloadRequestId: 'reload', sourceGeneration: 1, viewSessionId: 'session' }), crossRealm);
  await crossRealm;
  const rejection = new Error('original native rejection');
  const rejected = Promise.reject(rejection);
  behavior.postResult = rejected;
  assert.equal(panel.webview.postMessage({ type: 'documentData', reloadRequestId: 'rejected' }), rejected);
  await assert.rejects(rejected, error => error === rejection);
  let thenReads = 0;
  const custom = Object.defineProperty({}, 'then', { get() { thenReads++; throw new Error('Do not consume a thenable getter'); } });
  behavior.postResult = custom;
  assert.equal(panel.webview.postMessage({ type: 'documentData', reloadRequestId: 'custom' }), custom);
  const result = observer.restore();
  const probe = result.records.find(record => record.probeId === 'pending' && record.direction === 'post');
  assert.equal(probe.successTrue, 1);
  assert.ok(probe.firstSettledOrder > ready.firstOrder);
  assert.equal(result.records.find(record => record.reloadRequestId === 'reload').successFalse, 1);
  assert.equal(result.records.find(record => record.reloadRequestId === 'rejected').rejected, 1);
  assert.equal(result.settlementUnavailable, 1);
  assert.equal(result.complete, false);
  assert.equal(thenReads, 0);
  assert.equal(fixture.calls.post.length, 4);
  for (const key of ['captureFailures', 'boundaryUnavailable', 'boundaryDiagnosticOverflow', 'overflow', 'truncated', 'restoreMismatch', 'restoreFailures', 'disposeFailures', 'pendingAtRestore']) assert.equal(result[key], 0, key);
  fixture.assertRestored();
});

test('TypeSpec dispatcher observer keeps actual same-URI panels separate, deduplicates hooks and ignores foreign panels', () => {
  const fixture = dispatcherFixture();
  const { observer, provider, facade } = fixture;
  observer.install(facade);
  fixture.register();
  const wrappedResolve = provider.resolveCustomTextEditor;
  fixture.register();
  assert.equal(provider.resolveCustomTextEditor, wrappedResolve);
  fixture.resolve();
  const wrappedPost = fixture.panel.webview.postMessage;
  fixture.resolve();
  assert.equal(fixture.panel.webview.postMessage, wrappedPost);
  assert.equal(fixture.listeners.get(fixture.panel).size, 3, 'One observer plus two real provider subscriptions');
  const second = fixture.makePanel();
  fixture.resolve(second);
  const outsider = fixture.makePanel();
  const foreignPost = Object.getOwnPropertyDescriptor(outsider.webview, 'postMessage');
  fixture.resolve(outsider, 'file:///foreign/other.kqlx');
  assert.deepEqual(Object.getOwnPropertyDescriptor(outsider.webview, 'postMessage'), foreignPost);
  assert.equal(fixture.listeners.get(outsider).size, 1);
  const foreignProvider = { resolveCustomTextEditor: () => 'foreign' };
  const foreignResolve = Object.getOwnPropertyDescriptor(foreignProvider, 'resolveCustomTextEditor');
  assert.equal(facade.window.registerCustomEditorProvider('foreign.editor', foreignProvider), fixture.behavior.registerResult);
  assert.deepEqual(Object.getOwnPropertyDescriptor(foreignProvider, 'resolveCustomTextEditor'), foreignResolve);
  fixture.emit({ type: 'mainWebviewDispatcherReady', runtimeId: 'first' });
  fixture.emit({ type: 'mainWebviewDispatcherReady', runtimeId: 'second' }, second);
  const result = observer.restore();
  assert.equal(result.complete, true);
  assert.deepEqual(Array.from(result.panels, panel => [panel.panelId, panel.resolveCalls, panel.uriClassification]), [[1, 2, 'typespec-target'], [2, 1, 'typespec-target']]);
  assert.deepEqual(Array.from(result.records, record => [record.panelId, record.runtimeId]), [[1, 'first'], [2, 'second']]);
  assert.equal(result.records.some(record => Object.hasOwn(record, 'actualPanel')), false);
  fixture.assertRestored();
});

for (const panelCount of [1, 5]) test(`TypeSpec dispatcher observer preserves bounded traffic across ${panelCount} panels and cleanup`, async () => {
  const fixture = dispatcherFixture();
  const owners = [], expectedLifecycle = [];
  const metadataKeys = ['type', 'probeId', 'runtimeId', 'requestId', 'reloadRequestId', 'sourceGeneration', 'viewSessionId', 'applied'];
  const lifecycleRow = (owner, direction, message) => [owner.panelId, owner.referenceIndex, fixture.behavior.phase, direction, ...metadataKeys.map(key => message[key] ?? null)];
  const routine = [
    ['receive', 'fileOpenTrace'], ['receive', 'getConnections'], ['post', 'connectionsData'], ['post', 'editingPreferencesData'],
    ['receive', 'getDatabases'], ['post', 'databasesData'], ['receive', 'getSqlDatabases'], ['post', 'sqlDatabasesLoading'],
    ['post', 'sqlDatabasesData'], ['receive', 'refreshDatabases'], ['receive', 'refreshSqlDatabases'], ['post', 'sqlDatabasesError'],
    ['receive', 'prefetchSqlSchema'], ['post', 'sqlSchemaData'], ['receive', 'checkCopilotAvailability'], ['post', 'copilotAvailability'],
    ['post', 'sqlConnectionsData'], ['receive', 'saveLastSelection'],
  ];
  const send = async (owner, direction, message, lifecycle = false) => {
    const envelope = { ...message, runtimeId: owner.runtimeId };
    if (lifecycle) expectedLifecycle.push(lifecycleRow(owner, direction, envelope));
    if (direction === 'receive') fixture.emit(envelope, owner.panel);
    else {
      fixture.behavior.postResult = Promise.resolve(true);
      assert.equal(owner.panel.webview.postMessage(envelope), fixture.behavior.postResult);
      await fixture.behavior.postResult;
    }
  };
  fixture.observer.install(fixture.facade);
  fixture.register();
  try {
    for (let index = 0; index < panelCount; index++) {
      const panel = index === 0 ? fixture.panel : fixture.makePanel();
      if (index > 0) fixture.originals.push({ target: panel.webview, key: 'postMessage', descriptor: Object.getOwnPropertyDescriptor(panel.webview, 'postMessage') });
      const referenceIndex = panelCount === 1 ? 104 : 100 + index;
      const uri = `file:///owned/activation-${referenceIndex}.kqlx`;
      const owner = { panel, panelId: index + 1, referenceIndex, runtimeId: `runtime-${index}` };
      fixture.references.set(uri, { index: referenceIndex });
      fixture.behavior.phase = `first-activation-${referenceIndex}`;
      await fixture.resolve(panel, uri);
      await send(owner, 'post', { type: 'mainWebviewDispatcherProbe', probeId: `probe-${index}` });
      const lifecycle = [
        ['receive', { type: 'mainWebviewDispatcherReady', probeId: `probe-${index}` }],
        ['receive', { type: 'requestDocument', requestId: `reload-${index}` }],
        ['post', { type: 'documentData', reloadRequestId: `reload-${index}`, sourceGeneration: 1, viewSessionId: `session-${index}` }],
        ['receive', { type: 'documentReloadApplied', reloadRequestId: `reload-${index}`, sourceGeneration: 1, viewSessionId: `session-${index}`, applied: true }],
        ['post', { type: 'requestToolState', requestId: `state-${index}` }],
        ['receive', { type: 'toolStateResponse', requestId: `state-${index}`, sections: [] }],
      ];
      for (const [position, [direction, type]] of routine.entries()) {
        await send(owner, direction, { type });
        if (position === 8) for (const previous of owners) for (const [direction, type] of routine.slice(0, 4)) await send(previous, direction, { type });
        if (position % 3 === 2) {
          const [direction, message] = lifecycle[Math.floor(position / 3)];
          await send(owner, direction, message, true);
          for (let repeat = 0; repeat < 20; repeat++) await send(owner, 'receive', { type: 'fileOpenTrace' });
        }
      }
      owners.push(owner);
    }
    fixture.behavior.phase = 'cleanup';
    for (const owner of owners) {
      for (const [direction, type] of routine.slice(0, 4)) await send(owner, direction, { type });
      await send(owner, 'receive', { type: 'requestDocument', requestId: `cleanup-${owner.panelId}` }, true);
      await send(owner, 'receive', { type: 'documentReloadApplied', reloadRequestId: `cleanup-${owner.panelId}`, sourceGeneration: 2, applied: false }, true);
    }
    const result = fixture.observer.restore();
    const crossPanelPhases = panelCount * (panelCount - 1) / 2;
    const received = 137 * panelCount + 2 * crossPanelPhases, submissions = 14 * panelCount + 2 * crossPanelPhases;
    assert.equal(fixture.calls.routed.length, received);
    assert.equal(fixture.calls.post.length, submissions);
    assert.equal(fixture.calls.register.length, 1);
    assert.equal(fixture.calls.resolve.length, panelCount);
    assert.equal(result.panels.length, panelCount);
    assert.equal(result.sequence, received + 2 * submissions);
    for (const key of ['overflow', 'captureFailures', 'boundaryUnavailable', 'boundaryDiagnosticOverflow', 'truncated', 'settlementUnavailable', 'restoreMismatch', 'restoreFailures', 'disposeFailures', 'pendingAtRestore']) assert.equal(result[key], 0, key);
    for (const key of ['observed', 'freshPanelObserved', 'completeCapture', 'complete', 'restored', 'retired']) assert.equal(result[key], true, key);
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.boundaryDiagnostics.length, 0);
    assert.equal(result.records.length, 31 * panelCount + 4 * crossPanelPhases);
    assert.equal(result.records.reduce((total, record) => total + record.count, 0), received + submissions);
    assert.equal(result.records.reduce((total, record) => total + record.attempts, 0), submissions);
    assert.equal(result.records.reduce((total, record) => total + record.successTrue, 0), submissions);
    for (const [index, owner] of owners.entries()) {
      const panel = result.panels[index], records = result.records.filter(record => record.panelId === owner.panelId);
      assert.equal(panel.referenceIndex, owner.referenceIndex);
      assert.equal(panel.received, 137 + 2 * (panelCount - index - 1));
      assert.equal(panel.submissions, 14 + 2 * (panelCount - index - 1));
      assert.equal(panel.pending, 0);
      assert.equal(panel.inboundAttached, true); assert.equal(panel.postWrapped, true);
      assert.equal(records.length, 31 + 4 * (panelCount - index - 1));
      assert.ok(records.length <= 128);
      assert.equal(records.filter(record => record.direction === 'receive').reduce((total, record) => total + record.count, 0), panel.received);
      assert.equal(records.filter(record => record.direction === 'post').reduce((total, record) => total + record.count, 0), panel.submissions);
      assert.ok(records.every(record => record.referenceIndex === owner.referenceIndex && record.runtimeId === owner.runtimeId && record.uriClassification === (owner.referenceIndex === 104 ? 'typespec-target' : 'owned-prefix')));
      assert.equal(fixture.listeners.get(owner.panel).size, 1);
    }
    const lifecycle = result.records.filter(record => record.priority === 'lifecycle');
    assert.deepEqual(Array.from(lifecycle, record => [record.panelId, record.referenceIndex, record.phase, record.direction, ...metadataKeys.map(key => record[key] ?? null)]), expectedLifecycle);
    assert.ok(lifecycle.every(record => record.count === 1 && record.firstOrder === record.lastOrder));
    assert.ok(result.records.every((record, index) => index === 0 || record.firstOrder > result.records[index - 1].firstOrder));
    assert.ok(result.records.every(record => record.pending === 0 && record.successFalse === 0 && record.rejected === 0 && record.thrown === 0 && record.settlementUnavailable === 0));
  } finally { fixture.observer.restore(); fixture.assertRestored(); }
});

for (const { priority, type, limit, identities } of [
  { priority: 'routine', type: 'fileOpenTrace', limit: 32, identities: ['requestId', 'sourceGeneration'] },
  { priority: 'probe', type: 'mainWebviewDispatcherProbe', limit: 64, identities: ['probeId', 'requestId', 'sourceGeneration'] },
]) for (const identity of identities) test(`TypeSpec dispatcher observer keeps same-panel phase ${priority} overflow fatal (${identity})`, () => {
  const fixture = dispatcherFixture();
  fixture.observer.install(fixture.facade); fixture.register(); fixture.resolve();
  const message = index => ({ type, [identity]: identity === 'sourceGeneration' ? index : `identity-${index}` });
  const send = value => priority === 'probe' ? assert.equal(fixture.panel.webview.postMessage(value), true) : fixture.emit(value);
  try {
    for (let index = 0; index < limit; index++) send(message(index));
    const full = fixture.observer.snapshot();
    assert.equal(full.records.length, limit);
    assert.equal(full.overflow, 0);
    assert.equal(full.completeCapture, true);
    send(message(limit));
    assert.equal(fixture.observer.snapshot().overflow, 1, 'A distinct identity beyond the phase quota must be lost and reported');
    send(message(0));
    const peer = fixture.makePanel();
    fixture.originals.push({ target: peer.webview, key: 'postMessage', descriptor: Object.getOwnPropertyDescriptor(peer.webview, 'postMessage') });
    fixture.resolve(peer);
    assert.equal(peer.webview.postMessage({ type: 'mainWebviewDispatcherProbe', probeId: 'peer' }), true);
    fixture.emit({ type: 'fileOpenTrace' }, peer);
    fixture.behavior.phase = 'cleanup';
    send(message(0));
    const result = fixture.observer.restore();
    assert.equal(result.overflow, 1, 'Admitted repeats, another panel and a fresh phase must not reset or add to the original loss');
    assert.equal(result.records.length, limit + 3);
    assert.equal(result.records[0].count, 2);
    assert.equal(result.records.at(-1).panelId, 1);
    assert.equal(result.records.at(-1).phase, 'cleanup');
    assert.equal(result.records.at(-1).count, 1);
    assert.deepEqual(Array.from(result.records.filter(record => record.panelId === 2), record => [record.type, record.count]), [['mainWebviewDispatcherProbe', 1], ['fileOpenTrace', 1]]);
    assert.equal(result.records.reduce((total, record) => total + record.count, 0), limit + 4);
    assert.equal(fixture.calls.post.length, priority === 'probe' ? limit + 4 : 1);
    assert.equal(fixture.calls.routed.length, priority === 'routine' ? limit + 4 : 1);
    assert.equal(result.panels[0].received, priority === 'routine' ? limit + 3 : 0);
    assert.equal(result.panels[0].submissions, priority === 'probe' ? limit + 3 : 0);
    assert.equal(result.records.reduce((total, record) => total + record.successTrue, 0), priority === 'probe' ? limit + 3 : 1);
    assert.equal(result.complete, false); assert.equal(result.completeCapture, false); assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.restored, true);
    for (const key of ['captureFailures', 'boundaryUnavailable', 'boundaryDiagnosticOverflow', 'truncated', 'settlementUnavailable', 'restoreMismatch', 'restoreFailures', 'disposeFailures', 'pendingAtRestore']) assert.equal(result[key], 0, key);
  } finally { fixture.observer.restore(); fixture.assertRestored(); }
});

for (const { priority, type, phaseSize } of [
  { priority: 'lifecycle', type: 'requestDocument', phaseSize: 129 },
  { priority: 'routine', type: 'fileOpenTrace', phaseSize: 32 },
  { priority: 'probe', type: 'mainWebviewDispatcherProbe', phaseSize: 64 },
]) test(`TypeSpec dispatcher observer enforces the same-panel 128-row pool (${priority})`, () => {
  const fixture = dispatcherFixture();
  fixture.observer.install(fixture.facade); fixture.register(); fixture.resolve();
  const send = index => {
    fixture.behavior.phase = `phase-${Math.floor(index / phaseSize)}`;
    const message = { type, requestId: `identity-${index % phaseSize}` };
    if (priority === 'probe') assert.equal(fixture.panel.webview.postMessage(message), true); else fixture.emit(message);
  };
  try {
    for (let index = 0; index < 128; index++) send(index);
    const full = fixture.observer.snapshot();
    assert.equal(full.records.length, 128);
    assert.equal(full.overflow, 0);
    assert.equal(full.completeCapture, true);
    assert.equal(new Set(full.records.map(record => record.phase)).size, Math.ceil(128 / phaseSize));
    send(128);
    const result = fixture.observer.restore();
    assert.equal(result.records.length, 128);
    assert.equal(result.overflow, 1);
    assert.equal(result.complete, false); assert.equal(result.completeCapture, false); assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.restored, true);
    assert.ok(result.records.every(record => record.panelId === 1 && record.priority === priority && record.count === 1 && record.pending === 0));
    assert.equal(result.records.reduce((total, record) => total + record.count, 0), 128);
    assert.equal(result.panels[0].submissions, priority === 'probe' ? 129 : 0);
    assert.equal(result.panels[0].received, priority === 'probe' ? 0 : 129);
    assert.equal(fixture.calls.post.length, priority === 'probe' ? 129 : 0);
    assert.equal(fixture.calls.routed.length, priority === 'probe' ? 0 : 129);
    assert.equal(result.records.reduce((total, record) => total + record.successTrue, 0), priority === 'probe' ? 128 : 0);
    for (const key of ['captureFailures', 'boundaryUnavailable', 'boundaryDiagnosticOverflow', 'truncated', 'settlementUnavailable', 'restoreMismatch', 'restoreFailures', 'disposeFailures', 'pendingAtRestore']) assert.equal(result[key], 0, key);
  } finally { fixture.observer.restore(); fixture.assertRestored(); }
});

for (const localRoutine of [false, true]) test(`TypeSpec dispatcher observer confines lifecycle eviction to its own panel (localRoutine=${localRoutine})`, () => {
  const fixture = dispatcherFixture();
  fixture.observer.install(fixture.facade); fixture.register(); fixture.resolve();
  const target = fixture.makePanel();
  fixture.originals.push({ target: target.webview, key: 'postMessage', descriptor: Object.getOwnPropertyDescriptor(target.webview, 'postMessage') });
  fixture.resolve(target);
  try {
    fixture.emit({ type: 'fileOpenTrace', requestId: 'peer-before' });
    const peerBefore = fixture.observer.snapshot().records[0];
    if (localRoutine) fixture.emit({ type: 'fileOpenTrace', requestId: 'target-routine' }, target);
    for (let index = 0; index < (localRoutine ? 127 : 128); index++) fixture.emit({ type: 'requestDocument', requestId: `target-${index}` }, target);
    const full = fixture.observer.snapshot();
    assert.equal(full.records.length, 129);
    assert.equal(full.overflow, 0);
    assert.equal(full.completeCapture, true);
    fixture.emit({ type: 'documentReloadApplied', reloadRequestId: 'target-terminal', sourceGeneration: 2, applied: true }, target);
    fixture.emit({ type: 'fileOpenTrace', requestId: 'peer-after' });
    const result = fixture.observer.restore();
    assert.equal(result.overflow, 1);
    assert.equal(result.records.length, 130);
    assert.deepEqual(result.records[0], peerBefore, 'An overflowing panel must not evict or rewrite its peer');
    const targetRecords = result.records.filter(record => record.panelId === 2);
    assert.equal(targetRecords.length, 128);
    assert.ok(targetRecords.every(record => record.priority === 'lifecycle' && record.count === 1));
    assert.equal(targetRecords.some(record => record.reloadRequestId === 'target-terminal'), localRoutine);
    assert.deepEqual(Array.from(targetRecords.filter(record => record.type === 'requestDocument'), record => record.requestId), Array.from({ length: localRoutine ? 127 : 128 }, (_, index) => `target-${index}`));
    assert.deepEqual(Array.from(result.records.filter(record => record.panelId === 1), record => record.requestId), ['peer-before', 'peer-after']);
    assert.deepEqual(Array.from(result.panels, panel => panel.received), [2, 129]);
    assert.equal(fixture.calls.routed.length, 131); assert.equal(fixture.calls.post.length, 0);
    assert.equal(result.complete, false); assert.equal(result.completeCapture, false); assert.equal(result.status, 'INCOMPLETE');
    assert.equal(result.restored, true);
    for (const key of ['captureFailures', 'boundaryUnavailable', 'boundaryDiagnosticOverflow', 'truncated', 'settlementUnavailable', 'restoreMismatch', 'restoreFailures', 'disposeFailures', 'pendingAtRestore']) assert.equal(result[key], 0, key);
  } finally { fixture.observer.restore(); fixture.assertRestored(); }
});

test('TypeSpec dispatcher observer rejects panel 33 without changing SDK calls or clearing overflow', () => {
  const fixture = dispatcherFixture();
  fixture.observer.install(fixture.facade); fixture.register();
  try {
    for (let index = 0; index < 33; index++) {
      const panel = index === 0 ? fixture.panel : fixture.makePanel();
      const descriptor = Object.getOwnPropertyDescriptor(panel.webview, 'postMessage');
      if (index > 0) fixture.originals.push({ target: panel.webview, key: 'postMessage', descriptor });
      assert.equal(fixture.resolve(panel), fixture.behavior.resolveResult);
      assert.equal(panel.webview.postMessage({ type: 'mainWebviewDispatcherProbe', probeId: `probe-${index}` }), true);
      fixture.emit({ type: 'mainWebviewDispatcherReady', probeId: `probe-${index}` }, panel);
      const snapshot = fixture.observer.snapshot();
      assert.equal(snapshot.panels.length, Math.min(index + 1, 32));
      assert.equal(snapshot.records.length, 2 * Math.min(index + 1, 32));
      assert.equal(snapshot.overflow, index === 32 ? 1 : 0);
      assert.equal(snapshot.completeCapture, index < 32);
      if (index === 32) {
        assert.deepEqual(Object.getOwnPropertyDescriptor(panel.webview, 'postMessage'), descriptor);
        assert.equal(fixture.listeners.get(panel).size, 1);
      }
    }
    const result = fixture.observer.restore();
    assert.deepEqual(Array.from(result.panels, panel => panel.panelId), Array.from({ length: 32 }, (_, index) => index + 1));
    assert.ok(result.panels.every(panel => panel.received === 1 && panel.submissions === 1 && panel.pending === 0 && panel.inboundAttached && panel.postWrapped));
    assert.equal(result.records.reduce((total, record) => total + record.successTrue, 0), 32);
    assert.equal(fixture.calls.register.length, 1); assert.equal(fixture.calls.resolve.length, 33);
    assert.equal(fixture.calls.post.length, 33); assert.equal(fixture.calls.routed.length, 33);
    assert.equal(result.overflow, 1); assert.equal(result.complete, false); assert.equal(result.completeCapture, false);
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.restored, true);
    for (const key of ['captureFailures', 'boundaryUnavailable', 'boundaryDiagnosticOverflow', 'truncated', 'settlementUnavailable', 'restoreMismatch', 'restoreFailures', 'disposeFailures', 'pendingAtRestore']) assert.equal(result[key], 0, key);
    assert.ok([...fixture.listeners.values()].every(callbacks => callbacks.size === 1));
  } finally { fixture.observer.restore(); fixture.assertRestored(); }
});

test('TypeSpec dispatcher observer aggregates 120 retries and reserves bounded raw lifecycle evidence', async () => {
  const fixture = dispatcherFixture();
  fixture.observer.install(fixture.facade);
  fixture.register();
  fixture.resolve();
  for (let attempt = 0; attempt < 120; attempt++) {
    fixture.behavior.postResult = Promise.resolve(false);
    assert.equal(fixture.panel.webview.postMessage({ type: 'mainWebviewDispatcherProbe', probeId: 'same-probe', runtimeId: 'same-runtime' }), fixture.behavior.postResult);
  }
  assert.equal(fixture.observer.snapshot().records[0].pending, 120);
  await fixture.behavior.postResult;
  fixture.emit({ type: 'mainWebviewDispatcherReady', probeId: 'same-probe', runtimeId: 'same-runtime' });
  fixture.emit({ type: 'requestDocument', requestId: 'first-request' });
  fixture.emit({ type: 'documentReloadApplied', reloadRequestId: 'first-request', sourceGeneration: 1, viewSessionId: 'session', applied: true });
  const result = fixture.observer.restore();
  assert.equal(result.complete, true);
  assert.equal(result.records.length, 4);
  assert.equal(result.records[0].attempts, 120);
  assert.equal(result.records[0].successFalse, 120);
  assert.equal(result.records[0].pending, 0);
  assert.ok(result.records[1].firstOrder > result.records[0].lastSettledOrder);
  assert.equal(result.records[3].applied, true);
  const flooded = dispatcherFixture();
  flooded.observer.install(flooded.facade);
  flooded.register();
  flooded.resolve();
  for (let index = 0; index < 200; index++) flooded.panel.webview.postMessage({ type: 'mainWebviewDispatcherProbe', probeId: String(index) });
  for (let index = 0; index < 200; index++) flooded.emit({ type: 'routine', requestId: String(index) });
  for (let index = 0; index < 32; index++) flooded.emit({ type: 'requestDocument', requestId: String(index) });
  flooded.emit({ type: 'mainWebviewDispatcherReady', runtimeId: 'last-ready' });
  flooded.emit({ type: 'documentReloadApplied', requestId: 'x'.repeat(128), runtimeId: 'x'.repeat(129), sourceGeneration: Infinity, get applied() { assert.fail('Do not evaluate a protocol getter'); } });
  const overflow = flooded.observer.restore();
  assert.equal(overflow.records.length, 128);
  assert.equal(overflow.complete, false);
  assert.equal(overflow.status, 'INCOMPLETE');
  assert.ok(overflow.overflow > 0);
  assert.equal(overflow.truncated, 1);
  assert.equal(overflow.captureFailures, 2);
  assert.ok(overflow.records.some(record => record.runtimeId === 'last-ready'));
  assert.equal(overflow.records.at(-1).requestId.length, 128);
  assert.equal(flooded.calls.post.length, 200);
});

test('TypeSpec dispatcher observer captures cleanup then retires without waiting for late SDK settlements', async () => {
  const fixture = dispatcherFixture();
  fixture.observer.install(fixture.facade);
  fixture.register();
  fixture.resolve();
  const pending = Promise.withResolvers();
  fixture.behavior.postResult = pending.promise;
  fixture.panel.webview.postMessage({ type: 'mainWebviewDispatcherProbe', probeId: 'late' });
  fixture.behavior.phase = 'cleanup';
  fixture.emit({ type: 'documentReloadApplied', sourceGeneration: 1, applied: false });
  const retired = fixture.observer.restore();
  assert.equal(retired.pendingAtRestore, 1);
  assert.equal(retired.complete, false);
  assert.equal(retired.restored, true);
  assert.equal(retired.records.at(-1).phase, 'cleanup');
  const retained = JSON.stringify(retired);
  pending.resolve(true);
  await pending.promise;
  fixture.emit({ type: 'mainWebviewDispatcherReady', probeId: 'late' });
  assert.equal(JSON.stringify(fixture.observer.snapshot()), retained);
  assert.equal(JSON.stringify(retired), retained);
  fixture.assertRestored();
});

test('TypeSpec dispatcher observer restores partial installs and exact descriptors without overwriting external changes', () => {
  const factory = typeSpecObserverFactory();
  const options = { references: new Map(), getPhase: () => 'setup', clock: () => 0 };
  let getterReads = 0;
  const unavailable = { window: {} };
  Object.defineProperty(unavailable.window, 'registerCustomEditorProvider', { configurable: true, get() { getterReads++; throw new Error('No accessor invocation'); } });
  const accessor = Object.getOwnPropertyDescriptor(unavailable.window, 'registerCustomEditorProvider');
  const blocked = factory(options);
  blocked.install(unavailable);
  assert.equal(blocked.restore().observed, false);
  assert.equal(getterReads, 0);
  assert.deepEqual(Object.getOwnPropertyDescriptor(unavailable.window, 'registerCustomEditorProvider'), accessor);
  const original = () => 'unchanged';
  const target = { registerCustomEditorProvider: original };
  const partial = factory(options);
  partial.install({ window: new Proxy(target, { defineProperty(object, key, descriptor) {
    Reflect.defineProperty(object, key, descriptor);
    if (descriptor.value !== original) throw new Error('Partial native patch failure');
    return true;
  } }) });
  assert.notEqual(target.registerCustomEditorProvider, original);
  assert.equal(partial.restore().restored, true);
  assert.equal(target.registerCustomEditorProvider, original);
  assert.equal(partial.snapshot().captureFailures, 1);
  const inherited = dispatcherFixture();
  const resolve = inherited.provider.resolveCustomTextEditor;
  delete inherited.provider.resolveCustomTextEditor;
  const prototype = { resolveCustomTextEditor: resolve };
  Object.setPrototypeOf(inherited.provider, prototype);
  const inheritedDescriptor = Object.getOwnPropertyDescriptor(prototype, 'resolveCustomTextEditor');
  inherited.observer.install(inherited.facade);
  inherited.register();
  inherited.resolve();
  assert.equal(inherited.observer.restore().complete, true);
  assert.equal(Object.hasOwn(inherited.provider, 'resolveCustomTextEditor'), false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'resolveCustomTextEditor'), inheritedDescriptor);
  for (const [location, change] of [['register', 'enumerable'], ['resolve', 'writable'], ['post', 'configurable'], ['post', 'accessor']]) {
    const fixture = dispatcherFixture();
    fixture.observer.install(fixture.facade);
    fixture.register();
    fixture.resolve();
    const [object, key] = location === 'register' ? [fixture.facade.window, 'registerCustomEditorProvider'] : location === 'resolve' ? [fixture.provider, 'resolveCustomTextEditor'] : [fixture.panel.webview, 'postMessage'];
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    const external = change === 'accessor' ? { configurable: true, enumerable: true, get() { assert.fail('Do not invoke a replacement accessor'); }, set() { assert.fail('Do not invoke a replacement setter'); } } : { ...descriptor, [change]: !descriptor[change] };
    Object.defineProperty(object, key, external);
    const result = fixture.observer.restore();
    assert.equal(result.restored, false);
    assert.equal(result.restoreMismatch, 1);
    assert.equal(result.complete, false);
    assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), external);
    for (const prior of fixture.originals.filter(prior => prior.target !== object)) assert.deepEqual(Object.getOwnPropertyDescriptor(prior.target, prior.key), prior.descriptor);
  }
  const disposal = dispatcherFixture();
  disposal.observer.install(disposal.facade);
  disposal.register();
  disposal.resolve();
  disposal.behavior.disposeThrow = new Error('Observer subscription disposal failure');
  const result = disposal.observer.restore();
  assert.equal(result.restored, true);
  assert.equal(result.disposeFailures, 1);
  assert.equal(result.complete, false);
  disposal.assertRestored();
});

test('TypeSpec preset-only admission reads all three exact settings and never calls SDK update', async () => {
  const feature = typeSpecFeatureSource();
  const environmentGuard = feature.match(/assert\.equal\(\[undefined, '0', '1'\].includes\(process\.env\.KW_TYPESPEC_PRESET_ONLY\)[^\n]+/)[0];
  const settingsBody = typeSpecSlice('const readSetting =', 'const requireTypeSpecStandaloneReceipt =', feature);
  for (const mode of [undefined, '0', '1', '', 'true', 'false', 'yes', '2']) {
    const context = createContext({ assert, process: { env: { KW_TYPESPEC_PRESET_ONLY: mode } } });
    const script = new Script(environmentGuard);
    if ([undefined, '0', '1'].includes(mode)) assert.doesNotThrow(() => script.runInContext(context));
    else assert.throws(() => script.runInContext(context), /KW_TYPESPEC_PRESET_ONLY must be/);
  }
  for (const scenario of ['preset', 'global-0', 'global-1', 'global-2', 'effective-0', 'effective-1', 'effective-2', 'legacy-unset', 'legacy-zero']) {
    const mode = scenario === 'legacy-unset' ? undefined : scenario === 'legacy-zero' ? '0' : '1';
    const values = ['afterDelay', 1000, false];
    const globals = [...values], effective = [...values], reads = [], writes = [];
    if (scenario.startsWith('global-')) globals[Number(scenario.at(-1))] = undefined;
    if (scenario.startsWith('effective-')) effective[Number(scenario.at(-1))] = 'mismatch';
    if (scenario.startsWith('legacy')) { globals.fill(undefined); effective.fill('previous'); }
    const keys = ['files.autoSave', 'files.autoSaveDelay', 'workbench.editor.enablePreview'];
    const outcome = { configuration: { presetOnly: mode === '1', changes: [] } };
    const context = createContext({ assert, performance, outcome, settings: [], phase: 'setup', write() {}, setTimeout: () => 1, clearTimeout() {},
      vscode: { ConfigurationTarget: { Global: 1 }, workspace: {
        onDidChangeConfiguration: () => ({ dispose() {} }),
        getConfiguration: section => ({
          inspect(key) { const index = keys.indexOf(section + '.' + key); reads.push(index); return { globalValue: globals[index] }; },
          get: key => effective[keys.indexOf(section + '.' + key)],
          update(key, value, target) { const index = keys.indexOf(section + '.' + key); writes.push({ index, value, target }); globals[index] = value; effective[index] = value; return Promise.resolve(); },
        }),
      } },
    });
    const configure = new Script('(() => { ' + settingsBody + '; return configureTypeSpecSettings; })()').runInContext(context);
    if (scenario.startsWith('global-') || scenario.startsWith('effective-')) await assert.rejects(configure(), /Preset (global|effective) mismatch/);
    else await configure();
    assert.deepEqual(reads.slice(0, 3), [0, 1, 2], 'Admit the complete tuple before any updates');
    assert.equal(writes.length, scenario.startsWith('legacy') ? 3 : 0);
    assert.equal(outcome.configuration.changes.length, writes.length);
    assert.equal(context.settings.length, writes.length);
    if (scenario === 'preset') assert.equal(outcome.configuration.presetVerified, true);
  }
  assert.ok(feature.indexOf(environmentGuard) < feature.indexOf('const manifestBytes ='));
  assert.ok(feature.indexOf('await configureTypeSpecSettings();') < feature.indexOf("dispatcherObserver.install(workbenchRequire('vscode'))"));
});

test('TypeSpec qualified receipt rejects legacy PASS, incomplete SDK proof and any identity or preset drift', () => {
  const feature = typeSpecFeatureSource();
  const fixture = dispatcherFixture();
  fixture.observer.install(fixture.facade);
  fixture.register();
  fixture.resolve();
  fixture.panel.webview.postMessage({ type: 'mainWebviewDispatcherProbe', probeId: 'probe' });
  fixture.emit({ type: 'mainWebviewDispatcherReady', probeId: 'probe', runtimeId: 'runtime' });
  const settings = [['files', 'autoSave', 'afterDelay'], ['files', 'autoSaveDelay', 1000], ['workbench.editor', 'enablePreview', false]].map(([section, key, value]) => ({ section, key, value, before: { inspection: { globalValue: value }, effective: value } }));
  const expression = [...feature.matchAll(/"""\r?\n([\s\S]*?)\r?\n\s*"""/g)][0][1].trim();
  const runTypeSpecAcceptance = new Script(expression.slice(0, -2)).runInNewContext();
  const context = createContext({ assert, runTypeSpecAcceptance, hash: value => createHash('sha256').update(value).digest('hex'), outcome: {}, vscode: { version: '1.143.0' } });
  new Script(feature.match(/outcome\.guardContract =[^\n]+/)[0]).runInContext(context);
  const actualCode = { version: '1.143.0', commit: '2d0b'.padEnd(40, '0'), codeBytes: 32, codeSha256: 'a'.repeat(64), execPath: '/owned/Code.exe', appRoot: '/owned/resources/app', productPath: '/owned/resources/app/product.json', packagePath: '/owned/resources/app/package.json' };
  const current = JSON.parse(JSON.stringify({ schemaVersion: 1, trial: 'standalone', classification: 'PASS', calls: [{ index: 104, oraclePassed: true }],
    dispatcherObservation: fixture.observer.restore(), configuration: { presetOnly: true, presetVerified: true, changes: [], before: settings, after: settings },
    guardContract: context.outcome.guardContract, helperSha256: 'b'.repeat(64), actualCode, afterActualCode: actualCode,
    checks: { dispatcherObservation: true, evidenceSink: true, actualCode: true, helperUnchanged: true }, errors: [], evidenceFailures: [], evidenceFailureCount: 0,
    build: { mainSha256: 'main', manifestSha256: 'original-manifest', assetManifestSha256: 'all-assets', assets: [{ path: 'dist/extension.js', bytes: 10, sha256: 'main' }] },
    runtime: { vscode: '1.143.0', codeCommit: actualCode.commit, codeSha256: actualCode.codeSha256, codeBytes: actualCode.codeBytes }, archive: { sha256: 'archive', baselineSha256: 'baseline', ledgerSha256: 'ledger' } }));
  context.outcome = current;
  const body = typeSpecSlice('const typeSpecSettings =', 'const sample =', feature);
  const validate = new Script('(() => { ' + body + '; return requireTypeSpecStandaloneReceipt; })()').runInContext(context);
  assert.doesNotThrow(() => validate(structuredClone(current)));
  for (const panelCount of [1, 32]) {
    const bounded = dispatcherFixture();
    bounded.observer.install(bounded.facade); bounded.register();
    try {
      for (let index = 0; index < panelCount; index++) {
        const panel = index === 0 ? bounded.panel : bounded.makePanel();
        if (index > 0) bounded.originals.push({ target: panel.webview, key: 'postMessage', descriptor: Object.getOwnPropertyDescriptor(panel.webview, 'postMessage') });
        bounded.resolve(panel);
        for (let row = 0; row < 128; row++) bounded.emit({ type: 'requestDocument', requestId: `request-${row}` }, panel);
      }
      const receipt = structuredClone(current);
      receipt.dispatcherObservation = JSON.parse(JSON.stringify(bounded.observer.restore()));
      assert.equal(receipt.dispatcherObservation.complete, true);
      assert.equal(receipt.dispatcherObservation.overflow, 0);
      assert.equal(receipt.dispatcherObservation.panels.length, panelCount);
      assert.equal(receipt.dispatcherObservation.records.length, panelCount * 128);
      assert.doesNotThrow(() => validate(receipt), `${panelCount} bounded real panels must qualify`);
      receipt.dispatcherObservation.records.push({ ...receipt.dispatcherObservation.records[0] });
      assert.throws(() => validate(receipt), panelCount === 1 ? /panel exceeds 128 rows/ : /at most 4096 entries/);
    } finally { bounded.observer.restore(); bounded.assertRestored(); }
  }
  const mutations = [
    receipt => { delete receipt.schemaVersion; },
    receipt => { delete receipt.dispatcherObservation; },
    receipt => { receipt.dispatcherObservation.schemaVersion = 1; },
    receipt => { delete receipt.dispatcherObservation.boundaryDiagnostics; },
    receipt => { receipt.dispatcherObservation.boundaryDiagnostics = [{}]; },
    receipt => { delete receipt.dispatcherObservation.boundaryDiagnosticOverflow; },
    ...['observed', 'freshPanelObserved', 'completeCapture', 'complete', 'restored', 'retired'].map(key => receipt => { receipt.dispatcherObservation[key] = false; }),
    ...['captureFailures', 'boundaryUnavailable', 'boundaryDiagnosticOverflow', 'overflow', 'truncated', 'settlementUnavailable', 'restoreMismatch', 'restoreFailures', 'disposeFailures', 'pendingAtRestore'].map(key => receipt => { receipt.dispatcherObservation[key] = 1; }),
    receipt => { receipt.dispatcherObservation.panels = []; },
    receipt => { receipt.dispatcherObservation.panels = {}; },
    receipt => { delete receipt.dispatcherObservation.panels; },
    receipt => { receipt.dispatcherObservation.panels.push({ ...receipt.dispatcherObservation.panels[0] }); },
    receipt => { receipt.dispatcherObservation.panels = Array.from({ length: 33 }, (_, index) => ({ ...receipt.dispatcherObservation.panels[0], panelId: index + 1 })); },
    ...[undefined, null, 0, -1, 1.5, 33, '1'].map(panelId => receipt => {
      receipt.dispatcherObservation.panels[0].panelId = panelId;
      for (const record of receipt.dispatcherObservation.records) record.panelId = panelId;
    }),
    receipt => { receipt.dispatcherObservation.records = {}; },
    receipt => { delete receipt.dispatcherObservation.records; },
    receipt => { receipt.dispatcherObservation.records[0].panelId = 2; },
    receipt => { receipt.dispatcherObservation.records = Array.from({ length: 129 }, () => ({ ...receipt.dispatcherObservation.records[0] })); },
    receipt => { receipt.evidenceFailureCount = 1; },
    receipt => { delete receipt.guardContract; },
    receipt => { receipt.guardContract.version = 'typespec-dispatcher-v1'; },
    receipt => { delete receipt.guardContract.scriptSha256; },
    receipt => { receipt.guardContract.scriptSha256 = 'c'.repeat(64); },
    receipt => { delete receipt.helperSha256; },
    receipt => { receipt.helperSha256 = 'c'.repeat(64); },
    receipt => { receipt.checks.helperUnchanged = false; },
    receipt => { delete receipt.actualCode; },
    receipt => { delete receipt.afterActualCode; },
    receipt => { delete receipt.checks.actualCode; },
    ...['version', 'commit', 'codeSha256', 'codeBytes', 'execPath', 'appRoot', 'productPath', 'packagePath'].flatMap(key => [
      receipt => { receipt.actualCode[key] = 'changed'; }, receipt => { receipt.afterActualCode[key] = 'changed'; },
    ]),
    receipt => { receipt.configuration.presetOnly = false; },
    receipt => { receipt.configuration.changes.push({}); },
    receipt => { receipt.configuration.before[2].before.inspection.globalValue = true; },
    receipt => { receipt.configuration.after[1].before.effective = 500; },
    receipt => { receipt.build.mainSha256 = 'old'; },
    receipt => { receipt.build.manifestSha256 = 'different'; },
    receipt => { receipt.build.assetManifestSha256 = 'different'; },
    receipt => { receipt.build.assets[0].sha256 = 'changed'; },
    receipt => { receipt.runtime.codeCommit = 'different'; },
    receipt => { receipt.runtime.codeSha256 = 'different'; },
    receipt => { receipt.runtime.codeBytes++; },
    receipt => { receipt.archive.sha256 = 'different'; },
    receipt => { receipt.checks.dispatcherObservation = false; },
    receipt => { receipt.calls[0].oraclePassed = false; },
  ];
  for (const mutate of mutations) { const receipt = structuredClone(current); mutate(receipt); assert.throws(() => validate(receipt)); }
  assert.equal(current.guardContract.version, 'typespec-dispatcher-v3');
  for (const guardContract of [
    { ...current.guardContract, version: 'typespec-dispatcher-v2' },
    { version: 'typespec-dispatcher-v3', scriptSha256: '81f0eb71f077387a97aeac1a2d25bc91b29e7894722c3275df1fdbf8ed5fc3e5' },
  ]) {
    const receipt = structuredClone(current); receipt.guardContract = guardContract;
    assert.throws(() => validate(receipt), /Runtime guard version or executing script changed/);
  }
  const statements = ['outcome.actualCode = readActualCodeIdentity();', 'helperSha256 = hash(fs.readFileSync(helperPath));', 'helper = await import(url.pathToFileURL(helperPath).href);', 'requireTypeSpecStandaloneReceipt(receipt);', 'const selected =', "dispatcherObserver.install(workbenchRequire('vscode'));", 'await extension.activate();'];
  const assertOrder = candidate => {
    const offsets = statements.map(statement => { const offset = candidate.indexOf(statement); assert.ok(offset >= 0, 'Missing actual source guard: ' + statement); return offset; });
    assert.ok(offsets.every((offset, index) => index === 0 || offset > offsets[index - 1]), 'Identity and observer guards must precede activation');
  };
  assertOrder(feature);
  for (const statement of statements) assert.throws(() => assertOrder(feature.replace(statement, '')), /Missing actual source guard/);
});

const typeSpecTraceHarness = (fault = 'pass') => {
  const calls = [];
  const environment = { APPDATA: 'memory-only-appdata', VSCODE_EXT_TESTER_PORT: '59583', KW_TYPESPEC_CDP_PORT: '59584' };
  if (fault === 'controller-port') environment.VSCODE_EXT_TESTER_PORT = '0';
  if (fault === 'cdp-port') environment.KW_TYPESPEC_CDP_PORT = 'invalid';
  if (fault === 'same-port') environment.KW_TYPESPEC_CDP_PORT = environment.VSCODE_EXT_TESTER_PORT;
  class ControllerClient {
    constructor(port) { assert.equal(port, 59583); calls.push('client'); }
    async connect() { calls.push('connect'); if (fault === 'connect') throw new Error('Connection failed'); }
    disconnect() { calls.push('disconnect'); }
  }
  class TestRunner {
    constructor(client, options, report, native, port) {
      assert.ok(client instanceof ControllerClient);
      assert.equal(Object.keys(options).length, 0);
      assert.equal(report, undefined);
      assert.equal(native, undefined);
      assert.equal(port, 59584);
    }
    async setLogLevel(level, channel) {
      assert.equal(level, 'Trace'); assert.equal(channel, 'Kusto Workbench'); calls.push('set');
      if (fault === 'set') throw new Error('Named level unavailable');
    }
    async runSingleStep(step, options) {
      assert.deepEqual(JSON.parse(JSON.stringify(step)), { keyword: 'Then ', text: 'the output channel "Kusto Workbench" log level should be "Trace"' });
      assert.deepEqual(JSON.parse(JSON.stringify(options)), { screenshotPolicy: 'never', captureLogs: false, includeState: false });
      calls.push('assert');
      return { status: fault === 'assert' ? 'failed' : 'passed', error: fault === 'assert' ? { message: 'Named channel is not Trace' } : undefined };
    }
    cleanup() { calls.push('cleanup'); if (fault === 'cleanup') throw new Error('Runner cleanup failed'); }
  }
  const modules = { createRequire(location) {
    assert.equal(location, path.join(environment.APPDATA, 'npm/node_modules/vscode-ext-test/package.json'));
    return name => {
      if (name === './package.json') return { version: fault === 'version' ? 'different' : '0.1.24' };
      if (name === './dist/runner/controller-client.js') return { ControllerClient };
      if (name === './dist/runner/cdp-client.js') return { CdpClient: class {
        async connect() { calls.push('renderer-connect'); }
        async evaluateInWebview() {
          calls.push('renderer-read');
          if (fault.endsWith('renderer-error')) throw new Error('Renderer unavailable');
          return fault.endsWith('renderer-wrong-frame') ? null : { matchedSectionCount: 1, dispatcherFlag: 'true' };
        }
        disconnect() { calls.push('renderer-disconnect'); }
      } };
      assert.equal(name, './dist/runner/test-runner.js');
      return { TestRunner };
    };
  } };
  return { modules, environment, calls };
};

for (const fault of ['pass', 'controller-port', 'cdp-port', 'same-port', 'version', 'connect', 'set', 'assert', 'cleanup']) test(`TypeSpec named Trace gate precedes all target calls (${fault})`, async () => {
  const fixture = typeSpecTraceHarness(fault);
  const outcome = { checks: {} };
  const context = createContext({ assert, path, modules: fixture.modules, process: { env: fixture.environment }, outcome, calls: fixture.calls });
  const script = new Script(`(async () => { ${typeSpecSlice('const verifyTypeSpecTrace =', 'const createTypeSpecDispatcherObserver =')} await verifyTypeSpecTrace(); calls.push('first-public-call'); })()`);
  if (fault === 'pass') await script.runInContext(context);
  else await assert.rejects(script.runInContext(context));
  assert.equal(fixture.calls.includes('first-public-call'), fault === 'pass');
  if (fixture.calls.includes('client')) assert.deepEqual(fixture.calls.filter(call => ['cleanup', 'disconnect'].includes(call)), ['cleanup', 'disconnect']);
  if (fault === 'pass') {
    assert.deepEqual(fixture.calls, ['client', 'connect', 'set', 'assert', 'cleanup', 'disconnect', 'first-public-call']);
    assert.equal(outcome.checks.namedChannelTrace, true);
    assert.equal(outcome.namedChannelAssertion.status, 'passed');
  }
});

for (const fault of ['available', 'wrong-frame', 'wrong-active-tab', 'ambiguous-ids', 'connect-error', 'evaluation-error', 'timeout-late-result', 'flag-accessor']) test(`TypeSpec post-failure renderer inspection preserves the first result (${fault})`, async () => {
  const reference = { index: 102, uri: 'file:///prefix-102.kqlx', sectionIds: ['query-unique'] };
  const references = new Map([[reference.uri, reference]]);
  if (fault === 'ambiguous-ids') references.set('file:///other.kqlx', { sectionIds: ['query-unique'] });
  const calls = [];
  const timers = new Map();
  const entered = Promise.withResolvers();
  const delayed = Promise.withResolvers();
  const outcome = { classification: 'PREFIX_FIRST_ACTIVATION_FAILED', calls: [{ index: 102, oraclePassed: false, input: { targetFileUri: reference.uri }, elapsedMs: 17000, value: { success: false } }] };
  const original = JSON.stringify(outcome);
  let propertyReads = 0;
  const browserWindow = {};
  if (fault === 'flag-accessor') Object.defineProperty(browserWindow, '__kustoHostMessageDispatcherReady', { get() { propertyReads++; throw new Error('Do not invoke accessors'); } });
  else Object.defineProperty(browserWindow, '__kustoHostMessageDispatcherReady', { value: true });
  class CdpClient {
    constructor(port) { assert.equal(port, 59584); }
    async connect() { calls.push('connect'); if (fault === 'connect-error') throw new Error('No connection'); }
    async evaluateInWebview(expression, title, options) {
      calls.push('evaluate');
      assert.equal(title, undefined, 'No title-based tab activation');
      assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 4000);
      entered.resolve();
      if (fault === 'evaluation-error') throw new Error('No renderer response');
      if (fault === 'timeout-late-result') return delayed.promise;
      return new Script(expression).runInNewContext({ window: browserWindow, document: {
        getElementById: id => fault === 'wrong-frame' ? null : id === 'query-unique' ? {} : null,
        readyState: 'complete', visibilityState: 'visible', querySelectorAll: () => [],
      } });
    }
    disconnect() { calls.push('disconnect'); }
  }
  const context = createContext({ assert, path, performance, references, outcome,
    process: { env: { APPDATA: 'memory-only', KW_TYPESPEC_CDP_PORT: '59584' } },
    modules: { createRequire: () => name => name === './package.json' ? { version: '0.1.24' } : { CdpClient } },
    tabs: () => [{ isActive: true, input: { uri: { toString: () => fault === 'wrong-active-tab' ? 'file:///other.kqlx' : reference.uri } } }],
    setTimeout: (callback, delay) => { assert.equal(delay, 4000); timers.set(1, callback); return 1; },
    clearTimeout: id => timers.delete(id),
  });
  const inspect = new Script(`(() => { ${typeSpecSlice('const captureFailedTypeSpecRenderer =', 'const createTypeSpecDispatcherObserver =')} return captureFailedTypeSpecRenderer; })()`).runInContext(context);
  const pending = inspect();
  if (fault === 'timeout-late-result') { await entered.promise; timers.get(1)(); }
  const result = await pending;
  const captured = JSON.stringify(result);
  if (fault === 'timeout-late-result') { delayed.resolve({ matchedSectionCount: 1 }); await Promise.resolve(); await Promise.resolve(); }
  assert.equal(JSON.stringify(outcome), original);
  assert.equal(JSON.stringify(result), captured, 'Late work cannot change a captured diagnostic');
  assert.equal(timers.size, 0);
  assert.equal(propertyReads, 0);
  assert.equal(result.status, fault === 'available' || fault === 'flag-accessor' ? 'available' : fault === 'timeout-late-result' ? 'timeout' : 'unavailable');
  if (fault === 'flag-accessor') assert.equal(result.value.dispatcherFlag, 'accessor');
  if (calls.includes('connect')) assert.ok(calls.includes('disconnect'));
});

const pendingTypeSpecFixture = (fault = 'available') => {
  const timers = new Map(), writes = [], actions = [];
  let timerId = 0;
  const connected = Promise.withResolvers(), evaluated = Promise.withResolvers(), delayed = Promise.withResolvers();
  const reference = { index: 101, uri: 'file:///pending-101.kqlx', path: 'pending-101.kqlx', expectedOpenFileId: 'wf_101' };
  const outcome = { calls: [], errors: [], classification: 'RUNNING' };
  const documents = [{ uri: { toString: () => reference.uri }, version: 1, isDirty: false, get getText() { assert.fail('Do not read notebook text'); } }];
  class CdpClient {
    constructor(port) { assert.equal(port, 59584); }
    async connect() {
      actions.push('connect'); connected.resolve();
      if (fault === 'connect-error') throw new Error('Connection unavailable');
      if (fault === 'late-connect' || fault === 'settles-during-connect') await delayed.promise;
    }
    async evaluate(expression, options) {
      actions.push('evaluate'); evaluated.resolve();
      assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 4000);
      if (fault === 'evaluation-error') throw new Error('Evaluation unavailable');
      if (fault === 'late-evaluation' || fault === 'retired') return delayed.promise;
      return new Script(expression).runInNewContext({ document: {
        readyState: 'complete', querySelector: selector => selector === '.monaco-workbench' && fault !== 'wrong-realm' ? {} : null,
        querySelectorAll: selector => selector === '.tab.active .label-name' ? [{ textContent: reference.path }] : [],
      } });
    }
    disconnect() { actions.push('disconnect'); if (fault === 'disconnect-error') throw new Error('Disconnect failed'); }
  }
  const write = (name, value) => { if (fault === 'writer-error') throw new Error('Writer failed'); writes.push({ name, value: JSON.parse(JSON.stringify(value)) }); };
  const context = createContext({ assert, path, performance, outcome, write, Date, Promise,
    tabs: () => { if (fault === 'tab-error') throw new Error('Tab unavailable'); return [{ isActive: true, input: { uri: { toString: () => reference.uri } } }]; },
    vscode: { workspace: { textDocuments: documents } },
    modules: { createRequire: () => name => name === './package.json' ? { version: '0.1.24' } : { CdpClient } },
    process: { env: { APPDATA: 'memory-only', KW_TYPESPEC_CDP_PORT: '59584' } },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const helpers = new Script(`(() => { ${typeSpecSlice('const pendingTypeSpecCaptures =', 'const createTypeSpecDispatcherObserver =')} return { start: startPendingTypeSpecCapture, captures: pendingTypeSpecCaptures }; })()`).runInContext(context);
  const fire = delay => {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, 'Expected timer ' + delay);
    timers.delete(entry[0]); entry[1].callback();
  };
  const flush = async () => { for (let count = 0; count < 20; count++) await Promise.resolve(); };
  return { context, helpers, outcome, reference, timers, writes, actions, connected, evaluated, delayed, fire, flush };
};

for (const fault of ['available', 'early-settle', 'settles-during-connect', 'connect-error', 'evaluation-error', 'tab-error', 'writer-error', 'disconnect-error', 'wrong-realm', 'late-connect', 'late-evaluation', 'retired']) test(`TypeSpec pending capture never settles the original operation (${fault})`, async () => {
  const fixture = pendingTypeSpecFixture(fault);
  const original = { index: 101, oraclePassed: false, input: { targetFileUri: fixture.reference.uri } };
  fixture.outcome.calls.push(original);
  const originalText = JSON.stringify(original);
  const handle = fixture.helpers.start(fixture.reference);
  if (fault === 'early-settle') {
    const queued = [...fixture.timers.values()][0].callback;
    handle.settle(); queued();
  } else {
    fixture.fire(5000);
    await fixture.flush();
    if (fault === 'settles-during-connect') { handle.settle(); fixture.delayed.resolve(); }
    if (fault === 'late-connect' || fault === 'late-evaluation') fixture.fire(4000);
    if (fault === 'retired') handle.retire();
    await fixture.flush();
  }
  const captured = JSON.stringify(fixture.outcome.pendingActivationDiagnostics);
  fixture.delayed.resolve({ readyState: 'complete', iframeCount: 1, quickInputVisible: false, visibleDialogs: 0, activeNameMatches: true });
  await fixture.flush();
  if (fault === 'late-connect') assert.equal(fixture.actions.includes('evaluate'), false, 'Expired attachment must not start evaluation');
  assert.equal(JSON.stringify(original), originalText);
  assert.equal(JSON.stringify(fixture.outcome.pendingActivationDiagnostics), captured, 'Late completion cannot rewrite captured diagnostics');
  handle.settle(); handle.retire();
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.helpers.captures.size, 0);
  if (fault === 'early-settle') { assert.equal(fixture.actions.length, 0); assert.equal(fixture.writes.length, 0); }
  else {
    const row = fixture.outcome.pendingActivationDiagnostics[0];
    assert.equal(row.referenceIndex, 101);
    if (fault === 'late-connect' || fault === 'late-evaluation') {
      assert.equal(row.stage, fault === 'late-connect' ? 'connecting' : 'evaluating');
      assert.deepEqual({ ...row.native }, { activeTabMatches: true, documentPresent: true, version: 1, dirty: false });
    }
    assert.equal(row.status, fault === 'late-connect' || fault === 'late-evaluation' ? 'timeout' : fault === 'retired' ? 'retired' : ['connect-error', 'evaluation-error', 'tab-error', 'writer-error', 'wrong-realm'].includes(fault) ? 'unavailable' : 'available');
    if (fault === 'settles-during-connect') assert.equal(row.sampledWhilePending, false);
    if (fault === 'available') { assert.equal(row.sampledWhilePending, true); assert.equal(fixture.writes[0].name, 'pending-activation-101'); }
  }
});

test('TypeSpec actual calls save a pending diagnostic before cancellation and never open the next target', async () => {
  const fixture = pendingTypeSpecFixture();
  const cancellation = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const calls = [];
  const references = [100, 101, 102].map(index => ({ index, uri: `file:///pending-${index}.kqlx`, path: `pending-${index}.kqlx`, expectedOpenFileId: `wf_${index}` }));
  fixture.context.references = new Map(references.map(reference => [reference.uri, reference]));
  fixture.context.targetPath = 'typespec.kqlx';
  fixture.context.startPendingTypeSpecCapture = fixture.helpers.start;
  fixture.context.dispatcherObserver = { snapshot: () => ({}) };
  fixture.context.vscode.lm = { invokeTool: async (name, options) => {
    assert.equal(name, 'kusto-workbench_activate-workbench-file');
    calls.push(options.input.targetFileUri);
    if (calls.length === 2) { entered.resolve(); return cancellation.promise; }
    return { content: [{ value: JSON.stringify({ success: true, isLiveWorkbench: true, isReadOnlyFallback: false, uri: references[0].uri, openFileId: references[0].expectedOpenFileId }) }] };
  } };
  const source = typeSpecFeatureSource();
  const block = typeSpecSlice('const record = { index: reference.index,', 'const exactTabs =', source);
  const operation = new Script(`(async () => { try { for (const reference of references.values()) { ${block} } } catch (error) { outcome.errors.push(error.message); } })()`).runInContext(fixture.context);
  await entered.promise;
  assert.equal(fixture.outcome.calls[0].oraclePassed, true);
  assert.equal(fixture.outcome.calls[1].transportError, undefined);
  fixture.fire(5000); await fixture.flush();
  assert.equal(fixture.writes.some(entry => entry.name === 'pending-activation-101' && entry.value.sampledWhilePending === true), true);
  assert.equal(fixture.writes.some(entry => entry.name === 'call-101-response'), false);
  cancellation.reject(new Error('Canceled'));
  await operation;
  assert.deepEqual(calls, [references[0].uri, references[1].uri]);
  assert.equal(fixture.outcome.calls[1].transportError, 'Canceled');
  assert.equal(fixture.outcome.classification, 'PREFIX_FIRST_ACTIVATION_FAILED');
  assert.ok(fixture.writes.some(entry => entry.name === 'call-101-response' && entry.value.transportError === 'Canceled'));
  assert.equal(fixture.timers.size, 0);
});

for (const fault of ['ready', 'observer-error', 'activation-error', 'activation-pending']) test(`TypeSpec startup diagnostics preserve activation semantics (${fault})`, async () => {
  const fixture = pendingTypeSpecFixture();
  const activation = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const stages = [];
  let modelReads = 0, activationCalls = 0;
  Object.defineProperty(fixture.context.vscode.workspace, 'textDocuments', { get() { modelReads++; throw new Error('Startup sentinel must not inspect notebook models'); } });
  fixture.context.startPendingTypeSpecCapture = fixture.helpers.start;
  fixture.context.startupCapture = undefined;
  fixture.context.dispatcherObserver = undefined;
  fixture.context.references = new Map();
  fixture.context.phase = 'setup';
  fixture.context.preserveInitialDocuments = label => stages.push(label);
  fixture.context.workbenchRequire = name => { assert.equal(name, 'vscode'); return {}; };
  fixture.context.createTypeSpecDispatcherObserver = () => ({ install() { stages.push('install'); if (fault === 'observer-error') throw new Error('Original observer failure'); } });
  fixture.context.extension = { activate: async () => {
    activationCalls++; stages.push('activate'); entered.resolve();
    if (fault === 'activation-error') throw new Error('Original activation failure');
    if (fault === 'activation-pending') return activation.promise;
  } };
  const source = typeSpecFeatureSource();
  const block = typeSpecSlice("startupCapture = startPendingTypeSpecCapture({ index: 'startup'", "assert.equal(tabs().length, 0, 'Activation setup", source);
  const operation = new Script(`(async () => { try { ${block} } catch (error) { outcome.errors.push(error.message); outcome.classification = 'SETUP_BLOCKED'; } finally { startupCapture?.retire(); } })()`).runInContext(fixture.context);
  if (fault === 'activation-pending') {
    await entered.promise;
    fixture.fire(5000); await fixture.flush();
    const captured = fixture.writes.find(entry => entry.name === 'pending-activation-startup');
    assert.equal(captured.value.sampledWhilePending, true);
    assert.equal(captured.value.native.documentPresent, false);
    assert.equal(fixture.writes.some(entry => entry.name === 'startup-activated'), false);
    activation.reject(new Error('Original activation canceled'));
  }
  await operation;
  assert.equal(activationCalls, fault === 'observer-error' ? 0 : 1);
  assert.equal(fixture.outcome.calls.length, 0);
  assert.equal(fixture.context.references.size, 0);
  assert.equal(modelReads, 0);
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.helpers.captures.size, 0);
  assert.equal(fixture.writes[0].name, 'startup-before-observer');
  assert.equal(fixture.writes.some(entry => entry.name === 'startup-before-activation'), fault !== 'observer-error');
  assert.equal(fixture.writes.some(entry => entry.name === 'startup-activated'), fault === 'ready');
  if (fault !== 'ready') assert.match(fixture.outcome.errors[0], /^Original (observer failure|activation failure|activation canceled)$/);
});

test('TypeSpec composed actual feature finally preserves first failure through sink, close and disposal failures', async () => {
  const feature = typeSpecFeatureSource();
  const observerBody = typeSpecSlice('const createTypeSpecDispatcherObserver =', 'const readSetting =', feature);
  const writeBody = typeSpecSlice('const write =', 'const createTypeSpecDispatcherObserver =', feature);
  const metadataBody = typeSpecSlice('const initialDocumentReferences =', 'const subscriptions =', feature);
  const admission = typeSpecSlice('for (const document of vscode.workspace.textDocuments) initialDocumentReferences.set', 'assert.equal(vscode.workspace.workspaceFolders?.length', feature);
  const tail = typeSpecSlice("outcome.before = preservation('before-open');", '\n      })()', feature);
  for (const scenario of ['pass', 'activation-failure-owner-absent', 'unavailable-sdk', 'first-failure', 'first-failure-cleanup-sink', 'successful-response-sink', 'final-checkpoint-sink', 'drain-success', 'drain-timeout', 'first-failure-drain-timeout', 'first-failure-drain-throw', 'prefix-failure', 'prefix-failure-renderer-error', 'prefix-failure-renderer-wrong-frame', 'prefix-failure-renderer-timeout', 'prefix-failure-renderer-tab-error']) {
    const fixture = dispatcherFixture();
    const traceFixture = typeSpecTraceHarness(scenario);
    const currentTabs = [], lifecycle = [], writes = [];
    const prefixFailure = scenario.startsWith('prefix-failure');
    const firstFailure = scenario.startsWith('first-failure') || prefixFailure;
    const sinkFailure = scenario.endsWith('sink');
    const cleanupFailure = scenario === 'first-failure-cleanup-sink';
    const activationFailure = scenario === 'activation-failure-owner-absent';
    const unavailableSdk = scenario === 'unavailable-sdk';
    const drainTimeout = scenario.endsWith('drain-timeout'), drainThrow = scenario.endsWith('drain-throw');
    const cleanupPost = scenario.includes('drain-') ? Promise.withResolvers() : undefined;
    const drainTimers = new Map();
    if (unavailableSdk) {
      Object.defineProperty(fixture.panel.webview, 'postMessage', { configurable: false, writable: false });
      fixture.originals[2].descriptor = Object.getOwnPropertyDescriptor(fixture.panel.webview, 'postMessage');
    }
    const reference = { uri: fixture.uri, index: prefixFailure ? 102 : 104, path: prefixFailure ? 'prefix.kqlx' : 'typespec.kqlx', expectedOpenFileId: 'wf_unit', ...(prefixFailure ? { sectionIds: ['query-unique'] } : {}) };
    const owner = activationFailure ? undefined : {};
    const outcome = { classification: 'SETUP_BLOCKED', calls: [], models: [], damage: [], saved: [], errors: [], checks: { evidenceSink: true }, evidenceFailures: [], evidenceFailureCount: 0, configuration: {}, dispatcherObservation: {} };
    const chat = { uri: { scheme: 'chatSessionInput', toString: () => 'chatSessionInput:input-0' }, version: 2, isDirty: false, languageId: 'plaintext', get getText() { assert.fail('Do not read the preserved Chat body'); } };
    class TabInputCustom {
      constructor(uri) { this.uri = { toString: () => uri }; this.viewType = 'kusto.kqlxEditor'; }
    }
    let insideSdk = false;
    const extension = { isActive: false, activate: async () => {
      lifecycle.push('activate');
      fixture.register();
      if (activationFailure) throw new Error('original activation failure');
    } };
    const context = createContext({ assert, process: { ...process, env: traceFixture.environment }, modules: traceFixture.modules, Promise, path, performance, phase: 'setup', owner, evidenceRoot: 'memory-only', outcome, extension,
      setTimeout(callback, delay) {
        if (delay === 5000) { drainTimers.set(3, callback); return 3; }
        if (delay === 4000) {
          drainTimers.set(2, callback);
          if (scenario.endsWith('renderer-timeout')) queueMicrotask(callback);
          return 2;
        }
        assert.equal(delay, 2000); lifecycle.push('drain-wait');
        if (drainThrow) throw new Error('original drain failure');
        drainTimers.set(1, callback);
        queueMicrotask(() => { cleanupPost.resolve(true); if (drainTimeout) callback(); });
        return 1;
      }, clearTimeout(id) { drainTimers.delete(id); },
      dispatcherObserver: undefined, references: new Map([[reference.uri, reference]]), selected: [reference], targetPath: 'typespec.kqlx',
      settings: [], subscriptions: [{ dispose() { lifecycle.push('dispose-subscription'); if (cleanupFailure) throw new Error('original subscription failure'); } }],
      fs: { writeFileSync(file) { assert.equal(insideSdk, false, 'No evidence I/O in SDK observation'); writes.push(file); if (sinkFailure && (scenario !== 'final-checkpoint-sink' || file.endsWith('final-outcome.json'))) throw new Error('evidence writer failed'); } },
      workbenchRequire: name => { assert.equal(name, 'vscode'); return fixture.facade; },
      tabs: () => {
        if (scenario.endsWith('renderer-tab-error') && outcome.errors.length === 1 && outcome.rendererAfterFirstFailure === undefined) throw new Error('Transient diagnostic tab read failed');
        return currentTabs;
      }, tabSnapshot: () => currentTabs.map(tab => ({ dirty: tab.isDirty })),
      preservation: label => { lifecycle.push(label); return { passed: true }; },
      helper: { assertAcceptanceRoot(candidate) { assert.equal(candidate, owner); }, closeAcceptanceTabs: async (_vscode, candidate, uris) => {
        assert.equal(candidate, owner);
        assert.deepEqual(Array.from(uris), [fixture.uri]);
        lifecycle.push('close-owned');
        insideSdk = true;
        fixture.emit({ type: 'documentReloadApplied', viewSessionId: 'session', applied: false });
        if (cleanupPost) { fixture.behavior.postResult = cleanupPost.promise; fixture.panel.webview.postMessage({ type: 'kustoPublicationCommit' }); }
        insideSdk = false;
        currentTabs.length = 0;
        if (cleanupFailure) throw new Error('original close failure');
        return { onlyOwnedTabs: true, survivors: 0 };
      } },
      vscode: { TabInputCustom, workspace: { textDocuments: [chat] }, lm: { invokeTool: async (name, options) => {
        assert.equal(name, 'kusto-workbench_activate-workbench-file');
        assert.equal(options.input.targetFileUri, fixture.uri);
        lifecycle.push('first-public-call');
        insideSdk = true;
        fixture.resolve();
        fixture.panel.webview.postMessage({ type: 'mainWebviewDispatcherProbe', probeId: 'product-probe' });
        fixture.emit({ type: 'mainWebviewDispatcherReady', probeId: 'product-probe', runtimeId: 'runtime' });
        insideSdk = false;
        currentTabs.push({ input: new TabInputCustom(fixture.uri), isDirty: false, isActive: true });
        return { content: [{ value: JSON.stringify({ success: !firstFailure, error: firstFailure ? 'retained cold first failure' : undefined, isLiveWorkbench: true, isReadOnlyFallback: false, uri: reference.uri, openFileId: reference.expectedOpenFileId }) }] };
      } } },
    });
    const result = await new Script(`(async () => { ${metadataBody} ${admission} ${writeBody} ${observerBody} try { ${tail} })()`).runInContext(context);
    assert.equal(result.classification, prefixFailure ? 'PREFIX_FIRST_ACTIVATION_FAILED' : firstFailure ? 'TYPESPEC_FIRST_ACTIVATION_FAILED' : activationFailure ? 'SETUP_BLOCKED' : sinkFailure || unavailableSdk || drainTimeout ? 'EVIDENCE_OR_CLEANUP_FAILED' : 'PASS');
    assert.equal(result.calls.length, activationFailure ? 0 : 1);
    assert.equal(result.dispatcherObservation.restored, true);
    assert.equal(result.dispatcherObservation.complete, !activationFailure && !unavailableSdk && !drainThrow);
    assert.equal(result.dispatcherObservation.observed, !activationFailure && !unavailableSdk);
    assert.equal(chat.version, 2);
    assert.equal(chat.isDirty, false);
    assert.equal(result.damage.length, 0);
    assert.equal(result.evidenceFailureCount > 0, sinkFailure);
    if (firstFailure) {
      assert.equal(result.calls[0].value.error, 'retained cold first failure');
      assert.equal(result.calls[0].oraclePassed, false);
      assert.ok(result.errors.some(error => error.phase === `first-activation-${reference.index}`));
      if (prefixFailure) assert.equal(result.rendererAfterFirstFailure.status, scenario.endsWith('renderer-timeout') ? 'timeout' : scenario.endsWith('renderer-error') || scenario.endsWith('renderer-wrong-frame') || scenario.endsWith('renderer-tab-error') ? 'unavailable' : 'available');
    }
    if (cleanupFailure) {
      assert.ok(result.errors.some(error => error.phase === 'cleanup'));
      assert.ok(result.errors.some(error => error.phase === 'subscription-disposal'));
      const checkpointWriter = new Script('(() => { ' + writeBody + '; return write; })()').runInContext(context);
      for (let index = 0; index < 32; index++) checkpointWriter('bounded-checkpoint-' + index, {});
      assert.equal(outcome.evidenceFailures.length, 16);
      assert.ok(outcome.evidenceFailureCount > 16);
      assert.equal(outcome.classification, 'TYPESPEC_FIRST_ACTIVATION_FAILED');
    }
    if (!activationFailure) {
      assert.equal(result.dispatcherObservation.records.at(-1).phase, 'cleanup');
      assert.ok(lifecycle.indexOf('close-owned') < lifecycle.indexOf('dispose-subscription'));
      assert.equal(result.dispatcherDrain.status, drainThrow ? 'failed' : drainTimeout ? 'timeout' : 'settled');
      if (cleanupPost) {
        assert.ok(lifecycle.indexOf('close-owned') < lifecycle.indexOf('drain-wait'));
        assert.ok(lifecycle.indexOf('drain-wait') < lifecycle.indexOf('after-cleanup'));
        assert.ok(lifecycle.indexOf('after-cleanup') < lifecycle.indexOf('dispose-subscription'));
      }
      if (drainTimeout || drainThrow) assert.equal(result.checks.dispatcherObservation, false);
      assert.equal(fixture.listeners.get(fixture.panel).size, 1);
    }
    assert.equal(drainTimers.size, 0);
    fixture.assertRestored();
    assert.ok(writes.length > 0);
  }
});

test('agent run-mode execution senders carry complete non-mutating lifecycle proof', () => {
  const feature = fs.readFileSync(new URL('../vscode-extension-tester/e2e/default/kusto-agent-run-mode/kusto-agent-run-mode.feature', import.meta.url), 'utf8');
  const senders = [...feature.matchAll(/When I evaluate "(.*)" in the webview/g)].map(match => match[1])
    .filter(expression => expression.includes("type: 'toolConfigureQuerySection'") && expression.includes('execute: true'));
  assert.equal(senders.length, 2);
  for (const expression of senders) {
    const section = { boxId: 'query_run_mode',
      getSchemaLifecycleIdentity: () => ({ sectionInstanceId: 'run-mode-instance', targetGeneration: 4 }),
      getConnectionId: () => 'e2e-stub-conn', getClusterUrl: () => 'https://e2e-stub.kusto.windows.net', getDatabase: () => 'StubDb' };
    const sent = [];
    new Script(expression).runInNewContext({ document: { querySelector: () => section }, window: { postMessage: message => sent.push(message) } });
    assert.equal(sent.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(sent[0].expectedKustoTarget ?? null)), {
      sectionId: section.boxId, sectionInstanceId: 'run-mode-instance', targetGeneration: 4,
      connectionId: 'e2e-stub-conn', clusterUrl: 'https://e2e-stub.kusto.windows.net', database: 'StubDb',
    });
    assert.equal(sent[0].input.execute, true);
    assert.match(sent[0].input.query, /^StormEvents \| (take 10|count)$/);
    for (const key of ['connectionId', 'clusterUrl', 'database']) assert.equal(Object.hasOwn(sent[0].input, key), false);
  }
});

test('prepared Kusto baseline preserves duplicate tabs and does not change profile settings', async () => {
  const feature = fs.readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/archive-original-canary-baseline/archive-original-canary-baseline.feature', import.meta.url), 'utf8');
  const body = feature.slice(feature.indexOf('const preserveStartingTabs ='), feature.indexOf('const previous ='));
  const preserve = new Script('(() => { ' + body + '; return preserveStartingTabs; })()').runInNewContext();
  const tab = { uri: 'file:///existing.kqlx', type: 'kusto.kqlxEditor', dirty: false };
  assert.equal(preserve([tab, { ...tab }], [{ ...tab }]), false);
  assert.equal(preserve([tab, { ...tab }], [{ ...tab }, { ...tab }]), true);
  assert.equal(preserve([tab], [{ ...tab, type: 'other.editor' }]), false);
  assert.equal(preserve([tab], [{ ...tab, dirty: true }]), false);
  assert.equal(preserve([tab], [{ ...tab, active: false }]), true);
  const settings = feature.slice(feature.indexOf('if (!preparedProfile) {'), feature.indexOf("if (vscode.workspace.getConfiguration('workbench.editor').get"));
  let updates = 0;
  const context = createContext({ preparedProfile: 'kusto-auth', vscode: { ConfigurationTarget: { Global: 1 }, workspace: { getConfiguration: () => ({ update: () => { updates++; } }) } } });
  const script = new Script('(async () => { ' + settings + ' })()');
  await script.runInContext(context);
  assert.equal(updates, 0);
  context.preparedProfile = undefined;
  await script.runInContext(context);
  assert.equal(updates, 3);
});

test('original archive diagnostic requires the exact document URI and gates diagnostic failures', () => {
  const feature = fs.readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/archive-original-canary-baseline/archive-original-canary-baseline.feature', import.meta.url), 'utf8');
  const helper = feature.slice(feature.indexOf('const assertSavedDocument ='), feature.indexOf('const tabs ='));
  const assertSavedDocument = new Script('(() => { ' + helper + '; return assertSavedDocument; })()').runInNewContext();
  const uri = 'file:///c%3A/private/new/extension-regression-2026-10-07.kqlx';
  const matching = { documentUri: uri, boundArtifactId: 'result:original:3' };
  assert.equal(assertSavedDocument(matching, uri), matching);
  for (const snapshot of [undefined, {}, { documentUri: '' }, { documentUri: 'file:///c%3A/private/old/extension-regression-2026-10-07.kqlx' }]) assert.throws(() => assertSavedDocument(snapshot, uri), /Exact task-owned notebook URI/);
  assert.ok(feature.includes('(${assertSavedDocument.toString()})(binding, ${JSON.stringify(canary.toString())})'));
  const branch = feature.slice(feature.indexOf('if (process.env.KW_ARCHIVE_CDP_MODULE ||'), feature.indexOf("if (typeof openFileId === 'string'"));
  assert.ok(branch.includes('outcome.checks.savedDataDiagnostic = false'));
  const guardStatement = 'assertSavedDocument(outcome.savedDataDiagnostic.binding';
  const successStatement = 'outcome.checks.savedDataDiagnostic = true';
  const assertGuardOrder = candidate => {
    const guardOffset = candidate.indexOf(guardStatement);
    const successOffset = candidate.indexOf(successStatement);
    assert.ok(guardOffset >= 0, 'Missing returned-document guard');
    assert.ok(successOffset >= 0, 'Missing diagnostic success statement');
    assert.ok(guardOffset < successOffset, 'Diagnostic success precedes the returned-document guard');
  };
  assertGuardOrder(branch);
  assert.throws(() => assertGuardOrder(branch.replace(guardStatement, 'removedGuard')), /Missing returned-document guard/);
  assert.throws(() => assertGuardOrder(branch.replace(successStatement, 'removedSuccess')), /Missing diagnostic success statement/);
  assert.throws(() => assertGuardOrder(`${successStatement}; ${guardStatement}`), /Diagnostic success precedes/);
  assert.ok(feature.includes('Object.values(outcome.checks).every(value => value === true)'));
});

test('private profile runner quotes paths and refuses shell input', () => {
  const runner = require('../vscode-extension-tester/e2e/opt-in/archive-original-canary-baseline/profile-runner.cjs');
  assert.equal(runner.quoteArgumentValue('C:\\test profile\\source', 'win32'), '"C:\\test profile\\source"');
  assert.equal(runner.quoteArgumentValue('/tmp/test profile/source', 'linux'), '/tmp/test profile/source');
  for (const unsafe of ['', 'path&other', 'path|other', '%TEMP%', 'path"other', 'path\nother']) assert.throws(() => runner.quoteArgumentValue(unsafe, 'win32'), /Unsafe CLI argument/);
});

test('private profile runner checks owned paths, unchanged config and canonical files before launch', async context => {
  const runner = require('../vscode-extension-tester/e2e/opt-in/archive-original-canary-baseline/profile-runner.cjs');
  const owner = acceptanceHarness.createAcceptanceRoot();
  context.after(() => fs.rmSync(owner.root, { recursive: true, force: true }));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  const mainFile = path.resolve(sourceRoot, manifest.main);
  const vscodeExecutablePath = path.join(sourceRoot, '.vscode-test/vscode-win32-x64-archive-1.141.0/Code.exe');
  if (!fs.existsSync(mainFile) || !fs.existsSync(vscodeExecutablePath)
    || createHash('sha256').update(fs.readFileSync(mainFile)).digest('hex') !== '16e4a21e1580a9b4602a84b3d921a5c429bdf3df40359011c5089591fb4a3059') {
    context.skip('The recorded Windows source build and native test editor are required for this config validation; no substitute build or editor');
    return;
  }
  const directories = Object.fromEntries(Object.entries({ userDataDir: 'user-data', extensionsDir: 'extensions', sharedDataDir: 'shared-data', workspaceDir: 'workspace', evidenceDir: 'profile-evidence' })
    .map(([key, name]) => { const value = path.join(owner.root, name); fs.mkdirSync(value); return [key, value]; }));
  const config = { schemaVersion: 1, owner, expectedSourceRoot: sourceRoot, mainFile, mainSha256: createHash('sha256').update(fs.readFileSync(mainFile)).digest('hex'), ...directories,
    profileName: 'KW-Wave4-Starting-State-Isolated-' + path.basename(owner.root).slice('kw-acceptance-'.length), vscodeExecutablePath,
    vscodeExecutableSha256: createHash('sha256').update(fs.readFileSync(vscodeExecutablePath)).digest('hex') };
  const configPath = path.join(owner.root, 'profile-config.json');
  const store = value => { const bytes = JSON.stringify(value); fs.writeFileSync(configPath, bytes); return createHash('sha256').update(bytes).digest('hex'); };
  const originalHash = store(config);
  assert.equal((await runner.validateConfig(configPath, originalHash)).userDataDir, directories.userDataDir);
  if (process.platform === 'win32') {
    const nativeCase = { ...config, expectedSourceRoot: sourceRoot.toLowerCase(), mainFile: mainFile.toLowerCase() };
    assert.equal((await runner.validateConfig(configPath, store(nativeCase))).mainSha256, config.mainSha256);
  }
  store({ ...config, profileName: 'wrong-profile' });
  await assert.rejects(runner.validateConfig(configPath, originalHash), /Private config changed/);
  const escapedHash = store({ ...config, userDataDir: os.tmpdir() });
  await assert.rejects(runner.validateConfig(configPath, escapedHash), /Unexpected owned directory/);
  store(config);
  const alias = path.join(owner.root, 'config-alias.json');
  fs.linkSync(configPath, alias);
  await assert.rejects(runner.validateConfig(configPath, originalHash), /Refusing a link, hardlink or wrong path type/);
  fs.unlinkSync(alias);
  assert.equal((await runner.validateConfig(configPath, originalHash)).profileName, config.profileName);
});

test('private profile runner accepts only local storage inside its owned profile', context => {
  const runner = require('../vscode-extension-tester/e2e/opt-in/archive-original-canary-baseline/profile-runner.cjs');
  const owner = acceptanceHarness.createAcceptanceRoot();
  context.after(() => fs.rmSync(owner.root, { recursive: true, force: true }));
  const userData = path.join(owner.root, 'user-data');
  fs.mkdirSync(userData);
  const storage = path.join(userData, 'User', 'globalStorage', 'test-owner');
  for (const scheme of ['file', 'vscode-userdata']) assert.equal(runner.assertStorageUri({ scheme, authority: '', fsPath: storage }, userData), storage);
  assert.throws(() => runner.assertStorageUri({ scheme: 'vscode-remote', authority: '', fsPath: storage }, userData), /Local native storage URI required/);
  assert.throws(() => runner.assertStorageUri({ scheme: 'vscode-userdata', authority: 'remote', fsPath: storage }, userData), /Remote native storage/);
  assert.throws(() => runner.assertStorageUri({ scheme: 'vscode-userdata', authority: '', fsPath: os.tmpdir() }, userData), /escaped the owned directory/);
});

test('private profile runner fails a stalled phase without claiming work was cancelled', async () => {
  const runner = require('../vscode-extension-tester/e2e/opt-in/archive-original-canary-baseline/profile-runner.cjs');
  assert.equal(await runner.deadline(Promise.resolve('finished'), 50, 'Prepare'), 'finished');
  await assert.rejects(runner.deadline(new Promise(() => {}), 5, 'Prepare'), error => error.name === 'NativePhaseDeadlineError' && /physical work is not cancelled/.test(error.message));
});

test('standalone archive repros are opt-in and refuse reusable-profile suite dispatch before setup', async () => {
  for (const name of ['archive-public-activation-repro', 'archive-original-canary-baseline']) {
    const directory = new URL('../vscode-extension-tester/e2e/opt-in/' + name + '/', import.meta.url);
    const settings = JSON.parse(fs.readFileSync(new URL('e2e.settings.json', directory), 'utf8'));
    assert.equal(settings.optIn, true);
    assert.equal(settings.timeout, 180000);
    const feature = fs.readFileSync(new URL(name + '.feature', directory), 'utf8');
    const guard = feature.match(/if \(process\.env\.KUSTO_WORKBENCH_E2E_BYPASS_FIRST_LAUNCH[^\n]+/)[0];
    for (const bypass of ['0', '1']) {
      const context = createContext({ process: { env: { KUSTO_WORKBENCH_E2E_BYPASS_FIRST_LAUNCH: bypass } } });
      await assert.rejects(new Script('(async () => { ' + guard + ' })()').runInContext(context), /standalone repro requires its documented fresh-host command/);
    }
    assert.doesNotThrow(() => new Script(guard).runInContext(createContext({ process: { env: {} } })));
  }
});

test('timed archive repro keeps the recorded clock and preserves late starts', async () => {
  const feature = fs.readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/archive-public-activation-repro/archive-public-activation-repro.feature', import.meta.url), 'utf8');
  const body = feature.slice(feature.indexOf('const waitRecordedOffset ='), feature.indexOf('let observer;'));
  let now = 9000;
  const scheduled = [];
  const receipts = [];
  const state = { recordedTiming: { mode: 'wave4' }, initialGate: true, replayStart: 10000, timingEvents: [] };
  const context = createContext({ state, Date: { now: () => now },
    setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); },
    write: (name, value) => receipts.push({ name, value }) });
  const wait = new Script('(() => { ' + body + '; return waitRecordedOffset; })()').runInContext(context);
  const pending = wait(500, 'historical-1');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 1500);
  assert.equal(receipts.length, 0);
  now = 10500;
  scheduled[0].callback();
  await pending;
  assert.equal(state.timingEvents[0].lateByMs, 0);
  now = 11000;
  await wait(800, 'historical-2');
  assert.equal(scheduled.length, 1, 'A late start must not delay again or restart the original clock');
  assert.equal(state.timingEvents[1].lateByMs, 200);
  assert.equal(state.replayStart, 10000);
  state.initialGate = false;
  await assert.rejects(wait(900, 'before-baseline'), /before a healthy baseline/);
  state.initialGate = true;
  await assert.rejects(wait(200000, 'oversized-wait'), /existing step budget/);
  state.recordedTiming = null;
  await wait(undefined, 'fast-mode');
  assert.equal(receipts.length, 2);
});

test('isolated archive repro rejects equal but mismatching executing method proofs', () => {
  const feature = fs.readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/archive-public-activation-repro/archive-public-activation-repro.feature', import.meta.url), 'utf8');
  const body = feature.slice(feature.indexOf('const loadedProof ='), feature.indexOf('const sampleDocument ='));
  const names = ['collectOpenWorkbenchFiles', 'listSections', 'manageDevelopmentNotes', 'validateHtmlDashboard', 'activateWorkbenchFile'];
  const current = function currentRuntime() { return 'current'; };
  const stale = function staleRuntime() { return 'stale'; };
  const owner = { context: { extensionMode: 2, extensionPath: '/source' }, ...Object.fromEntries(names.map(name => [name, current])) };
  const context = createContext({ workbenchRequire: { cache: { main: { filename: '/source/main.js', loaded: true, exports: { toolOrchestrator: owner } } } },
    main: '/source/main.js', sourceRoot: '/source', samePath: (left, right) => left === right,
    fs: { readFileSync: () => current.toString() }, hash: value => createHash('sha256').update(value).digest('hex'),
    vscode: { version: 'unit-only', ExtensionMode: { Development: 2 } }, extension: { packageJSON: { version: 'unit-only' } } });
  const script = new Script('(() => { ' + body + '; return loadedProof(); })()');
  assert.ok(script.runInContext(context).methods.every(method => method.matchesMain === true));
  owner.listSections = stale;
  for (let checkpoint = 0; checkpoint < 2; checkpoint++) assert.throws(() => script.runInContext(context), /executing method does not match source main: listSections/);
  delete owner.listSections;
  assert.throws(() => script.runInContext(context), /loaded method absent: listSections/);
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

test('current133 API acceptance is explicit, geometry-independent and never qualifies an incomplete release', () => {
  const input = ['--vsix', 'candidate.vsix', '--expected-sha', 'a'.repeat(64), '--before-archive', 'wave3-before.zip', '--order-archive', 'original-order.zip'];
  const options = parseArgs([...input, '--acceptance', 'current133-api']);
  assert.equal(options.acceptance, 'current133-api');
  assert.equal(options.cdpPort, null);
  assert.equal(options.autosave, 'afterDelay');
  assert.equal(options.repeats, 1);
  assert.equal(parseArgs([...input, '--acceptance', 'original109']).acceptance, 'original109');
  assert.throws(() => parseArgs(input), /explicit --acceptance/);
  const evidence = acceptanceEvidence();
  evidence.acceptance.mode = 'current133-api';
  evidence.acceptance.archive.baselineCount = 133;
  evidence.acceptance.archive.sourceCount = 133;
  evidence.acceptance.pixels = { status: 'UNATTEMPTED', captures: [] };
  evidence.acceptance.lifecycle = { nativeAuthoring: 'UNATTEMPTED' };
  const result = classify(evidence, false);
  assert.equal(result.primary, 'HARNESS_BLOCKED');
  assert.equal(result.acceptanceQualified, false);
  assert.equal(result.visualReview, 'human-unreviewed');
});

test('readonly registered API results use their literal shapes, not a universal success flag', () => {
  const reply = value => ({ content: [{ value: JSON.stringify(value) }] });
  for (const [name, value] of [
    ['kusto-workbench_list-connections', { connections: [{ id: 'saved', name: 'Saved', clusterUrl: 'https://example.test' }] }],
    ['kusto-workbench_list-sections', { sections: [], openFiles: [] }],
  ]) {
    assert.deepEqual(acceptanceHarness.parseAcceptanceToolResult(name, reply(value)), value);
    assert.throws(() => acceptanceHarness.parseAcceptanceToolResult(name, reply({ success: true })), /shape|failed/i);
    assert.throws(() => acceptanceHarness.parseAcceptanceToolResult(name, reply({ ...value, success: false, error: 'Snapshot unavailable' })), /Snapshot unavailable/);
  }
  assert.throws(() => acceptanceHarness.parseAcceptanceToolResult('kusto-workbench_activate-workbench-file', reply({ uri: 'file:///owned.kqlx' })), /failed|shape/i);
  assert.throws(() => acceptanceHarness.parseAcceptanceToolResult('kusto-workbench_manage-development-notes', { content: [{ value: 'Error: Snapshot timed out' }] }), /Snapshot timed out/);
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

const acceptanceEvidence = () => {
  const order = Array.from({ length: 109 }, (_, index) => `past/target-${index + 1}.kqlx`);
  order[82] = 'past/azure-mcp-growth-analysis.kqlx';
  order[87] = 'past/azure-mcp-vs-tool-calls-investigation.kqlx';
  order[108] = 'upgraded-kql-files/historical_success_rate copy.kql';
  const expected = { installedPath: 'C:/TEMP/kw-acceptance-test/product', mainPath: 'C:/TEMP/kw-acceptance-test/product/dist/extension.js',
    vsixSha256: 'a'.repeat(64), mainSha256: 'b'.repeat(64), treeSha256: 'c'.repeat(64), vscodeVersion: '1.141.0', sourceHead: 'd'.repeat(40), sourcePatchSha256: 'e'.repeat(64) };
  const loaded = { ...expected, extensionMode: 1, contextObserved: true, contextPath: expected.installedPath,
    moduleCacheLoaded: true, moduleCachePath: expected.mainPath, driverExtensionMode: 2 };
  const phases = ['cold-controls', 'cold-menu', 'cold-escape', 'historical-83', 'historical-88', 'historical-109', 'reopened-controls', 'second-interaction'];
  const ownedRoot = 'C:/TEMP/kw-acceptance-test';
  const legacyPath = 'extension-fix-validation-empty-legacy-2026-09-12.kqlx';
  order[19] = legacyPath;
  const coldPath = path.join(ownedRoot, 'cold-canary', legacyPath);
  const coldUri = pathToFileURL(coldPath).href;
  const coldCanary = { count: 1, checkedSourceCount: 1, root: path.join(ownedRoot, 'cold-canary'), rootMarker: '3'.repeat(48),
    filePath: coldPath, path: 'cold-canary/' + legacyPath, uri: coldUri, sourcePath: legacyPath,
    sourceUri: pathToFileURL(path.join(ownedRoot, 'history', legacyPath)).href, bytes: 498, sha256: '2'.repeat(64), sourceSha256: '2'.repeat(64),
    sectionId: 'legacy', verified: true, markerVerified: true, aliasFree: true };
  const coldTab = { uri: coldUri, fsPath: coldPath, viewType: 'kusto.kqlxEditor', isCustom: true, isDirty: false, isActive: true };
  const tabReadiness = { expected: { uri: coldUri, fsPath: coldPath, viewType: coldTab.viewType }, active: { ...coldTab }, tabs: [{ ...coldTab }],
    document: { uri: coldUri, version: 1, isDirty: false, sha256: '2'.repeat(64) } };
  const captures = phases.map((phase, index) => {
    const geometry = controlGeometryFixture(phase);
    const relative = phase === 'historical-83' ? order[82] : phase === 'historical-88' ? order[87] : phase === 'historical-109' ? order[108]
      : phase === 'second-interaction' ? 'original109-authoring.kqlx' : legacyPath;
    const uri = phase.startsWith('historical-') || phase === 'second-interaction' ? pathToFileURL(path.join(ownedRoot, 'history', relative)).href : coldUri;
    geometry.target.uri = uri;
    geometry.target.panel.uri = uri;
    geometry.capture.resolvedContext.resolutionId = index + 1;
    geometry.capture.webviewSynchronization.resolutionId = index + 1;
    const controlProof = acceptanceHarness.correlateControlRegions(geometry.probe, geometry.target, geometry.capture, geometry.documents);
    return { ...geometry.capture, controlProof, decoded: true, controlsNonblank: true, sha256: '1'.repeat(64),
      regions: controlProof.regions.map(region => ({ ...region, samples: 1000, uniqueColors: 40, luminanceRange: 120, edgePixels: 180, chromaticPixels: 100,
        sha256: phase === 'cold-escape' && region.name === 'query-menu' ? 'b'.repeat(64) : 'a'.repeat(64) })) };
  });
  return {
    acceptanceRequired: true,
    cli: { exitCode: 0 }, results: { completed: true, failedSteps: [] },
    summary: { verdict: 'PASS_UNREVIEWED_VISUAL', operations: [] }, journal: { harnessFailures: [], metrics: {} },
    revisions: { present: true, total: 2, texts: 2, invalid: [], invalidDiskReads: [], preservation: [], rawChanges: [], malformedLines: 0 },
    saveLogs: { errors: [] },
    acceptance: {
      schemaVersion: 1, mode: 'original109',
      archive: { verified: true, immutableBeforeImages: true, beforeSha256: 'f'.repeat(64), orderSha256: '0'.repeat(64), baselineCount: 131, sourceCount: 131, sidecarsSeparate: true, linksConfined: true, linkedTargetCount: 0 },
      expectedOrder: order, activationOrder: [...order],
      historicalInventories: ['full109', 'closed', 'reopened'].map(phase => ({ phase, retainedCount: 109, exactPaths: [...order], allClean: true })),
      cold: { firstWorkbenchActivation: true, firstToolTarget: 'openFileId', activationPhase: 'exact-active', activationCalls: 1, warmingCalls: 0, legacyBytes: 498,
        controlsReady: true, menuOpened: true, escapeDismissed: true, blankExecutions: 0, uri: coldUri, path: coldCanary.path, sectionId: 'legacy',
        firstMetadataId: { uri: coldUri, openFileId: 'exact-cold-id', matchingCount: 1, lookupCount: 1, source: 'metadata-only' },
        tabReadiness: { before: structuredClone(tabReadiness), after: structuredClone(tabReadiness) } },
      coldCanary: { ...coldCanary, exactBytes: true, allRevisionsClean: true, versionsStable: true, dirtyTransitions: [], byteChanges: [], versionChanges: [],
        revisions: ['open:cold-open', 'before-close', 'close:before-close', 'open:closed', 'reopened'].map((phase, index) => ({ phase, openGeneration: index < 3 ? 1 : 2,
          documentVersion: 1, isDirty: false, sha256: coldCanary.sha256, expectedModelSha256: coldCanary.sha256 })),
        setupSaves: 0, rebaselines: 0, checkpoints: ['before-cold', 'cold', 'hidden', 'revealed', 'closed', 'reopened', 'full109'] },
      execution: { source: 'actual-workbench-vscode-facade', status: 'complete', registrationObserved: true, coldPanelObserved: true,
        restored: true, ingressCount: 0, startCount: 0, blankExecutions: 0, events: [], blockers: [],
        panels: captures.map(capture => ({ uri: capture.controlProof.uri, generation: capture.controlProof.panelGeneration, handle: capture.controlProof.panelHandle })) },
      untouched: { checkedSourceCount: 131, exactBytes: true, allRevisionsClean: true, dirtyTransitions: [], byteChanges: [], setupSaves: 0, rebaselines: 0,
        checkpoints: ['cold', 'hidden', 'revealed', 'closed', 'reopened', 'full109'] },
      lifecycle: { authoring: true, nativeSave: true, reopen: true, secondInteraction: true },
      notes: ['initial', 'hidden', 'reactivated', 'reopened', 'second-interaction'].map(phase => ({ phase, success: true, exact: true, notes: [{ id: 'sweep-note', content: 'survive activation sweep' }] })),
      dashboard: { success: true, valid: true, bindingCount: 6, dataSourceCount: 1, issues: [] },
      fixtureOwnership: { status: 'legitimate-production-owner', path: 'offline-query', forged: false, developmentSeeds: false },
      identity: { expected, before: { ...loaded }, after: { ...loaded }, parentFinal: { ...expected } },
      collection: { ownedRoot, archiveVerified: true, coldCanary: { ...coldCanary }, expectedBuildIdentity: { ...expected } },
      pixels: { status: 'cpu-verified-unreviewed', captures, capabilityBlockers: [] },
      cleanup: { canonicalTempRoot: true, markerVerified: true, aliasFree: true, dirtyDiscard: false, onlyOwnedTabs: true, preservedFailures: true, survivors: 0 },
    },
  };
};

test('acceptance classifier admits only complete original109 evidence and keeps visuals human-unreviewed', () => {
  const result = classify(acceptanceEvidence(), false);
  assert.equal(result.primary, 'PASS_UNREVIEWED_VISUAL');
  assert.equal(result.acceptanceQualified, true);
  assert.equal(result.visualReview, 'human-unreviewed');
});

const currentApiEvidence = () => {
  const evidence = acceptanceEvidence();
  const acceptance = evidence.acceptance;
  const canary = { path: 'extension-regression-2026-10-07.kqlx', count: 1, bytes: 28864,
    sha256: 'eeafb29fdb57398dbb6e2a83a7aec0fd5b2cc658f12e156f671fdfee144f51e0', resultGraphSha256: '6'.repeat(64),
    sectionIds: ['markdown_1791393457389', 'section_fe0a7d53-90a4-4805-88e0-74c6fa4893ea', 'html_1791393873620', 'chart_1791393694412',
      'transformation_1791393768756', 'query_1791393180464', 'sql_8f650c71-569e-47b9-9bf2-0a9d20817fb8', 'devnotes_1791393497223', 'url_1791393561128', 'python_1791393561354'],
    factSectionId: 'section_fe0a7d53-90a4-4805-88e0-74c6fa4893ea', htmlSectionId: 'html_1791393873620',
    factColumns: [{ name: 'EventTime', type: 'datetime' }, { name: 'Category', type: 'string' }, { name: 'Value', type: 'long' }, { name: 'Status', type: 'string' }],
    bindingIds: ['totalValue', 'valueByCategory', 'valueOverTime', 'valueByStatus', 'factRows', 'categoryTables'],
    note: { id: 'dn_1791393497188_yncr7k', created: '2026-10-07T17:18:17.188Z', updated: '2026-10-07T17:18:17.188Z', category: 'gotcha',
      relatedSectionIds: ['section_fe0a7d53-90a4-4805-88e0-74c6fa4893ea', 'markdown_1791393457389'],
      content: 'Regression bridge canary 2026-10-07: after legacy-file activation, listSections alone is insufficient. This note must still be returned by manageDevelopmentNotes(view), and dashboard validation must still accept the exact target.', source: 'agent' } };
  const uri = pathToFileURL(path.join(acceptance.collection.ownedRoot, 'history', canary.path)).href;
  acceptance.mode = 'current133-api';
  evidence.acceptanceMode = 'current133-api';
  evidence.summary.verdict = 'API_PRESERVATION_COMPLETE';
  Object.assign(acceptance.archive, { baselineCount: 133, sourceCount: 133, structuredCount: 101,
    beforeSha256: 'c5d02675d4702277a1769ec7f4fca0bd6948174ef9a4b37e72e2f9f0a89bc52f' });
  acceptance.archivedCanary = canary;
  Object.assign(acceptance.collection, { archivedCanary: structuredClone(canary), expectedOrder: [...acceptance.expectedOrder],
    runtimeVerified: { before: true, after: true, panelOwners: true } });
  const canaryTab = { uri, fsPath: fileURLToPath(uri), viewType: 'kusto.kqlxEditor', isCustom: true, isDirty: false, isActive: true };
  const tabReadiness = { expected: { uri, fsPath: canaryTab.fsPath, viewType: canaryTab.viewType }, active: { ...canaryTab }, tabs: [{ ...canaryTab }] };
  acceptance.api = { status: 'complete', warmReport: true, uri, openFileId: 'archived-exact-id', initialActivationCalls: 1,
    initialActivation: { success: true, uri, openFileId: 'archived-exact-id' },
    tabReadiness: { before: structuredClone(tabReadiness), after: structuredClone(tabReadiness) }, activationCalls: 1,
    activation: { success: true, uri, openFileId: 'archived-exact-id' }, snapshotFailures: [], autoRevealEvents: [],
    phases: ['initial', 'full109', 'hidden', 'reactivated', 'closed'],
    history: acceptance.expectedOrder.map((relative, index) => {
      const targetFileUri = pathToFileURL(path.join(acceptance.collection.ownedRoot, 'history', relative)).href;
      return { path: relative, uri: targetFileUri, exact: true, snapshot: true, firstCallPassed: true,
        firstActivation: { name: 'kusto-workbench_activate-workbench-file', phase: 'historical-' + (index + 1), input: { targetFileUri }, success: true,
          value: { success: true, uri: targetFileUri, openFileId: 'historical-' + index, isLiveWorkbench: true, isReadOnlyFallback: false } } };
    }),
    checks: ['initial', 'hidden', 'reactivated'].map(phase => ({ phase, uri, openFileId: 'archived-exact-id', noAutoReveal: true,
      activeBefore: phase === 'hidden' ? 'file:///owned-hide.txt' : uri, activeAfter: phase === 'hidden' ? 'file:///owned-hide.txt' : uri,
      hidden: phase === 'hidden', bridge: { uri, liveConnectionCount: 1, snapshotCallbackObserved: true } })) };
  acceptance.notes = ['initial', 'hidden', 'reactivated'].map(phase => ({ phase, uri, openFileId: 'archived-exact-id', success: true, exact: true, notes: [structuredClone(canary.note)] }));
  acceptance.dashboards = ['initial', 'hidden', 'reactivated'].map(phase => ({ phase, uri, openFileId: 'archived-exact-id', sectionId: canary.htmlSectionId,
    success: true, valid: true, hasProvenance: true, bindingCount: 6, dataSourceCount: 1, factColumns: structuredClone(canary.factColumns), issues: [], diagnostics: [], exactTarget: true }));
  Object.assign(acceptance.untouched, { checkedSourceCount: 133, versionsStable: true, versionChanges: [],
    checkpoints: ['prepared', 'initial', 'full109', 'hidden', 'reactivated', 'before-cleanup', 'after-cleanup'] });
  Object.assign(acceptance.coldCanary, { revisions: [], checkpoints: [...acceptance.untouched.checkpoints] });
  acceptance.historicalInventories = ['full109', 'hidden', 'reactivated', 'before-cleanup'].map(phase => ({ phase, retainedCount: 109, exactPaths: [...acceptance.expectedOrder], allClean: true }));
  acceptance.lifecycle = { nativeAuthoring: 'UNATTEMPTED' };
  acceptance.pixels = { status: 'UNATTEMPTED', captures: [], humanReview: 'human-unreviewed' };
  acceptance.roles = { archive: 133, cold: 1, authoring: 1, canary: 1, authoringUnopened: true, authoringExactBytes: true };
  acceptance.fixtureOwnership = { status: 'legitimate-production-owner', path: 'archived-native-admission', forged: false, developmentSeeds: false };
  const runtime = { source: 'executing-require-cache', methods: ['constructor', 'collectOpenWorkbenchFiles', 'listSections', 'manageDevelopmentNotes', 'validateHtmlDashboard', 'activateWorkbenchFile']
    .map(name => ({ name, sha256: '7'.repeat(64), offset: 0, length: 20, matchesPackage: true })) };
  Object.assign(acceptance.identity.expected, { dependenciesSha256: '8'.repeat(64), assetTrees: { monaco: '9'.repeat(64), css: 'a'.repeat(64), scripts: 'b'.repeat(64) } });
  acceptance.collection.expectedBuildIdentity = structuredClone(acceptance.identity.expected);
  for (const phase of ['before', 'after', 'parentFinal']) Object.assign(acceptance.identity[phase], {
    dependenciesSha256: acceptance.identity.expected.dependenciesSha256, assetTrees: structuredClone(acceptance.identity.expected.assetTrees), runtime: structuredClone(runtime) });
  return evidence;
};

test('current133 API classifier credits the composed readonly path without native geometry, authoring or release qualification', () => {
  const result = classify(currentApiEvidence(), false);
  assert.equal(result.primary, 'API_PRESERVATION_VERIFIED_NOT_RELEASE');
  assert.equal(result.apiPreservationQualified, true);
  assert.equal(result.acceptanceQualified, false);
  assert.equal(result.nativeAuthoring, 'UNATTEMPTED');
  assert.equal(result.pixels, 'UNATTEMPTED');
  assert.equal(result.visualReview, 'human-unreviewed');
});

test('current133 API classifier admits SDK encoded-drive URIs while retaining exact SDK URI/ID targeting', () => {
  const evidence = currentApiEvidence();
  const sdkUri = value => value.replace(/^file:\/\/\/([A-Z]):\//, (match, drive) => 'file:///' + drive.toLowerCase() + '%3A/');
  const state = evidence.acceptance;
  state.api.uri = sdkUri(state.api.uri);
  state.api.initialActivation.uri = state.api.uri;
  for (const readiness of Object.values(state.api.tabReadiness)) {
    for (const entry of [readiness.expected, readiness.active, ...readiness.tabs]) entry.uri = sdkUri(entry.uri);
  }
  state.api.activation.uri = state.api.uri;
  for (const entry of [...state.api.history, ...state.api.checks, ...state.notes, ...state.dashboards]) {
    entry.uri = sdkUri(entry.uri);
    if (entry.firstActivation) {
      entry.firstActivation.input.targetFileUri = entry.uri;
      entry.firstActivation.value.uri = entry.uri;
    }
    if (entry.activeBefore) entry.activeBefore = sdkUri(entry.activeBefore);
    if (entry.activeAfter) entry.activeAfter = sdkUri(entry.activeAfter);
    if (entry.bridge) entry.bridge.uri = sdkUri(entry.bridge.uri);
  }
  assert.equal(classify(evidence, false).primary, 'API_PRESERVATION_VERIFIED_NOT_RELEASE');
  state.notes[1].uri = pathToFileURL(path.join(state.collection.ownedRoot, 'other-role', state.archivedCanary.path)).href;
  assert.notEqual(classify(evidence, false).primary, 'API_PRESERVATION_VERIFIED_NOT_RELEASE', 'A matching basename in another role is never an exact target');
});

const initialApiOwnerEvidence = () => {
  const evidence = currentApiEvidence();
  const state = evidence.acceptance;
  const failure = 'BLOCKED: StageSetupBlockingOwner: unchanged archived canary was not lawfully admitted; no fake result values, auth seed, query or offline-query substitution';
  evidence.cli.exitCode = 1;
  evidence.results = { completed: false, failedSteps: [{ text: 'Initial readonly API admission', error: failure }] };
  evidence.summary = { verdict: 'HARNESS_BLOCKED', failure, operations: [
    { phase: 'initial', name: 'kusto-workbench_manage-development-notes', success: false, error: 'Result owner unavailable' },
    { phase: 'initial', name: 'kusto-workbench_validate-html-dashboard', success: true },
  ] };
  state.operations = evidence.summary.operations;
  state.failures = [{ phase: 'initial', error: failure }];
  state.fixtureOwnership.status = 'blocked';
  state.fixtureOwnership.reason = 'StageSetupBlockingOwner: archived native admission unattempted; no auth seed or query execution authorized';
  Object.assign(state.api, { status: 'observing', activationCalls: 0, activation: null, phases: ['initial'], history: [],
    checks: [{ ...state.api.checks[0], oraclesExact: false }] });
  state.activationOrder = [];
  state.historicalInventories = [];
  state.untouched.checkpoints = ['prepared', 'initial'];
  state.notes = [{ ...state.notes[0], success: false, exact: false, notes: null, error: 'Result owner unavailable' }];
  state.dashboards = [{ ...state.dashboards[0], valid: false, hasProvenance: false, dataSourceCount: 0,
    factColumns: [], issues: [{ message: 'Result owner unavailable' }] }];
  return evidence;
};

for (const [name, change, expected, ownerStop] of [
  ['initial missing provenance', () => {}, 'HARNESS_BLOCKED', true],
  ['initial missing result owner', value => { value.acceptance.dashboards[0].hasProvenance = true; }, 'HARNESS_BLOCKED', true],
  ['initial bridge transport timeout', value => {
    value.summary.operations.forEach(operation => { operation.success = false; operation.error = 'Request timed out'; });
    value.acceptance.notes[0].error = 'Request timed out';
    Object.assign(value.acceptance.dashboards[0], { success: false, error: 'Request timed out' });
  }, 'WORKFLOW_FAILED', false],
  ['initial note timeout with admitted dashboard', value => {
    value.summary.operations[0].error = 'Request timed out';
    value.acceptance.notes[0].error = 'Request timed out';
    value.acceptance.dashboards = [currentApiEvidence().acceptance.dashboards[0]];
  }, 'WORKFLOW_FAILED', false],
  ...['full109', 'hidden', 'reactivated'].map(phase => [phase + ' failure after admitted baseline', value => {
    Object.assign(value, currentApiEvidence());
    value.cli.exitCode = 1;
    value.results.completed = false;
    value.summary = { verdict: 'HARNESS_BLOCKED', failure: 'Request timed out', operations: [
      { phase, name: phase === 'reactivated' ? 'kusto-workbench_activate-workbench-file' : 'kusto-workbench_manage-development-notes', success: false, error: 'Request timed out' },
    ] };
    value.acceptance.operations = value.summary.operations;
    value.acceptance.failures = [{ phase, error: value.summary.failure }];
    value.acceptance.api.status = 'partial';
  }, 'WORKFLOW_FAILED', false]),
  ['invalid root despite initial owner stop', value => { value.summary.verdict = 'HARNESS_BLOCKED_SETUP'; value.revisions.invalid.push({ revision: 1 }); }, 'CORRUPTION_OBSERVED', true],
  ['serialized bytes changed despite initial owner stop', value => { value.revisions.rawChanges.push({ revision: 1 }); }, 'PRESERVATION_FAILED', true],
  ['dirty revision despite initial owner stop', value => { value.acceptance.untouched.dirtyTransitions.push({ isDirty: true }); }, 'PRESERVATION_FAILED', true],
]) test('current133 API setup classifier preserves ' + name, () => {
  const evidence = initialApiOwnerEvidence();
  change(evidence);
  const retained = structuredClone(evidence);
  const result = classify(evidence, false);
  assert.equal(result.primary, expected);
  assert.equal(result.rawStatus, ownerStop ? 'StageSetupBlockingOwner' : undefined);
  assert.equal(result.apiPreservationQualified, false);
  assert.equal(result.acceptanceQualified, false);
  assert.equal(result.nativeAuthoring, 'UNATTEMPTED');
  assert.equal(result.pixels, 'UNATTEMPTED');
  assert.equal(result.flags.includes('WORKFLOW_FAILED'), expected === 'WORKFLOW_FAILED');
  assert.ok(result.reasons.every(reason => reason.trim().length > 0));
  if (expected === 'HARNESS_BLOCKED') assert.ok(result.reasons.some(reason => reason.startsWith('HARNESS_BLOCKED_SETUP:') && reason.includes('StageSetupBlockingOwner')));
  if (!ownerStop) {
    assert.ok(result.reasons.some(reason => reason.includes('Request timed out')));
    assert.ok(result.reasons.every(reason => !reason.includes('StageSetupBlockingOwner')), 'A retained setup label cannot establish an owner/authentication cause without admission metadata');
  }
  assert.deepEqual(evidence, retained, 'Never rewrite failed operations, ownership proof or the first failed artifact');
});

for (const [name, change, expected, error] of [
  ['initial activation record missing', value => { delete value.acceptance.api.initialActivation; }, 'HARNESS_BLOCKED'],
  ['initial activation count missing', value => { delete value.acceptance.api.initialActivationCalls; }, 'HARNESS_BLOCKED'],
  ['initial activation repeated', value => { value.acceptance.api.initialActivationCalls = 2; }, 'HARNESS_BLOCKED'],
  ['initial activation returned another target', value => { value.acceptance.api.initialActivation.uri = 'file:///neighbor.kqlx'; }, 'HARNESS_BLOCKED'],
  ['initial SDK tab observation missing', value => { delete value.acceptance.api.tabReadiness; }, 'HARNESS_BLOCKED'],
  ['initial SDK tab dirty', value => { value.acceptance.api.tabReadiness.before.tabs[0].isDirty = true; }, 'HARNESS_BLOCKED'],
  ['initial SDK tab duplicated', value => { value.acceptance.api.tabReadiness.before.tabs.push({ ...value.acceptance.api.tabReadiness.before.tabs[0] }); }, 'HARNESS_BLOCKED'],
  ['initial SDK editor type wrong', value => { value.acceptance.api.tabReadiness.before.tabs[0].viewType = 'neighbor.editor'; }, 'HARNESS_BLOCKED'],
  ['post-initial SDK focus wrong', value => { value.acceptance.api.tabReadiness.after.active.uri = 'file:///neighbor.kqlx'; }, 'HARNESS_BLOCKED'],
  ['separate cold ledger missing', value => { delete value.acceptance.coldCanary; }, 'HARNESS_BLOCKED'],
  ['separate cold independent inspection missing', value => { delete value.acceptance.collection.coldCanary; }, 'HARNESS_BLOCKED'],
  ['separate cold bytes changed then reverted', value => { value.acceptance.coldCanary.byteChanges.push({ origin: 'disk' }); }, 'PRESERVATION_FAILED'],
  ['separate cold dirty then reverted', value => { value.acceptance.coldCanary.dirtyTransitions.push({ isDirty: true }); }, 'PRESERVATION_FAILED'],
  ['separate cold version changed', value => { value.acceptance.coldCanary.versionChanges.push({ documentVersion: 2 }); }, 'PRESERVATION_FAILED'],
  ['separate cold setup Save', value => { value.acceptance.coldCanary.setupSaves = 1; }, 'HARNESS_BLOCKED'],
  ['separate cold rebaseline', value => { value.acceptance.coldCanary.rebaselines = 1; }, 'HARNESS_BLOCKED'],
  ['separate cold checkpoint missing', value => { value.acceptance.coldCanary.checkpoints.pop(); }, 'HARNESS_BLOCKED'],
  ['hidden note missing', value => { value.acceptance.notes.splice(1, 1); }, 'HARNESS_BLOCKED'],
  ['hidden dashboard timeout without a recorded tool', value => { value.acceptance.dashboards[1] = { phase: 'hidden', success: false, error: 'DashboardRequestTimedOut' }; }, 'HARNESS_BLOCKED'],
  ['hidden dashboard missing', value => { value.acceptance.dashboards.splice(1, 1); }, 'HARNESS_BLOCKED'],
  ['partial88', value => { value.acceptance.activationOrder.length = 88; }, 'HARNESS_BLOCKED'],
  ['observed historical API result unavailable', value => {
    Object.assign(value.acceptance.api.history[78], { snapshot: false, sectionCount: 0, error: 'Historical snapshot budget exhausted' });
    value.summary.operations.push({ phase: 'full109', name: 'kusto-workbench_list-sections', success: true });
  }, 'WORKFLOW_FAILED', 'Historical snapshot budget exhausted'],
  ['historical snapshot false with a successful literal wrapper', value => {
    Object.assign(value.acceptance.api.history[78], { snapshot: false, sectionCount: 0, error: null });
    value.summary.operations.push({ phase: 'full109', name: 'kusto-workbench_list-sections', success: true });
  }, 'WORKFLOW_FAILED'],
  ['historical snapshot observation missing', value => { delete value.acceptance.api.history[78].snapshot; }, 'HARNESS_BLOCKED'],
  ['historical snapshot row missing', value => { value.acceptance.api.history.splice(78, 1); }, 'HARNESS_BLOCKED'],
  ['first historical activation missing despite healthy later snapshot', value => { delete value.acceptance.api.history[78].firstActivation; }, 'HARNESS_BLOCKED'],
  ['first historical activation rejected despite healthy later snapshot', value => {
    const entry = value.acceptance.api.history[78];
    entry.firstCallPassed = false;
    Object.assign(entry.firstActivation, { success: false, error: 'First live bridge rejected', value: { success: false, uri: entry.uri } });
  }, 'WORKFLOW_FAILED', 'First live bridge rejected'],
  ['first historical rejection cannot be healed by changing its summary flag', value => {
    const entry = value.acceptance.api.history[78];
    Object.assign(entry.firstActivation.value, { success: false, error: 'Retained first rejection' });
  }, 'WORKFLOW_FAILED'],
  ['second ordinary activation', value => { value.acceptance.api.activationCalls = 2; }, 'HARNESS_BLOCKED'],
  ['sole activation returned false', value => {
    Object.assign(value.acceptance.api.activation, { success: false, error: 'Exact activation unready' });
    value.summary.operations.push({ phase: 'reactivated', name: 'kusto-workbench_activate-workbench-file', success: true });
  }, 'WORKFLOW_FAILED', 'Exact activation unready'],
  ['earlier failed snapshot later looked healthy', value => {
    value.acceptance.api.snapshotFailures.push({ phase: 'full109', uri: value.acceptance.api.history[78].uri, error: 'Earlier snapshot failed' });
    value.summary.operations.push({ phase: 'full109', name: 'kusto-workbench_list-sections', success: true });
  }, 'WORKFLOW_FAILED', 'Earlier snapshot failed'],
  ['transient hidden reveal reverted', value => { value.acceptance.api.autoRevealEvents.push({ phase: 'hidden', event: 'tab-active' }); }, 'HARNESS_BLOCKED'],
  ['dashboard returned a different exact target', value => {
    value.acceptance.dashboards[1].exactTarget = false;
    value.summary.operations.push({ phase: 'hidden', name: 'kusto-workbench_validate-html-dashboard', success: true });
  }, 'WORKFLOW_FAILED'],
  ['hidden full oracle returned a retained timeout', value => {
    Object.assign(value.acceptance.dashboards[1], { success: false, valid: false, hasProvenance: false, exactTarget: false,
      bindingCount: 0, dataSourceCount: 0, factColumns: [], error: 'DashboardRequestTimedOut' });
    value.summary.operations.push({ phase: 'hidden', name: 'kusto-workbench_validate-html-dashboard', success: true });
  }, 'WORKFLOW_FAILED', 'DashboardRequestTimedOut'],
  ['hidden native projection returned unavailable flags and zero counts', value => {
    Object.assign(value.acceptance.dashboards[1], { valid: false, hasProvenance: false, exactTarget: false,
      bindingCount: 0, dataSourceCount: 0, factColumns: [], error: 'Native result projection unavailable' });
    value.summary.operations.push({ phase: 'hidden', name: 'kusto-workbench_validate-html-dashboard', success: true });
  }, 'WORKFLOW_FAILED', 'Native result projection unavailable'],
  ['reactivated numeric binding count changed', value => {
    value.acceptance.dashboards[2].bindingCount = 0;
    value.summary.operations.push({ phase: 'reactivated', name: 'kusto-workbench_validate-html-dashboard', success: true });
  }, 'WORKFLOW_FAILED'],
  ['hidden note returned an empty success', value => {
    Object.assign(value.acceptance.notes[1], { exact: false, notes: [] });
    value.summary.operations.push({ phase: 'hidden', name: 'kusto-workbench_manage-development-notes', success: true });
  }, 'WORKFLOW_FAILED'],
  ['hidden read auto revealed', value => { value.acceptance.api.checks[1].activeAfter = value.acceptance.api.uri; }, 'HARNESS_BLOCKED'],
  ['changed note metadata', value => {
    value.acceptance.notes[1].notes[0].relatedSectionIds.reverse();
    value.summary.operations.push({ phase: 'hidden', name: 'kusto-workbench_manage-development-notes', success: true });
  }, 'WORKFLOW_FAILED'],
  ['hidden data source count has an invalid type', value => {
    value.acceptance.dashboards[1].dataSourceCount = '0';
    value.summary.operations.push({ phase: 'hidden', name: 'kusto-workbench_validate-html-dashboard', success: true });
  }, 'HARNESS_SUSPECT'],
  ['hidden binding count has an invalid type', value => {
    value.acceptance.dashboards[1].bindingCount = false;
    value.summary.operations.push({ phase: 'hidden', name: 'kusto-workbench_validate-html-dashboard', success: true });
  }, 'HARNESS_SUSPECT'],
  ['hidden dashboard count observation missing', value => {
    delete value.acceptance.dashboards[1].dataSourceCount;
    value.summary.operations.push({ phase: 'hidden', name: 'kusto-workbench_validate-html-dashboard', success: true });
  }, 'HARNESS_BLOCKED'],
  ['ownership label without an initial full note cannot prove admission', value => {
    value.acceptance.notes.splice(0, 1);
    value.acceptance.api.history[78].snapshot = false;
    value.summary.operations.push({ phase: 'full109', name: 'kusto-workbench_list-sections', success: true });
  }, 'HARNESS_BLOCKED'],
  ['ownership label without initial dashboard bindings cannot prove admission', value => {
    value.acceptance.dashboards[0].bindingCount = 0;
    value.acceptance.api.history[78].snapshot = false;
    value.summary.operations.push({ phase: 'full109', name: 'kusto-workbench_list-sections', success: true });
  }, 'HARNESS_BLOCKED'],
  ['same-count changed result graph', value => { value.acceptance.archivedCanary.resultGraphSha256 = 'f'.repeat(64); }, 'HARNESS_BLOCKED'],
  ['changed133 count', value => { value.acceptance.archive.sourceCount = 131; }, 'HARNESS_BLOCKED'],
  ['transient model version', value => { value.acceptance.untouched.versionChanges.push({ path: 'historical.kqlx' }); }, 'PRESERVATION_FAILED'],
  ['unlawful archived owner', value => { value.acceptance.fixtureOwnership.status = 'blocked'; }, 'HARNESS_BLOCKED'],
  ['loaded old runtime', value => { value.acceptance.identity.before.runtime.methods[0].matchesPackage = false; }, 'HARNESS_BLOCKED'],
  ['matching orchestrator without executing panel-owner proof', value => { value.acceptance.collection.runtimeVerified.panelOwners = false; }, 'HARNESS_BLOCKED'],
  ['executing panel-owner proof missing', value => { delete value.acceptance.collection.runtimeVerified.panelOwners; }, 'HARNESS_BLOCKED'],
  ['parent runtime verification missing', value => { delete value.acceptance.collection.runtimeVerified; }, 'HARNESS_BLOCKED'],
  ['native capture attempted', value => { value.acceptance.pixels.status = 'cpu-verified-unreviewed'; }, 'HARNESS_BLOCKED'],
  ['source dependency drift', value => { value.acceptance.identity.after.dependenciesSha256 = '0'.repeat(64); }, 'HARNESS_BLOCKED'],
]) test('current133 API classifier preserves negative evidence for ' + name, () => {
  const evidence = currentApiEvidence();
  change(evidence);
  const retained = structuredClone(evidence);
  const result = classify(evidence, false);
  assert.equal(result.primary, expected);
  assert.notEqual(result.primary, 'API_PRESERVATION_VERIFIED_NOT_RELEASE');
  assert.equal(result.apiPreservationQualified, false);
  assert.equal(result.acceptanceQualified, false);
  assert.equal(result.nativeAuthoring, 'UNATTEMPTED');
  assert.equal(result.pixels, evidence.acceptance.pixels.status);
  assert.equal(result.rawStatus, undefined);
  assert.equal(result.flags.includes('WORKFLOW_FAILED'), expected === 'WORKFLOW_FAILED');
  if (error) assert.ok(result.reasons.some(reason => reason.includes(error)), 'Retain the exact observed API error');
  assert.deepEqual(evidence, retained, 'Classification must not rewrite the recorded result, error or admission evidence');
});

test('acceptance control paths bind cold/reopened frames to the separate copy and historical frames to the unchanged archive', () => {
  const evidence = acceptanceEvidence().acceptance;
  for (const phase of ['cold-controls', 'cold-menu', 'cold-escape', 'reopened-controls']) {
    assert.equal(acceptanceHarness.acceptanceControlPath(phase, evidence.expectedOrder, evidence.coldCanary.path), evidence.coldCanary.path);
    assert.notEqual(evidence.coldCanary.uri, evidence.coldCanary.sourceUri);
  }
  for (const ordinal of [83, 88, 109]) assert.equal(acceptanceHarness.acceptanceControlPath('historical-' + ordinal, evidence.expectedOrder, evidence.coldCanary.path), 'history/' + evidence.expectedOrder[ordinal - 1]);
  assert.equal(acceptanceHarness.acceptanceControlPath('second-interaction', evidence.expectedOrder, evidence.coldCanary.path), 'history/original109-authoring.kqlx');
  assert.equal(evidence.expectedOrder[19], evidence.coldCanary.sourcePath);
});

for (const [name, change] of [
  ['cold copy missing', value => { delete value.acceptance.coldCanary; }],
  ['cold count blended into the archive', value => { value.acceptance.archive.sourceCount = 132; value.acceptance.untouched.checkedSourceCount = 132; }],
  ['two cold copies', value => { value.acceptance.coldCanary.count = 2; }],
  ['missing independent cold inspection', value => { delete value.acceptance.collection.coldCanary; }],
  ['cold copy reused as archival target20', value => { value.acceptance.coldCanary.sourceUri = value.acceptance.coldCanary.uri; }],
  ['original target20 replaced in the order', value => { value.acceptance.expectedOrder[19] = value.acceptance.coldCanary.path; value.acceptance.activationOrder[19] = value.acceptance.coldCanary.path; }],
  ['cold URI points at the archival original', value => { value.acceptance.cold.uri = value.acceptance.coldCanary.sourceUri; }],
  ['cold parent hash changed', value => { value.acceptance.collection.coldCanary.sha256 = '4'.repeat(64); }],
  ['cold root marker changed', value => { value.acceptance.coldCanary.rootMarker = '4'.repeat(48); }],
  ['cold source hash changed', value => { value.acceptance.coldCanary.sourceSha256 = '4'.repeat(64); }],
  ['cold dirty then reverted', value => { value.acceptance.coldCanary.dirtyTransitions.push({ isDirty: true }); }],
  ['cold bytes changed then reverted', value => { value.acceptance.coldCanary.byteChanges.push({ origin: 'buffer' }); }],
  ['cold same-generation version changed', value => { value.acceptance.coldCanary.revisions[1].documentVersion++; }],
  ['cold close/reopen observer missing', value => { value.acceptance.coldCanary.checkpoints = ['cold', 'full109']; }],
  ['cold setup Save', value => { value.acceptance.coldCanary.setupSaves = 1; }],
  ['cold rebaseline', value => { value.acceptance.coldCanary.rebaselines = 1; }],
  ['first cold metadata lookup repeated', value => { value.acceptance.cold.firstMetadataId.lookupCount = 2; }],
  ['first metadata ID from archival original', value => { value.acceptance.cold.firstMetadataId.uri = value.acceptance.coldCanary.sourceUri; }],
  ['cold frame from archival original', value => { const capture = value.acceptance.pixels.captures[0]; capture.controlProof = { ...capture.controlProof, uri: value.acceptance.coldCanary.sourceUri }; }],
]) test('acceptance classifier rejects ' + name + ' without lowering exact109 or blending131', () => {
  const evidence = acceptanceEvidence();
  change(evidence);
  assert.equal(classify(evidence, false).acceptanceQualified, false);
  assert.notEqual(classify(evidence, false).primary, 'PASS_UNREVIEWED_VISUAL');
});

test('acceptance classifier permits onboarding focus before the sole activation but requires exact focus afterward', () => {
  const evidence = acceptanceEvidence();
  const before = evidence.acceptance.cold.tabReadiness.before;
  before.active = { uri: null, viewType: 'kustoWorkbench.firstLaunchSetup', isCustom: false, isDirty: false, isActive: true };
  before.tabs[0].isActive = false;
  before.tabs.push({ ...before.active });
  assert.equal(classify(evidence, false).primary, 'PASS_UNREVIEWED_VISUAL');
});

test('acceptance classifier reports unattempted composed Production fixtures as blocked, never product failure or completion', () => {
  const evidence = acceptanceEvidence();
  evidence.acceptance.fixtureOwnership = { status: 'blocked', path: null, forged: false, developmentSeeds: false };
  evidence.acceptance.notes = [];
  evidence.acceptance.dashboard = null;
  evidence.summary.verdict = 'PARTIAL_ACCEPTANCE_ONLY';
  const result = classify(evidence, false);
  assert.equal(result.primary, 'HARNESS_BLOCKED');
  assert.equal(result.acceptanceQualified, false);
  assert.ok(result.reasons.some(reason => reason.includes('Production result owner')));
});

for (const [name, damage, expected] of [
  ['without damage', () => {}, 'HARNESS_BLOCKED'],
  ['with primary corruption', value => { value.revisions.invalid.push({ revision: 1 }); }, 'CORRUPTION_OBSERVED'],
  ['with the first invalid artifact', value => { value.firstInvalid = true; }, 'CORRUPTION_OBSERVED'],
  ['with primary preservation damage', value => { value.revisions.preservation.push({ revision: 1 }); }, 'PRESERVATION_FAILED'],
  ['with primary serialized byte damage', value => { value.revisions.rawChanges.push({ revision: 1 }); }, 'PRESERVATION_FAILED'],
  ...['invalid', 'preservation', 'rawChanges'].map(field => ['with related ' + field + ' damage', value => {
    value.relatedRevisions = [{ file: 'linked/revisions.jsonl', invalid: [], preservation: [], rawChanges: [], invalidDiskReads: [], malformedLines: 0,
      [field]: [{ revision: 1 }] }];
  }, field === 'invalid' ? 'CORRUPTION_OBSERVED' : 'PRESERVATION_FAILED']),
  ['with related corruption and primary preservation damage', value => {
    value.revisions.preservation.push({ revision: 1 });
    value.relatedRevisions = [{ file: 'linked/revisions.jsonl', invalid: [{ revision: 1 }], preservation: [], rawChanges: [], invalidDiskReads: [], malformedLines: 0 }];
  }, 'CORRUPTION_OBSERVED'],
]) test('acceptance classifier treats the retained first-artifact zero-tool stop ' + name + ' with exact damage priority', () => {
  const evidence = acceptanceEvidence();
  evidence.cli.exitCode = 1;
  evidence.results = { completed: false, failedSteps: [{ text: 'I collect JSON artifact "original109-isolation" from extension host expression:',
    error: 'Exact owned URI is not active; no healthy-neighbor substitution' }] };
  evidence.summary = { verdict: 'WORKFLOW_FAILED', failure: evidence.results.failedSteps[0].error, operations: [] };
  evidence.acceptance.cold = { ...evidence.acceptance.cold, firstToolTarget: null, activationCalls: 0, controlsReady: false, menuOpened: false, escapeDismissed: false };
  delete evidence.acceptance.cold.activationPhase;
  evidence.acceptance.operations = [];
  evidence.acceptance.failures = [{ phase: 'cold-open', error: evidence.summary.failure }];
  evidence.acceptance.activationOrder = [];
  evidence.acceptance.historicalInventories = [];
  evidence.acceptance.untouched.checkpoints = [];
  evidence.acceptance.lifecycle = {};
  evidence.acceptance.fixtureOwnership.status = 'blocked';
  evidence.acceptance.notes = [];
  evidence.acceptance.dashboard = null;
  evidence.acceptance.pixels.captures = [];
  damage(evidence);
  const retained = structuredClone(evidence);
  const result = classify(evidence, false);
  assert.equal(result.primary, expected);
  assert.equal(result.acceptanceQualified, false);
  if (expected === 'HARNESS_BLOCKED') {
    assert.equal(result.flags.includes('WORKFLOW_FAILED'), false);
    assert.ok(result.reasons.some(reason => /setup.*before.*activat/i.test(reason)));
  }
  assert.equal(evidence.summary.verdict, 'WORKFLOW_FAILED', 'Never rewrite the preserved first failed artifact');
  assert.deepEqual(evidence, retained, 'All primary and related revision ledgers must remain unchanged');
});

test('acceptance classifier requires observed execution ingress and starts, not an always-zero blank counter', () => {
  const evidence = acceptanceEvidence();
  delete evidence.acceptance.execution;
  assert.equal(evidence.acceptance.cold.blankExecutions, 0);
  assert.equal(classify(evidence, false).primary, 'HARNESS_BLOCKED');
});

test('acceptance unavailable native capability stays bounded partial BLOCKED without inventing a product failure', () => {
  const evidence = acceptanceEvidence();
  evidence.summary = { verdict: 'HARNESS_BLOCKED', failure: 'BLOCKED: native frame geometry unavailable', operations: [] };
  evidence.results.completed = false;
  evidence.cli.exitCode = 1;
  evidence.acceptance.fixtureOwnership.status = 'blocked';
  evidence.acceptance.cold.menuOpened = false;
  evidence.acceptance.cold.escapeDismissed = false;
  evidence.acceptance.activationOrder = [];
  evidence.acceptance.historicalInventories = [];
  evidence.acceptance.notes = [];
  evidence.acceptance.dashboard = null;
  evidence.acceptance.lifecycle = {};
  evidence.acceptance.pixels = { status: 'cpu-evidence-blocked', capabilityBlockers: [{ phase: 'cold-controls', error: evidence.summary.failure }],
    captures: [{ phase: 'cold-controls', blocked: true, error: evidence.summary.failure }] };
  const result = classify(evidence, false);
  assert.equal(result.primary, 'HARNESS_BLOCKED');
  assert.equal(result.acceptanceQualified, false);
  assert.equal(result.flags.includes('WORKFLOW_FAILED'), false);
  assert.ok(result.reasons.some(reason => reason.includes('native')));
});

test('acceptance execution observer uses the supplied Workbench facade and counts a rejected blank ingress before production routing', () => {
  const coldUri = 'file:///C:/TEMP/kw-acceptance-unit/history/cold.kqlx';
  const listeners = [];
  const calls = [];
  const registration = {};
  const result = Promise.resolve(false);
  const panel = { webview: { _handle: 'actual-panel-handle', cspSource: 'vscode-webview://actual-panel-handle',
    onDidReceiveMessage: listener => { listeners.push(listener); return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) }; },
    postMessage(message) { calls.push({ kind: 'outbound', message, receiver: this }); return result; } } };
  const originalResolve = function (document, target) {
    calls.push({ kind: 'resolve', receiver: this, document, target });
    target.webview.onDidReceiveMessage(message => calls.push({ kind: 'production-route', message }));
    return result;
  };
  const provider = { resolveCustomTextEditor: originalResolve };
  const originalRegister = function (viewType, candidate, options) {
    calls.push({ kind: 'register', receiver: this, viewType, candidate, options });
    return registration;
  };
  const facade = { window: { registerCustomEditorProvider: originalRegister } };
  const controllerFacade = { window: { registerCustomEditorProvider() { assert.fail('Never wrap the controller facade'); } } };
  const registerDescriptor = Object.getOwnPropertyDescriptor(facade.window, 'registerCustomEditorProvider');
  const resolveDescriptor = Object.getOwnPropertyDescriptor(provider, 'resolveCustomTextEditor');
  const postDescriptor = Object.getOwnPropertyDescriptor(panel.webview, 'postMessage');
  const observer = acceptanceHarness.observeAcceptanceExecutionBoundary(facade, { ownedUris: new Set([coldUri]), coldUri, coldSectionId: 'legacy' });
  assert.equal(controllerFacade.window.registerCustomEditorProvider.name, 'registerCustomEditorProvider');
  assert.equal(facade.window.registerCustomEditorProvider('kusto.kqlxEditor', provider, { supportsMultipleEditorsPerDocument: false }), registration);
  assert.equal(provider.resolveCustomTextEditor({ uri: { toString: () => coldUri } }, panel), result, 'Preserve the original promise and receiver');
  assert.equal(observer.snapshot().coldPanelObserved, true);
  assert.equal(observer.snapshot().ingressCount, 0);
  const blank = { type: 'executeQuery', boxId: 'legacy', query: '', executionId: 'one-rejected-request' };
  for (const listener of [...listeners]) listener(blank);
  assert.equal(observer.snapshot().ingressCount, 1);
  assert.equal(observer.snapshot().startCount, 0);
  assert.equal(observer.snapshot().blankExecutions, 1);
  assert.equal(calls.filter(call => call.kind === 'production-route').length, 1, 'Do not suppress, replay or modify production ingress');
  assert.equal(calls.find(call => call.kind === 'production-route').message, blank);
  const start = { type: 'kustoExecutionStarted', boxId: 'legacy', executionId: blank.executionId };
  assert.equal(panel.webview.postMessage(start), result);
  assert.equal(observer.snapshot().startCount, 1);
  assert.equal(observer.snapshot().events[0].queryLength, 0);
  assert.equal(observer.snapshot().events[0].uri, coldUri);
  assert.equal(observer.snapshot().panels[0].handle, 'actual-panel-handle');
  assert.equal(calls.find(call => call.kind === 'resolve').receiver, provider);
  assert.equal(calls.find(call => call.kind === 'register').receiver, facade.window);
  assert.equal(calls.find(call => call.kind === 'outbound').receiver, panel.webview);
  assert.equal(observer.restore().restored, true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(facade.window, 'registerCustomEditorProvider'), registerDescriptor);
  assert.deepEqual(Object.getOwnPropertyDescriptor(provider, 'resolveCustomTextEditor'), resolveDescriptor);
  assert.deepEqual(Object.getOwnPropertyDescriptor(panel.webview, 'postMessage'), postDescriptor);
  assert.equal(listeners.length, 1, 'Dispose only the test-owned observer');
  assert.equal(observer.snapshot().events.length, 2, 'Preserve the failed execution evidence after cleanup');
});

test('acceptance execution observation without a writable actual boundary is explicitly blocked, never reported as zero', () => {
  const facade = { window: Object.freeze({ registerCustomEditorProvider() { assert.fail('Unavailable hooks must not invoke production'); } }) };
  const observer = acceptanceHarness.observeAcceptanceExecutionBoundary(facade, { ownedUris: new Set(), coldUri: 'file:///owned/cold.kqlx', coldSectionId: 'legacy' });
  const result = observer.snapshot();
  assert.equal(result.status, 'blocked');
  assert.equal(result.ingressCount, null);
  assert.equal(result.startCount, null);
  assert.equal(result.blankExecutions, null);
  assert.match(result.blockers[0], /writable|boundary|capability/i);
  assert.equal(observer.restore().restored, true);
});

test('acceptance execution observer never wraps a non-owned panel or fabricates an execution', () => {
  const facade = { window: { registerCustomEditorProvider: () => undefined } };
  const provider = { resolveCustomTextEditor: () => 'unchanged' };
  const outsider = { webview: { onDidReceiveMessage() { assert.fail('Do not observe another owner'); }, postMessage() { assert.fail('Do not send fake starts'); } } };
  const originalPost = outsider.webview.postMessage;
  const observer = acceptanceHarness.observeAcceptanceExecutionBoundary(facade, { ownedUris: new Set(['file:///owned/cold.kqlx']), coldUri: 'file:///owned/cold.kqlx', coldSectionId: 'legacy' });
  facade.window.registerCustomEditorProvider('kusto.kqlxEditor', provider);
  assert.equal(provider.resolveCustomTextEditor({ uri: { toString: () => 'file:///unowned/original.kqlx' } }, outsider), 'unchanged');
  assert.equal(outsider.webview.postMessage, originalPost);
  assert.equal(observer.snapshot().coldPanelObserved, false);
  assert.equal(observer.snapshot().blankExecutions, null);
  assert.equal(observer.restore().restored, true);
});

test('acceptance execution observation is bounded and never heals overflow back to zero', () => {
  const uri = 'file:///owned/cold.kqlx';
  const listeners = [];
  let routes = 0;
  const panel = { webview: { onDidReceiveMessage: listener => { listeners.push(listener); return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) }; }, postMessage: () => undefined } };
  const facade = { window: { registerCustomEditorProvider: () => undefined } };
  const provider = { resolveCustomTextEditor: () => { listeners.push(() => routes++); } };
  const observer = acceptanceHarness.observeAcceptanceExecutionBoundary(facade, { ownedUris: new Set([uri]), coldUri: uri, coldSectionId: 'legacy' });
  facade.window.registerCustomEditorProvider('kusto.kqlxEditor', provider);
  provider.resolveCustomTextEditor({ uri: { toString: () => uri } }, panel);
  for (let index = 0; index < 520; index++) for (const listener of [...listeners]) listener({ type: 'executeQuery', boxId: 'legacy', query: '' });
  assert.equal(routes, 520, 'Keep original routing intact even when observation is blocked');
  const observation = observer.snapshot();
  assert.equal(observation.status, 'blocked');
  assert.equal(observation.events.length, 512);
  assert.equal(observation.blankExecutions, null);
  assert.equal(observation.blockers.length, 1);
  assert.match(observation.blockers[0], /512-event bound/);
  assert.equal(observer.restore().restored, true);
  assert.equal(observer.snapshot().status, 'blocked');
});

test('acceptance execution cleanup does not overwrite a replacement wrapper and cannot claim exact restoration', () => {
  const facade = { window: { registerCustomEditorProvider: () => undefined } };
  const observer = acceptanceHarness.observeAcceptanceExecutionBoundary(facade, { ownedUris: new Set(), coldUri: 'file:///owned/cold.kqlx', coldSectionId: 'legacy' });
  const replacement = () => 'independent replacement';
  facade.window.registerCustomEditorProvider = replacement;
  const result = observer.restore();
  assert.equal(result.restored, false);
  assert.equal(result.status, 'blocked');
  assert.equal(facade.window.registerCustomEditorProvider, replacement);
  assert.match(result.blockers[0], /Exact execution wrapper changed/);
});

test('acceptance writer observation is opt-in and the default never inspects workspace applyEdit', () => {
  let reads = 0;
  const facade = { window: { registerCustomEditorProvider: () => undefined } };
  Object.defineProperty(facade, 'workspace', { get() { reads++; throw new Error('Must remain unread'); } });
  const observer = acceptanceHarness.observeAcceptanceExecutionBoundary(facade, { ownedUris: new Set(), coldUri: 'file:///owned/cold.kqlx', coldSectionId: 'legacy' });
  assert.equal(reads, 0);
  assert.deepEqual(observer.snapshot().writerRecords, []);
  assert.equal(observer.snapshot().writerObservation.status, 'disabled');
  assert.equal(observer.restore().restored, true);
  assert.equal(reads, 0);
});

test('acceptance execution observer rejects accessor boundaries without invoking the getter', () => {
  let reads = 0;
  const facade = { window: {} };
  Object.defineProperty(facade.window, 'registerCustomEditorProvider', { configurable: true, get() { reads++; return () => undefined; } });
  const descriptor = Object.getOwnPropertyDescriptor(facade.window, 'registerCustomEditorProvider');
  const observer = acceptanceHarness.observeAcceptanceExecutionBoundary(facade, { ownedUris: new Set(), coldUri: 'file:///owned/cold.kqlx', coldSectionId: 'legacy' });
  assert.equal(reads, 0);
  assert.equal(observer.snapshot().status, 'blocked');
  assert.equal(observer.restore().restored, true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(facade.window, 'registerCustomEditorProvider'), descriptor);
});

test('acceptance writer observer preserves exact receiver arguments and returned thenable while recording attempted metadata only', () => {
  const uri = pathToFileURL(path.join(os.tmpdir(), 'kw-writer-unit', 'history', 'owned.kqlx')).href;
  const beforeText = 'before';
  const replacement = 'replacement';
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: beforeText.length } };
  class WorkspaceEdit {
    entries() { return [[{ toString: () => uri }, [{ range, newText: replacement }]]]; }
  }
  const edit = new WorkspaceEdit();
  const result = { then() { assert.fail('Observation must not touch the original thenable'); } };
  const metadata = { label: 'original argument' };
  const privateEvents = [];
  let originalCalls = 0;
  const document = { uri: { toString: () => uri }, version: 7, getText: () => beforeText, offsetAt: position => position.character };
  const facade = { WorkspaceEdit, window: { registerCustomEditorProvider: () => undefined }, workspace: { textDocuments: [document],
    applyEdit(...args) { originalCalls++; assert.equal(this, facade.workspace); assert.equal(args[0], edit); assert.equal(args[1], metadata); return result; } } };
  const originalDescriptor = Object.getOwnPropertyDescriptor(facade.workspace, 'applyEdit');
  const observer = acceptanceHarness.observeAcceptanceExecutionBoundary(facade, { ownedUris: new Set([uri]), coldUri: uri, coldSectionId: 'legacy', observeWrites: true,
    onWriterEvent: event => privateEvents.push(event) });
  assert.equal(facade.workspace.applyEdit(edit, metadata), result);
  assert.equal(originalCalls, 1);
  const snapshot = observer.snapshot();
  assert.equal(snapshot.writerRecords.length, 1);
  const record = snapshot.writerRecords[0];
  assert.equal(record.stage, 'attempted');
  assert.equal(record.documentVersion, 7);
  assert.equal(record.fullReplacement, true);
  assert.equal(record.newTextSha256, createHash('sha256').update(replacement).digest('hex'));
  assert.equal(record.beforeSha256, createHash('sha256').update(beforeText).digest('hex'));
  assert.equal(Object.hasOwn(record, 'replacementText'), false);
  assert.ok(privateEvents[0]?.replacementText === replacement, 'Only the private storage callback receives replacement text');
  assert.deepEqual(snapshot.events, []);
  assert.equal(observer.restore().restored, true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(facade.workspace, 'applyEdit'), originalDescriptor);
});

const writerObserverFixture = ({ uri = pathToFileURL(path.join(os.tmpdir(), 'kw-writer-unit', 'history', 'owned.kqlx')).href, text = 'before', applyEdit, onWriterEvent, entriesError, sdkTypes = {} } = {}) => {
  const entriesByEdit = new WeakMap();
  class WorkspaceEdit {
    constructor(entries) { entriesByEdit.set(this, entries); }
    entries() { if (entriesError) throw entriesError; return entriesByEdit.get(this); }
  }
  const document = { uri: { toString: () => uri }, version: 1, isDirty: false, getText: () => text,
    offsetAt(position) {
      const current = this.getText();
      const breaks = [...current.matchAll(/\r\n|\r|\n/g)];
      const starts = [0, ...breaks.map(match => match.index + match[0].length)];
      const line = Math.min(position.line, starts.length - 1);
      return Math.min(starts[line] + position.character, breaks[line]?.index ?? current.length);
    } };
  const calls = [];
  const result = { then() { assert.fail('Never adopt the original thenable'); } };
  const facade = { ...sdkTypes, WorkspaceEdit, window: { registerCustomEditorProvider: () => undefined }, workspace: { textDocuments: [document],
    applyEdit(...args) { calls.push({ receiver: this, args }); return applyEdit ? Reflect.apply(applyEdit, this, args) : result; } } };
  const originalDescriptor = Object.getOwnPropertyDescriptor(facade.workspace, 'applyEdit');
  const observer = acceptanceHarness.observeAcceptanceExecutionBoundary(facade, { ownedUris: new Set([uri]), coldUri: uri, coldSectionId: 'legacy', observeWrites: true, onWriterEvent });
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } };
  const edit = (edits = [{ range, newText: 'changed' }], target = uri) => new WorkspaceEdit([[{ toString: () => target }, edits]]);
  return { facade, observer, document, uri, range, edit, WorkspaceEdit, calls, result, originalDescriptor };
};

const hostileObservationError = counter => ({ get message() { counter.reads++; throw new Error('Forbidden error getter'); },
  toString() { counter.reads++; throw new Error('Forbidden error coercion'); }, [Symbol.toPrimitive]() { counter.reads++; throw new Error('Forbidden error coercion'); } });

for (const origin of ['callback', 'entries', 'document', 'offset']) test('acceptance writer observer never coerces ' + origin + ' errors or blocks original forwarding', () => {
  const counter = { reads: 0 };
  const failure = hostileObservationError(counter);
  const fixture = writerObserverFixture({ entriesError: origin === 'entries' ? failure : undefined, onWriterEvent: origin === 'callback' ? () => { throw failure; } : undefined });
  if (origin === 'document') fixture.document.getText = () => { throw failure; };
  if (origin === 'offset') fixture.document.offsetAt = () => { throw failure; };
  assert.equal(fixture.facade.workspace.applyEdit(fixture.edit()), fixture.result);
  assert.equal(fixture.calls.length, 1);
  assert.equal(counter.reads, 0);
  assert.deepEqual(fixture.observer.snapshot().blockers, ['Writer observation failed']);
  assert.deepEqual(fixture.observer.snapshot().events, []);
  assert.equal(fixture.observer.restore().restored, true);
});

test('acceptance writer observer leaves original synchronous throws and rejected promises unchanged', async () => {
  const counter = { reads: 0 };
  const failure = hostileObservationError(counter);
  const throwing = writerObserverFixture({ applyEdit() { throw failure; } });
  assert.throws(() => throwing.facade.workspace.applyEdit(throwing.edit()), error => error === failure);
  assert.equal(throwing.calls.length, 1);
  assert.equal(throwing.observer.snapshot().writerRecords.length, 1);
  assert.equal(throwing.observer.snapshot().blockers.length, 0);
  assert.equal(throwing.observer.restore().restored, true);
  const rejection = Promise.reject(failure);
  let thenReads = 0;
  Object.defineProperty(rejection, 'then', { get() { thenReads++; throw new Error('Do not consume the rejection'); } });
  const rejecting = writerObserverFixture({ applyEdit: () => rejection });
  const returned = rejecting.facade.workspace.applyEdit(rejecting.edit());
  assert.equal(returned, rejection);
  assert.equal(thenReads, 0);
  await Reflect.apply(Promise.prototype.then, rejection, [() => assert.fail('Original rejection must remain a rejection'), error => assert.equal(error, failure)]);
  assert.equal(counter.reads, 0);
  assert.equal(rejecting.observer.snapshot().blockers.length, 0);
  assert.equal(rejecting.observer.restore().restored, true);
});

test('acceptance writer callback success cannot turn an attempted rejected mutation into a committed write', () => {
  const fixture = writerObserverFixture({ applyEdit: () => false, onWriterEvent: () => ({ success: true }) });
  assert.equal(fixture.facade.workspace.applyEdit(fixture.edit()), false);
  const record = fixture.observer.snapshot().writerRecords[0];
  assert.equal(record.stage, 'attempted');
  for (const forbidden of ['success', 'applied', 'committed', 'replacementText']) assert.equal(Object.hasOwn(record, forbidden), false);
  assert.equal(fixture.observer.restore().restored, true);
});

test('acceptance writer observer admits captured native field getters but rejects overridden or wire accessors without invoking them', () => {
  const fields = new WeakMap();
  class Position {
    constructor(line, character) { fields.set(this, { line, character }); }
    get line() { return fields.get(this).line; }
    get character() { return fields.get(this).character; }
  }
  class Range {
    constructor(start, end) { fields.set(this, { start, end }); }
    get start() { return fields.get(this).start; }
    get end() { return fields.get(this).end; }
  }
  class TextEdit {
    constructor(range, newText) { fields.set(this, { range, newText }); }
    get range() { return fields.get(this).range; }
    get newText() { return fields.get(this).newText; }
  }
  const fixture = writerObserverFixture({ sdkTypes: { Position, Range, TextEdit } });
  const native = new TextEdit(new Range(new Position(0, 0), new Position(0, 6)), 'changed');
  assert.equal(fixture.facade.workspace.applyEdit(fixture.edit([native])), fixture.result);
  assert.equal(fixture.observer.snapshot().writerRecords.length, 1);
  assert.equal(fixture.observer.snapshot().writerRecords[0].fullReplacement, true);
  let reads = 0;
  Object.defineProperty(native, 'newText', { get() { reads++; throw new Error('Forbidden override'); } });
  assert.equal(fixture.facade.workspace.applyEdit(fixture.edit([native])), fixture.result);
  const wire = { range: fixture.range, get newText() { reads++; throw new Error('Forbidden wire accessor'); } };
  assert.equal(fixture.facade.workspace.applyEdit(fixture.edit([wire])), fixture.result);
  assert.equal(reads, 0);
  assert.equal(fixture.observer.snapshot().writerRecords.length, 1);
  assert.deepEqual(fixture.observer.snapshot().blockers, ['Writer observation failed']);
  assert.equal(fixture.observer.restore().restored, true);
});

for (const protectedKind of ['accessor', 'nonwritable']) test('acceptance writer observer refuses a ' + protectedKind + ' applyEdit descriptor before invoking it', () => {
  let reads = 0;
  class WorkspaceEdit { entries() { return []; } }
  const workspace = {};
  const descriptor = protectedKind === 'accessor' ? { configurable: true, get() { reads++; throw new Error('Forbidden getter'); } }
    : { configurable: false, writable: false, value() { reads++; throw new Error('Protected method'); } };
  Object.defineProperty(workspace, 'applyEdit', descriptor);
  Object.defineProperty(workspace, 'textDocuments', { get() { reads++; throw new Error('Must not inspect documents'); } });
  const original = Object.getOwnPropertyDescriptor(workspace, 'applyEdit');
  const observer = acceptanceHarness.observeAcceptanceExecutionBoundary({ WorkspaceEdit, workspace, window: { registerCustomEditorProvider: () => undefined } },
    { ownedUris: new Set(), coldUri: 'file:///owned/cold.kqlx', coldSectionId: 'legacy', observeWrites: true });
  assert.equal(observer.snapshot().writerObservation.status, 'blocked');
  assert.equal(reads, 0);
  assert.equal(observer.restore().restored, true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(workspace, 'applyEdit'), original);
});

test('acceptance writer observer requires native entries and ignores outside-owned edit contents and documents', () => {
  const fixture = writerObserverFixture();
  let unsafeReads = 0;
  const outsider = pathToFileURL(path.join(os.tmpdir(), 'another-owner', 'owned.kqlx')).href;
  const unsafeEntry = {};
  Object.defineProperty(unsafeEntry, 'newText', { get() { unsafeReads++; throw new Error('Outside payload must remain unread'); } });
  const outsideDocument = { uri: { toString: () => outsider }, get getText() { unsafeReads++; throw new Error('Outside document must remain unread'); }, get version() { unsafeReads++; throw new Error('Outside version must remain unread'); } };
  fixture.facade.workspace.textDocuments.push(outsideDocument);
  const mixed = new fixture.WorkspaceEdit([[{ toString: () => outsider }, [unsafeEntry]], [{ toString: () => fixture.uri }, [{ range: fixture.range, newText: '' }]]]);
  assert.equal(fixture.facade.workspace.applyEdit(mixed), fixture.result);
  assert.equal(fixture.observer.snapshot().writerRecords.length, 1);
  assert.equal(fixture.observer.snapshot().writerRecords[0].newTextLength, 0);
  assert.equal(unsafeReads, 0);
  const wire = { entries() { unsafeReads++; throw new Error('Untrusted entries must remain uncalled'); } };
  assert.equal(fixture.facade.workspace.applyEdit(wire), fixture.result);
  const accessorEdit = fixture.edit();
  Object.defineProperty(accessorEdit, 'entries', { get() { unsafeReads++; throw new Error('Accessor entries must remain unread'); } });
  assert.equal(fixture.facade.workspace.applyEdit(accessorEdit), fixture.result);
  const revoked = Proxy.revocable(fixture.edit(), {});
  revoked.revoke();
  assert.equal(fixture.facade.workspace.applyEdit(revoked.proxy), fixture.result);
  assert.equal(unsafeReads, 0);
  assert.equal(fixture.calls.length, 4);
  assert.equal(fixture.observer.snapshot().writerRecords.length, 1);
  assert.deepEqual(fixture.observer.snapshot().events, []);
  assert.match(fixture.observer.snapshot().blockers[0], /VS Code-owned WorkspaceEdit/);
  assert.equal(fixture.observer.restore().restored, true);
});

test('acceptance writer observer records multi-edit CRLF Unicode UTF16 offsets and model generations without confusing full replacement', () => {
  const fixture = writerObserverFixture({ text: 'alpha\r\n\u{1f600}beta\r\nlast' });
  const firstRange = { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } };
  const secondRange = { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } };
  fixture.facade.workspace.applyEdit(fixture.edit([{ range: firstRange, newText: '' }, { range: secondRange, newText: '\u03a9' }]));
  let records = fixture.observer.snapshot().writerRecords;
  assert.deepEqual(records.map(record => [record.startOffset, record.endOffset, record.newTextLength, record.newTextBytes, record.fullReplacement]), [[7, 9, 0, 0, false], [15, 19, 1, 2, false]]);
  assert.ok(records.every(record => record.documentGeneration === 1 && record.documentVersion === 1 && record.beforeLength === 19 && record.attempt === 1));
  assert.equal(records[0].newTextSha256, createHash('sha256').update('').digest('hex'));
  const fullRange = { start: { line: 0, character: 0 }, end: { line: 2, character: 4 } };
  fixture.document.version = 2;
  fixture.facade.workspace.applyEdit(fixture.edit([{ range: fullRange, newText: '' }]));
  const replacementModel = { ...fixture.document, version: 3 };
  fixture.facade.workspace.textDocuments[0] = replacementModel;
  fixture.facade.workspace.applyEdit(fixture.edit([{ range: firstRange, newText: '' }]));
  records = fixture.observer.snapshot().writerRecords;
  assert.equal(records[2].fullReplacement, true);
  assert.equal(records[2].documentGeneration, 1);
  assert.equal(records[2].documentVersion, 2);
  assert.equal(records[3].documentGeneration, 2);
  assert.equal(records[3].fullReplacement, false);
  assert.equal(fixture.observer.writerDocumentGeneration(fixture.document), 1);
  assert.equal(fixture.observer.writerDocumentGeneration(replacementModel), 2);
  assert.equal(fixture.observer.restore().restored, true);
});

test('acceptance writer observer bounds records at512 edits at64 bytes at16MiB and stacks at12 without perturbing mutation', () => {
  const bounded = writerObserverFixture();
  const edit = bounded.edit();
  for (let index = 0; index < 514; index++) assert.equal(bounded.facade.workspace.applyEdit(edit), bounded.result);
  const records = bounded.observer.snapshot();
  assert.equal(records.writerRecords.length, 512);
  assert.equal(records.writerObservation.calls, 514);
  assert.equal(records.writerObservation.status, 'blocked');
  assert.match(records.blockers[0], /512-record bound/);
  assert.equal(bounded.calls.length, 514);
  assert.equal(bounded.observer.restore().writerObservation.status, 'blocked');
  const oversized = writerObserverFixture();
  let contentReads = 0;
  const uninspected = { get range() { contentReads++; throw new Error('Do not inspect oversized edits'); }, get newText() { contentReads++; throw new Error('Do not inspect oversized edits'); } };
  assert.equal(oversized.facade.workspace.applyEdit(oversized.edit(Array(65).fill(uninspected))), oversized.result);
  assert.equal(contentReads, 0);
  assert.equal(oversized.observer.snapshot().writerRecords.length, 0);
  assert.match(oversized.observer.snapshot().blockers[0], /64-edit bound/);
  assert.equal(oversized.observer.restore().restored, true);
  const exactEdits = writerObserverFixture();
  exactEdits.facade.workspace.applyEdit(exactEdits.edit(Array.from({ length: 64 }, () => ({ range: exactEdits.range, newText: '' }))));
  assert.equal(exactEdits.observer.snapshot().writerRecords.length, 64);
  assert.equal(exactEdits.observer.snapshot().blockers.length, 0);
  assert.equal(exactEdits.observer.restore().restored, true);
  const bytes = writerObserverFixture();
  const unicode = '\u{1f600}'.repeat(2 * 1024 * 1024);
  for (let index = 0; index < 2; index++) bytes.facade.workspace.applyEdit(bytes.edit([{ range: bytes.range, newText: unicode }]));
  assert.equal(bytes.facade.workspace.applyEdit(bytes.edit([{ range: bytes.range, newText: 'x' }])), bytes.result);
  const observation = bytes.observer.snapshot();
  assert.equal(observation.writerObservation.bytes, 16 * 1024 * 1024);
  assert.equal(observation.writerRecords.length, 2);
  assert.match(observation.blockers[0], /16-MiB byte bound/);
  assert.ok(observation.writerObservation.timingObserverCostMs >= 0);
  assert.deepEqual([observation.writerObservation.maxRecords, observation.writerObservation.maxEdits, observation.writerObservation.maxBytes, observation.writerObservation.maxStackFrames], [512, 64, 16 * 1024 * 1024, 12]);
  assert.ok(observation.writerRecords.every(record => record.stackFrames.length > 0 && record.stackFrames.length <= 12 && record.stackFrames.every(frame => !path.isAbsolute(frame.path))));
  assert.ok(Object.isFrozen(observation.writerRecords) && Object.isFrozen(observation.writerRecords[0]) && Object.isFrozen(observation.writerRecords[0].stackFrames));
  assert.equal(observation.writerObservation.stackQualification, 'UNQUALIFIED_LOCATION_ONLY_NOT_CAUSE');
  assert.deepEqual(observation.events, []);
  assert.equal(bytes.observer.restore().restored, true);
});

test('acceptance writer observer truncates a genuinely deeper project stack to12 frames', () => {
  const previous = Error.stackTraceLimit;
  const fixture = writerObserverFixture();
  const edit = fixture.edit();
  const callAtDepth = depth => depth ? callAtDepth(depth - 1) : fixture.facade.workspace.applyEdit(edit);
  try {
    Error.stackTraceLimit = 64;
    assert.equal(callAtDepth(24), fixture.result);
    assert.equal(fixture.observer.snapshot().writerRecords[0].stackFrames.length, 12);
  } finally { Error.stackTraceLimit = previous; fixture.observer.restore(); }
});

for (const attribute of ['writable', 'enumerable', 'configurable', 'value']) test('acceptance writer cleanup preserves independent ' + attribute + ' descriptor changes even when other installed flags match', () => {
  const fixture = writerObserverFixture();
  const installed = Object.getOwnPropertyDescriptor(fixture.facade.workspace, 'applyEdit');
  const changed = { ...installed, [attribute]: attribute === 'value' ? () => 'independent' : !installed[attribute] };
  Object.defineProperty(fixture.facade.workspace, 'applyEdit', changed);
  const restored = fixture.observer.restore();
  assert.equal(restored.restored, false);
  assert.equal(restored.status, 'blocked');
  assert.match(restored.blockers[0], /Exact execution wrapper changed before cleanup: applyEdit/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(fixture.facade.workspace, 'applyEdit'), changed);
  assert.deepEqual(fixture.observer.restore(), restored, 'Refused cleanup must not retry or overwrite independent changes');
});

test('acceptance writer cleanup deletes only its exact inherited-method shadow and execution callback failures remain content-free', () => {
  class WorkspaceEdit { entries() { return []; } }
  const original = () => 'unchanged';
  const prototype = { applyEdit: original };
  const workspace = Object.create(prototype);
  const counter = { reads: 0 };
  const listeners = [];
  const uri = pathToFileURL(path.join(os.tmpdir(), 'kw-writer-unit', 'cold.kqlx')).href;
  const facade = { WorkspaceEdit, workspace, window: { registerCustomEditorProvider: () => undefined } };
  const observer = acceptanceHarness.observeAcceptanceExecutionBoundary(facade, { ownedUris: new Set([uri]), coldUri: uri, coldSectionId: 'legacy', observeWrites: true,
    onEvent() { throw hostileObservationError(counter); } });
  assert.equal(Object.hasOwn(workspace, 'applyEdit'), true);
  const provider = { resolveCustomTextEditor: () => undefined };
  const panel = { webview: { postMessage: () => 'original', onDidReceiveMessage: listener => { listeners.push(listener); return { dispose() {} }; } } };
  facade.window.registerCustomEditorProvider('kusto.kqlxEditor', provider);
  provider.resolveCustomTextEditor({ uri: { toString: () => uri } }, panel);
  assert.equal(panel.webview.postMessage({ type: 'kustoExecutionStarted', boxId: 'legacy' }), 'original');
  assert.equal(counter.reads, 0);
  assert.deepEqual(observer.snapshot().blockers, ['Writer observation failed']);
  assert.equal(observer.restore().restored, true);
  assert.equal(Object.hasOwn(workspace, 'applyEdit'), false);
  assert.equal(workspace.applyEdit, original);
  assert.equal(prototype.applyEdit, original);
});

const archiveCaptureFixture = context => {
  const feature = fs.readFileSync(new URL('../vscode-extension-tester/e2e/opt-in/archive-public-activation-repro/archive-public-activation-repro.feature', import.meta.url), 'utf8');
  const owner = acceptanceHarness.createAcceptanceRoot();
  context.after(() => fs.rmSync(owner.root, { recursive: true, force: true }));
  const evidenceRoot = path.join(owner.root, 'evidence');
  fs.mkdirSync(evidenceRoot);
  const referencePath = 'history/nested/owned.kqlx';
  const sourceFile = path.join(owner.root, referencePath);
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  const beforeText = 'alpha\r\n\u{1f600}beta\r\nlast';
  fs.writeFileSync(sourceFile, beforeText, { flag: 'wx' });
  const uri = pathToFileURL(sourceFile).href;
  const references = new Map([[uri, { path: referencePath, file: sourceFile, text: beforeText }]]);
  const state = { damage: [], models: [], observationBlockers: [], writerCaptures: [], firstChangedCaptures: [] };
  const vmContext = createContext({ fs, path, helper: acceptanceHarness, owner, evidenceRoot, state, references, Buffer, process: { platform: process.platform }, queueMicrotask,
    observer: null, hash: value => createHash('sha256').update(value).digest('hex') });
  const captureBody = feature.slice(feature.indexOf('const captureRelativePath ='), feature.indexOf('const fingerprintTree ='));
  const sampleBody = feature.slice(feature.indexOf('const sampleDocument ='), feature.indexOf('const sampleTabs ='));
  const api = new Script('(() => { ' + captureBody + sampleBody + '; return { privateCapturePath, writePrivateCapture, queuePrivateCapture, flushPrivateCaptures, captureWriterAttempt, sampleDocument }; })()').runInContext(vmContext);
  return { owner, evidenceRoot, sourceFile, beforeText, uri, references, state, vmContext, api };
};

for (const mode of ['fullReplacement', 'partial']) test('archive private evidence composes ' + mode + ' attempts first changed buffer revert change flush and exact restoration without writing before forwarding', async context => {
  const capture = archiveCaptureFixture(context);
  const range = mode === 'fullReplacement' ? { start: { line: 0, character: 0 }, end: { line: 2, character: 4 } }
    : { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } };
  const replacement = mode === 'fullReplacement' ? 'first\r\n\u{1f600}changed\r\n' : '';
  const expected = mode === 'fullReplacement' ? replacement : capture.beforeText.slice(0, 7) + capture.beforeText.slice(9);
  let fixture;
  fixture = writerObserverFixture({ uri: capture.uri, text: capture.beforeText, onWriterEvent: capture.api.captureWriterAttempt,
    applyEdit() {
      assert.equal(fs.existsSync(path.join(capture.evidenceRoot, 'writer-attempts')), false, 'No synchronous storage before original forwarding');
      fixture.document.getText = () => expected;
      fixture.document.version = 2;
      fixture.document.isDirty = true;
      capture.api.sampleDocument(fixture.document, 'change', [{ rangeOffset: mode === 'fullReplacement' ? 0 : 7, rangeLength: mode === 'fullReplacement' ? 19 : 2, text: replacement }]);
      assert.equal(capture.state.damage.length, 1);
      assert.equal(capture.state.firstChangedCaptures.length, 1);
      assert.equal(fs.existsSync(path.join(capture.evidenceRoot, 'before-image-changed')), false, 'Buffer capture storage is deferred too');
      return fixture.result;
    } });
  capture.vmContext.observer = fixture.observer;
  capture.api.sampleDocument(fixture.document, 'open');
  const edit = fixture.edit([{ range, newText: replacement }]);
  assert.equal(fixture.facade.workspace.applyEdit(edit), fixture.result);
  fixture.document.getText = () => capture.beforeText;
  fixture.document.version = 3;
  fixture.document.isDirty = false;
  capture.api.sampleDocument(fixture.document, 'change');
  fixture.document.getText = () => 'later changed buffer';
  fixture.document.version = 4;
  capture.api.sampleDocument(fixture.document, 'change');
  const flushed = await capture.api.flushPrivateCaptures();
  assert.equal(flushed.pending, 0);
  assert.ok(flushed.bytes > 0 && flushed.bytes <= flushed.maxBytes);
  assert.equal(capture.state.firstChangedCaptures.length, 1);
  const receipt = capture.state.firstChangedCaptures[0];
  assert.equal(receipt.path, 'before-image-changed/history/nested/owned.kqlx');
  assert.equal(receipt.status, 'captured');
  assert.deepEqual(Array.from(receipt.matchingWriterSequences), [1]);
  assert.equal(receipt.correlation, 'ATTEMPT_MATCH_ONLY_NOT_COMMIT_OR_CAUSE');
  assert.equal(receipt.documentVersion, 2);
  assert.equal(receipt.documentGeneration, 1);
  assert.equal(receipt.bufferSha256, createHash('sha256').update(expected).digest('hex'));
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(capture.evidenceRoot, receipt.path))).digest('hex'), receipt.bufferSha256);
  assert.ok(fs.readFileSync(path.join(capture.evidenceRoot, receipt.path)).equals(Buffer.from(expected)), 'Capture must retain the exact first UTF8 buffer including CRLF and Unicode');
  const writer = JSON.parse(fs.readFileSync(path.join(capture.evidenceRoot, capture.state.writerCaptures[0].path), 'utf8'));
  assert.equal(writer.expectedMode, mode);
  assert.equal(writer.stage, 'attempted');
  assert.ok(writer.replacementText === replacement, 'Private writer payload must remain exact');
  assert.equal(Object.hasOwn(fixture.observer.snapshot().writerRecords[0], 'replacementText'), false);
  assert.equal(capture.state.observationBlockers.length, 0);
  assert.ok(capture.state.damage.every(entry => !Object.hasOwn(entry, 'replacementText')));
  assert.ok(fs.readFileSync(capture.sourceFile).equals(Buffer.from(capture.beforeText)), 'The before-image must remain unchanged');
  assert.equal(fixture.observer.restore().restored, true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(fixture.facade.workspace, 'applyEdit'), fixture.originalDescriptor);
});

for (const mismatch of ['generation', 'version', 'beforeHash', 'replacementHash', 'range']) test('archive first changed correlation refuses a mismatching ' + mismatch + ' without hiding the actual buffer', async context => {
  const capture = archiveCaptureFixture(context);
  const fixture = writerObserverFixture({ uri: capture.uri, text: capture.beforeText });
  const sha = value => createHash('sha256').update(value).digest('hex');
  const record = { sequence: 1, uri: capture.uri, documentGeneration: 1, documentVersion: 1, beforeSha256: sha(capture.beforeText), startOffset: 7, endOffset: 9, fullReplacement: false, newTextSha256: sha('') };
  if (mismatch === 'generation') record.documentGeneration = 2;
  if (mismatch === 'version') record.documentVersion = 2;
  if (mismatch === 'beforeHash') record.beforeSha256 = '0'.repeat(64);
  if (mismatch === 'replacementHash') record.newTextSha256 = '0'.repeat(64);
  if (mismatch === 'range') record.startOffset = 8;
  capture.vmContext.observer = { writerDocumentGeneration: () => 1, snapshot: () => ({ writerRecords: [record] }) };
  capture.api.sampleDocument(fixture.document, 'open');
  const actual = capture.beforeText.slice(0, 7) + capture.beforeText.slice(9);
  fixture.document.getText = () => actual;
  fixture.document.version = 2;
  capture.api.sampleDocument(fixture.document, 'change', [{ rangeOffset: 7, rangeLength: 2, text: '' }]);
  await capture.api.flushPrivateCaptures();
  const receipt = capture.state.firstChangedCaptures[0];
  assert.equal(receipt.status, 'captured');
  assert.equal(receipt.bufferSha256, sha(actual));
  assert.deepEqual(Array.from(receipt.matchingWriterSequences), []);
  assert.equal(capture.state.damage.length, 1);
  assert.equal(fixture.observer.restore().restored, true);
});

test('archive first changed capture keeps the first attempt and damage when exclusive storage fails and never overwrites later', async context => {
  const capture = archiveCaptureFixture(context);
  const destination = capture.api.privateCapturePath('before-image-changed/history/nested/owned.kqlx');
  fs.linkSync(capture.sourceFile, destination);
  const fixture = writerObserverFixture({ uri: capture.uri, text: capture.beforeText });
  capture.api.sampleDocument(fixture.document, 'open');
  fixture.document.getText = () => 'first changed buffer';
  fixture.document.version = 2;
  capture.api.sampleDocument(fixture.document, 'change');
  await capture.api.flushPrivateCaptures();
  const firstHash = capture.state.damage[0].bufferSha256;
  assert.equal(capture.state.firstChangedCaptures[0].status, 'blocked');
  assert.deepEqual(Array.from(capture.state.observationBlockers), ['First changed buffer capture failed']);
  fixture.document.getText = () => 'different changed buffer';
  fixture.document.version = 3;
  capture.api.sampleDocument(fixture.document, 'change');
  await capture.api.flushPrivateCaptures();
  assert.equal(capture.state.firstChangedCaptures.length, 1);
  assert.equal(capture.state.firstChangedCaptures[0].bufferSha256, firstHash);
  assert.equal(capture.state.damage.length, 2);
  assert.ok(fs.readFileSync(capture.sourceFile).equals(Buffer.from(capture.beforeText)), 'Existing hardlinked bytes must not be overwritten');
});

test('archive private capture confines full normalized paths and refuses traversal aliases junctions and a forged owner', context => {
  const capture = archiveCaptureFixture(context);
  const relative = 'before-image-changed/history\\nested\\preserved.kqlx';
  const receipt = capture.api.writePrivateCapture(relative, 'owned private bytes');
  const file = path.join(capture.evidenceRoot, 'before-image-changed/history/nested/preserved.kqlx');
  assert.equal(receipt.bytes, 19);
  assert.equal(fs.lstatSync(file).nlink, 1);
  assert.throws(() => capture.api.writePrivateCapture(relative, 'must not overwrite'), /EEXIST/);
  for (const unsafe of ['../outside', '/outside', 'C:/outside', 'history//file', 'history/../file', 'history/file:stream', 'history/CON.txt', 'history./file', 'history/file.', 'history/file ']) {
    assert.throws(() => capture.api.writePrivateCapture(unsafe, 'must not write'), /Private capture path rejected/);
  }
  const target = path.join(capture.owner.root, 'unit-junction-target');
  fs.mkdirSync(target);
  const alias = path.join(capture.evidenceRoot, 'unit-junction');
  fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => capture.api.writePrivateCapture('unit-junction/escaped.json', 'must not write'), /Private capture parent rejected/);
  assert.equal(fs.readdirSync(target).length, 0);
  capture.owner.marker = '0'.repeat(48);
  assert.throws(() => capture.api.writePrivateCapture('forged.json', 'must not write'), /marker mismatch/);
  assert.equal(fs.existsSync(path.join(capture.evidenceRoot, 'forged.json')), false);
});

test('archive private capture enforces a total serialized16MiB bound and flushes failures without error coercion', async context => {
  const capture = archiveCaptureFixture(context);
  const oversized = { replacementText: '\0'.repeat(3 * 1024 * 1024) };
  const receipt = { status: 'pending' };
  capture.api.queuePrivateCapture('writer-attempts/oversized.json', oversized, receipt, 'Writer payload capture failed');
  let flushed = await capture.api.flushPrivateCaptures();
  assert.equal(receipt.status, 'blocked');
  assert.equal(flushed.bytes, 0);
  assert.equal(flushed.pending, 0);
  assert.equal(fs.existsSync(path.join(capture.evidenceRoot, 'writer-attempts/oversized.json')), false);
  assert.ok(capture.state.observationBlockers.includes('Private capture exceeded its 16-MiB byte bound'));
  const counter = { reads: 0 };
  capture.vmContext.fs = { ...fs, openSync() { throw hostileObservationError(counter); } };
  const failed = { status: 'pending' };
  capture.api.queuePrivateCapture('writer-attempts/failure.json', 'private bytes', failed, 'Writer payload capture failed');
  flushed = await capture.api.flushPrivateCaptures();
  assert.equal(failed.status, 'blocked');
  assert.equal(flushed.pending, 0);
  assert.equal(counter.reads, 0);
});

const acceptanceCounterexamples = [
  ['missing acceptance artifact', value => delete value.acceptance],
  ['missing cold activation phase', value => delete value.acceptance.cold.activationPhase],
  ['missing pre-tool clean-tab evidence', value => value.acceptance.cold.tabReadiness.before = null],
  ['missing post-tool exact-focus evidence', value => value.acceptance.cold.tabReadiness.after = null],
  ['neighbor post-tool SDK focus', value => value.acceptance.cold.tabReadiness.after.active.uri = 'file:///owned/healthy-neighbor.kqlx'],
  ['dirty pre-tool SDK tab', value => value.acceptance.cold.tabReadiness.before.tabs[0].isDirty = true],
  ['partial88', value => value.acceptance.activationOrder.splice(88)],
  ['missing target109', value => value.acceptance.activationOrder.pop()],
  ['partial source inventory', value => { value.acceptance.archive.sourceCount = 120; value.acceptance.untouched.checkedSourceCount = 120; }],
  ['missing independent retained109 inventory', value => value.acceptance.historicalInventories = []],
  ['only88 retained after reopen', value => value.acceptance.historicalInventories[2].retainedCount = 88],
  ['synthetic-only equivalence', value => value.acceptance.mode = 'synthetic109'],
  ['wrong recorded order', value => value.acceptance.activationOrder.reverse()],
  ['missing authoring', value => value.acceptance.lifecycle.authoring = false],
  ['missing native Save', value => value.acceptance.lifecycle.nativeSave = false],
  ['missing reopen', value => value.acceptance.lifecycle.reopen = false],
  ['missing second interaction', value => value.acceptance.lifecycle.secondInteraction = false],
  ['wrong loaded main hash', value => value.acceptance.identity.before.mainSha256 = '9'.repeat(64)],
  ['changed resource tree', value => value.acceptance.identity.after.treeSha256 = '9'.repeat(64)],
  ['manifest-only identity', value => value.acceptance.identity.before.contextObserved = false],
  ['missing loaded require.cache module', value => value.acceptance.identity.before.moduleCacheLoaded = false],
  ['Development product', value => value.acceptance.identity.after.extensionMode = 2],
  ['wrong editor', value => value.acceptance.identity.before.vscodeVersion = '1.139.1'],
  ['changed dirty patch', value => value.acceptance.identity.after.sourcePatchSha256 = '9'.repeat(64)],
  ['missing host-after hash despite matching parent', value => delete value.acceptance.identity.after.mainSha256],
  ['missing independent parent identity', value => delete value.acceptance.identity.parentFinal],
  ['parent-final differs from host identities', value => value.acceptance.identity.parentFinal.treeSha256 = '9'.repeat(64)],
  ['host expected identity differs from parent configuration', value => value.acceptance.identity.expected.vsixSha256 = '9'.repeat(64)],
  ['independent archive verification failure', value => value.acceptance.collection.archiveVerified = false],
  ['missing pixel evidence', value => value.acceptance.pixels.captures = []],
  ['gray controls with healthy DOM', value => value.acceptance.pixels.captures[0].controlsNonblank = false],
  ['fallback capture', value => value.acceptance.pixels.captures[0].fallback = true],
  ['wrong foreground window', value => value.acceptance.pixels.captures[0].foregroundHwnd = '0x999'],
  ['stale screenshot frame', value => value.acceptance.pixels.captures[0].currentFrame = false],
  ['dirty then revert', value => value.acceptance.untouched.dirtyTransitions.push({ phase: 'open', dirty: true })],
  ['byte rewrite then revert', value => value.acceptance.untouched.byteChanges.push({ phase: 'open', expected: 'before', actual: 'rewritten' })],
  ['setup Save normalization', value => value.acceptance.untouched.setupSaves = 1],
  ['post-stress rebaseline', value => value.acceptance.untouched.rebaselines = 1],
  ['unsafe cleanup alias', value => value.acceptance.cleanup.aliasFree = false],
  ['dirty discard', value => value.acceptance.cleanup.dirtyDiscard = true],
  ['unowned tab cleanup', value => value.acceptance.cleanup.onlyOwnedTabs = false],
  ['failure fixture deletion', value => value.acceptance.cleanup.preservedFailures = false],
  ['unavailable notes success plus empty array', value => value.acceptance.notes[2] = { phase: 'reactivated', success: true, notes: [] }],
  ['Production fixture ownership blocked', value => value.acceptance.fixtureOwnership.status = 'blocked'],
  ['forged result ownership', value => value.acceptance.fixtureOwnership.forged = true],
  ['development seed fixture', value => value.acceptance.fixtureOwnership.developmentSeeds = true],
  ['independent canary warming', value => value.acceptance.cold.warmingCalls = 1],
  ['activation retry', value => value.acceptance.cold.activationCalls = 2],
  ['first tool not exact ID', value => value.acceptance.cold.firstToolTarget = 'active-editor'],
  ['blank query execution', value => value.acceptance.cold.blankExecutions = 1],
  ['rejected execution ingress without a start or byte change', value => { value.acceptance.execution.ingressCount = 1; value.acceptance.execution.events.push({ stage: 'ingress', blank: true }); }],
  ['observed execution start without a request', value => value.acceptance.execution.startCount = 1],
  ['missing actual execution facade', value => value.acceptance.execution.source = 'controller-vscode-facade'],
  ['execution wrappers not restored', value => value.acceptance.execution.restored = false],
  ['missing cold execution listener', value => value.acceptance.execution.coldPanelObserved = false],
  ['unavailable execution observation reported as zeros', value => value.acceptance.execution.status = 'blocked'],
];

for (const [name, modify] of acceptanceCounterexamples) test('acceptance classifier rejects ' + name, () => {
  const evidence = acceptanceEvidence();
  modify(evidence);
  const result = classify(evidence, false);
  assert.notEqual(result.primary, 'PASS_UNREVIEWED_VISUAL');
  assert.equal(result.acceptanceQualified, false);
  assert.ok(result.reasons.length > 0);
});

test('acceptance mode is explicit, Auto Save on, archival-only, and separate from older defaults', () => {
  const input = ['--vsix', 'synthetic.vsix', '--expected-sha', 'a'.repeat(64)];
  const older = parseArgs(input);
  assert.equal(older.vscodeVersion, '1.139.1');
  assert.equal(older.autosave, 'both');
  const accepted = parseArgs([...input, '--acceptance', 'original109', '--before-archive', 'before.zip', '--order-archive', 'order.zip']);
  assert.equal(accepted.acceptance, 'original109');
  assert.equal(accepted.vscodeVersion, '1.141.0');
  assert.equal(accepted.autosave, 'afterDelay');
  assert.equal(accepted.repeats, 1);
  assert.ok(path.isAbsolute(accepted.beforeArchive));
  assert.ok(path.isAbsolute(accepted.orderArchive));
  assert.throws(() => parseArgs([...input, '--before-archive', 'before.zip']), /acceptance/);
  assert.throws(() => parseArgs([...input, '--acceptance', 'original109']), /archive/);
  for (const forbidden of [['--autosave', 'off'], ['--autosave', 'both'], ['--observation', 'minimal'], ['--profile-host-cpu']]) {
    assert.throws(() => parseArgs([...input, '--acceptance', 'original109', '--before-archive', 'before.zip', '--order-archive', 'order.zip', ...forbidden]), /acceptance|Auto Save/);
  }
});

test('acceptance startup never reads profile/auth/original settings/baseline inputs', () => {
  const originals = new Map(['readFileSync', 'existsSync', 'statSync', 'lstatSync', 'openSync'].map(name => [name, fs[name]]));
  const accessed = [];
  const options = { acceptance: 'original109' };
  for (const name of ['seedProfile', 'seedAuth', 'originalSettings', 'baselineRun']) Object.defineProperty(options, name, { get() { assert.fail('Never access acceptance ' + name); } });
  try {
    for (const name of originals.keys()) fs[name] = (...args) => { accessed.push({ name, target: args[0] }); throw new Error('Forbidden startup read'); };
    const inputs = acceptanceHarness.readReplayInputs(options);
    assert.deepEqual(inputs.originalSettings, {});
    assert.equal(inputs.baseline.initialHash, null);
    assert.equal(inputs.settingsIdentity.path, null);
    assert.deepEqual(accessed, []);
  } finally { for (const [name, original] of originals) fs[name] = original; }
});

test('current133 API startup never accesses profile/auth seeds or historical live inputs', () => {
  const options = { acceptance: 'current133-api' };
  for (const name of ['seedProfile', 'seedAuth', 'originalSettings', 'baselineRun']) Object.defineProperty(options, name, { get() { assert.fail('Forbidden current133 startup input: ' + name); } });
  const inputs = acceptanceHarness.readReplayInputs(options);
  assert.deepEqual(inputs.originalSettings, {});
  assert.equal(inputs.settingsIdentity.path, null);
  assert.equal(inputs.baseline.initialHash, null);
});

test('older replay startup retains its existing seeded-settings contract using only synthetic owned inputs', context => {
  const owner = acceptanceHarness.createAcceptanceRoot();
  context.after(() => fs.rmSync(owner.root, { recursive: true, force: true }));
  const seedProfile = path.join(owner.root, 'fake-seed');
  const seedAuth = path.join(owner.root, 'fake-auth');
  const originalSettings = path.join(owner.root, 'fake-settings.json');
  for (const relative of ['fake-seed/user-data/Local State', 'fake-seed/user-data/User/globalStorage/state.vscdb', 'fake-auth/Local State']) {
    const file = path.join(owner.root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'Synthetic test bytes only');
  }
  fs.writeFileSync(originalSettings, '{"files.autoSave":"off","editor.fontSize":13}');
  const inputs = acceptanceHarness.readReplayInputs({ acceptance: null, seedProfile, seedAuth, originalSettings, baselineRun: path.join(owner.root, 'missing-baseline') });
  assert.deepEqual(inputs.originalSettings, { 'files.autoSave': 'off', 'editor.fontSize': 13 });
  assert.equal(inputs.baseline.reason, 'baseline run not found');
  assert.equal(inputs.settingsIdentity.path, originalSettings);
});

test('acceptance recorded order rejects partial, duplicate, sidecar, traversal, Windows alias and wrong sentinel paths', () => {
  const order = acceptanceEvidence().acceptance.expectedOrder;
  assert.deepEqual(acceptanceHarness.validateActivationOrder(order), order);
  const invalid = [order.slice(0, 88), [...order, 'extra.kqlx'], order.map((value, index) => index === 5 ? order[4] : value),
    order.map((value, index) => index === 2 ? 'file.kql.json' : value),
    order.map((value, index) => index === 2 ? '../file.kqlx' : value),
    order.map((value, index) => index === 2 ? 'C:/original/file.kqlx' : value),
    order.map((value, index) => index === 2 ? 'past/file.kqlx:stream' : value),
    order.map((value, index) => index === 2 ? 'past/CON.kqlx' : value),
    order.map((value, index) => index === 2 ? 'past./file.kqlx' : value),
    order.map((value, index) => index === 5 ? order[4].toUpperCase() : value), [...order].reverse()];
  for (const value of invalid) assert.throws(() => acceptanceHarness.validateActivationOrder(value), /109|order|path|alias|sentinel/i);
});

test('acceptance roots must be fresh marked canonical TEMP directories and refuse existing, unmarked and junction roots', context => {
  const owner = acceptanceHarness.createAcceptanceRoot();
  context.after(() => fs.rmSync(owner.root, { recursive: true, force: true }));
  assert.equal(acceptanceHarness.assertAcceptanceRoot(owner), owner.root);
  assert.throws(() => acceptanceHarness.createAcceptanceRoot(owner.root), /TEMP|parent|fresh/i);
  assert.throws(() => acceptanceHarness.assertAcceptanceRoot({ ...owner, marker: 'wrong' }), /marker/i);
  const alias = path.join(os.tmpdir(), 'kw-acceptance-alias-' + path.basename(owner.root));
  try {
    fs.symlinkSync(owner.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    context.after(() => fs.rmSync(alias, { recursive: false, force: true }));
    assert.throws(() => acceptanceHarness.assertAcceptanceRoot({ ...owner, root: alias }), /canonical|alias|link/i);
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    assert.fail('Root alias rejection could not be exercised on this machine: ' + error.code);
  }
});

const syntheticBeforeImages = () => {
  const order = acceptanceEvidence().acceptance.expectedOrder;
  for (let index = 0; index < 21; index++) order[index] = order[index].replace(/\.kqlx$/, '.kql');
  const images = new Map(order.map(value => [value, Buffer.from(makeText())]));
  const legacy = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [{ id: 'legacy', type: 'query', query: '', expanded: true, favoritesMode: true }] } }).padEnd(498, ' ');
  images.set('extension-fix-validation-empty-legacy-2026-09-12.kqlx', Buffer.from(legacy));
  for (let index = 0; images.size < 131; index++) images.set(order[index] + '.json', Buffer.from('{"state":{"sections":[]}}\r\n'));
  const files = [...images].map(([file, bytes]) => ({ path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
  return { order, images, baseline: { files } };
};

test('acceptance before-images validate every exact byte hash and keep companions out of activation order', () => {
  const { order, images, baseline } = syntheticBeforeImages();
  const plan = acceptanceHarness.validateBeforeImages(baseline, images, order);
  assert.equal(plan.files.length, 131);
  assert.equal(plan.primaries.length, 110);
  assert.equal(plan.sidecars.length, 21);
  assert.deepEqual(plan.activationOrder, order);
  const incomplete = new Map(images);
  incomplete.delete(order[82]);
  assert.throws(() => acceptanceHarness.validateBeforeImages(baseline, incomplete, order), /missing|131/i);
  const rewritten = new Map(images);
  rewritten.set(order[82], Buffer.from(JSON.stringify(JSON.parse(images.get(order[82]).toString()), null, 2)));
  assert.throws(() => acceptanceHarness.validateBeforeImages(baseline, rewritten, order), /hash|byte/i);
  const aliased = structuredClone(baseline);
  aliased.files[1].path = aliased.files[0].path.toUpperCase();
  assert.throws(() => acceptanceHarness.validateBeforeImages(aliased, images, order), /duplicate|alias/i);
});

test('current133 manifest has a fixed independent count and cannot replace the immutable original131 contract', () => {
  const { order, images, baseline } = syntheticBeforeImages();
  for (const file of ['unit-current-one.kqlx', 'unit-current-two.mdx']) {
    const bytes = Buffer.from(makeText());
    images.set(file, bytes);
    baseline.files.push({ path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const plan = acceptanceHarness.validateBeforeImages(baseline, images, order, 'current133-api');
  assert.equal(plan.files.length, 133);
  assert.deepEqual(plan.activationOrder, order);
  assert.throws(() => acceptanceHarness.validateBeforeImages(baseline, images, order), /131/);
  assert.throws(() => acceptanceHarness.validateBeforeImages({ files: baseline.files.slice(0, 132) }, new Map([...images].slice(0, 132)), order, 'current133-api'), /133/);
  assert.throws(() => acceptanceHarness.validateBeforeImages({ files: [...baseline.files, baseline.files[0]] }, images, order, 'current133-api'), /133/);
  assert.equal(acceptanceHarness.validateBeforeImages(syntheticBeforeImages().baseline, syntheticBeforeImages().images, order).files.length, 131);
});

test('acceptance before-image staging copies bytes exclusively and refuses normalization or an existing destination', context => {
  const { order, images, baseline } = syntheticBeforeImages();
  const plan = acceptanceHarness.validateBeforeImages(baseline, images, order);
  const owner = acceptanceHarness.createAcceptanceRoot();
  context.after(() => fs.rmSync(owner.root, { recursive: true, force: true }));
  const staged = acceptanceHarness.stageBeforeImages(owner, plan, images);
  for (const file of plan.files) assert.deepEqual(fs.readFileSync(path.join(staged.historyRoot, file.path)), images.get(file.path));
  assert.throws(() => acceptanceHarness.stageBeforeImages(owner, plan, images), /exist|fresh/i);
  assert.equal(fs.readFileSync(path.join(staged.historyRoot, plan.sidecars[0].path), 'utf8').endsWith('\r\n'), true);
});

test('acceptance cold canary close retains exact109 including archival original target20; closing target20 fails108/109', async context => {
  const before = syntheticBeforeImages();
  const legacyPath = 'extension-fix-validation-empty-legacy-2026-09-12.kqlx';
  before.order[19] = legacyPath;
  const plan = { ...acceptanceHarness.validateBeforeImages(before.baseline, before.images, before.order), legacyPath, legacySectionId: 'legacy' };
  const owner = acceptanceHarness.createAcceptanceRoot();
  context.after(() => fs.rmSync(owner.root, { recursive: true, force: true }));
  const staged = acceptanceHarness.stageBeforeImages(owner, plan, before.images);
  const historicalUris = plan.activationOrder.map(relative => pathToFileURL(path.join(staged.historyRoot, relative)).href);
  const coldUri = pathToFileURL(staged.coldCanary?.filePath ?? path.join(staged.historyRoot, legacyPath)).href;
  const tabs = historicalUris.map(uri => ({ input: { uri: { toString: () => uri } }, isDirty: false }));
  if (!historicalUris.includes(coldUri)) tabs.push({ input: { uri: { toString: () => coldUri } }, isDirty: false });
  const vscode = { window: { tabGroups: { all: [{ tabs }], close: async selected => {
    for (const tab of selected) tabs.splice(tabs.indexOf(tab), 1);
    return true;
  } } }, workspace: { textDocuments: [] } };
  assert.equal(historicalUris[19], pathToFileURL(path.join(staged.historyRoot, legacyPath)).href);
  assert.equal(acceptanceHarness.inspectHistoricalTabs(vscode, historicalUris).retainedCount, 109);
  assert.equal((await acceptanceHarness.closeAcceptanceTabs(vscode, owner, [coldUri])).closed, 1);
  assert.equal(acceptanceHarness.inspectHistoricalTabs(vscode, historicalUris).retainedCount, 109);
  assert.notEqual(coldUri, historicalUris[19], 'The first cold URI must be a distinct byte-identical copy, not archival target20');
  assert.equal(tabs.length, 109);
  assert.equal((await acceptanceHarness.closeAcceptanceTabs(vscode, owner, [historicalUris[19]])).closed, 1);
  assert.throws(() => acceptanceHarness.inspectHistoricalTabs(vscode, historicalUris), /108\/109/);
  for (const file of plan.files) assert.deepEqual(fs.readFileSync(path.join(staged.historyRoot, file.path)), before.images.get(file.path));
});

test('acceptance cold canary inspection confines the exclusive copy and binds its original bytes, ID, source URI and root marker', context => {
  const before = syntheticBeforeImages();
  const plan = acceptanceHarness.validateBeforeImages(before.baseline, before.images, before.order);
  const owner = acceptanceHarness.createAcceptanceRoot();
  context.after(() => fs.rmSync(owner.root, { recursive: true, force: true }));
  const staged = acceptanceHarness.stageBeforeImages(owner, plan, before.images);
  const canary = staged.coldCanary;
  const inspected = acceptanceHarness.inspectAcceptanceColdCanary(owner, staged.historyRoot, canary, plan.files);
  assert.equal(inspected.count, 1);
  assert.equal(inspected.bytes, 498);
  assert.equal(inspected.markerVerified, true);
  assert.equal(inspected.aliasFree, true);
  assert.equal(path.basename(canary.filePath), canary.sourcePath);
  assert.notEqual(canary.uri, canary.sourceUri);
  assert.deepEqual(fs.readFileSync(canary.filePath), before.images.get(canary.sourcePath));
  assert.equal(JSON.parse(fs.readFileSync(canary.filePath, 'utf8')).state.sections[0].id, 'legacy');
  assert.equal(plan.files.length, 131);
  assert.equal(staged.files.length, 131);
  for (const mutation of [{ rootMarker: '0'.repeat(48) }, { count: 2 }, { sourceUri: canary.uri },
    { root: staged.historyRoot }, { filePath: path.join(staged.historyRoot, canary.sourcePath) }, { path: '../cold-canary/' + canary.sourcePath }]) {
    assert.throws(() => acceptanceHarness.inspectAcceptanceColdCanary(owner, staged.historyRoot, { ...canary, ...mutation }, plan.files), /cold|source|root|marker|linkage/i);
  }
  fs.appendFileSync(canary.filePath, ' ');
  assert.throws(() => acceptanceHarness.inspectAcceptanceColdCanary(owner, staged.historyRoot, canary, plan.files), /changed exact bytes/i);
  for (const file of plan.files) assert.deepEqual(fs.readFileSync(path.join(staged.historyRoot, file.path)), before.images.get(file.path));
});

test('acceptance cold canary staging refuses an existing private root without overwriting its contents', context => {
  const before = syntheticBeforeImages();
  const plan = acceptanceHarness.validateBeforeImages(before.baseline, before.images, before.order);
  const owner = acceptanceHarness.createAcceptanceRoot();
  context.after(() => fs.rmSync(owner.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(owner.root, 'cold-canary'));
  const existing = path.join(owner.root, 'cold-canary', 'extension-fix-validation-empty-legacy-2026-09-12.kqlx');
  fs.writeFileSync(existing, 'Private existing destination, never overwrite');
  assert.throws(() => acceptanceHarness.stageBeforeImages(owner, plan, before.images), /EEXIST|exist/i);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'Private existing destination, never overwrite');
  for (const file of plan.files) assert.deepEqual(fs.readFileSync(path.join(owner.root, 'history', file.path)), before.images.get(file.path));
});

test('acceptance archived links reject escapes before any target filesystem access', () => {
  const invalid = ['C:/original/query.kql', 'C:\\original\\query.kql', '\\\\server\\share\\query.kql', '//server/share/query.kql',
    '/original/query.kql', 'file:///C:/original/query.kql', 'https://example.test/query.kql', 'vscode-userdata:/query.kql',
    '../query.kql', 'nested/../../query.kql', '..\\query.kql', 'C:query.kql', 'missing.kql', 'nested\\query.kql'];
  for (const linkedQueryPath of invalid) {
    const { order, images, baseline } = syntheticBeforeImages();
    const notebook = order[23];
    const bytes = Buffer.from(JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [{ type: 'query', linkedQueryPath }] } }));
    images.set(notebook, bytes);
    const record = baseline.files.find(file => file.path === notebook);
    Object.assign(record, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    const originals = new Map(['readFileSync', 'statSync', 'lstatSync', 'realpathSync', 'existsSync', 'openSync'].map(name => [name, fs[name]]));
    const accessed = [];
    try {
      for (const name of originals.keys()) fs[name] = (...args) => { accessed.push({ name, target: args[0] }); throw new Error('Unexpected target filesystem access'); };
      assert.throws(() => acceptanceHarness.validateBeforeImages(baseline, images, order), /linked|inventory|relative|traversal/i, linkedQueryPath);
      assert.deepEqual(accessed, [], linkedQueryPath);
      assert.deepEqual(images.get(notebook), bytes, 'Archived links must never be rewritten');
    } finally {
      for (const [name, original] of originals) fs[name] = original;
    }
  }
});

test('acceptance archived relative links use native POSIX notebook-directory resolution and preserve bytes', () => {
  const { order, images, baseline } = syntheticBeforeImages();
  const notebook = order[23];
  const target = order[0];
  const bytes = Buffer.from(JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [{ type: 'query', linkedQueryPath: '  ./target-1.kql  ' }] } }) + '\r\n');
  images.set(notebook, bytes);
  const record = baseline.files.find(file => file.path === notebook);
  Object.assign(record, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const beforeHashes = [...images].map(([relative, image]) => [relative, createHash('sha256').update(image).digest('hex')]);
  const plan = acceptanceHarness.validateBeforeImages(baseline, images, order);
  assert.deepEqual(plan.linkedTargets, [{ source: notebook, sectionIndex: 0, linkedQueryPath: '  ./target-1.kql  ', target }]);
  assert.deepEqual([...images].map(([relative, image]) => [relative, createHash('sha256').update(image).digest('hex')]), beforeHashes);
});

test('acceptance archived Windows relative links resolve only to the separately archived owned target without rewriting bytes', () => {
  const { order, images, baseline } = syntheticBeforeImages();
  const notebook = order[23];
  const linkedQueryPath = '  .\\target-1.kql  ';
  const bytes = Buffer.from(JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [{ type: 'query', linkedQueryPath }] } }) + '\r\n');
  images.set(notebook, bytes);
  Object.assign(baseline.files.find(file => file.path === notebook), { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const plan = acceptanceHarness.validateBeforeImages(baseline, images, order);
  assert.deepEqual(plan.linkedTargets, [{ source: notebook, sectionIndex: 0, linkedQueryPath, target: order[0] }]);
  assert.deepEqual(images.get(notebook), bytes);
});

test('acceptance loaded identity reads the executing cached module and actual context without requiring or activating the product', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-identity-test-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'dist'));
  const mainPath = path.join(root, 'dist/extension.js');
  fs.writeFileSync(mainPath, 'throw new Error("DO NOT REQUIRE THIS MODULE");\n');
  const extension = { extensionPath: root, packageJSON: { main: './dist/extension.js', version: '5.2.0' }, activate() { assert.fail('Identity must not activate a runtime'); } };
  const source = { head: 'd'.repeat(40), patchSha256: 'e'.repeat(64) };
  const reference = { installedPath: root, mainPath, vsixSha256: 'a'.repeat(64) };
  const contextValue = { extensionMode: 1, extensionPath: root };
  const cache = { [mainPath]: { filename: mainPath, loaded: true, exports: { toolOrchestrator: { context: contextValue } } } };
  const identity = acceptanceHarness.readLoadedBuildIdentity({ extension, cache, expected: reference, vscodeVersion: '1.141.0', source, driverExtensionMode: 2 });
  assert.equal(identity.extensionMode, 1);
  assert.equal(identity.contextObserved, true);
  assert.equal(identity.moduleCacheLoaded, true);
  assert.equal(identity.mainSha256, createHash('sha256').update(fs.readFileSync(mainPath)).digest('hex'));
  assert.equal(identity.vsixSha256, reference.vsixSha256);
  assert.equal(identity.sourcePatchSha256, source.patchSha256);
  const absent = acceptanceHarness.readLoadedBuildIdentity({ extension, cache: {}, expected: reference, vscodeVersion: '1.141.0', source, driverExtensionMode: 2 });
  assert.equal(absent.contextObserved, false);
  assert.equal(absent.extensionMode, null);
  assert.equal(absent.moduleCacheLoaded, false);
  contextValue.extensionMode = 2;
  assert.equal(acceptanceHarness.readLoadedBuildIdentity({ extension, cache, expected: reference, vscodeVersion: '1.141.0', source, driverExtensionMode: 2 }).extensionMode, 2);
});

test('current API loaded METHOD fingerprints distinguish stale runtime from identical on-disk manifests without importing the product', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-runtime-method-test-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'dist'));
  const mainPath = path.join(root, 'dist/extension.js');
  class CandidateRuntime {
    collectOpenWorkbenchFiles() { return { openFiles: [] }; }
    listSections() { return { sections: [] }; }
    manageDevelopmentNotes() { return { success: true, notes: [] }; }
    validateHtmlDashboard() { return { success: true, valid: true }; }
    activateWorkbenchFile() { return { success: true }; }
  }
  class OldRuntime extends CandidateRuntime { listSections() { return { sections: [], stale: true }; } }
  fs.writeFileSync(mainPath, CandidateRuntime.toString());
  const extension = { extensionPath: root, packageJSON: { main: './dist/extension.js' }, activate() { assert.fail('Never activate'); } };
  const expected = { vsixSha256: 'a'.repeat(64) };
  const source = { head: 'd'.repeat(40), patchSha256: 'e'.repeat(64), dependenciesSha256: 'f'.repeat(64) };
  const identityFor = owner => {
    owner.context = { extensionMode: 1, extensionPath: root };
    return acceptanceHarness.readLoadedBuildIdentity({ extension, cache: { [mainPath]: { filename: mainPath, loaded: true, exports: { toolOrchestrator: owner } } }, expected, source, vscodeVersion: '1.141.0', driverExtensionMode: 2 });
  };
  const candidate = identityFor(new CandidateRuntime());
  const old = identityFor(new OldRuntime());
  assert.equal(candidate.mainSha256, old.mainSha256);
  assert.equal(candidate.runtime.source, 'executing-require-cache');
  assert.equal(candidate.runtime.methods.length, 6);
  assert.ok(candidate.runtime.methods.every(method => method.matchesPackage && method.offset >= 0 && method.length > 0));
  assert.equal(old.runtime.methods.find(method => method.name === 'listSections').matchesPackage, false);
  assert.equal(candidate.dependenciesSha256, source.dependenciesSha256);
  assert.deepEqual(Object.keys(candidate.assetTrees), ['monaco', 'css', 'scripts']);
  fs.mkdirSync(path.join(root, 'dist/monaco/vs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist/monaco/vs/loader.js'), 'Inert Monaco asset bytes');
  fs.writeFileSync(path.join(root, 'dist/queryEditor.css'), 'body { color: red; }');
  const changed = identityFor(new CandidateRuntime());
  assert.equal(changed.mainSha256, candidate.mainSha256);
  assert.notEqual(changed.assetTrees.monaco, candidate.assetTrees.monaco);
  assert.notEqual(changed.assetTrees.css, candidate.assetTrees.css);
  assert.notEqual(changed.assetTrees.scripts, candidate.assetTrees.scripts);
});

test('current API unchanged-byte revisions still retain transient same-model version changes', () => {
  const state = { untouched: { exactBytes: true, allRevisionsClean: true, versionsStable: true, modelVersions: [], versionChanges: [], dirtyTransitions: [], byteChanges: [] } };
  const reference = { path: 'historical.kqlx', text: makeText() };
  const revision = { phase: 'initial', openGeneration: 1, documentVersion: 1, isDirty: false, text: reference.text };
  acceptanceHarness.recordUntouchedRevision(state, reference, revision);
  acceptanceHarness.recordUntouchedRevision(state, reference, { ...revision, phase: 'hidden', documentVersion: 2 });
  acceptanceHarness.recordUntouchedRevision(state, reference, { ...revision, phase: 'reactivated' });
  acceptanceHarness.recordUntouchedRevision(state, reference, { ...revision, phase: 'new-model', openGeneration: 2 });
  assert.equal(state.untouched.exactBytes, true);
  assert.equal(state.untouched.allRevisionsClean, true);
  assert.equal(state.untouched.versionsStable, false);
  assert.equal(state.untouched.versionChanges.length, 1);
});

test('acceptance loaded identity rejects an installed-path junction rather than treating its manifest as build proof', context => {
  const owner = acceptanceHarness.createAcceptanceRoot();
  context.after(() => fs.rmSync(owner.root, { recursive: true, force: true }));
  const product = path.join(owner.root, 'product');
  fs.mkdirSync(path.join(product, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(product, 'dist/extension.js'), 'never require');
  const alias = path.join(owner.root, 'product-alias');
  fs.symlinkSync(product, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const extension = { extensionPath: alias, packageJSON: { main: './dist/extension.js', version: '5.2.0' } };
  assert.throws(() => acceptanceHarness.readLoadedBuildIdentity({ extension, cache: {}, expected: { vsixSha256: 'a'.repeat(64) }, source: {}, vscodeVersion: '1.141.0', driverExtensionMode: 2 }), /link|junction|alias|canonical/i);
});

for (const missing of [false, true]) test('acceptance parent collection never heals ' + (missing ? 'missing' : 'mismatched') + ' host identity evidence', context => {
  const owner = acceptanceHarness.createAcceptanceRoot();
  context.after(() => fs.rmSync(owner.root, { recursive: true, force: true }));
  const evidenceRoot = path.join(owner.root, 'evidence');
  const installedPath = path.join(owner.root, 'product');
  fs.mkdirSync(evidenceRoot);
  fs.mkdirSync(path.join(installedPath, 'dist'), { recursive: true });
  const mainPath = path.join(installedPath, 'dist/extension.js');
  fs.writeFileSync(mainPath, 'Unit-only identity bytes, never execute');
  const vsixPath = path.join(owner.root, 'fake-package-bytes.vsix');
  const beforeArchiveCopy = path.join(owner.root, 'fake-before.zip');
  const orderArchiveCopy = path.join(owner.root, 'fake-order.zip');
  for (const file of [vsixPath, beforeArchiveCopy, orderArchiveCopy]) fs.writeFileSync(file, 'Unit-only archive bytes, never launch');
  const before = syntheticBeforeImages();
  const plan = acceptanceHarness.validateBeforeImages(before.baseline, before.images, before.order);
  const staged = acceptanceHarness.stageBeforeImages(owner, plan, before.images);
  const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const evidence = acceptanceEvidence();
  const state = evidence.acceptance;
  state.archive.beforeSha256 = hashFile(beforeArchiveCopy);
  state.archive.orderSha256 = hashFile(orderArchiveCopy);
  state.identity.expected = { ...state.identity.expected, installedPath, mainPath, vsixPath, mainSha256: hashFile(mainPath), vsixSha256: hashFile(vsixPath) };
  state.identity.before = { ...state.identity.before, ...state.identity.expected, contextPath: installedPath, moduleCachePath: mainPath };
  state.identity.after = { ...state.identity.before, mainSha256: '9'.repeat(64) };
  if (missing) delete state.identity.after.mainSha256;
  const hostBefore = structuredClone(state.identity.before);
  const hostAfter = structuredClone(state.identity.after);
  fs.writeFileSync(path.join(evidenceRoot, 'acceptance-state.json'), JSON.stringify(state));
  const collected = acceptanceHarness.collectAcceptanceState({ evidenceRoot, acceptanceConfig: { owner, evidenceRoot, beforeArchiveCopy, orderArchiveCopy,
    historyRoot: staged.historyRoot, coldCanary: staged.coldCanary, acceptancePlan: { files: plan.files, activationOrder: state.expectedOrder }, expectedBuildIdentity: state.identity.expected,
    sourceRoot: process.cwd(), packageIdentity: { vsixMainEntry: 'extension/dist/extension.js' } } });
  assert.deepEqual(collected.identity.before, hostBefore);
  assert.deepEqual(collected.identity.after, hostAfter, 'Parent hashes cannot replace a host observation');
  assert.equal(collected.identity.parentFinal.mainSha256, hashFile(mainPath));
  assert.equal(collected.collection.coldCanary.verified, true);
  assert.equal(collected.collection.coldCanary.checkedSourceCount, 1);
  assert.equal(collected.collection.coldCanary.sha256, staged.coldCanary.sha256);
  assert.equal(collected.collection.coldCanary.sourceSha256, staged.coldCanary.sha256);
  assert.equal(collected.collection.coldCanary.rootMarker, owner.marker);
  assert.equal(collected.archive.sourceCount, 131);
  assert.equal(collected.archive.baselineCount, 131);
  assert.equal(collected.untouched.checkedSourceCount, 131);
  assert.notEqual(classify({ ...evidence, acceptance: collected }, false).primary, 'PASS_UNREVIEWED_VISUAL');
  assert.equal(JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'acceptance-state.json'), 'utf8')).identity.after.mainSha256, hostAfter.mainSha256);
});

test('acceptance pixel admission rejects blank or gray control regions despite healthy chrome and DOM', () => {
  const capture = { phase: 'cold-controls', native: true, pid: 100, hwnd: '0x123', foregroundHwnd: '0x123', bounds: { x: 0, y: 0, width: 1280, height: 1000 }, dpi: 96, currentFrame: true, fallback: false, sha256: 'a'.repeat(64) };
  capture.controlProof = { requiredRegions: ['query-controls', 'query-toggle'], regions: [{ name: 'query-controls', elementId: 'legacy_run_btn', x: 20, y: 120, width: 120, height: 24 },
    { name: 'query-toggle', elementId: 'legacy_run_toggle', x: 140, y: 120, width: 24, height: 24 }] };
  const decoded = { width: 1280, height: 1000, regions: capture.controlProof.regions.map(region => ({ ...region, samples: 1000, uniqueColors: 40, luminanceRange: 120, edgePixels: 180, chromaticPixels: 100, sha256: 'a'.repeat(64) })) };
  const accepted = acceptanceHarness.assessControlPixels(capture, decoded);
  assert.equal(accepted.controlsNonblank, true);
  assert.equal(accepted.visualReview, 'human-unreviewed');
  for (const region of [{ ...decoded.regions[0], uniqueColors: 1, luminanceRange: 0, edgePixels: 0, chromaticPixels: 0 },
    { ...decoded.regions[0], chromaticPixels: 0 }, { ...decoded.regions[0], samples: 0 }, { ...decoded.regions[0], name: 'chrome-only' }]) {
    assert.equal(acceptanceHarness.assessControlPixels(capture, { ...decoded, regions: [region, decoded.regions[1]] }).controlsNonblank, false);
  }
  assert.equal(acceptanceHarness.assessControlPixels({ ...capture, fallback: true }, decoded).controlsNonblank, false);
  assert.equal(acceptanceHarness.assessControlPixels(capture, { ...decoded, width: 1 }).controlsNonblank, false);
});

function controlGeometryFixture(phase = 'cold-menu') {
  const sectionId = 'legacy';
  const uri = 'file:///C:/TEMP/kw-acceptance-unit/history/cold.kqlx';
  const regions = [{ name: 'query-controls', elementId: sectionId + '_run_btn', x: 20, y: 20, width: 120, height: 24, disabled: false },
    { name: 'query-toggle', elementId: sectionId + '_run_toggle', x: 140, y: 20, width: 24, height: 24, disabled: false }];
  if (phase === 'cold-menu' || phase === 'cold-escape') regions.push({ name: 'query-menu', elementId: sectionId + '_run_menu', x: 20, y: 44, width: 240, height: 160 });
  const probe = { phase, sectionId, token: 'fresh-' + phase, frameUrl: 'vscode-webview://owned-frame/', documentTitle: 'owned.kqlx', query: '',
    viewport: { width: 1280, height: 900, dpr: 1 }, ready: true, menuOpen: phase === 'cold-menu', expectedRunDisabled: false, regions };
  const target = { uri, sectionId, panel: { uri, handle: 'owned-frame', generation: 1, active: true, visible: true } };
  const resolvedContext = { resolutionId: phase === 'cold-escape' ? 2 : 1, targetId: 'owned-target', targetType: 'page', targetTitle: 'owned.kqlx',
    targetUrl: probe.frameUrl, contextId: 42, uniqueContextId: 'actual-context', captureMarker: 'actual-marker-' + phase };
  const capture = { phase, native: true, pid: 100, hwnd: '0x123', foregroundHwnd: '0x123', bounds: { x: 0, y: 0, width: 1280, height: 1000 },
    dpi: 96, currentFrame: true, fallback: false, resolvedContext, webviewSynchronization: { ...resolvedContext, visibilityState: 'visible', barrier: 'animation-frame+Page.captureScreenshot' } };
  const documents = { frameOwner: { targetId: 'owned-target', frameId: 'actual-owned-frame', frameUrl: probe.frameUrl, backendNodeId: 501,
    quad: [0, 100, 1280, 100, 1280, 1000, 0, 1000], shell: { documentTitle: 'Owned shell', visibilityState: 'visible', viewport: { width: 1280, height: 1000, dpr: 1 } } },
    nativeDocuments: [{ id: 'native-owned-document', controlType: 'Document', name: 'Owned shell', isVisible: true, bounds: { x: 0, y: 0, width: 1280, height: 1000 } }] };
  return { probe, target, capture, documents };
}

test('acceptance actual null panel handle with wildcard CSP remains BLOCKED without a fabricated identity or dropped matcher', () => {
  const fixture = controlGeometryFixture('cold-controls');
  fixture.target.panel.handle = null;
  fixture.target.panel.cspSource = 'https://*.vscode-cdn.net';
  assert.throws(() => acceptanceHarness.correlateControlRegions(fixture.probe, fixture.target, fixture.capture, fixture.documents),
    /BLOCKED: exact URI-to-native-panel-to-CDP-frame identity unavailable/);
  assert.equal(fixture.target.panel.handle, null);
});

const nativeDocumentLookupSource = fs.readFileSync(new URL('../../scripts/repro-published-notebook.mjs', import.meta.url), 'utf8')
  .match(/^async function readNativeDocuments\([\s\S]*?^}/m)?.[0];
assert.ok(nativeDocumentLookupSource, 'Exercise the actual acceptance native-document adapter');
const readNativeDocuments = new Script('(' + nativeDocumentLookupSource + ')').runInThisContext();

test('acceptance native wrapped tree binds exact document bounds, URI, frame owner and main/toggle/menu targets', async () => {
  const { probe, target, capture, documents } = controlGeometryFixture();
  const window = { id: 'exact-prepared-window', processId: capture.pid, nativeHandle: capture.hwnd };
  const document = { ...documents.nativeDocuments[0], isEnabled: true };
  const tree = {
    element: { id: window.id, name: 'Prepared window', controlType: 'Window', isVisible: true, isEnabled: true, bounds: capture.bounds },
    children: [{
      element: { id: 'native-pane', name: '', controlType: 'Pane', isVisible: true, isEnabled: true, bounds: capture.bounds },
      children: [
        { element: { ...document, id: 'other-uri-document', name: 'Other shell' }, children: [] },
        { element: document, children: [] },
      ],
    }],
  };
  const calls = [];
  const nativeUI = { getElementTree: async windowId => { calls.push(windowId); return tree; } };
  const nativeDocuments = await readNativeDocuments(nativeUI, window, documents.frameOwner.shell.documentTitle);
  assert.deepEqual(calls, [window.id], 'Use only the exact prepared window');
  assert.deepEqual(nativeDocuments, documents.nativeDocuments);
  assert.equal(nativeDocuments[0].bounds, document.bounds, 'Preserve observed element bounds without inventing geometry');
  const geometry = { frameOwner: documents.frameOwner, nativeDocuments };
  const proof = acceptanceHarness.correlateControlRegions(probe, target, capture, geometry);
  assert.equal(proof.uri, target.uri);
  assert.equal(proof.sectionId, target.sectionId);
  assert.equal(proof.panelGeneration, target.panel.generation);
  assert.equal(proof.panelHandle, target.panel.handle);
  assert.equal(proof.nativeDocumentId, document.id);
  assert.equal(proof.frameUrl, probe.frameUrl);
  assert.equal(proof.frameOwner, documents.frameOwner);
  assert.deepEqual(proof.requiredRegions, ['query-controls', 'query-toggle', 'query-menu']);
  assert.deepEqual(proof.regions, [
    { name: 'query-controls', elementId: 'legacy_run_btn', x: 20, y: 120, width: 120, height: 24, disabled: false },
    { name: 'query-toggle', elementId: 'legacy_run_toggle', x: 140, y: 120, width: 24, height: 24, disabled: false },
    { name: 'query-menu', elementId: 'legacy_run_menu', x: 20, y: 144, width: 240, height: 160, disabled: false },
  ]);
  for (const change of [
    value => value.target.panel.uri = 'file:///other/cold.kqlx',
    value => value.probe.frameUrl = 'vscode-webview://other-frame/',
    value => value.documents.frameOwner.targetId = 'other-owner',
    ...[0, 1, 2].map(index => value => value.probe.regions[index].elementId = 'other-control'),
  ]) {
    const changed = structuredClone({ probe, target, capture, documents: geometry });
    change(changed);
    assert.throws(() => acceptanceHarness.correlateControlRegions(changed.probe, changed.target, changed.capture, changed.documents), /URI|frame|owner|region/i);
  }
});

test('acceptance native wrapped tree rejects other documents, duplicate windows and hidden matches', async () => {
  const { capture, documents } = controlGeometryFixture();
  const window = { id: 'exact-prepared-window' };
  const document = { ...documents.nativeDocuments[0], isEnabled: true };
  const tree = {
    element: { id: window.id, name: 'Prepared window', controlType: 'Window', isVisible: true, isEnabled: true, bounds: capture.bounds },
    children: [{ element: document, children: [] }],
  };
  for (const response of [
    { ...tree, children: [{ element: { ...document, name: 'Other shell' }, children: [] }] },
    [tree, { ...tree, element: { ...tree.element, id: 'duplicate-window' } }],
    { ...tree, children: [{ element: { ...document, isVisible: false }, children: [] }] },
  ]) {
    const nativeUI = { getElementTree: async windowId => { assert.equal(windowId, window.id); return response; } };
    await assert.rejects(readNativeDocuments(nativeUI, window, documents.frameOwner.shell.documentTitle), /unavailable or ambiguous/);
  }
});

test('acceptance native document rejection retains bounded SDK shape and geometry without child-control content', async () => {
  const window = { id: 'owned-window', processId: 123, nativeHandle: '0x123', title: 'Expected shell', bounds: { x: 0, y: 0, width: 1280, height: 1000 } };
  const element = { id: 'actual-document', controlType: 'Document', name: 'Different UIA name', isVisible: true,
    bounds: { x: 8, y: 8, width: 1264, height: 992 }, value: 'private-query-value' };
  const tree = { element: { ...window, name: window.title, controlType: 'Window', isVisible: true }, children: [
    { element, children: [{ element: { id: 'query-editor', controlType: 'Edit', name: 'private-query-name', value: 'private-query-value' }, children: [] }] },
  ] };
  const diagnostics = {};
  const calls = [];
  await assert.rejects(readNativeDocuments({ getElementTree: async (...args) => { calls.push(args); return tree; } }, window, window.title, diagnostics), /unavailable or ambiguous/);
  assert.deepEqual(calls, [[window.id]], 'Use the actual one-argument SDK method on only the prepared window');
  assert.deepEqual(diagnostics.nativeTree.request, { method: 'getElementTree', windowId: window.id, maxDepth: null });
  assert.deepEqual(diagnostics.nativeTree.preparedWindow, window, 'Retain the actual prepared PID/HWND and window bounds');
  assert.equal(diagnostics.nativeTree.responseShape.kind, 'object');
  assert.deepEqual(diagnostics.nativeTree.responseShape.keys, ['element', 'children']);
  assert.equal(diagnostics.nativeTree.roots[0].id, window.id);
  assert.deepEqual(diagnostics.nativeTree.roots[0].bounds, window.bounds);
  assert.deepEqual(diagnostics.nativeTree.documents, [{ id: element.id, controlType: element.controlType, name: element.name,
    isVisible: true, bounds: element.bounds, depth: 1 }]);
  assert.equal(diagnostics.nativeTree.visited, 3);
  assert.equal(diagnostics.nativeTree.maximumDepth, 2);
  assert.equal(diagnostics.nativeTree.matchCount, 0);
  assert.equal(diagnostics.nativeTree.truncated, false);
  assert.equal(JSON.stringify(diagnostics).includes('private-query'), false, 'Never retain names/values from query controls');
});

test('acceptance native document diagnostics bound retained nodes and inventory without admitting truncated evidence', async () => {
  const window = { id: 'owned-window' };
  const document = { id: 'owned-document', controlType: 'Document', name: 'Expected shell', isVisible: true,
    bounds: { x: 8, y: 8, width: 1264, height: 992 } };
  const root = { element: { id: window.id, controlType: 'Window', name: 'Expected shell' }, children: [] };
  for (const size of [65, 12001]) {
    const diagnostics = {};
    const tree = { ...root, children: Array.from({ length: size }, (_, index) => ({ element: { ...document, id: 'document-' + index }, children: [] })) };
    await assert.rejects(readNativeDocuments({ getElementTree: async () => tree }, window, document.name, diagnostics), /unavailable or ambiguous|bounded tree inventory/);
    assert.equal(diagnostics.nativeTree.documents.length, 64);
    assert.equal(diagnostics.nativeTree.visited, Math.min(size + 1, 12000));
    assert.equal(diagnostics.nativeTree.matchCount, Math.min(size, 11999));
    assert.equal(diagnostics.nativeTree.truncated, true);
  }
  const diagnostics = {};
  const roots = Array.from({ length: 9 }, () => ({ ...root, children: [{ element: document, children: [] }] }));
  await assert.rejects(readNativeDocuments({ getElementTree: async () => roots }, window, document.name, diagnostics), /unavailable or ambiguous/);
  assert.equal(diagnostics.nativeTree.roots.length, 8);
  assert.equal(diagnostics.nativeTree.truncated, true);
});

test('acceptance intended Query geometry binds exact URI, frame, section and separate main/toggle/menu regions', () => {
  const { probe, target, capture, documents } = controlGeometryFixture();
  const proof = acceptanceHarness.correlateControlRegions(probe, target, capture, documents);
  assert.equal(proof.uri, target.uri);
  assert.equal(proof.sectionId, target.sectionId);
  assert.deepEqual(proof.requiredRegions, ['query-controls', 'query-toggle', 'query-menu']);
  assert.deepEqual(proof.regions.map(region => [region.name, region.x, region.y]), [['query-controls', 20, 120], ['query-toggle', 140, 120], ['query-menu', 20, 144]]);
  for (const change of [value => value.target.panel.uri = 'file:///neighbor.kqlx', value => value.target.panel.active = false,
    value => value.target.sectionId = 'neighbor', value => value.probe.frameUrl = 'vscode-webview://neighbor-frame/',
    value => value.probe.regions[0].elementId = 'neighbor_run_btn', value => value.probe.menuOpen = false,
    value => value.documents.nativeDocuments.push({ ...value.documents.nativeDocuments[0], id: 'ambiguous-document' }),
    value => value.documents.nativeDocuments[0].bounds.width = 100, value => value.probe.regions.splice(2),
    value => value.probe.regions[1].x = 2000]) {
    const changed = structuredClone({ probe, target, capture, documents });
    change(changed);
    assert.throws(() => acceptanceHarness.correlateControlRegions(changed.probe, changed.target, changed.capture, changed.documents), /URI|frame|section|geometry|menu|region|ambiguous|visible/i);
  }
});

test('acceptance geometry rejects a neighboring CDP frame owner even when native document titles and Run names coincide', () => {
  const geometry = controlGeometryFixture();
  geometry.documents.frameOwner = { targetId: 'neighbor', frameId: 'neighbor-frame', backendNodeId: 99 };
  assert.throws(() => acceptanceHarness.correlateControlRegions(geometry.probe, geometry.target, geometry.capture, geometry.documents), /frame.*owner|frame.*identity|native.*geometry/i);
});

test('acceptance native geometry remains exact before and after capture rather than borrowing an earlier footprint', () => {
  const geometry = controlGeometryFixture().documents;
  assert.doesNotThrow(() => acceptanceHarness.assertStableNativeGeometry(geometry, structuredClone(geometry)));
  for (const mutate of [value => value.frameOwner.quad[0] += 50, value => value.frameOwner.backendNodeId++,
    value => value.frameOwner.shell.viewport.dpr = 2, value => value.nativeDocuments[0].bounds.y += 30]) {
    const after = structuredClone(geometry);
    mutate(after);
    assert.throws(() => acceptanceHarness.assertStableNativeGeometry(geometry, after), /geometry|footprint|frame/i);
  }
  assert.ok(acceptanceHarness.createAcceptanceSession.toString().includes('raw.afterNativeGeometry'), 'Observe the actual post-capture footprint');
});

test('acceptance menu pixels cannot be replaced by healthy main-button or neighboring-control pixels', () => {
  const capture = { phase: 'cold-menu', native: true, pid: 100, hwnd: '0x123', foregroundHwnd: '0x123', bounds: { width: 1280, height: 1000 },
    dpi: 96, currentFrame: true, fallback: false, controlProof: { requiredRegions: ['query-controls', 'query-toggle', 'query-menu'],
      regions: [{ name: 'query-controls', elementId: 'legacy_run_btn', x: 20, y: 120, width: 120, height: 24 },
        { name: 'query-toggle', elementId: 'legacy_run_toggle', x: 140, y: 120, width: 24, height: 24 },
        { name: 'query-menu', elementId: 'legacy_run_menu', x: 20, y: 144, width: 240, height: 160 }] } };
  const statistics = capture.controlProof.regions.map(region => ({ ...region, samples: 1000, uniqueColors: 40, luminanceRange: 120, edgePixels: 180, chromaticPixels: 100, sha256: 'a'.repeat(64) }));
  const decoded = { width: 1280, height: 1000, regions: statistics };
  assert.equal(acceptanceHarness.assessControlPixels(capture, decoded).controlsNonblank, true);
  for (const regions of [statistics.slice(0, 1), statistics.slice(0, 2),
    statistics.map(region => region.name === 'query-menu' ? { ...region, uniqueColors: 1, luminanceRange: 0, edgePixels: 0 } : region),
    statistics.map(region => region.name === 'query-controls' ? { ...region, elementId: 'neighbor_run_btn', x: 800 } : region)]) {
    assert.equal(acceptanceHarness.assessControlPixels(capture, { ...decoded, regions }).controlsNonblank, false, 'Healthy chrome or duplicate Run names are not intended-region proof');
  }
});

test('acceptance visible-menu and Escape evidence requires different synchronized frames and changed menu-region pixels', () => {
  const menu = { ...controlGeometryFixture('cold-menu').capture, controlProof: { uri: 'owned', sectionId: 'legacy', panelGeneration: 1, token: 'menu-token', menuVisible: true },
    regions: [{ name: 'query-menu', sha256: 'a'.repeat(64) }] };
  const escape = { ...controlGeometryFixture('cold-escape').capture, controlProof: { uri: 'owned', sectionId: 'legacy', panelGeneration: 1, token: 'escape-token', menuVisible: false },
    regions: [{ name: 'query-menu', sha256: 'b'.repeat(64) }] };
  assert.equal(acceptanceHarness.verifyMenuEscapeFrames(menu, escape), true);
  for (const changed of [{ ...escape, regions: menu.regions }, { ...escape, resolvedContext: menu.resolvedContext },
    { ...escape, controlProof: { ...escape.controlProof, token: menu.controlProof.token } },
    { ...escape, controlProof: { ...escape.controlProof, sectionId: 'neighbor' } },
    { ...escape, controlProof: { ...escape.controlProof, menuVisible: true } }]) {
    assert.equal(acceptanceHarness.verifyMenuEscapeFrames(menu, changed), false);
  }
});

test('acceptance feature fragment is opt-in, syntactically valid and contains the composed native lifecycle', () => {
  const source = fs.readFileSync(new URL('../vscode-extension-tester/e2e/default/workbench-tool-session-activation-sweep/workbench-tool-session-activation-sweep.feature', import.meta.url), 'utf8');
  const feature = acceptanceHarness.extractAcceptanceFeature(source);
  assert.ok(feature.startsWith('Feature:'));
  assert.equal((feature.match(/Scenario:/g) || []).length, 1);
  for (const boundary of ['cold-controls', 'cold-menu', 'historical-83', 'historical-88', 'historical-109', 'reopened-controls', 'second-interaction', 'workbench.action.files.save', 'When I type', 'When I press "Escape"']) assert.ok(feature.includes(boundary), boundary);
  for (const forbidden of ['Given the extension is in a clean state', 'kustoWorkbench.test.', 'revertAndClose', 'closeAllEditors', 'closeActiveEditor', 'restore-original', 'configure-query-section']) assert.equal(feature.includes(forbidden), false, forbidden);
  assert.equal(feature.includes('.find(item => window.queryEditors'), false, 'Do not substitute a healthy neighboring Query section');
  assert.ok(feature.includes("typeof section?.executionCtrl?.isRunSelectionReady !== 'function'"), 'Observe the actual target-readiness predicate');
  const blocks = [...feature.matchAll(/"""\r?\n([\s\S]*?)\r?\n\s*"""/g)].map(match => match[1]);
  const inline = [...feature.matchAll(/from (?:extension host|webview) expression "(.*)"/g)].map(match => match[1]);
  assert.ok(blocks.length > 0);
  for (const expression of [...blocks, ...inline]) assert.doesNotThrow(() => new Script(expression));
  assert.equal(feature.includes('Reactivate and author the immutable original109 copies'), false);
  assert.throws(() => acceptanceHarness.extractAcceptanceFeature('Feature: missing fragment'), /fragment/i);
});

test('acceptance staged lifecycle wires actual synchronization, exact-frame probes, native toggle input and a separate Escape capture', () => {
  const source = fs.readFileSync(new URL('../vscode-extension-tester/e2e/default/workbench-tool-session-activation-sweep/workbench-tool-session-activation-sweep.feature', import.meta.url), 'utf8');
  const feature = acceptanceHarness.extractAcceptanceFeature(source);
  assert.equal(feature.includes('queryExecuted: false'), false, 'Never manufacture an execution assertion in a DOM probe');
  assert.ok(feature.includes("acceptControl('cold-escape')"), 'Escape must capture a later frame of the menu region');
  assert.ok(feature.includes('clickColdToggle()'), 'Use the actual native toggle input at its correlated bounds');
  for (const field of ['frameUrl', 'viewport', 'regions', 'token', 'menuOpen']) assert.ok(feature.includes(field), field);
  const implementation = acceptanceHarness.createAcceptanceSession.toString();
  assert.ok(implementation.includes('captureSynchronizedNativeFrame('));
  assert.ok(implementation.includes('new CdpClient('));
  assert.equal(implementation.includes('nativeUI.findElement(window.id, probe.accessibleName'), false, 'Never use a window-wide Run lookup');
});

async function actualTesterControlProbeFixture({ includeExact = true, splitTargets = true, wrongToken = 'stale-token' } = {}) {
  const modules = path.join(process.env.APPDATA, 'npm/node_modules/vscode-ext-test/dist/runner');
  const { CdpClient } = await import(pathToFileURL(path.join(modules, 'cdp-client.js')).href);
  const probe = { phase: 'cold-controls', ready: true, sectionId: 'legacy', query: '', expectedRunDisabled: true,
    mainRunDisabled: true, toggleDisabled: false, token: 'exact-current-token', frameUrl: 'vscode-webview://exact-frame/index.html',
    documentTitle: 'cold.kqlx', viewport: { width: 640, height: 480, dpr: 1 },
    regions: [{ name: 'query-controls', elementId: 'legacy_run_btn', x: 20, y: 30, width: 120, height: 24, disabled: true },
      { name: 'query-toggle', elementId: 'legacy_run_toggle', x: 140, y: 30, width: 24, height: 24, disabled: false }],
    menuOpen: false, menuLabels: [], dismissed: false };
  const controls = new Map(probe.regions.map(region => [region.elementId, { id: region.elementId, disabled: region.disabled,
    getBoundingClientRect: () => ({ ...region, left: region.x, top: region.y, right: region.x + region.width, bottom: region.y + region.height }) }]));
  const menu = { id: 'legacy_run_menu' };
  const section = { id: probe.sectionId, executionCtrl: { isRunSelectionReady: () => false }, querySelector: () => ({}) };
  const sandbox = { __original109ControlProbe: Object.freeze(probe), queryEditors: { legacy: { getValue: () => probe.query } },
    document: { title: probe.documentTitle, visibilityState: 'visible', getElementById: id => id === section.id ? section : id === menu.id ? menu : controls.get(id) },
    location: { href: probe.frameUrl }, innerWidth: 640, innerHeight: 480, devicePixelRatio: 1,
    getComputedStyle: element => ({ display: element === menu ? 'none' : 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto' }),
    requestAnimationFrame: callback => callback() };
  sandbox.window = sandbox;
  const wrong = { id: 7, uniqueId: 'wrong-context', sandbox: createContext(wrongToken === null ? {} : { __original109ControlProbe: { token: wrongToken } }) };
  const exact = { id: 42, uniqueId: 'exact-context', sandbox: createContext(sandbox) };
  const welcome = { id: 'welcome-target', title: 'Welcome', url: 'vscode-webview://welcome-frame/' };
  const owned = { id: 'owned-target', title: probe.documentTitle, url: probe.frameUrl };
  const targets = splitTargets ? [welcome, ...(includeExact ? [owned] : [])] : [owned];
  const calls = [];
  const clients = new Map(targets.map(target => {
    const contexts = splitTargets && target === owned ? [exact] : [wrong, ...(!splitTargets && includeExact ? [exact] : [])];
    return [target.id, { contexts, Runtime: { evaluate: async request => {
      const frame = contexts.find(value => request.uniqueContextId ? value.uniqueId === request.uniqueContextId : value.id === request.contextId);
      assert.ok(frame, 'Use the actual SDK-selected numeric or unique context');
      assert.equal(request.returnByValue, true);
      calls.push({ targetId: target.id, contextId: frame.id, request });
      try {
        const pending = new Script(request.expression).runInContext(frame.sandbox, { timeout: 1000 });
        const value = request.awaitPromise ? await pending : pending;
        return { result: { type: typeof value, ...(value === undefined ? {} : { value: JSON.parse(JSON.stringify(value)) }) } };
      } catch (error) {
        return { result: { type: 'object', subtype: 'error' }, exceptionDetails: { text: 'Uncaught', exception: { description: error.stack } } };
      }
    } } }];
  }));
  const cdp = new CdpClient(0);
  cdp.onActivateTab = () => assert.fail('Exact control verification must not change the current tab or focus');
  cdp.getWebviewTargets = async title => { assert.equal(title, undefined); return targets; };
  cdp.discoverFrameContexts = async client => client.contexts;
  cdp.withWebviewClient = async (targetId, action, options) => {
    assert.deepEqual(options, { operationTimeoutMs: 5000, retries: 1, retryOperationTimeouts: false });
    return action(clients.get(targetId));
  };
  const expressionSource = acceptanceHarness.createAcceptanceSession.toString().match(/const expression = (`[^\n]+`);/);
  assert.ok(expressionSource, 'Exercise the actual acceptControl expression, not a rewritten guard');
  const expression = new Script(expressionSource[1]).runInNewContext({ probe, name: probe.phase, raw: { target: { sectionId: probe.sectionId } },
    expectation: 'closed', readAcceptanceControlDom: acceptanceHarness.readAcceptanceControlDom });
  const rejectionSource = acceptanceHarness.createAcceptanceSession.toString().match(/\} catch \(error\) \{ (raw\.error = [^\n]+) \}/);
  assert.ok(rejectionSource, 'Exercise the actual acceptControl rejection classification');
  const rejectCapture = new Script('(error, raw) => { ' + rejectionSource[1] + ' }').runInNewContext({ clip: message => String(message) });
  return { cdp, calls, probe, expression, targets, rejectCapture };
}

test('acceptance actual SDK control re-probe skips a wrong-token target and resolves the exact async Query frame', async () => {
  const { cdp, calls, probe, expression } = await actualTesterControlProbeFixture();
  const beforeProbe = await cdp.evaluateInWebview(expression, undefined, { timeoutMs: 5000 });
  assert.notEqual(beforeProbe, undefined, 'The installed SDK must not credit an undefined wrong-target re-probe');
  const { paintedAt, ...current } = beforeProbe;
  assert.equal(typeof paintedAt, 'number');
  assert.deepEqual(current, probe);
  assert.deepEqual(calls.filter(call => call.request.expression === expression).map(call => [call.targetId, call.contextId]),
    [['welcome-target', 7], ['owned-target', 42]]);
  assert.equal(cdp.resolvedWebviewContext.targetId, 'owned-target');
  assert.equal(cdp.resolvedWebviewContext.contextId, 42);
  assert.equal(cdp.resolvedWebviewContext.uniqueContextId, 'exact-context');
  assert.equal(cdp.resolvedWebviewContext.activationTitle, undefined);
});

test('acceptance actual SDK control re-probe traverses an unmarked outer context without title activation', async () => {
  const { cdp, calls, probe, expression } = await actualTesterControlProbeFixture({ splitTargets: false, wrongToken: null });
  const { paintedAt, ...current } = await cdp.evaluateInWebview(expression, undefined, { timeoutMs: 5000 });
  assert.equal(typeof paintedAt, 'number');
  assert.deepEqual(current, probe);
  const attempts = calls.filter(call => call.request.expression === expression);
  assert.deepEqual(attempts.map(call => call.contextId), [7, 42]);
  assert.ok(attempts.every(call => call.request.awaitPromise === true));
  assert.equal(cdp.resolvedWebviewContext.uniqueContextId, 'exact-context');
  assert.equal(cdp.resolvedWebviewContext.activationTitle, undefined);
});

test('acceptance actual SDK control re-probe blocks missing or stale tokens and retires its previous capture resolution', async () => {
  for (const wrongToken of [null, 'stale-token']) {
    const { cdp, calls, probe, expression, targets, rejectCapture } = await actualTesterControlProbeFixture({ wrongToken });
    assert.equal((await cdp.evaluateInWebview(expression, undefined, { timeoutMs: 5000 })).token, probe.token);
    assert.equal(cdp.hasResolvedWebviewForNativeCapture, true);
    targets.pop();
    const attempted = calls.length;
    const raw = { native: false, currentFrame: false, fallback: true };
    await assert.rejects(() => cdp.evaluateInWebview(expression, undefined, { timeoutMs: 5000 }), error => {
      rejectCapture(error, raw);
      assert.match(raw.error, /BLOCKED: exact Query control frame token missing or changed/);
      assert.equal(raw.blocked, true, 'The actual caller must report a missing exact frame as BLOCKED, not a product rejection');
      return true;
    });
    assert.equal(cdp.hasResolvedWebviewForNativeCapture, false, 'Never reuse the prior successful capture context');
    assert.deepEqual(calls.slice(attempted).map(call => [call.targetId, call.contextId, call.request.expression]), [['welcome-target', 7, expression]]);
    assert.equal(raw.native, false);
    assert.equal(raw.currentFrame, false);
    assert.equal(Object.hasOwn(raw, 'controlProof'), false);
  }
});

async function actualTesterCaptureFixture() {
  const modules = path.join(process.env.APPDATA, 'npm/node_modules/vscode-ext-test/dist/runner');
  const { CdpClient } = await import(pathToFileURL(path.join(modules, 'cdp-client.js')).href);
  const { NativeUIClient } = await import(pathToFileURL(path.join(modules, 'native-ui-client.js')).href);
  const calls = [];
  const resolved = { resolutionId: 7, targetId: 'owned-target', targetType: 'page', targetTitle: 'owned.kqlx', targetUrl: 'vscode-webview://owned-frame/',
    contextId: 42, uniqueContextId: 'actual-context', captureMarker: 'actual-tester-marker' };
  const cdp = Object.create(CdpClient.prototype);
  cdp.resolvedWebviewContext = { ...resolved };
  cdp.withProtocolTimeout = operation => operation;
  cdp.withWebviewClient = async (target, action, options) => {
    assert.equal(target, resolved.targetId);
    assert.equal(options.retries, 1);
    assert.equal(options.retryOperationTimeouts, false);
    return action({ Runtime: { evaluate: async request => {
      calls.push('guest-animation-frame');
      assert.equal(request.uniqueContextId, resolved.uniqueContextId);
      assert.equal(request.awaitPromise, true);
      assert.match(request.expression, /requestAnimationFrame/);
      assert.match(request.expression, /actual-tester-marker/);
      return { result: { value: { visibilityState: 'visible' } } };
    } }, Page: { enable: async () => calls.push('page-enable'), captureScreenshot: async request => {
      calls.push('guest-surface-barrier');
      assert.deepEqual(request, { format: 'png', fromSurface: true });
      return { data: 'bounded-unit-transport-image-data' };
    } } });
  };
  const native = { expected: { processId: 100, hwnd: '0x123' }, target: { processId: 100, hwnd: '0x123' },
    foregroundBefore: { processId: 100, hwnd: '0x123' }, foregroundAtCapture: { processId: 100, hwnd: '0x123' }, foregroundAfter: { processId: 100, hwnd: '0x123' },
    bounds: { x: 0, y: 0, width: 1280, height: 1000 }, dpi: 96,
    validation: { targetMatchesForegroundAtCapture: true } };
  const result = { success: true, strategy: 'CopyFromScreen', width: 1280, height: 1000, warnings: [], attempts: [{ attempt: 1, strategy: 'CopyFromScreen', success: true }], metadata: native };
  const window = { id: 'native-window', processId: 100, nativeHandle: '0x123', title: 'Owned unit transport' };
  const nativeUI = Object.create(NativeUIClient.prototype);
  nativeUI.prepareDevHostScreenshot = async () => { calls.push('prepare-native-window'); return window; };
  nativeUI.captureWindowScreenshot = async (id, file, expectedWindow, options) => {
    calls.push('native-capture');
    assert.equal(id, window.id);
    assert.equal(typeof file, 'string');
    assert.deepEqual(expectedWindow, { processId: 100, title: window.title, windowHandle: '0x123' });
    assert.deepEqual(options, { preserveForeground: true });
    return result;
  };
  return { calls, cdp, nativeUI, resolved, result, window };
}

test('acceptance native capture admission uses the actual tester synchronization response, not invented native booleans', async () => {
  const { cdp, resolved, result } = await actualTesterCaptureFixture();
  const synchronization = await cdp.synchronizeResolvedWebviewForNativeCapture();
  assert.equal(Object.hasOwn(result.metadata.validation, 'compositorSynchronized'), false);
  assert.equal(Object.hasOwn(synchronization, 'compositorSynchronized'), false);
  assert.equal(synchronization.barrier, 'animation-frame+Page.captureScreenshot');
  const expected = { pid: 100, hwnd: '0x123' };
  assert.equal(acceptanceHarness.admitNativeCapture(result, expected, synchronization, resolved).currentFrame, true);
  for (const mutate of [value => value.metadata.target.processId++, value => value.metadata.foregroundAtCapture.hwnd = '0x999',
    value => value.metadata.dpi = null, value => value.metadata.validation.targetMatchesForegroundAtCapture = false,
    value => value.strategy = 'PrintWindow-fallback', value => value.width = 1279, value => value.warnings.push('fallback'),
    value => value.attempts.push({ attempt: 2, strategy: 'CopyFromScreen', success: true })]) {
    const changed = structuredClone(result);
    mutate(changed);
    assert.throws(() => acceptanceHarness.admitNativeCapture(changed, expected, synchronization, resolved), /native|capture|frame|DPI|foreground|fallback|bounds/i);
  }
  for (const changed of [undefined, { compositorSynchronized: true }, { ...synchronization, contextId: 99 }, { ...synchronization, targetId: 'neighbor' },
    { ...synchronization, uniqueContextId: 'replaced-context' }, { ...synchronization, visibilityState: 'hidden' }, { ...synchronization, barrier: 'none' }]) {
    assert.throws(() => acceptanceHarness.admitNativeCapture(result, expected, changed, resolved), /synchron|context|frame|target/i);
  }
});

test('acceptance frame-owner adapter uses actual CDP frame-tree/owner/box-model responses and blocks missing domains', async () => {
  const { cdp, resolved } = await actualTesterCaptureFixture();
  const calls = [];
  cdp.withWebviewClient = async (target, action, options) => {
    assert.equal(target, resolved.targetId);
    assert.equal(options.retries, 1);
    assert.equal(options.retryOperationTimeouts, false);
    return action({ Page: { getFrameTree: async () => { calls.push('Page.getFrameTree'); return { frameTree: { frame: { id: 'actual-root-frame', url: resolved.targetUrl } } }; } } });
  };
  cdp.client = { DOM: { getFrameOwner: async request => { calls.push('DOM.getFrameOwner'); assert.deepEqual(request, { frameId: 'actual-root-frame' }); return { backendNodeId: 501 }; },
    getBoxModel: async request => { calls.push('DOM.getBoxModel'); assert.deepEqual(request, { backendNodeId: 501 }); return { model: { content: [0, 100, 1280, 100, 1280, 1000, 0, 1000] } }; } },
    Runtime: { evaluate: async request => { calls.push('Runtime.evaluate'); assert.equal(request.returnByValue, true); assert.match(request.expression, /document\.title/);
      return { result: { value: { documentTitle: 'Owned shell', visibilityState: 'visible', viewport: { width: 1280, height: 1000, dpr: 1 } } } }; } } };
  const owner = await acceptanceHarness.readAcceptanceFrameOwner(cdp, resolved);
  assert.equal(owner.frameId, 'actual-root-frame');
  assert.equal(owner.backendNodeId, 501);
  assert.equal(owner.frameUrl, resolved.targetUrl);
  assert.deepEqual(calls, ['Page.getFrameTree', 'DOM.getFrameOwner', 'DOM.getBoxModel', 'Runtime.evaluate']);
  delete cdp.client.DOM.getFrameOwner;
  await assert.rejects(() => acceptanceHarness.readAcceptanceFrameOwner(cdp, resolved), /BLOCKED.*frame-owner/i);
  assert.equal(calls.length, 4, 'No synthetic geometry fallback or extra protocol access');
});

test('acceptance synchronized capture adapter calls the real tester CDP barrier immediately before native capture', async () => {
  const { cdp, nativeUI, calls, resolved } = await actualTesterCaptureFixture();
  const capture = await acceptanceHarness.captureSynchronizedNativeFrame(nativeUI, cdp, 'owned-unit-output.png', resolved);
  assert.equal(capture.currentFrame, true);
  assert.deepEqual(calls, ['prepare-native-window', 'page-enable', 'guest-animation-frame', 'guest-surface-barrier', 'native-capture']);
  assert.equal(cdp.hasResolvedWebviewForNativeCapture, false, 'Consume only the exact actual synchronized resolution');
  const missing = await actualTesterCaptureFixture();
  missing.cdp.synchronizeResolvedWebviewForNativeCapture = undefined;
  await assert.rejects(() => acceptanceHarness.captureSynchronizedNativeFrame(missing.nativeUI, missing.cdp, 'never-capture.png', missing.resolved), /BLOCKED.*synchron/i);
  assert.equal(missing.calls.includes('native-capture'), false);
});

test('acceptance CPU decoder reads PNG only and reports flat controls without image viewing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-png-test-'));
  try {
    const file = path.join(root, 'flat.png');
    fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/fccAAAAASUVORK5CYII=', 'base64'));
    const decoded = acceptanceHarness.decodePngControlRegions(file, [{ name: 'query-controls', x: 0, y: 0, width: 1, height: 1 }]);
    assert.equal(decoded.width, 1);
    assert.equal(decoded.height, 1);
    assert.equal(decoded.regions[0].uniqueColors, 1);
    assert.equal(decoded.regions[0].edgePixels, 0);
    assert.throws(() => acceptanceHarness.decodePngControlRegions(file, [{ name: 'query-controls', x: -1, y: 0, width: 1, height: 1 }]), /region|bounds/i);
    fs.writeFileSync(path.join(root, 'not.png'), 'not a PNG');
    assert.throws(() => acceptanceHarness.decodePngControlRegions(path.join(root, 'not.png'), []), /PNG/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('acceptance revision observer retains dirty-then-revert and key-order-only rewrites at the original baseline', () => {
  const evidence = acceptanceEvidence().acceptance;
  const original = '{"kind":"kqlx","version":1,"state":{"sections":[]}}\r\n';
  const reference = { path: 'untouched.kqlx', text: original };
  const revision = { phase: 'open', documentVersion: 1, isDirty: false, text: original };
  acceptanceHarness.recordUntouchedRevision(evidence, reference, revision);
  acceptanceHarness.recordUntouchedRevision(evidence, reference, { ...revision, phase: 'change', documentVersion: 2, isDirty: true });
  acceptanceHarness.recordUntouchedRevision(evidence, reference, { ...revision, phase: 'reverted', documentVersion: 3 });
  acceptanceHarness.recordUntouchedRevision(evidence, reference, { ...revision, phase: 'reordered', documentVersion: 4, text: '{"version":1,"kind":"kqlx","state":{"sections":[]}}\r\n' });
  acceptanceHarness.recordUntouchedRevision(evidence, reference, { ...revision, phase: 'second-revert', documentVersion: 5 });
  assert.equal(evidence.untouched.allRevisionsClean, false);
  assert.equal(evidence.untouched.exactBytes, false);
  assert.equal(evidence.untouched.dirtyTransitions.length, 1);
  assert.equal(evidence.untouched.byteChanges.length, 1);
  assert.equal(reference.text, original);
});

test('acceptance exact cleanup refuses dirty discard, preserves unrelated tabs, and rejects external targets', async context => {
  const owner = acceptanceHarness.createAcceptanceRoot();
  context.after(() => fs.rmSync(owner.root, { recursive: true, force: true }));
  const ownedPath = path.join(owner.root, 'owned.kqlx');
  fs.writeFileSync(ownedPath, makeText());
  const ownedUri = new URL('file:///' + ownedPath.replace(/\\/g, '/')).href;
  const unrelatedUri = new URL('file:///' + path.join(os.tmpdir(), 'normal-profile-original.kqlx').replace(/\\/g, '/')).href;
  const owned = { input: { uri: { toString: () => ownedUri } }, isDirty: true };
  const unrelated = { input: { uri: { toString: () => unrelatedUri } }, isDirty: true };
  const tabs = [owned, unrelated];
  let closeCalls = 0;
  const vscode = { workspace: { textDocuments: [] }, window: { tabGroups: { all: [{ tabs }], close: async target => {
    closeCalls++;
    assert.deepEqual(target, [owned]);
    tabs.splice(tabs.indexOf(owned), 1);
    return true;
  } } } };
  await assert.rejects(() => acceptanceHarness.closeAcceptanceTabs(vscode, owner, [ownedUri]), /dirty|discard/i);
  assert.equal(closeCalls, 0);
  owned.isDirty = false;
  const result = await acceptanceHarness.closeAcceptanceTabs(vscode, owner, [ownedUri]);
  assert.equal(result.survivors, 0);
  assert.equal(result.dirtyDiscard, false);
  assert.equal(closeCalls, 1);
  assert.deepEqual(tabs, [unrelated]);
  await assert.rejects(() => acceptanceHarness.closeAcceptanceTabs(vscode, owner, [unrelatedUri]), /outside|owned/i);
  assert.equal(closeCalls, 1);
});

test('acceptance session refuses pre-existing tabs before reading or activating a Workbench runtime', async context => {
  const owner = acceptanceHarness.createAcceptanceRoot();
  context.after(() => fs.rmSync(owner.root, { recursive: true, force: true }));
  const original = { input: { uri: { toString: () => 'file:///C:/dogfood/original.kqlx' } }, isDirty: false };
  const vscode = { workspace: {}, window: { tabGroups: { all: [{ tabs: [original] }] } }, extensions: { getExtension() { assert.fail('Do not read or activate an existing runtime'); } } };
  await assert.rejects(() => acceptanceHarness.createAcceptanceSession(vscode, { acceptance: 'original109', owner }), /empty|isolated|pre-existing/i);
  assert.equal(vscode.window.tabGroups.all[0].tabs[0], original);
});

test('acceptance session rejects a normal-profile installed path before activation or document operations', async context => {
  const owner = acceptanceHarness.createAcceptanceRoot();
  context.after(() => fs.rmSync(owner.root, { recursive: true, force: true }));
  const extension = { extensionPath: 'C:\\normal-profile\\installed', activate() { assert.fail('Never activate the normal-profile product'); } };
  const vscode = { workspace: {}, window: { tabGroups: { all: [{ tabs: [] }] } }, extensions: { getExtension: () => extension } };
  await assert.rejects(() => acceptanceHarness.createAcceptanceSession(vscode, { acceptance: 'original109', owner, expectedExtensionPath: path.join(owner.root, 'isolated-product') }), /installed|profile|path/i);
});

test('acceptance finalizer cannot silently fall back to an older generic pass when its artifact is missing', () => {
  const evidence = acceptanceEvidence();
  delete evidence.acceptance;
  delete evidence.acceptanceRequired;
  const result = finalizeAttemptEvidence({ cli: evidence.cli, acceptance: 'original109' }, () => evidence);
  assert.equal(result.evidence.acceptanceRequired, true);
  assert.equal(result.acceptanceQualified, false);
  assert.notEqual(result.primary, 'PASS_UNREVIEWED_VISUAL');
});

test('acceptance finalizer retains a failed collector and explicitly refuses qualification', () => {
  const cli = { exitCode: 0 };
  const result = finalizeAttemptEvidence({ cli, acceptance: 'original109' }, () => { throw new Error('Missing native capture metadata'); });
  assert.equal(result.acceptanceQualified, false);
  assert.equal(result.visualReview, 'human-unreviewed');
  assert.equal(result.evidence.cli, cli);
  assert.equal(result.primary, 'HARNESS_SUSPECT');
});

test('acceptance asset staging extracts only the opted-in fragment and reuses the existing standalone runner and journal', async context => {
  const owner = acceptanceHarness.createAcceptanceRoot();
  context.after(() => fs.rmSync(owner.root, { recursive: true, force: true }));
  const assetsDir = path.join(owner.root, 'assets');
  fs.mkdirSync(assetsDir);
  const options = parseArgs(['--vsix', 'unused.vsix', '--expected-sha', 'a'.repeat(64), '--acceptance', 'original109', '--before-archive', 'before.zip', '--order-archive', 'order.zip']);
  const assets = acceptanceHarness.stageAssets({ ...options, owner }, assetsDir);
  const staged = fs.readFileSync(assets.feature, 'utf8');
  assert.equal(staged.includes('Feature: Immutable original109 installed-build acceptance'), true);
  assert.equal(staged.includes('seedCopilotClarificationConnection'), false);
  assert.equal(staged.includes('Given the extension is in a clean state'), false);
  assert.equal(fs.readdirSync(assets.featureDir).filter(value => value.endsWith('.feature')).length, 1);
  assert.equal(createHash('sha256').update(fs.readFileSync(assets.acceptanceHarness)).digest('hex'), assets.acceptanceHarnessSha256);
  assert.equal(typeof (await import(pathToFileURL(assets.acceptanceHarness).href)).createAcceptanceSession, 'function');
  assert.equal(fs.readFileSync(assets.helper, 'utf8'), fs.readFileSync(new URL('../vscode-extension-tester/e2e/default/published-notebook-corruption/lifecycle-journal.cjs', import.meta.url), 'utf8'));
});

test('current133 API asset selection is separate, readonly and does not silently stage the full native or synthetic campaign', context => {
  const owner = acceptanceHarness.createAcceptanceRoot();
  context.after(() => fs.rmSync(owner.root, { recursive: true, force: true }));
  const assetsDir = path.join(owner.root, 'assets');
  fs.mkdirSync(assetsDir);
  const options = parseArgs(['--vsix', 'unused.vsix', '--expected-sha', 'a'.repeat(64), '--acceptance', 'current133-api', '--before-archive', 'before.zip', '--order-archive', 'order.zip']);
  const assets = acceptanceHarness.stageAssets({ ...options, owner }, assetsDir);
  const feature = fs.readFileSync(assets.feature, 'utf8');
  assert.ok(feature.includes('Feature: Current133 readonly API preservation'));
  for (const forbidden of ['__ORIGINAL109_CONTROL_PROBE__', 'openCold()', 'clickColdToggle', 'I take a screenshot', 'I press', 'I type', 'I focus', 'I move', 'I resize', 'files.save', 'seedCopilot', 'clean state']) assert.equal(feature.includes(forbidden), false, forbidden);
  for (const expression of [...feature.matchAll(/from extension host expression "(.*)"/g)].map(match => match[1])) assert.doesNotThrow(() => new Script(expression));
  for (const block of [...feature.matchAll(/"""\r?\n([\s\S]*?)\r?\n\s*"""/g)].map(match => match[1])) assert.doesNotThrow(() => new Script(block));
  assert.ok(feature.indexOf('openApi()') < feature.indexOf('activateRange(0, 20)'));
  assert.ok(feature.indexOf('activateRange(88, 109)') < feature.indexOf('hideApi()'));
  assert.ok(feature.indexOf('hideApi()') < feature.indexOf('reactivateApi()'));
  assert.ok(feature.indexOf('reactivateApi()') < feature.indexOf('finish()'));
  assert.equal(fs.readdirSync(assets.featureDir).filter(value => value.endsWith('.feature')).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(assets.featureDir, 'e2e.settings.json'), 'utf8')), { timeout: 180000 });
});

test('owned JSON atomic replacement retries transient Windows rename failures without rewriting or unlinking', () => {
  const source = fs.readFileSync(new URL('../../scripts/repro-published-notebook.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const writeJsonAtomic ='), end = source.indexOf('\nexport function parseArgs', start);
  assert.ok(start >= 0 && end > start);
  for (const failures of [[], ['EPERM'], ['EBUSY', 'EPERM'], ['EPERM', 'EBUSY', 'EPERM']]) {
    const files = new Map([['journal.json', 'original']]), writes = [], renames = [], waits = [];
    let serializations = 0;
    const writer = new Script('(() => { ' + source.slice(start, end) + '; return writeJsonAtomic; })()').runInNewContext({ process: { platform: 'win32' },
      fs: { writeFileSync(file, text) { writes.push([file, text]); files.set(file, text); }, renameSync(from, to) {
        renames.push([from, to]); const code = failures[renames.length - 1];
        if (code) throw Object.assign(new Error(code), { code });
        files.set(to, files.get(from)); files.delete(from);
      } }, Atomics: { wait(_array, index, value, delay) { assert.equal(index, 0); assert.equal(value, 0); waits.push(delay); } } });
    writer('journal.json', { toJSON() { serializations++; return { generation: 2 }; } });
    assert.equal(serializations, 1); assert.equal(writes.length, 1); assert.equal(renames.length, failures.length + 1);
    assert.deepEqual(waits, [10, 20, 30].slice(0, failures.length));
    assert.ok(renames.every(([from, to]) => from === 'journal.json.tmp' && to === 'journal.json'));
    assert.equal(files.get('journal.json'), writes[0][1]); assert.equal(files.has('journal.json.tmp'), false);
  }
});

test('owned JSON atomic replacement preserves terminating errors and old bytes without retrying writes or other platforms', () => {
  const source = fs.readFileSync(new URL('../../scripts/repro-published-notebook.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const writeJsonAtomic ='), end = source.indexOf('\nexport function parseArgs', start);
  assert.ok(start >= 0 && end > start);
  const cases = [
    ['win32', ['EPERM', 'EBUSY', 'EPERM', 'EBUSY'], 3], ['win32', ['EPERM', 'EACCES'], 1],
    ...['EACCES', 'EIO', 'ENOENT', 'ENOSPC', undefined].map(code => ['win32', [code], 0]),
    ...['linux', 'darwin'].flatMap(platform => ['EPERM', 'EBUSY'].map(code => [platform, [code], 0])),
  ];
  for (const [platform, codes, retries] of cases) for (const existing of [false, true]) {
    const failures = codes.map((code, index) => Object.assign(new Error('failure-' + index), { code }));
    const files = new Map(existing ? [['journal.json', 'original']] : []), waits = [];
    let writes = 0, renames = 0;
    const writer = new Script('(() => { ' + source.slice(start, end) + '; return writeJsonAtomic; })()').runInNewContext({ process: { platform },
      fs: { writeFileSync(file, text) { writes++; files.set(file, text); }, renameSync() { throw failures[renames++]; } },
      Atomics: { wait(_array, _index, _value, delay) { waits.push(delay); } } });
    assert.throws(() => writer('journal.json', { revision: 2 }), error => error === failures.at(-1));
    assert.equal(writes, 1); assert.equal(renames, retries + 1); assert.deepEqual(waits, [10, 20, 30].slice(0, retries));
    assert.equal(files.get('journal.json'), existing ? 'original' : undefined); assert.ok(files.get('journal.json.tmp').includes('2'));
  }
  for (const boundary of ['serialize', 'write']) {
    const failure = Object.assign(new Error(boundary), { code: 'EPERM' }); let writes = 0;
    const writer = new Script('(() => { ' + source.slice(start, end) + '; return writeJsonAtomic; })()').runInNewContext({ process: { platform: 'win32' },
      fs: { writeFileSync() { writes++; throw failure; }, renameSync() { assert.fail('Rename must not be attempted'); } },
      Atomics: { wait() { assert.fail('Write failures must not be retried'); } } });
    assert.throws(() => writer('journal.json', boundary === 'serialize' ? { toJSON() { throw failure; } } : {}), error => error === failure);
    assert.equal(writes, boundary === 'write' ? 1 : 0);
  }
});

test('current133 API finalization keeps missing or wrong-mode artifacts blocked, never generic release passes', () => {
  const evidence = acceptanceEvidence();
  const result = finalizeAttemptEvidence({ cli: evidence.cli, acceptance: 'current133-api' }, () => evidence);
  assert.equal(result.acceptanceQualified, false);
  assert.equal(result.apiPreservationQualified, false);
  assert.notEqual(result.primary, 'PASS_UNREVIEWED_VISUAL');
  delete evidence.acceptance;
  const missing = finalizeAttemptEvidence({ cli: evidence.cli, acceptance: 'current133-api' }, () => evidence);
  assert.equal(missing.apiPreservationQualified, false);
  assert.notEqual(missing.primary, 'PASS_UNREVIEWED_VISUAL');
});

async function coldSessionFixture(context, { afterOpen, invokeTool, metadataInventory, diagnoseJournalRename = false, expectCleanupFailure = false, acceptance = 'original109', beforeImages } = {}) {
  const owner = acceptanceHarness.createAcceptanceRoot();
  const before = beforeImages ?? syntheticBeforeImages();
  before.order[19] = 'extension-fix-validation-empty-legacy-2026-09-12.kqlx';
  const plan = { ...acceptanceHarness.validateBeforeImages(before.baseline, before.images, before.order, acceptance), archivedCanary: before.archivedCanary };
  const staged = acceptanceHarness.stageBeforeImages(owner, plan, before.images);
  const evidenceRoot = path.join(owner.root, 'evidence');
  const installedPath = path.join(owner.root, 'product');
  fs.mkdirSync(evidenceRoot);
  fs.mkdirSync(path.join(installedPath, 'dist'), { recursive: true });
  const mainPath = path.join(installedPath, 'dist/extension.js');
  fs.writeFileSync(mainPath, 'throw new Error("Unit-only cache fixture; never load");');
  const toUri = file => ({ fsPath: file, toString: () => pathToFileURL(file).href });
  const listeners = new Map();
  const subscribe = name => callback => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
    return { dispose: () => listeners.get(name).delete(callback) };
  };
  const emit = (name, value) => { for (const callback of listeners.get(name) ?? []) callback(value); };
  class TabInputCustom { constructor(uri, viewType) { this.uri = uri; this.viewType = viewType; } }
  class TabInputText { constructor(uri) { this.uri = uri; } }
  class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
  const tabs = [];
  const documents = [];
  const activeTabGroup = { tabs, activeTab: null, isActive: true };
  const contextValue = { extensionPath: installedPath, extensionMode: 1 };
  const extension = { extensionPath: installedPath, packageJSON: { main: './dist/extension.js', version: 'unit-only' }, activate: async () => {} };
  let opens = 0;
  let activations = 0;
  let closes = 0;
  const liveConnections = new Map();
  const openFiles = () => tabs.filter(tab => /\.(kqlx|sqlx|mdx|kql|csl|sql|md)$/i.test(tab.input?.uri?.fsPath ?? '')).map(tab => ({
    uri: tab.input.uri.toString(), filePath: tab.input.uri.fsPath, openFileId: acceptance === 'current133-api' ? tab.unitOpenFileId : 'exact-cold-id',
    isLiveWorkbench: true, isReadOnlyFallback: false, sections: [] }));
  const previousCache = require.cache[mainPath];
  require.cache[mainPath] = { filename: mainPath, loaded: true, exports: { toolOrchestrator: { context: contextValue, liveConnections,
    collectOpenWorkbenchFiles: () => ({ openFiles: metadataInventory ? metadataInventory({ tabs, activeTabGroup }) : tabs.filter(tab => tab.input instanceof TabInputCustom)
      .map(tab => ({ uri: tab.input.uri.toString(), openFileId: acceptance === 'current133-api' ? tab.unitOpenFileId : 'exact-cold-id' })) }) } } };
  const vscode = {
    version: '1.141.0', ExtensionMode: { Production: 1, Development: 2 }, TextDocumentSaveReason: { Manual: 1 }, Uri: { file: toUri }, TabInputCustom, TabInputText, TabInputWebview,
    extensions: { getExtension: id => id === 'workbench-test.published-corruption-driver' ? { activate: async () => ({ extensionMode: 2 }) } : extension },
    workspace: { textDocuments: documents, getConfiguration: () => ({ get: name => name === 'autoSave' ? 'afterDelay' : 1000 }),
      onDidOpenTextDocument: subscribe('open'), onDidChangeTextDocument: subscribe('change'), onWillSaveTextDocument: subscribe('will-save'), onDidSaveTextDocument: subscribe('did-save'), onDidCloseTextDocument: subscribe('close') },
    window: { tabGroups: { all: [activeTabGroup], activeTabGroup, onDidChangeTabs: subscribe('tabs'), onDidChangeTabGroups: subscribe('groups'),
      close: async target => {
        closes++;
        for (const tab of target) {
          tabs.splice(tabs.indexOf(tab), 1);
          const document = documents.find(value => value.uri.toString() === tab.input.uri.toString());
          if (document) { documents.splice(documents.indexOf(document), 1); document.isClosed = true; emit('close', document); }
          for (const [token, connection] of liveConnections) if (connection.documentUri === tab.input.uri.toString()) liveConnections.delete(token);
        }
        if (target.includes(activeTabGroup.activeTab)) activeTabGroup.activeTab = tabs.at(-1) ?? null;
        emit('tabs', { opened: [], changed: [], closed: target });
        return true;
      } } },
    commands: { getCommands: async () => [], executeCommand: async (name, uri, viewType, options) => {
      assert.equal(name, 'vscode.openWith'); opens++;
      assert.deepEqual(options, { preview: false });
      const existing = tabs.find(tab => tab.input?.uri?.toString() === uri.toString());
      if (activeTabGroup.activeTab) activeTabGroup.activeTab.isActive = false;
      if (existing) { existing.isActive = true; activeTabGroup.activeTab = existing; return; }
      const tab = { input: viewType === 'default' ? new TabInputText(uri) : new TabInputCustom(uri, viewType), isDirty: false, isActive: true, label: path.basename(uri.fsPath), unitOpenFileId: 'unit-api-id-' + opens };
      tabs.push(tab); activeTabGroup.activeTab = tab;
      if (viewType !== 'default') liveConnections.set(opens, { token: opens, sequence: opens, documentUri: uri.toString(), stateGetter: async () => [] });
      const text = fs.readFileSync(uri.fsPath, 'utf8');
      const document = { uri, version: 1, isDirty: false, getText: () => text }; documents.push(document); emit('open', document);
      await afterOpen?.({ tab, tabs, activeTabGroup, emit, vscode });
    } },
    lm: { invokeTool: async (name, options) => {
      if (acceptance === 'current133-api') {
        if (name === 'kusto-workbench_activate-workbench-file') activations++;
        const overridden = await invokeTool?.({ name, options, tabs, activeTabGroup, emit, vscode });
        if (overridden !== undefined) return overridden;
        let value;
        if (name === 'kusto-workbench_list-connections') value = { connections: [] };
        else if (name === 'kusto-workbench_list-sections') {
          const filePath = activeTabGroup.activeTab?.input?.uri?.fsPath;
          value = { sections: filePath === path.join(staged.historyRoot, plan.archivedCanary.path) ? plan.archivedCanary.sectionIds.map(id => ({ id })) : [], openFiles: openFiles(), filePath };
        } else if (name === 'kusto-workbench_manage-development-notes') value = { success: true, notes: [plan.archivedCanary.note] };
        else if (name === 'kusto-workbench_validate-html-dashboard') value = { success: true, valid: true, hasProvenance: true, sectionId: plan.archivedCanary.htmlSectionId,
          filePath: path.join(staged.historyRoot, plan.archivedCanary.path), bindingCount: 6, dataSourceCount: 1, factColumns: plan.archivedCanary.factColumns, issues: [], diagnostics: [] };
        else if (name === 'kusto-workbench_activate-workbench-file') {
          let tab = tabs.find(tab => tab.input?.uri?.toString() === options.input.targetFileUri);
          if (!tab && options.input.openFileId === undefined) {
            const uri = toUri(fileURLToPath(options.input.targetFileUri));
            const viewType = /\.md$/i.test(uri.fsPath) ? 'default' : /\.(kql|csl)$/i.test(uri.fsPath) ? 'kusto.kqlCompatEditor'
              : /\.sql$/i.test(uri.fsPath) ? 'kusto.sqlCompatEditor' : 'kusto.kqlxEditor';
            await vscode.commands.executeCommand('vscode.openWith', uri, viewType, { preview: false });
            tab = tabs.find(candidate => candidate.input?.uri?.toString() === options.input.targetFileUri);
          }
          assert.ok(tab && (options.input.openFileId === undefined || tab.unitOpenFileId === options.input.openFileId), 'Activate only the same exact URI/ID');
          if (activeTabGroup.activeTab) activeTabGroup.activeTab.isActive = false;
          activeTabGroup.activeTab = tab; tab.isActive = true;
          const readOnlyFallback = tab.input instanceof TabInputText;
          value = { success: true, isLiveWorkbench: !readOnlyFallback, isReadOnlyFallback: readOnlyFallback, uri: options.input.targetFileUri, openFileId: tab.unitOpenFileId };
        } else assert.fail('Forbidden API-case tool: ' + name);
        return { content: [{ value: JSON.stringify(value) }] };
      }
      assert.equal(name, 'kusto-workbench_activate-workbench-file');
      assert.equal(options.input.openFileId, 'exact-cold-id'); activations++;
      if (invokeTool) return invokeTool({ tab: tabs.find(tab => tab.input instanceof TabInputCustom), tabs, activeTabGroup, emit, vscode, options });
      return { content: [{ value: '{"success":false,"error":"Exact cold activation unready"}' }] };
    } },
  };
  const config = { acceptance, owner, historyRoot: staged.historyRoot, coldCanary: staged.coldCanary, evidenceRoot, expectedExtensionPath: installedPath,
    expectedBuildIdentity: { installedPath, mainPath, vsixSha256: 'a'.repeat(64) }, sourceRoot: process.cwd(),
    helperPath: new URL('../vscode-extension-tester/e2e/default/published-notebook-corruption/lifecycle-journal.cjs', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'),
    acceptancePlan: { ...plan, legacyPath: 'extension-fix-validation-empty-legacy-2026-09-12.kqlx', legacySectionId: staged.coldCanary.sectionId, archive: before.archive ?? acceptanceEvidence().acceptance.archive } };
  const journalModule = require(config.helperPath);
  const originalCreateJournal = journalModule.createJournal;
  let journal;
  let session;
  let retainJournalFailure = false;
  const originalRename = Object.getOwnPropertyDescriptor(fs, 'renameSync');
  const journalPath = path.join(evidenceRoot, 'acceptance-state.json');
  const diagnosticRename = function (...args) {
    try { return Reflect.apply(originalRename.value, this, args); }
    catch (error) {
      if (!retainJournalFailure && error?.code === 'EPERM' && args[0] === journalPath + '.tmp' && args[1] === journalPath) {
        retainJournalFailure = true;
        try {
          const inspect = (file, method) => {
            try {
              const stat = fs[method](file, { bigint: true });
              return { exists: true, file: stat.isFile(), directory: stat.isDirectory(), symbolicLink: stat.isSymbolicLink(), mode: stat.mode.toString(8), writableBits: (stat.mode & 0o222n).toString(8), size: stat.size.toString(), modifiedNs: stat.mtimeNs.toString() };
            } catch (inspectionError) { return { exists: inspectionError?.code === 'ENOENT' ? false : null, error: String(inspectionError?.code ?? 'unknown') }; }
          };
          context.diagnostic(JSON.stringify({ kind: 'first-owned-journal-rename-failure', ownerRoot: owner.root, at: new Date().toISOString(), code: error.code, errno: error.errno, syscall: error.syscall,
            source: args[0], destination: args[1], lastOperationPhase: session?.state.operations.at(-1)?.phase ?? null, activationOrdinal: session?.state.activationAttempts.length ?? null,
            paths: [args[0], args[1], path.dirname(args[1])].map(file => ({ path: file, stat: inspect(file, 'statSync'), lstat: inspect(file, 'lstatSync') })), stack: String(error.stack ?? '').slice(0, 2400) }));
        } catch {}
      }
      throw error;
    }
  };
  if (diagnoseJournalRename) Object.defineProperty(fs, 'renameSync', { ...originalRename, value: diagnosticRename });
  context.after(async () => {
    try { if (session && session.state.cleanup.survivors !== 0) await session.finish(); }
    catch (error) { if (!expectCleanupFailure) throw error; assert.ok(session.state.failures.length); await journal.close(); }
    finally {
      try { await journal?.close(); }
      finally {
        if (diagnoseJournalRename && Object.getOwnPropertyDescriptor(fs, 'renameSync')?.value === diagnosticRename) Object.defineProperty(fs, 'renameSync', originalRename);
        if (previousCache) require.cache[mainPath] = previousCache; else delete require.cache[mainPath];
        if (!retainJournalFailure) fs.rmSync(owner.root, { recursive: true, force: true });
      }
    }
  });
  try {
    journalModule.createJournal = async options => { journal = await originalCreateJournal(options); return journal; };
    session = await acceptanceHarness.createAcceptanceSession(vscode, config);
  } finally { journalModule.createJournal = originalCreateJournal; }
  return { session, vscode, evidenceRoot, config, owner, staged, before, emit, closeCount: () => closes, counts: () => ({ opens, activations }),
    listenerCounts: () => ({ tabs: listeners.get('tabs')?.size ?? 0, groups: listeners.get('groups')?.size ?? 0 }) };
}

async function privateCurrentSessionFixture(context, options = {}) {
  const beforeArchive = path.join(os.tmpdir(), 'kw-wave3-before-2026-10-09-032b29ab0ad64643abd66746fb58bb7f.zip');
  const orderArchive = path.join(os.tmpdir(), 'kw-regression-before-2026-10-07-5f779bb4a66542f6ae767e9e817f7a22.zip');
  if (!fs.existsSync(beforeArchive) || !fs.existsSync(orderArchive)) { context.skip('Private immutable archive inputs unavailable; no synthetic equivalence'); return null; }
  const archived = await acceptanceHarness.inspectAcceptanceArchives(beforeArchive, orderArchive, 'current133-api');
  return coldSessionFixture(context, { ...options, acceptance: 'current133-api', beforeImages: {
    order: archived.activationOrder, images: archived.images, baseline: { files: archived.files }, archive: archived.archive, archivedCanary: archived.archivedCanary } });
}

test('current133 initial exact-ID activation admits the clean inactive canary behind Welcome and waits for SDK focus', async context => {
  const fixture = await privateCurrentSessionFixture(context, {
    afterOpen: ({ tab, tabs, activeTabGroup, vscode }) => {
      tab.isActive = false;
      const welcome = { input: new vscode.TabInputWebview('mainThreadWebview-kustoFirstLaunchSetup'), isDirty: false, isActive: true };
      tabs.push(welcome); activeTabGroup.activeTab = welcome;
    },
    invokeTool: ({ name, options, tabs, activeTabGroup, emit, vscode }) => {
      if (name !== 'kusto-workbench_activate-workbench-file') return;
      assert.equal(activeTabGroup.activeTab.input.viewType, 'mainThreadWebview-kustoFirstLaunchSetup');
      const matches = tabs.filter(tab => tab.input?.uri?.toString() === options.input.targetFileUri);
      assert.equal(matches.length, 1);
      const tab = matches[0];
      assert.ok(tab.input instanceof vscode.TabInputCustom);
      assert.equal(tab.input.viewType, 'kusto.kqlxEditor');
      assert.equal(tab.isDirty, false);
      assert.equal(tab.isActive, false);
      assert.equal(options.input.openFileId, tab.unitOpenFileId);
      setImmediate(() => {
        activeTabGroup.activeTab.isActive = false; activeTabGroup.activeTab = tab; tab.isActive = true;
        emit('groups', { opened: [], changed: [activeTabGroup], closed: [] });
      });
      return { content: [{ value: JSON.stringify({ success: true, isLiveWorkbench: true, uri: options.input.targetFileUri, openFileId: options.input.openFileId }) }] };
    },
  });
  if (!fixture) return;
  const { session } = fixture;
  const result = await session.openApi();
  assert.deepEqual(fixture.counts(), { opens: 1, activations: 1 });
  assert.equal(session.state.api.initialActivationCalls, 1);
  assert.equal(session.state.api.activationCalls, 0, 'Initial admission does not consume the sole post-stress activation');
  assert.equal(result.uri, fixture.vscode.window.tabGroups.activeTabGroup.activeTab.input.uri.toString());
  assert.equal(result.openFileId, fixture.vscode.window.tabGroups.activeTabGroup.activeTab.unitOpenFileId);
  assert.equal(result.oracles.oraclesExact, true);
  assert.deepEqual(session.state.notes[0].notes, [fixture.config.acceptancePlan.archivedCanary.note]);
  assert.equal(session.state.dashboards[0].bindingCount, 6);
  assert.equal(session.state.fixtureOwnership.status, 'legitimate-production-owner');
  assert.deepEqual(session.state.activationOrder, []);
  assert.deepEqual(session.state.failures, []);
  assert.deepEqual(fixture.listenerCounts(), { tabs: 1, groups: 1 }, 'Dispose both temporary readiness subscriptions');
});

test('current133 independent collection keeps API pixels unattempted and cannot heal stale loaded METHOD observations', async context => {
  const fixture = await privateCurrentSessionFixture(context);
  if (!fixture) return;
  await fixture.session.openApi();
  await fixture.session.finish();
  assert.equal(fixture.vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input?.uri?.toString() === fixture.session.state.api.uri), false,
    'Exact cleanup must remove the archived canary tab, not merely report zero survivors from an incomplete URI set');
  const { config, owner } = fixture;
  const observations = structuredClone(fixture.session.state.identity);
  config.beforeArchiveCopy = path.join(owner.root, 'private-before.zip');
  config.orderArchiveCopy = path.join(owner.root, 'private-order.zip');
  fs.copyFileSync(path.join(os.tmpdir(), 'kw-wave3-before-2026-10-09-032b29ab0ad64643abd66746fb58bb7f.zip'), config.beforeArchiveCopy, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(path.join(os.tmpdir(), 'kw-regression-before-2026-10-07-5f779bb4a66542f6ae767e9e817f7a22.zip'), config.orderArchiveCopy, fs.constants.COPYFILE_EXCL);
  const vsixPath = path.join(owner.root, 'unit-only-not-installable.vsix');
  fs.writeFileSync(vsixPath, 'Inert unit bytes, never install');
  config.expectedBuildIdentity.vsixPath = vsixPath;
  config.packageIdentity = { vsixMainEntry: 'extension/dist/extension.js' };
  const statePath = path.join(fixture.evidenceRoot, 'acceptance-state.json');
  const retained = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  retained.collection = { runtimeVerified: { before: true, after: true, panelOwners: true } };
  fs.writeFileSync(statePath, JSON.stringify(retained));
  const collected = acceptanceHarness.collectAcceptanceState({ acceptanceConfig: config, evidenceRoot: fixture.evidenceRoot });
  assert.equal(collected.pixels.status, 'UNATTEMPTED');
  assert.deepEqual(collected.identity.before, observations.before);
  assert.deepEqual(collected.identity.after, observations.after);
  assert.deepEqual(collected.collection.expectedOrder, fixture.before.order);
  assert.deepEqual(collected.collection.archivedCanary, config.acceptancePlan.archivedCanary);
  assert.equal(collected.collection.runtimeVerified.before, false, 'The mocked loaded methods are not the packaged production runtime');
  assert.equal(collected.collection.runtimeVerified.after, false);
  assert.equal(collected.collection.runtimeVerified.panelOwners, false, 'Parent collection cannot inherit unobserved provider/gateway/webview proof');
  assert.match(collected.collection.runtimeLimitation, /identities are not observed/);
  assert.equal(collected.collection.archiveVerified, true);
  assert.ok(collected.identity.parentFinal.dependenciesSha256);
  assert.deepEqual(Object.keys(collected.identity.parentFinal.assetTrees), ['monaco', 'css', 'scripts']);
});

test('current133 historical first opens use exactly one public activation call without direct-open warming', async context => {
  const fixture = await privateCurrentSessionFixture(context);
  if (!fixture) return;
  await fixture.session.openApi();
  await fixture.session.activateRange(0, 1);
  const activations = fixture.session.state.operations.filter(operation => operation.phase === 'historical-1'
    && operation.name === 'kusto-workbench_activate-workbench-file');
  assert.equal(activations.length, 1, 'Direct vscode.openWith and later inventory cannot replace the first public activation response');
  assert.equal(activations[0].input.targetFileUri, fixture.vscode.Uri.file(path.join(fixture.staged.historyRoot, fixture.before.order[0])).toString());
  assert.equal(activations[0].success, true);
});

for (const rejected of [false, true]) test('current133 Node mocked lifecycle composes all109, exact hidden oracles, one activation and readonly close' + (rejected ? ' while retaining public failures' : ''), async context => {
  let session;
  let historyFailureRecorded = false;
  const fixture = await privateCurrentSessionFixture(context, { diagnoseJournalRename: true, invokeTool: rejected ? ({ name, options, activeTabGroup, tabs }) => {
    const failure = error => ({ content: [{ value: JSON.stringify({ success: false, error }) }] });
    if (name === 'kusto-workbench_manage-development-notes' && session?.state.api.phases.at(-1) === 'full109') return failure('Hidden development-note snapshot unavailable');
    if (name === 'kusto-workbench_validate-html-dashboard' && session?.state.api.phases.at(-1) === 'full109') return failure('DashboardRequestTimedOut');
    if (name === 'kusto-workbench_activate-workbench-file' && session?.state.api.phases.at(-1) === 'hidden') return failure('Exact activation unready');
    if (name === 'kusto-workbench_list-sections' && session?.state.activationAttempts.length === 79 && !historyFailureRecorded) {
      historyFailureRecorded = true;
      return { content: [{ value: JSON.stringify({ sections: [], filePath: activeTabGroup.activeTab.input.uri.fsPath,
        openFiles: tabs.filter(tab => tab.input instanceof fixture.vscode.TabInputCustom).map(tab => ({ uri: tab.input.uri.toString(), openFileId: tab.unitOpenFileId,
          sections: [], ...(tab === activeTabGroup.activeTab ? { sectionsUnavailable: true, error: 'Historical snapshot budget exhausted' } : {}) })) }) }] };
    }
  } : undefined });
  if (!fixture) return;
  session = fixture.session;
  await session.openApi();
  for (const [start, end] of [[0, 20], [20, 41], [41, 62], [62, 83], [83, 88], [88, 109]]) await session.activateRange(start, end);
  assert.equal(session.state.historicalInventories.find(entry => entry.phase === 'full109').retainedCount, 109);
  assert.equal(fixture.vscode.window.tabGroups.all[0].tabs.length, 110);
  await session.hideApi();
  await session.reactivateApi();
  const result = await session.finish();
  assert.deepEqual(session.state.activationOrder, fixture.before.order);
  assert.deepEqual(session.state.api.phases, ['initial', 'full109', 'hidden', 'reactivated', 'closed']);
  assert.equal(session.state.api.status, rejected ? 'partial' : 'complete');
  assert.equal(session.state.api.initialActivationCalls, 1);
  assert.equal(session.state.api.initialActivation.success, true);
  assert.equal(session.state.api.activationCalls, 1);
  assert.equal(session.state.api.history.length, 109);
  assert.equal(session.state.archive.sourceCount, 133);
  assert.equal(session.state.untouched.checkedSourceCount, 133);
  assert.equal(session.state.roles.cold, 1);
  assert.equal(session.state.roles.authoring, 1);
  assert.equal(session.state.roles.authoringUnopened, true);
  assert.equal(session.state.pixels.status, 'UNATTEMPTED');
  assert.equal(result.acceptanceQualified, false);
  assert.equal(result.cleanup.survivors, 0);
  assert.deepEqual(fixture.vscode.window.tabGroups.all.flatMap(group => group.tabs), [], 'All actual task-owned tabs, including the archived canary, must be absent');
  assert.equal(fixture.counts().activations, 111);
  for (const phase of ['initial', 'hidden', 'reactivated']) {
    const notes = session.state.notes.find(entry => entry.phase === phase);
    const dashboard = session.state.dashboards.find(entry => entry.phase === phase);
    assert.equal(notes.openFileId, session.state.api.openFileId);
    assert.equal(dashboard.openFileId, session.state.api.openFileId);
    assert.equal(notes.uri, session.state.api.uri);
    assert.equal(dashboard.uri, session.state.api.uri);
    if (!rejected || phase !== 'hidden') assert.deepEqual(notes.notes, [fixture.config.acceptancePlan.archivedCanary.note]);
  }
  if (rejected) {
    assert.equal(historyFailureRecorded, true);
    assert.equal(session.state.api.history[78].snapshot, false);
    assert.ok(session.state.dashboards.some(entry => entry.error?.includes('DashboardRequestTimedOut')));
    assert.equal(session.state.operations.filter(entry => entry.name === 'kusto-workbench_activate-workbench-file' && !entry.success).length, 1);
  }
  assert.equal(session.state.operations.filter(entry => entry.name === 'kusto-workbench_manage-development-notes').length, 3);
  assert.equal(session.state.operations.filter(entry => entry.name === 'kusto-workbench_validate-html-dashboard').length, 3);
  assert.equal(session.state.operations.filter(entry => entry.name === 'kusto-workbench_list-sections').length, 110);
  assert.ok(session.state.operations.every(entry => /_(list-connections|list-sections|manage-development-notes|validate-html-dashboard|activate-workbench-file)$/.test(entry.name)));
  for (const file of fixture.config.acceptancePlan.files) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(fixture.staged.historyRoot, file.path))).digest('hex'), file.sha256);
});

test('acceptance session composes first exact-ID cold copy, original109 including target20, clean close/reopen and independent131+1 observers', async context => {
  let lookups = 0;
  const fixture = await coldSessionFixture(context, {
    metadataInventory: ({ tabs }) => { lookups++; return tabs.map(tab => ({ uri: tab.input.uri.toString(), openFileId: 'exact-cold-id' })); },
    invokeTool: ({ options }) => ({ content: [{ value: JSON.stringify({ success: true, isLiveWorkbench: true, uri: options.input.targetFileUri }) }] }),
  });
  assert.deepEqual(fixture.counts(), { opens: 0, activations: 0 });
  assert.equal(fixture.session.state.coldCanary.markerVerified, true);
  const cold = await fixture.session.openCold();
  const state = fixture.session.state;
  assert.equal(cold.coldUri, fixture.staged.coldCanary.uri);
  assert.equal(lookups, 1);
  assert.deepEqual(state.cold.firstMetadataId, { uri: cold.coldUri, openFileId: 'exact-cold-id', matchingCount: 1, lookupCount: 1, source: 'metadata-only' });
  assert.equal(fixture.vscode.window.tabGroups.activeTabGroup.activeTab.label, path.basename(fixture.staged.coldCanary.filePath));
  await fixture.session.activateRange(0, 41);
  await fixture.session.activateRange(41, 83);
  await fixture.session.activateRange(83, 88);
  await fixture.session.activateRange(88, 109);
  await fixture.session.checkpoint('full109');
  assert.deepEqual(state.activationOrder, fixture.before.order);
  assert.equal(state.activationOrder[19], state.coldCanary.sourcePath);
  assert.notEqual(state.cold.uri, state.coldCanary.sourceUri);
  assert.equal(fixture.vscode.window.tabGroups.all[0].tabs.length, 110);
  assert.equal((await fixture.session.closeCold()).closed, 1);
  assert.equal(state.historicalInventories.find(value => value.phase === 'closed').retainedCount, 109);
  assert.equal(fixture.vscode.window.tabGroups.all[0].tabs.length, 109);
  await fixture.session.reopenCold();
  assert.equal(state.historicalInventories.find(value => value.phase === 'reopened').retainedCount, 109);
  assert.equal(fixture.vscode.window.tabGroups.all[0].tabs.length, 110);
  assert.equal(state.archive.sourceCount, 131);
  assert.equal(state.archive.baselineCount, 131);
  assert.equal(state.untouched.checkedSourceCount, 131);
  assert.equal(state.coldCanary.count, 1);
  assert.equal(state.coldCanary.checkedSourceCount, 1);
  assert.equal(state.coldCanary.versionsStable, true);
  assert.ok(state.coldCanary.revisions.some(value => value.phase.startsWith('close:')));
  assert.ok(state.coldCanary.revisions.some(value => value.phase === 'reopened' && value.openGeneration === 111), 'Reopen follows 110 distinct initial models: the cold copy plus all109 archives');
  await fixture.session.openAuthoring();
  assert.notEqual(fixture.vscode.window.tabGroups.activeTabGroup.activeTab.input.uri.toString(), state.cold.uri);
  assert.deepEqual(fs.readFileSync(fixture.vscode.window.tabGroups.activeTabGroup.activeTab.input.uri.fsPath), fixture.before.images.get(state.coldCanary.sourcePath));
  for (const file of fixture.config.acceptancePlan.files) assert.deepEqual(fs.readFileSync(path.join(fixture.staged.historyRoot, file.path)), fixture.before.images.get(file.path));
  assert.equal(state.fixtureOwnership.status, 'blocked');
  assert.deepEqual(state.notes, []);
  assert.equal(state.dashboard, null);
});

for (const boundary of ['before-activation', 'before-close', 'after-reopen']) {
  for (const kind of ['buffer', 'disk', 'dirty-document', 'dirty-tab', 'version-only', 'buffer-reverted']) {
    test('acceptance session rejects cold canary ' + kind + ' ' + boundary + ' before any further intent', async context => {
      let opened = 0;
      const mutate = ({ tab, emit, vscode }) => {
        const document = vscode.workspace.textDocuments.find(value => value.uri.toString() === tab.input.uri.toString());
        if (kind === 'disk') { fs.appendFileSync(tab.input.uri.fsPath, ' '); return; }
        if (kind === 'dirty-tab') { tab.isDirty = true; emit('tabs', { opened: [], changed: [tab], closed: [] }); return; }
        if (kind === 'dirty-document') document.isDirty = true;
        else {
          document.version++;
          if (kind !== 'version-only') { const text = document.getText(); document.getText = () => text + ' '; }
        }
        emit('change', { document, contentChanges: [] });
        if (kind === 'buffer-reverted') { const text = fs.readFileSync(tab.input.uri.fsPath, 'utf8'); document.version++; document.getText = () => text; emit('change', { document, contentChanges: [] }); }
      };
      const fixture = await coldSessionFixture(context, {
        expectCleanupFailure: true,
        afterOpen: values => { opened++; if (boundary === 'before-activation' || boundary === 'after-reopen' && opened === 2) mutate(values); },
        invokeTool: ({ options }) => ({ content: [{ value: JSON.stringify({ success: true, isLiveWorkbench: true, uri: options.input.targetFileUri }) }] }),
      });
      if (boundary === 'before-activation') {
        await assert.rejects(() => fixture.session.openCold(), /cold|canary|clean|bytes|version/i);
        assert.equal(fixture.counts().activations, 0);
        assert.equal(fixture.session.state.cold.firstMetadataId, null);
      } else {
        await fixture.session.openCold();
        if (boundary === 'before-close') {
          mutate({ tab: fixture.vscode.window.tabGroups.activeTabGroup.activeTab, emit: fixture.emit, vscode: fixture.vscode });
          await assert.rejects(() => fixture.session.closeCold(), /cold|canary|clean|bytes|version/i);
          assert.equal(fixture.closeCount(), 0);
        } else {
          await fixture.session.closeCold();
          await assert.rejects(() => fixture.session.reopenCold(), /cold|canary|clean|bytes|version/i);
          assert.equal(fixture.closeCount(), 1);
        }
        assert.equal(fixture.counts().activations, 1);
      }
      const state = fixture.session.state;
      assert.ok(state.coldCanary.exactBytes === false || state.coldCanary.allRevisionsClean === false || state.coldCanary.versionsStable === false);
      assert.equal(state.untouched.checkedSourceCount, 131);
      assert.equal(state.untouched.exactBytes, true);
      assert.equal(state.untouched.allRevisionsClean, true);
      for (const file of fixture.config.acceptancePlan.files) assert.deepEqual(fs.readFileSync(path.join(fixture.staged.historyRoot, file.path)), fixture.before.images.get(file.path));
      assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.evidenceRoot, 'lifecycle-summary.json'), 'utf8')).verdict, 'PRESERVATION_FAILED');
    });
  }
}

test('acceptance session permits one first exact-ID activation to focus a clean owned tab from onboarding', async context => {
  const fixture = await coldSessionFixture(context, {
    afterOpen: ({ tab, tabs, activeTabGroup, vscode }) => {
      tab.isActive = false;
      const welcome = { input: new vscode.TabInputWebview('kustoWorkbench.firstLaunchSetup'), label: 'Welcome to Kusto Workbench', isDirty: false, isActive: true };
      tabs.push(welcome); activeTabGroup.activeTab = welcome;
    },
    invokeTool: ({ tab, activeTabGroup, options }) => {
      assert.equal(activeTabGroup.activeTab.label, 'Welcome to Kusto Workbench');
      assert.equal(tab.isDirty, false);
      assert.equal(options.input.targetFileUri, tab.input.uri.toString());
      activeTabGroup.activeTab.isActive = false; activeTabGroup.activeTab = tab; tab.isActive = true;
      return { content: [{ value: JSON.stringify({ success: true, isLiveWorkbench: true, uri: tab.input.uri.toString() }) }] };
    },
  });
  const result = await fixture.session.openCold();
  assert.equal(result.coldUri, fixture.vscode.window.tabGroups.activeTabGroup.activeTab.input.uri.toString());
  assert.deepEqual(fixture.counts(), { opens: 1, activations: 1 });
  assert.equal(fixture.session.state.cold.activationCalls, 1);
  assert.equal(fixture.session.state.operations[0].success, true);
  assert.deepEqual(fixture.session.state.failures, []);
});

test('acceptance session waits for delayed exact-tab notification without another open or activation', async context => {
  const fixture = await coldSessionFixture(context, {
    afterOpen: ({ tab, tabs, activeTabGroup, emit }) => {
      tabs.splice(tabs.indexOf(tab), 1); activeTabGroup.activeTab = null;
      setImmediate(() => { tabs.push(tab); activeTabGroup.activeTab = tab; emit('tabs', { opened: [tab], changed: [], closed: [] }); });
    },
    invokeTool: ({ tab, options }) => ({ content: [{ value: JSON.stringify({ success: true, isLiveWorkbench: true, uri: options.input.targetFileUri }) }] }),
  });
  await fixture.session.openCold();
  assert.deepEqual(fixture.counts(), { opens: 1, activations: 1 });
  assert.deepEqual(fixture.listenerCounts(), { tabs: 1, groups: 0 }, 'Dispose only the readiness subscriptions');
});

test('acceptance session waits for post-tool SDK focus notification and still asserts the current exact custom tab', async context => {
  const fixture = await coldSessionFixture(context, {
    afterOpen: ({ tab, tabs, activeTabGroup, vscode }) => {
      tab.isActive = false;
      const welcome = { input: new vscode.TabInputWebview('kustoWorkbench.firstLaunchSetup'), label: 'Welcome to Kusto Workbench', isDirty: false, isActive: true };
      tabs.push(welcome); activeTabGroup.activeTab = welcome;
    },
    invokeTool: ({ tab, activeTabGroup, emit, options }) => {
      setImmediate(() => { activeTabGroup.activeTab.isActive = false; activeTabGroup.activeTab = tab; tab.isActive = true;
        emit('groups', { opened: [], changed: [activeTabGroup], closed: [] }); });
      return { content: [{ value: JSON.stringify({ success: true, isLiveWorkbench: true, uri: options.input.targetFileUri }) }] };
    },
  });
  await fixture.session.openCold();
  assert.deepEqual(fixture.counts(), { opens: 1, activations: 1 });
  assert.equal(fixture.vscode.window.tabGroups.activeTabGroup.activeTab.input.viewType, 'kusto.kqlxEditor');
  assert.deepEqual(fixture.listenerCounts(), { tabs: 1, groups: 0 });
});

for (const [name, options, error] of [
  ['wrong editor type', { afterOpen: ({ tab, vscode }) => { tab.input = new vscode.TabInputCustom(tab.input.uri, 'foreign.editor'); } }, /wrong editor type/i],
  ['neighbor-only metadata', { metadataInventory: () => [{ uri: 'file:///owned/healthy-neighbor.kqlx', openFileId: 'neighbor-id' }] }, /openFileId.*absent/i],
  ['ambiguous exact metadata', { metadataInventory: ({ tabs }) => ['first-id', 'second-id'].map(openFileId => ({ uri: tabs[0].input.uri.toString(), openFileId })) }, /openFileId.*ambiguous/i],
]) test('acceptance session blocks ' + name + ' before any activation and retains exact tab diagnostics', async context => {
  const fixture = await coldSessionFixture(context, options);
  await assert.rejects(() => fixture.session.openCold(), error);
  assert.deepEqual(fixture.counts(), { opens: 1, activations: 0 });
  assert.equal(fixture.session.state.cold.firstToolTarget, null);
  assert.equal(fixture.session.state.operations.length, 0);
  const diagnostic = fixture.session.state.tabDiagnostics[0];
  assert.equal(diagnostic.expected.uri, fixture.session.state.cold.uri);
  assert.equal(diagnostic.expected.viewType, 'kusto.kqlxEditor');
  assert.equal(diagnostic.active.uri, diagnostic.expected.uri);
  assert.equal(diagnostic.tabs.length, 1);
  assert.equal(diagnostic.tabs[0].viewType, name === 'wrong editor type' ? 'foreign.editor' : 'kusto.kqlxEditor');
  assert.equal(diagnostic.document.isDirty, false);
  assert.deepEqual(fixture.listenerCounts(), { tabs: 1, groups: 0 });
  const retained = JSON.parse(fs.readFileSync(path.join(fixture.evidenceRoot, 'acceptance-state.json'), 'utf8'));
  assert.deepEqual(retained.tabDiagnostics[0], diagnostic);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.evidenceRoot, 'lifecycle-summary.json'), 'utf8')).verdict, 'HARNESS_BLOCKED_SETUP');
});

for (const beforeTool of [true, false]) test('acceptance session bounds ' + (beforeTool ? 'missing-tab' : 'post-tool wrong-focus') + ' notification waits without replay or losing the first failure', async context => {
  let waitEntered;
  const waiting = new Promise(resolve => { waitEntered = resolve; });
  const fixture = await coldSessionFixture(context, {
    afterOpen: ({ tab, tabs, activeTabGroup, vscode }) => {
      tab.isActive = false;
      if (beforeTool) tabs.splice(tabs.indexOf(tab), 1);
      const welcome = { input: new vscode.TabInputWebview('kustoWorkbench.firstLaunchSetup'), label: 'Welcome to Kusto Workbench', isDirty: false, isActive: true };
      tabs.push(welcome); activeTabGroup.activeTab = welcome;
      if (beforeTool) setImmediate(waitEntered);
    },
    invokeTool: ({ options }) => { setImmediate(waitEntered); return { content: [{ value: JSON.stringify({ success: true, isLiveWorkbench: true, uri: options.input.targetFileUri }) }] }; },
  });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(() => fixture.session.openCold(), beforeTool ? /tab\/buffer unavailable before first activation/i : /not active after first activation/i);
  await waiting;
  context.mock.timers.tick(90000);
  context.mock.timers.reset();
  await rejected;
  assert.deepEqual(fixture.counts(), { opens: 1, activations: beforeTool ? 0 : 1 });
  assert.equal(fixture.session.state.cold.activationPhase, beforeTool ? 'opening' : 'tool-invoked');
  assert.equal(fixture.session.state.cold.tabReadiness.after, null);
  assert.equal(fixture.session.state.cold.controlsReady, false);
  if (!beforeTool) assert.equal(fixture.session.state.operations[0].success, true, 'A success JSON does not prove current SDK focus');
  const diagnostic = fixture.session.state.tabDiagnostics[0];
  assert.equal(diagnostic.expected.uri, fixture.session.state.cold.uri);
  assert.equal(diagnostic.active.uri, null);
  assert.equal(diagnostic.active.viewType, 'kustoWorkbench.firstLaunchSetup');
  assert.equal(diagnostic.tabs.length, beforeTool ? 1 : 2);
  assert.deepEqual(fixture.listenerCounts(), { tabs: 1, groups: 0 });
  const first = { ...fixture.session.state.failures[0] };
  await assert.rejects(() => fixture.session.openCold(), /retry|replay|already|first/i);
  assert.deepEqual(fixture.session.state.failures[0], first);
  assert.deepEqual(fixture.counts(), { opens: 1, activations: beforeTool ? 0 : 1 });
});

test('acceptance session rejects a neighboring tool-result URI even with the exact owned tab already active', async context => {
  const fixture = await coldSessionFixture(context, {
    invokeTool: ({ options }) => ({ content: [{ value: JSON.stringify({ success: true, isLiveWorkbench: true, uri: options.input.targetFileUri + '.neighbor.kqlx' }) }] }),
  });
  await assert.rejects(() => fixture.session.openCold(), /exact usable panel/i);
  assert.deepEqual(fixture.counts(), { opens: 1, activations: 1 });
  assert.equal(fixture.session.state.cold.activationPhase, 'tool-invoked');
  assert.equal(fixture.session.state.cold.tabReadiness.after, null);
  assert.notEqual(fixture.session.state.tabDiagnostics[0].toolResult.uri, fixture.session.state.cold.uri);
});

test('acceptance session cannot retry a rejected first cold exact-ID activation or erase its failed evidence', async context => {
  const { session, evidenceRoot, counts } = await coldSessionFixture(context);
  await assert.rejects(() => session.openCold(), /cold activation unready/i);
  const first = session.state.failures[0];
  await assert.rejects(() => session.openCold(), /retry|replay|already|first/i);
  assert.deepEqual(counts(), { opens: 1, activations: 1 });
  assert.equal(session.state.cold.activationCalls, 1);
  assert.deepEqual(session.state.failures[0], first);
  assert.equal(session.state.operations[0].success, false);
  const retained = JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'acceptance-state.json'), 'utf8'));
  assert.equal(retained.operations[0].success, false);
});

test('acceptance historical inventory requires all 109 exact retained tabs, not a successful activation counter', () => {
  const order = acceptanceEvidence().acceptance.expectedOrder;
  const root = path.join(os.tmpdir(), 'kw-acceptance-inventory-fixture', 'history');
  const uris = order.map(value => pathToFileURL(path.join(root, value)).href);
  const tabs = uris.map(uri => ({ input: { uri: { toString: () => uri } }, isDirty: false }));
  const vscode = { window: { tabGroups: { all: [{ tabs }] } } };
  assert.equal(acceptanceHarness.inspectHistoricalTabs(vscode, uris).retainedCount, 109);
  const last = tabs.pop();
  assert.throws(() => acceptanceHarness.inspectHistoricalTabs(vscode, uris), /retained|109|missing/i);
  tabs.push(last);
  tabs[82].isDirty = true;
  assert.throws(() => acceptanceHarness.inspectHistoricalTabs(vscode, uris), /dirty|clean/i);
  tabs[82].isDirty = false;
  tabs.push(tabs[0]);
  assert.throws(() => acceptanceHarness.inspectHistoricalTabs(vscode, uris), /duplicate|retained/i);
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