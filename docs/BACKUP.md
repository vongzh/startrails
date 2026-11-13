# 备份与恢复

备份的目标只有一个：**一个文件装下全部状态**。所以订阅源正文、标注、订阅 Token 哈希、管理面令牌哈希、构建历史都在 SQLite 里，加密字段靠 `STARTRAILS_TOKEN_SECRET` 解密，不需要同步任何目录。

## 备份里有什么

| 内容 | 在不在备份里 | 说明 |
| --- | --- | --- |
| 订阅源配置（URL / UA / 代理 / 刷新策略） | ✅ | `source_config` |
| 文件源与粘贴源正文 | ✅ | `source_payload`，字段级 AES-GCM |
| 组合订阅 / Profile 构成 / 标注 / 内联规则 / 策略组 | ✅ | 全部用户意图 |
| 订阅 Token 的 **hash** | ✅ | 明文 token 只在签发时出现一次，永不落库 |
| 管理面令牌的 **hash** | ✅ | `app_setting`；恢复后沿用同一枚管理令牌（若配置了环境变量则以环境变量为准） |
| 构建历史与诊断 | ✅ | 最近 200 次，可裁剪 |
| `web/dist` 前端产物 | ❌ | 由 `npm run build:ui` 重新生成 |
| `data/cache/`（上游快照、规则集缓存） | ❌ | 可重建产物 |

下载回的 `.db` 是**全量**的，恢复后不需要重填任何订阅。

## 本地备份

下面两条 `curl` 里的 `$STARTRAILS_ADMIN_TOKEN` 未设置时，换成首次在 Web UI 设定的那枚令牌；设置了环境变量的情况下，环境变量始终优先。

界面「设置 → 维护 → 备份数据库」，或：

```bash
curl -X POST -H "Authorization: Bearer $STARTRAILS_ADMIN_TOKEN" \
     http://127.0.0.1:8787/api/backup
# → {"destination":"/path/to/data/backup/startrails-1712345678901.db"}
```

实现用 SQLite 的 `VACUUM INTO`（等价于 backup API），**不要**直接 `cp startrails.db`：WAL 模式下裸拷贝会丢最近的提交，甚至拷到半个事务。

## 远端备份（WebDAV）

```bash
export STARTRAILS_WEBDAV_URL='https://dav.example.com/remote.php/dav/files/me/startrails'
export STARTRAILS_WEBDAV_USER='me'
export STARTRAILS_WEBDAV_PASS='<应用专用密码>'
```

配置后界面出现「上传备份」按钮，或：

```bash
curl -X POST -H "Authorization: Bearer $STARTRAILS_ADMIN_TOKEN" \
     http://127.0.0.1:8787/api/backup/remote
# → {"ok":true,"remoteUrl":"…/startrails-2026-01-01T00-00-00-000Z.db","bytes":1234567}
```

选 WebDAV 而不是 Gist 的理由：备份里有加密后的订阅正文与全部凭据引用，Gist 是公开可达的托管（secret gist 只是不出现在列表里）。WebDAV（Nextcloud / 群晖 / 坚果云 / 自建）权限模型与文件系统一致。

上传实现是标准 `PUT`：已存在资源回 `204`、新建回 `201`，两者都算成功；其他状态码一律视为失败并把状态码写进错误。发起上传前会先在本地落一份快照，上传失败时本地文件仍在。

## 恢复步骤

1. **停服务**（`docker compose stop` 或 `systemctl stop startrails`），确保没有进程持有数据库。
2. 备份现有库（哪怕它坏了）：`mv data/startrails.db data/startrails.db.broken`，同时删掉 `startrails.db-wal` / `startrails.db-shm`——它们属于旧库，混用会损坏新库。
3. 把远端那份 `.db` 下载到 `data/startrails.db`。
4. **用同一个 `STARTRAILS_TOKEN_SECRET` 启动**。换了密钥，加密字段全部解不开，表现是「源列表还在、正文读不出来」。
5. 启动后自检：
   - `/health` 返回 `ok`；
   - 「订阅源」里每个源都有节点数，`lastError` 为空；
   - 订阅 URL 返回 200 且内容与备份前一致（ETag 会变，属正常）；
   - 已签发的订阅 token 仍然可用（token 在你手上，库里存的是它的 hash）。

## 演练

```bash
npm run drill:backup
```

脚本会建一个临时库、写入数据、`VACUUM INTO`、重开校验、比对正文，最后打印 `BACKUP_DRILL_OK`。`npm run verify` 里包含这一步，所以每次发版都会实际走一遍恢复路径，而不是「文档写着能恢复」。

## 密钥轮换

`STARTRAILS_TOKEN_SECRET` 不是可选项。轮换意味着旧库里的加密字段无法解密，只有两条路：

- 有旧密钥：用它启动，把每个文件源 / 粘贴源的内容重新保存一次（走新密钥加密），再换新密钥启动；
- 没有旧密钥：删除这些源后重新添加。

因此**密钥要跟备份一起存**（例如放密码管理器），但不要跟备份放在同一个存储里。
