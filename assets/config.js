/**
 * Настройки статичной версии AI Text Lab.
 * Менять здесь: откуда брать веса и какое окно/порог использовать по умолчанию.
 */

export const CONFIG = {
  // Закреплённая ревизия модели (та же, что в download_model.py).
  repo: 'toiletsandpaper/russian-ai-text-detector-modernbert',
  revision: '00141fe7ab18291ef0c4ab75bc00c0797e590a8b',
  hfHost: 'https://huggingface.co',
  files: {
    tokenizer: 'tokenizer.json',
    fp32: 'model.onnx',
    int8: 'model_int8.onnx',
  },
  /**
   * Локальная копия весов. Если положить model/ рядом с index.html,
   * браузер возьмёт файлы оттуда и не будет обращаться к Hugging Face.
   * Для GitHub Pages подходит model_int8.onnx (36 МБ < лимита 100 МБ).
   */
  localPath: 'model/',
  checkLocalFirst: true,

  // onnxruntime-web с CDN. Версия закреплена, чтобы поведение не менялось.
  ortVersion: '1.23.0',
  ortBase: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/',

  // Параметры анализа по умолчанию (как в Python-версии).
  threshold: 0.8,
  windowTokens: 384,
  maxChars: 200000,
  maxFileBytes: 10 * 1024 * 1024,
  minWordsPerWindow: 20,

  // Ограничения модели: 512 позиций, из них 2 служебных токена.
  maxSequence: 512,
  clsId: 50281,
  sepId: 50282,
  labels: ['human', 'ai'],

  defaults: {
    precision: 'int8',
    backend: 'auto',
  },
};

export const MODEL_INFO = {
  repo: CONFIG.repo,
  revision: CONFIG.revision,
  license: 'Apache-2.0',
  url: 'https://huggingface.co/' + CONFIG.repo,
};
