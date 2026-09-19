import { describe, it, expect } from 'vitest';
import { formatCompact } from '../src/components/HotBadge';

describe('formatCompact', () => {
  it('formats >=1e8 as 亿', () => {
    expect(formatCompact(123_000_000)).toBe('1.2 亿');
    expect(formatCompact(1_500_000_000)).toBe('15.0 亿');
  });
  it('formats >=1e4 as 万', () => {
    expect(formatCompact(12_500)).toBe('1.3 万');
    expect(formatCompact(3_420_000)).toBe('342.0 万');
  });
  it('formats <1e4 raw', () => {
    expect(formatCompact(999)).toBe('999');
    expect(formatCompact(0)).toBe('0');
  });
});