# Fast Note Sync 插件

Fast Note Sync 的 Obsidian 插件（TypeScript）：监听笔记库的文件变化，通过 WebSocket 和服务端同步。fork 自 haierkeys/obsidian-fast-note-sync，上游已停更。

## 地图
- src/main.ts：插件入口
- src/lib/sync/：同步。websocket_* 管连接，operator_* 按对象类型处理收发（笔记、附件、文件夹、配置）
- src/lib/utils/events_manager.ts：监听 Obsidian 文件事件
- src/lib/storage/：本地状态（哈希缓存、待确认列表）
- src/setting.tsx、src/views/：设置页和各种弹窗
- 插件的设计见 [docs/atlas/README.md](docs/atlas/README.md)
- 整套系统见 [服务端的 atlas](../fast-note-sync-service/docs/atlas/README.md)；改动涉及同步协议或冲突规则时先读它的[同步](../fast-note-sync-service/docs/atlas/sync.md)一节

## 验证
- `pnpm build`：类型检查加打包，生成 main.js，约 15 秒。2026-10-14 时 master 上编译失败：src/views/conflict-resolve-modal.ts 用了不存在的翻译键 `ui.conflict.diff_skipped`
- `pnpm lint`

## 硬约束
- 同步协议以服务端为准；改 src/pb/ 或消息结构时，服务端仓库同步改

## 改动前先读
| 如果你要改… | 先读 |
|---|---|
| 同步的收发、冲突、连接（src/lib/sync/*、src/lib/utils/events_manager.ts、src/lib/storage/*） | [插件导览](docs/atlas/README.md) 和服务端的[同步](../fast-note-sync-service/docs/atlas/sync.md) |
| 设置和界面（src/setting.tsx、src/views/*） | [插件导览](docs/atlas/README.md) |

## 维护
- 改了某一块的边界、流程，或踩到新坑：同一次改动里更新 atlas，刷新 verified。
- 硬约束和服务端 atlas 的守护层：不直接改，在改动说明里单独列出建议，等主人确认。
- 代码和守护层冲突时，停下来问主人，不要自行二选一。
- 提交前跑 `python3 scripts/atlas_audit.py`。
