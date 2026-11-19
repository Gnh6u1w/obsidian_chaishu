import { ItemView, MarkdownRenderer, Menu, Notice, Platform, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type ChaiShuMatrixPlugin from "./main";
import {
  BookData,
  CharacterData,
  Dimension,
  FactionData,
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
import { ConfirmModal, DimensionModal, PromptModal, RelationshipModal } from "./modals";

const MAX_PREVIEW = 200;

// ------------------------------------------------------ graph color palette
const REL_PRESETS: Record<string, string> = {
  爱情: "#ef4444",
  爱慕: "#ef4444",
  恋人: "#ef4444",
  情侣: "#ef4444",
  同盟: "#3b82f6",
  盟友: "#3b82f6",
  朋友: "#3b82f6",
  师徒: "#22c55e",
  亲情: "#ec4899",
  家人: "#ec4899",
  仇恨: "#f97316",
  敌对: "#f97316",
  敌人: "#f97316",
  中立: "#94a3b8",
};

function relColor(type: string): string {
  if (REL_PRESETS[type]) return REL_PRESETS[type];
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 62%, 52%)`;
}

interface GEdge {
  from: string;
  to: string;
  type: string;
  explicit: boolean;
}

/** 人设拆解 sub-matrix: rows = characters (grouped by 阵营), columns = character
 *  dimensions. Also hosts the 关系图谱 (force-directed canvas). */
export class ChaiShuCharacterView extends ItemView {
  plugin: ChaiShuMatrixPlugin;
  bookId = "";

  private observer: IntersectionObserver | null = null;
  private viewMode: "table" | "graph" = "table";

  // faction drag state
  private dragCharId: string | null = null;

  // graph state
  private graphColorMode: "faction" | "relation" = "faction";
  private graphFocusId = "";
  private graphCanvas!: HTMLCanvasElement;
  private graphCtx!: CanvasRenderingContext2D;
  private graphNodes = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  private graphEdges: GEdge[] = [];
  private graphPan = { x: 0, y: 0 };
  private graphZoom = 1;
  private graphRaf = 0;
  private graphDragId: string | null = null;
  private graphLinkFrom: string | null = null;
  private graphPointers = new Map<number, { x: number; y: number }>();
  private graphPinchDist = 0;

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
    this.stopGraphLoop();
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

    // view switch: 表格视图 / 关系图谱视图
    const seg = left.createDiv("chs-seg");
    const tableBtn = seg.createEl("button", {
      text: "表格视图",
      cls: "chs-btn" + (this.viewMode === "table" ? " chs-btn-primary" : ""),
    });
    tableBtn.addEventListener("click", () => this.setViewMode("table"));
    const graphBtn = seg.createEl("button", {
      text: "关系图谱",
      cls: "chs-btn" + (this.viewMode === "graph" ? " chs-btn-primary" : ""),
    });
    graphBtn.addEventListener("click", () => this.setViewMode("graph"));

    const addChar = left.createEl("button", { text: "＋ 添加角色", cls: "chs-btn chs-btn-primary" });
    addChar.addEventListener("click", () => this.addCharacter());
    const addFaction = left.createEl("button", { text: "＋ 添加阵营", cls: "chs-btn" });
    addFaction.addEventListener("click", () => this.addFaction());
    const addDim = left.createEl("button", { text: "＋ 添加人设维度", cls: "chs-btn" });
    addDim.addEventListener("click", () => this.addCharacterDimension());

    const stats = toolbar.createDiv("chs-stats");
    stats.setText(
      (book.characters.length || 0) +
        " 个角色 · " +
        (book.factions.length || 0) +
        " 个阵营 · " +
        (book.characterDimensions.length || 0) +
        " 个人设维度"
    );

    if (this.viewMode === "graph") {
      this.buildGraphView(book);
    } else {
      this.buildMatrix(book);
    }
  }

  private setViewMode(mode: "table" | "graph"): void {
    this.viewMode = mode;
    this.render();
  }

  // ================================================================ table

  private buildMatrix(book: BookData): void {
    const scroll = this.contentEl.createDiv("chs-matrix-scroll");
    const table = scroll.createEl("table");
    table.addClass("chs-matrix", "chs-character-matrix");

    scroll.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    scroll.addEventListener("dragstart", (e) => this.onCharDragStart(e));
    scroll.addEventListener("dragover", (e) => this.onCharDragOver(e));
    scroll.addEventListener("drop", (e) => this.onCharDrop(e));
    scroll.addEventListener("dragend", () => (this.dragCharId = null));

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

    // Unassigned characters first, then factions (with a header row each).
    const unassigned = book.characters.filter((c) => !c.factionId);
    if (unassigned.length > 0 && book.factions.length > 0) {
      this.renderFactionRow(tbody, book, null, unassigned.length);
    }
    for (const character of unassigned) {
      this.renderCharacterRow(tbody, book, character);
    }
    for (const faction of book.factions) {
      const members = book.characters.filter((c) => c.factionId === faction.id);
      this.renderFactionRow(tbody, book, faction, members.length);
      for (const character of members) {
        this.renderCharacterRow(tbody, book, character);
      }
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

  /** A faction header row spanning the whole table width (drag-drop target). */
  private renderFactionRow(
    tbody: HTMLElement,
    book: BookData,
    faction: FactionData | null,
    count: number
  ): void {
    const tr = tbody.createEl("tr", { cls: "chs-faction-row" });
    const td = tr.createEl("td", { cls: "chs-faction-cell" });
    td.setAttribute("colspan", String(book.characterDimensions.length + 2));
    td.dataset.factionId = faction?.id ?? "";
    const dot = td.createSpan("chs-faction-dot");
    dot.style.backgroundColor = faction?.color ?? "var(--text-faint)";
    td.createSpan("chs-faction-name").setText(faction ? faction.name : "未分配阵营");
    td.createSpan("chs-faction-count").setText(String(count) + " 人");
    td.addEventListener("contextmenu", (e) => {
      if (faction) {
        e.preventDefault();
        this.buildFactionMenu(faction.id).showAtMouseEvent(e);
      }
    });
  }

  private renderCharacterRow(tbody: HTMLElement, book: BookData, character: CharacterData): void {
    const tr = tbody.createEl("tr");
    const nodeTd = tr.createEl("td", { cls: "chs-node" });
    nodeTd.draggable = true;
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

  // ------------------------------------------------------- faction drag

  private onCharDragStart(e: DragEvent): void {
    const t = (e.target as HTMLElement).closest("[data-char-id]") as HTMLElement | null;
    if (!t) return;
    this.dragCharId = t.dataset.charId as string;
    if (e.dataTransfer) e.dataTransfer.setData("text/plain", this.dragCharId);
  }

  private onCharDragOver(e: DragEvent): void {
    const factionEl = (e.target as HTMLElement).closest("[data-faction-id]") as HTMLElement | null;
    this.contentEl.querySelectorAll(".chs-faction-cell.chs-drop-target").forEach((el) =>
      el.removeClass("chs-drop-target")
    );
    if (factionEl && this.dragCharId) {
      factionEl.addClass("chs-drop-target");
      e.preventDefault();
    }
  }

  private onCharDrop(e: DragEvent): void {
    const factionEl = (e.target as HTMLElement).closest("[data-faction-id]") as HTMLElement | null;
    this.contentEl.querySelectorAll(".chs-faction-cell.chs-drop-target").forEach((el) =>
      el.removeClass("chs-drop-target")
    );
    if (factionEl && this.dragCharId) {
      e.preventDefault();
      this.assignFaction(this.dragCharId, factionEl.dataset.factionId ?? "");
    }
    this.dragCharId = null;
  }

  private assignFaction(charId: string, factionId: string): void {
    const book = this.book;
    if (!book) return;
    const character = book.characters.find((c) => c.id === charId);
    if (!character) return;
    character.factionId = factionId;
    void this.plugin.saveSettings();
    this.render();
  }

  private buildCharacterMenu(charId: string): Menu {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("重命名").setIcon("pencil").onClick(() => this.renameCharacter(charId))
    );
    // 移动到阵营 — inline list (MenuItem.setSubmenu is unavailable in bundled obsidian types)
    const book = this.book;
    if (book && book.factions.length > 0) {
      menu.addItem((i) => i.setTitle("移动到阵营").setIcon("users").setDisabled(true));
      menu.addItem((i) =>
        i.setTitle("　　未分配").onClick(() => this.assignFaction(charId, ""))
      );
      for (const f of book.factions) {
        menu.addItem((i) =>
          i.setTitle("　　" + f.name).onClick(() => this.assignFaction(charId, f.id))
        );
      }
    }
    menu.addItem((i) =>
      i.setTitle("删除角色").setIcon("trash").onClick(() => this.deleteCharacter(charId))
    );
    return menu;
  }

  private buildFactionMenu(factionId: string): Menu {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("重命名阵营").setIcon("pencil").onClick(() => this.renameFaction(factionId))
    );
    menu.addItem((i) =>
      i.setTitle("更换颜色").setIcon("palette").onClick(() => this.changeFactionColor(factionId))
    );
    menu.addItem((i) =>
      i.setTitle("删除阵营").setIcon("trash").onClick(() => this.deleteFaction(factionId))
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

  // --------------------------------------------------------- characters

  private addCharacter(): void {
    const book = this.book;
    if (!book) return;
    new PromptModal(this.app, {
      title: "添加角色",
      placeholder: "角色姓名",
      confirmText: "添加",
      onConfirm: (name) => {
        const n = sanitizeFileName(name) || "角色";
        book.characters.push({ id: uid("p"), name: n, factionId: "" });
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
        book.relationships = (book.relationships ?? []).filter(
          (r) => r.from !== charId && r.to !== charId
        );
        await this.plugin.saveSettings();
        this.render();
      },
    }).open();
  }

  // ------------------------------------------------------------ factions

  private addFaction(): void {
    const book = this.book;
    if (!book) return;
    new PromptModal(this.app, {
      title: "添加阵营",
      placeholder: "阵营名称（如：正道 / 魔道 / 中立）",
      confirmText: "添加",
      onConfirm: (name) => {
        const n = sanitizeFileName(name) || "阵营";
        const colors = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6"];
        book.factions.push({
          id: uid("f"),
          name: n,
          color: colors[(book.factions.length || 0) % colors.length],
        });
        void this.plugin.saveSettings();
        this.render();
      },
    }).open();
  }

  private renameFaction(factionId: string): void {
    const book = this.book;
    if (!book) return;
    const faction = book.factions.find((f) => f.id === factionId);
    if (!faction) return;
    new PromptModal(this.app, {
      title: "重命名阵营",
      placeholder: "阵营名称",
      initial: faction.name,
      confirmText: "保存",
      onConfirm: (name) => {
        const n = sanitizeFileName(name) || faction.name;
        faction.name = n;
        void this.plugin.saveSettings();
        this.render();
      },
    }).open();
  }

  private changeFactionColor(factionId: string): void {
    const book = this.book;
    if (!book) return;
    const faction = book.factions.find((f) => f.id === factionId);
    if (!faction) return;
    const colors = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6"];
    const menu = new Menu();
    for (const c of colors) {
      menu.addItem((i) => {
        i.setTitle(c).setIcon(faction.color === c ? "check" : "circle");
        i.onClick(() => {
          faction.color = c;
          void this.plugin.saveSettings();
          this.render();
        });
      });
    }
    menu.showAtPosition({ x: window.innerWidth / 2 - 100, y: window.innerHeight / 2 - 100 });
  }

  private deleteFaction(factionId: string): void {
    const book = this.book;
    if (!book) return;
    const faction = book.factions.find((f) => f.id === factionId);
    if (!faction) return;
    new ConfirmModal(this.app, {
      title: "删除阵营",
      message: "将删除阵营「" + faction.name + "」，其下角色会变为「未分配」。（角色笔记保留）",
      confirmText: "删除",
      danger: true,
      onConfirm: async () => {
        book.factions = book.factions.filter((f) => f.id !== factionId);
        for (const c of book.characters) {
          if (c.factionId === factionId) c.factionId = "";
        }
        await this.plugin.saveSettings();
        this.render();
      },
    }).open();
  }

  // ------------------------------------------------------- dimensions

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

  // ================================================================ graph

  private buildGraphView(book: BookData): void {
    const wrap = this.contentEl.createDiv("chs-graph-wrap");

    const controls = wrap.createDiv("chs-graph-controls");
    controls.createSpan("chs-graph-hint").setText(
      "节点按阵营着色 · 实线 = 手动关系 · 虚线 = 双链自动推导"
    );
    const addRel = controls.createEl("button", {
      text: "＋ 添加关系",
      cls: "chs-btn chs-btn-sm chs-btn-primary",
    });
    addRel.addEventListener("click", () => this.openAddRelationship(book));

    // faction legend
    const legend = wrap.createDiv("chs-graph-legend");
    const factions = book.factions ?? [];
    const legendItem = (color: string, label: string) => {
      const item = legend.createDiv("chs-legend-item");
      item.createSpan("chs-legend-dot").style.background = color;
      item.createSpan("chs-legend-label").setText(label);
    };
    for (const f of factions) legendItem(f.color || "#8b9bb4", f.name);
    const unassigned = book.characters.filter((c) => !c.factionId).length;
    if (unassigned > 0) legendItem("#8b9bb4", "未分配");

    // Render the diagram with Obsidian's native Mermaid renderer.
    const body = wrap.createDiv("chs-graph-mermaid");
    this.computeGraph(book);
    const source = this.buildMermaidSource(book);
    void MarkdownRenderer.render(this.app, "```mermaid\n" + source + "\n```", body, "", this);
  }

  /** Serialise the character graph into a Mermaid `graph TD` diagram. */
  private buildMermaidSource(book: BookData): string {
    const esc = (s: string) => s.replace(/[`"|\\]/g, " ").replace(/\s+/g, " ").trim();
    const chars = book.characters ?? [];
    const factions = book.factions ?? [];
    const lines: string[] = [
      "graph TD",
      '  classDef clsNone fill:#8b9bb4,stroke:#334155,color:#fff;',
    ];
    factions.forEach((f, i) => {
      lines.push(`  classDef cls${i} fill:${f.color || "#8b9bb4"},stroke:#334155,color:#fff;`);
    });

    const idOf = new Map<string, string>();
    chars.forEach((c, i) => idOf.set(c.id, "n" + i));

    const nodeClass = (c: CharacterData): string => {
      if (!c.factionId) return "clsNone";
      const idx = factions.findIndex((f) => f.id === c.factionId);
      return idx >= 0 ? `cls${idx}` : "clsNone";
    };

    for (const c of chars) {
      lines.push(`  ${idOf.get(c.id)}["${esc(c.name) || "（未命名）"}"]:::${nodeClass(c)}`);
    }
    if (chars.length === 0) {
      lines.push('  empty["（暂无角色）"]:::clsNone');
    }

    for (const e of this.graphEdges) {
      const a = idOf.get(e.from);
      const b = idOf.get(e.to);
      if (!a || !b) continue;
      const label = esc(e.type) || "关联";
      lines.push(e.explicit ? `  ${a} -->|${label}| ${b}` : `  ${a} -.->|${label}| ${b}`);
    }

    return lines.join("\n");
  }

  /** Manual relationship creation: pick two characters + a type. */
  private openAddRelationship(book: BookData): void {
    if (book.characters.length < 2) {
      new Notice("至少需要两个角色才能建立关系");
      return;
    }
    new RelationshipModal(this.app, {
      characters: book.characters,
      onSubmit: (from, to, type) => {
        const t = sanitizeFileName(type) || "关联";
        book.relationships = (book.relationships ?? []).filter(
          (r) => !((r.from === from && r.to === to) || (r.from === to && r.to === from))
        );
        book.relationships.push({ id: uid("r"), from, to, type: t, explicit: true });
        void this.plugin.saveSettings();
        this.render();
      },
    }).open();
  }

  private resizeGraphCanvas(): void {
    const canvas = this.graphCanvas;
    if (!canvas) return;
    const rect = canvas.parentElement?.getBoundingClientRect();
    const w = Math.max(320, rect?.width ?? 600);
    const h = Math.max(320, rect?.height ?? 480);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    this.graphCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Build the edge list: explicit (manual) + implicit (Obsidian wikilinks). */
  private computeGraph(book: BookData): void {
    const edges: GEdge[] = [];
    const seen = new Set<string>();

    const addEdge = (from: string, to: string, type: string, explicit: boolean) => {
      if (!from || !to || from === to) return;
      const key = [from, to].sort().join("|") + "|" + (explicit ? "e" : "i");
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ from, to, type, explicit });
    };

    // 1) explicit relationships (manual).
    for (const r of book.relationships ?? []) {
      addEdge(r.from, r.to, r.type, true);
    }

    // 2) implicit relationships from wikilinks in character notes.
    const characters = book.characters;
    const byName = new Map<string, CharacterData>();
    for (const c of characters) byName.set(c.name, c);
    const matchTarget = (linkBase: string): CharacterData | null => {
      const exact = byName.get(linkBase);
      if (exact) return exact;
      for (const c of characters) {
        if (linkBase.startsWith(c.name + "-")) return c;
      }
      return null;
    };

    for (const char of characters) {
      for (const dim of book.characterDimensions) {
        const cell = book.characterCells[cellKey(char.id, dim.id)];
        if (!cell?.filePath) continue;
        const f = this.app.vault.getAbstractFileByPath(cell.filePath);
        if (!(f instanceof TFile)) continue;
        const links = this.app.metadataCache.getFileCache(f)?.links ?? [];
        for (const l of links) {
          const base = (l.link || "").split("/").pop() ?? "";
          const target = matchTarget(base);
          if (target) addEdge(char.id, target.id, "关联", false);
        }
      }
    }

    this.graphEdges = edges;
  }

  private initGraphPositions(book: BookData): void {
    this.graphNodes.clear();
    const n = book.characters.length;
    const radius = Math.max(120, n * 22);
    book.characters.forEach((c, i) => {
      const angle = (i / Math.max(1, n)) * Math.PI * 2;
      this.graphNodes.set(c.id, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
      });
    });
    // center the pan on the nodes
    this.graphPan = { x: 0, y: 0 };
    this.graphZoom = 1;
    this.graphFocusId = "";
  }

  private startGraphLoop(book: BookData): void {
    this.stopGraphLoop();
    const step = () => {
      this.graphPhysics(book);
      this.graphDraw(book);
      this.graphRaf = requestAnimationFrame(step);
    };
    this.graphRaf = requestAnimationFrame(step);
  }

  private stopGraphLoop(): void {
    if (this.graphRaf) {
      cancelAnimationFrame(this.graphRaf);
      this.graphRaf = 0;
    }
  }

  private graphPhysics(book: BookData): void {
    const nodes = this.graphNodes;
    const ids = [...nodes.keys()];
    const W = this.graphCanvas?.clientWidth || 600;
    const H = this.graphCanvas?.clientHeight || 480;

    // repulsion
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = nodes.get(ids[i])!;
        const b = nodes.get(ids[j])!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const force = 900 / d2;
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    // spring attraction along edges
    for (const e of this.graphEdges) {
      const a = nodes.get(e.from);
      const b = nodes.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = 110;
      const force = (d - target) * 0.02;
      const fx = (dx / d) * force;
      const fy = (dy / d) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // center gravity
    for (const id of ids) {
      const n = nodes.get(id)!;
      if (this.graphDragId === id) continue;
      n.vx += -n.x * 0.004;
      n.vy += -n.y * 0.004;
    }

    // integrate + damp
    for (const id of ids) {
      const n = nodes.get(id)!;
      if (this.graphDragId === id) continue;
      n.vx *= 0.82;
      n.vy *= 0.82;
      n.x += n.vx;
      n.y += n.vy;
      // keep inside a soft bounds
      n.x = Math.max(-W, Math.min(W, n.x));
      n.y = Math.max(-H, Math.min(H, n.y));
    }

    // collision avoidance — enforce a minimum gap so node circles (and their
    // labels) never overlap, no matter how many edges pull them together.
    // minGap is in world units; the screen gap scales with graphZoom.
    const minGap = 48;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = nodes.get(ids[i])!;
        const b = nodes.get(ids[j])!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d = Math.sqrt(dx * dx + dy * dy);
        if (d < minGap) {
          if (d < 0.01) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          }
          const push = (minGap - d) * 0.5;
          const nx = dx / d;
          const ny = dy / d;
          a.x += nx * push;
          a.y += ny * push;
          b.x -= nx * push;
          b.y -= ny * push;
        }
      }
    }
  }

  private toScreen(wx: number, wy: number): { x: number; y: number } {
    const W = this.graphCanvas?.clientWidth || 600;
    const H = this.graphCanvas?.clientHeight || 480;
    return {
      x: wx * this.graphZoom + this.graphPan.x + W / 2,
      y: wy * this.graphZoom + this.graphPan.y + H / 2,
    };
  }

  private graphDraw(book: BookData): void {
    const ctx = this.graphCtx;
    if (!ctx) return;
    const W = this.graphCanvas?.clientWidth || 600;
    const H = this.graphCanvas?.clientHeight || 480;
    ctx.clearRect(0, 0, W, H);

    const factionById = new Map<string, FactionData>();
    for (const f of book.factions) factionById.set(f.id, f);
    const charById = new Map<string, CharacterData>();
    for (const c of book.characters) charById.set(c.id, c);

    const nodeColor = (char: CharacterData): string => {
      const f = char.factionId ? factionById.get(char.factionId) : null;
      return f?.color ?? "#8b9bb4";
    };

    // edges
    for (const e of this.graphEdges) {
      const a = this.graphNodes.get(e.from);
      const b = this.graphNodes.get(e.to);
      if (!a || !b) continue;
      const pa = this.toScreen(a.x, a.y);
      const pb = this.toScreen(b.x, b.y);
      const focused = this.graphFocusId && (e.from === this.graphFocusId || e.to === this.graphFocusId);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      if (e.explicit) {
        ctx.strokeStyle = this.graphColorMode === "relation" ? relColor(e.type) : relColor(e.type);
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = "rgba(140, 156, 178, 0.7)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
      }
      ctx.globalAlpha = this.graphFocusId && !focused ? 0.15 : 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // nodes
    for (const char of book.characters) {
      const n = this.graphNodes.get(char.id);
      if (!n) continue;
      const p = this.toScreen(n.x, n.y);
      const r = 16 / this.graphZoom < 6 ? 6 : Math.max(8, Math.min(20, 16 / this.graphZoom * 1.2));
      const color = nodeColor(char);
      const focused = char.id === this.graphFocusId;
      const dimmed = this.graphFocusId && !focused && !this.isAdjacent(char.id, this.graphFocusId);

      ctx.globalAlpha = dimmed ? 0.35 : 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = focused ? 3 : 1.5;
      ctx.strokeStyle = focused ? "#ffffff" : "rgba(0,0,0,0.35)";
      ctx.stroke();

      // label
      ctx.font = `${Math.round(13 / Math.sqrt(this.graphZoom))}px -apple-system, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillStyle = "var(--text-normal)";
      ctx.fillText(char.name, p.x, p.y + r + 14);
      ctx.globalAlpha = 1;
    }
  }

  private isAdjacent(id: string, focusId: string): boolean {
    for (const e of this.graphEdges) {
      if ((e.from === id && e.to === focusId) || (e.to === id && e.from === focusId)) return true;
    }
    return false;
  }

  // ---- graph pointer interaction ----

  private graphScreenToWorld(sx: number, sy: number): { x: number; y: number } {
    const W = this.graphCanvas?.clientWidth || 600;
    const H = this.graphCanvas?.clientHeight || 480;
    return {
      x: (sx - this.graphPan.x - W / 2) / this.graphZoom,
      y: (sy - this.graphPan.y - H / 2) / this.graphZoom,
    };
  }

  private hitTestNode(sx: number, sy: number): string | null {
    const world = this.graphScreenToWorld(sx, sy);
    let best: string | null = null;
    let bestD = Infinity;
    for (const [id, n] of this.graphNodes) {
      const dx = n.x - world.x;
      const dy = n.y - world.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 24 / this.graphZoom && d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  private onGraphPointerDown(e: PointerEvent): void {
    const rect = this.graphCanvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    this.graphPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.graphCanvas.setPointerCapture(e.pointerId);

    if (this.graphPointers.size === 2) {
      const pts = [...this.graphPointers.values()];
      this.graphPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      this.graphDragId = null;
      return;
    }

    const hit = this.hitTestNode(sx, sy);
    if (hit) {
      this.graphDragId = hit;
      this.graphLinkFrom = hit;
      this.graphFocusId = hit;
    }
  }

  private onGraphPointerMove(e: PointerEvent): void {
    if (!this.graphPointers.has(e.pointerId)) return;
    const rect = this.graphCanvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const prev = this.graphPointers.get(e.pointerId)!;
    this.graphPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.graphPointers.size === 2) {
      // pinch zoom
      e.preventDefault();
      const pts = [...this.graphPointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (this.graphPinchDist > 0) {
        const factor = dist / this.graphPinchDist;
        this.graphZoom = Math.min(4, Math.max(0.25, this.graphZoom * factor));
      }
      this.graphPinchDist = dist;
      return;
    }

    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;

    if (this.graphDragId) {
      const world = this.graphScreenToWorld(sx, sy);
      const n = this.graphNodes.get(this.graphDragId);
      if (n) {
        n.x = world.x;
        n.y = world.y;
        n.vx = 0;
        n.vy = 0;
      }
    } else {
      this.graphPan.x += dx;
      this.graphPan.y += dy;
    }
  }

  private onGraphPointerUp(e: PointerEvent): void {
    const rect = this.graphCanvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (this.graphPointers.size === 2) {
      this.graphPointers.delete(e.pointerId);
      this.graphPinchDist = 0;
      return;
    }

    this.graphPointers.delete(e.pointerId);

    if (this.graphDragId) {
      const released = this.hitTestNode(sx, sy);
      if (released && released !== this.graphDragId) {
        // manual link: drag node A onto node B → prompt for relationship type
        const from = this.graphDragId;
        const to = released;
        this.graphDragId = null;
        this.graphLinkFrom = null;
        this.promptRelationship(from, to);
        return;
      }
      this.graphDragId = null;
      this.graphLinkFrom = null;
    } else {
      // click empty space → clear focus
      if (!this.graphDragId && Math.abs(e.movementX) < 2 && Math.abs(e.movementY) < 2) {
        const hit = this.hitTestNode(sx, sy);
        if (!hit) this.graphFocusId = "";
      }
    }
  }

  private onGraphWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.graphCanvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.min(4, Math.max(0.25, this.graphZoom * factor));
    // zoom toward cursor
    const worldBefore = this.graphScreenToWorld(sx, sy);
    this.graphZoom = newZoom;
    const W = this.graphCanvas?.clientWidth || 600;
    const H = this.graphCanvas?.clientHeight || 480;
    this.graphPan.x = sx - W / 2 - worldBefore.x * this.graphZoom;
    this.graphPan.y = sy - H / 2 - worldBefore.y * this.graphZoom;
  }

  private promptRelationship(from: string, to: string): void {
    const book = this.book;
    if (!book) return;
    const a = book.characters.find((c) => c.id === from);
    const b = book.characters.find((c) => c.id === to);
    if (!a || !b) return;
    new PromptModal(this.app, {
      title: "建立关系",
      placeholder: "关系类型（爱情 / 同盟 / 仇恨 / 师徒 / 自定义…）",
      confirmText: "建立连线",
      onConfirm: (type) => {
        const t = sanitizeFileName(type) || "关联";
        // replace any existing explicit edge between the two
        book.relationships = (book.relationships ?? []).filter(
          (r) => !((r.from === from && r.to === to) || (r.from === to && r.to === from))
        );
        book.relationships.push({ id: uid("r"), from, to, type: t, explicit: true });
        void this.plugin.saveSettings();
        this.render();
      },
    }).open();
  }
}
