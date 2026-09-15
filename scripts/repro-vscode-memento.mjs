#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const usage = `Usage: node scripts/repro-vscode-memento.mjs --vscode-root <resources/app or installation root>
Manual diagnostic using the installed native Memento and ExtHostStorage classes.
Only the scheduler, deferred promises, emitter and main-thread transport are controlled.
Uses synthetic state; reads installation files only; writes JSON to stdout only.
Cases: FIFO echo race, serialized, coalesced, B eager send before A echo.
Exit 1: all five preferences lost in the race, with all controls preserved.
Exit 0: race and all controls preserved. Exit 2: unsupported layout or diagnostic/control failure.
--help prints this text. No CI or unit-test registration.`;
const report = { version: null, commit: null, nodeVersion: process.version, scenarios: [] };
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const one = (values, label) => {
	ensure(values.length === 1, `Unsupported layout: expected one ${label}, found ${values.length}`);
	return values[0];
};
const clone = value => JSON.parse(JSON.stringify(value));
const builtins = new Set(['Object', 'Array', 'Map', 'Set', 'Promise', 'JSON', 'Error', 'TypeError', 'String', 'Number', 'Boolean', 'undefined']);
function scan(root, predicate) {
	const matches = [];
	function visit(node) { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit); }
	visit(root);
	return matches;
}
const method = (owner, name) => owner.members.find(member => ts.isMethodDeclaration(member) && member.name.getText() === name);
function inspect(owner) {
	const text = `(${owner.getText()})`;
	const file = ts.createSourceFile('native.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const options = { allowJs: true, noLib: true, noResolve: true, noEmit: true };
	const host = { ...ts.createCompilerHost(options), getSourceFile: name => name === 'native.js' ? file : undefined,
		fileExists: name => name === 'native.js', readFile: () => undefined,
		writeFile: () => { throw new Error('Diagnostic must not write files'); } };
	const checker = ts.createProgram(['native.js'], options, host).getTypeChecker();
	const globals = new Set(scan(file, ts.isIdentifier).filter(identifier => {
		const parent = identifier.parent;
		if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === identifier) return false;
		return !builtins.has(identifier.text) && !checker.getSymbolAtLocation(identifier);
	}).map(identifier => identifier.text));
	return { text, globals };
}
async function settled(promise, label) {
	ensure(typeof promise?.then === 'function', `Unsupported native promise: ${label}`);
	let timer;
	try { return await Promise.race([promise, new Promise((resolveTimeout, rejectTimeout) => {
		timer = setTimeout(() => rejectTimeout(new Error(`Diagnostic did not settle: ${label}`)), 2000);
	})]); } finally { clearTimeout(timer); }
}
class Deferred {
	constructor() { this.p = new Promise((resolvePromise, rejectPromise) => { this.complete = resolvePromise; this.error = rejectPromise; }); }
}
class Emitter {
	listeners = new Set();
	event = (listener, thisArg) => {
		const entry = { listener, thisArg }; this.listeners.add(entry);
		return { dispose: () => this.listeners.delete(entry) };
	};
	fire(value) { for (const { listener, thisArg } of [...this.listeners]) listener.call(thisArg, value); }
	dispose() { this.listeners.clear(); }
}
async function scenario(name, definitions, identifiers) {
	const expected = { unrelated: 'A', prefs: Object.fromEntries([1, 2, 3, 4, 5].map(index => [`preference${index}`, true])) };
	const record = { name, updates: [], timeline: [], expected, actual: null, logs: [] };
	report.scenarios.push(record);
	const timers = [], callbacks = [], queue = [], promises = [];
	let persisted = {}, sequence = 0;
	const extensionId = 'diagnostic.synthetic-memento';
	const logger = Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error', 'log'].map(level =>
		[level, (...args) => record.logs.push({ level, message: args.map(String).join(' ') })]));
	class Scheduler {
		constructor(callback, delay) { ensure(delay === 0, 'Unsupported scheduler delay'); this.callback = callback; this.pending = false; timers.push(this); }
		schedule(delay = 0) { ensure(delay === 0, 'Unsupported scheduled delay'); this.pending = true; }
		isScheduled() { return this.pending; }
		cancel() { this.pending = false; }
		dispose() { this.cancel(); }
	}
	const bindings = { [identifiers.scheduler]: Scheduler, [identifiers.deferred]: Deferred,
		[identifiers.emitter]: Emitter, [identifiers.mainContext]: { MainThreadStorage: 0 }, console: logger };
	const native = definition => {
		const missing = [...definition.globals].filter(identifier => !Object.hasOwn(bindings, identifier));
		ensure(!missing.length, `Unsupported native dependencies: ${missing.join(', ')}`);
		return runInNewContext(definition.text, bindings, { timeout: 1000, filename: 'installed-native-class.js' });
	};
	const proxy = {
		$initializeExtensionStorage(shared, key) {
			ensure(shared === true && key === extensionId, 'Unsupported initialization identity'); return Promise.resolve('{}');
		},
		$setValue(shared, key, value) {
			ensure(shared === true && key === extensionId, 'Unsupported write identity');
			const write = { sequence: ++sequence, shared, key, value: clone(value), done: new Deferred() };
			queue.push(write); record.timeline.push({ event: 'send', sequence, value: clone(write.value) });
			return write.done.p;
		}
	};
	const storage = new (native(definitions.storage))({ getProxy: () => proxy }, logger);
	const memento = new (native(definitions.memento))(extensionId, true, storage);
	await settled(memento.whenReady, `${name} initialization`);
	const timer = one(timers, 'native Memento scheduler');
	const normalize = value => clone({ unrelated: value.unrelated ?? null, prefs: value.prefs ?? {} });
	const snapshot = () => normalize({ unrelated: memento.get('unrelated'), prefs: memento.get('prefs') });
	const update = (key, value) => {
		const entry = { key, value: clone(value), status: 'pending' }; record.updates.push(entry);
		const promise = memento.update(key, value); promises.push(promise);
		promise.then(() => { entry.status = 'fulfilled'; }, () => { entry.status = 'rejected'; });
		record.timeline.push({ event: 'update', key, live: snapshot() }); return promise;
	};
	const send = () => {
		ensure(timer.isScheduled(), `Unsupported scheduling in ${name}`); timer.cancel();
		const callback = Promise.resolve(timer.callback()); callback.catch(() => {}); callbacks.push(callback);
		ensure(sequence === callbacks.length, `Unsupported asynchronous send in ${name}`);
	};
	const echo = () => {
		const write = queue.shift(); ensure(write, `Missing FIFO write in ${name}`);
		persisted = clone(write.value); storage.$acceptValue(write.shared, write.key, JSON.stringify(persisted));
		record.timeline.push({ event: 'echo', sequence: write.sequence, value: clone(persisted), live: snapshot() });
		write.done.complete();
	};
	const pendingA = update('unrelated', expected.unrelated);
	if (name === 'coalesced') { update('prefs', expected.prefs); send(); echo(); }
	else {
		send();
		ensure(!Object.hasOwn(queue[0].value, 'prefs'), 'A snapshot unexpectedly contains preferences');
		if (name === 'serialized') { echo(); await settled(pendingA, `${name} A`); }
		update('prefs', expected.prefs);
		if (name === 'fifo-echo-race') { echo(); await settled(pendingA, `${name} A`); }
		send();
		if (name === 'b-eager-before-a-echo') echo();
		echo();
	}
	await settled(Promise.all([...promises, ...callbacks]), `${name} updates`);
	ensure(!queue.length && !timer.isScheduled() && sequence === (name === 'coalesced' ? 1 : 2), `Pending work or unexpected sends in ${name}`);
	ensure(!record.logs.length, `Native storage logger reported a diagnostic failure in ${name}`);
	record.actual = { live: snapshot(), persisted: normalize(persisted) };
	record.retainedPreferences = Object.fromEntries(Object.entries(record.actual).map(([layer, value]) =>
		[layer, Object.keys(expected.prefs).filter(key => value.prefs[key] === expected.prefs[key]).length]));
	const values = Object.values(record.actual);
	record.status = values.every(value => isDeepStrictEqual(value, expected)) ? 'preserved'
		: values.every(value => isDeepStrictEqual(value, { unrelated: 'A', prefs: {} })) ? 'lost-five-preferences' : 'unexpected-state';
	memento.dispose();
}
async function main(argv) {
	ensure(argv.length === 2 && argv[0] === '--vscode-root' && argv[1] && !argv[1].startsWith('--'), usage);
	const root = resolve(argv[1]), bundle = 'out/vs/workbench/api/node/extensionHostProcess.js';
	const candidates = [root, join(root, 'resources', 'app')];
	const isApp = candidate => existsSync(join(candidate, bundle));
	if (!candidates.some(isApp)) candidates.push(...readdirSync(root, { withFileTypes: true })
		.filter(entry => entry.isDirectory()).map(entry => join(root, entry.name, 'resources', 'app')));
	const app = one(candidates.filter(isApp), 'VS Code app root; specify resources/app if ambiguous');
	report.version = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).version;
	report.commit = JSON.parse(readFileSync(join(app, 'product.json'), 'utf8')).commit;
	ensure(typeof report.version === 'string' && typeof report.commit === 'string', 'Installed version/commit metadata is missing');
	const source = ts.createSourceFile(bundle, readFileSync(join(app, bundle), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	ensure(!source.parseDiagnostics.length, 'Unsupported native JavaScript syntax');
	const classes = scan(source, node => ts.isClassDeclaration(node) || ts.isClassExpression(node));
	const memento = one(classes.filter(owner => method(owner, 'get') && method(owner, 'update') && scan(owner, node =>
		ts.isPropertyAccessExpression(node) && node.name.text === 'onDidChangeStorage' && ts.isPropertyAccessExpression(node.expression)
		&& node.expression.name.text === '_storage' && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword).length), 'Memento class');
	const storage = one(classes.filter(owner => ['initializeExtensionStorage', '$acceptValue', 'setValue'].every(name => method(owner, name))), 'ExtHostStorage class');
	const definitions = { memento: inspect(memento), storage: inspect(storage) };
	const externalNew = (node, definition) => ts.isNewExpression(node) && ts.isIdentifier(node.expression) && definition.globals.has(node.expression.text);
	const identifiers = {
		scheduler: one(scan(memento, node => externalNew(node, definitions.memento) && node.arguments?.length === 2
			&& ts.isArrowFunction(node.arguments[0]) && ts.isNumericLiteral(node.arguments[1]) && node.arguments[1].text === '0'), 'zero-delay scheduler').expression.text,
		deferred: one(scan(method(memento, 'update'), node => externalNew(node, definitions.memento) && !node.arguments?.length), 'update deferred').expression.text,
		emitter: one(scan(storage, node => externalNew(node, definitions.storage) && !node.arguments?.length), 'storage emitter').expression.text,
		mainContext: one([...new Set(scan(storage, node => ts.isPropertyAccessExpression(node) && node.name.text === 'MainThreadStorage'
			&& ts.isIdentifier(node.expression)).map(node => node.expression.text))], 'MainThreadStorage namespace')
	};
	ensure(new Set(Object.values(identifiers)).size === 4, 'Unsupported overlapping native dependencies');
	report.nativeDependencies = identifiers;
	for (const name of ['fifo-echo-race', 'serialized', 'coalesced', 'b-eager-before-a-echo']) await scenario(name, definitions, identifiers);
	const failedControls = report.scenarios.slice(1).filter(result => result.status !== 'preserved');
	ensure(!failedControls.length, `Control failure: ${failedControls.map(result => result.name).join(', ')}`);
	const race = report.scenarios[0];
	ensure(race.status !== 'unexpected-state', 'Race contract failure: unexpected partial or unrelated data change');
	report.status = race.status === 'preserved' ? 'contract-preserved' : 'race-reproduced';
	process.exitCode = race.status === 'preserved' ? 0 : 1;
}

if (process.argv.length === 3 && process.argv[2] === '--help') console.log(usage);
else {
	try { await main(process.argv.slice(2)); }
	catch (error) { report.status = 'diagnostic-error'; report.error = String(error?.message ?? error); process.exitCode = 2; }
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}