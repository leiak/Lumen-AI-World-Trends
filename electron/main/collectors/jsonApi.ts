import axios from 'axios';
import { normalizeArticle } from './ids.js';
import type {
  Collector,
  FieldsMap,
  JsonApiSourceConfig
} from './types.js';
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

function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function createJsonApiCollector(
  cfg: JsonApiSourceConfig,
  loadJson: LoadJson = defaultLoadJson
): Collector {
  return {
    config: cfg,
    async collect(): Promise<SourceArticle[]> {
      if (!cfg.apiUrl) throw new Error('apiUrl required');
      if (!cfg.fieldsMap.title || !cfg.fieldsMap.url) {
        throw new Error('fieldsMap.title and url required');
      }
      const raw = await loadJson(cfg.apiUrl, cfg.headers);
      const arr = cfg.dataPath ? getByPath(raw, cfg.dataPath) : raw;
      if (!Array.isArray(arr)) return [];
      const out: SourceArticle[] = [];
      for (const item of arr) {
        const title = pluck(item, cfg.fieldsMap.title);
        const url = pluck(item, cfg.fieldsMap.url);
        if (!title || !url) continue;
        const article = normalizeArticle(
          cfg,
          {
            title: String(title),
            url: String(url),
            content: cfg.fieldsMap.content
              ? pluck(item, cfg.fieldsMap.content)
              : undefined,
            publishedAt: cfg.fieldsMap.publishedAt
              ? (pluck(item, cfg.fieldsMap.publishedAt) as string | undefined)
              : undefined
          }
        );
        article.hotScore = numOrNull(
          cfg.fieldsMap.hotScore
            ? pluck(item, cfg.fieldsMap.hotScore)
            : undefined
        );
        out.push(article);
      }
      return out;
    }
  };
}

// Suppress unused-import warning for FieldsMap type if tree-shaken later
export type { FieldsMap };
