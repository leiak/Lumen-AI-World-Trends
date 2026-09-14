import type { Database } from 'sql.js';
import type { SourceArticle } from '../../../shared/models.js';
import { createGazetteer, type Gazetteer, type GazetteerEntry } from '../extract/gazetteer.js';
import { clusterArticles } from './cluster.js';
import { buildCooccurrenceEdges } from './relation.js';
import {
  saveEntities, saveEvents, mergeEdges, loadArticles
} from './repository.js';

export interface GraphBuildResult {
  articles: number;
  entities: number;
  events: number;
  edges: number;
}

const DEFAULT_ENTRIES: GazetteerEntry[] = [
  { name: 'China', type: 'country', lang: 'en' },
  { name: 'United States', type: 'country', lang: 'en' },
  { name: 'US', nameEn: 'United States', type: 'country', lang: 'en' },
  { name: 'Russia', type: 'country', lang: 'en' },
  { name: 'Ukraine', type: 'country', lang: 'en' },
  { name: 'European Union', type: 'organization', lang: 'en' },
  { name: 'United Nations', type: 'organization', lang: 'en' },
  { name: '中国', type: 'country', lang: 'zh' },
  { name: '美国', type: 'country', lang: 'zh' },
  { name: '俄罗斯', type: 'country', lang: 'zh' },
  { name: '乌克兰', type: 'country', lang: 'zh' },
  { name: '欧盟', type: 'organization', lang: 'zh' },
  { name: '联合国', type: 'organization', lang: 'zh' }
];

export function defaultGazetteer(): Gazetteer {
  return createGazetteer(DEFAULT_ENTRIES);
}

export async function buildGraph(
  db: Database,
  articles: SourceArticle[],
  gazetteer: Gazetteer
): Promise<GraphBuildResult> {
  const items = articles.map((article) => ({
    article,
    entities: gazetteer.match(`${article.title} ${article.content ?? ''}`)
  }));

  const bundles = clusterArticles(items);

  const allEntities = items.flatMap((i) => i.entities);
  const entities = saveEntities(db, allEntities);

  const events = saveEvents(db, bundles);

  const edges: ReturnType<typeof buildCooccurrenceEdges> = [];
  for (const it of items) {
    edges.push(...buildCooccurrenceEdges(it.article, it.entities));
  }
  mergeEdges(db, edges);

  return { articles: articles.length, entities, events, edges: edges.length };
}

export async function buildGraphFromDb(
  db: Database,
  gazetteer: Gazetteer,
  limit = 200
): Promise<GraphBuildResult> {
  return buildGraph(db, loadArticles(db, limit), gazetteer);
}

