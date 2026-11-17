import { Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { ChaiShuMatrixView } from "./matrix-view";
import { ChaiShuSettingTab } from "./settings";
import {
  BookData,
  ChaiShuSettings,
  DEFAULT_SETTINGS,
  VIEW_TYPE_CHAISHU_MATRIX,
} from "./types";
import { uid } from "./store";

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

    // Reverse sync: keep cell filePath in sync when notes are renamed/moved/deleted.
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
    this.views.clear();
  }

  getSettings(): ChaiShuSettings {
    return this.settings;
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<ChaiShuSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
    if (!Array.isArray(this.settings.books)) this.settings.books = [];
    this.settings.books = this.settings.books.map((b) => this.normalizeBook(b));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  notifyViews(): void {
    for (const v of this.views) v.refresh();
  }

  async activateView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAISHU_MATRIX);
    let leaf = leaves[0];
    if (!leaf) {
      const right = this.app.workspace.getRightLeaf(false);
      if (right) {
        await right.setViewState({ type: VIEW_TYPE_CHAISHU_MATRIX, active: true });
        leaf = right;
      }
    }
    if (leaf) this.app.workspace.revealLeaf(leaf);
  }

  getOpenView(): ChaiShuMatrixView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAISHU_MATRIX);
    const leaf = leaves[0];
    return leaf && leaf.view instanceof ChaiShuMatrixView ? leaf.view : null;
  }

  private normalizeBook(b: BookData): BookData {
    return {
      id: b.id ?? uid("book"),
      bookInfo: {
        title: b.bookInfo?.title ?? "未命名拆书",
        author: b.bookInfo?.author ?? "",
        score: b.bookInfo?.score ?? "",
      },
      dimensions: Array.isArray(b.dimensions) ? b.dimensions : [],
      chapters: Array.isArray(b.chapters) ? b.chapters : [],
      cells: b.cells && typeof b.cells === "object" ? b.cells : {},
    };
  }

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
    }
    if (changed) {
      await this.saveSettings();
      this.notifyViews();
    }
  }
}
