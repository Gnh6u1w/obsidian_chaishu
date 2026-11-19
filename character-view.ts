import { ItemView, Menu, Notice, Platform, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type ChaiShuMatrixPlugin from "./main";
import {
  BookData,
  CharacterData,
  Dimension,
  VIEW_TYPE_CHAISHU_CHARACTER,
  VIEW_TYPE_CHAISHU_MATRIX,
} from "./types";
import {
  buildCharacterPath,
  cellKey,
  createCharacterNote,
  sanitizeFileName,
  uid,
} from "./store";
import { ConfirmModal, DimensionModal, PromptModal } from "./modals";

const MAX_PREVIEW = 200;

/** 人设拆解 sub-matrix: rows = characters, columns = character dimensions.
 *  Reuses the same cell↔note interaction as the main 拆书矩阵. */
export class ChaiShuCharacterView extends ItemView {
  plugin: ChaiShuMatrixPlugin;
  bookId = "";

  private observer: IntersectionObserver | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ChaiShuMatrixPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAISHU_CHARACTER;
  }

  getDisplayText(): string {
    return "人设拆解";
  }

  getIcon(): string {
    return "users";
  }

  private get settings() {
    return this.plugin.getSettings();
  }

  private get book(): BookData | null {
    return this.settings.books.find((b) => b.id === this.bookId) ?? null;
  }

  async onOpen(): Promise<void> {
    this.bookId = this.settings.activeBookId;
    this.render();
  }

  async onClose(): Promise<void> {
    this.observer?.disconnect();
    this.observer = null;
    this.contentEl.empty();
  }

  /** Called by the plugin when re-opening this view for a different book. */
  setBook(bookId: string): void {
    this.bookId = bookId;
    this.render();
  }

  render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chs-view", "chs-character-view");

    const book = this.book;
    if (!book) {
      contentEl.createDiv("chs-empty").createDiv("chs-empty-title").setText("没有拆书项目");
      return;
    }

    const top = contentEl.createDiv("chs-topbar");
    const row = top.createDiv("chs-book-row");
    const back = row.createEl("button", { text: "← 返回拆书项目", cls: "chs-btn" });
    back.addEventListener("click", () => void this.returnToMatrix());
    row.createSpan("chs-char-title").setText("人设拆解 · " + book.bookInfo.title);

    const toolbar = contentEl.createDiv("chs-toolbar");
    const left = toolbar.createDiv("chs-toolbar-left");
    const addChar = left.createEl("button", { text: "＋ 添加角色", cls: "chs-btn chs-btn-primary" });
    addChar.addEventListener("click", () => this.addCharacter());
    const addDim = left.createEl("button", { text: "＋ 添加人设维度", cls: "chs-btn" });
    addDim.addEventListener("click", () => this.addCharacterDimension());

    const stats = toolbar.createDiv("chs-stats");
    stats.setText(
      (book.characters.length || 0) + " 个角色 · " + (book.characterDimensions.length || 0) + " 个人设维度"
    );

    this.buildMatrix(book);
  }

  private buildMatrix(book: BookData): void {
    const scroll = this.contentEl.createDiv("chs-matrix-scroll");
    const table = scroll.createEl("table");
    table.addClass("chs-matrix", "chs-character-matrix");

    scroll.addEventListener("contextmenu", (e) => this.onContextMenu(e));

    const colgroup = table.createEl("colgroup");
    const nodeCol = colgroup.createEl("col");
    nodeCol.style.width = "var(--chs-node-w, 200px)";
    for (const _d of book.characterDimensions) {
      const c = colgroup.createEl("col");
      c.style.width = "var(--chs-col-w, 150px)";
    }
    const fillerCol = colgroup.createEl("col");
    fillerCol.style.width = "var(--chs-col-w, 150px)";

    const thead = table.createEl("thead");
    const headRow = thead.createEl("tr");
    const corner = headRow.createEl("th", { cls: "chs-corner" });
    corner.createSpan("chs-corner-label").setText("角色");

    for (const dim of book.characterDimensions) {
      const th = headRow.createEl("th", { cls: "chs-dim-head" });
      th.dataset.charDimId = dim.id;
      th.style.setProperty("--chs-color", dim.color);
      const cap = th.createDiv("chs-capsule");
      cap.createSpan("chs-capsule-dot").style.backgroundColor = dim.color;
      cap.createSpan("chs-capsule-name").setText(dim.name);
    }
    const addDimTh = headRow.createEl("th", { cls: "chs-add-dim-head" });
    const addDimBtn = addDimTh.createEl("button", {
      text: "＋ 维度",
      cls: "chs-btn chs-btn-primary chs-btn-sm",
    });
    addDimBtn.addEventListener("click", () => this.addCharacterDimension());

    const tbody = table.createEl("tbody");
    for (const character of book.characters) {
      const tr = tbody.createEl("tr");
      const nodeTd = tr.createEl("td", { cls: "chs-node" });
      nodeTd.dataset.charId = character.id;
      const icon = nodeTd.createSpan("chs-node-icon");
      setIcon(icon, "user");
      nodeTd.createSpan("chs-node-name").setText(character.name);

      for (const dim of book.characterDimensions) {
        const td = tr.createEl("td", { cls: "chs-cell chs-character-cell" });
        td.style.setProperty("--chs-color", dim.color);
        td.dataset.charCell = character.id;
        td.dataset.charDim = dim.id;
        this.renderCharacterCell(td, character, dim);
      }
      tr.createEl("td", { cls: "chs-cell-filler" });
    }

    // add-character row
    const addTr = tbody.createEl("tr", { cls: "chs-add-row" });
    const addTd = addTr.createEl("td", { cls: "chs-node chs-add-chapter" });
    const addBtn = addTd.createEl("button", {
      text: "＋ 添加角色",
      cls: "chs-btn chs-btn-ghost chs-btn-sm",
    });
    addBtn.addEventListener("click", () => this.addCharacter());
    for (let i = 0; i < book.characterDimensions.length + 1; i++) {
      addTr.createEl("td", { cls: "chs-cell-filler" });
    }

    this.setupObserver(scroll);
    table.addEventListener("click", (e) => this.onClick(e));
  }

  private setupObserver(scroll: HTMLElement): void {
    this.observer?.disconnect();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const el = entry.target as HTMLElement;
            this.observer?.unobserve(el);
            void this.loadCharacterCell(el);
          }
        }
      },
      { root: scroll, rootMargin: "120px" }
    );
  }

  private renderCharacterCell(td: HTMLElement, character: CharacterData, dim: Dimension): void {
    const book = this.book;
    if (!book) return;
    const cell = book.characterCells[cellKey(character.id, dim.id)];
    const fileExists =
      !!cell?.filePath && this.app.vault.getAbstractFileByPath(cell.filePath) instanceof TFile;
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

  private async loadCharacterCell(td: HTMLElement): Promise<void> {
    const book = this.book;
    if (!book) return;
    const charId = td.dataset.charCell;
    const dimId = td.dataset.charDim;
    if (!charId || !dimId) return;
    const cell = book.characterCells[cellKey(charId, dimId)];
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
      return;
    }
    let content = "";
    try {
      content = await this.app.vault.cachedRead(file);
    } catch (e) {
      /* ignore */
    }
    const body = content
      .replace(/^---[\s\S]*?---\s*/, "")
      .replace(/<!-- chs-return -->[\s\S]*$/, "")
      .trim();
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
    td.createDiv("chs-cell-body").setText(body.length > MAX_PREVIEW ? body.slice(0, MAX_PREVIEW) + "…" : body);
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const cellEl = t.closest("[data-char-cell]") as HTMLElement | null;
    if (cellEl) {
      void this.openCharacterNote(cellEl.dataset.charCell as string, cellEl.dataset.charDim as string);
      return;
    }
    const dimEl = t.closest("[data-char-dim-id]") as HTMLElement | null;
    if (dimEl) {
      this.editCharacterDimension(dimEl.dataset.charDimId as string);
    }
  }

  private onContextMenu(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const nodeEl = t.closest("[data-char-id]") as HTMLElement | null;
    if (nodeEl) {
      e.preventDefault();
      this.buildCharacterMenu(nodeEl.dataset.charId as string).showAtMouseEvent(e);
    }
  }

  private buildCharacterMenu(charId: string): Menu {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("重命名").setIcon("pencil").onClick(() => this.renameCharacter(charId))
    );
    menu.addItem((i) =>
      i.setTitle("删除角色").setIcon("trash").onClick(() => this.deleteCharacter(charId))
    );
    return menu;
  }

  private async openCharacterNote(charId: string, dimId: string): Promise<void> {
    const book = this.book;
    if (!book) return;
    const dim = book.characterDimensions.find((d) => d.id === dimId);
    const character = book.characters.find((c) => c.id === charId);
    if (!dim || !character) return;
    const key = cellKey(charId, dimId);
    const cell = book.characterCells[key] ?? (book.characterCells[key] = { filePath: "", hasContent: false });
    let file = cell.filePath ? this.app.vault.getAbstractFileByPath(cell.filePath) : null;
    if (!(file instanceof TFile)) {
      file = await createCharacterNote(this.app.vault, book, charId, dim, "");
      cell.filePath = file.path;
      cell.hasContent = false;
      await this.plugin.saveSettings();
      this.render();
    }
    await this.openInEditor(file.path);
  }

  private async openInEditor(filePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      new Notice("笔记不存在：" + filePath);
      return;
    }
    const workspace = this.app.workspace;
    let leaf = workspace.getLeaf(false);
    if (leaf === this.leaf) {
      leaf = Platform.isMobile ? workspace.getLeaf("tab") : workspace.getLeaf("split");
    }
    await leaf.openFile(file);
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  private async returnToMatrix(): Promise<void> {
    const workspace = this.app.workspace;
    const matrixLeaf = workspace.getLeavesOfType(VIEW_TYPE_CHAISHU_MATRIX)[0] ?? null;
    this.leaf.detach();
    if (matrixLeaf) {
      await workspace.revealLeaf(matrixLeaf);
      workspace.setActiveLeaf(matrixLeaf, { focus: true });
    } else {
      const leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_CHAISHU_MATRIX, active: true });
      workspace.setActiveLeaf(leaf, { focus: true });
    }
  }

  private addCharacter(): void {
    const book = this.book;
    if (!book) return;
    new PromptModal(this.app, {
      title: "添加角色",
      placeholder: "角色姓名",
      confirmText: "添加",
      onConfirm: (name) => {
        const n = sanitizeFileName(name) || "角色";
        book.characters.push({ id: uid("p"), name: n });
        void this.plugin.saveSettings();
        this.render();
      },
    }).open();
  }

  private renameCharacter(charId: string): void {
    const book = this.book;
    if (!book) return;
    const character = book.characters.find((c) => c.id === charId);
    if (!character) return;
    new PromptModal(this.app, {
      title: "重命名角色",
      placeholder: "角色姓名",
      initial: character.name,
      confirmText: "保存",
      onConfirm: (name) => void this.doSaveCharacterName(character, name),
    }).open();
  }

  private async doSaveCharacterName(character: CharacterData, name: string): Promise<void> {
    const book = this.book;
    if (!book) return;
    const n = sanitizeFileName(name) || character.name;
    if (n === character.name) return;
    character.name = n;
    await this.syncCharacterFiles(character);
    await this.plugin.saveSettings();
    this.render();
  }

  /** Rename a character's note files to match its new name. */
  private async syncCharacterFiles(character: CharacterData): Promise<void> {
    const book = this.book;
    if (!book) return;
    for (const dim of book.characterDimensions) {
      const key = cellKey(character.id, dim.id);
      const cell = book.characterCells[key];
      if (!cell?.filePath) continue;
      const newPath = buildCharacterPath(book, character.id, dim.name);
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

  private deleteCharacter(charId: string): void {
    const book = this.book;
    if (!book) return;
    const character = book.characters.find((c) => c.id === charId);
    if (!character) return;
    new ConfirmModal(this.app, {
      title: "删除角色",
      message: "将从人设矩阵中删除「" + character.name + "」（仓库中的笔记文件保留）。",
      confirmText: "删除",
      danger: true,
      onConfirm: async () => {
        book.characters = book.characters.filter((c) => c.id !== charId);
        await this.plugin.saveSettings();
        this.render();
      },
    }).open();
  }

  private addCharacterDimension(): void {
    const book = this.book;
    if (!book) return;
    new DimensionModal(this.app, {
      title: "添加人设维度",
      onSave: async (name, color) => {
        book.characterDimensions.push({
          id: uid("d"),
          name: sanitizeFileName(name) || "维度",
          color,
          isChart: false,
          yAxisLabels: [],
        });
        await this.plugin.saveSettings();
        this.render();
      },
    }).open();
  }

  private editCharacterDimension(dimId: string): void {
    const book = this.book;
    if (!book) return;
    const dim = book.characterDimensions.find((d) => d.id === dimId);
    if (!dim) return;
    new DimensionModal(this.app, {
      title: "编辑人设维度",
      initial: dim,
      onSave: async (name, color) => {
        dim.name = sanitizeFileName(name) || dim.name;
        dim.color = color;
        await this.plugin.saveSettings();
        this.render();
      },
      onDelete: () => {
        new ConfirmModal(this.app, {
          title: "删除人设维度",
          message: "将删除维度「" + dim.name + "」及其矩阵列（仓库中的笔记文件保留）。",
          confirmText: "删除",
          danger: true,
          onConfirm: async () => {
            book.characterDimensions = book.characterDimensions.filter((d) => d.id !== dimId);
            await this.plugin.saveSettings();
            this.render();
          },
        }).open();
      },
    }).open();
  }
}
