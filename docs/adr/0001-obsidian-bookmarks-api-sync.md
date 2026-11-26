# 1. 仅通过 Obsidian 核心插件运行时 API 同步书签

Status: accepted

主页「书签」卡片需要与 Obsidian 原生书签保持实时一致并支持添加与删减。我们决定仅通过 Obsidian 核心插件 `bookmarks` 的运行时实例 API（`items`、`addItem`、`removeItem`、`openBookmark`、`getItemTitle` 与 `on('changed')`）进行读写和监听，而不直接解析或改写 `.obsidian/bookmarks.json`；当检测到核心「书签」插件未启用时，卡片展示启用引导并禁用增删操作。

## Considered Options

- **通过 `bookmarks` 核心插件运行时 API 同步（已采纳）**：由 Obsidian 核心插件统一维护内存书签树、文件重命名联动、标签页书签图标与落盘时机，避免状态撕裂。
- **直接读写 `.obsidian/bookmarks.json`**：可在插件未启用时强行修改磁盘文件，但无法触发 Obsidian 内存态与侧边栏即时刷新，且存在并发覆盖与格式漂移风险。

## Consequences

- 当核心「书签」插件关闭时，主页只能降级为只读引导提示，不能直接替用户增删书签。
- 代码依赖 Obsidian 内部插件实例接口，需要在适配层中做好空值防御与能力回退。
