import { Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { ChaiShuMatrixView } from "./matrix-view";
import { ChaiShuCharacterView } from "./character-view";
import { ChaiShuDashboardView } from "./dashboard-view";
import { ChaiShuSettingTab } from "./settings";
import {
  BookData,
  CellData,
  CharacterData,
  ChaiShuSettings,
  DEFAULT_SETTINGS,
  DEFAULT_Y_AXIS_LABELS,
  DIMENSION_COLORS,
  Dimension,
  NodeData,
  NodeType,
  VIEW_TYPE_CHAISHU_CHARACTER,
  VIEW_TYPE_CHAISHU_DASHBOARD,
  VIEW_TYPE_CHAISHU_MATRIX,
} from "./types";
import {
  bookFolderName,
  buildChapterContent,
  cellKey,
  collectChapters,
  createNode,
  normalizeYAxisLabels,
  sanitizeFileName,
  stripFrontmatter,
  uid,
} from "./store";

export default class ChaiShuMatrixPlugin extends Plugin {
  settings!: ChaiShuSettings;
  views: Set<ChaiShuMatrixView> = new Set();
  characterViews: Set<ChaiShuCharacterView> = new Set();

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.relinkNotes();

    this.registerView(VIEW_TYPE_CHAISHU_MATRIX, (leaf: WorkspaceLeaf) => {
      const view = new ChaiShuMatrixView(leaf, this);
      this.views.add(view);
      return view;
    });

    this.registerView(VIEW_TYPE_CHAISHU_DASHBOARD, (leaf: WorkspaceLeaf) => {
      return new ChaiShuDashboardView(leaf, this);
    });

    this.registerView(VIEW_TYPE_CHAISHU_CHARACTER, (leaf: WorkspaceLeaf) => {
      const view = new ChaiShuCharacterView(leaf, this);
      this.characterViews.add(view);
      return view;
    });

    this.addRibbonIcon("layout-grid", "打开项目大厅", () => {
      void this.openDashboard();
    });

    this.addCommand({
      id: "open-dashboard",
      name: "打开项目大厅",
      callback: () => {
        void this.openDashboard();
      },
    });

    this.addCommand({
      id: "new-book",
      name: "新建拆书项目",
      callback: () => {
        // V2.3.1: unified entry — just open the dashboard; creation is inline there.
        void this.openDashboard();
      },
    });

    this.addCommand({
      id: "return-matrix",
      name: "返回拆书矩阵",
      callback: () => {
        void this.returnToMatrix();
      },
    });

    // In-note return link: [🔙 返回拆书矩阵](obsidian://chaishu-matrix-pro)
    this.registerObsidianProtocolHandler("chaishu-matrix-pro", () => {
      void this.returnToMatrix();
    });

    // Character-note return link: [🔙 返回人设拆解](obsidian://chaishu-character)
    this.registerObsidianProtocolHandler("chaishu-character", () => {
      void this.returnToCharacter();
    });

    // Make the in-note return links reliably-clickable buttons in Reading/Live Preview.
    this.registerMarkdownPostProcessor((el) => {
      el.querySelectorAll<HTMLAnchorElement>('a[href="obsidian://chaishu-matrix-pro"]').forEach((a) => {
        a.classList.add("chs-return-link");
        a.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          void this.returnToMatrix();
        });
      });
      el.querySelectorAll<HTMLAnchorElement>('a[href="obsidian://chaishu-character"]').forEach((a) => {
        a.classList.add("chs-return-link");
        a.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          void this.returnToCharacter();
        });
      });
    });

    this.addSettingTab(new ChaiShuSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        void this.onVaultRename(file, oldPath);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        void this.onVaultDelete(file);
      })
    );
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAISHU_MATRIX);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAISHU_DASHBOARD);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAISHU_CHARACTER);
    this.views.clear();
    this.characterViews.clear();
  }

  getSettings(): ChaiShuSettings {
    return this.settings;
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<ChaiShuSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
    if (!Array.isArray(this.settings.books)) this.settings.books = [];
    this.settings.books = this.settings.books.map((b) => this.normalizeBook(b as unknown as BookData));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  notifyViews(): void {
    for (const v of this.views) v.refresh();
    for (const v of this.characterViews) v.render();
  }

  /** Open (or focus) the standalone 项目大厅 tab. */
  async openDashboard(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAISHU_DASHBOARD);
    let leaf: WorkspaceLeaf | null = leaves[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_CHAISHU_DASHBOARD, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  /** Open (or focus) the matrix view for a book (defaults to the active book). */
  async openMatrix(bookId?: string): Promise<void> {
    if (bookId) {
      this.settings.activeBookId = bookId;
      await this.saveSettings();
    }
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAISHU_MATRIX);
    let leaf: WorkspaceLeaf | null = leaves[0] ?? null;
    const existed = !!leaf;
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_CHAISHU_MATRIX, active: true });
    }
    if (existed && leaf.view instanceof ChaiShuMatrixView) {
      leaf.view.activeBookId = this.settings.activeBookId;
      leaf.view.refresh();
    }
    await this.app.workspace.revealLeaf(leaf);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  /** Open (or focus) the 人设拆解 sub-matrix for a book. */
  async openCharacterView(bookId: string): Promise<void> {
    this.settings.activeBookId = bookId;
    await this.saveSettings();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAISHU_CHARACTER);
    let leaf: WorkspaceLeaf | null = leaves[0] ?? null;
    const existed = !!leaf;
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_CHAISHU_CHARACTER, active: true });
    }
    if (existed && leaf.view instanceof ChaiShuCharacterView) {
      leaf.view.setBook(bookId);
    }
    await this.app.workspace.revealLeaf(leaf);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  /** Create a new book (with default chapters + dimensions) and persist it. */
  async createBook(title: string, author: string): Promise<BookData> {
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
        category: [],
        tags: [],
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
      characters: [],
      characterDimensions: [],
      characterCells: {},
      factions: [],
      relationships: [],
    };
    settings.books.push(book);
    settings.activeBookId = book.id;
    await this.saveSettings();
    return book;
  }

  /**
   * Return from an opened note: close the note leaf, then focus/reveal the
   * matrix (V1.9 — prevents abandoned note tabs from piling up).
   */
  async returnToMatrix(): Promise<void> {
    const workspace = this.app.workspace;
    const matrixLeaf = workspace.getLeavesOfType(VIEW_TYPE_CHAISHU_MATRIX)[0] ?? null;
    const activeLeaf = workspace.activeLeaf;

    // Close the note leaf we are returning from (never a plugin view).
    if (
      activeLeaf &&
      activeLeaf !== matrixLeaf &&
      !this.isPluginView(activeLeaf.view?.getViewType())
    ) {
      activeLeaf.detach();
    }

    if (matrixLeaf) {
      await workspace.revealLeaf(matrixLeaf);
      workspace.setActiveLeaf(matrixLeaf, { focus: true });
    } else {
      const leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_CHAISHU_MATRIX, active: true });
      workspace.setActiveLeaf(leaf, { focus: true });
    }
  }

  /** Return from a character note: close the note leaf, then reveal the 人设拆解 view. */
  async returnToCharacter(): Promise<void> {
    const workspace = this.app.workspace;
    const charLeaf = workspace.getLeavesOfType(VIEW_TYPE_CHAISHU_CHARACTER)[0] ?? null;
    const activeLeaf = workspace.activeLeaf;

    if (
      activeLeaf &&
      activeLeaf !== charLeaf &&
      !this.isPluginView(activeLeaf.view?.getViewType())
    ) {
      activeLeaf.detach();
    }

    if (charLeaf) {
      await workspace.revealLeaf(charLeaf);
      workspace.setActiveLeaf(charLeaf, { focus: true });
    } else {
      const leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_CHAISHU_CHARACTER, active: true });
      workspace.setActiveLeaf(leaf, { focus: true });
    }
  }

  private isPluginView(viewType: string | undefined): boolean {
    return (
      viewType === VIEW_TYPE_CHAISHU_MATRIX ||
      viewType === VIEW_TYPE_CHAISHU_DASHBOARD ||
      viewType === VIEW_TYPE_CHAISHU_CHARACTER
    );
  }

  getOpenView(): ChaiShuMatrixView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAISHU_MATRIX);
    const leaf = leaves[0];
    return leaf && leaf.view instanceof ChaiShuMatrixView ? leaf.view : null;
  }

  /** Rename a dimension label and sync the `dimension` property in its existing notes. */
  async renameDimension(bookId: string, dimId: string, newName: string): Promise<void> {
    const book = this.settings.books.find((b) => b.id === bookId);
    if (!book) return;
    const dim = book.dimensions.find((d) => d.id === dimId);
    if (!dim) return;
    const name = sanitizeFileName(newName) || dim.name;
    if (name === dim.name) return;
    dim.name = name;

    for (const ch of collectChapters(book.structure)) {
      const cell = book.cells[cellKey(ch.id, dimId)];
      if (!cell?.filePath) continue;
      const f = this.app.vault.getAbstractFileByPath(cell.filePath);
      if (f instanceof TFile) {
        try {
          const body = stripFrontmatter(await this.app.vault.cachedRead(f));
          const content = buildChapterContent(book, ch.id, dim, body);
          await this.app.vault.modify(f, content);
        } catch (e) {
          /* ignore individual note failures */
        }
      }
    }
    await this.saveSettings();
    this.notifyViews();
  }

  // ---------------------------------------------------------- normalization

  private normalizeBook(b: any): BookData {
    const bookInfo = {
      title: b.bookInfo?.title ?? "未命名拆书",
      author: b.bookInfo?.author ?? "",
      score: b.bookInfo?.score ?? "",
      category: Array.isArray(b.bookInfo?.category)
        ? b.bookInfo.category.map((c: unknown) => String(c)).filter(Boolean)
        : [],
      tags: Array.isArray(b.bookInfo?.tags)
        ? b.bookInfo.tags.map((t: unknown) => String(t)).filter(Boolean)
        : [],
      bgImage: b.bookInfo?.bgImage ?? "",
      bgMode: (b.bookInfo?.bgMode === "repeat" ? "repeat" : "cover") as "cover" | "repeat",
      bgOverlay: typeof b.bookInfo?.bgOverlay === "number" ? b.bookInfo.bgOverlay : 0.3,
    };

    const dimensions: Dimension[] = Array.isArray(b.dimensions)
      ? b.dimensions.map((d: any) => ({
          id: d.id ?? uid("d"),
          name: d.name ?? "维度",
          color: d.color ?? DIMENSION_COLORS[0],
          isChart: d.isChart === true || d.type === "chart" || d.name === "情绪",
          yAxisLabels: normalizeYAxisLabels(d.yAxisLabels),
        }))
      : [];

    const storagePath = typeof b.storagePath === "string" ? b.storagePath : "";

    // Legacy emotion data (V1.1 chartData / V1.2 chapterEmotions) → migrate to per-node emotionData.
    const legacyEmotions: Record<string, { x: number; y: number }[]> = {};
    if (b.chapterEmotions && typeof b.chapterEmotions === "object") {
      for (const [k, v] of Object.entries(b.chapterEmotions)) {
        if (Array.isArray(v)) legacyEmotions[k] = v as { x: number; y: number }[];
      }
    } else if (b.chartData && typeof b.chartData === "object") {
      for (const points of Object.values(b.chartData)) {
        if (!Array.isArray(points)) continue;
        for (const p of points as any[]) {
          if (!p?.chapterId) continue;
          const value = typeof p.value === "number" ? p.value : 0;
          const y = Math.max(1, Math.min(5, Math.round(value / 2.5) + 1));
          (legacyEmotions[p.chapterId] ??= []).push({ x: 50, y });
        }
      }
    }

    let structure: NodeData[];
    let cells: Record<string, CellData>;

    if (Array.isArray(b.structure)) {
      structure = b.structure.map((n: any) => this.normalizeNode(n));
      cells = b.cells && typeof b.cells === "object" ? b.cells : {};
    } else if (Array.isArray(b.chapters)) {
      // Migrate from V1.0: flat chapters array + "第X章_d1" cell keys.
      structure = [];
      const chapterIdByName = new Map<string, string>();
      for (const name of b.chapters) {
        const node = createNode("chapter", String(name));
        chapterIdByName.set(String(name), node.id);
        structure.push(node);
      }
      cells = {};
      const oldCells = b.cells && typeof b.cells === "object" ? b.cells : {};
      for (const [oldKey, c] of Object.entries(oldCells)) {
        const sep = oldKey.lastIndexOf("_");
        if (sep <= 0) continue;
        const chapterName = oldKey.slice(0, sep);
        const dimId = oldKey.slice(sep + 1);
        const nodeId = chapterIdByName.get(chapterName);
        if (!nodeId) continue;
        const cc = c as CellData;
        cells[cellKey(nodeId, dimId)] = {
          filePath: cc?.filePath ?? "",
          hasContent: !!cc?.hasContent,
        };
      }
    } else {
      structure = [];
      cells = {};
    }

    for (const ch of collectChapters(structure)) {
      const old = legacyEmotions[ch.id];
      if (Array.isArray(old) && old.length > 0 && ch.emotionData.length === 0) {
        const sorted = old.slice().sort((a, b) => a.x - b.x);
        ch.emotionData = sorted.map((p) => Math.max(1, Math.min(5, Math.round(p.y) || 3)));
      }
    }

    const characters: CharacterData[] = Array.isArray(b.characters)
      ? b.characters.map((c: any) => ({
          id: c?.id ?? uid("p"),
          name: sanitizeFileName(c?.name ?? "角色"),
          factionId: typeof c?.factionId === "string" ? c.factionId : "",
        }))
      : [];

    const characterDimensions: Dimension[] = Array.isArray(b.characterDimensions)
      ? b.characterDimensions.map((d: any) => ({
          id: d.id ?? uid("d"),
          name: d.name ?? "维度",
          color: d.color ?? DIMENSION_COLORS[0],
          isChart: false,
          yAxisLabels: [],
        }))
      : [];

    const characterCells: Record<string, CellData> =
      b.characterCells && typeof b.characterCells === "object" ? b.characterCells : {};

    const factions = Array.isArray(b.factions)
      ? b.factions.map((f: any) => ({
          id: f?.id ?? uid("f"),
          name: sanitizeFileName(f?.name ?? "阵营"),
          color: typeof f?.color === "string" && f.color ? f.color : DIMENSION_COLORS[0],
        }))
      : [];

    const relationships = Array.isArray(b.relationships)
      ? b.relationships.map((r: any) => ({
          id: r?.id ?? uid("r"),
          from: typeof r?.from === "string" ? r.from : "",
          to: typeof r?.to === "string" ? r.to : "",
          type: typeof r?.type === "string" && r.type ? r.type : "关系",
          explicit: r?.explicit !== false,
        }))
      : [];

    return {
      id: b.id ?? uid("book"),
      bookInfo,
      storagePath,
      dimensions,
      structure,
      cells,
      characters,
      characterDimensions,
      characterCells,
      factions,
      relationships,
    };
  }

  private normalizeNode(n: any): NodeData {
    const type: NodeType =
      n.type === "volume" || n.type === "unit" ? n.type : "chapter";
    return {
      id: n.id ?? uid(type === "chapter" ? "c" : type === "volume" ? "v" : "u"),
      type,
      name: sanitizeFileName(n.name ?? ""),
      summaryFile: typeof n.summaryFile === "string" ? n.summaryFile : "",
      summaryHasContent: !!n.summaryHasContent,
      summaryFiles:
        n.summaryFiles && typeof n.summaryFiles === "object" ? n.summaryFiles : {},
      children: Array.isArray(n.children)
        ? n.children.map((c: any) => this.normalizeNode(c))
        : [],
      collapsed: !!n.collapsed,
      emotionData: Array.isArray(n.emotionData)
        ? (n.emotionData as unknown[]).map((v) => Number(v)).filter((v) => Number.isFinite(v))
        : [],
    };
  }

  private allNodes(book: BookData): NodeData[] {
    const out: NodeData[] = [];
    const walk = (nodes: NodeData[]) => {
      for (const n of nodes) {
        out.push(n);
        walk(n.children);
      }
    };
    walk(book.structure);
    return out;
  }

  // -------------------------------------------------------- reverse sync

  private async onVaultRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!(file instanceof TFile)) return;
    let changed = false;
    for (const book of this.settings.books) {
      for (const key of Object.keys(book.cells)) {
        const cell = book.cells[key];
        if (cell.filePath === oldPath) {
          cell.filePath = file.path;
          changed = true;
        }
      }
      for (const key of Object.keys(book.characterCells ?? {})) {
        const cell = book.characterCells[key];
        if (cell.filePath === oldPath) {
          cell.filePath = file.path;
          changed = true;
        }
      }
      for (const node of this.allNodes(book)) {
        if (node.type === "chapter") continue;
        for (const dimId of Object.keys(node.summaryFiles ?? {})) {
          if (node.summaryFiles[dimId] === oldPath) {
            node.summaryFiles[dimId] = file.path;
            changed = true;
          }
        }
      }
    }
    if (changed) {
      await this.saveSettings();
      this.notifyViews();
    }
  }

  private async onVaultDelete(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile)) return;
    let changed = false;
    for (const book of this.settings.books) {
      for (const key of Object.keys(book.cells)) {
        const cell = book.cells[key];
        if (cell.filePath === file.path) {
          cell.filePath = "";
          cell.hasContent = false;
          changed = true;
        }
      }
      for (const key of Object.keys(book.characterCells ?? {})) {
        const cell = book.characterCells[key];
        if (cell.filePath === file.path) {
          cell.filePath = "";
          cell.hasContent = false;
          changed = true;
        }
      }
      for (const node of this.allNodes(book)) {
        if (node.type === "chapter") continue;
        for (const dimId of Object.keys(node.summaryFiles ?? {})) {
          if (node.summaryFiles[dimId] === file.path) {
            delete node.summaryFiles[dimId];
            changed = true;
          }
        }
      }
    }
    if (changed) {
      await this.saveSettings();
      this.notifyViews();
    }
  }

  // ------------------------------------------------------ note re-linking

  /** Re-link cell/summary/character notes whose stored path no longer resolves (e.g. after
   *  an upgrade moved or renamed files). Matches notes by their frontmatter. */
  private async relinkNotes(): Promise<void> {
    const vault = this.app.vault;
    const resolves = (p: string): boolean =>
      !!p && vault.getAbstractFileByPath(p) instanceof TFile;

    // Only run the metadata scan when at least one stored path is stale.
    let stale = false;
    outer: for (const book of this.settings.books) {
      for (const ch of collectChapters(book.structure)) {
        for (const d of book.dimensions) {
          if (d.isChart) continue;
          const c = book.cells[cellKey(ch.id, d.id)];
          if (c?.filePath && !resolves(c.filePath)) {
            stale = true;
            break outer;
          }
        }
      }
      for (const n of this.allNodes(book)) {
        if (n.type === "chapter") continue;
        for (const p of Object.values(n.summaryFiles ?? {})) {
          if (p && !resolves(p)) {
            stale = true;
            break outer;
          }
        }
      }
      for (const c of Object.values(book.characterCells ?? {})) {
        if (c.filePath && !resolves(c.filePath)) {
          stale = true;
          break outer;
        }
      }
    }
    if (!stale) return;

    let changed = false;
    const files = vault.getMarkdownFiles();
    for (const book of this.settings.books) {
      const bookTitle = bookFolderName(book.bookInfo.title); // 《书名》
      const chByName = new Map<string, NodeData>();
      for (const ch of collectChapters(book.structure)) chByName.set(ch.name, ch);
      const dimByName = new Map<string, Dimension>();
      for (const d of book.dimensions) if (!d.isChart) dimByName.set(d.name, d);
      const volByName = new Map<string, NodeData>();
      const unitByName = new Map<string, NodeData>();
      for (const n of this.allNodes(book)) {
        if (n.type === "volume") volByName.set(n.name, n);
        else if (n.type === "unit") unitByName.set(n.name, n);
      }
      const charByName = new Map<string, CharacterData>();
      for (const c of book.characters ?? []) charByName.set(c.name, c);
      const charDimByName = new Map<string, Dimension>();
      for (const d of book.characterDimensions ?? []) charDimByName.set(d.name, d);

      for (const file of files) {
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;
        if (!fm) continue;

        // --- chapter cell notes (multiple YAML key eras) ---
        const fmChapter = String(fm["章节名称"] ?? fm["chapter"] ?? fm["章节"] ?? "");
        const fmDim = String(fm["分析维度"] ?? fm["dimension"] ?? fm["维度"] ?? "");
        if (fmChapter && fmDim) {
          const fmBook = String(fm["拆书项目"] ?? fm["book"] ?? fm["书名"] ?? "");
          if (fmBook && fmBook !== bookTitle && fmBook !== book.bookInfo.title) continue;
          const ch = chByName.get(fmChapter);
          const dim = dimByName.get(fmDim);
          if (!ch || !dim) continue;
          const key = cellKey(ch.id, dim.id);
          const cell = book.cells[key];
          if (cell?.filePath && resolves(cell.filePath)) continue; // already bound
          if (cell) {
            cell.filePath = file.path;
            cell.hasContent = true;
          } else {
            book.cells[key] = { filePath: file.path, hasContent: true };
          }
          changed = true;
          continue;
        }

        // --- per-dimension volume/unit summary notes (V2.0) ---
        const fmType = String(fm["类型"] ?? fm["type"] ?? "");
        const sumDim = String(fm["维度"] ?? fm["dimension"] ?? "");
        if ((fmType === "卷总结" || fmType === "单元总结") && sumDim) {
          const dim = dimByName.get(sumDim);
          if (!dim) continue;
          let target: NodeData | undefined;
          if (fmType === "卷总结") {
            const volName = String(fm["所属卷"] ?? fm["卷名"] ?? fm["volume"] ?? "");
            target = volName ? volByName.get(volName) : undefined;
          } else {
            const unitName = String(fm["单元名"] ?? fm["unit"] ?? "");
            target = unitName ? unitByName.get(unitName) : undefined;
          }
          if (!target) continue;
          if (!target.summaryFiles) target.summaryFiles = {};
          if (target.summaryFiles[dim.id] && resolves(target.summaryFiles[dim.id])) continue;
          target.summaryFiles[dim.id] = file.path;
          changed = true;
          continue;
        }

        // --- character dimension notes (V2.1) ---
        if (fmType === "人设") {
          const charName = String(fm["角色名称"] ?? fm["character"] ?? "");
          const charDim = String(fm["人设维度"] ?? fm["characterDimension"] ?? "");
          const character = charName ? charByName.get(charName) : undefined;
          const cdim = charDim ? charDimByName.get(charDim) : undefined;
          if (!character || !cdim) continue;
          const key = cellKey(character.id, cdim.id);
          const cell = book.characterCells[key];
          if (cell?.filePath && resolves(cell.filePath)) continue;
          if (cell) {
            cell.filePath = file.path;
            cell.hasContent = true;
          } else {
            book.characterCells[key] = { filePath: file.path, hasContent: true };
          }
          changed = true;
        }
      }
    }

    if (changed) {
      await this.saveSettings();
      this.notifyViews();
    }
  }
}
