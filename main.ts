import { Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { ChaiShuMatrixView } from "./matrix-view";
import { ChaiShuSettingTab } from "./settings";
import {
  BookData,
  CellData,
  ChaiShuSettings,
  DEFAULT_SETTINGS,
  DIMENSION_COLORS,
  Dimension,
  NodeData,
  NodeType,
  VIEW_TYPE_CHAISHU_MATRIX,
} from "./types";
import {
  buildChapterContent,
  cellKey,
  collectChapters,
  createNode,
  normalizeYAxisLabels,
  parseEmotionData,
  sanitizeFileName,
  stripFrontmatter,
  uid,
} from "./store";

export default class ChaiShuMatrixPlugin extends Plugin {
  settings!: ChaiShuSettings;
  views: Set<ChaiShuMatrixView> = new Set();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_CHAISHU_MATRIX, (leaf: WorkspaceLeaf) => {
      const view = new ChaiShuMatrixView(leaf, this);
      this.views.add(view);
      return view;
    });

    this.addRibbonIcon("layout-grid", "打开拆书矩阵", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-matrix",
      name: "打开拆书矩阵",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "new-book",
      name: "新建拆书",
      callback: () => {
        void this.activateView().then(() => this.getOpenView()?.openCreateBook());
      },
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
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        void this.onVaultModify(file);
      })
    );
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAISHU_MATRIX);
    this.views.clear();
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
  }

  async activateView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAISHU_MATRIX);
    let leaf: WorkspaceLeaf | null = leaves[0] ?? null;
    if (!leaf) {
      // Open as a standard main-workspace tab (not the right sidebar).
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_CHAISHU_MATRIX, active: true });
    }
    if (leaf) {
      await this.app.workspace.revealLeaf(leaf);
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    }
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

    return {
      id: b.id ?? uid("book"),
      bookInfo,
      storagePath,
      dimensions,
      structure,
      cells,
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
      children: Array.isArray(n.children)
        ? n.children.map((c: any) => this.normalizeNode(c))
        : [],
      collapsed: !!n.collapsed,
      emotionFile: typeof n.emotionFile === "string" ? n.emotionFile : "",
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
      for (const node of this.allNodes(book)) {
        if (node.summaryFile === oldPath) {
          node.summaryFile = file.path;
          changed = true;
        }
        if (node.emotionFile === oldPath) {
          node.emotionFile = file.path;
          changed = true;
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
      for (const node of this.allNodes(book)) {
        if (node.summaryFile === file.path) {
          node.summaryFile = "";
          node.summaryHasContent = false;
          changed = true;
        }
        if (node.emotionFile === file.path) {
          node.emotionFile = "";
          node.emotionData = [];
          changed = true;
        }
      }
    }
    if (changed) {
      await this.saveSettings();
      this.notifyViews();
    }
  }

  private async onVaultModify(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile)) return;
    let changed = false;
    for (const book of this.settings.books) {
      for (const ch of collectChapters(book.structure)) {
        if (ch.emotionFile === file.path) {
          try {
            const content = await this.app.vault.cachedRead(file);
            ch.emotionData = parseEmotionData(content);
            changed = true;
          } catch (e) {
            /* ignore read errors */
          }
        }
      }
    }
    if (changed) {
      await this.saveSettings();
      this.notifyViews();
    }
  }
}
