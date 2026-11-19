import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type ChaiShuMatrixPlugin from "./main";
import { BookData, VIEW_TYPE_CHAISHU_DASHBOARD } from "./types";
import { BookCreateModal } from "./modals";

/** 项目大厅 (Dashboard): standalone tab opened by the ribbon icon / command.
 *  Lists all 拆书项目 with fuzzy search + category/tag filters (with badge counts). */
export class ChaiShuDashboardView extends ItemView {
  plugin: ChaiShuMatrixPlugin;

  private searchInput!: HTMLInputElement;
  private categorySelect!: HTMLSelectElement;
  private tagSelect!: HTMLSelectElement;
  private listEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: ChaiShuMatrixPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAISHU_DASHBOARD;
  }

  getDisplayText(): string {
    return "项目大厅";
  }

  getIcon(): string {
    return "layout-grid";
  }

  private get settings() {
    return this.plugin.getSettings();
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chs-dashboard");

    const head = contentEl.createDiv("chs-dash-head");
    const titleWrap = head.createDiv("chs-dash-titlewrap");
    const icon = titleWrap.createSpan("chs-dash-icon");
    setIcon(icon, "layout-grid");
    titleWrap.createSpan("chs-dash-title").setText("ChaiShu 项目大厅");

    const newBtn = head.createEl("button", {
      text: "＋ 新建拆书项目",
      cls: "chs-btn chs-btn-primary",
    });
    newBtn.addEventListener("click", () => this.openCreateBook());

    const controls = contentEl.createDiv("chs-dash-controls");
    this.searchInput = controls.createEl("input", { type: "text" });
    this.searchInput.addClass("chs-input", "chs-dash-search");
    this.searchInput.setAttribute("placeholder", "🔍 搜索拆书名称…");
    this.searchInput.addEventListener("input", () => this.renderList());

    this.categorySelect = controls.createEl("select");
    this.categorySelect.addClass("chs-select", "chs-dash-filter");
    this.tagSelect = controls.createEl("select");
    this.tagSelect.addClass("chs-select", "chs-dash-filter");
    this.categorySelect.addEventListener("change", () => this.renderList());
    this.tagSelect.addEventListener("change", () => this.renderList());

    this.listEl = contentEl.createDiv("chs-dash-list");

    this.renderFilters();
    this.renderList();
  }

  private allBooks(): BookData[] {
    return this.settings.books ?? [];
  }

  private renderFilters(): void {
    const catCounts = new Map<string, number>();
    const tagCounts = new Map<string, number>();
    for (const b of this.allBooks()) {
      for (const c of b.bookInfo.category ?? []) catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
      for (const t of b.bookInfo.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }

    const prevCat = this.categorySelect.value;
    const prevTag = this.tagSelect.value;

    this.categorySelect.empty();
    const catAll = this.categorySelect.createEl("option");
    catAll.value = "";
    catAll.textContent = "全部分类 (" + this.allBooks().length + ")";
    for (const [c, n] of [...catCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const opt = this.categorySelect.createEl("option");
      opt.value = c;
      opt.textContent = c + " (" + n + ")";
    }
    this.categorySelect.value = prevCat;

    this.tagSelect.empty();
    const tagAll = this.tagSelect.createEl("option");
    tagAll.value = "";
    tagAll.textContent = "全部标签 (" + this.allBooks().length + ")";
    for (const [t, n] of [...tagCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const opt = this.tagSelect.createEl("option");
      opt.value = t;
      opt.textContent = t + " (" + n + ")";
    }
    this.tagSelect.value = prevTag;
  }

  private renderList(): void {
    this.renderFilters();
    const query = this.searchInput.value.trim().toLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);
    const cat = this.categorySelect.value;
    const tag = this.tagSelect.value;

    const books = this.allBooks().filter((b) => {
      if (tokens.length > 0) {
        const hay = (b.bookInfo.title + " " + (b.bookInfo.author ?? "")).toLowerCase();
        if (!tokens.every((t) => hay.includes(t))) return false;
      }
      if (cat && !(b.bookInfo.category ?? []).includes(cat)) return false;
      if (tag && !(b.bookInfo.tags ?? []).includes(tag)) return false;
      return true;
    });

    this.listEl.empty();
    if (books.length === 0) {
      const empty = this.listEl.createDiv("chs-dash-empty");
      empty.setText(this.allBooks().length === 0 ? "还没有拆书项目" : "没有匹配的项目");
      if (this.allBooks().length === 0) {
        const btn = empty.createEl("button", {
          text: "＋ 新建拆书项目",
          cls: "chs-btn chs-btn-primary",
        });
        btn.addEventListener("click", () => this.openCreateBook());
      }
      return;
    }

    for (const b of books) {
      const card = this.listEl.createDiv("chs-dash-card");
      card.dataset.bookId = b.id;

      const meta = card.createDiv("chs-dash-card-meta");
      meta.createDiv("chs-dash-card-title").setText(b.bookInfo.title || "未命名拆书");
      if (b.bookInfo.author) {
        meta.createDiv("chs-dash-card-author").setText("作者：" + b.bookInfo.author);
      }
      if ((b.bookInfo.category ?? []).length > 0) {
        const catRow = meta.createDiv("chs-dash-card-tags");
        for (const c of b.bookInfo.category) catRow.createSpan("chs-chip").setText(c);
      }
      if ((b.bookInfo.tags ?? []).length > 0) {
        const tagRow = meta.createDiv("chs-dash-card-tags");
        for (const t of b.bookInfo.tags) {
          const chip = tagRow.createSpan("chs-chip chs-chip-tag");
          chip.setText("# " + t);
        }
      }

      const openBtn = card.createEl("button", {
        text: "打开矩阵",
        cls: "chs-btn chs-btn-primary chs-btn-sm",
      });
      openBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.plugin.openMatrix(b.id);
      });

      card.addEventListener("click", () => void this.plugin.openMatrix(b.id));
    }
  }

  private openCreateBook(): void {
    new BookCreateModal(this.app, async (title, author) => {
      await this.plugin.createBook(title, author);
      await this.plugin.openMatrix();
    }).open();
  }
}
