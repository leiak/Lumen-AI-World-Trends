import type { SourceArticle } from '../../../shared/models.js';

export type FieldKey =
  | 'title'
  | 'url'
  | 'content'
  | 'hotScore'
  | 'description'
  | 'publishedAt';

export type FieldsMap = Partial<Record<FieldKey, string>>;

export interface RssSourceConfig {
  id: string;
  name: string;
  lang: 'zh' | 'en';
  kind: 'rss';
  url: string;
}

export interface HtmlSourceConfig {
  id: string;
  name: string;
  lang: 'zh' | 'en';
  kind: 'html';
  url: string;
  itemSelector?: string;
  titleSelector?: string;
  linkSelector?: string;
  contentSelector?: string;
}

export interface JsonApiSourceConfig {
  id: string;
  name: string;
  lang: 'zh' | 'en';
  kind: 'json-api';
  url: string;             // SourceConfig 必填；json-api 不用，留空字符串
  apiUrl: string;
  fieldsMap: FieldsMap;
  dataPath?: string;
  headers?: Record<string, string>;
}

export interface BrowserSourceConfig {
  id: string;
  name: string;
  lang: 'zh' | 'en';
  kind: 'browser';
  url: string;             // 同上，留空
  browserUrl: string;
  browserWaitSelector?: string;
  browserWaitMs?: number;
  browserExtractScript: string;
  fieldsMap: FieldsMap;
}

export type SourceConfig =
  | RssSourceConfig
  | HtmlSourceConfig
  | JsonApiSourceConfig
  | BrowserSourceConfig;

export interface Collector {
  readonly config: SourceConfig;
  collect(): Promise<SourceArticle[]>;
}
