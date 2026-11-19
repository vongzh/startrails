import pkg from '../../package.json' with { type: 'json' };

/** 前端声明兼容的内核契约版本：唯一配置源为 package.json 的 version 字段。 */
export const UI_CORE_VERSION: string = pkg.version;
