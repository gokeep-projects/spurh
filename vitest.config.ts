import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ['svelte', 'browser', 'import', 'module'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['@testing-library/svelte/vitest'],
  },
});
