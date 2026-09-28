// MediaPipe task creation shared by faces.js and segment.js (one worker can hold several tasks).
// The wasm loader is an ES module that sets self.ModuleFactory once, when first imported, and every
// task clears it after building its own wasm instance. So the second task in a worker would find
// nothing: put the factory back before each create, one create at a time.
import { FilesetResolver } from './vendor/mediapipe/vision_bundle.mjs';

// Safari's module workers have no importScripts at all (Chrome has one that throws TypeError). MediaPipe's
// loader checks for it and, when it's missing, assumes it is on a page and reaches for `document`, which a
// worker doesn't have: "Can't find variable: document". A stub that throws TypeError sends it down its
// import() path instead.
if (typeof self.importScripts !== 'function' && typeof document === 'undefined') {
  self.importScripts = () => { throw new TypeError('importScripts is not available in module workers'); };
}

// MediaPipe also reaches for `document` to make a canvas when it decides the browser is Safari without a usable
// OffscreenCanvas. It decides from the user agent (Safari token, no `Version/` number) and iPhones don't always
// match. A worker has no document, so hand it a stand-in that makes OffscreenCanvases while a task is built.
const WORKER_DOCUMENT = {
  createElement(tag) {
    if (tag === 'canvas' && typeof OffscreenCanvas === 'function') return new OffscreenCanvas(1, 1);
    throw new Error(`MediaPipe asked the worker for a <${tag}> element`);
  },
};

// Shown in Settings > Run check, so a copy of this file that is stale on the phone is obvious.
export const MP_BUILD = 'mp-2';

export const WASM = new URL('./vendor/mediapipe/wasm', import.meta.url).href;
export const LOADER = new URL('./vendor/mediapipe/wasm/vision_wasm_module_internal.js', import.meta.url).href;
let filesP = null;
let chain = Promise.resolve();

export function createTask(Task, options) {
  const run = async () => {
    filesP ||= FilesetResolver.forVisionTasks(WASM, true);
    const files = await filesP;
    const m = await import(LOADER);
    self.ModuleFactory = m.default;
    const stand = typeof document === 'undefined';
    if (stand) self.document = WORKER_DOCUMENT;
    try { return await Task.createFromOptions(files, options); } finally { if (stand) delete self.document; }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

// Why a model didn't start, per model name ('face', 'person', 'tap'), for the app to show.
export const visionErrors = {};

function errInfo(e) {
  const type = e && e.type ? ` (${e.type} event)` : '';
  return { message: String((e && e.message) || e) + type, stack: String((e && e.stack) || '').split('\n').slice(0, 4).join('\n') };
}

/**
 * A task built on first use. A failure is remembered in visionErrors but not for good: the next use
 * tries again (a phone can run out of memory while several workers start at once), up to `tries` times.
 * get.retry() gives it fresh attempts. Resolves null when the model can't start.
 */
export function lazyTask(name, Task, options, tries = 2) {
  let task = null, pending = null, used = 0;
  const get = () => {
    if (task) return Promise.resolve(task);
    if (pending) return pending;
    if (used >= tries) return Promise.resolve(null);
    used++;
    pending = createTask(Task, options).then((t) => { task = t; visionErrors[name] = null; return t; }, (e) => {
      visionErrors[name] = errInfo(e);
      console.warn(`${name} model unavailable:`, e);
      return null;
    }).finally(() => { pending = null; });
    return pending;
  };
  get.retry = () => { used = 0; };
  return get;
}
