import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../store/sqlite.ts';
import { ADMIN_TOKEN_SETTING_KEY, createApp } from './app.ts';

// 本地开发：优先加载项目根目录的 .env（不存在则静默跳过），使 secret 跨会话一致。
// 生产部署仍由编排器注入环境变量，此处不覆盖已存在的同名变量（loadEnvFile 不覆盖）。
try {
  process.loadEnvFile(join(fileURLToPath(new URL('../../', import.meta.url)), '.env'));
} catch {
  // .env 不存在或不可读：忽略，走下方的临时密钥回退。
}

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const dataDir = process.env['STARTRAILS_DATA_DIR'] ?? join(projectRoot, 'data');
const dbPath = process.env['STARTRAILS_DB_PATH'] ?? join(dataDir, 'startrails.db');
const port = Number(process.env['STARTRAILS_PORT'] ?? 8787);
// 默认只监听回环：订阅 URL 的 token 即凭据，公网访问必须走 TLS 反代。
const host = process.env['STARTRAILS_HOST'] ?? '127.0.0.1';
const webRoot = process.env['STARTRAILS_WEB_ROOT'] ?? join(projectRoot, 'web', 'dist');

const secret = process.env['STARTRAILS_TOKEN_SECRET'];
if (secret === undefined || secret.length === 0) {
  console.warn('[startrails] STARTRAILS_TOKEN_SECRET 未设置：本次使用临时密钥，重启后加密字段将无法解密。生产必须设置。');
}
// 管理面令牌：环境变量优先；没配就回退到数据库里首次设置时落下的哈希。
// trim 同时处理「未设置」与「设成空字符串」，避免空令牌把管理面锁死。
const adminToken = process.env['STARTRAILS_ADMIN_TOKEN']?.trim() ?? '';
const store = openStore(dbPath, secret ?? randomBytes(32).toString('hex'));
const adminConfigured = adminToken.length > 0 || store.getSetting(ADMIN_TOKEN_SETTING_KEY) !== undefined;

// 通知与远端备份都是「可选能力」：没配就整块不启用，不因为缺配置而拒绝启动。
const tgToken = process.env['STARTRAILS_TG_BOT_TOKEN'];
const tgChat = process.env['STARTRAILS_TG_CHAT_ID'];
const barkUrl = process.env['STARTRAILS_BARK_URL'];
const webdavUrl = process.env['STARTRAILS_WEBDAV_URL'];

/**
 * 对外可达的基地址。两个地方依赖它：外部规则集镜像地址、以及二维码里那条绝对 URL。
 * 都配了反代时应当显式声明——否则只能按请求头推断，反代没传 X-Forwarded-Proto 就会拼成 http。
 */
const publicBaseUrl = process.env['STARTRAILS_PUBLIC_BASE_URL']?.trim().replace(/\/+$/, '');

// 两条通知渠道可能只有其一，必须合成一个对象：分两次展开 notify 会互相覆盖。
const notifyConfig = {
  ...(tgToken === undefined || tgChat === undefined
    ? {}
    : { telegram: { botToken: tgToken, chatId: tgChat } }),
  ...(barkUrl === undefined || barkUrl.length === 0 ? {} : { bark: { url: barkUrl } }),
};

const app = createApp({
  store,
  ...(adminToken.length === 0 ? {} : { adminToken }),
  cacheDir: join(dataDir, 'cache'),
  dataDir,
  webRoot,
  allowPrivate: process.env['STARTRAILS_ALLOW_PRIVATE'] === '1',
  // 无状态转换默认关闭：它让匿名请求借服务器身份去拉任意公网 URL。要开必须显式表态。
  allowStateless: process.env['STARTRAILS_ALLOW_STATELESS'] === '1',
  ...(publicBaseUrl === undefined || publicBaseUrl.length === 0 ? {} : { publicBaseUrl }),
  ...(Object.keys(notifyConfig).length === 0 ? {} : { notify: notifyConfig }),
  ...(webdavUrl === undefined || webdavUrl.length === 0
    ? {}
    : {
        webdav: {
          url: webdavUrl,
          ...(process.env['STARTRAILS_WEBDAV_USER'] === undefined
            ? {}
            : { username: process.env['STARTRAILS_WEBDAV_USER'] }),
          ...(process.env['STARTRAILS_WEBDAV_PASS'] === undefined
            ? {}
            : { password: process.env['STARTRAILS_WEBDAV_PASS'] }),
        },
      }),
});

app.server.listen(port, host, () => {
  console.log(`Startrails listening on http://${host}:${port}`);
  console.log(`  health        GET  /health`);
  console.log(`  subscription  GET  /s/:token/:profile/:target`);
  console.log(`  diagnostics   GET  /api/diagnostics?buildId=...`);
  if (!adminConfigured) {
    console.log('  admin setup   首次访问请打开 Web UI 设置管理令牌（写入数据库，重启后仍有效）');
  }
});

const shutdown = (): void => {
  void app.close().finally(() => {
    store.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
