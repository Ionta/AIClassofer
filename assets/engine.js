/**
 * Загрузка onnxruntime-web, скачивание весов и запуск модели в браузере.
 * Никаких серверов: всё считается на устройстве пользователя.
 */
import { CONFIG } from './config.js';

let ortModule = null;

export function ortUrl() {
  return `${CONFIG.ortBase}ort.all.min.mjs`;
}

async function loadOrt() {
  if (!ortModule) {
    ortModule = await import(/* @vite-ignore */ ortUrl());
    const ort = ortModule;
    if (ort.env && ort.env.wasm) {
      ort.env.wasm.wasmPaths = CONFIG.ortBase;
      ort.env.wasm.simd = true;
      const isolated =
        typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false;
      ort.env.wasm.numThreads = isolated
        ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))
        : 1;
      ort.env.logLevel = 'error';
    }
  }
  return ortModule;
}

export async function fetchWithProgress(url, onProgress, label) {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`Не удалось скачать ${label || 'файл'} (HTTP ${response.status}).`);
  }
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (onProgress) onProgress(buffer.byteLength, buffer.byteLength);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(received, total);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function exists(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch (error) {
    return false;
  }
}

let localManifest;
/**
 * Список файлов, лежащих рядом с сайтом (model/manifest.json).
 * Если файла нет, все запросы идут на Hugging Face.
 */
function readLocalManifest() {
  if (!localManifest) {
    localManifest = (async () => {
      if (!CONFIG.localPath) return null;
      try {
        const url = new URL(CONFIG.localPath + 'manifest.json', document.baseURI).href;
        const response = await fetch(url, { cache: 'no-cache' });
        if (!response.ok) return null;
        const payload = await response.json();
        const files = Array.isArray(payload) ? payload : payload.files;
        return new Set(Array.isArray(files) ? files : []);
      } catch (error) {
        return null;
      }
    })();
  }
  return localManifest;
}

/**
 * Ищет файл сначала рядом с сайтом (model/…), затем на Hugging Face.
 * @returns {Promise<{url: string, source: 'local'|'remote'}>}
 */
export async function resolveAsset(name) {
  if (CONFIG.localPath && CONFIG.checkLocalFirst) {
    const files = await readLocalManifest();
    if (files && files.has(name)) {
      const local = new URL(CONFIG.localPath + name, document.baseURI).href;
      if (await exists(local)) return { url: local, source: 'local' };
    }
  }
  const remote = `${CONFIG.hfHost}/${CONFIG.repo}/resolve/${CONFIG.revision}/${name}`;
  return { url: remote, source: 'remote' };
}

export class Engine {
  constructor(session, ort, backend, meta) {
    this.session = session;
    this.ort = ort;
    this.backend = backend;
    this.meta = meta;
    this.inputIdsName = session.inputNames.includes('input_ids')
      ? 'input_ids'
      : session.inputNames[0];
    this.attentionName = session.inputNames.includes('attention_mask')
      ? 'attention_mask'
      : session.inputNames[session.inputNames.length - 1];
    this.outputName = session.outputNames.includes('logits')
      ? 'logits'
      : session.outputNames[0];
    this.aiIndex = CONFIG.labels.indexOf('ai');
    this._degraded = false;
  }

  static async create(options = {}) {
    const onProgress = options.onProgress || (() => {});
    const onStatus = options.onStatus || (() => {});
    const precision = options.precision || CONFIG.defaults.precision;
    const requested = options.backend || CONFIG.defaults.backend;

    onStatus('Загружаем onnxruntime-web…');
    const ort = await loadOrt();

    const file = precision === 'fp16' ? CONFIG.files.fp16 : precision === 'int8' ? CONFIG.files.int8 : CONFIG.files.fp32;
    const resolved = await resolveAsset(file);
    onStatus(
      resolved.source === 'local'
        ? `Локальные веса: ${file}`
        : `Скачиваем ${file} с Hugging Face…`
    );
    const started = performance.now();
    const bytes = await fetchWithProgress(resolved.url, (loaded, total) => {
      onProgress({ phase: 'download', loaded, total, file });
    }, file);
    const seconds = (performance.now() - started) / 1000;

    const candidates = [];
    if (requested === 'webgpu' || requested === 'auto') candidates.push('webgpu');
    candidates.push('wasm');

    let lastError = null;
    for (const backend of candidates) {
      if (backend === 'webgpu' && typeof navigator !== 'undefined' && !navigator.gpu) {
        continue;
      }
      try {
        onStatus(
          backend === 'webgpu'
            ? 'Готовим сессию WebGPU…'
            : 'Готовим сессию WASM (CPU)…'
        );
        onProgress({ phase: 'init', loaded: 0, total: 0, file });
        const session = await ort.InferenceSession.create(bytes, {
          executionProviders: [backend],
          graphOptimizationLevel: 'all',
        });
        return new Engine(session, ort, backend, {
          file,
          source: resolved.source,
          bytes: bytes.byteLength,
          seconds,
          precision,
        });
      } catch (error) {
        lastError = error;
        console.warn('Backend ' + backend + ' недоступен:', error);
      }
    }
    throw new Error(
      'Не удалось запустить модель в этом браузере. ' +
        (lastError ? lastError.message : 'Попробуйте Chrome или Edge последней версии.')
    );
  }

  async score(ids) {
    const size = ids.length + 2;
    const input = new BigInt64Array(size);
    input[0] = BigInt(CONFIG.clsId);
    for (let i = 0; i < ids.length; i++) input[i + 1] = BigInt(ids[i]);
    input[size - 1] = BigInt(CONFIG.sepId);
    const mask = new BigInt64Array(size).fill(1n);
    const feeds = {};
    feeds[this.inputIdsName] = new this.ort.Tensor('int64', input, [1, size]);
    feeds[this.attentionName] = new this.ort.Tensor('int64', mask, [1, size]);
    try {
      const output = await this.session.run(feeds);
      const logits = output[this.outputName].data;
      return softmaxAi(logits, this.aiIndex);
    } catch (error) {
      if (this.backend === 'wasm' || this._degraded) throw error;
      // WebGPU может не поддержать int64 — один раз пересобираем сессию на WASM.
      console.warn('WebGPU не справился, переключаемся на WASM:', error);
      this._degraded = true;
      throw new Error('WEBGPU_FALLBACK');
    }
  }

  async dispose() {
    try {
      await this.session.release?.();
    } catch (error) {
      /* ignore */
    }
  }
}

function softmaxAi(logits, index) {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
  let sum = 0;
  for (let i = 0; i < logits.length; i++) sum += Math.exp(logits[i] - max);
  return Math.exp(logits[index] - max) / sum;
}
