/**
 * @cup/contract —— 四方共享的数据契约(唯一真相源)。
 *
 * 文档:桌面《contract.md》。文档与代码必须一致,不一致 = bug(契约 §7.4)。
 *
 * 用法:
 *   import { LidTelemetrySchema, type LidTelemetry, CUP } from '@cup/contract';
 *   const parsed = LidTelemetrySchema.parse(raw);   // 运行时校验
 *   const t: LidTelemetry = parsed;                 // 编译期类型
 */
export * from './constants.ts';
export * from './schemas.ts';
