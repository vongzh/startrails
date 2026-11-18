import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { ClientTarget } from '../../core/index.ts';
import { hashToken, newToken } from '../../store/crypto.ts';
import type { AppEnv } from '../http.ts';
import { absoluteUrlOf, readJsonObject } from '../http.ts';
import { asString, isTarget } from '../input.ts';
import type { AdminDeps } from './admin-context.ts';

export function tokensRoutes(deps: AdminDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { store, builder, publicBaseUrl } = deps;

  router.post('/tokens', async (c) => {
    const body = await readJsonObject(c);
    const profileName = asString(body['profile']) ?? 'default';
    const target = asString(body['target']) ?? '';
    if (target !== 'auto' && !isTarget(target)) {
      return c.json({ error: 'unknown-target' }, 400);
    }
    const definition = builder.findProfile(profileName);
    if (definition === undefined) {
      return c.json({ error: 'profile-not-found' }, 404);
    }
    if (
      definition.entries.length === 0 &&
      store.listRules(definition.id).length === 0 &&
      store.listGroupOverrides(definition.id).length === 0
    ) {
      return c.json(
        {
          error: 'profile-empty',
          hint: '当前 Profile 没有任何内容：先在订阅源页把源加入构成并保存，再签发地址',
        },
        409,
      );
    }
    const token = newToken();
    const id = randomUUID();
    const resolvedTarget: ClientTarget | 'auto' = isTarget(target) ? target : 'auto';
    store.createToken({
      id,
      tokenHash: hashToken(token),
      token,
      profile: profileName,
      target: resolvedTarget,
      revoked: false,
      createdAt: new Date().toISOString(),
    });
    const path =
      resolvedTarget === 'auto'
        ? `/s/${token}`
        : `/s/${token}/${encodeURIComponent(profileName)}/${resolvedTarget}`;
    return c.json(
      {
        id,
        token,
        url: absoluteUrlOf(c, path, '', publicBaseUrl),
        path,
        target: resolvedTarget,
        profile: profileName,
      },
      201,
    );
  });

  router.delete('/tokens/:id', (c) => {
    store.revokeToken(c.req.param('id'));
    return c.json({ ok: true });
  });

  return router;
}
