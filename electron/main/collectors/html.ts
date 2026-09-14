import * as cheerio from 'cheerio';
import axios from 'axios';
import { normalizeArticle } from './ids.js';
import type { Collector, SourceConfig } from './types.js';

type LoadHtml = (url: string) => Promise<string>;
const defaultLoadHtml: LoadHtml = async (url) => (await axios.get<string>(url)).data;

export function createHtmlCollector(
  config: SourceConfig,
  loadHtml: LoadHtml = defaultLoadHtml
): Collector {
  return {
    config,
    async collect() {
      if (!config.itemSelector) throw new Error('itemSelector required');
      const html = await loadHtml(config.url);
      const $ = cheerio.load(html);
      const arts: ReturnType<typeof normalizeArticle>[] = [];
      $(config.itemSelector).each((_, el) => {
        const $item = $(el);
        const title = config.titleSelector
          ? $item.find(config.titleSelector).text().trim()
          : '';
        const relHref = config.linkSelector
          ? $item.find(config.linkSelector).attr('href')
          : undefined;
        const content = config.contentSelector
          ? $item.find(config.contentSelector).text().trim()
          : undefined;
        if (!title || !relHref) return;
        arts.push(
          normalizeArticle(config, {
            title,
            url: new URL(relHref, config.url).toString(),
            content
          })
        );
      });
      return arts;
    }
  };
}
