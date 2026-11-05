/**
 * Нормализация, нарезка на окна и подсчёт оценок.
 * Порт логики app.py (Detector.analyze) на JavaScript +
 * режим окон по предложениям (по умолчанию).
 */
import { CONFIG } from './config.js';
import { splitSentences, buildSentenceWindows, buildTokenWindows } from './sentences.js';

/**
 * Правила нормализации из model/inference.json (версия 1).
 * Замены записаны в синтаксисе JS: $1 вместо \1.
 */
export const NORMALIZE_RULES = [
  { pattern: '[\u200b\u200c\u200d\u200e\u200f\u2060\ufeff\u00ad]', replacement: '' },
  { pattern: '[\u00a0\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000\t\r\f\v]', replacement: ' ' },
  { pattern: '^[ ]*(?:```|~~~).*$', replacement: '' },
  { pattern: '^[ ]*(?:[-*_=][ ]*){3,}$', replacement: '' },
  { pattern: '^[ ]*\\|?(?:[ ]*:?-+:?[ ]*\\|)+[ ]*(?::?-+:?)?[ ]*$', replacement: '' },
  { pattern: '^[ ]*#{1,6}[ ]+', replacement: '' },
  { pattern: '^[ ]*(?:>[ ]?)+', replacement: '' },
  { pattern: '^[ ]*(?:[-*+\\u2022\\u00b7\\u25aa\\u25cf\\u25e6\\u2023\\u2013\\u2014]|\\d{1,3}[.)])[ ]+', replacement: '' },
  { pattern: '!\\[([^\\]\\n]*)\\]\\([^)\\n]*\\)', replacement: '$1' },
  { pattern: '\\[([^\\]\\n]+)\\]\\([^)\\n]*\\)', replacement: '$1' },
  { pattern: '</?[A-Za-z][A-Za-z0-9]*(?:\\s[^<>\\n]*)?/?>', replacement: ' ' },
  { pattern: '\\*+|~~|`+', replacement: '' },
  { pattern: '(?<![\\p{L}\\p{N}_])_+|_+(?![\\p{L}\\p{N}_])', replacement: '', unicode: true },
  { pattern: '\\|', replacement: ' ' },
  { pattern: '[\u00ab\u00bb\u201e\u201c\u201d\u201f\u2033]', replacement: '"' },
  { pattern: '[\u2018\u2019\u201a\u201b\u2032]', replacement: "'" },
  { pattern: '[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]', replacement: '-' },
  { pattern: '\u2026', replacement: '...' },
  { pattern: 'ё', replacement: 'е' },
  { pattern: 'Ё', replacement: 'Е' },
  { pattern: '\\s+', replacement: ' ' },
];

const COMPILED_RULES = NORMALIZE_RULES.map((rule) => ({
  regex: new RegExp(rule.pattern, rule.unicode ? 'gmu' : 'gm'),
  replacement: rule.replacement,
}));

export function normalizeText(text) {
  let value = text;
  for (const rule of COMPILED_RULES) {
    value = value.replace(rule.regex, rule.replacement);
  }
  return value;
}

const WORD_RE = /[\p{L}\p{N}_]+/gu;

export function countWords(text) {
  const matches = text.match(WORD_RE);
  return matches ? matches.length : 0;
}

export function countVisible(text) {
  let total = 0;
  for (const ch of text) if (!/\s/.test(ch)) total += 1;
  return total;
}

/**
 * Прежний режим: границы окон по токенам, как в app.py.
 * Оставлен для сравнения с Python-версией.
 */
export function splitWindows(text, offsets, windowTokens) {
  return buildTokenWindows(text, offsets.map((offset) => offset[0]), windowTokens);
}

export const NOTICE =
  'Экспериментальная оценка модели, не доказательство авторства. ' +
  'Процент — доля непробельных символов в подсвеченных окнах, а не установленная доля ИИ. ' +
  'Классификатор обучен на целых текстах; оценка коротких фрагментов менее надёжна и отдельно не валидирована.';

export const OFFSET_UNIT = 'UTF-16 code units JS; конец не включён';

export class Detector {
  /**
   * @param {import('./tokenizer.js').ByteLevelTokenizer} tokenizer
   * @param {{score: (ids: number[]) => Promise<number>}} engine
   */
  constructor(tokenizer, engine) {
    this.tokenizer = tokenizer;
    this.engine = engine;
    this.aiEnabled = true;
  }

  async scoreSegment(segment) {
    const normalized = normalizeText(segment).trim();
    if (!normalized) return null;
    const ids = this.tokenizer.encode(normalized).ids;
    if (!ids.length) return null;
    if (ids.length > CONFIG.maxSequence - 2) {
      throw new Error('Фрагмент превышает контекст модели.');
    }
    return this.engine.score(ids);
  }

  /**
   * @param {{text: string, threshold?: number,
   *          windowMode?: 'sentences'|'tokens',
   *          sentencesPerWindow?: number, windowTokens?: number, minWords?: number,
   *          onProgress?: (state: {done: number, total: number}) => void,
   *          signal?: AbortSignal}} options
   */
  async analyze(options) {
    const text = options.text;
    const threshold = options.threshold ?? CONFIG.threshold;
    const mode = options.windowMode === 'tokens' ? 'tokens' : 'sentences';
    const sentencesPerWindow = Math.floor(
      options.sentencesPerWindow ?? CONFIG.sentencesPerWindow
    );
    const windowTokens = Math.floor(options.windowTokens ?? CONFIG.windowTokens);
    const minWords = Math.floor(options.minWords ?? CONFIG.minWords);
    const onProgress = options.onProgress || (() => {});
    const signal = options.signal;

    if (!text || !text.trim()) throw new Error('Введите текст или загрузите файл.');
    if (text.length > CONFIG.maxChars) {
      throw new Error(`Лимит — ${CONFIG.maxChars.toLocaleString('ru-RU')} символов. Разделите работу на части.`);
    }
    if (!(threshold >= 0.01 && threshold <= 0.99)) {
      throw new Error('Порог должен быть от 0.01 до 0.99.');
    }
    if (!Number.isFinite(minWords) || minWords < 1 || minWords > 200) {
      throw new Error('Минимум слов должен быть от 1 до 200.');
    }
    if (mode === 'sentences') {
      if (!Number.isFinite(sentencesPerWindow) || sentencesPerWindow < 1 || sentencesPerWindow > 50) {
        throw new Error('Количество предложений на окно — от 1 до 50.');
      }
    } else if (!Number.isFinite(windowTokens) || windowTokens < 64 || windowTokens > 510) {
      throw new Error('Окно должно быть от 64 до 510 токенов.');
    }

    const encoding = this.tokenizer.encode(text);
    const tokenStarts = encoding.offsets.map((offset) => offset[0]);
    const windows =
      mode === 'sentences'
        ? buildSentenceWindows(text, splitSentences(text), tokenStarts, {
            sentencesPerWindow,
            maxTokens: CONFIG.maxWindowTokens,
          })
        : buildTokenWindows(text, tokenStarts, windowTokens);

    const spans = [];
    const total = windows.length;
    for (let index = 0; index < total; index++) {
      if (signal && signal.aborted) throw new DOMException('Отменено', 'AbortError');
      const window = windows[index];
      const segment = text.slice(window.start, window.end);
      const words = countWords(segment);
      let score = null;
      if (words >= minWords) {
        score = await this.scoreSegment(segment);
      }
      spans.push({
        start: window.start,
        end: window.end,
        sentences: window.sentences,
        split: window.split,
        words,
        score,
        flagged: score !== null && score >= threshold,
        status: score !== null ? 'scored' : 'insufficient_text',
      });
      onProgress({ done: index + 1, total });
    }

    const visible = countVisible(text);
    let flagged = 0;
    let assessed = 0;
    for (const span of spans) {
      const chunk = text.slice(span.start, span.end);
      const count = countVisible(chunk);
      if (span.flagged) flagged += count;
      if (span.score !== null) assessed += count;
    }
    const round2 = (value) => Math.round(value * 100) / 100;
    return {
      method:
        mode === 'sentences'
          ? `RuModernBERT ONNX, окна по ${sentencesPerWindow} предложениям (границы не рвут слова)`
          : 'RuModernBERT ONNX, непересекающиеся окна по исходному тексту',
      model: { repo: CONFIG.repo, revision: CONFIG.revision },
      threshold,
      window_mode: mode,
      sentences_per_window: mode === 'sentences' ? sentencesPerWindow : null,
      window_tokens: mode === 'sentences' ? CONFIG.maxWindowTokens : windowTokens,
      min_words: minWords,
      notice: NOTICE,
      offset_unit: OFFSET_UNIT,
      ai_enabled: this.aiEnabled,
      highlighted_share: visible ? round2((100 * flagged) / visible) : null,
      assessed_share: visible ? round2((100 * assessed) / visible) : 0,
      text,
      spans,
    };
  }
}

export { splitSentences };
