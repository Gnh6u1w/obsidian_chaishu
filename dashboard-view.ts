import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type ChaiShuMatrixPlugin from "./main";
import { BookData, VIEW_TYPE_CHAISHU_DASHBOARD } from "./types";
import { StoragePathModal } from "./modals";
import { recoverBooksFromFolder } from "./store";

/** 项目大厅 (Dashboard): standalone tab opened by the ribbon icon / command.
 *  Lists all 拆书项目 with fuzzy search + category/tag filters (with badge counts). */
export class ChaiShuDashboardView extends ItemView {
  plugin: ChaiShuMatrixPlugin;

  private searchInput!: HTMLInputElement;
  private categorySelect!: HTMLSelectElement;
  private tagSelect!: HTMLSelectElement;
  private listEl!: HTMLElement;
  private createFormEl: HTMLElement | null = null;

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

    const recoverBtn = head.createEl("button", {
      text: "📥 导入/恢复已有项目",
      cls: "chs-btn",
    });
    recoverBtn.addEventListener("click", () => this.openRecover());

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
    // V2.3: inline create panel (no centered modal) — respects 统一入口.
    if (this.createFormEl) {
      const nameInput = this.createFormEl.querySelector<HTMLInputElement>(
        ".chs-dash-create-name"
      );
      nameInput?.focus();
      return;
    }
    const panel = this.contentEl.createDiv("chs-dash-create");
    this.createFormEl = panel;
    const head = panel.createDiv("chs-dash-create-title");
    head.setText("新建拆书项目");

    const nameField = panel.createDiv("chs-dash-create-field");
    nameField.createSpan("chs-field-label").setText("拆书名称");
    const nameInput = nameField.createEl("input", {
      type: "text",
      cls: "chs-input chs-dash-create-name",
    });
    nameInput.setAttribute("placeholder", "拆书名称（必填）");

    const authorField = panel.createDiv("chs-dash-create-field");
    authorField.createSpan("chs-field-label").setText("作者");
    const authorInput = authorField.createEl("input", {
      type: "text",
      cls: "chs-input",
    });
    authorInput.setAttribute("placeholder", "作者（可选）");

    const actions = panel.createDiv("chs-dash-create-actions");
    const createBtn = actions.createEl("button", {
      text: "创建",
      cls: "chs-btn chs-btn-primary",
    });
    const cancelBtn = actions.createEl("button", {
      text: "取消",
      cls: "chs-btn",
    });

    const closePanel = () => {
      this.createFormEl?.remove();
      this.createFormEl = null;
    };

    createBtn.addEventListener("click", async () => {
      const title = nameInput.value.trim();
      if (!title) {
        new Notice("请填写拆书名称");
        return;
      }
      await this.plugin.createBook(title, authorInput.value.trim());
      closePanel();
      this.render();
      await this.plugin.openMatrix();
    });
    cancelBtn.addEventListener("click", closePanel);
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        createBtn.click();
      }
    });
    authorInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        createBtn.click();
      }
    });
    nameInput.focus();
  }

  /** V2.3: scan a folder of old notes (YAML 拆书项目/所属卷/章节名称…) and
   *  rebuild the project JSON structures. */
  private openRecover(): void {
    new StoragePathModal(this.app, {
      current: "",
      title: "导入/恢复已有项目",
      desc:
        "选择一个包含旧拆书笔记的文件夹（笔记需带 YAML 属性：拆书项目/所属卷/章节名称/分析维度）。插件会扫描并自动重建项目。",
      onSelect: async (path) => {
        if (!path) {
          new Notice("请选择文件夹");
          return;
        }
        const recovered = await recoverBooksFromFolder(this.app.vault, path);
        if (recovered.length === 0) {
          new Notice("未在所选文件夹中找到可恢复的拆书笔记");
          return;
        }
        const settings = this.settings;
        let added = 0;
        for (const b of recovered) {
          if (settings.books.some((x) => x.bookInfo.title === b.bookInfo.title)) {
            continue;
          }
          settings.books.push(b);
          added++;
        }
        await this.plugin.saveSettings();
        this.render();
        new Notice(
          added > 0
            ? `已恢复 ${added} 个项目（共扫描到 ${recovered.length} 个）`
            : `扫描到 ${recovered.length} 个项目，但都已存在`
        );
      },
    }).open();
  }
}
