import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'path';

/**
 * Dev/preview proxy so the sync API is reached **same-origin** while testing
 * locally. That matters for more than CORS: the API session is a
 * `SameSite=Lax` cookie, and a cross-site request (localhost -> *.workers.dev)
 * would never send it. Proxying `/api` keeps the cookie first-party.
 *
 * Set these in `apps/web/.env.local` (git-ignored):
 *   VITE_SYNC_PROXY_TARGET=https://<worker>.<account>.workers.dev
 *   VITE_SYNC_API_BASE=/api
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_SYNC_PROXY_TARGET;
  const proxy = target
    ? {
        '/api': {
          target,
          changeOrigin: true,
          // Strip the local prefix: /api/sync -> <worker>/sync
          rewrite: (path: string) => path.replace(/^\/api/, ''),
        },
      }
    : undefined;

  return {
    resolve: {
      alias: {
        '@': resolve(import.meta.dirname, './src'),
      },
    },
    server: proxy ? { proxy } : undefined,
    preview: proxy ? { proxy } : undefined,
  };
});
