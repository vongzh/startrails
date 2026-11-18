import { Hono } from 'hono';
import { hashToken, safeEqual } from '../../store/crypto.ts';
import type { AppEnv } from '../http.ts';
import { readJsonObject } from '../http.ts';
import { redact } from '../redact.ts';
import {
  MIN_TOKEN_SECRET_LENGTH,
  commitSecretFile,
  discardSecretFile,
  stageSecretFile,
} from '../secret.ts';
import type { AdminDeps } from './admin-context.ts';
import {
  ADMIN_TOKEN_SETTING_KEY,
  MIN_ADMIN_TOKEN_LENGTH,
  activeAdminHashOf,
  isAdminRequest,
} from './admin-context.ts';

export function setupRoutes(deps: AdminDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/setup/status', (c) =>
    c.json({
      required: activeAdminHashOf(deps) === undefined,
      secretRequired: !deps.isSecretConfigured(),
    }),
  );

  router.post('/setup', async (c) => {
    const body = await readJsonObject(c);
    const adminMissing = activeAdminHashOf(deps) === undefined;
    const secretMissing = !deps.isSecretConfigured();
    if (!adminMissing && !secretMissing) {
      return c.json({ error: 'already-initialized' }, 409);
    }
    if (!adminMissing && !isAdminRequest(deps, c)) {
      return c.json({ error: 'admin-auth-required' }, 401);
    }
    const token = typeof body['token'] === 'string' ? body['token'].trim() : '';
    const nextSecret = typeof body['secret'] === 'string' ? body['secret'].trim() : '';
    if (adminMissing && token.length < MIN_ADMIN_TOKEN_LENGTH) {
      return c.json({ error: 'admin-token-too-short', minLength: MIN_ADMIN_TOKEN_LENGTH }, 400);
    }
    if (secretMissing) {
      if (nextSecret.length < MIN_TOKEN_SECRET_LENGTH) {
        return c.json({ error: 'secret-too-short', minLength: MIN_TOKEN_SECRET_LENGTH }, 400);
      }
      if (deps.secretFile === undefined) {
        return c.json({ error: 'secret-file-unavailable' }, 500);
      }
      let staged: string | null = null;
      let rollback: (() => void) | undefined;
      try {
        staged = stageSecretFile(deps.secretFile, nextSecret);
        rollback = deps.store.rotateSecret(nextSecret);
        commitSecretFile(deps.secretFile, staged);
        staged = null;
        deps.markSecretConfigured();
      } catch (error) {
        if (staged !== null) discardSecretFile(staged);
        let reverted = true;
        if (rollback !== undefined) {
          try {
            rollback();
          } catch {
            reverted = false;
          }
        }
        const reason = error instanceof Error ? error.message : 'unknown';
        if (/unable to authenticate|bad decrypt|wrong final block length/i.test(reason)) {
          return c.json(
            {
              error: 'payload-undecryptable',
              hint: '已有正文无法用新密钥解密：请先用原 STARTRAILS_TOKEN_SECRET 启动，或从备份恢复',
            },
            422,
          );
        }
        if (!reverted) {
          return c.json(
            {
              error: 'secret-file-desync',
              reason: redact(reason).slice(0, 160),
              hint: '数据库已切到新密钥但密钥文件未写入：重启前把密钥文件内容改成刚才设置的密钥，或用 STARTRAILS_TOKEN_SECRET 启动，否则已有正文将无法解密',
            },
            500,
          );
        }
        return c.json(
          {
            error: 'secret-persist-failed',
            reason: redact(reason).slice(0, 160),
          },
          500,
        );
      }
    }
    if (adminMissing && !deps.store.claimSetting(ADMIN_TOKEN_SETTING_KEY, hashToken(token))) {
      return c.json({ error: 'admin-already-initialized' }, 409);
    }
    return c.json({ ok: true }, 201);
  });

  router.post('/admin/token', async (c) => {
    if (deps.envTokenHash !== undefined) {
      return c.json(
        {
          error: 'admin-token-from-env',
          hint: '管理令牌来自环境变量 STARTRAILS_ADMIN_TOKEN，请在部署侧修改后重启',
        },
        409,
      );
    }
    const body = await readJsonObject(c);
    const next = typeof body['token'] === 'string' ? body['token'].trim() : '';
    if (next.length < MIN_ADMIN_TOKEN_LENGTH) {
      return c.json({ error: 'admin-token-too-short', minLength: MIN_ADMIN_TOKEN_LENGTH }, 400);
    }
    const current = activeAdminHashOf(deps);
    if (current !== undefined && safeEqual(hashToken(next), current)) {
      return c.json({ error: 'admin-token-unchanged' }, 400);
    }
    deps.store.putSetting(ADMIN_TOKEN_SETTING_KEY, hashToken(next));
    return c.json({ ok: true });
  });

  return router;
}
