// MediaPipe task creation shared by faces.js and segment.js (one worker can hold several tasks).
// The wasm loader is an ES module that sets self.ModuleFactory once, when first imported, and every
// task clears it after building its own wasm instance. So the second task in a worker would find
// nothing: put the factory back before each create, one create at a time.
import { FilesetResolver } from './vendor/mediapipe/vision_bundle.mjs';

const WASM = new URL('./vendor/mediapipe/wasm', import.meta.url).href;
const LOADER = new URL('./vendor/mediapipe/wasm/vision_wasm_module_internal.js', import.meta.url).href;
let filesP = null;
let chain = Promise.resolve();

export function createTask(Task, options) {
  const run = async () => {
    filesP ||= FilesetResolver.forVisionTasks(WASM, true);
    const files = await filesP;
    const m = await import(LOADER);
    self.ModuleFactory = m.default;
    return Task.createFromOptions(files, options);
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}
