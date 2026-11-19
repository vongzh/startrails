import pkg from '../../package.json' with { type: 'json' };

/** 内核契约版本：唯一配置源为 package.json 的 version 字段。 */
export const CORE_VERSION: string = pkg.version;
