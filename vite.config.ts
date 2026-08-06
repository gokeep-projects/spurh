import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  define: {
    // 窗口标题里的构建日期，随每次构建自动更新（替代硬编码 dev-YYYYMMDD）
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: ['es2021', 'chrome105', 'safari13'],
    sourcemap: false,
    rollupOptions: {
      output: {
        // icons.ts 被主界面与多个懒加载面板共享:固定为独立 chunk,保持主包体积
        manualChunks(id) {
          if (id.includes('/src/lib/icons.ts')) return 'icons';
        },
      },
    },
  },
});
