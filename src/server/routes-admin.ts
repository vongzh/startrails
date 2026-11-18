import { Hono } from 'hono';
import type { AppEnv } from './http.ts';
import { collectionsRoutes } from './routes/admin-collections.ts';
import { configRoutes } from './routes/admin-config.ts';
import { ADMIN_TOKEN_SETTING_KEY, SETTING_NOTIFY, SETTING_WEBDAV, adminAuthMiddleware } from './routes/admin-context.ts';
import type { AdminDeps } from './routes/admin-context.ts';
import { nodesRoutes } from './routes/admin-nodes.ts';
import { opsRoutes } from './routes/admin-ops.ts';
import { setupRoutes } from './routes/admin-setup.ts';
import { sourcesRoutes } from './routes/admin-sources.ts';
import { tokensRoutes } from './routes/admin-tokens.ts';

export { ADMIN_TOKEN_SETTING_KEY, SETTING_NOTIFY, SETTING_WEBDAV };
export type { AdminDeps };

export function createAdminApp(deps: AdminDeps): Hono<AppEnv> {
  const api = new Hono<AppEnv>();

  api.use('*', adminAuthMiddleware(deps));

  api.route('/', setupRoutes(deps));
  api.route('/', sourcesRoutes(deps));
  api.route('/', collectionsRoutes(deps));
  api.route('/', nodesRoutes(deps));
  api.route('/', configRoutes(deps));
  api.route('/', tokensRoutes(deps));
  api.route('/', opsRoutes(deps));

  api.notFound((c) => c.json({ error: 'unknown-api-route' }, 404));

  return api;
}
