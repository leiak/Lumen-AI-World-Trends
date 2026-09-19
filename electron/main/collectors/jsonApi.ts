import axios from 'axios';
import { normalizeArticle } from './ids.js';
import type { Collector, JsonApiSourceConfig } from './types.js';
import type { SourceArticle } from '../../../shared/models.js';

type LoadJson = (url: string, headers?: Record<string, string>) => Promise<unknown>;

const defaultLoadJson: LoadJson = async (url, headers) =>
  (await axios.get(url, { headers, timeout: 15000 })).data;

/** 极简两层 dot path：'a' / 'a.b' / 'a[0].b' / 'a[0].b.c' / '[0].b'
 *  不实现完整 JSONPath；不支持 '[]' 数组迭代占位。 */
export function pluck(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;
  // 分词：'info[0].word' → ['info', '[0]', 'word']
  const tokens: string[] = [];
  let cur = '';
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === '.' || ch === '[') {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
      if (ch === '[') {
        const end = path.indexOf(']', i);
        if (end < 0) return undefined;
        tokens.push(path.slice(i, end + 1));
        i = end;
      }
    } else if (ch === ']') {
      // 已由 '[' 处理
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);

  let v: unknown = obj;
  for (const t of tokens) {
    if (v == null) return undefined;
    const m = t.match(/^\[(\d+)\]$/);
    if (m) {
      v = Array.isArray(v) ? v[Number(m[1])] : undefined;
    } else {
      v = (v as Record<string, unknown>)[t];
    }
  }
  return v;
}

/** dataPath：单层 dot path 走到数组根；缺省视为整体 */
export function getByPath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function createJsonApiCollector(
  config: JsonApiSourceConfig,
  loadJson: LoadJson = defaultLoadJson
): Collector {
  return {
    config,
    async collect(): Promise<SourceArticle[]> {
      if (!config.apiUrl) throw new Error('apiUrl required');
      if (!config.fieldsMap.title || !config.fieldsMap.url) {
        throw new Error('fieldsMap.title and url required');
      }
      const raw = await loadJson(config.apiUrl, config.headers);
      const arr = config.dataPath ? getByPath(raw, config.dataPath) : raw;
      if (!Array.isArray(arr)) return [];
      const out: SourceArticle[] = [];
      for (const item of arr) {
        const title = pluck(item, config.fieldsMap.title);
        const url = pluck(item, config.fieldsMap.url);
        if (!title || !url) continue;
        // json-api uses fieldsMap.content (full body); description reserved for future use
        const article = normalizeArticle(
          config,
          {
            title: String(title),
            url: String(url),
            content: config.fieldsMap.content
              ? (pluck(item, config.fieldsMap.content) as string | undefined)
              : undefined,
            publishedAt: config.fieldsMap.publishedAt
              ? (pluck(item, config.fieldsMap.publishedAt) as string | undefined)
              : undefined
          }
        );
        article.hotScore = numOrNull(
          config.fieldsMap.hotScore
            ? pluck(item, config.fieldsMap.hotScore)
            : undefined
        );
        out.push(article);
      }
      return out;
    }
  };
}
