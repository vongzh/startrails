export * from './version.ts';
// CLIENT_TARGETS / ClientTarget 由 ir/index.ts 重导出，这里只导出注册表特有符号。
export {
  DIALECTS,
  TARGETS,
  descriptorOf,
  dialectOf,
  outputFilename,
  targetsOfDialect,
} from './targets.ts';
export type { ContentMode, Dialect, TargetDescriptor } from './targets.ts';
export * from './ir/index.ts';
export * from './ir/validate.ts';
export * from './capabilities/index.ts';
export * from './capabilities/features.ts';
export * from './capabilities/verified.ts';
export * from './diagnostics/index.ts';
export * from './ingest/index.ts';
export * from './collections/index.ts';
export * from './process/index.ts';
export * from './process/trace.ts';
export * from './rules/index.ts';
export * from './plan/index.ts';
export * from './emit/index.ts';
export * from './import-url.ts';
export * from './qr/index.ts';
export * from './groups/icons.ts';
