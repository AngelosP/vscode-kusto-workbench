const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, entry) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  return Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]));
});
const within = (parent, child) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};

function assertSeparateRoots(fixtureRoot, evidenceRoot) {
  const fixture = fs.realpathSync(fixtureRoot);
  const evidence = fs.realpathSync(evidenceRoot);
  if (within(fixture, evidence) || within(evidence, fixture)) {
    throw new Error('Fixture and evidence roots must be separate, non-nested directories');
  }
}

function payloads(document) {
  if (!Array.isArray(document?.state?.sections)) throw new Error('Missing notebook sections');
  const resultIdentity = text => {
    if (typeof text !== 'string') return null;
    try { return { raw: hash(text), canonical: hash(canonical(JSON.parse(text))) }; }
    catch (error) { return { raw: hash(text), canonical: null, error: String(error.message) }; }
  };
  return document.state.sections.map(section => ({
    id: section.id,
    type: section.type,
    name: section.name ?? null,
    title: section.title ?? null,
    query: typeof section.query === 'string' ? hash(section.query) : null,
    text: typeof section.text === 'string' ? hash(section.text) : null,
    result: resultIdentity(section.resultJson),
    attachment: Object.hasOwn(section, 'resultArtifact') ? hash(canonical(section.resultArtifact)) : null,
  }));
}

async function createJournal({ fixtureRoot, evidenceRoot, initialText, mode = 'diagnostic', maxPendingCodeUnits = 32 * 1024 * 1024 }) {
  assertSeparateRoots(fixtureRoot, evidenceRoot);
  if (!['diagnostic', 'minimal'].includes(mode)) throw new Error('Unknown journal mode');
  const worker = new Worker(__filename, { workerData: { evidenceRoot, initialText } });
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const events = [];
  const failures = [];
  const pending = new Map();
  let sequence = 0;
  let pendingCodeUnits = 0;
  let maximumPendingCodeUnits = 0;
  let callbackMaximumMs = 0;
  let callbackTotalMs = 0;
  let transportMaximumMs = 0;
  let stopped = false;
  let workerFailed = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const fail = error => {
    workerFailed = true;
    failures.push(String(error?.message || error));
    readyReject(error);
    for (const waiter of pending.values()) waiter.resolve(null);
    pending.clear();
    pendingCodeUnits = 0;
  };
  worker.on('error', fail);
  worker.on('exit', code => {
    if (!stopped) fail(new Error('Journal worker exited before completion: ' + code));
  });
  worker.on('message', message => {
    if (message.ready) { readyResolve(message.baseline); return; }
    const waiter = pending.get(message.sequence);
    if (!waiter) return;
    pending.delete(message.sequence);
    pendingCodeUnits -= waiter.codeUnits;
    if (message.error) failures.push(message.error);
    if (message.entry) events.push(message.entry);
    waiter.resolve(message.entry || null);
  });
  const baseline = await ready.catch(async error => {
    stopped = true;
    histogram.disable();
    await worker.terminate();
    throw error;
  });

  function enqueue(text, metadata, force = false) {
    const started = performance.now();
    const observedAt = Date.now();
    try {
      if (stopped || workerFailed) throw new Error('Journal is not accepting observations');
      const captured = structuredClone(metadata);
      const capturedText = mode === 'minimal' && !force ? undefined : text;
      const codeUnits = capturedText?.length || 0;
      if (pending.size >= 256 || pendingCodeUnits + codeUnits > maxPendingCodeUnits) {
        failures.push('Journal overflow at ' + captured.phase + ' version ' + captured.documentVersion);
        return null;
      }
      const identity = ++sequence;
      let resolve;
      const done = new Promise(complete => { resolve = complete; });
      pending.set(identity, { resolve, done, codeUnits });
      pendingCodeUnits += codeUnits;
      maximumPendingCodeUnits = Math.max(maximumPendingCodeUnits, pendingCodeUnits);
      setImmediate(() => {
        if (workerFailed || stopped) return;
        const transportStarted = performance.now();
        try {
          worker.postMessage({ ...captured, sequence: identity, observedAt, text: capturedText });
        } catch (error) { fail(error); }
        finally { transportMaximumMs = Math.max(transportMaximumMs, performance.now() - transportStarted); }
      });
      return identity;
    } catch (error) {
      failures.push(String(error?.message || error));
      return null;
    } finally {
      const duration = performance.now() - started;
      callbackMaximumMs = Math.max(callbackMaximumMs, duration);
      callbackTotalMs += duration;
    }
  }

  async function flush() {
    while (pending.size) await Promise.all([...pending.values()].map(waiter => waiter.done));
    return summary();
  }

  function summary() {
    const hasDelay = Number.isFinite(histogram.mean);
    return {
      mode, baseline, events: [...events], harnessFailures: [...failures],
      metrics: {
        callbackMaximumMs, callbackTotalMs, transportMaximumMs, maximumPendingCodeUnits,
        eventLoopMaximumMs: histogram.max / 1e6,
        eventLoopMeanMs: hasDelay ? histogram.mean / 1e6 : 0,
        eventLoopP99Ms: hasDelay ? histogram.percentile(99) / 1e6 : 0,
      },
    };
  }

  return {
    baseline,
    capture: (text, metadata) => enqueue(text, metadata),
    checkpoint: async (text, metadata) => {
      const identity = enqueue(text, metadata, true);
      await flush();
      return events.find(entry => entry.sequence === identity) || null;
    },
    note: metadata => enqueue(undefined, metadata, true),
    flush,
    summary,
    async close() {
      await flush();
      stopped = true;
      histogram.disable();
      await worker.terminate();
      const result = summary();
      fs.writeFileSync(path.join(evidenceRoot, 'journal-summary.json'), JSON.stringify(result, null, 2));
      return result;
    },
  };
}

if (!isMainThread) {
  const baseline = payloads(JSON.parse(workerData.initialText));
  const baselineIds = baseline.map(section => section.id);
  const journalPath = path.join(workerData.evidenceRoot, 'revisions.jsonl');
  fs.writeFileSync(journalPath, '', { flag: 'wx' });
  const firstInvalid = new Set();
  parentPort.on('message', message => {
    const started = performance.now();
    const { text, ...entry } = message;
    try {
      if (typeof text === 'string') {
        entry.byteLength = Buffer.byteLength(text);
        entry.sha256 = hash(text);
        try {
          const parsed = JSON.parse(text);
          entry.sections = payloads(parsed);
          entry.valid = true;
          entry.preservation = [];
          const originalOrder = entry.sections.filter(section => baselineIds.includes(section.id)).map(section => section.id);
          if (JSON.stringify(originalOrder) !== JSON.stringify(baselineIds)) entry.preservation.push('original-section-order-or-identity');
          for (const original of baseline) {
            const current = entry.sections.find(section => section.id === original.id);
            if (!current) continue;
            if (current.type !== original.type) entry.preservation.push(original.id + ':type');
            if (original.result && current.result?.canonical !== original.result.canonical) entry.preservation.push(original.id + ':result-content');
            if (original.attachment && current.attachment !== original.attachment) entry.preservation.push(original.id + ':attachment');
          }
          entry.rawChanges = baseline.filter(original => original.result && entry.sections.find(section => section.id === original.id)?.result?.raw !== original.result.raw).map(section => section.id);
        } catch (error) {
          entry.valid = false;
          entry.error = String(error.message);
          const origin = String(entry.phase || '').startsWith('disk:') ? 'disk-read' : 'buffer';
          entry.invalidOrigin = origin;
          if (!firstInvalid.has(origin)) {
            fs.writeFileSync(path.join(workerData.evidenceRoot, origin === 'buffer' ? 'first-invalid.kqlx' : 'first-invalid-disk-read.kqlx'), text, { flag: 'wx' });
            firstInvalid.add(origin);
          }
        }
      }
      entry.workerDurationMs = performance.now() - started;
      fs.appendFileSync(journalPath, JSON.stringify(entry) + '\n');
      parentPort.postMessage({ sequence: message.sequence, entry });
    } catch (error) {
      parentPort.postMessage({ sequence: message.sequence, error: String(error.message) });
    }
  });
  parentPort.postMessage({ ready: true, baseline });
} else {
  module.exports = { createJournal, assertSeparateRoots };
}