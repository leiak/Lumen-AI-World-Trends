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
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        /**
         * P5-2：重依赖单独成块，配合按 Tab 懒加载。
         * zrender 是 echarts 的渲染底座，单独拆出可让两个块都低于 500 kB 警告线。
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('zrender')) return 'vendor-zrender';
          if (id.includes('echarts')) return 'vendor-echarts';
          if (id.includes('@xyflow')) return 'vendor-xyflow';
          if (id.includes('@langchain') || id.includes('langgraph')) return 'vendor-langgraph';
          return undefined;
        }
      }
    }
  }
});