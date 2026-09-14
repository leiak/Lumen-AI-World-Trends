import type { SourceConfig } from './types.js';

export const REAL_SOURCES: SourceConfig[] = [
  {
    id: 'bbc-world',
    name: 'BBC World',
    lang: 'en',
    kind: 'rss',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml'
  },
  {
    id: 'guardian-world',
    name: 'The Guardian World',
    lang: 'en',
    kind: 'rss',
    url: 'https://www.theguardian.com/world/rss'
  },
  {
    id: 'nyt-world',
    name: 'NYT World',
    lang: 'en',
    kind: 'rss',
    url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml'
  }
];
