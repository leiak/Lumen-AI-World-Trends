import Parser from 'rss-parser';
import axios from 'axios';
import { normalizeArticle } from './ids.js';
import type { Collector, SourceConfig } from './types.js';

type LoadXml = (url: string) => Promise<string>;

const defaultLoadXml: LoadXml = async (url) => (await axios.get<string>(url)).data;

export function createRssCollector(
  config: SourceConfig,
  loadXml: LoadXml = defaultLoadXml
): Collector {
  return {
    config,
    async collect() {
      const xml = await loadXml(config.url);
      const parser = new Parser();
      const feed = await parser.parseString(xml);
      return (feed.items ?? [])
        .filter((i) => i.title && i.link)
        .map((i) =>
          normalizeArticle(config, {
            title: i.title!,
            url: i.link!,
            content: i.content ?? i.contentSnippet,
            publishedAt: i.isoDate ?? i.pubDate
          })
        );
    }
  };
}
