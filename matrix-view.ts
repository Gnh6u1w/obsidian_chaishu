import {
  ItemView,
  Menu,
  Notice,
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
  EMOTION_LEVELS,
  EmotionPoint,
  ImportRequest,
  NodeData,
  VIEW_TYPE_CHAISHU_MATRIX,
} from "./types";
import {
  buildChapterPath,
  buildSummaryPath,
  cellKey,
  collectChapters,
  collectUnits,
  collectVolumes,
  createChapterNote,
  createNode,
  createSummaryNote,
  findNode,
  findParentArray,
  isSelfOrDescendant,
  normalizeYAxisLabels,
  removeNode,
  sanitizeFileName,
  stripFrontmatter,
  uid,
} from "./store";
import {
  BookCreateModal,
  CellEditModal,
  ConfirmModal,
  DimensionModal,
  ImportModal,
  MoveNodeModal,
  StoragePathModal,
  SummaryModal,
  WallpaperModal,
} from "./modals";

const MAX_PREVIEW = 300;
const SVG_NS = "http://www.w3.org/2000/svg";

// Emotion chart layout (pixels in the SVG coordinate system).
const CHART_PLOT_W = 520;
const CHART_PAD_LEFT = 46;
const CHART_PAD_RIGHT = 16;
const CHART_PAD_TOP = 14;
const CHART_PAD_BOTTOM = 30;
const CHART_HEIGHT = 210;

function makeSvg(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** Aggregate per-chapter emotion points into one macro 0..100 line. */
function aggregateEmotions(book: BookData, chapters: NodeData[]): EmotionPoint[] {
  const n = chapters.length;
  const out: EmotionPoint[] = [];
  chapters.forEach((ch, i) => {
    const pts = book.chapterEmotions[ch.id] ?? [];
    const start = n > 0 ? (i / n) * 100 : 0;
    const w = n > 0 ? 100 / n : 100;
    for (const p of pts) {
      out.push({ x: start + (p.x / 100) * w, y: p.y });
    }
  });
  return out.sort((a, b) => a.x - b.x);
}

export class ChaiShuMatrixView extends ItemView {
  plugin: ChaiShuMatrixPlugin;
  activeBookId = "";

  private observer: IntersectionObserver | null = null;
  private saveTimer: number | null = null;
  private chartSaveTimer: number | null = null;

  private wrapEl!: HTMLElement;
  private matrixScrollEl!: HTMLElement;
  private matrixEl!: HTMLTableElement;
  private statsEl!: HTMLElement;
  private selectEl!: HTMLSelectElement;

  // Chart state
  private chartPanelEl: HTMLElement | null = null;
  private chartBodyEl: HTMLElement | null = null;
  private chartSvgEl: SVGSVGElement | null = null;
  private chartPolyEl: SVGElement | null = null;
  private chartPointsEl: SVGElement | null = null;
  private chartCollapsed = false;
  private chartEraser = false;
  private chartPointerDown = false;
  private activeChartDimId = "";
  private chartLevel: "volume" | "unit" | "chapter" = "chapter";
  private activeChartNodeId = "";

  // Drag state
  private dragNodeId: string | null = null;
  private dragOverTargetId: string | null = null;

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
    if (this.chartSaveTimer !== null) window.clearTimeout(this.chartSaveTimer);
    this.saveTimer = null;
    this.chartSaveTimer = null;
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
    this.chartPanelEl = null;

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
    this.buildChartPanel();
    this.buildMatrix();

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

    this.statsEl = tb.createDiv("chs-stats");
  }

  private readAddCount(input: HTMLInputElement): number {
    const n = parseInt(input.value, 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(500, n);
  }

  // ================================================================ chart

  private chartX(x: number): number {
    return CHART_PAD_LEFT + (x / 100) * CHART_PLOT_W;
  }

  private chartY(level: number): number {
    const plotH = CHART_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM;
    return CHART_PAD_TOP + ((EMOTION_LEVELS - level) / (EMOTION_LEVELS - 1)) * plotH;
  }

  private levelNodes(): NodeData[] {
    const book = this.book;
    if (!book) return [];
    if (this.chartLevel === "chapter") return collectChapters(book.structure);
    if (this.chartLevel === "unit") return collectUnits(book.structure);
    return collectVolumes(book.structure);
  }

  private levelLabel(): string {
    return this.chartLevel === "chapter" ? "章节" : this.chartLevel === "unit" ? "单元" : "卷";
  }

  private buildChartPanel(): void {
    this.chartPanelEl?.remove();
    this.chartPanelEl = null;
    this.chartBodyEl = null;
    this.chartSvgEl = null;
    this.chartPolyEl = null;
    this.chartPointsEl = null;

    const book = this.book as BookData;
    const chartDims = book.dimensions.filter((d) => d.isChart);
    if (chartDims.length === 0) return;

    if (!chartDims.some((d) => d.id === this.activeChartDimId)) {
      this.activeChartDimId = chartDims[0].id;
    }
    const levelNodes = this.levelNodes();
    if (!levelNodes.some((n) => n.id === this.activeChartNodeId)) {
      this.activeChartNodeId = levelNodes[0]?.id ?? "";
    }

    const panel = this.wrapEl.createDiv("chs-chart-panel");
    this.chartPanelEl = panel;
    const head = panel.createDiv("chs-chart-head");

    const toggle = head.createSpan("chs-toggle");
    toggle.setText(this.chartCollapsed ? "▶" : "▼");
    toggle.addEventListener("click", () => {
      this.chartCollapsed = !this.chartCollapsed;
      this.renderChart();
    });

    head.createSpan("chs-chart-title").setText("📈 情绪折线");

    if (chartDims.length > 1) {
      const sel = head.createEl("select");
      sel.addClass("chs-select", "chs-chart-dim-select");
      for (const d of chartDims) {
        const o = sel.createEl("option");
        o.value = d.id;
        o.textContent = d.name;
      }
      sel.value = this.activeChartDimId;
      sel.addEventListener("change", () => {
        this.activeChartDimId = sel.value;
        this.renderChart();
      });
    }

    const levelSel = head.createEl("select");
    levelSel.addClass("chs-select", "chs-chart-level-select");
    levelSel.createEl("option", { value: "chapter", text: "章节" });
    levelSel.createEl("option", { value: "unit", text: "单元" });
    levelSel.createEl("option", { value: "volume", text: "卷" });
    levelSel.value = this.chartLevel;
    levelSel.addEventListener("change", () => {
      this.chartLevel = levelSel.value as "volume" | "unit" | "chapter";
      const ln = this.levelNodes();
      this.activeChartNodeId = ln[0]?.id ?? "";
      this.buildChartPanel();
    });

    const nodeSel = head.createEl("select");
    nodeSel.addClass("chs-select", "chs-chart-node-select");
    for (const n of levelNodes) {
      const o = nodeSel.createEl("option");
      o.value = n.id;
      o.textContent = n.name;
    }
    nodeSel.value = this.activeChartNodeId;
    nodeSel.addEventListener("change", () => {
      this.activeChartNodeId = nodeSel.value;
      this.renderChart();
    });

    if (this.chartLevel === "chapter") {
      const eraser = head.createEl("button", {
        cls: "chs-btn chs-btn-sm",
        text: "🧽 橡皮擦",
      });
      eraser.addEventListener("click", () => {
        this.chartEraser = !this.chartEraser;
        eraser.toggleClass("chs-btn-primary", this.chartEraser);
      });

      const clear = head.createEl("button", {
        cls: "chs-btn chs-btn-sm chs-btn-ghost",
        text: "清除",
      });
      clear.addEventListener("click", () => {
        const b = this.book;
        const n = b ? findNode(b.structure, this.activeChartNodeId) : null;
        if (b && n) {
          b.chapterEmotions[n.id] = [];
          void this.plugin.saveSettings();
          this.renderChart();
        }
      });
    } else {
      head.createSpan("chs-chart-readonly").setText("（只读汇总）");
    }

    this.chartBodyEl = panel.createDiv("chs-chart-body");
    this.renderChart();
  }

  private renderChart(): void {
    const book = this.book;
    if (this.chartBodyEl) this.chartBodyEl.toggleClass("is-hidden", this.chartCollapsed);
    if (!this.chartBodyEl || this.chartCollapsed) return;

    this.chartBodyEl.empty();
    this.chartSvgEl = null;
    this.chartPolyEl = null;
    this.chartPointsEl = null;
    if (!book) return;

    const dim = book.dimensions.find((d) => d.id === this.activeChartDimId);
    if (!dim || !dim.isChart) return;

    let node = this.activeChartNodeId
      ? findNode(book.structure, this.activeChartNodeId)
      : null;
    if (!node) {
      const ln = this.levelNodes();
      node = ln[0] ?? null;
      this.activeChartNodeId = node?.id ?? "";
    }
    if (!node) {
      this.chartBodyEl.createDiv("chs-chart-empty").setText("暂无" + this.levelLabel() + "，先创建对应层级节点");
      return;
    }

    const editable = this.chartLevel === "chapter" && node.type === "chapter";
    const labels = normalizeYAxisLabels(dim.yAxisLabels);
    const plotH = CHART_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM;
    const totalW = CHART_PAD_LEFT + CHART_PLOT_W + CHART_PAD_RIGHT;

    const svg = makeSvg("svg", {
      width: String(totalW),
      height: String(CHART_HEIGHT),
    });
    svg.setAttribute("class", "chs-chart-svg");
    svg.style.touchAction = editable ? "none" : "auto";

    // horizontal gridlines for the 5 levels + labels
    for (let level = 1; level <= EMOTION_LEVELS; level++) {
      const y = this.chartY(level);
      const isBaseline = level === 3;
      const line = makeSvg("line", {
        x1: String(CHART_PAD_LEFT),
        x2: String(CHART_PAD_LEFT + CHART_PLOT_W),
        y1: String(y),
        y2: String(y),
      });
      line.style.stroke = "var(--background-modifier-border)";
      line.setAttribute("stroke-width", isBaseline ? "1.5" : "1");
      if (isBaseline) line.setAttribute("stroke-dasharray", "4 3");
      svg.appendChild(line);

      const lbl = makeSvg("text", {
        x: String(CHART_PAD_LEFT - 8),
        y: String(y + 4),
        "text-anchor": "end",
      });
      lbl.textContent = labels[level - 1] ?? String(level);
      lbl.style.fill = isBaseline ? "var(--text-normal)" : "var(--text-muted)";
      lbl.setAttribute("font-size", "11");
      if (isBaseline) lbl.setAttribute("font-weight", "600");
      svg.appendChild(lbl);
    }

    // x-axis line
    const xAxis = makeSvg("line", {
      x1: String(CHART_PAD_LEFT),
      x2: String(CHART_PAD_LEFT + CHART_PLOT_W),
      y1: String(CHART_PAD_TOP + plotH),
      y2: String(CHART_PAD_TOP + plotH),
    });
    xAxis.style.stroke = "var(--background-modifier-border)";
    xAxis.setAttribute("stroke-width", "1");
    svg.appendChild(xAxis);

    const poly = makeSvg("polyline", {
      points: "",
      fill: "none",
      "stroke-width": editable ? "2.5" : "3",
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    });
    poly.setAttribute("stroke", dim.color);
    if (!editable) poly.setAttribute("opacity", "0.7");
    svg.appendChild(poly);
    this.chartPolyEl = poly;

    const pointsG = makeSvg("g", {});
    svg.appendChild(pointsG);
    this.chartPointsEl = pointsG;

    if (editable) {
      svg.style.cursor = "crosshair";
      svg.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this.chartPointerDown = true;
        this.handleChartPointer(e as PointerEvent);
      });
      svg.addEventListener("pointermove", (e) => {
        if (this.chartPointerDown) this.handleChartPointer(e as PointerEvent);
      });
      const stop = () => {
        this.chartPointerDown = false;
      };
      svg.addEventListener("pointerup", stop);
      svg.addEventListener("pointerleave", stop);
    } else {
      svg.style.pointerEvents = "none";
    }

    this.chartBodyEl.appendChild(svg);
    this.chartSvgEl = svg as SVGSVGElement;
    this.updateChartLine();
  }

  private updateChartLine(): void {
    const book = this.book;
    const dim = book?.dimensions.find((d) => d.id === this.activeChartDimId);
    if (!book || !dim || !dim.isChart || !this.chartPolyEl || !this.chartPointsEl) return;

    const node = this.activeChartNodeId
      ? findNode(book.structure, this.activeChartNodeId)
      : null;
    if (!node) return;

    let points: EmotionPoint[];
    if (this.chartLevel === "chapter" && node.type === "chapter") {
      points = (book.chapterEmotions[node.id] ?? []).slice().sort((a, b) => a.x - b.x);
    } else {
      points = aggregateEmotions(book, node.type === "chapter" ? [node] : collectChapters([node]));
    }

    const linePts = points.map((p) => this.chartX(p.x) + "," + this.chartY(p.y));
    this.chartPolyEl.setAttribute("points", linePts.join(" "));
    this.chartPolyEl.setAttribute("stroke", dim.color);

    while (this.chartPointsEl.firstChild) {
      this.chartPointsEl.removeChild(this.chartPointsEl.firstChild);
    }
    for (const p of points) {
      const c = makeSvg("circle", {
        cx: String(this.chartX(p.x)),
        cy: String(this.chartY(p.y)),
        r: "4",
      });
      c.setAttribute("fill", dim.color);
      this.chartPointsEl.appendChild(c);
    }
  }

  private handleChartPointer(e: PointerEvent): void {
    const book = this.book;
    if (!book) return;
    if (this.chartLevel !== "chapter") return;
    const node = findNode(book.structure, this.activeChartNodeId);
    if (!node || node.type !== "chapter") return;

    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const plotH = CHART_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM;

    const arr = book.chapterEmotions[node.id] ?? (book.chapterEmotions[node.id] = []);

    if (this.chartEraser) {
      const idx = arr.findIndex(
        (p) => Math.abs(this.chartX(p.x) - px) < 14 && Math.abs(this.chartY(p.y) - py) < 14
      );
      if (idx !== -1) arr.splice(idx, 1);
    } else {
      const x = Math.max(0, Math.min(100, ((px - CHART_PAD_LEFT) / CHART_PLOT_W) * 100));
      const level = Math.max(
        1,
        Math.min(
          EMOTION_LEVELS,
          Math.round(EMOTION_LEVELS - ((py - CHART_PAD_TOP) / plotH) * (EMOTION_LEVELS - 1))
        )
      );
      const rx = Math.round(x);
      const existing = arr.findIndex((p) => Math.abs(p.x - rx) <= 3);
      if (existing !== -1) arr[existing] = { x: rx, y: level };
      else arr.push({ x: rx, y: level });
    }
    this.updateChartLine();
    this.debounceChartSave();
  }

  private debounceChartSave(): void {
    if (this.chartSaveTimer !== null) window.clearTimeout(this.chartSaveTimer);
    this.chartSaveTimer = window.setTimeout(() => {
      this.chartSaveTimer = null;
      void this.plugin.saveSettings();
    }, 300);
  }

  private openChartForNode(nodeId: string): void {
    const book = this.book;
    if (!book) return;
    const node = findNode(book.structure, nodeId);
    if (!node) return;
    if (!book.dimensions.some((d) => d.isChart)) {
      new Notice("请先在维度设置中开启「情绪折线」");
      return;
    }
    this.chartLevel = node.type as "volume" | "unit" | "chapter";
    this.activeChartNodeId = nodeId;
    this.chartCollapsed = false;
    this.render();
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
    this.renderChart();
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

    const thead = table.createEl("thead");
    const headRow = thead.createEl("tr");
    const corner = headRow.createEl("th", { cls: "chs-corner" });
    corner.setText("大纲 / 章节");

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

  private renderNodeRow(tbody: HTMLElement, node: NodeData, depth: number): void {
    const book = this.book as BookData;
    const tr = tbody.createEl("tr");

    const nodeTd = tr.createEl("td", { cls: "chs-node" });
    this.renderNodeCell(nodeTd, node, depth);

    if (node.type === "chapter") {
      for (const dim of book.dimensions) {
        const key = cellKey(node.id, dim.id);
        const td = tr.createEl("td", { cls: "chs-cell" });
        td.dataset.cellKey = key;
        td.dataset.chapterId = node.id;
        td.dataset.dimId = dim.id;
        td.style.setProperty("--chs-color", dim.color);
        this.renderCell(td, key);
      }
      tr.createEl("td", { cls: "chs-cell-filler" });
    } else {
      const summaryTd = tr.createEl("td", { cls: "chs-summary" });
      summaryTd.dataset.summaryId = node.id;
      summaryTd.setAttribute("colspan", String(book.dimensions.length + 1));
      this.renderSummaryCell(summaryTd, node);
    }

    if (node.type !== "chapter" && !node.collapsed) {
      for (const child of node.children) {
        this.renderNodeRow(tbody, child, depth + 1);
      }
    }
  }

  private renderNodeCell(td: HTMLElement, node: NodeData, depth: number): void {
    td.draggable = true;
    td.dataset.nodeId = node.id;
    td.dataset.nodeType = node.type;
    td.style.paddingLeft = depth * 16 + 8 + "px";

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

    if (node.type !== "chapter") {
      const sbtn = td.createEl("button", {
        cls: "chs-btn chs-btn-sm chs-node-summary-btn",
        text: node.summaryHasContent ? "✓总结" : "总结",
      });
      sbtn.dataset.summaryId = node.id;
    }

    const chartBtn = td.createEl("button", { cls: "chs-icon-btn chs-node-chart-btn" });
    chartBtn.dataset.chartNodeId = node.id;
    chartBtn.setAttribute("aria-label", "情绪折线");
    setIcon(chartBtn, "activity");

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

  private renderSummaryCell(td: HTMLElement, node: NodeData): void {
    const hasSummary =
      node.summaryHasContent &&
      !!node.summaryFile &&
      this.app.vault.getAbstractFileByPath(node.summaryFile) instanceof TFile;
    td.empty();
    td.removeClass("is-filled", "is-empty");
    if (hasSummary) {
      td.addClass("is-filled");
      td.createDiv("chs-summary-body").setText("…");
      this.observer?.observe(td);
    } else {
      td.addClass("is-empty");
      td.createSpan("chs-summary-hint").setText(
        "点击填写" + (node.type === "volume" ? "卷总结" : "单元总结")
      );
    }
  }

  private async loadContent(el: HTMLElement): Promise<void> {
    if (el.dataset.cellKey) return this.loadCell(el);
    if (el.dataset.summaryId) return this.loadSummary(el);
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

  private async loadSummary(td: HTMLElement): Promise<void> {
    const book = this.book;
    if (!book) return;
    const nodeId = td.dataset.summaryId;
    if (!nodeId) return;
    const node = findNode(book.structure, nodeId);
    if (!node) return;

    const f = node.summaryFile
      ? this.app.vault.getAbstractFileByPath(node.summaryFile)
      : null;
    td.empty();
    if (!(f instanceof TFile)) {
      node.summaryFile = "";
      node.summaryHasContent = false;
      void this.plugin.saveSettings();
      td.removeClass("is-filled");
      td.addClass("is-empty");
      td.createSpan("chs-summary-hint").setText(
        "点击填写" + (node.type === "volume" ? "卷总结" : "单元总结")
      );
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
      td.createSpan("chs-summary-hint").setText(
        "点击填写" + (node.type === "volume" ? "卷总结" : "单元总结")
      );
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

    const summaryEl = t.closest("[data-summary-id]") as HTMLElement | null;
    if (summaryEl) {
      void this.openSummaryModal(summaryEl.dataset.summaryId as string);
      return;
    }

    const toggleEl = t.closest("[data-toggle-id]") as HTMLElement | null;
    if (toggleEl) {
      this.toggleNode(toggleEl.dataset.toggleId as string);
      return;
    }

    const chartBtn = t.closest("[data-chart-node-id]") as HTMLElement | null;
    if (chartBtn) {
      this.openChartForNode(chartBtn.dataset.chartNodeId as string);
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
    if (fileExists) {
      menu.addItem((i) =>
        i
          .setTitle("在编辑器中打开")
          .setIcon("external-link")
          .onClick(() => void this.openInEditor(cell.filePath))
      );
      menu.addItem((i) =>
        i
          .setTitle("编辑内容")
          .setIcon("pencil")
          .onClick(() => void this.openCellEditor(key, chapterId, dimId))
      );
      menu.addSeparator();
      menu.addItem((i) =>
        i.setTitle("删除笔记").setIcon("trash").onClick(() => this.deleteCellNote(key, cell))
      );
    } else {
      menu.addItem((i) =>
        i
          .setTitle("写入内容")
          .setIcon("plus")
          .onClick(() => void this.openCellEditor(key, chapterId, dimId))
      );
    }
    const rect = cellEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }

  private onCellClick(key: string, chapterId: string, dimId: string): void {
    const book = this.book;
    if (!book) return;
    const cell = book.cells[key];
    const fileExists =
      !!cell?.filePath &&
      this.app.vault.getAbstractFileByPath(cell.filePath) instanceof TFile;
    if (fileExists) {
      void this.openInEditor(cell.filePath);
    } else {
      void this.openCellEditor(key, chapterId, dimId);
    }
  }

  private async openCellEditor(key: string, chapterId: string, dimId: string): Promise<void> {
    const book = this.book;
    if (!book) return;
    const dim = book.dimensions.find((d) => d.id === dimId);
    const chapterNode = findNode(book.structure, chapterId);
    if (!dim || !chapterNode) return;

    let initialBody = "";
    const cell = book.cells[key];
    if (cell?.filePath) {
      const f = this.app.vault.getAbstractFileByPath(cell.filePath);
      if (f instanceof TFile) {
        try {
          initialBody = stripFrontmatter(await this.app.vault.cachedRead(f));
        } catch (e) {
          /* ignore */
        }
      }
    }

    new CellEditModal(this.app, {
      title: chapterNode.name + " · " + dim.name,
      initialBody,
      onSave: async (body) => {
        const file = await createChapterNote(this.app.vault, book, chapterId, dim, body);
        const c =
          book.cells[key] ?? (book.cells[key] = { filePath: "", hasContent: false });
        c.filePath = file.path;
        c.hasContent = true;
        await this.plugin.saveSettings();
        this.renderMatrix();
      },
    }).open();
  }

  private async openSummaryModal(nodeId: string): Promise<void> {
    const book = this.book;
    if (!book) return;
    const node = findNode(book.structure, nodeId);
    if (!node || node.type === "chapter") return;

    let initialBody = "";
    if (node.summaryFile) {
      const f = this.app.vault.getAbstractFileByPath(node.summaryFile);
      if (f instanceof TFile) {
        try {
          initialBody = stripFrontmatter(await this.app.vault.cachedRead(f));
        } catch (e) {
          /* ignore */
        }
      }
    }

    new SummaryModal(this.app, {
      title: (node.type === "volume" ? "卷总结 · " : "单元总结 · ") + node.name,
      initialBody,
      onSave: async (body) => {
        if (!body.trim()) {
          if (node.summaryFile) {
            const f = this.app.vault.getAbstractFileByPath(node.summaryFile);
            if (f instanceof TFile) {
              try {
                await this.app.vault.delete(f);
              } catch (e) {
                /* ignore */
              }
            }
          }
          node.summaryFile = "";
          node.summaryHasContent = false;
        } else {
          const file = await createSummaryNote(this.app.vault, book, nodeId, body);
          node.summaryFile = file.path;
          node.summaryHasContent = true;
        }
        await this.plugin.saveSettings();
        this.renderMatrix();
      },
    }).open();
  }

  private async openInEditor(filePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    } else {
      new Notice("笔记不存在：" + filePath);
    }
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
          .setTitle("编辑" + (node.type === "volume" ? "卷总结" : "单元总结"))
          .setIcon("pencil")
          .onClick(() => void this.openSummaryModal(nodeId))
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
      this.setDragHighlight(targetId);
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
    // chapter target
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
      if (!sn.summaryFile) continue;
      const newPath = buildSummaryPath(book, sn.id);
      if (newPath === sn.summaryFile) continue;
      const f = this.app.vault.getAbstractFileByPath(sn.summaryFile);
      if (f instanceof TFile) {
        try {
          await this.app.fileManager.renameFile(f, newPath);
        } catch (e) {
          /* skip */
        }
      }
      sn.summaryFile = newPath;
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
          yAxisLabels: normalizeYAxisLabels(yAxisLabels),
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
        dim.yAxisLabels = normalizeYAxisLabels(yAxisLabels);
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
    const dimensions = book.dimensions.map((d) => ({ id: d.id, name: d.name }));
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
    if (!chapter || !dim) {
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
        chapterEmotions: {},
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
    const total = chapters * book.dimensions.length + volumes + units;
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
    const summaryNodes = [...collectVolumes(book.structure), ...collectUnits(book.structure)];
    for (const sn of summaryNodes) {
      if (
        sn.summaryHasContent &&
        sn.summaryFile &&
        this.app.vault.getAbstractFileByPath(sn.summaryFile) instanceof TFile
      ) {
        n++;
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
