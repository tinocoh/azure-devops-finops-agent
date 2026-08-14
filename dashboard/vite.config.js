import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: 'dist',
    // Charts are the largest dependency; splitting keeps the initial paint fast on a
    // cold demo machine.
    rollupOptions: {
      output: {
        manualChunks: { echarts: ['echarts'] },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.KPI_SERVER ?? 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
});
