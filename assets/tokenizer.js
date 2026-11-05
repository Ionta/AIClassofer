/**
 * Pure-JS byte-level BPE tokenizer (без WASM и без внешних библиотек).
 *
 * Реализует ровно тот конвейер, что записан в model/tokenizer.json:
 *   нормализация NFC → added tokens → ByteLevel pre-tokenizer (GPT-2 regex) →
 *   BPE по merges. Возвращает id и смещения в единицах UTF-16 JS, чтобы
 *   подсветка совпадала с исходной строкой один-в-один.
 */

const PRE_TOKENIZE =
  /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

function buildByteMaps() {
  const bytes = [];
  for (let i = 33; i <= 126; i++) bytes.push(i);
  for (let i = 161; i <= 172; i++) bytes.push(i);
  for (let i = 174; i <= 255; i++) bytes.push(i);
  const codepoints = bytes.slice();
  let extra = 0;
  for (let b = 0; b < 256; b++) {
    if (!bytes.includes(b)) {
      bytes.push(b);
      codepoints.push(256 + extra);
      extra += 1;
    }
  }
  const byteToChar = new Array(256);
  for (let i = 0; i < bytes.length; i++) {
    byteToChar[bytes[i]] = String.fromCharCode(codepoints[i]);
  }
  return byteToChar;
}

const BYTE_TO_CHAR = buildByteMaps();
const ENCODER = new TextEncoder();

function utf8Length(cp) {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class ByteLevelTokenizer {
  /**
   * @param {object} spec содержимое tokenizer.json
   */
  constructor(spec) {
    if (!spec || !spec.model || spec.model.type !== 'BPE') {
      throw new Error('Ожидается tokenizer.json с моделью BPE.');
    }
    this.vocab = new Map(Object.entries(spec.model.vocab));
    this.ranks = new Map();
    const merges = spec.model.merges || [];
    for (let i = 0; i < merges.length; i++) {
      const pair = merges[i];
      const key = Array.isArray(pair) ? `${pair[0]} ${pair[1]}` : pair;
      if (!this.ranks.has(key)) this.ranks.set(key, i);
    }
    this.unkId =
      spec.model.unk_token != null && this.vocab.has(spec.model.unk_token)
        ? this.vocab.get(spec.model.unk_token)
        : null;
    this.cache = new Map();
    this.cacheLimit = 60000;
    this.added = new Map();
    this.lstrip = new Set();
    this.rstrip = new Set();
    const patterns = [];
    for (const token of spec.added_tokens || []) {
      if (!token || typeof token.content !== 'string' || !token.content) continue;
      this.added.set(token.content, token.id);
      if (token.lstrip) this.lstrip.add(token.content);
      if (token.rstrip) this.rstrip.add(token.content);
      let pattern = escapeRegExp(token.content);
      if (token.single_word) {
        pattern = `(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`;
      }
      patterns.push({ pattern, length: token.content.length });
    }
    patterns.sort((a, b) => b.length - a.length);
    this.addedRe = patterns.length
      ? new RegExp(patterns.map((p) => p.pattern).join('|'), 'gu')
      : null;
  }

  static fromJSON(spec) {
    return new ByteLevelTokenizer(spec);
  }

  /** Число токенов без спецтокенов (быстрая проверка лимита). */
  count(text) {
    return this.encode(text).ids.length;
  }

  /**
   * @param {string} text
   * @returns {{ids: number[], tokens: string[], offsets: Array<[number, number]>}}
   */
  encode(text) {
    const ids = [];
    const tokens = [];
    const offsets = [];
    let last = 0;
    if (this.addedRe && text.length) {
      this.addedRe.lastIndex = 0;
      let match;
      while ((match = this.addedRe.exec(text)) !== null) {
        const value = match[0];
        if (!value) {
          this.addedRe.lastIndex += 1;
          continue;
        }
        const id = this.added.get(value);
        if (id === undefined) {
          // Совпадение по «одиночному слову» без токена в словаре — не должно случаться.
          this.addedRe.lastIndex = match.index + value.length;
          continue;
        }
        let start = match.index;
        let end = start + value.length;
        if (this.lstrip.has(value)) {
          while (start > last && /\s/.test(text[start - 1])) start -= 1;
        }
        if (this.rstrip.has(value)) {
          while (end < text.length && /\s/.test(text[end])) end += 1;
        }
        if (start > last) this._encodeSegment(text.slice(last, start), last, ids, tokens, offsets);
        ids.push(id);
        tokens.push(value);
        offsets.push([start, end]);
        last = end;
      }
    }
    if (last < text.length) this._encodeSegment(text.slice(last), last, ids, tokens, offsets);
    return { ids, tokens, offsets };
  }

  /** Текст + [CLS] / [SEP] — так его видит классификатор. */
  encodeForClassifier(text) {
    return this.encode(text).ids;
  }

  _encodeSegment(segment, base, ids, tokens, offsets) {
    if (!segment) return;
    PRE_TOKENIZE.lastIndex = 0;
    let match;
    while ((match = PRE_TOKENIZE.exec(segment)) !== null) {
      const piece = match[0];
      if (!piece) {
        PRE_TOKENIZE.lastIndex += 1;
        continue;
      }
      this._encodePiece(piece, base + match.index, ids, tokens, offsets);
    }
  }

  _encodePiece(piece, start, ids, tokens, offsets) {
    const cached = this.cache.get(piece);
    if (cached) {
      let consumed = 0;
      for (let i = 0; i < cached.length; i++) {
        const item = cached[i];
        ids.push(item.id);
        tokens.push(item.token);
        offsets.push([start + consumed, start + consumed + item.units]);
        consumed += item.units;
      }
      return;
    }

    // UTF-8 байты → «безопасные» Unicode-символы (byte-level mapping GPT-2).
    const bytes = ENCODER.encode(piece);
    let escaped = '';
    for (let i = 0; i < bytes.length; i++) escaped += BYTE_TO_CHAR[bytes[i]];
    const words = this._bpe(escaped);

    // Байтовое смещение → индекс в UTF-16 исходной строки.
    const byteToUnit = new Uint32Array(bytes.length + 1);
    let bytePos = 0;
    let unitPos = 0;
    for (let i = 0; i < piece.length; ) {
      const cp = piece.codePointAt(i);
      const width = cp > 0xffff ? 2 : 1;
      const length = utf8Length(cp);
      for (let k = 0; k < length; k++) byteToUnit[bytePos + k] = unitPos;
      bytePos += length;
      unitPos += width;
      i += width;
    }
    byteToUnit[bytes.length] = unitPos;

    const entry = [];
    let consumed = 0;
    for (const word of words) {
      const id = this.vocab.get(word);
      const value = id === undefined ? this.unkId : id;
      if (value === null || value === undefined) {
        throw new Error('Токен отсутствует в словаре: ' + JSON.stringify(word));
      }
      const units = byteToUnit[consumed + word.length] - byteToUnit[consumed];
      ids.push(value);
      tokens.push(word);
      offsets.push([start + byteToUnit[consumed], start + byteToUnit[consumed + word.length]]);
      entry.push({ id: value, token: word, units });
      consumed += word.length;
    }
    if (this.cache.size >= this.cacheLimit) this.cache.clear();
    this.cache.set(piece, entry);
  }

  _bpe(token) {
    if (token.length <= 1) return [token];
    let word = token.split('');
    for (;;) {
      let bestRank = Infinity;
      let bestIndex = -1;
      for (let i = 0; i < word.length - 1; i++) {
        const rank = this.ranks.get(word[i] + ' ' + word[i + 1]);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestIndex = i;
        }
      }
      if (bestIndex < 0) break;
      const merged = word[bestIndex] + word[bestIndex + 1];
      const next = [];
      for (let i = 0; i < word.length; i++) {
        if (i === bestIndex) {
          next.push(merged);
          i += 1;
        } else {
          next.push(word[i]);
        }
      }
      word = next;
      if (word.length === 1) break;
    }
    return word;
  }
}

export default ByteLevelTokenizer;
