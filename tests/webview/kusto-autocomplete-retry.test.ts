import { describe, expect, it, vi } from 'vitest';

import {
	classifyKustoSupplementalRetryState,
	KustoAutocompleteRetryCoordinator,
	runKustoAutocompleteTriggerFrame,
	waitForKustoSupplementalRetryReadiness,
} from '../../src/webview/shared/kusto-autocomplete-retry.js';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(next => { resolve = next; });
	return { promise, resolve };
}

function editorFixture() {
	let position = { lineNumber: 9, column: 11 };
	let cursorListener: (() => void) | undefined;
	let contentListener: (() => void) | undefined;
	const model = { getVersionId: () => 1, isDisposed: () => false };
	const editor = {
		getModel: () => model,
		getPosition: () => position,
		hasTextFocus: () => true,
		hasWidgetFocus: () => false,
		onDidChangeCursorPosition: (listener: () => void) => { cursorListener = listener; return { dispose: () => { cursorListener = undefined; } }; },
		onDidChangeModelContent: (listener: () => void) => { contentListener = listener; return { dispose: () => { contentListener = undefined; } }; },
	};
	return {
		editor,
		model,
		setPosition: (lineNumber: number, column: number) => { position = { lineNumber, column }; cursorListener?.(); },
		changeContent: () => contentListener?.(),
	};
}

describe('KustoAutocompleteRetryCoordinator', () => {
	it('lets the latest request win and triggers it exactly once', async () => {
		const coordinator = new KustoAutocompleteRetryCoordinator();
		const fixture = editorFixture();
		const first = deferred<boolean>();
		const second = deferred<boolean>();
		const firstTrigger = vi.fn();
		const secondTrigger = vi.fn();

		const firstRequest = coordinator.begin({ editor: fixture.editor, boxId: 'query_1' })!;
		const secondRequest = coordinator.begin({ editor: fixture.editor, boxId: 'query_1' })!;
		expect(firstRequest.signal.aborted).toBe(true);
		expect(coordinator.queue(firstRequest, { ready: first.promise, trigger: firstTrigger })).toBe(false);
		expect(coordinator.queue(secondRequest, { ready: second.promise, trigger: secondTrigger })).toBe(true);
		first.resolve(true);
		second.resolve(true);
		await Promise.all([first.promise, second.promise]);
		await Promise.resolve();
		await Promise.resolve();

		expect(firstTrigger).not.toHaveBeenCalled();
		expect(secondTrigger).toHaveBeenCalledTimes(1);
	});

	it('does not trigger after the caret moves or editor ownership is lost', async () => {
		const coordinator = new KustoAutocompleteRetryCoordinator();
		const moved = editorFixture();
		const movedReady = deferred<boolean>();
		const movedTrigger = vi.fn();
		const movedRequest = coordinator.begin({ editor: moved.editor, boxId: 'query_1' })!;
		expect(coordinator.queue(movedRequest, { ready: movedReady.promise, trigger: movedTrigger })).toBe(true);
		moved.setPosition(10, 4);
		expect(movedRequest.signal.aborted).toBe(true);
		movedReady.resolve(true);

		const retired = editorFixture();
		const retiredReady = deferred<boolean>();
		const retiredTrigger = vi.fn();
		let current = true;
		const retiredRequest = coordinator.begin({ editor: retired.editor, boxId: 'query_2', isEditorCurrent: () => current })!;
		expect(coordinator.queue(retiredRequest, { ready: retiredReady.promise, trigger: retiredTrigger })).toBe(true);
		current = false;
		retiredReady.resolve(true);
		await Promise.all([movedReady.promise, retiredReady.promise]);
		await Promise.resolve();
		await Promise.resolve();

		expect(movedTrigger).not.toHaveBeenCalled();
		expect(retiredTrigger).not.toHaveBeenCalled();
	});

	it('does not trigger after explicit cancellation', async () => {
		const coordinator = new KustoAutocompleteRetryCoordinator();
		const fixture = editorFixture();
		const ready = deferred<boolean>();
		const trigger = vi.fn();
		const request = coordinator.begin({ editor: fixture.editor, boxId: 'query_1' })!;
		expect(coordinator.queue(request, { ready: ready.promise, trigger })).toBe(true);

		coordinator.cancel(fixture.editor);
		expect(request.signal.aborted).toBe(true);
		ready.resolve(true);
		await ready.promise;
		await Promise.resolve();

		expect(trigger).not.toHaveBeenCalled();
	});

	it('rejects an old preparation that queues after a newer request begins', () => {
		const coordinator = new KustoAutocompleteRetryCoordinator();
		const fixture = editorFixture();
		const oldRequest = coordinator.begin({ editor: fixture.editor, boxId: 'query_1' })!;
		const currentRequest = coordinator.begin({ editor: fixture.editor, boxId: 'query_1' })!;

		expect(coordinator.queue(oldRequest, { ready: Promise.resolve(true), trigger: vi.fn() })).toBe(false);
		expect(coordinator.isCurrent(currentRequest)).toBe(true);
		expect(coordinator.complete(currentRequest)).toBe(true);
	});

	it('aborts on content changes during preparation', () => {
		const coordinator = new KustoAutocompleteRetryCoordinator();
		const fixture = editorFixture();
		const request = coordinator.begin({ editor: fixture.editor, boxId: 'query_1' })!;

		fixture.changeContent();

		expect(request.signal.aborted).toBe(true);
		expect(coordinator.isCurrent(request)).toBe(false);
	});

	it('aborts immediately when an external schema target becomes stale', () => {
		const coordinator = new KustoAutocompleteRetryCoordinator();
		const fixture = editorFixture();
		let targetCurrent = true;
		let notifyTargetChanged: (() => void) | undefined;
		const request = coordinator.begin({
			editor: fixture.editor,
			boxId: 'query_1',
			isEditorCurrent: () => targetCurrent,
			subscribeCurrentness: listener => {
				notifyTargetChanged = listener;
				return { dispose: () => { notifyTargetChanged = undefined; } };
			},
		})!;

		targetCurrent = false;
		notifyTargetChanged?.();

		expect(request.signal.aborted).toBe(true);
		expect(coordinator.isCurrent(request)).toBe(false);
	});

	it('aborts immediately when the completion session is dismissed', () => {
		const coordinator = new KustoAutocompleteRetryCoordinator();
		const fixture = editorFixture();
		let dismiss: (() => void) | undefined;
		const request = coordinator.begin({
			editor: fixture.editor,
			boxId: 'query_1',
			subscribeCancellation: listener => {
				dismiss = listener;
				return { dispose: () => { dismiss = undefined; } };
			},
		})!;

		dismiss?.();

		expect(request.signal.aborted).toBe(true);
		expect(coordinator.isCurrent(request)).toBe(false);
	});

	it('uses fallback exactly once when readiness settles false', async () => {
		const coordinator = new KustoAutocompleteRetryCoordinator();
		const fixture = editorFixture();
		const ready = deferred<boolean>();
		const trigger = vi.fn();
		const fallback = vi.fn();
		const request = coordinator.begin({ editor: fixture.editor, boxId: 'query_1' })!;
		coordinator.queue(request, { ready: ready.promise, trigger, fallback });

		ready.resolve(false);
		await ready.promise;
		await Promise.resolve();

		expect(trigger).not.toHaveBeenCalled();
		expect(fallback).toHaveBeenCalledTimes(1);
	});
});


describe('waitForKustoSupplementalRetryReadiness', () => {
	it('waits through arbitrary queued and applying states until loaded', async () => {
		let callback: (() => void) | undefined;
		let status: 'pending' | 'loaded' = 'pending';
		const readiness = waitForKustoSupplementalRetryReadiness({
			keys: ['remote'],
			getStatus: () => status,
			timerApi: {
				setTimer: next => { callback = next; return 'timer'; },
				clearTimer: vi.fn(),
			},
		});

		for (let index = 0; index < 100; index++) callback?.();
		status = 'loaded';
		callback?.();

		await expect(readiness).resolves.toBe(true);
	});

	it('settles false when every schema fails or the request aborts', async () => {
		let callback: (() => void) | undefined;
		const statuses: Record<string, 'pending' | 'failed'> = { first: 'failed', second: 'pending' };
		const failed = waitForKustoSupplementalRetryReadiness({
			keys: ['first', 'second'],
			getStatus: key => statuses[key],
			timerApi: {
				setTimer: next => { callback = next; return 'timer'; },
				clearTimer: vi.fn(),
			},
		});
		statuses.second = 'failed';
		callback?.();
		await expect(failed).resolves.toBe(false);

		const controller = new AbortController();
		const aborted = waitForKustoSupplementalRetryReadiness({
			keys: ['remote'],
			signal: controller.signal,
			getStatus: () => 'pending',
		});
		controller.abort();
		await expect(aborted).resolves.toBe(false);
	});

	it('settles false when a pending schema exceeds the retry deadline', async () => {
		let callback: (() => void) | undefined;
		let now = 0;
		const readiness = waitForKustoSupplementalRetryReadiness({
			keys: ['remote'],
			getStatus: () => 'pending',
			timeoutMs: 100,
			timerApi: {
				now: () => now,
				setTimer: next => { callback = next; return 'timer'; },
				clearTimer: vi.fn(),
			},
		});
		now = 100;
		callback?.();

		await expect(readiness).resolves.toBe(false);
	});

	it('treats removed or replacement reference generations as stale', async () => {
		expect(classifyKustoSupplementalRetryState(1, undefined)).toBe('stale');
		expect(classifyKustoSupplementalRetryState(1, { referenceGeneration: 2, status: 'loaded' })).toBe('stale');
		expect(classifyKustoSupplementalRetryState(1, { referenceGeneration: 1, status: 'applying' })).toBe('pending');
		expect(classifyKustoSupplementalRetryState(1, { referenceGeneration: 1, status: 'loaded' })).toBe('loaded');

		let callback: (() => void) | undefined;
		let state: { referenceGeneration: number; status: string } | undefined = { referenceGeneration: 1, status: 'fetching' };
		const onStale = vi.fn();
		const readiness = waitForKustoSupplementalRetryReadiness({
			keys: ['remote'],
			getStatus: () => classifyKustoSupplementalRetryState(1, state),
			onStale,
			timerApi: {
				setTimer: next => { callback = next; return 'timer'; },
				clearTimer: vi.fn(),
			},
		});
		state = { referenceGeneration: 2, status: 'loaded' };
		callback?.();

		await expect(readiness).resolves.toBe(false);
		expect(onStale).toHaveBeenCalledTimes(1);
	});

	it('lets a stale generation veto another reference that already loaded', async () => {
		const onStale = vi.fn();
		const readiness = waitForKustoSupplementalRetryReadiness({
			keys: ['loaded', 'replaced'],
			getStatus: key => key === 'loaded' ? 'loaded' : 'stale',
			onStale,
		});

		await expect(readiness).resolves.toBe(false);
		expect(onStale).toHaveBeenCalledTimes(1);
	});
});

describe('runKustoAutocompleteTriggerFrame', () => {
	it('accepts a stale deferred frame without invoking the trigger', async () => {
		let frame: (() => void) | undefined;
		let current = true;
		const trigger = vi.fn(() => true);
		const result = runKustoAutocompleteTriggerFrame({
			isCurrent: () => current,
			trigger,
			schedule: callback => { frame = callback; },
		});
		current = false;
		frame?.();

		await expect(result).resolves.toEqual({ accepted: true, triggered: false, stale: true });
		expect(trigger).not.toHaveBeenCalled();
	});

	it('runs only the current deferred frame', async () => {
		let frame: (() => void) | undefined;
		const trigger = vi.fn(() => true);
		const result = runKustoAutocompleteTriggerFrame({
			isCurrent: () => true,
			trigger,
			schedule: callback => { frame = callback; },
		});
		frame?.();

		await expect(result).resolves.toEqual({ accepted: true, triggered: true, stale: false });
		expect(trigger).toHaveBeenCalledTimes(1);
	});
});