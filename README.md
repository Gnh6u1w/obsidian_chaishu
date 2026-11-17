# ChaiShu Matrix Pro（书名矩阵专业版）

> 章节 × 分析维度 的可视化拆书矩阵，深度绑定 Obsidian 笔记系统。
> 每个单元格都可编辑，并对应仓库中的一份真实 `.md` 笔记，按书名与章节自动归档。

- 平台：macOS Obsidian ✅ · iOS Obsidian ✅（`isDesktopOnly: false`）
- 依赖：仅使用 Obsidian API 与浏览器 Web API，**不依赖 Node / Electron API**

---

## 一、功能特性

| 模块 | 说明 |
|---|---|
| 顶部操作栏 | 拆书名称 / 作者 / 成绩，可自由编辑，自动保存 |
| 次级控制栏 | 章节数量输入 + `+一键添加` / `+10章` / `+20章`；实时统计 `共 X 章 · Y 个维度 · 填充率 Z%` |
| 矩阵网格 | 章节为行（Y 轴）、维度为列（X 轴）；表头胶囊标签带自定义颜色；底部 `+ 添加章节`、右侧 `+ 添加新维度` |
| 单元格联动 | 点击空单元格 → 弹窗输入 → 自动创建笔记；点击已填写单元格 → 在 Obsidian 编辑器中打开 |
| 自动归档 | 笔记保存于 `《书名》/第X章/第X章-维度名.md`，并写入 YAML 属性 `维度` / `章节` / `书名` |
| 反向同步 | 监听 `vault` 的 `rename` / `delete` 事件，自动更新单元格中的文件路径引用 |
| 数据持久化 | 矩阵配置通过 `saveData()` 自动保存到插件目录 `data.json` |
| 主题适配 | 使用 Obsidian CSS 变量，自动适配亮 / 暗色主题 |
| 性能 | 单元格内容用 `IntersectionObserver` 懒加载，1000 单元格不卡顿 |

---

## 二、安装说明

### 2.1 准备构建产物

构建完成后，插件目录下应包含以下三个文件：

```
obsidian_chaishu/
├── main.js          # 打包后的插件入口
├── manifest.json    # 插件清单（isDesktopOnly: false）
└── styles.css       # 样式
```

> 仓库中已提交 `main.js`，你也可以自行构建：`npm install && npm run build`。

### 2.2 macOS 安装

1. 打开你的 Obsidian 仓库文件夹（Vault）。
2. 进入 `.obsidian/plugins/` 目录（若不存在 `plugins` 目录则新建）。
3. 在 `plugins` 下新建文件夹，命名为 **`chaishu-matrix-pro`**（必须与 `manifest.json` 中的 `id` 一致）。
4. 将 `main.js`、`manifest.json`、`styles.css` 三个文件复制到该文件夹。
5. 打开 Obsidian → 设置 → 第三方插件：
   - 若提示“关闭安全模式”，请关闭安全模式（Safe Mode）。
   - 在“已安装插件”中找到 **ChaiShu Matrix Pro** 并开启。
6. 点击左侧功能区（Ribbon）的网格图标，或使用命令面板执行「打开拆书矩阵」。

### 2.3 iOS 安装

> iOS 上不能直接运行 shell 脚本，推荐用「手动复制文件」的方式：

1. 将 `main.js`、`manifest.json`、`styles.css` 三个文件放入 iCloud Drive / 文件 App 可访问的位置。
2. 打开 Obsidian iOS，进入你的 Vault（通常位于 iCloud 中的 Obsidian 目录）。
3. 在 Obsidian 的「文件管理器」左侧栏中，点击左下角 **设置 → 第三方插件 → 关闭安全模式**。
4. 在 Obsidian 内，将侧栏的“显示”切换到「所有文件」，找到 `.obsidian/plugins/` 目录：
   - 若看不到隐藏文件夹 `.obsidian`，需先在 iOS「文件」App 中打开该 Vault，显示隐藏文件后再操作。
5. 在 `.obsidian/plugins/` 下新建文件夹 `chaishu-matrix-pro`，把三个文件复制进去。
6. 回到 Obsidian → 设置 → 第三方插件 → 开启 **ChaiShu Matrix Pro**。

> 提示：也可通过 macOS 端安装完成后，依靠 iCloud 同步把 `.obsidian/plugins/chaishu-matrix-pro/` 同步到 iOS 设备（插件文件会随 Vault 一起同步）。

---

## 三、使用说明

1. 打开插件视图，点击 **`＋ 新建拆书`**，输入拆书名称（自动加书名号归档）与作者。
2. 顶部三个输入框可随时修改书名 / 作者 / 成绩，自动保存。
3. 在控制栏输入数量，点 `+一键添加` / `+10章` / `+20章` 增加章节（行）。
4. 点击右上角 **`＋ 添加新维度`**，输入名称并选择颜色，增加维度（列）。
5. 点击 **空单元格（带 `+`）** → 弹窗输入内容 → 保存，自动创建 `《书名》/第X章/第X章-维度名.md`。
6. 点击 **已填写单元格** → 在 Obsidian 编辑器中打开对应笔记，直接编辑（反向同步）。
7. 右键（桌面）单元格可：在编辑器中打开 / 编辑内容 / 删除笔记。
8. 点击章节行首的 `✕` 可移除该行（笔记文件保留，不删除）。

---

## 四、数据模型与存储

- 矩阵配置：`.obsidian/plugins/chaishu-matrix-pro/data.json`
- 笔记归档：`《书名》/第X章/第X章-维度名.md`
- 笔记 YAML 属性：

```yaml
---
维度: 长期期待
章节: 第1章
书名: 《三体》
---
```

---

## 五、移动端兼容性检查清单

| 检查项 | 状态 |
|---|---|
| `manifest.json` 中 `isDesktopOnly: false` | ✅ |
| 不依赖 `fs` / `path` / `child_process` / `electron` / `window.require` / 本地 HTTP server | ✅ |
| 文件读写仅用 `app.vault` / `vault.adapter` / `normalizePath` | ✅ |
| 不使用绝对路径，路径全部 vault 相对 | ✅ |
| 输入框 `font-size ≥ 16px`，避免 iOS 聚焦自动缩放 | ✅ |
| 触控目标高度 ≥ 40px（按钮 / 输入框） | ✅ |
| 顶部信息栏窄屏自动改为单列（`@media 640px`） | ✅ |
| 矩阵容器 `-webkit-overflow-scrolling: touch` + 双轴滚动 | ✅ |
| 单元格弹窗使用 `textarea`（多行、软键盘友好），自动聚焦 | ✅ |
| 章节列 / 维度表头 sticky 吸附（上下 + 左右滚动） | ✅ |
| `onunload` 清理：断开 IntersectionObserver、清除定时器、清空 DOM、detach 视图 | ✅ |
| 亮 / 暗主题适配（使用 Obsidian CSS 变量） | ✅ |
| 1000 单元格：内容懒加载（IntersectionObserver） | ✅ |

---

## 六、验收清单

- [x] `manifest.json` 存在且 `isDesktopOnly: false`
- [x] `main.js` 构建成功（`npm run build` 无报错）
- [x] `styles.css` 存在
- [x] 核心命令：打开拆书矩阵、新建拆书
- [x] Modal：新建拆书 / 维度 / 单元格编辑 / 确认
- [x] 设置页：默认章节数、默认维度、重置数据
- [x] 日记（单元格笔记）创建 / 追加逻辑：自动归档 + YAML 属性
- [x] 章节增加 / 减少（行）
- [x] 维度增加 / 删除（列）、自定义颜色
- [x] 填充率实时计算与显示
- [x] 自动保存到插件 `data.json`
- [x] 反向同步（`vault` rename / delete 事件）
- [x] 未引入任何 Node / Electron API（源码审计通过）
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
