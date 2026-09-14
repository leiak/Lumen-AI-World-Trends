import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { feature } from 'topojson-client';

const here = dirname(fileURLToPath(import.meta.url));
const topoPath = join(here, '..', 'node_modules', 'world-atlas', 'countries-110m.json');
const topo = JSON.parse(readFileSync(topoPath, 'utf8'));
const geo = feature(topo, topo.objects.countries);
const outPath = join(here, '..', 'resources', 'world.geojson');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(geo));
console.log('features:', geo.features.length);