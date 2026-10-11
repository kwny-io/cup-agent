# 贡献约定

本项目是**软硬件双线**的单仓(monorepo)。改代码前先读这一页 —— 里面几条都是踩过坑才定下的。

## 目录分工(改前必读)

| 目录 | 归属 | 说明 |
|---|---|---|
| `packages/contract` | **冻结** | 四方共享的数据契约,唯一真相源(zod schema + TS 类型)。**改字段 = 改协议**,须先达成共识再动。 |
| `apps/server` | 后端线 | ingest 适配层 → 事件管线 → Store → REST/WS |
| `apps/web` | 前端线 | 卡通杯 + 看板 + 对话 |
| `apps/simulator` | 模拟器线 | 假杯子(假杯盖 + 假底座 + 行为脚本) |
| `firmware/**` | 固件线 | 独立于 npm workspace(`firmware/` 不在根 `workspaces` 里),不受 JS 工具链影响 |

**多窗口并行靠"目录不重叠"**:各线只写自己的目录,**谁也不碰 `packages/contract`**。若多个会话共用同一工作树,**别擅自 `git checkout/commit/push`** —— 会把别人的未提交改动一起卷进快照。

## 三道门禁(与 CI 一致)

`.github/workflows/ci.yml` 每次推 `main` / 开 PR 跑**三个互不依赖的闸**,本地提交前请逐条跑过:

```bash
npm ci
npm run typecheck                          # 闸 1:根 tsc + apps/web 的 tsc
npm test                                   # 闸 2:契约 + 模拟器 + 后端
npm --workspace @cup/web test              # 闸 2b:前端
bash firmware/lid/host_test/run_all.sh     # 闸 3:固件宿主单测(纯 C)
```

- **闸 1**:`typecheck` 是**两条** `tsc`(根 + `apps/web`)。`apps/web` 曾长期不在根脚本里,它有自己的 strict `tsconfig.json`;谈"类型检查绿"要指明跑的是这条合并命令。
- **闸 3**:固件那一闸在**零 ESP-IDF** 下用 `cc` 直接编纯 C 层(见下节)。开发机不一定带 C 编译器,故 **CI 是纯 C 层的兜底**。若本机装了 mingw,可 `CC=/c/mingw64/mingw64/bin/gcc.exe bash firmware/lid/host_test/run_all.sh`。
- **测试数以实跑为准。** 文档里的条数(根 / web / 固件)会随开发漂,引用前**实测一遍**,别照抄旧数。

## 固件的"纯 C 可测 / IDF 薄壳"分法

固件里**最容易错、又不依赖真板**的两类东西(契约字段名/数值区间、下行过滤去重、判定与换算边界)全部抽成**零 IDF 依赖的纯 C**:

- 纯 C 层 → 能在 PC 上跑宿主单测(`firmware/lid/host_test/run_all.sh`),真板上的逻辑与它**逐字一致**;
- 真板专属(esp-mqtt / NVS / LEDC / SPI / 面板推屏)→ **薄壳**,本机只做 shim 头 `-fsyntax-only` 语法检查(非真编译)。

**新增一个 `.c` 要同时改两处**:`CMakeLists.txt` 的 `SRCS`(否则真板根本不编它)**和** `run_all.sh`(否则宿主单测漏跑)。只改一处会让"宿主单测绿"变成假象 —— 这是踩过的坑。

编纯 C 单测时的 include 路径:`-Icomponents/cup_common -Ilid/main -Ibase/main`(共享组件在 `cup_common`,盖/底座各留专有源)。

## 依赖与许可证

- **加依赖先问**(原则 P4)。运行时依赖目前屈指可数(`ws`、`mqtt`、`aedes`(dev)、`zod` 等),每个都要有明确理由。
- 许可证 **Apache-2.0**(将来开源)。**新依赖必须许可兼容** —— 别引入 GPL / AGPL / LGPL 类(已核当前全部依赖为 MIT/ISC/BSD/Apache 系)。

## 文档

- 仓库内文档(`README.md` / 各目录说明)只谈**本仓事实**。
- 私人桌面档案(若存在)**不外链、不入仓** —— 仓内文件绝不反向引用桌面路径。

## 提交

提交信息按 `<type>(<scope>): <摘要>` 惯例(如 `fix(firmware): …` / `feat(web): …`),说明**为什么**而非罗列改了什么。
