/**
 * Разбиение текста на предложения и окна по предложениям.
 *
 * Окно — это целое число предложений подряд (по умолчанию 3), поэтому
 * подсветка не рвётся посреди слова или фразы. Если предложение само
 * длиннее лимита модели, оно режется по токенам, и это видно в отчёте.
 */

const MAX_CHARS = 200000;

/** Запасные границы предложений, если Intl.Segmenter недоступен. */
const FALLBACK = /[^.!?…\n]+(?:[.!?…]+[»"')]*)?/g;

/**
 * @param {string} text
 * @returns {Array<{start: number, end: number}>} предложения без хвостовых пробелов
 */
export function splitSentences(text) {
  const result = [];
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('ru', { granularity: 'sentence' });
    for (const part of segmenter.segment(text)) {
      const value = part.segment;
      const trimmed = value.replace(/\s+$/, '');
      if (!trimmed) continue;
      result.push({ start: part.index, end: part.index + trimmed.length });
    }
  } else {
    FALLBACK.lastIndex = 0;
    let match;
    while ((match = FALLBACK.exec(text)) !== null) {
      const value = match[0].replace(/\s+$/, '');
      if (!value) continue;
      result.push({ start: match.index, end: match.index + value.length });
    }
  }
  if (!result.length && text.length) result.push({ start: 0, end: text.length });
  return result;
}

/** Индекс первого элемента >= value (массив возрастает). */
function lowerBound(values, value) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function countTokens(starts, from, to) {
  return lowerBound(starts, to) - lowerBound(starts, from);
}

/** Режет слишком длинное предложение по границам токенов. */
function splitByTokens(starts, text, from, to, budget) {
  const first = lowerBound(starts, from);
  const last = lowerBound(starts, to);
  const total = last - first;
  if (total <= budget) return [{ start: from, end: to }];
  const pieces = [];
  let cursor = from;
  for (let index = first + budget; index < last; index += budget) {
    const boundary = starts[index];
    if (boundary > cursor && boundary < to) {
      pieces.push({ start: cursor, end: boundary });
      cursor = boundary;
    }
  }
  pieces.push({ start: cursor, end: to });
  return pieces;
}

/**
 * Группирует предложения в окна: не больше `sentencesPerWindow` предложений
 * и не больше `maxTokens` токенов на окно. Границы окон совпадают с началом
 * предложения, поэтому слова и фразы не разрываются.
 *
 * @param {string} text
 * @param {Array<{start: number, end: number}>} sentences
 * @param {number[]} tokenStarts отсортированные смещения начала токенов
 * @param {{sentencesPerWindow?: number, maxTokens?: number}} options
 * @returns {Array<{start: number, end: number, sentences: number, split: boolean}>}
 */
export function buildSentenceWindows(text, sentences, tokenStarts, options = {}) {
  const limit = Math.max(1, Math.floor(options.sentencesPerWindow || 3));
  const budget = Math.max(32, Math.floor(options.maxTokens || 500));
  const windows = [];
  let startIndex = 0;
  while (startIndex < sentences.length) {
    const start = startIndex === 0 ? 0 : sentences[startIndex].start;
    let endIndex = startIndex;
    while (endIndex < sentences.length && endIndex - startIndex < limit) {
      const candidate = endIndex + 1;
      const candidateEnd = sentences[candidate - 1].end;
      if (countTokens(tokenStarts, start, candidateEnd) > budget) break;
      endIndex = candidate;
    }
    if (endIndex === startIndex) {
      // Одно предложение длиннее лимита модели: режем по токенам.
      const end = sentences[startIndex].end;
      for (const piece of splitByTokens(tokenStarts, text, start, end, budget)) {
        windows.push({ ...piece, sentences: 1, split: true });
      }
      startIndex += 1;
      continue;
    }
    const end = sentences[endIndex - 1].end;
    windows.push({ start, end, sentences: endIndex - startIndex, split: false });
    startIndex = endIndex;
  }
  if (!windows.length) windows.push({ start: 0, end: text.length, sentences: 1, split: false });
  return windows;
}

/** Окна по токенам — прежний режим, оставлен для сравнения. */
export function buildTokenWindows(text, tokenStarts, windowTokens) {
  const starts = [0];
  for (let index = windowTokens; index < tokenStarts.length; index += windowTokens) {
    const at = tokenStarts[index];
    if (starts[starts.length - 1] < at && at < text.length) starts.push(at);
  }
  const bounds = starts.concat([text.length]);
  const windows = [];
  for (let index = 0; index < bounds.length - 1; index++) {
    windows.push({ start: bounds[index], end: bounds[index + 1], sentences: null, split: false });
  }
  return windows;
}

export { MAX_CHARS };
