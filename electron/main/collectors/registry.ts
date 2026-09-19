import type { SourceConfig } from './types.js';

export const REAL_SOURCES: SourceConfig[] = [
  // RSS 原 5 源（结构未变）
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
  },
  {
    id: '36kr',
    name: '36氪',
    lang: 'zh',
    kind: 'rss',
    url: 'https://36kr.com/feed'
  },
  {
    id: 'ithome',
    name: 'IT之家',
    lang: 'zh',
    kind: 'rss',
    url: 'https://www.ithome.com/rss/'
  },
  // 中文热点 6 源（json-api + browser）
  {
    id: 'weibo-hot',
    name: '微博热搜',
    lang: 'zh',
    kind: 'json-api',
    url: '',
    apiUrl: 'https://s.weibo.com/top/summary',
    headers: { Referer: 'https://s.weibo.com/' },
    fieldsMap: { title: 'word', url: 'url', hotScore: 'num' }
  },
  {
    id: 'zhihu-hot',
    name: '知乎热榜',
    lang: 'zh',
    kind: 'json-api',
    url: '',
    apiUrl:
      'https://api.zhihu.com/topstory/hot-lists/total?limit=50',
    fieldsMap: {
      title: 'target.title',
      url: 'target.url',
      hotScore: 'detail_text'
    }
  },
  {
    id: 'toutiao-hot',
    name: '今日头条热榜',
    lang: 'zh',
    kind: 'json-api',
    url: '',
    apiUrl:
      'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc',
    fieldsMap: { title: 'title', url: 'url', hotScore: 'hotValue' }
  },
  {
    id: 'bilibili-hot',
    name: 'B站热门',
    lang: 'zh',
    kind: 'json-api',
    url: '',
    apiUrl:
      'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',
    fieldsMap: { title: 'title', url: 'link', hotScore: 'stat.view' }
  },
  {
    id: 'baidu-hot',
    name: '百度热搜',
    lang: 'zh',
    kind: 'browser',
    url: '',
    browserUrl: 'https://top.baidu.com/board?platform=pc-task',
    browserWaitSelector: '.category-wrap_iQLoo',
    browserExtractScript: `
      const items = document.querySelectorAll('.category-wrap_iQLoo');
      return Array.from(items).map((it) => {
        const a = it.querySelector('.title-content_Yd290');
        const word = it.querySelector('.c-single-text-ellipsis');
        const num = it.querySelector('.hot-index_1Bl1a');
        return {
          title: word ? word.textContent.trim() : '',
          url: a ? a.href : '',
          hotScore: num ? Number(num.textContent.replace(/[^0-9]/g, '')) : null
        };
      });
    `,
    fieldsMap: { title: 'title', url: 'url', hotScore: 'hotScore' }
  },
  {
    id: 'douyin-hot',
    name: '抖音热门',
    lang: 'zh',
    kind: 'browser',
    url: '',
    browserUrl: 'https://www.douyin.com/hot',
    browserWaitSelector: '[data-e2e="hot-list-item"]',
    browserExtractScript: `
      const items = document.querySelectorAll('[data-e2e="hot-list-item"]');
      return Array.from(items).map((it) => {
        const t = it.querySelector('a');
        return {
          title: it.textContent.trim().slice(0, 60),
          url: t ? t.href : '',
          hotScore: null
        };
      });
    `,
    fieldsMap: { title: 'title', url: 'url', hotScore: 'hotScore' }
  }
];