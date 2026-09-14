import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist-electron', 'preload'), { recursive: true });
cpSync(
  join(root, 'electron', 'preload', 'index.cjs'),
  join(root, 'dist-electron', 'preload', 'index.cjs')
);
console.log('preload copied');
