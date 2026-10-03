import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  base: '/ai-town/',
  plugins: [react()],
  // NEXUS: the built world is served by NEXUS itself at /ai-town/.
  build: { outDir: '../public/ai-town', emptyOutDir: true },
  server: {
    allowedHosts: ['ai-town-your-app-name.fly.dev', 'localhost', '127.0.0.1'],
  },
});
