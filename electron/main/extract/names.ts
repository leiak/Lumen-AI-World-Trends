import { createHash } from 'node:crypto';

export function entityId(name: string): string {
  return createHash('sha1').update(name.trim().toLowerCase()).digest('hex');
}
