import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.INVENTORY_API_URL ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': apiTarget },  // aynı origin: backend'de CORS gerekmez
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    proxy: { '/api': apiTarget },
  },
});
