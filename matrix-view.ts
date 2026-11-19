import {
  ItemView,
  Menu,
  Notice,
  Platform,
  setIcon,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import type ChaiShuMatrixPlugin from "./main";
import {
  BookData,
  CellData,
  DEFAULT_Y_AXIS_LABELS,
  DIMENSION_COLORS,
  Dimension,
  ImportRequest,
  NodeData,
  VIEW_TYPE_CHAISHU_MATRIX,
} from "./types";
import {
  buildChapterPath,
  buildSummaryDimPath,
  cellKey,
  collectChapters,
  collectUncollectedChapters,
  collectUnits,
  collectVolumes,
  createChapterNote,
  createNode,
  createSummaryDimNote,
  ensureReturnFooter,
  findNode,
  findParentArray,
  isSelfOrDescendant,
  removeNode,
  sanitizeFileName,
  sortChapterSiblings,
  stripFrontmatter,
  uid,
} from "./store";
import {
  BookCreateModal,
  ConfirmModal,
  DimensionModal,
  EmotionEditorModal,
  ImportModal,
  MoveNodeModal,
  PromptModal,
  StoragePathModal,
  WallpaperModal,
} from "./modals";

const MAX_PREVIEW = 300;
const SVG_NS = "http://www.w3.org/2000/svg";

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 1.6;

function makeSvg(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** Render a tiny sparkline (or an activity icon when there is no data). */
function renderSparkline(
  el: HTMLElement,
  data: number[],
  color: string,
  width: number,
  height: number
): void {
  el.empty();
  if (!data || data.length < 2) {
    const span = el.createSpan("chs-spark-empty");
    setIcon(span, "activity");
    return;
  }
  const min = 1;
  const max = 5;
  const pad = 1.5;
  const svg = makeSvg("svg", {
    width: String(width),
    height: String(height),
    viewBox: "0 0 " + width + " " + height,
  });
  svg.setAttribute("class", "chs-sparkline");
  const pts: string[] = [];
  const n = data.length;
  for (let i = 0; i < n; i++) {
    const x = pad + (i / (n - 1)) * (width - 2 * pad);
    const y = pad + (1 - (data[i] - min) / (max - min)) * (height - 2 * pad);
    pts.push(x.toFixed(1) + "," + y.toFixed(1));
  }
  const poly = makeSvg("polyline", {
    points: pts.join(" "),
    fill: "none",
    stroke: color,
    "stroke-width": "1.5",
    "stroke-linejoin": "round",
    "stroke-linecap": "round",
  });
  svg.appendChild(poly);
  el.appendChild(svg);
}

/** Emotion values for a node: chapter uses its own; volume/unit aggregate descendants. */
function nodeEmotionData(node: NodeData): number[] {
  if (node.type === "chapter") return node.emotionData ?? [];
  const out: number[] = [];
  for (const ch of collectChapters([node])) out.push(...(ch.emotionData ?? []));
  return out;
}

export class ChaiShuMatrixView extends ItemView {
  plugin: ChaiShuMatrixPlugin;
  activeBookId = "";

  private observer: IntersectionObserver | null = null;
  private saveTimer: number | null = null;

  private wrapEl!: HTMLElement;
  private matrixScrollEl!: HTMLElement;
  private matrixEl!: HTMLTableElement;
  private statsEl!: HTMLElement;
  private selectEl!: HTMLSelectElement;

  // Drag state
  private dragNodeId: string | null = null;
  private dragOverTargetId: string | null = null;
  private dragRafId: number | null = null;

  // Multi-select (quick collection) state
  private selectMode = false;
  private selectedChapterIds = new Set<string>();
  private selectBarEl!: HTMLElement;
  private selectCountEl!: HTMLElement;
  // Pinch-to-zoom state (V2.0)
  private pinchDist = 0;
  private pinchZoom = 1;

  constructor(leaf: WorkspaceLeaf, plugin: ChaiShuMatrixPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAISHU_MATRIX;
  }

  getDisplayText(): string {
    return "ChaiShu Matrix Pro";
  }

  getIcon(): string {
    return "layout-grid";
  }

  private get settings() {
    return this.plugin.getSettings();
  }

  private get book(): BookData | null {
    return this.settings.books.find((b) => b.id === this.activeBookId) ?? null;
  }

  private getChartDim(): Dimension | undefined {
    return this.book?.dimensions.find((d) => d.isChart);
  }

  async onOpen(): Promise<void> {
    const books = this.settings.books;
    if (this.settings.activeBookId && books.some((b) => b.id === this.settings.activeBookId)) {
      this.activeBookId = this.settings.activeBookId;
    } else if (books.length > 0) {
      this.activeBookId = books[0].id;
    } else {
      this.activeBookId = "";
    }
    this.render();
  }

  async onClose(): Promise<void> {
    this.observer?.disconnect();
    this.observer = null;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.dragRafId !== null) cancelAnimationFrame(this.dragRafId);
    this.dragRafId = null;
    this.plugin.views.delete(this);
    this.contentEl.empty();
  }

  refresh(): void {
    const books = this.settings.books;
    if (!books.some((b) => b.id === this.activeBookId)) {
      this.activeBookId = books[0]?.id ?? "";
      this.settings.activeBookId = this.activeBookId;
    }
    this.render();
  }

  // ================================================================ render

  private render(): void {
    const prevScroll = this.matrixScrollEl
      ? { left: this.matrixScrollEl.scrollLeft, top: this.matrixScrollEl.scrollTop }
      : null;
    this.observer?.disconnect();
    this.observer = null;

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chs-view");
    const book = this.book;
    if (book?.bookInfo.bgImage) contentEl.addClass("chs-has-bg");
    else contentEl.removeClass("chs-has-bg");

    this.renderBackground();
    this.wrapEl = contentEl.createDiv("chs-content");

    this.buildTopBar();
    if (!book) {
      this.buildEmptyState();
      return;
    }
    this.buildBookInfo();
    this.buildToolbar();
    this.buildMatrix();
    this.applyZoom();

    if (prevScroll && this.matrixScrollEl) {
      this.matrixScrollEl.scrollLeft = prevScroll.left;
      this.matrixScrollEl.scrollTop = prevScroll.top;
    }
    this.updateStats();
  }

  private renderBackground(): void {
    const book = this.book;
    const bg = this.contentEl.createDiv("chs-bg");
    const mask = this.contentEl.createDiv("chs-bg-mask");
    if (!book?.bookInfo.bgImage) {
      bg.remove();
      mask.remove();
      return;
    }
    const f = this.app.vault.getAbstractFileByPath(book.bookInfo.bgImage);
    if (f instanceof TFile) {
      bg.style.backgroundImage = `url("${this.app.vault.getResourcePath(f)}")`;
    }
    if (book.bookInfo.bgMode === "repeat") {
      bg.style.backgroundSize = "auto";
      bg.style.backgroundRepeat = "repeat";
      bg.style.backgroundPosition = "top left";
    } else {
      bg.style.backgroundSize = "cover";
      bg.style.backgroundPosition = "center";
    }
    mask.style.opacity = String(book.bookInfo.bgOverlay ?? 0.3);
  }

  private buildTopBar(): void {
    const top = this.wrapEl.createDiv("chs-topbar");
    const row = top.createDiv("chs-book-row");

    row.createSpan("chs-book-label").setText("拆书项目");

    this.selectEl = row.createEl("select");
    this.selectEl.addClass("chs-select");
    this.settings.books.forEach((b) => {
      const opt = this.selectEl.createEl("option");
      opt.value = b.id;
      opt.textContent = b.bookInfo.title || "未命名拆书";
    });
    this.selectEl.value = this.activeBookId;
    this.selectEl.addEventListener("change", () => {
      this.activeBookId = this.selectEl.value;
      this.settings.activeBookId = this.activeBookId;
      void this.plugin.saveSettings();
      this.render();
    });

    const addBtn = row.createEl("button", {
      text: "＋ 新建拆书",
      cls: "chs-btn chs-btn-primary",
    });
    addBtn.addEventListener("click", () => this.openCreateBook());

    const delBtn = row.createEl("button", {
      text: "删除",
      cls: "chs-btn chs-btn-ghost chs-btn-danger-text",
    });
    delBtn.addEventListener("click", () => this.deleteCurrentBook());

    const settingsBtn = row.createEl("button", { cls: "chs-icon-btn chs-icon-btn-lg" });
    settingsBtn.setAttribute("aria-label", "拆书设置");
    setIcon(settingsBtn, "settings");
    settingsBtn.addEventListener("click", () => this.openBookSettingsMenu(settingsBtn));

    const wallpaperBtn = row.createEl("button", { cls: "chs-icon-btn chs-icon-btn-lg" });
    wallpaperBtn.setAttribute("aria-label", "上传壁纸");
    setIcon(wallpaperBtn, "image");
    wallpaperBtn.addEventListener("click", () => this.openWallpaper());
  }

  private buildEmptyState(): void {
    const empty = this.wrapEl.createDiv("chs-empty");
    empty.createDiv("chs-empty-title").setText("还没有拆书项目");
    empty.createEl("p", { text: "点击下方按钮创建你的第一个拆书矩阵" });
    const btn = empty.createEl("button", {
      text: "＋ 新建拆书",
      cls: "chs-btn chs-btn-primary",
    });
    btn.addEventListener("click", () => this.openCreateBook());
  }

  private buildBookInfo(): void {
    const book = this.book as BookData;
    const info = this.wrapEl.createDiv("chs-bookinfo");

    this.makeField(info, "拆书名称", book.bookInfo.title, (v) => {
      book.bookInfo.title = v;
      this.syncSelectText();
      this.scheduleSave();
    });
    this.makeField(info, "作者", book.bookInfo.author, (v) => {
      book.bookInfo.author = v;
      this.scheduleSave();
    });
    this.makeField(info, "成绩", book.bookInfo.score, (v) => {
      book.bookInfo.score = v;
      this.scheduleSave();
    });
  }

  private makeField(
    parent: HTMLElement,
    label: string,
    value: string,
    onChange: (v: string) => void
  ): HTMLInputElement {
    const field = parent.createDiv("chs-field");
    field.createSpan("chs-field-label").setText(label);
    const input = field.createEl("input", { type: "text" });
    input.addClass("chs-input");
    input.value = value;
    input.setAttribute("placeholder", label);
    input.addEventListener("input", () => onChange(input.value));
    return input;
  }

  private syncSelectText(): void {
    const book = this.book;
    if (!book || !this.selectEl) return;
    for (const opt of Array.from(this.selectEl.options)) {
      if (opt.value === book.id) opt.textContent = book.bookInfo.title || "未命名拆书";
    }
  }

  private buildToolbar(): void {
    const tb = this.wrapEl.createDiv("chs-toolbar");

    const left = tb.createDiv("chs-toolbar-left");
    left.createSpan("chs-tb-label").setText("章节");
    const countInput = left.createEl("input", { type: "number" });
    countInput.addClass("chs-input", "chs-count-input");
    countInput.min = "1";
    countInput.max = "500";
    countInput.value = String(this.settings.defaultChapterCount || 5);

    const addOne = left.createEl("button", {
      text: "＋ 一键添加",
      cls: "chs-btn chs-btn-primary",
    });
    addOne.addEventListener("click", () => this.addChapters(this.readAddCount(countInput)));
    const add10 = left.createEl("button", { text: "＋10 章", cls: "chs-btn" });
    add10.addEventListener("click", () => this.addChapters(10));
    const add20 = left.createEl("button", { text: "＋20 章", cls: "chs-btn" });
    add20.addEventListener("click", () => this.addChapters(20));

    const mid = tb.createDiv("chs-toolbar-mid");
    const addVol = mid.createEl("button", { text: "＋ 添加卷", cls: "chs-btn" });
    addVol.addEventListener("click", () => this.addVolume());
    const addUnit = mid.createEl("button", { text: "＋ 添加小单元", cls: "chs-btn" });
    addUnit.addEventListener("click", () => this.addUnit());
    const importBtn = mid.createEl("button", { text: "📥 导入", cls: "chs-btn" });
    importBtn.addEventListener("click", () => this.openImportModal());
    const multiBtn = mid.createEl("button", { text: "☑ 多选", cls: "chs-btn" });
    multiBtn.addEventListener("click", () => this.setSelectMode(!this.selectMode));
    const focusBtn = mid.createEl("button", {
      text: this.settings.focusMode ? "👁 专注模式 开" : "👁 专注模式",
      cls: "chs-btn",
    });
    focusBtn.addEventListener("click", () => this.toggleFocusMode());

    this.statsEl = tb.createDiv("chs-stats");

    this.selectBarEl = this.wrapEl.createDiv("chs-selectbar");
    this.renderSelectBar();
  }

  private readAddCount(input: HTMLInputElement): number {
    const n = parseInt(input.value, 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(500, n);
  }

  // ================================================================ matrix

  private buildMatrix(): void {
    this.matrixScrollEl = this.wrapEl.createDiv("chs-matrix-scroll");
    this.matrixEl = this.matrixScrollEl.createEl("table");
    this.matrixEl.addClass("chs-matrix");

    this.matrixScrollEl.addEventListener("click", (e) => this.onMatrixClick(e));
    this.matrixScrollEl.addEventListener("contextmenu", (e) => this.onMatrixContextMenu(e));
    this.matrixScrollEl.addEventListener("dragstart", (e) => this.onDragStart(e));
    this.matrixScrollEl.addEventListener("dragover", (e) => this.onDragOver(e));
    this.matrixScrollEl.addEventListener("drop", (e) => this.onDrop(e));
    this.matrixScrollEl.addEventListener("dragend", () => this.onDragEnd());

    // V2.0: pinch-to-zoom (mobile) — replaces the floating +/- buttons.
    this.matrixScrollEl.addEventListener("touchstart", (e) => this.onPinchStart(e), { passive: true });
    this.matrixScrollEl.addEventListener("touchmove", (e) => this.onPinchMove(e), { passive: false });
    this.matrixScrollEl.addEventListener("touchend", (e) => this.onPinchEnd(e));
    this.matrixScrollEl.addEventListener("touchcancel", (e) => this.onPinchEnd(e));

    this.setupObserver();
    this.renderMatrixRows();
  }

  private renderMatrix(): void {
    if (!this.matrixEl || !this.book) return;
    this.observer?.disconnect();
    this.matrixEl.empty();
    this.setupObserver();
    this.renderMatrixRows();
    this.updateStats();
  }

  private setupObserver(): void {
    this.observer?.disconnect();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const el = entry.target as HTMLElement;
            this.observer?.unobserve(el);
            void this.loadContent(el);
          }
        }
      },
      { root: this.matrixScrollEl ?? null, rootMargin: "120px" }
    );
  }

  private renderMatrixRows(): void {
    const book = this.book as BookData;
    const table = this.matrixEl;
    table.empty();

    const collapsed = this.settings.outlineCollapsed;

    // Fixed column widths (used with `table-layout: fixed` in styles.css).
    // When the outline is collapsed, shrink the node column to match the 34px
    // corner so header labels stay aligned with the data cells (V1.6).
    const colgroup = table.createEl("colgroup");
    const nodeCol = colgroup.createEl("col");
    nodeCol.style.width = collapsed ? "34px" : "var(--chs-node-w, 200px)";
    for (const dim of book.dimensions) {
      const c = colgroup.createEl("col");
      c.style.width = "var(--chs-col-w, 150px)";
    }
    const fillerCol = colgroup.createEl("col");
    fillerCol.style.width = "var(--chs-col-w, 150px)";

    table.toggleClass("chs-outline-collapsed", collapsed);

    const thead = table.createEl("thead");
    const headRow = thead.createEl("tr");
    const corner = headRow.createEl("th", { cls: "chs-corner" });
    this.renderCorner(corner, collapsed);

    for (const dim of book.dimensions) {
      const th = headRow.createEl("th", { cls: "chs-dim-head" });
      th.dataset.dimId = dim.id;
      th.style.setProperty("--chs-color", dim.color);
      const cap = th.createDiv("chs-capsule");
      cap.createSpan("chs-capsule-dot").style.backgroundColor = dim.color;
      cap.createSpan("chs-capsule-name").setText(dim.name + (dim.isChart ? " 📈" : ""));
    }

    const addDimTh = headRow.createEl("th", { cls: "chs-add-dim-head" });
    const addDimBtn = addDimTh.createEl("button", {
      text: "＋ 添加新维度",
      cls: "chs-btn chs-btn-primary chs-btn-sm",
    });
    addDimBtn.addEventListener("click", () => this.openAddDimension());

    const tbody = table.createEl("tbody");
    for (const node of book.structure) {
      this.renderNodeRow(tbody, node, 0);
    }

    const addTr = tbody.createEl("tr", { cls: "chs-add-row" });
    const addChHead = addTr.createEl("td", { cls: "chs-node chs-add-chapter" });
    const addChBtn = addChHead.createEl("button", {
      text: "＋ 添加章节",
      cls: "chs-btn chs-btn-ghost chs-btn-sm",
    });
    addChBtn.addEventListener("click", () => this.addChapters(1));
    for (let i = 0; i < book.dimensions.length + 1; i++) {
      addTr.createEl("td", { cls: "chs-cell-filler" });
    }
  }

  private renderCorner(corner: HTMLElement, collapsed: boolean): void {
    const btn = corner.createEl("button", { cls: "chs-outline-toggle" });
    btn.setAttribute("aria-label", collapsed ? "展开大纲" : "收起大纲");
    setIcon(btn, collapsed ? "chevron-right" : "chevron-left");
    if (!collapsed) {
      corner.createSpan("chs-corner-label").setText("大纲 / 章节");
    }
    btn.addEventListener("click", () => {
      this.settings.outlineCollapsed = !this.settings.outlineCollapsed;
      void this.plugin.saveSettings();
      this.renderMatrix();
    });
  }

  private renderNodeRow(tbody: HTMLElement, node: NodeData, depth: number): void {
    const book = this.book as BookData;

    // V1.8: inverted outline — render children (chapters) ABOVE the volume/unit
    // node, so the first rows are concrete chapters instead of blank containers.
    if (node.type !== "chapter" && !node.collapsed) {
      for (const child of node.children) {
        this.renderNodeRow(tbody, child, depth + 1);
      }
    }

    const tr = tbody.createEl("tr");

    const nodeTd = tr.createEl("td", { cls: "chs-node" });
    this.renderNodeCell(nodeTd, node, depth);

    if (node.type === "chapter") {
      for (const dim of book.dimensions) {
        const td = tr.createEl("td", { cls: "chs-cell" });
        td.style.setProperty("--chs-color", dim.color);
        if (dim.isChart) {
          td.dataset.emotionCell = node.id;
          td.dataset.dimId = dim.id;
          this.renderEmotionCell(td, node, dim);
        } else {
          const key = cellKey(node.id, dim.id);
          td.dataset.cellKey = key;
          td.dataset.chapterId = node.id;
          td.dataset.dimId = dim.id;
          this.renderCell(td, key);
        }
      }
      tr.createEl("td", { cls: "chs-cell-filler" });
    } else if (this.settings.focusMode || node.hideContent) {
      // V2.0 focus mode: hide the volume/unit dimension cells (keep the node row).
      const hideTd = tr.createEl("td", { cls: "chs-summary chs-hidden-content" });
      hideTd.setAttribute("colspan", String(book.dimensions.length + 1));
      hideTd.createSpan("chs-summary-hint").setText("已隐藏维度内容");
    } else {
      // V2.0: volume/unit rows mirror chapter rows — one cell per dimension.
      // Non-chart dimensions link to per-dimension summary notes; the chart
      // dimension shows the read-only aggregate emotion sparkline.
      for (const dim of book.dimensions) {
        const td = tr.createEl("td", { cls: "chs-cell chs-summary-dim" });
        td.style.setProperty("--chs-color", dim.color);
        if (dim.isChart) {
          this.renderAggregateEmotionCell(td, node, dim);
        } else {
          td.dataset.summaryNodeId = node.id;
          td.dataset.summaryDimId = dim.id;
          this.renderSummaryDimCell(td, node, dim);
        }
      }
      tr.createEl("td", { cls: "chs-cell-filler" });
    }
  }

  private renderNodeCell(td: HTMLElement, node: NodeData, depth: number): void {
    td.draggable = !this.selectMode;
    td.dataset.nodeId = node.id;
    td.dataset.nodeType = node.type;
    td.style.paddingLeft = depth * 16 + 8 + "px";

    if (this.selectMode && node.type === "chapter") {
      const cb = td.createEl("input", { type: "checkbox" });
      cb.addClass("chs-select-cb");
      cb.checked = this.selectedChapterIds.has(node.id);
      cb.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleSelect(node.id);
      });
    }

    if (node.type !== "chapter") {
      const toggle = td.createSpan("chs-toggle");
      toggle.setText(node.collapsed ? "▶" : "▼");
      toggle.dataset.toggleId = node.id;
    } else {
      td.createSpan("chs-toggle chs-toggle-empty").setText("");
    }

    const icon = td.createSpan("chs-node-icon");
    setIcon(
      icon,
      node.type === "volume" ? "library" : node.type === "unit" ? "layers" : "file-text"
    );
    td.createSpan("chs-node-name").setText(node.name);

    const chartDim = this.getChartDim();
    const chartBtn = td.createEl("button", { cls: "chs-icon-btn chs-node-chart-btn" });
    chartBtn.dataset.chartNodeId = node.id;
    chartBtn.setAttribute("aria-label", "情绪折线");
    renderSparkline(chartBtn, nodeEmotionData(node), chartDim?.color ?? "#3b82f6", 28, 16);

    const more = td.createEl("button", { cls: "chs-icon-btn chs-node-menu-btn" });
    more.dataset.nodeMenuId = node.id;
    more.setAttribute("aria-label", "节点操作");
    setIcon(more, "more-vertical");
  }

  private renderCell(td: HTMLElement, key: string): void {
    const book = this.book as BookData;
    const cell = book.cells[key];
    const fileExists =
      !!cell?.filePath &&
      this.app.vault.getAbstractFileByPath(cell.filePath) instanceof TFile;

    td.empty();
    td.removeClass("is-filled", "is-empty");
    if (fileExists) {
      td.addClass("is-filled");
      td.createDiv("chs-cell-body").setText("…");
      this.observer?.observe(td);
    } else {
      td.addClass("is-empty");
      const plus = td.createDiv("chs-cell-plus");
      setIcon(plus, "plus");
    }
  }

  private renderEmotionCell(td: HTMLElement, node: NodeData, dim: Dimension): void {
    td.empty();
    td.removeClass("is-filled", "is-empty");
    const data = node.emotionData ?? [];
    if (data.length >= 2) {
      td.addClass("is-filled");
      const body = td.createDiv("chs-cell-body");
      renderSparkline(body, data, dim.color, 140, 44);
      body.createDiv("chs-cell-emotion-hint").setText("点击编辑");
    } else {
      td.addClass("is-empty");
      const plus = td.createDiv("chs-cell-plus");
      setIcon(plus, "plus");
    }
  }

  /** V2.0: render one volume/unit per-dimension summary cell. */
  private renderSummaryDimCell(td: HTMLElement, node: NodeData, dim: Dimension): void {
    const filePath = node.summaryFiles?.[dim.id] ?? "";
    const fileExists =
      !!filePath && this.app.vault.getAbstractFileByPath(filePath) instanceof TFile;
    td.empty();
    td.removeClass("is-filled", "is-empty");
    if (fileExists) {
      td.addClass("is-filled");
      td.createDiv("chs-summary-body").setText("…");
      this.observer?.observe(td);
    } else {
      td.addClass("is-empty");
      td.createSpan("chs-summary-hint").setText("+ 添加");
    }
  }

  /** V2.0: chart-dimension cell for a volume/unit (read-only aggregate sparkline). */
  private renderAggregateEmotionCell(td: HTMLElement, node: NodeData, dim: Dimension): void {
    td.empty();
    td.removeClass("is-filled", "is-empty");
    const data = nodeEmotionData(node);
    if (data.length >= 2) {
      td.addClass("is-filled");
      const body = td.createDiv("chs-cell-body");
      renderSparkline(body, data, dim.color, 140, 44);
      body.createDiv("chs-cell-emotion-hint").setText("聚合折线");
    } else {
      td.addClass("is-empty");
      td.createSpan("chs-summary-hint").setText("暂无");
    }
  }

  private async loadContent(el: HTMLElement): Promise<void> {
    if (el.dataset.cellKey) return this.loadCell(el);
    if (el.dataset.summaryNodeId) return this.loadSummaryDim(el);
  }

  private async loadCell(td: HTMLElement): Promise<void> {
    const book = this.book;
    if (!book) return;
    const key = td.dataset.cellKey;
    if (!key) return;
    const cell = book.cells[key];
    if (!cell?.filePath) return;

    const file = this.app.vault.getAbstractFileByPath(cell.filePath);
    if (!(file instanceof TFile)) {
      cell.filePath = "";
      cell.hasContent = false;
      void this.plugin.saveSettings();
      td.removeClass("is-filled");
      td.addClass("is-empty");
      td.empty();
      const plus = td.createDiv("chs-cell-plus");
      setIcon(plus, "plus");
      this.updateStats();
      return;
    }

    let content = "";
    try {
      content = await this.app.vault.cachedRead(file);
    } catch (e) {
      /* ignore transient read errors */
    }
    const body = stripFrontmatter(content).trim();

    td.empty();
    if (!body) {
      td.removeClass("is-filled");
      td.addClass("is-empty");
      const plus = td.createDiv("chs-cell-plus");
      setIcon(plus, "plus");
      td.createSpan("chs-cell-hint").setText("已创建");
      return;
    }

    td.addClass("is-filled");
    const bodyEl = td.createDiv("chs-cell-body");
    bodyEl.setText(body.length > MAX_PREVIEW ? body.slice(0, MAX_PREVIEW) + "…" : body);
  }

  private async loadSummaryDim(td: HTMLElement): Promise<void> {
    const book = this.book;
    if (!book) return;
    const nodeId = td.dataset.summaryNodeId;
    const dimId = td.dataset.summaryDimId;
    if (!nodeId || !dimId) return;
    const node = findNode(book.structure, nodeId);
    if (!node) return;

    const f = node.summaryFiles?.[dimId]
      ? this.app.vault.getAbstractFileByPath(node.summaryFiles[dimId])
      : null;
    td.empty();
    if (!(f instanceof TFile)) {
      if (node.summaryFiles) delete node.summaryFiles[dimId];
      void this.plugin.saveSettings();
      td.removeClass("is-filled");
      td.addClass("is-empty");
      td.createSpan("chs-summary-hint").setText("+ 添加");
      this.updateStats();
      return;
    }

    let content = "";
    try {
      content = await this.app.vault.cachedRead(f);
    } catch (e) {
      /* ignore */
    }
    const body = stripFrontmatter(content).trim();
    if (!body) {
      td.removeClass("is-filled");
      td.addClass("is-empty");
      td.createSpan("chs-summary-hint").setText("+ 添加");
      return;
    }
    td.addClass("is-filled");
    const b = td.createDiv("chs-summary-body");
    b.setText(body.length > 200 ? body.slice(0, 200) + "…" : body);
  }

  // ================================================================ events

  private onMatrixClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;

    const cellEl = t.closest("[data-cell-key]") as HTMLElement | null;
    if (cellEl) {
      this.onCellClick(
        cellEl.dataset.cellKey as string,
        cellEl.dataset.chapterId as string,
        cellEl.dataset.dimId as string
      );
      return;
    }

    const emotionCell = t.closest("[data-emotion-cell]") as HTMLElement | null;
    if (emotionCell) {
      this.openEmotionEditor(emotionCell.dataset.emotionCell as string);
      return;
    }

    const summaryEl = t.closest("[data-summary-node-id]") as HTMLElement | null;
    if (summaryEl) {
      void this.openSummaryDimNote(
        summaryEl.dataset.summaryNodeId as string,
        summaryEl.dataset.summaryDimId as string
      );
      return;
    }

    const toggleEl = t.closest("[data-toggle-id]") as HTMLElement | null;
    if (toggleEl) {
      this.toggleNode(toggleEl.dataset.toggleId as string);
      return;
    }

    const chartBtn = t.closest("[data-chart-node-id]") as HTMLElement | null;
    if (chartBtn) {
      const id = chartBtn.dataset.chartNodeId as string;
      const n = this.book ? findNode(this.book.structure, id) : null;
      if (n?.type === "chapter") this.openEmotionEditor(id);
      return;
    }

    const menuBtn = t.closest("[data-node-menu-id]") as HTMLElement | null;
    if (menuBtn) {
      const rect = menuBtn.getBoundingClientRect();
      this.openNodeMenu(menuBtn.dataset.nodeMenuId as string, { x: rect.left, y: rect.bottom });
      return;
    }

    const dimEl = t.closest("[data-dim-id]") as HTMLElement | null;
    if (dimEl) {
      this.openEditDimension(dimEl.dataset.dimId as string);
      return;
    }

    if (this.selectMode) {
      const nodeEl = t.closest("[data-node-id]") as HTMLElement | null;
      if (nodeEl && nodeEl.dataset.nodeType === "chapter") {
        const cb = nodeEl.querySelector(".chs-select-cb") as HTMLInputElement | null;
        if (cb) cb.checked = !cb.checked;
        this.toggleSelect(nodeEl.dataset.nodeId as string);
      }
      return;
    }
  }

  private onMatrixContextMenu(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const cellEl = t.closest("[data-cell-key]") as HTMLElement | null;
    if (cellEl) {
      e.preventDefault();
      this.openCellMenu(cellEl);
      return;
    }
    const nodeEl = t.closest("[data-node-id]") as HTMLElement | null;
    if (nodeEl) {
      e.preventDefault();
      const menu = this.buildNodeMenu(nodeEl.dataset.nodeId as string);
      if (menu) menu.showAtMouseEvent(e);
      return;
    }
  }

  private openCellMenu(cellEl: HTMLElement): void {
    const book = this.book;
    if (!book) return;
    const key = cellEl.dataset.cellKey as string;
    const chapterId = cellEl.dataset.chapterId as string;
    const dimId = cellEl.dataset.dimId as string;
    const cell = book.cells[key];
    const fileExists =
      !!cell?.filePath &&
      this.app.vault.getAbstractFileByPath(cell.filePath) instanceof TFile;

    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("打开笔记")
        .setIcon("external-link")
        .onClick(() => void this.openCellNote(key, chapterId, dimId))
    );
    if (fileExists) {
      menu.addSeparator();
      menu.addItem((i) =>
        i.setTitle("删除笔记").setIcon("trash").onClick(() => this.deleteCellNote(key, cell))
      );
    }
    const rect = cellEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }

  private onCellClick(key: string, chapterId: string, dimId: string): void {
    void this.openCellNote(key, chapterId, dimId);
  }

  /** V1.5: always open the cell note in the main editor (never inline). */
  private async openCellNote(key: string, chapterId: string, dimId: string): Promise<void> {
    const book = this.book;
    if (!book) return;
    const dim = book.dimensions.find((d) => d.id === dimId);
    const chapter = findNode(book.structure, chapterId);
    if (!dim || !chapter) return;
    const cell = book.cells[key] ?? (book.cells[key] = { filePath: "", hasContent: false });
    let file = cell.filePath
      ? this.app.vault.getAbstractFileByPath(cell.filePath)
      : null;
    if (!(file instanceof TFile)) {
      file = await createChapterNote(this.app.vault, book, chapterId, dim, "");
      cell.filePath = file.path;
      cell.hasContent = false;
      await this.plugin.saveSettings();
      this.renderMatrix();
    } else {
      // Add the return-link footer to notes created by older versions.
      await ensureReturnFooter(this.app.vault, file);
    }
    await this.openInEditor(file.path);
  }

  private openEmotionEditor(chapterId: string): void {
    const book = this.book;
    if (!book) return;
    const chapter = findNode(book.structure, chapterId);
    if (!chapter || chapter.type !== "chapter") return;
    const dim = this.getChartDim();
    if (!dim) {
      new Notice("请先添加开启「情绪折线」的维度");
      return;
    }
    new EmotionEditorModal(this.app, {
      title: chapter.name + " · " + dim.name + "折线",
      color: dim.color,
      yAxisLabels: dim.yAxisLabels,
      initial: chapter.emotionData ?? [],
      onSave: async (data) => {
        chapter.emotionData = data;
        await this.plugin.saveSettings();
        this.renderMatrix();
      },
    }).open();
  }

  /** V2.0: open a volume/unit per-dimension summary note in the main editor. */
  private async openSummaryDimNote(nodeId: string, dimId: string): Promise<void> {
    const book = this.book;
    if (!book) return;
    const node = findNode(book.structure, nodeId);
    const dim = book.dimensions.find((d) => d.id === dimId);
    if (!node || node.type === "chapter" || !dim || dim.isChart) return;

    const existingPath = node.summaryFiles?.[dimId] ?? "";
    let file = existingPath
      ? this.app.vault.getAbstractFileByPath(existingPath)
      : null;
    if (!(file instanceof TFile)) {
      file = await createSummaryDimNote(this.app.vault, book, nodeId, dim, "");
      if (!node.summaryFiles) node.summaryFiles = {};
      node.summaryFiles[dimId] = file.path;
      await this.plugin.saveSettings();
      this.renderMatrix();
    } else {
      await ensureReturnFooter(this.app.vault, file);
    }
    await this.openInEditor(file.path);
  }

  private async openInEditor(filePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      new Notice("笔记不存在：" + filePath);
      return;
    }
    // Open in the user's current area, but never clobber the matrix tab itself.
    const workspace = this.app.workspace;
    let leaf = workspace.getLeaf(false);
    if (leaf === this.leaf) {
      leaf = Platform.isMobile ? workspace.getLeaf("tab") : workspace.getLeaf("split");
    }
    await leaf.openFile(file);
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  private deleteCellNote(key: string, cell: CellData): void {
    new ConfirmModal(this.app, {
      title: "删除笔记",
      message: "将删除该单元格对应的笔记文件，此操作不可撤销。",
      confirmText: "删除",
      danger: true,
      onConfirm: async () => {
        const file = cell.filePath
          ? this.app.vault.getAbstractFileByPath(cell.filePath)
          : null;
        if (file instanceof TFile) {
          try {
            await this.app.vault.delete(file);
          } catch (e) {
            /* ignore */
          }
        }
        cell.filePath = "";
        cell.hasContent = false;
        await this.plugin.saveSettings();
        this.renderMatrix();
      },
    }).open();
  }

  private toggleNode(nodeId: string): void {
    const book = this.book;
    if (!book) return;
    const node = findNode(book.structure, nodeId);
    if (!node || node.type === "chapter") return;
    node.collapsed = !node.collapsed;
    void this.plugin.saveSettings();
    this.renderMatrix();
  }

  private toggleHideContent(nodeId: string): void {
    const book = this.book;
    if (!book) return;
    const node = findNode(book.structure, nodeId);
    if (!node || node.type === "chapter") return;
    node.hideContent = !node.hideContent;
    void this.plugin.saveSettings();
    this.renderMatrix();
  }

  private toggleFocusMode(): void {
    this.settings.focusMode = !this.settings.focusMode;
    void this.plugin.saveSettings();
    this.render();
  }

  // ---------------------------------------------------------------- nodes

  private addChapters(n: number): void {
    const book = this.book;
    if (!book) return;
    n = Math.max(1, Math.min(500, Math.floor(n)));
    const start = collectChapters(book.structure).length;
    for (let i = 0; i < n; i++) {
      book.structure.push(createNode("chapter", "第" + (start + i + 1) + "章"));
    }
    void this.plugin.saveSettings();
    this.renderMatrix();
  }

  private addVolume(): void {
    const book = this.book;
    if (!book) return;
    const idx = collectVolumes(book.structure).length + 1;
    book.structure.push(createNode("volume", "第" + idx + "卷"));
    void this.plugin.saveSettings();
    this.renderMatrix();
  }

  private addUnit(): void {
    const book = this.book;
    if (!book) return;
    const idx = collectUnits(book.structure).length + 1;
    book.structure.push(createNode("unit", "第" + idx + "单元"));
    void this.plugin.saveSettings();
    this.renderMatrix();
  }

  private moveNodeRelative(nodeId: string, dir: number): void {
    const book = this.book;
    if (!book) return;
    const arr = findParentArray(book.structure, nodeId);
    if (!arr) return;
    const idx = arr.findIndex((n) => n.id === nodeId);
    const to = idx + dir;
    if (idx === -1 || to < 0 || to >= arr.length) return;
    const [n] = arr.splice(idx, 1);
    arr.splice(to, 0, n);
    void this.syncNodeFiles(n);
    void this.plugin.saveSettings();
    this.renderMatrix();
  }

  /** Natural-sort the chapter siblings of the node's parent (reorder only). */
  private smartSort(nodeId: string): void {
    const book = this.book;
    if (!book) return;
    const arr = findParentArray(book.structure, nodeId);
    if (!arr) return;
    sortChapterSiblings(arr);
    void this.plugin.saveSettings();
    this.renderMatrix();
  }

  // --------------------------------------------------------- multi-select

  private setSelectMode(on: boolean): void {
    this.selectMode = on;
    if (!on) this.selectedChapterIds.clear();
    this.renderSelectBar();
    this.renderMatrix();
  }

  private toggleSelect(id: string): void {
    if (this.selectedChapterIds.has(id)) this.selectedChapterIds.delete(id);
    else this.selectedChapterIds.add(id);
    this.renderSelectBar();
  }

  private renderSelectBar(): void {
    if (!this.selectBarEl) return;
    this.selectBarEl.empty();
    this.selectBarEl.toggleClass("is-visible", this.selectMode);
    if (!this.selectMode) return;

    this.selectCountEl = this.selectBarEl.createSpan("chs-select-count");
    this.selectCountEl.setText("已选 " + this.selectedChapterIds.size + " 章");

    const allBtn = this.selectBarEl.createEl("button", {
      text: "全选",
      cls: "chs-btn chs-btn-sm",
    });
    allBtn.addEventListener("click", () => this.selectAll());

    const moveBtn = this.selectBarEl.createEl("button", {
      text: "移动到…",
      cls: "chs-btn chs-btn-sm",
    });
    moveBtn.addEventListener("click", () => void this.openMoveSelected());

    const collectBtn = this.selectBarEl.createEl("button", {
      text: "＋ 收纳为单元",
      cls: "chs-btn chs-btn-primary chs-btn-sm",
    });
    collectBtn.addEventListener("click", () => void this.collectToUnit());

    const doneBtn = this.selectBarEl.createEl("button", {
      text: "完成",
      cls: "chs-btn chs-btn-sm",
    });
    doneBtn.addEventListener("click", () => this.setSelectMode(false));
  }

  private collectToUnit(): void {
    const book = this.book;
    if (!book) return;
    if (this.selectedChapterIds.size === 0) {
      new Notice("请先勾选要收纳的章节");
      return;
    }
    const idx = collectUnits(book.structure).length + 1;
    new PromptModal(this.app, {
      title: "收纳为单元",
      placeholder: "新单元名称",
      initial: "第" + idx + "单元",
      confirmText: "创建并收纳",
      onConfirm: (name) => void this.doCollectToUnit(name),
    }).open();
  }

  private async doCollectToUnit(name: string): Promise<void> {
    const book = this.book;
    if (!book) return;
    const unit = createNode("unit", sanitizeFileName(name) || "未命名单元");
    const ordered = collectChapters(book.structure).filter((c) =>
      this.selectedChapterIds.has(c.id)
    );
    for (const c of ordered) removeNode(book.structure, c.id);
    unit.children = ordered;
    book.structure.push(unit);
    await this.syncNodeFiles(unit);
    this.selectedChapterIds.clear();
    this.selectMode = false;
    this.renderSelectBar();
    await this.plugin.saveSettings();
    this.render();
  }

  // ----------------------------------------------- multi-select batch ops

  private selectAll(): void {
    const book = this.book;
    if (!book) return;
    const uncollected = collectUncollectedChapters(book.structure);
    const allSelected =
      uncollected.length > 0 &&
      uncollected.every((c) => this.selectedChapterIds.has(c.id));
    if (allSelected) {
      for (const c of uncollected) this.selectedChapterIds.delete(c.id);
    } else {
      for (const c of uncollected) this.selectedChapterIds.add(c.id);
    }
    this.renderSelectBar();
    this.renderMatrix();
  }

  private openMoveSelected(): void {
    const book = this.book;
    if (!book) return;
    if (this.selectedChapterIds.size === 0) {
      new Notice("请先勾选要移动的章节");
      return;
    }
    const targets: { id: string; name: string; type: "volume" | "unit" }[] = [];
    for (const v of collectVolumes(book.structure)) {
      targets.push({ id: v.id, name: v.name, type: "volume" });
    }
    for (const u of collectUnits(book.structure)) {
      targets.push({ id: u.id, name: u.name, type: "unit" });
    }
    new MoveNodeModal(this.app, {
      targets,
      onSelect: (targetId) => void this.doMoveSelected(targetId),
    }).open();
  }

  private async doMoveSelected(targetId: string | null): Promise<void> {
    const book = this.book;
    if (!book) return;
    const ordered = collectChapters(book.structure).filter((c) =>
      this.selectedChapterIds.has(c.id)
    );
    if (ordered.length === 0) return;

    if (targetId) {
      const target = findNode(book.structure, targetId);
      if (!target || target.type === "chapter") return;
      for (const c of ordered) removeNode(book.structure, c.id);
      target.children = target.children ?? [];
      target.children.push(...ordered);
      target.collapsed = false;
      await this.syncNodeFiles(target);
    } else {
      for (const c of ordered) {
        removeNode(book.structure, c.id);
        book.structure.push(c);
      }
      for (const c of ordered) await this.syncNodeFiles(c);
    }

    this.selectedChapterIds.clear();
    this.selectMode = false;
    this.renderSelectBar();
    await this.plugin.saveSettings();
    this.render();
  }

  // -------------------------------------------------------------- view zoom

  private get zoom(): number {
    return this.settings.matrixZoom || 1;
  }

  private set zoom(z: number) {
    this.settings.matrixZoom = z;
  }

  private isCompactViewport(): boolean {
    return window.matchMedia(
      "(max-width: 640px), (max-height: 500px) and (orientation: landscape)"
    ).matches;
  }

  /** V2.0: apply the pinch zoom + settings-driven cell size to CSS variables. */
  private applyZoom(): void {
    const z = this.zoom;
    const compact = this.isCompactViewport();
    const baseNodeW = compact ? 140 : 200;
    const baseColW = this.settings.cellWidth || 150;
    const cellH = this.settings.cellHeight || 72;
    this.contentEl.style.setProperty("--chs-node-w", Math.round(baseNodeW * z) + "px");
    this.contentEl.style.setProperty("--chs-col-w", Math.round(baseColW * z) + "px");
    this.contentEl.style.setProperty("--chs-cell-h", Math.round(cellH * z) + "px");
    this.contentEl.style.setProperty("--chs-zoom", String(z));
  }

  // ---- pinch-to-zoom (mobile) ----

  private onPinchStart(e: TouchEvent): void {
    if (e.touches.length === 2) {
      this.pinchDist = this.touchDistance(e.touches);
      this.pinchZoom = this.zoom;
    }
  }

  private onPinchMove(e: TouchEvent): void {
    if (e.touches.length !== 2 || this.pinchDist <= 0) return;
    e.preventDefault();
    const dist = this.touchDistance(e.touches);
    const z = this.pinchZoom * (dist / this.pinchDist);
    this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10));
    this.applyZoom();
  }

  private onPinchEnd(e: TouchEvent): void {
    if (e.touches.length < 2 && this.pinchDist > 0) {
      this.pinchDist = 0;
      void this.plugin.saveSettings();
    }
  }

  private touchDistance(touches: TouchList): number {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  private deleteNode(nodeId: string): void {
    const book = this.book;
    if (!book) return;
    const node = findNode(book.structure, nodeId);
    if (!node) return;
    const label = node.type === "volume" ? "卷" : node.type === "unit" ? "单元" : "章节";
    new ConfirmModal(this.app, {
      title: "删除" + label,
      message:
        "将从矩阵中删除「" +
        node.name +
        "」" +
        (node.type !== "chapter" ? "及其所有子节点" : "") +
        "（仓库中的笔记文件不会被删除）。",
      confirmText: "删除",
      danger: true,
      onConfirm: async () => {
        removeNode(book.structure, nodeId);
        await this.plugin.saveSettings();
        this.render();
      },
    }).open();
  }

  private buildNodeMenu(nodeId: string): Menu | null {
    const book = this.book;
    if (!book) return null;
    const node = findNode(book.structure, nodeId);
    if (!node) return null;

    const menu = new Menu();
    if (node.type !== "chapter") {
      menu.addItem((i) =>
        i
          .setTitle(node.collapsed ? "展开" : "折叠")
          .setIcon("chevrons-up-down")
          .onClick(() => this.toggleNode(nodeId))
      );
      menu.addItem((i) =>
        i
          .setTitle(node.hideContent ? "显示该行维度内容" : "隐藏该行维度内容")
          .setIcon("eye-off")
          .onClick(() => this.toggleHideContent(nodeId))
      );
    }
    if (node.type === "chapter") {
      menu.addItem((i) =>
        i.setTitle("编辑情绪折线").setIcon("activity").onClick(() => this.openEmotionEditor(nodeId))
      );
    }
    menu.addItem((i) =>
      i.setTitle("移动到…").setIcon("folder-input").onClick(() => this.openMoveNodeModal(nodeId))
    );
    menu.addItem((i) =>
      i.setTitle("上移").setIcon("arrow-up").onClick(() => this.moveNodeRelative(nodeId, -1))
    );
    menu.addItem((i) =>
      i.setTitle("下移").setIcon("arrow-down").onClick(() => this.moveNodeRelative(nodeId, 1))
    );
    menu.addItem((i) =>
      i.setTitle("智能排序").setIcon("list-ordered").onClick(() => this.smartSort(nodeId))
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("删除" + (node.type === "volume" ? "卷" : node.type === "unit" ? "单元" : "章节"))
        .setIcon("trash")
        .onClick(() => this.deleteNode(nodeId))
    );
    return menu;
  }

  private openNodeMenu(nodeId: string, pos: { x: number; y: number }): void {
    const menu = this.buildNodeMenu(nodeId);
    if (menu) menu.showAtPosition(pos);
  }

  private openMoveNodeModal(nodeId: string): void {
    const book = this.book;
    if (!book) return;
    const node = findNode(book.structure, nodeId);
    if (!node) return;
    const targets: { id: string; name: string; type: "volume" | "unit" }[] = [];
    if (node.type === "chapter" || node.type === "unit") {
      for (const v of collectVolumes(book.structure)) {
        targets.push({ id: v.id, name: v.name, type: "volume" });
      }
    }
    if (node.type === "chapter") {
      for (const u of collectUnits(book.structure)) {
        targets.push({ id: u.id, name: u.name, type: "unit" });
      }
    }
    new MoveNodeModal(this.app, {
      targets,
      onSelect: (targetId) => {
        void this.performMove(nodeId, targetId);
      },
    }).open();
  }

  // ---------------------------------------------------------- drag & drop

  private onDragStart(e: DragEvent): void {
    const nodeEl = (e.target as HTMLElement).closest("[data-node-id]") as HTMLElement | null;
    if (!nodeEl) {
      e.preventDefault();
      return;
    }
    const id = nodeEl.dataset.nodeId as string;
    this.dragNodeId = id;
    if (e.dataTransfer) {
      e.dataTransfer.setData("text/plain", id);
      e.dataTransfer.effectAllowed = "move";
    }
    nodeEl.addClass("is-dragging");
  }

  private onDragOver(e: DragEvent): void {
    if (!this.dragNodeId) return;
    const targetEl = (e.target as HTMLElement).closest("[data-node-id]") as HTMLElement | null;
    const targetId = targetEl ? (targetEl.dataset.nodeId as string) : null;
    if (!targetId || this.canDropOnto(this.dragNodeId, targetId)) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    }
    // Throttle highlight updates to one per animation frame (reduces drag jank).
    if (this.dragRafId === null) {
      this.dragRafId = requestAnimationFrame(() => {
        this.dragRafId = null;
        if (!this.dragNodeId) return;
        if (!targetId || this.canDropOnto(this.dragNodeId, targetId)) {
          this.setDragHighlight(targetId);
        } else {
          this.setDragHighlight(null);
        }
      });
    }
  }

  private onDrop(e: DragEvent): void {
    e.preventDefault();
    const draggedId = this.dragNodeId;
    if (!draggedId) return;
    const targetEl = (e.target as HTMLElement).closest("[data-node-id]") as HTMLElement | null;
    const targetId = targetEl ? (targetEl.dataset.nodeId as string) : null;
    void this.performMove(draggedId, targetId);
  }

  private onDragEnd(): void {
    this.dragNodeId = null;
    this.dragOverTargetId = null;
    if (this.dragRafId !== null) {
      cancelAnimationFrame(this.dragRafId);
      this.dragRafId = null;
    }
    this.matrixEl?.querySelectorAll(".chs-drop-target").forEach((el) => el.removeClass("chs-drop-target"));
    this.matrixEl?.querySelectorAll(".chs-drop-root").forEach((el) => el.removeClass("chs-drop-root"));
    this.matrixEl?.querySelectorAll(".is-dragging").forEach((el) => el.removeClass("is-dragging"));
  }

  private setDragHighlight(targetId: string | null): void {
    if (this.dragOverTargetId === targetId) return;
    this.matrixEl?.querySelectorAll(".chs-drop-target").forEach((el) => el.removeClass("chs-drop-target"));
    this.matrixEl?.querySelectorAll(".chs-drop-root").forEach((el) => el.removeClass("chs-drop-root"));
    this.dragOverTargetId = targetId;
    if (targetId) {
      this.matrixEl?.querySelector(`[data-node-id="${targetId}"]`)?.addClass("chs-drop-target");
    } else {
      this.matrixEl?.querySelector("tr.chs-add-row")?.addClass("chs-drop-root");
    }
  }

  private canDropOnto(draggedId: string, targetId: string | null): boolean {
    const book = this.book;
    if (!book) return false;
    const dragged = findNode(book.structure, draggedId);
    if (!dragged) return false;
    if (!targetId) return true;
    const target = findNode(book.structure, targetId);
    if (!target) return false;
    if (target.id === dragged.id) return false;
    if (isSelfOrDescendant(target, dragged)) return false;
    if (dragged.type === "volume") return target.type === "volume";
    if (dragged.type === "unit") return target.type === "volume" || target.type === "unit";
    return true;
  }

  private resolveDrop(
    dragged: NodeData,
    target: NodeData | null
  ): { arr: NodeData[]; index: number } | null {
    const book = this.book as BookData;
    if (!target) return { arr: book.structure, index: book.structure.length };
    if (target.type === "volume") {
      if (dragged.type === "volume") {
        const arr = findParentArray(book.structure, target.id);
        if (!arr) return null;
        return { arr, index: arr.indexOf(target) + 1 };
      }
      return { arr: target.children, index: target.children.length };
    }
    if (target.type === "unit") {
      if (dragged.type === "unit") {
        const arr = findParentArray(book.structure, target.id);
        if (!arr) return null;
        return { arr, index: arr.indexOf(target) + 1 };
      }
      return { arr: target.children, index: target.children.length };
    }
    const arr = findParentArray(book.structure, target.id);
    if (!arr) return null;
    return { arr, index: arr.indexOf(target) + 1 };
  }

  private async performMove(draggedId: string, targetId: string | null): Promise<void> {
    const book = this.book;
    if (!book) return;
    const dragged = findNode(book.structure, draggedId);
    if (!dragged) return;
    if (!this.canDropOnto(draggedId, targetId)) return;
    const target = targetId ? findNode(book.structure, targetId) : null;
    const drop = this.resolveDrop(dragged, target);
    if (!drop) return;

    const oldArr = findParentArray(book.structure, draggedId);
    const oldIndex = oldArr ? oldArr.indexOf(dragged) : -1;
    removeNode(book.structure, draggedId);

    let index = drop.index;
    if (oldArr === drop.arr && oldIndex !== -1 && oldIndex < drop.index) index -= 1;
    index = Math.max(0, Math.min(index, drop.arr.length));
    drop.arr.splice(index, 0, dragged);

    // V1.5: after a chapter is moved, natural-sort its new siblings (reorder only).
    if (dragged.type === "chapter") sortChapterSiblings(drop.arr);

    await this.syncNodeFiles(dragged);
    await this.plugin.saveSettings();
    this.render();
  }

  /** Move the actual note files of a node subtree to match its new location. */
  private async syncNodeFiles(node: NodeData): Promise<void> {
    const book = this.book;
    if (!book) return;

    const chapters = node.type === "chapter" ? [node] : collectChapters([node]);
    for (const ch of chapters) {
      for (const dim of book.dimensions) {
        if (dim.isChart) continue;
        const key = cellKey(ch.id, dim.id);
        const cell = book.cells[key];
        if (!cell?.filePath) continue;
        const newPath = buildChapterPath(book, ch.id, dim.name);
        if (newPath === cell.filePath) continue;
        const f = this.app.vault.getAbstractFileByPath(cell.filePath);
        if (f instanceof TFile) {
          try {
            await this.app.fileManager.renameFile(f, newPath);
          } catch (e) {
            /* skip on conflict */
          }
        }
        cell.filePath = newPath;
      }
    }

    const summaryNodes: NodeData[] = [];
    if (node.type === "volume") summaryNodes.push(node, ...collectUnits([node]));
    else if (node.type === "unit") summaryNodes.push(node);
    for (const sn of summaryNodes) {
      const files = sn.summaryFiles ?? {};
      for (const dim of book.dimensions) {
        if (dim.isChart) continue;
        const oldPath = files[dim.id];
        if (!oldPath) continue;
        const newPath = buildSummaryDimPath(book, sn.id, dim.name);
        if (newPath === oldPath) continue;
        const f = this.app.vault.getAbstractFileByPath(oldPath);
        if (f instanceof TFile) {
          try {
            await this.app.fileManager.renameFile(f, newPath);
          } catch (e) {
            /* skip */
          }
        }
        files[dim.id] = newPath;
      }
    }
  }

  // ------------------------------------------------------------ dimensions

  private openAddDimension(): void {
    const book = this.book;
    if (!book) return;
    new DimensionModal(this.app, {
      title: "添加新维度",
      onSave: async (name, color, isChart, yAxisLabels) => {
        const dim: Dimension = {
          id: uid("d"),
          name: sanitizeFileName(name),
          color,
          isChart: isChart || name === "情绪",
          yAxisLabels: yAxisLabels,
        };
        book.dimensions.push(dim);
        await this.plugin.saveSettings();
        this.render();
      },
    }).open();
  }

  private openEditDimension(dimId: string): void {
    const book = this.book;
    if (!book) return;
    const dim = book.dimensions.find((d) => d.id === dimId);
    if (!dim) return;

    new DimensionModal(this.app, {
      title: "编辑维度",
      initial: dim,
      onSave: async (name, color, isChart, yAxisLabels) => {
        const newName = sanitizeFileName(name);
        dim.color = color;
        dim.isChart = isChart || newName === "情绪";
        dim.yAxisLabels = yAxisLabels;
        if (newName !== dim.name) {
          await this.plugin.renameDimension(book.id, dim.id, newName);
        } else {
          await this.plugin.saveSettings();
          this.render();
        }
      },
      onDelete: () => {
        new ConfirmModal(this.app, {
          title: "删除维度",
          message: "将删除维度「" + dim.name + "」及其矩阵列（仓库中的笔记文件保留）。",
          confirmText: "删除",
          danger: true,
          onConfirm: async () => {
            book.dimensions = book.dimensions.filter((d) => d.id !== dimId);
            await this.plugin.saveSettings();
            this.render();
          },
        }).open();
      },
    }).open();
  }

  // ---------------------------------------------------------- import

  private openImportModal(): void {
    const book = this.book;
    if (!book) return;
    const chapters = collectChapters(book.structure).map((c) => ({ id: c.id, name: c.name }));
    const dimensions = book.dimensions.filter((d) => !d.isChart).map((d) => ({ id: d.id, name: d.name }));
    if (chapters.length === 0) {
      new Notice("请先添加章节");
      return;
    }
    if (dimensions.length === 0) {
      new Notice("请先添加维度");
      return;
    }
    new ImportModal(this.app, {
      chapters,
      dimensions,
      onImport: (req) => void this.handleImport(req),
    }).open();
  }

  private async handleImport(req: ImportRequest): Promise<void> {
    const book = this.book;
    if (!book) return;
    const chapter = findNode(book.structure, req.chapterId);
    const dim = book.dimensions.find((d) => d.id === req.dimensionId);
    if (!chapter || !dim || dim.isChart) {
      new Notice("目标章节或维度无效");
      return;
    }
    const key = cellKey(chapter.id, dim.id);
    try {
      if (req.sourceType === "external") {
        const body = stripFrontmatter(req.content ?? "");
        const file = await createChapterNote(this.app.vault, book, chapter.id, dim, body);
        const cell = book.cells[key] ?? (book.cells[key] = { filePath: "", hasContent: false });
        cell.filePath = file.path;
        cell.hasContent = body.trim().length > 0;
      } else {
        const srcFile = req.vaultPath
          ? this.app.vault.getAbstractFileByPath(req.vaultPath)
          : null;
        if (!(srcFile instanceof TFile)) {
          new Notice("找不到库内笔记");
          return;
        }
        const targetPath = buildChapterPath(book, chapter.id, dim.name);
        let file = srcFile;
        if (req.move && srcFile.path !== targetPath) {
          await this.app.fileManager.renameFile(srcFile, targetPath);
          const moved = this.app.vault.getAbstractFileByPath(targetPath);
          if (moved instanceof TFile) file = moved;
        }
        const cell = book.cells[key] ?? (book.cells[key] = { filePath: "", hasContent: false });
        cell.filePath = file.path;
        cell.hasContent = true;
      }
      await this.plugin.saveSettings();
      this.renderMatrix();
      new Notice("导入成功");
    } catch (e) {
      new Notice("导入失败");
    }
  }

  // -------------------------------------------------------- book settings

  private openBookSettingsMenu(btn: HTMLElement): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("壁纸与背景").setIcon("image").onClick(() => this.openWallpaper())
    );
    menu.addItem((i) =>
      i.setTitle("拆书存放位置").setIcon("folder").onClick(() => this.openStoragePath())
    );
    const rect = btn.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }

  private openWallpaper(): void {
    const book = this.book;
    if (!book) return;
    new WallpaperModal(this.app, {
      bgImage: book.bookInfo.bgImage,
      bgMode: book.bookInfo.bgMode,
      bgOverlay: book.bookInfo.bgOverlay,
      onApply: async (patch) => {
        if (patch.bgImage !== undefined) book.bookInfo.bgImage = patch.bgImage;
        if (patch.bgMode !== undefined) book.bookInfo.bgMode = patch.bgMode;
        if (patch.bgOverlay !== undefined) book.bookInfo.bgOverlay = patch.bgOverlay;
        await this.plugin.saveSettings();
        this.render();
      },
    }).open();
  }

  private openStoragePath(): void {
    const book = this.book;
    if (!book) return;
    new StoragePathModal(this.app, {
      current: book.storagePath,
      onSelect: async (path) => {
        book.storagePath = path;
        await this.plugin.saveSettings();
        this.render();
      },
    }).open();
  }

  openCreateBook(): void {
    new BookCreateModal(this.app, async (title, author) => {
      const settings = this.settings;
      const dims = settings.defaultDimensionNames.split(/[,，、\s]+/).filter(Boolean);
      const dimensions: Dimension[] = dims.map((name, i) => ({
        id: uid("d"),
        name: sanitizeFileName(name),
        color: DIMENSION_COLORS[i % DIMENSION_COLORS.length],
        isChart: name === "情绪",
        yAxisLabels: [...DEFAULT_Y_AXIS_LABELS],
      }));
      const count = Math.max(1, Math.min(500, settings.defaultChapterCount || 5));
      const structure: NodeData[] = [];
      for (let i = 1; i <= count; i++) {
        structure.push(createNode("chapter", "第" + i + "章"));
      }

      const book: BookData = {
        id: uid("book"),
        bookInfo: {
          title,
          author,
          score: "",
          bgImage: "",
          bgMode: "cover",
          bgOverlay: 0.3,
        },
        storagePath: settings.defaultStoragePath || "",
        dimensions: dimensions.length
          ? dimensions
          : [
              {
                id: uid("d"),
                name: "情绪",
                color: DIMENSION_COLORS[0],
                isChart: true,
                yAxisLabels: [...DEFAULT_Y_AXIS_LABELS],
              },
            ],
        structure,
        cells: {},
      };
      settings.books.push(book);
      settings.activeBookId = book.id;
      this.activeBookId = book.id;
      await this.plugin.saveSettings();
      this.render();
    }).open();
  }

  private deleteCurrentBook(): void {
    const book = this.book;
    if (!book) return;
    new ConfirmModal(this.app, {
      title: "删除拆书项目",
      message:
        "将删除项目「" +
        (book.bookInfo.title || "未命名拆书") +
        "」的矩阵数据（仓库中的笔记文件保留）。",
      confirmText: "删除",
      danger: true,
      onConfirm: async () => {
        const settings = this.settings;
        settings.books = settings.books.filter((b) => b.id !== book.id);
        settings.activeBookId = settings.books[0]?.id ?? "";
        this.activeBookId = settings.activeBookId;
        await this.plugin.saveSettings();
        this.render();
      },
    }).open();
  }

  // ================================================================ stats

  private updateStats(): void {
    if (!this.statsEl) return;
    const book = this.book;
    if (!book) return;
    const volumes = collectVolumes(book.structure).length;
    const units = collectUnits(book.structure).length;
    const chapters = collectChapters(book.structure).length;
    const nonChartDims = book.dimensions.filter((d) => !d.isChart).length;
    const total = chapters * book.dimensions.length + (volumes + units) * nonChartDims;
    const filled = this.countFilled();
    const rate = total > 0 ? Math.round((filled / total) * 100) : 0;
    this.statsEl.setText(
      "共 " +
        volumes +
        " 卷 · " +
        units +
        " 单元 · " +
        chapters +
        " 章 · " +
        book.dimensions.length +
        " 个维度 · 填充率 " +
        rate +
        "%"
    );
  }

  private countFilled(): number {
    const book = this.book;
    if (!book) return 0;
    let n = 0;
    for (const ch of collectChapters(book.structure)) {
      for (const d of book.dimensions) {
        if (d.isChart) {
          if ((ch.emotionData?.length ?? 0) >= 2) n++;
          continue;
        }
        const c = book.cells[cellKey(ch.id, d.id)];
        if (
          c?.hasContent &&
          c.filePath &&
          this.app.vault.getAbstractFileByPath(c.filePath) instanceof TFile
        ) {
          n++;
        }
      }
    }
    for (const sn of [...collectVolumes(book.structure), ...collectUnits(book.structure)]) {
      for (const d of book.dimensions) {
        if (d.isChart) continue;
        const p = sn.summaryFiles?.[d.id];
        if (p && this.app.vault.getAbstractFileByPath(p) instanceof TFile) n++;
      }
    }
    return n;
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.plugin.saveSettings();
    }, 400);
  }
}
