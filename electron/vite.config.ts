import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';

export default defineConfig({
  build: {
    outDir: '../dist-electron',
    rollupOptions: {
      external: ['electron', ...builtinModules]
    },
    lib: { entry: 'electron/main/index.ts', formats: ['es'] }
  }
});
