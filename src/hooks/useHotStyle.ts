import { useEffect, useState } from 'react';
import type { HotStyle } from '../components/HotBadge';

const KEY = 'lumen.hotStyle';
const DEFAULT: HotStyle = 'B';

function read(): HotStyle {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (v === 'A' || v === 'B' || v === 'C' || v === 'D') return v;
  } catch {
    // SSR / 测试环境 localStorage 不可用
  }
  return DEFAULT;
}

export function useHotStyle(): [HotStyle, (s: HotStyle) => void] {
  const [style, setStyle] = useState<HotStyle>(read);
  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, style);
    } catch {
      // ignore
    }
  }, [style]);
  return [style, setStyle];
}