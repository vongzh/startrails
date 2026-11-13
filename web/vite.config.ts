import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // 单页管理台，组件库整包约 530KB；拆包后仍有单块超限，放宽阈值避免噪音。
    chunkSizeWarningLimit: 700,
    // 组件库与图标拆成独立 chunk，应用代码变更不影响其缓存。
    rollupOptions: {
      output: {
        manualChunks: (id: string) => {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('naive-ui') || id.includes('css-render') || id.includes('seemly')) return 'vendor';
          if (id.includes('lucide')) return 'vendor-icons';
          if (id.includes('vue')) return 'vendor';
          return undefined;
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/s': 'http://127.0.0.1:8787',
    },
  },
});
