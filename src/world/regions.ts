import { normalizeCountry } from './geo';

export type RegionKey =
  | 'asia'
  | 'europe'
  | 'north-america'
  | 'latin-america'
  | 'middle-east'
  | 'africa'
  | 'oceania'
  | 'other';

export const REGION_KEYS: RegionKey[] = [
  'asia',
  'europe',
  'north-america',
  'latin-america',
  'middle-east',
  'africa',
  'oceania',
  'other'
];

// 键与 resources/world.geojson 的 properties.name 完全一致（别名先经 normalizeCountry 归一）
const REGION_BY_COUNTRY: Record<string, RegionKey> = {
  // 亚洲
  China: 'asia',
  India: 'asia',
  Japan: 'asia',
  'South Korea': 'asia',
  'North Korea': 'asia',
  Taiwan: 'asia',
  Mongolia: 'asia',
  Vietnam: 'asia',
  Thailand: 'asia',
  Myanmar: 'asia',
  Cambodia: 'asia',
  Laos: 'asia',
  Philippines: 'asia',
  Indonesia: 'asia',
  Bangladesh: 'asia',
  Pakistan: 'asia',
  Nepal: 'asia',
  'Sri Lanka': 'asia',
  Afghanistan: 'asia',
  Kazakhstan: 'asia',
  Uzbekistan: 'asia',
  Turkmenistan: 'asia',
  Kyrgyzstan: 'asia',
  Tajikistan: 'asia',
  Bhutan: 'asia',
  Brunei: 'asia',
  'Timor-Leste': 'asia',
  Azerbaijan: 'asia',
  Georgia: 'asia',
  Armenia: 'asia',
  // 欧洲
  Russia: 'europe',
  'United Kingdom': 'europe',
  France: 'europe',
  Germany: 'europe',
  Italy: 'europe',
  Spain: 'europe',
  Portugal: 'europe',
  Netherlands: 'europe',
  Belgium: 'europe',
  Luxembourg: 'europe',
  Switzerland: 'europe',
  Austria: 'europe',
  Sweden: 'europe',
  Norway: 'europe',
  Denmark: 'europe',
  Finland: 'europe',
  Iceland: 'europe',
  Poland: 'europe',
  Ukraine: 'europe',
  Czechia: 'europe',
  Slovakia: 'europe',
  Hungary: 'europe',
  Romania: 'europe',
  Bulgaria: 'europe',
  Greece: 'europe',
  Ireland: 'europe',
  Croatia: 'europe',
  Serbia: 'europe',
  Slovenia: 'europe',
  Belarus: 'europe',
  Lithuania: 'europe',
  Latvia: 'europe',
  Estonia: 'europe',
  'Bosnia and Herz.': 'europe',
  Macedonia: 'europe',
  Montenegro: 'europe',
  Kosovo: 'europe',
  Albania: 'europe',
  Moldova: 'europe',
  Cyprus: 'europe',
  'N. Cyprus': 'europe',
  // 北美
  'United States of America': 'north-america',
  Canada: 'north-america',
  Mexico: 'north-america',
  Greenland: 'north-america',
  // 拉美
  Brazil: 'latin-america',
  Argentina: 'latin-america',
  Chile: 'latin-america',
  Peru: 'latin-america',
  Colombia: 'latin-america',
  Venezuela: 'latin-america',
  Ecuador: 'latin-america',
  Bolivia: 'latin-america',
  Paraguay: 'latin-america',
  Uruguay: 'latin-america',
  Cuba: 'latin-america',
  'Dominican Rep.': 'latin-america',
  Haiti: 'latin-america',
  Guatemala: 'latin-america',
  Honduras: 'latin-america',
  Nicaragua: 'latin-america',
  'El Salvador': 'latin-america',
  'Costa Rica': 'latin-america',
  Panama: 'latin-america',
  Jamaica: 'latin-america',
  'Puerto Rico': 'latin-america',
  'Trinidad and Tobago': 'latin-america',
  Bahamas: 'latin-america',
  Belize: 'latin-america',
  Guyana: 'latin-america',
  Suriname: 'latin-america',
  'Falkland Is.': 'latin-america',
  // 中东
  Turkey: 'middle-east',
  Iran: 'middle-east',
  Iraq: 'middle-east',
  Syria: 'middle-east',
  Lebanon: 'middle-east',
  Israel: 'middle-east',
  Palestine: 'middle-east',
  Jordan: 'middle-east',
  'Saudi Arabia': 'middle-east',
  'United Arab Emirates': 'middle-east',
  Qatar: 'middle-east',
  Kuwait: 'middle-east',
  Oman: 'middle-east',
  Yemen: 'middle-east',
  // 非洲
  Morocco: 'africa',
  Algeria: 'africa',
  Tunisia: 'africa',
  Libya: 'africa',
  Egypt: 'africa',
  Sudan: 'africa',
  'S. Sudan': 'africa',
  'South Africa': 'africa',
  Nigeria: 'africa',
  Ghana: 'africa',
  Kenya: 'africa',
  Ethiopia: 'africa',
  Somalia: 'africa',
  'Dem. Rep. Congo': 'africa',
  Congo: 'africa',
  Angola: 'africa',
  Mozambique: 'africa',
  Zambia: 'africa',
  Zimbabwe: 'africa',
  Botswana: 'africa',
  Namibia: 'africa',
  Madagascar: 'africa',
  Uganda: 'africa',
  Tanzania: 'africa',
  Rwanda: 'africa',
  Burundi: 'africa',
  Senegal: 'africa',
  Mali: 'africa',
  Niger: 'africa',
  Chad: 'africa',
  Cameroon: 'africa',
  "Côte d'Ivoire": 'africa',
  Guinea: 'africa',
  'Sierra Leone': 'africa',
  Liberia: 'africa',
  'Burkina Faso': 'africa',
  'Central African Rep.': 'africa',
  Gabon: 'africa',
  'Eq. Guinea': 'africa',
  Malawi: 'africa',
  eSwatini: 'africa',
  Lesotho: 'africa',
  Mauritania: 'africa',
  Benin: 'africa',
  Togo: 'africa',
  'Guinea-Bissau': 'africa',
  Gambia: 'africa',
  Eritrea: 'africa',
  Djibouti: 'africa',
  Somaliland: 'africa',
  'W. Sahara': 'africa',
  // 大洋洲
  Australia: 'oceania',
  'New Zealand': 'oceania',
  Fiji: 'oceania',
  'Papua New Guinea': 'oceania',
  'Solomon Is.': 'oceania',
  Vanuatu: 'oceania',
  'New Caledonia': 'oceania',
  // 其他
  Antarctica: 'other',
  'Fr. S. Antarctic Lands': 'other'
};

export function regionOfCountry(canonicalName: string): RegionKey {
  return REGION_BY_COUNTRY[canonicalName] ?? 'other';
}

export interface RegionHeat {
  key: RegionKey;
  count: number;
}

export function aggregateRegions(items: { name: string; count: number }[]): RegionHeat[] {
  const totals = new Map<RegionKey, number>();
  for (const c of items) {
    const canonical = normalizeCountry(c.name);
    if (!canonical) continue;
    const key = regionOfCountry(canonical);
    totals.set(key, (totals.get(key) ?? 0) + c.count);
  }
  return REGION_KEYS.filter((key) => (totals.get(key) ?? 0) > 0)
    .map((key) => ({ key, count: totals.get(key) ?? 0 }))
    .sort((a, b) => b.count - a.count);
}
