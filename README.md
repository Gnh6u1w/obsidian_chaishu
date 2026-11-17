# ChaiShu Matrix Pro（书名矩阵专业版）

> 章节/单元/卷 树形大纲 × 分析维度矩阵，辅以情绪折线画板与壁纸背景。
> 深度绑定 Obsidian 笔记系统：每个单元格、每条总结都对应仓库中的一份真实 `.md` 笔记，按书名自动归档。

- 平台：macOS Obsidian ✅ · iOS Obsidian ✅（`isDesktopOnly: false`）
- 依赖：仅使用 Obsidian API 与浏览器 Web API，**不依赖 Node / Electron API**

---

## 一、功能特性（V1.4）

| 模块 | 说明 |
|---|---|
| 标准标签页 | PC 与移动端均以 Obsidian 标准**全屏标签页**打开（`getLeaf('tab')`），移动端顶部表单+控制栏支持纵向滚动 |
| 树形大纲 | 卷（Volume）→ 单元（Unit）→ 章节（Chapter）三级结构，可折叠/展开、拖拽排序、`移动到…` 树形选择 |
| 矩阵网格 | 章节为行、维度为列；表头胶囊标签带自定义颜色；`+ 添加新维度` |
| 卷/单元总结 | 每个卷、单元可填写「卷总结」「单元总结」，独立笔记归档并纳入填充率 |
| 单元格联动 | 点击空单元格 → 弹窗输入 → 自动创建笔记；点击已填单元格 → 在 Obsidian 编辑器打开 |
| 笔记导入 | 导入本地 `.md/.txt` 文件，或搜索选择库内已有笔记，映射到目标章节×维度单元格（可选移动归档） |
| 情绪折线（就地编辑） | 每章行首显示微型折线缩略图（卷/单元显示整体缩影）；点击弹出**画板 Modal**，鼠标/手指点击拖拽直接绘制，`一键打平`/`清除`/`橡皮擦`，保存即刷新，数据存插件配置 `data.json` |
| 壁纸背景 | 上传图片或从库中选择，支持 cover/repeat、遮罩透明度可调、毛玻璃效果 |
| 存储路径 | 可为每本书设置「拆书文件夹存放位置」，也可在设置页配置默认位置 |
| 维度管理 | 设置面板中可修改维度名称/颜色/折线开关/Y轴层级名，改后表头与笔记「dimension」属性自动同步 |
| 自动归档 | `存放位置/《书名》/卷/单元/章节-维度.md`，注入 YAML `type/book/volume/unit/chapter/dimension` |
| 拖拽同步 | 拖拽/移动章节/单元/卷后，调用 `fileManager.renameFile` 同步移动实际笔记文件 |
| 反向同步 | 监听 `vault` 的 `rename`/`delete` 事件，自动更新路径引用 |
| 数据持久化 | 通过 `saveData()` 自动保存到插件目录 `data.json`（含 V1.0–V1.3 自动迁移） |
| 主题适配 | 使用 Obsidian CSS 变量，亮/暗主题自适应 |
| 性能 | 单元格内容 `IntersectionObserver` 懒加载，1000 单元格不卡顿 |

---

## 二、安装说明

### 2.1 构建产物

构建完成后，插件目录应包含三个文件：

```
obsidian_chaishu/
├── main.js          # 打包后的插件入口
├── manifest.json    # 插件清单（isDesktopOnly: false）
└── styles.css       # 样式
```

> 仓库中已提交 `main.js`；也可自行构建：`npm install && npm run build`。

### 2.2 macOS 安装

1. 打开你的 Obsidian 仓库（Vault）。
2. 进入 `.obsidian/plugins/`（不存在则新建）。
3. 新建文件夹 **`chaishu-matrix-pro`**（必须与 `manifest.json` 的 `id` 一致）。
4. 将 `main.js`、`manifest.json`、`styles.css` 复制进去。
5. Obsidian → 设置 → 第三方插件：关闭安全模式，开启 **ChaiShu Matrix Pro**。
6. 点击左侧功能区网格图标，或命令面板执行「打开拆书矩阵」。

### 2.3 iOS 安装

1. 将三个文件放入 iCloud Drive / 文件 App 可访问的位置。
2. 打开 Obsidian iOS，进入 Vault（通常位于 iCloud）。
3. 设置 → 第三方插件 → 关闭安全模式。
4. 在 Obsidian 侧栏「显示所有文件」，找到 `.obsidian/plugins/`（若看不到 `.obsidian`，先在 iOS「文件」App 中开启显示隐藏文件）。
5. 新建 `chaishu-matrix-pro` 文件夹，把三个文件复制进去。
6. 设置 → 第三方插件 → 开启 **ChaiShu Matrix Pro**。

> 也可在 macOS 端装好后，靠 iCloud 同步 `.obsidian/plugins/chaishu-matrix-pro/` 到 iOS。

---

## 三、使用说明

### 3.1 如何打开插件（找不到入口时看这里）

插件启用后，有三种打开方式：

1. **左侧功能区图标**：Obsidian 最左侧竖排图标栏下方会多出一个「网格」图标，点击即可在**主工作区新标签页**打开。
2. **命令面板**：桌面按 `Cmd/Ctrl + P`，手机点工具栏的「命令」图标 → 输入 `打开拆书矩阵` 或 `ChaiShu`。
3. **设置里确认已启用**：设置 → 第三方插件 → 已安装插件 → 确认「ChaiShu Matrix Pro」开关为开启。

> ⚠️ 如果完全找不到图标/命令，请检查插件文件夹名是否为 **`chaishu-matrix-pro`**（必须与 `manifest.json` 的 `id` 完全一致），然后**完全退出并重启 Obsidian**。

### 3.2 基本操作

1. 打开插件视图 → `＋ 新建拆书`，输入名称与作者。
2. 顶部编辑书名 / 作者 / 成绩，自动保存；`⚙️` 设置壁纸与存放位置，`🖼` 上传壁纸。
3. 控制栏：`+ 添加卷`、`+ 添加小单元`、`+ 一键添加 / +10章 / +20章` 增章节。
4. 点击左侧树节点的 `▶/▼` 折叠/展开；**拖拽**（桌面）或 `⋯` 菜单（移动端）排序/`移动到…`/删除节点。
5. 点击卷/单元的「总结」填写卷总结/单元总结。
6. 点击空单元格（`+`）→ 输入内容 → 保存，自动归档笔记；点击已填单元格 → 在编辑器打开。
7. 右键（桌面）单元格：打开 / 编辑 / 删除笔记；点击工具栏「📥 导入」导入本地或库内笔记。
8. 「情绪」维度（开启折线）下：每章行首有微型折线缩略图；点击行首 `📈` 或该维度单元格的 `+` 会**就地弹出画板**——点击/拖拽直接绘制折线，`一键打平` 生成基准线，`橡皮擦` 删除点，保存后行首缩略图立即刷新（数据存于插件 `data.json`，不建外部笔记）。

---

## 四、数据模型与存储

- 矩阵配置：`.obsidian/plugins/chaishu-matrix-pro/data.json`
- 笔记归档：`存放位置/《书名》/卷/单元/章节-维度.md`
- 总结归档：`存放位置/《书名》/卷/卷总结.md`、`…/单元/单元总结.md`
- 章节笔记 YAML：

```yaml
---
维度: 情绪
章节: 第1章
所属卷: 第一卷 觉醒
所属单元: 单元一 起承转合
书名: 《三体》
---
```

---

## 五、移动端兼容性检查清单

| 检查项 | 状态 |
|---|---|
| `manifest.json` 中 `isDesktopOnly: false` | ✅ |
| 不依赖 `fs`/`path`/`child_process`/`electron`/`window.require`/本地 HTTP server | ✅ |
| 文件读写仅用 `app.vault` / `fileManager` / `normalizePath` | ✅ |
| 不使用绝对路径，路径全部 vault 相对 | ✅ |
| 输入框 `font-size ≥ 16px`，避免 iOS 聚焦自动缩放 | ✅ |
| 触控目标高度 ≥ 40px（按钮/输入框） | ✅ |
| 窄屏（≤640px）顶部信息栏/工具栏自动换行 | ✅ |
| 矩阵容器双轴滚动 + `-webkit-overflow-scrolling: touch` | ✅ |
| 单元格/总结弹窗用 `textarea`（多行、软键盘友好）自动聚焦 | ✅ |
| 树形行首 / 维度表头 sticky 吸附 | ✅ |
| 拖拽：桌面 HTML5 DnD；移动端 `⋯` 菜单（上移/下移/折叠/删除）兜底 | ✅ |
| 情绪折线 SVG 面板 `touch-action: none`，支持触摸绘制 | ✅ |
| 壁纸 `getResourcePath` + 毛玻璃 `backdrop-filter` | ✅ |
| `onunload` 清理：断开 IntersectionObserver、清除定时器、清空 DOM、detach 视图 | ✅ |
| 亮/暗主题适配（Obsidian CSS 变量） | ✅ |
| 1000 单元格懒加载（IntersectionObserver） | ✅ |

---

## 六、验收清单（V1.4）

- [x] `manifest.json` 存在且 `isDesktopOnly: false`，版本 1.4.0
- [x] `main.js` 构建成功（`npm run build` 无报错），`styles.css` 存在
- [x] PC/移动端均以标准全屏标签页打开（`getLeaf('tab')`），移动端顶部表单+控制栏可纵向滚动
- [x] 移动端输入框/按钮紧凑化、自动换行、顶栏整合（新建/删除/设置/壁纸）
- [x] 树形大纲（卷/单元/章节）+ 折叠/展开 + 拖拽 + `移动到…` 树形选择
- [x] 卷总结 / 单元总结（独立笔记 + 纳入填充率）
- [x] 笔记导入（本地 `.md/.txt` + 库内笔记搜索选择 + 可选移动归档）
- [x] 情绪折线：行首缩略图 + 就地弹窗画板（点击/拖拽绘制、一键打平、清除、橡皮擦、保存即刷新）
- [x] 情绪折线数据存插件 `data.json`（`emotionData` 数组），不创建外部笔记
- [x] 卷/单元行首显示整体情绪缩影（聚合后代章节 emotionData）
- [x] 维度管理：设置面板修改名称/颜色/折线开关/Y轴层级，表头与笔记 `dimension` 属性同步
- [x] 壁纸上传（cover/repeat + 遮罩透明度 + 毛玻璃）
- [x] 存储路径选择（每本书 + 全局默认）
- [x] 归档路径 `存放位置/《书名》/卷/单元/章节-维度.md` + YAML `type/book/volume/unit/chapter/dimension` 注入
- [x] 拖拽/移动后 `fileManager.renameFile` 同步移动实际文件
- [x] 反向同步（`vault` rename/delete，含总结笔记）
- [x] 填充率实时计算（含卷/单元总结 + 已绘制情绪折线的章节）
- [x] V1.0–V1.3 → V1.4 数据自动迁移
- [x] 未引入任何 Node/Electron API（源码 + 产物审计通过）
- [x] 兼容 macOS 与 iOS（移动端清单全部通过）

---

## 七、本地构建

```bash
npm install
npm run build   # tsc 类型检查 + esbuild 打包，产出 main.js
npm run dev     # 监听模式
```

---

## 八、许可

MIT
