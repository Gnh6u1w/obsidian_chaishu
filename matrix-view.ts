import { ItemView, Menu, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type ChaiShuMatrixPlugin from "./main";
import {
  BookData,
  CellData,
  DIMENSION_COLORS,
  Dimension,
  VIEW_TYPE_CHAISHU_MATRIX,
} from "./types";
import {
  cellKey,
  createCellNote,
  sanitizeFileName,
  stripFrontmatter,
  uid,
} from "./store";
import {
  BookCreateModal,
  CellEditModal,
  ConfirmModal,
  DimensionModal,
} from "./modals";

const MAX_PREVIEW = 300;

export class ChaiShuMatrixView extends ItemView {
  plugin: ChaiShuMatrixPlugin;
  activeBookId = "";

  private observer: IntersectionObserver | null = null;
  private saveTimer: number | null = null;

  private matrixScrollEl!: HTMLElement;
  private matrixEl!: HTMLTableElement;
  private statsEl!: HTMLElement;
  private selectEl!: HTMLSelectElement;

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
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.plugin.views.delete(this);
    this.contentEl.empty();
  }

  /** Refresh the whole view (used by reverse-sync notifications). */
  refresh(): void {
    const books = this.settings.books;
    if (!books.some((b) => b.id === this.activeBookId)) {
      this.activeBookId = books[0]?.id ?? "";
      this.settings.activeBookId = this.activeBookId;
    }
    this.render();
  }

  // ---------------------------------------------------------------- render

  private render(): void {
    const prevScroll = this.matrixScrollEl
      ? { left: this.matrixScrollEl.scrollLeft, top: this.matrixScrollEl.scrollTop }
      : null;
    this.observer?.disconnect();
    this.observer = null;

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chs-view");

    this.buildTopBar();
    if (!this.book) {
      this.buildEmptyState();
      return;
    }
    this.buildBookInfo();
    this.buildToolbar();
    this.buildMatrix();

    if (prevScroll && this.matrixScrollEl) {
      this.matrixScrollEl.scrollLeft = prevScroll.left;
      this.matrixScrollEl.scrollTop = prevScroll.top;
    }
    this.updateStats();
  }

  private buildTopBar(): void {
    const top = this.contentEl.createDiv("chs-topbar");
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
  }

  private buildEmptyState(): void {
    const empty = this.contentEl.createDiv("chs-empty");
    empty.createEl("div", { text: "还没有拆书项目" }).addClass("chs-empty-title");
    empty.createEl("p", { text: "点击下方按钮创建你的第一个拆书矩阵" });
    const btn = empty.createEl("button", {
      text: "＋ 新建拆书",
      cls: "chs-btn chs-btn-primary",
    });
    btn.addEventListener("click", () => this.openCreateBook());
  }

  private buildBookInfo(): void {
    const book = this.book as BookData;
    const info = this.contentEl.createDiv("chs-bookinfo");

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
    const tb = this.contentEl.createDiv("chs-toolbar");

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
    mid.createSpan("chs-tb-label").setText("分析维度");

    this.statsEl = tb.createDiv("chs-stats");
  }

  private readAddCount(input: HTMLInputElement): number {
    const n = parseInt(input.value, 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(500, n);
  }

  private buildMatrix(): void {
    this.matrixScrollEl = this.contentEl.createDiv("chs-matrix-scroll");
    this.matrixEl = this.matrixScrollEl.createEl("table");
    this.matrixEl.addClass("chs-matrix");

    this.matrixScrollEl.addEventListener("click", (e) => this.onMatrixClick(e));
    this.matrixScrollEl.addEventListener("contextmenu", (e) => this.onMatrixContextMenu(e));

    this.setupObserver();
    this.renderMatrixRows();
  }

  /** Rebuild only the table rows (incremental update, keeps scroll container). */
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
            void this.loadCell(el);
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

    // Header: dimensions (columns)
    const thead = table.createEl("thead");
    const headRow = thead.createEl("tr");
    const corner = headRow.createEl("th", { cls: "chs-corner" });
    corner.setText("章节 \\ 维度");

    for (const dim of book.dimensions) {
      const th = headRow.createEl("th", { cls: "chs-dim-head" });
      th.dataset.dimId = dim.id;
      th.style.setProperty("--chs-color", dim.color);
      const cap = th.createDiv("chs-capsule");
      cap.createSpan("chs-capsule-dot").style.backgroundColor = dim.color;
      cap.createSpan("chs-capsule-name").setText(dim.name);
    }

    const addDimTh = headRow.createEl("th", { cls: "chs-add-dim-head" });
    const addDimBtn = addDimTh.createEl("button", {
      text: "＋ 添加新维度",
      cls: "chs-btn chs-btn-primary chs-btn-sm",
    });
    addDimBtn.addEventListener("click", () => this.openAddDimension());

    // Body: chapters (rows) × dimensions (columns)
    const tbody = table.createEl("tbody");
    for (const chapter of book.chapters) {
      const tr = tbody.createEl("tr");

      const chHead = tr.createEl("td", { cls: "chs-chapter-head" });
      chHead.createSpan("chs-chapter-name").setText(chapter);
      const delBtn = chHead.createEl("button", { cls: "chs-icon-btn" });
      delBtn.dataset.chapterDel = chapter;
      delBtn.setAttribute("aria-label", "移除 " + chapter);
      setIcon(delBtn, "x");

      for (const dim of book.dimensions) {
        const key = cellKey(chapter, dim.id);
        const td = tr.createEl("td", { cls: "chs-cell" });
        td.dataset.cellKey = key;
        td.dataset.chapter = chapter;
        td.dataset.dimId = dim.id;
        td.style.setProperty("--chs-color", dim.color);
        this.renderCell(td, key);
      }
      tr.createEl("td", { cls: "chs-cell-filler" });
    }

    // Footer: quick add-chapter row
    const addTr = tbody.createEl("tr", { cls: "chs-add-row" });
    const addChHead = addTr.createEl("td", {
      cls: "chs-chapter-head chs-add-chapter",
    });
    const addChBtn = addChHead.createEl("button", {
      text: "＋ 添加章节",
      cls: "chs-btn chs-btn-ghost chs-btn-sm",
    });
    addChBtn.addEventListener("click", () => this.addChapters(1));
    for (let i = 0; i < book.dimensions.length + 1; i++) {
      addTr.createEl("td", { cls: "chs-cell-filler" });
    }
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

  // ------------------------------------------------------------- events

  private onMatrixClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;

    const cellEl = t.closest("[data-cell-key]") as HTMLElement | null;
    if (cellEl) {
      this.onCellClick(
        cellEl.dataset.cellKey as string,
        cellEl.dataset.chapter as string,
        cellEl.dataset.dimId as string
      );
      return;
    }

    const dimEl = t.closest("[data-dim-id]") as HTMLElement | null;
    if (dimEl) {
      this.openEditDimension(dimEl.dataset.dimId as string);
      return;
    }

    const delEl = t.closest("[data-chapter-del]") as HTMLElement | null;
    if (delEl) {
      this.removeChapter(delEl.dataset.chapterDel as string);
      return;
    }
  }

  private onMatrixContextMenu(e: MouseEvent): void {
    const cellEl = (e.target as HTMLElement).closest("[data-cell-key]") as HTMLElement | null;
    if (!cellEl) return;
    const key = cellEl.dataset.cellKey as string;
    const chapter = cellEl.dataset.chapter as string;
    const dimId = cellEl.dataset.dimId as string;
    const book = this.book;
    if (!book) return;
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
          .onClick(() => void this.openCellEditor(key, chapter, dimId))
      );
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle("删除笔记")
          .setIcon("trash")
          .onClick(() => this.deleteCellNote(key, cell))
      );
    } else {
      menu.addItem((i) =>
        i
          .setTitle("写入内容")
          .setIcon("plus")
          .onClick(() => void this.openCellEditor(key, chapter, dimId))
      );
    }
    menu.showAtMouseEvent(e);
  }

  private onCellClick(key: string, chapter: string, dimId: string): void {
    const book = this.book;
    if (!book) return;
    const cell = book.cells[key];
    const fileExists =
      !!cell?.filePath &&
      this.app.vault.getAbstractFileByPath(cell.filePath) instanceof TFile;
    if (fileExists) {
      void this.openInEditor(cell.filePath);
    } else {
      void this.openCellEditor(key, chapter, dimId);
    }
  }

  private async openCellEditor(key: string, chapter: string, dimId: string): Promise<void> {
    const book = this.book;
    if (!book) return;
    const dim = book.dimensions.find((d) => d.id === dimId);
    if (!dim) return;

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
      title: chapter + " · " + dim.name,
      initialBody,
      onSave: async (body) => {
        const file = await createCellNote(this.app.vault, book, chapter, dim, body);
        const c =
          book.cells[key] ?? (book.cells[key] = { filePath: "", hasContent: false });
        c.filePath = file.path;
        c.hasContent = true;
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

  private addChapters(n: number): void {
    const book = this.book;
    if (!book) return;
    n = Math.max(1, Math.min(500, Math.floor(n)));
    const start = book.chapters.length;
    for (let i = 0; i < n; i++) {
      book.chapters.push("第" + (start + i + 1) + "章");
    }
    void this.plugin.saveSettings();
    this.renderMatrix();
  }

  private removeChapter(chapter: string): void {
    const book = this.book;
    if (!book) return;
    new ConfirmModal(this.app, {
      title: "移除章节",
      message: "将从矩阵中移除 " + chapter + "（仓库中的笔记文件不会被删除）。",
      confirmText: "移除",
      danger: true,
      onConfirm: async () => {
        book.chapters = book.chapters.filter((c) => c !== chapter);
        await this.plugin.saveSettings();
        this.renderMatrix();
      },
    }).open();
  }

  private openAddDimension(): void {
    const book = this.book;
    if (!book) return;
    new DimensionModal(this.app, {
      title: "添加新维度",
      onSave: async (name, color) => {
        book.dimensions.push({ id: uid("d"), name: sanitizeFileName(name), color });
        await this.plugin.saveSettings();
        this.renderMatrix();
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
      onSave: async (name, color) => {
        dim.name = sanitizeFileName(name);
        dim.color = color;
        await this.plugin.saveSettings();
        this.renderMatrix();
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
            this.renderMatrix();
          },
        }).open();
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
      }));
      const count = Math.max(1, Math.min(500, settings.defaultChapterCount || 5));
      const chapters: string[] = [];
      for (let i = 1; i <= count; i++) chapters.push("第" + i + "章");

      const book: BookData = {
        id: uid("book"),
        bookInfo: { title, author, score: "" },
        dimensions: dimensions.length
          ? dimensions
          : [{ id: uid("d"), name: "长期期待", color: DIMENSION_COLORS[0] }],
        chapters,
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

  // ---------------------------------------------------------------- stats

  private updateStats(): void {
    if (!this.statsEl) return;
    const book = this.book;
    if (!book) return;
    const total = book.chapters.length * book.dimensions.length;
    const filled = this.countFilled();
    const rate = total > 0 ? Math.round((filled / total) * 100) : 0;
    this.statsEl.setText(
      "共 " +
        book.chapters.length +
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
    for (const ch of book.chapters) {
      for (const d of book.dimensions) {
        const c = book.cells[cellKey(ch, d.id)];
        if (
          c?.hasContent &&
          c.filePath &&
          this.app.vault.getAbstractFileByPath(c.filePath) instanceof TFile
        ) {
          n++;
        }
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
