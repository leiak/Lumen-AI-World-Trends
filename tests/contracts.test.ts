import { describe, it, expect } from 'vitest';
import { ALL_CHANNELS, type Channel } from '../shared/contracts';

describe('IPC contract', () => {
  it('渠道表非空且唯一', () => {
    const set = new Set(ALL_CHANNELS);
    expect(set.size).toBe(ALL_CHANNELS.length);
    expect(ALL_CHANNELS.length).toBeGreaterThan(0);
  });

  it('含关键渠道', () => {
    expect(ALL_CHANNELS).toContain('engine:status');
    expect(ALL_CHANNELS).toContain('dashboard:today');
  });
});
