import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function geojsonJson(): Plugin {
  return {
    name: 'geojson-as-json',
    transform(code, id) {
      if (id.endsWith('.geojson')) {
        return { code: `export default ${code};`, map: null };
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), geojsonJson()],
  server: { port: 5173 },
  base: './',
  build: { outDir: 'dist' }
});