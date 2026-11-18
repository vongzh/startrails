/**
 * 拆出候选 URI：换行之外，还兼容一段里用空白 / 逗号 / 分号拼接的分享链接
 * （机场 App 的「批量复制」并不总是换行，粘贴进网页也可能被压成一行）。
 * 只在「分隔符后面紧跟 scheme」处切，避免把 `#香港 01` 这类节点名里的空格拆开。
 *
 * 独立放在零依赖模块中，供后端解析器与前端粘贴计数同构共用。
 */
export function splitSubscriptionUris(raw: string): string[] {
  return raw
    .split(/\r\n|\n|\r/)
    .flatMap((line) => line.split(/[\s,;]+(?=[a-z0-9+.-]+:\/\/)/i))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
