import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Annotation, BuildReport, ClientTarget, CollectionMember, DedupeStrategy, InlineRule } from '../core/index.ts';
import { decrypt, deriveKey, encrypt } from './crypto.ts';
import type {
  PersistedBuildReport,
  PersistedCollection,
  PersistedGroupOverride,
  PersistedProfile,
  PersistedSource,
  PersistedToken,
  ProfileEntry,
  SourceKind,
  Store,
} from './port.ts';

interface SourceRow {
  id: string;
  url: string;
  credential_ref: string | null;
  refresh_policy: string | null;
  kind: string;
  name: string | null;
  format: string | null;
  ua: string | null;
  enabled: number;
  proxy: string | null;
  last_fetched_at: string | null;
  last_error: string | null;
  userinfo: string | null;
  suggested_hours: number | null;
  updated_at: string;
}
interface PayloadRow { content: string; bytes: number; updated_at: string }
interface ProfileRow { id: string; name: string; source_ids: string; items: string | null }
interface CollectionRow {
  id: string;
  name: string;
  members: string;
  dedupe: string;
  sort_order: number;
}
interface AnnotationRow {
  node_key: string;
  excluded: number;
  alias: string | null;
  tag: string | null;
  region: string | null;
  sort_order: number | null;
}
interface TokenRow {
  id: string;
  token_hash: string;
  profile: string;
  target: string;
  revoked: number;
  created_at: string;
}
interface ReportRow { build_id: string; target: string; payload: string; created_at: string }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS source_config (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL DEFAULT '',
  credential_ref TEXT,
  refresh_policy TEXT,
  kind TEXT NOT NULL DEFAULT 'remote',
  name TEXT,
  format TEXT,
  ua TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  proxy TEXT,
  last_fetched_at TEXT,
  last_error TEXT,
  userinfo TEXT,
  suggested_hours REAL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_payload (
  source_id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profile_definition (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  source_ids TEXT NOT NULL DEFAULT '[]',
  items TEXT
);
CREATE TABLE IF NOT EXISTS collection_definition (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  members TEXT NOT NULL,
  dedupe TEXT NOT NULL DEFAULT 'nodeKey',
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS annotation (
  node_key TEXT PRIMARY KEY,
  excluded INTEGER NOT NULL DEFAULT 0,
  alias TEXT,
  tag TEXT,
  region TEXT,
  sort_order INTEGER
);
CREATE TABLE IF NOT EXISTS subscription_token (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  profile TEXT NOT NULL,
  target TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS build_report (
  build_id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inline_rule (
  position INTEGER PRIMARY KEY,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policy_group_override (
  name TEXT PRIMARY KEY,
  members TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_build_report_created ON build_report(created_at DESC);
`;

/** 老库升级：SQLite 没有 ADD COLUMN IF NOT EXISTS，只能先查 PRAGMA。 */
function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

const SOURCE_KINDS: readonly SourceKind[] = ['remote', 'file', 'inline'];
const DEDUPE_STRATEGIES: readonly DedupeStrategy[] = ['nodeKey', 'name', 'none'];

export function openStore(dbPath: string, secret: string): Store {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  let key = deriveKey(secret);
  // WAL 官方限制：所有进程必须在同一主机，且不能放在网络文件系统上。
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  ensureColumn(db, 'source_config', 'kind', "kind TEXT NOT NULL DEFAULT 'remote'");
  ensureColumn(db, 'source_config', 'name', 'name TEXT');
  ensureColumn(db, 'source_config', 'format', 'format TEXT');
  ensureColumn(db, 'source_config', 'ua', 'ua TEXT');
  ensureColumn(db, 'source_config', 'enabled', 'enabled INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'source_config', 'proxy', 'proxy TEXT');
  ensureColumn(db, 'source_config', 'last_fetched_at', 'last_fetched_at TEXT');
  ensureColumn(db, 'source_config', 'last_error', 'last_error TEXT');
  ensureColumn(db, 'source_config', 'userinfo', 'userinfo TEXT');
  ensureColumn(db, 'source_config', 'suggested_hours', 'suggested_hours REAL');
  ensureColumn(db, 'profile_definition', 'items', 'items TEXT');
  // 手动覆盖地区：早期版本只存 alias / tag，旧库要补这一列才不会在写入时 500。
  ensureColumn(db, 'annotation', 'region', 'region TEXT');

  // 空库冷启动：保证始终存在一个 default profile，否则登录后 /api/nodes、/api/preview 等
  // 因 findProfile('default') 返回 undefined 全部抛 profile-not-found，前端直接「登录失败」。
  const profileCount = (
    db.prepare('SELECT COUNT(*) AS c FROM profile_definition').get() as { c: number }
  ).c;
  if (profileCount === 0) {
    db.prepare(
      'INSERT INTO profile_definition (id, name, source_ids, items) VALUES (?, ?, ?, ?)',
    ).run('default', 'default', '[]', '[]');
  }

  const toSource = (row: SourceRow): PersistedSource => {
    const kind = (SOURCE_KINDS as readonly string[]).includes(row.kind)
      ? (row.kind as SourceKind)
      : 'remote';
    return {
      id: row.id,
      name: row.name ?? row.id,
      kind,
      enabled: row.enabled === 1,
      ...(row.url.length === 0 ? {} : { url: row.url }),
      ...(row.ua === null ? {} : { ua: row.ua }),
      ...(row.format === null ? {} : { format: row.format }),
      ...(row.refresh_policy === null ? {} : { refreshPolicy: row.refresh_policy }),
      ...(row.proxy === null || row.proxy.length === 0 ? {} : { proxy: row.proxy }),
      ...(row.last_fetched_at === null ? {} : { lastFetchedAt: row.last_fetched_at }),
      ...(row.last_error === null ? {} : { lastError: row.last_error }),
      ...(row.userinfo === null
        ? {}
        : { userinfo: JSON.parse(row.userinfo) as NonNullable<PersistedSource['userinfo']> }),
      ...(row.suggested_hours === null ? {} : { suggestedRefreshHours: row.suggested_hours }),
    };
  };

  const toAnnotation = (row: AnnotationRow): Annotation => ({
    nodeKey: row.node_key,
    ...(row.alias === null ? {} : { alias: row.alias }),
    ...(row.tag === null ? {} : { tag: row.tag }),
    ...(row.region === null ? {} : { region: row.region }),
    ...(row.sort_order === null ? {} : { order: row.sort_order }),
    excluded: row.excluded === 1,
  });

  const toToken = (row: TokenRow): PersistedToken => ({
    id: row.id,
    tokenHash: row.token_hash,
    profile: row.profile,
    target: row.target === 'auto' ? 'auto' : (row.target as ClientTarget),
    revoked: row.revoked === 1,
    createdAt: row.created_at,
  });

  const toReport = (row: ReportRow): PersistedBuildReport => ({
    buildId: row.build_id,
    target: row.target as ClientTarget,
    report: JSON.parse(row.payload) as BuildReport,
    createdAt: row.created_at,
  });

  const toCollection = (row: CollectionRow): PersistedCollection => ({
    id: row.id,
    name: row.name,
    members: JSON.parse(row.members) as CollectionMember[],
    dedupe: (DEDUPE_STRATEGIES as readonly string[]).includes(row.dedupe)
      ? (row.dedupe as DedupeStrategy)
      : 'nodeKey',
    order: row.sort_order,
  });

  /** 老库只有 source_ids：升级时按顺序生成 items，语义与升级前一致（扁平合并）。 */
  const toProfile = (row: ProfileRow): PersistedProfile => {
    const legacyIds = JSON.parse(row.source_ids) as string[];
    const parsed = row.items === null ? null : (JSON.parse(row.items) as ProfileEntry[]);
    const entries: ProfileEntry[] =
      parsed === null || parsed.length === 0
        ? legacyIds.map((id) => ({ kind: 'source', id }))
        : parsed;
    return { id: row.id, name: row.name, entries };
  };

  return {
    listSources: () =>
      (db.prepare('SELECT * FROM source_config ORDER BY updated_at DESC, id').all() as SourceRow[]).map(
        toSource,
      ),

    getSource: (id) => {
      const row = db.prepare('SELECT * FROM source_config WHERE id = ?').get(id) as SourceRow | undefined;
      return row === undefined ? undefined : toSource(row);
    },

    putSource: (source) => {
      db.prepare(
        `INSERT INTO source_config (id, url, credential_ref, refresh_policy, kind, name, format, ua, enabled, proxy, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET url=excluded.url, credential_ref=excluded.credential_ref,
           refresh_policy=excluded.refresh_policy, kind=excluded.kind, name=excluded.name,
           format=excluded.format, ua=excluded.ua, enabled=excluded.enabled, proxy=excluded.proxy,
           updated_at=excluded.updated_at`,
      ).run(
        source.id,
        source.url ?? '',
        null,
        source.refreshPolicy ?? null,
        source.kind,
        source.name,
        source.format ?? null,
        source.ua ?? null,
        source.enabled ? 1 : 0,
        source.proxy ?? null,
        new Date().toISOString(),
      );
    },

    // 刷新结果只写运行态列：updated_at 不动，避免自动刷新把源列表顺序打乱。
    updateSourceState: (id, state) => {
      const assignments: string[] = [];
      const values: unknown[] = [];
      if ('lastFetchedAt' in state) {
        assignments.push('last_fetched_at = ?');
        values.push(state.lastFetchedAt ?? null);
      }
      if ('lastError' in state) {
        assignments.push('last_error = ?');
        values.push(state.lastError ?? null);
      }
      if ('userinfo' in state) {
        assignments.push('userinfo = ?');
        values.push(state.userinfo === undefined || state.userinfo === null ? null : JSON.stringify(state.userinfo));
      }
      if ('suggestedRefreshHours' in state) {
        assignments.push('suggested_hours = ?');
        values.push(state.suggestedRefreshHours ?? null);
      }
      if (assignments.length === 0) return;
      db.prepare(`UPDATE source_config SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id);
    },

    removeSource: (id) => {
      db.transaction(() => {
        db.prepare('DELETE FROM source_payload WHERE source_id = ?').run(id);
        db.prepare('DELETE FROM source_config WHERE id = ?').run(id);
      })();
    },

    readSourcePayload: (id) => {
      const row = db.prepare('SELECT content FROM source_payload WHERE source_id = ?').get(id) as
        | { content: string }
        | undefined;
      return row === undefined ? undefined : decrypt(row.content, key);
    },

    writeSourcePayload: (id, content) => {
      db.prepare(
        `INSERT INTO source_payload (source_id, content, bytes, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET content=excluded.content, bytes=excluded.bytes,
           updated_at=excluded.updated_at`,
      ).run(id, encrypt(content, key), Buffer.byteLength(content, 'utf8'), new Date().toISOString());
    },

    sourcePayloadInfo: (id) => {
      const row = db.prepare('SELECT bytes, updated_at FROM source_payload WHERE source_id = ?').get(id) as
        | { bytes: number; updated_at: string }
        | undefined;
      return row === undefined ? undefined : { bytes: row.bytes, updatedAt: row.updated_at };
    },

    rotateSecret: (nextSecret) => {
      const previousKey = key;
      const nextKey = deriveKey(nextSecret);
      const rows = db.prepare('SELECT source_id, content FROM source_payload').all() as {
        source_id: string;
        content: string;
      }[];
      // 整个重加密放在一个事务里：任何一行解不开都回滚，不会留下「一半新密钥、一半旧密钥」。
      db.transaction(() => {
        const update = db.prepare('UPDATE source_payload SET content = ? WHERE source_id = ?');
        for (const row of rows) {
          update.run(encrypt(decrypt(row.content, key), nextKey), row.source_id);
        }
      })();
      key = nextKey;
      /* 撤销：把库里刚换成 nextKey 的正文重新用 previousKey 加密回去。
         重新读行而不是复用上面的 rows——那份是轮换前的旧密文，此时已经失效。
         事务成功后才切回旧 key：撤销失败时内存里的 key 必须和库里保持一致。 */
      return () => {
        const current = db.prepare('SELECT source_id, content FROM source_payload').all() as {
          source_id: string;
          content: string;
        }[];
        db.transaction(() => {
          const update = db.prepare('UPDATE source_payload SET content = ? WHERE source_id = ?');
          for (const row of current) {
            update.run(encrypt(decrypt(row.content, nextKey), previousKey), row.source_id);
          }
        })();
        key = previousKey;
      };
    },

    listCollections: () =>
      (
        db.prepare('SELECT * FROM collection_definition ORDER BY sort_order, name').all() as CollectionRow[]
      ).map(toCollection),

    getCollection: (id) => {
      const row = db.prepare('SELECT * FROM collection_definition WHERE id = ?').get(id) as
        | CollectionRow
        | undefined;
      return row === undefined ? undefined : toCollection(row);
    },

    putCollection: (collection) => {
      db.prepare(
        `INSERT INTO collection_definition (id, name, members, dedupe, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, members=excluded.members,
           dedupe=excluded.dedupe, sort_order=excluded.sort_order, updated_at=excluded.updated_at`,
      ).run(
        collection.id,
        collection.name,
        JSON.stringify(collection.members),
        collection.dedupe,
        collection.order,
        new Date().toISOString(),
      );
    },

    removeCollection: (id) => {
      db.prepare('DELETE FROM collection_definition WHERE id = ?').run(id);
    },

    listProfiles: () =>
      (db.prepare('SELECT * FROM profile_definition ORDER BY name').all() as ProfileRow[]).map(toProfile),

    putProfile: (profile) => {
      db.prepare(
        `INSERT INTO profile_definition (id, name, source_ids, items) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, source_ids=excluded.source_ids, items=excluded.items`,
      ).run(
        profile.id,
        profile.name,
        JSON.stringify(profile.entries.filter((entry) => entry.kind === 'source').map((entry) => entry.id)),
        JSON.stringify(profile.entries),
      );
    },

    removeProfile: (id) => {
      db.prepare('DELETE FROM profile_definition WHERE id = ?').run(id);
    },

    listAnnotations: () =>
      (db.prepare('SELECT * FROM annotation').all() as AnnotationRow[]).map(toAnnotation),

    putAnnotation: (annotation) => {
      // 写串行化交给 SQLite 事务；单实例单进程，不需要额外的写队列。
      db.transaction(() => {
        db.prepare(
          `INSERT INTO annotation (node_key, excluded, alias, tag, region, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(node_key) DO UPDATE SET excluded=excluded.excluded, alias=excluded.alias,
             tag=excluded.tag, region=excluded.region, sort_order=excluded.sort_order`,
        ).run(
          annotation.nodeKey,
          annotation.excluded === true ? 1 : 0,
          annotation.alias ?? null,
          annotation.tag ?? null,
          // 空串按「没有覆盖」落库：下游 regionOfNode 用 `!== ''` 判断，存 null 语义更准。
          annotation.region === undefined || annotation.region === '' ? null : annotation.region,
          annotation.order ?? null,
        );
      })();
    },

    removeAnnotation: (nodeKey) => {
      db.prepare('DELETE FROM annotation WHERE node_key = ?').run(nodeKey);
    },

    getSetting: (key) => {
      const row = db.prepare('SELECT value FROM app_setting WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value;
    },

    putSetting: (key, value) => {
      db.prepare(
        'INSERT INTO app_setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(key, value);
    },

    // 单条 UPSERT 原子判定：key 不存在则写入；已存在且非空则不动；残留空值视为
    // 「上次初始化没写完」，就地修复，避免管理面永久锁死且无法重新设置。
    claimSetting: (key, value) =>
      db
        .prepare(
          `INSERT INTO app_setting (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value
           WHERE app_setting.value = ''`,
        )
        .run(key, value).changes === 1,

    listRules: () =>
      (db.prepare('SELECT payload FROM inline_rule ORDER BY position').all() as { payload: string }[]).map(
        (row) => JSON.parse(row.payload) as InlineRule,
      ),

    replaceRules: (rules) => {
      db.transaction(() => {
        db.prepare('DELETE FROM inline_rule').run();
        const insert = db.prepare('INSERT INTO inline_rule (position, payload) VALUES (?, ?)');
        rules.forEach((rule, index) => insert.run(index, JSON.stringify(rule)));
      })();
    },

    listGroupOverrides: () =>
      (
        db.prepare('SELECT name, members, sort_order FROM policy_group_override ORDER BY sort_order').all() as {
          name: string;
          members: string;
          sort_order: number;
        }[]
      ).map((row) => ({
        name: row.name,
        members: JSON.parse(row.members) as string[],
        order: row.sort_order,
      })),

    replaceGroupOverrides: (overrides: readonly PersistedGroupOverride[]) => {
      db.transaction(() => {
        db.prepare('DELETE FROM policy_group_override').run();
        const insert = db.prepare(
          'INSERT INTO policy_group_override (name, members, sort_order) VALUES (?, ?, ?)',
        );
        overrides.forEach((override) =>
          insert.run(override.name, JSON.stringify(override.members), override.order),
        );
      })();
    },

    createToken: (token) => {
      db.prepare(
        'INSERT INTO subscription_token (id, token_hash, profile, target, revoked, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      ).run(token.id, token.tokenHash, token.profile, token.target, token.createdAt);
    },

    findTokenByHash: (hash) => {
      const row = db.prepare('SELECT * FROM subscription_token WHERE token_hash = ?').get(hash) as
        | TokenRow
        | undefined;
      return row === undefined ? undefined : toToken(row);
    },

    listTokens: () =>
      (db.prepare('SELECT * FROM subscription_token ORDER BY created_at DESC').all() as TokenRow[]).map(
        toToken,
      ),

    revokeToken: (id) => {
      db.prepare('UPDATE subscription_token SET revoked = 1 WHERE id = ?').run(id);
    },

    saveBuildReport: (report) => {
      db.prepare(
        'INSERT OR REPLACE INTO build_report (build_id, target, payload, created_at) VALUES (?, ?, ?, ?)',
      ).run(report.buildId, report.target, JSON.stringify(report.report), report.createdAt);
    },

    getBuildReport: (buildId) => {
      const row = db.prepare('SELECT * FROM build_report WHERE build_id = ?').get(buildId) as
        | ReportRow
        | undefined;
      return row === undefined ? undefined : toReport(row);
    },

    listBuildReports: (limit) =>
      (
        db.prepare('SELECT * FROM build_report ORDER BY created_at DESC LIMIT ?').all(limit) as ReportRow[]
      ).map(toReport),

    pruneBuildReports: (max) => {
      db.prepare(
        `DELETE FROM build_report WHERE build_id NOT IN (
           SELECT build_id FROM build_report ORDER BY created_at DESC LIMIT ?
         )`,
      ).run(max);
    },

    // SQLite 官方快照方式，WAL 下安全；裸 cp .db 会漏掉未 checkpoint 的 -wal。
    backup: async (destination) => {
      mkdirSync(dirname(destination), { recursive: true });
      db.prepare('VACUUM INTO ?').run(destination);
    },

    close: () => {
      db.close();
    },
  };
}
