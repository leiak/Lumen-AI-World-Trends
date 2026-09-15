export interface StockWatchItem {
  symbol: string;
  name: string;
  market: 'cn-index' | 'cn' | 'hk' | 'us';
}

export const DEFAULT_WATCHLIST: StockWatchItem[] = [
  { symbol: 'sh000001', name: '上证指数', market: 'cn-index' },
  { symbol: 'sh000300', name: '沪深300', market: 'cn-index' },
  { symbol: 'sz399001', name: '深证成指', market: 'cn-index' },
  { symbol: 'sz399006', name: '创业板指', market: 'cn-index' },
  { symbol: 'hkHSI', name: '恒生指数', market: 'cn-index' },
  { symbol: 'hkHSCEI', name: '国企指数', market: 'cn-index' },
  { symbol: 'usDJI', name: '道琼斯', market: 'cn-index' },
  { symbol: 'usIXIC', name: '纳斯达克', market: 'cn-index' },
  { symbol: 'usINX', name: '标普500', market: 'cn-index' },
  { symbol: 'sh600519', name: '贵州茅台', market: 'cn' },
  { symbol: 'sz300750', name: '宁德时代', market: 'cn' },
  { symbol: 'sz002594', name: '比亚迪', market: 'cn' },
  { symbol: 'sh601318', name: '中国平安', market: 'cn' },
  { symbol: 'sh600036', name: '招商银行', market: 'cn' },
  { symbol: 'sz000333', name: '美的集团', market: 'cn' },
  { symbol: 'sh601899', name: '紫金矿业', market: 'cn' },
  { symbol: 'sh600030', name: '中信证券', market: 'cn' },
  { symbol: 'sz000858', name: '五粮液', market: 'cn' },
  { symbol: 'sh688981', name: '中芯国际', market: 'cn' },
  { symbol: 'hk00700', name: '腾讯控股', market: 'hk' },
  { symbol: 'hk09988', name: '阿里巴巴', market: 'hk' },
  { symbol: 'hk03690', name: '美团', market: 'hk' },
  { symbol: 'hk01810', name: '小米集团', market: 'hk' },
  { symbol: 'hk00941', name: '中国移动', market: 'hk' },
  { symbol: 'hk02318', name: '中国平安', market: 'hk' },
  { symbol: 'usAAPL', name: '苹果', market: 'us' },
  { symbol: 'usMSFT', name: '微软', market: 'us' },
  { symbol: 'usNVDA', name: '英伟达', market: 'us' },
  { symbol: 'usGOOG', name: '谷歌', market: 'us' },
  { symbol: 'usTSLA', name: '特斯拉', market: 'us' },
  { symbol: 'usAMZN', name: '亚马逊', market: 'us' },
  { symbol: 'usMETA', name: 'Meta', market: 'us' },
  { symbol: 'usBABA', name: '阿里巴巴', market: 'us' }
];
