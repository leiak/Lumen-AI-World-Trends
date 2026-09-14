import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const outDir = fileURLToPath(new URL('../dist-electron', import.meta.url));

export default defineConfig({
  build: {
    ssr: 'electron/main/index.ts',
    outDir,
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      external: ['electron', ...builtinModules]
    }
  }
});
