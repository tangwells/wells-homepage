# 2. 运行时读取 Periodic Notes 周志预设并对齐 ISO 周口径与混合模板渲染

Status: accepted

左栏日历增加周数列与点击打开/创建周志能力，并与顶部快捷栏「打开/创建本周周志」共用同一周志预设解析逻辑。我们决定由 `carrot-home` 运行时读取 `periodic-notes` 插件的 `settings.weekly` 配置（缺省回退至 `06_日志` / `gggg[W]ww` / `02_模版/周志-xdb.md`），并以左栏周一～周日行的 ISO 周口径对齐 `gggg`/`ww` 命名，再由 `carrot-home` 自行读取模板并执行混合占位符渲染，而不直接调用 `periodic-notes` 内部创建函数或裸用 `moment().format()`。

## Considered Options

- **运行时读取 Periodic Notes 预设 + 默认回退 + ISO 周口径对齐 + 混合模板渲染（已采纳）**：
  - 优先从 `app.plugins` 读取 `periodic-notes` 的 `settings.weekly`（`folder`、`format`、`template`），当插件未启用或任意字段留空时按字段回退至默认预设，保证修改 Periodic Notes 配置即时生效，同时停用插件也不阻断工作台操作。
  - 左栏网格固定为周一至周日，将格式串中的 `gggg`/`GGGG`/`ww`/`WW` 对齐到以周四定年的 ISO 周口径，避免 Obsidian 切换英文 locale 时出现周号偏移或跨年周取错年份。
  - 混合模板渲染同时替换 `{{title}}`/`{{weekStart}}`/`{{weekEnd}}` 与 Periodic Notes 原生的 `{{date:...}}`/`{{time}}`/`{{monday:...}}`～`{{sunday:...}}`，兼容现有 `02_模版/周志-xdb.md` 与原生周志模板语法。
- **直接调用 `periodic-notes` 插件内部创建方法或裸用 `moment().format(format)`**：`periodic-notes` 未暴露稳定的公共创建 API，且原生创建不替换 `{{weekStart}}`/`{{weekEnd}}`，直接裸用 `moment()` 还会受 locale 影响导致周一～周日行与周号错位。
- **强依赖 `periodic-notes` 插件启用状态，或在 `carrot-home` 单独硬编码/新增重复设置项**：前者在插件停用时会打断工作台基础功能，后者会与用户已在 Periodic Notes 维护的预设产生双份真相。

## Consequences

- `carrot-home` 新增轻量级 `periodic-notes-adapter.js`，零 Node 内置模块依赖以兼容移动端，并在模板缺失时给出 `Notice` 提示后创建空白周志兜底。
- 模板中若出现本插件未实现的 Templater 动态脚本（如 `<% ... %>`），仍需依赖用户后续按需配置 Templater；标准 Periodic Notes 与既有周志占位符均在创建时即时完成替换。
