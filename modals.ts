import {
  App,
  ButtonComponent,
  FuzzySuggestModal,
  Modal,
  Notice,
  normalizePath,
  Setting,
  TextAreaComponent,
  TFile,
  TFolder,
} from "obsidian";
import {
  DEFAULT_Y_AXIS_LABELS,
  DIMENSION_COLOR_NAMES,
  DIMENSION_COLORS,
  Dimension,
  EMOTION_LEVELS,
  ImportRequest,
  BookData,
} from "./types";
import {
  cellKey,
  collectChapters,
  collectUnits,
  collectVolumes,
  ensureFolder,
  normalizeYAxisLabels,
  sanitizeFileName,
} from "./store";

const SVG_NS = "http://www.w3.org/2000/svg";

// Emotion editor canvas layout (pixels in the SVG coordinate system).
const EMO_PAD_LEFT = 44;
const EMO_PAD_RIGHT = 12;
const EMO_PAD_TOP = 16;
const EMO_PAD_BOTTOM = 30;
const EMO_HEIGHT = 250;
const EMO_PLOT_W = 520;

let emoClipSeq = 0;

function makeSvgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** Minimal single-line text prompt (used for naming a new collected unit). */
export class PromptModal extends Modal {
  private value = "";

  constructor(
    app: App,
    private opts: {
      title: string;
      placeholder?: string;
      initial?: string;
      confirmText?: string;
      onConfirm: (value: string) => void;
    }
  ) {
    super(app);
    this.value = opts.initial ?? "";
  }

  onOpen(): void {
    this.contentEl.addClass("chs-modal");
    this.contentEl.createEl("h2", { text: this.opts.title });
    const input = this.contentEl.createEl("input", { type: "text", cls: "chs-input" });
    input.value = this.value;
    input.placeholder = this.opts.placeholder ?? "";
    input.addEventListener("input", () => (this.value = input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.opts.onConfirm(this.value);
        this.close();
      }
    });
    const footer = this.contentEl.createDiv("chs-modal-actions");
    new ButtonComponent(footer).setButtonText("取消").onClick(() => this.close());
    new ButtonComponent(footer)
      .setButtonText(this.opts.confirmText ?? "确定")
      .setCta()
      .onClick(() => {
        this.opts.onConfirm(this.value);
        this.close();
      });
    setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class BookCreateModal extends Modal {
  private title = "";
  private author = "";

  constructor(
    app: App,
    private onSubmit: (title: string, author: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chs-modal");
    contentEl.createEl("h2", { text: "新建拆书" });

    new Setting(contentEl)
      .setName("拆书名称")
      .setDesc("将作为归档文件夹名称（自动添加书名号《》）")
      .addText((t) => {
        t.setPlaceholder("例如：三体")
          .onChange((v) => (this.title = v))
          .inputEl.addClass("chs-input");
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") this.submit();
        });
      });

    new Setting(contentEl)
      .setName("作者")
      .addText((t) => {
        t.setPlaceholder("例如：刘慈欣")
          .onChange((v) => (this.author = v))
          .inputEl.addClass("chs-input");
      });

    const footer = contentEl.createDiv("chs-modal-actions");
    new ButtonComponent(footer).setButtonText("取消").onClick(() => this.close());
    new ButtonComponent(footer)
      .setButtonText("创建")
      .setCta()
      .onClick(() => this.submit());
  }

  private submit(): void {
    const title = this.title.trim();
    if (!title) {
      new Notice("请输入拆书名称");
      return;
    }
    this.close();
    this.onSubmit(title, this.author.trim());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class DimensionModal extends Modal {
  private name = "";
  private color = DIMENSION_COLORS[0];
  private isChart = false;
  private yAxisLabels: string[] = [...DEFAULT_Y_AXIS_LABELS];
  private isEdit = false;

  constructor(
    app: App,
    private opts: {
      title: string;
      initial?: Dimension;
      onSave: (name: string, color: string, isChart: boolean, yAxisLabels: string[]) => void;
      onDelete?: () => void;
    }
  ) {
    super(app);
    if (opts.initial) {
      this.name = opts.initial.name;
      this.color = opts.initial.color;
      this.isChart = opts.initial.isChart;
      this.yAxisLabels = normalizeYAxisLabels(opts.initial.yAxisLabels);
      this.isEdit = true;
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chs-modal");
    contentEl.createEl("h2", { text: this.opts.title });

    new Setting(contentEl).setName("维度名称").addText((t) => {
      t.setValue(this.name)
        .setPlaceholder("例如：情绪")
        .onChange((v) => (this.name = v))
        .inputEl.addClass("chs-input");
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.submit();
      });
    });

    const swatches = contentEl.createDiv("chs-swatches");
    for (let i = 0; i < DIMENSION_COLORS.length; i++) {
      const c = DIMENSION_COLORS[i];
      const sw = swatches.createDiv("chs-swatch");
      sw.style.backgroundColor = c;
      sw.setAttribute("aria-label", DIMENSION_COLOR_NAMES[i]);
      if (c === this.color) sw.addClass("is-active");
      sw.addEventListener("click", () => {
        this.color = c;
        swatches
          .querySelectorAll(".chs-swatch")
          .forEach((el) => el.removeClass("is-active"));
        sw.addClass("is-active");
      });
    }

    new Setting(contentEl).setName("自定义颜色").setDesc("十六进制色值，例如 #3b82f6").addText((t) => {
      t.setPlaceholder("#3b82f6").onChange((v) => {
        const val = v.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(val)) {
          this.color = val;
          swatches
            .querySelectorAll(".chs-swatch")
            .forEach((el) => el.removeClass("is-active"));
        }
      });
    });

    new Setting(contentEl)
      .setName("开启情绪折线画板")
      .setDesc("开启后，该维度拥有专属的折线图绘制功能")
      .addToggle((t) => t.setValue(this.isChart).onChange((v) => (this.isChart = v)));

    new Setting(contentEl)
      .setName("Y轴 5 层级名称")
      .setDesc("从低到高 5 层，用逗号分隔（第 3 层为基准线）")
      .addText((t) => {
        t.setValue(this.yAxisLabels.join(",")).onChange((v) => {
          this.yAxisLabels = normalizeYAxisLabels(v.split(/[,，、\s]+/).filter(Boolean));
        });
      });

    const footer = contentEl.createDiv("chs-modal-actions");
    new ButtonComponent(footer).setButtonText("取消").onClick(() => this.close());
    if (this.isEdit && this.opts.onDelete) {
      new ButtonComponent(footer)
        .setButtonText("删除维度")
        .setWarning()
        .onClick(() => {
          this.close();
          this.opts.onDelete?.();
        });
    }
    new ButtonComponent(footer)
      .setButtonText("保存")
      .setCta()
      .onClick(() => this.submit());
  }

  private submit(): void {
    const name = this.name.trim();
    if (!name) {
      new Notice("请输入维度名称");
      return;
    }
    this.close();
    this.opts.onSave(name, this.color || DIMENSION_COLORS[0], this.isChart, this.yAxisLabels);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class CellEditModal extends Modal {
  private textarea!: TextAreaComponent;

  constructor(
    app: App,
    private opts: {
      title: string;
      initialBody: string;
      onSave: (body: string) => Promise<void> | void;
    }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chs-modal", "chs-cell-modal");
    contentEl.createEl("h2", { text: this.opts.title });

    this.textarea = new TextAreaComponent(contentEl);
    this.textarea.setValue(this.opts.initialBody);
    this.textarea.inputEl.addClass("chs-textarea");
    this.textarea.inputEl.rows = 10;
    this.textarea.inputEl.setAttribute(
      "placeholder",
      "在此输入内容…\n支持多行文本，保存后自动归档为笔记"
    );

    const footer = contentEl.createDiv("chs-modal-actions");
    new ButtonComponent(footer).setButtonText("取消").onClick(() => this.close());
    new ButtonComponent(footer)
      .setButtonText("保存")
      .setCta()
      .onClick(async () => {
        const body = this.textarea.getValue();
        if (!body.trim()) {
          new Notice("内容为空，未保存");
          return;
        }
        await this.opts.onSave(body);
        this.close();
      });

    window.setTimeout(() => this.textarea.inputEl.focus(), 60);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Editable textarea modal for summaries; empty body deletes the summary note. */
export class SummaryModal extends Modal {
  private textarea!: TextAreaComponent;

  constructor(
    app: App,
    private opts: {
      title: string;
      initialBody: string;
      onSave: (body: string) => Promise<void> | void;
    }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chs-modal", "chs-cell-modal");
    contentEl.createEl("h2", { text: this.opts.title });

    this.textarea = new TextAreaComponent(contentEl);
    this.textarea.setValue(this.opts.initialBody);
    this.textarea.inputEl.addClass("chs-textarea");
    this.textarea.inputEl.rows = 8;
    this.textarea.inputEl.setAttribute("placeholder", "在此输入总结内容…（留空保存将删除该总结）");

    const footer = contentEl.createDiv("chs-modal-actions");
    new ButtonComponent(footer).setButtonText("取消").onClick(() => this.close());
    new ButtonComponent(footer)
      .setButtonText("保存")
      .setCta()
      .onClick(async () => {
        await this.opts.onSave(this.textarea.getValue());
        this.close();
      });

    window.setTimeout(() => this.textarea.inputEl.focus(), 60);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private opts: {
      title: string;
      message: string;
      confirmText: string;
      danger?: boolean;
      onConfirm: () => void;
    }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chs-modal");
    contentEl.createEl("h2", { text: this.opts.title });
    contentEl.createEl("p", { text: this.opts.message });

    const footer = contentEl.createDiv("chs-modal-actions");
    new ButtonComponent(footer).setButtonText("取消").onClick(() => this.close());
    const b = new ButtonComponent(footer).setButtonText(this.opts.confirmText);
    if (this.opts.danger) b.setWarning();
    b.onClick(() => {
      this.close();
      this.opts.onConfirm();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Pick the vault folder where books are archived. */
export class StoragePathModal extends Modal {
  private pathInput!: HTMLInputElement;

  constructor(
    app: App,
    private opts: {
      current: string;
      onSelect: (path: string) => void;
      title?: string;
      desc?: string;
    }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chs-modal");
    contentEl.createEl("h2", {
      text: this.opts.title ?? "拆书文件夹存放位置",
    });
    contentEl.createEl("p", {
      text:
        this.opts.desc ??
        "该路径下将自动生成 《书名》/卷/单元/章节 的层级文件夹。",
    });

    new Setting(contentEl).setName("存放路径").setDesc("留空 = 库根目录").addText((t) => {
      t.setPlaceholder("例如：拆书项目")
        .setValue(this.opts.current)
        .inputEl.addClass("chs-input");
      this.pathInput = t.inputEl;
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.commit();
      });
    });

    const list = contentEl.createDiv("chs-folder-list");
    const root = list.createEl("button", { cls: "chs-folder-item" });
    root.setText("📁 库根目录");
    root.addEventListener("click", () => this.commit(""));

    const folders = (this.app.vault.getAllLoadedFiles() as Array<TFolder | TFile>).filter(
      (f): f is TFolder => f instanceof TFolder
    );
    folders.sort((a, b) => a.path.localeCompare(b.path));
    for (const folder of folders) {
      const btn = list.createEl("button", { cls: "chs-folder-item" });
      const indent = "　".repeat(Math.max(0, folder.path.split("/").length - 1));
      btn.setText(indent + "📁 " + (folder.path.split("/").pop() || folder.path));
      btn.addEventListener("click", () => this.commit(folder.path));
    }

    const footer = contentEl.createDiv("chs-modal-actions");
    new ButtonComponent(footer).setButtonText("取消").onClick(() => this.close());
    new ButtonComponent(footer).setButtonText("确定").setCta().onClick(() => this.commit());
  }

  private commit(path?: string): void {
    const value = path !== undefined ? path : this.pathInput?.value?.trim() ?? "";
    this.close();
    this.opts.onSelect(normalizePath(value));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Upload or pick a wallpaper image, configure cover/repeat and overlay. */
export class WallpaperModal extends Modal {
  constructor(
    app: App,
    private opts: {
      bgImage: string;
      bgMode: "cover" | "repeat";
      bgOverlay: number;
      onApply: (patch: { bgImage?: string; bgMode?: "cover" | "repeat"; bgOverlay?: number }) => void | Promise<void>;
    }
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chs-modal");
    contentEl.createEl("h2", { text: "壁纸与背景" });

    const status = contentEl.createEl("p", { cls: "chs-wallpaper-status" });
    status.setText(this.opts.bgImage ? "当前壁纸：" + this.opts.bgImage : "未设置壁纸");

    new Setting(contentEl)
      .setName("背景模式")
      .addDropdown((d) => {
        d.addOption("cover", "覆盖 (Cover)");
        d.addOption("repeat", "平铺 (Repeat)");
        d.setValue(this.opts.bgMode);
        d.onChange((v) => void this.opts.onApply({ bgMode: v as "cover" | "repeat" }));
      });

    new Setting(contentEl)
      .setName("遮罩透明度")
      .setDesc("数值越大遮罩越深，文字越清晰")
      .addSlider((s) => {
        s.setLimits(0, 100, 1);
        s.setValue(Math.round((this.opts.bgOverlay ?? 0.3) * 100));
        s.setDynamicTooltip();
        s.onChange((v) => void this.opts.onApply({ bgOverlay: v / 100 }));
      });

    const row = contentEl.createDiv("chs-wallpaper-actions");
    const uploadBtn = row.createEl("button", { cls: "chs-btn chs-btn-primary", text: "上传壁纸" });
    uploadBtn.addEventListener("click", () => this.uploadImage());

    const pickBtn = row.createEl("button", { cls: "chs-btn", text: "从库中选择" });
    pickBtn.addEventListener("click", () => this.pickFromVault());

    if (this.opts.bgImage) {
      const removeBtn = row.createEl("button", { cls: "chs-btn chs-btn-ghost chs-btn-danger-text", text: "移除壁纸" });
      removeBtn.addEventListener("click", () => void this.opts.onApply({ bgImage: "" }));
    }
  }

  private async uploadImage(): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const dir = "_chaishu_assets";
        await ensureFolder(this.app.vault, dir);
        const name = sanitizeFileName(f.name || "壁纸.png");
        const path = normalizePath(dir + "/" + name);
        const buf = await f.arrayBuffer();
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
          await this.app.vault.modifyBinary(existing, buf);
        } else {
          await this.app.vault.createBinary(path, buf);
        }
        await this.opts.onApply({ bgImage: path });
        this.render();
        new Notice("壁纸已上传：" + path);
      } catch (e) {
        new Notice("壁纸上传失败");
      }
    });
    input.click();
  }

  private pickFromVault(): void {
    const images = this.app.vault
      .getFiles()
      .filter((f) => /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(f.extension));
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chs-modal");
    contentEl.createEl("h2", { text: "从库中选择壁纸" });
    const list = contentEl.createDiv("chs-folder-list");
    if (images.length === 0) {
      list.createEl("p", { text: "库中没有图片文件，请使用「上传壁纸」。" });
    }
    for (const img of images) {
      const btn = list.createEl("button", { cls: "chs-folder-item" });
      btn.setText("🖼 " + img.path);
      btn.addEventListener("click", () => {
        void this.opts.onApply({ bgImage: img.path });
        this.close();
      });
    }
    const footer = contentEl.createDiv("chs-modal-actions");
    new ButtonComponent(footer).setButtonText("返回").onClick(() => this.render());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Search and pick an existing vault markdown note. */
export class NoteSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onChoose: (file: TFile) => void) {
    super(app);
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  onChooseItem(item: TFile): void {
    this.onChoose(item);
  }
}

/** Import an external file or an existing vault note into a target cell. */
export class ImportModal extends Modal {
  private sourceType: "external" | "vault" | null = null;
  private sourceName = "";
  private content = "";
  private vaultPath = "";
  private chapterId = "";
  private dimensionId = "";
  private move = true;
  private statusEl!: HTMLElement;

  constructor(
    app: App,
    private opts: {
      chapters: { id: string; name: string }[];
      dimensions: { id: string; name: string }[];
      onImport: (req: ImportRequest) => Promise<void> | void;
    }
  ) {
    super(app);
    this.chapterId = opts.chapters[0]?.id ?? "";
    this.dimensionId = opts.dimensions[0]?.id ?? "";
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chs-modal");
    contentEl.createEl("h2", { text: "导入笔记" });

    const srcRow = contentEl.createDiv("chs-modal-actions");
    const extBtn = srcRow.createEl("button", { cls: "chs-btn", text: "导入本地文件 (.md/.txt)" });
    extBtn.addEventListener("click", () => this.pickFile());
    const vaultBtn = srcRow.createEl("button", { cls: "chs-btn", text: "从库中选择笔记" });
    vaultBtn.addEventListener("click", () => this.pickVaultNote());

    this.statusEl = contentEl.createDiv("chs-import-status");
    this.updateStatus();

    new Setting(contentEl).setName("目标章节").addDropdown((d) => {
      for (const c of this.opts.chapters) d.addOption(c.id, c.name);
      d.setValue(this.chapterId);
      d.onChange((v) => (this.chapterId = v));
    });

    new Setting(contentEl).setName("目标维度").addDropdown((d) => {
      for (const dm of this.opts.dimensions) d.addOption(dm.id, dm.name);
      d.setValue(this.dimensionId);
      d.onChange((v) => (this.dimensionId = v));
    });

    if (this.sourceType === "vault") {
      new Setting(contentEl)
        .setName("移动到拆书文件夹")
        .setDesc("若笔记不在拆书文件夹中，导入时将其移动过去")
        .addToggle((t) => t.setValue(this.move).onChange((v) => (this.move = v)));
    }

    const footer = contentEl.createDiv("chs-modal-actions");
    new ButtonComponent(footer).setButtonText("取消").onClick(() => this.close());
    new ButtonComponent(footer).setButtonText("导入").setCta().onClick(() => this.submit());
  }

  private pickFile(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.txt,text/markdown,text/plain";
    input.addEventListener("change", async () => {
      const f = input.files?.[0];
      if (!f) return;
      this.sourceType = "external";
      this.sourceName = f.name;
      this.content = await f.text();
      this.render();
    });
    input.click();
  }

  private pickVaultNote(): void {
    new NoteSuggestModal(this.app, (file) => {
      this.sourceType = "vault";
      this.sourceName = file.name;
      this.vaultPath = file.path;
      this.content = "";
      this.render();
    }).open();
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    this.statusEl.empty();
    if (!this.sourceType) {
      this.statusEl.setText("尚未选择来源笔记");
    } else if (this.sourceType === "external") {
      this.statusEl.setText("已选文件：" + this.sourceName);
    } else {
      this.statusEl.setText("已选库内笔记：" + this.vaultPath);
    }
  }

  private submit(): void {
    if (!this.sourceType) {
      new Notice("请先选择来源笔记");
      return;
    }
    if (!this.chapterId) {
      new Notice("请选择目标章节");
      return;
    }
    if (!this.dimensionId) {
      new Notice("请选择目标维度");
      return;
    }
    this.close();
    this.opts.onImport({
      sourceType: this.sourceType,
      sourceName: this.sourceName,
      content: this.sourceType === "external" ? this.content : undefined,
      vaultPath: this.sourceType === "vault" ? this.vaultPath : undefined,
      chapterId: this.chapterId,
      dimensionId: this.dimensionId,
      move: this.move,
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** In-place emotion line editor: click/drag to draw, no external note. */
export class EmotionEditorModal extends Modal {
  private data: number[];
  private svgEl: SVGSVGElement | null = null;
  private polyEl: SVGElement | null = null;
  private pointsEl: SVGElement | null = null;
  private eraser = false;
  private dragging = false;
  private dragIndex = -1;
  // Tap-vs-drag disambiguation + rAF throttle (mobile anti-mistouch).
  private pending = false;
  private downX = 0;
  private downY = 0;
  private rafId: number | null = null;

  constructor(
    app: App,
    private opts: {
      title: string;
      color: string;
      yAxisLabels: string[];
      initial: number[];
      onSave: (data: number[]) => void;
    }
  ) {
    super(app);
    this.data = (opts.initial && opts.initial.length ? opts.initial : [3, 3, 3, 3, 3]).slice();
  }

  onOpen(): void {
    this.render();
  }

  private yPx(level: number): number {
    const plotH = EMO_HEIGHT - EMO_PAD_TOP - EMO_PAD_BOTTOM;
    return EMO_PAD_TOP + ((EMOTION_LEVELS - level) / (EMOTION_LEVELS - 1)) * plotH;
  }

  private xPx(i: number): number {
    const n = this.data.length;
    if (n <= 1) return EMO_PAD_LEFT; // pin the first point to the X origin
    return EMO_PAD_LEFT + (i / (n - 1)) * EMO_PLOT_W;
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chs-modal", "chs-emotion-modal");
    contentEl.createEl("h2", { text: this.opts.title });

    this.buildCanvas(contentEl);

    const controls = contentEl.createDiv("chs-emotion-controls");
    const addBtn = controls.createEl("button", { cls: "chs-btn chs-btn-sm", text: "＋ 添加点" });
    addBtn.addEventListener("click", () => {
      this.data.push(3);
      this.render();
    });
    const delBtn = controls.createEl("button", { cls: "chs-btn chs-btn-sm", text: "－ 删除末点" });
    delBtn.addEventListener("click", () => {
      if (this.data.length > 1) this.data.pop();
      this.render();
    });
    const flatBtn = controls.createEl("button", { cls: "chs-btn chs-btn-sm", text: "一键打平" });
    flatBtn.addEventListener("click", () => {
      this.data = [3, 3, 3, 3, 3];
      this.render();
    });
    const clearBtn = controls.createEl("button", { cls: "chs-btn chs-btn-sm chs-btn-ghost", text: "清除" });
    clearBtn.addEventListener("click", () => {
      this.data = [];
      this.render();
    });
    const eraserBtn = controls.createEl("button", { cls: "chs-btn chs-btn-sm", text: "🧽 橡皮擦" });
    eraserBtn.addEventListener("click", () => {
      this.eraser = !this.eraser;
      eraserBtn.toggleClass("chs-btn-primary", this.eraser);
    });

    const hint = contentEl.createDiv("chs-emotion-hint");
    hint.setText("点击画布添加点 · 拖拽圆点修改高低 · 橡皮擦模式点击圆点可删除");

    const footer = contentEl.createDiv("chs-modal-actions");
    new ButtonComponent(footer).setButtonText("取消").onClick(() => this.close());
    new ButtonComponent(footer)
      .setButtonText("保存")
      .setCta()
      .onClick(() => {
        this.opts.onSave(this.data.slice());
        this.close();
      });
  }

  private buildCanvas(parent: HTMLElement): void {
    const labels = this.opts.yAxisLabels ?? DEFAULT_Y_AXIS_LABELS;
    const plotH = EMO_HEIGHT - EMO_PAD_TOP - EMO_PAD_BOTTOM;
    const totalW = EMO_PAD_LEFT + EMO_PLOT_W + EMO_PAD_RIGHT;

    const scroll = parent.createDiv("chs-emotion-scroll");
    const svg = makeSvgEl("svg", {
      width: String(totalW),
      height: String(EMO_HEIGHT),
    });
    svg.setAttribute("class", "chs-emotion-canvas");
    svg.style.touchAction = "none";
    svg.style.cursor = "crosshair";

    for (let level = 1; level <= EMOTION_LEVELS; level++) {
      const y = this.yPx(level);
      const isBaseline = level === 3;
      const line = makeSvgEl("line", {
        x1: String(EMO_PAD_LEFT),
        x2: String(EMO_PAD_LEFT + EMO_PLOT_W),
        y1: String(y),
        y2: String(y),
      });
      line.style.stroke = "var(--background-modifier-border)";
      line.setAttribute("stroke-width", isBaseline ? "1.5" : "1");
      if (isBaseline) line.setAttribute("stroke-dasharray", "4 3");
      svg.appendChild(line);

      const lbl = makeSvgEl("text", {
        x: String(EMO_PAD_LEFT - 8),
        y: String(y + 4),
        "text-anchor": "end",
      });
      lbl.textContent = labels[level - 1] ?? String(level);
      lbl.style.fill = isBaseline ? "var(--text-normal)" : "var(--text-muted)";
      lbl.setAttribute("font-size", "11");
      if (isBaseline) lbl.setAttribute("font-weight", "600");
      svg.appendChild(lbl);
    }

    const xAxis = makeSvgEl("line", {
      x1: String(EMO_PAD_LEFT),
      x2: String(EMO_PAD_LEFT + EMO_PLOT_W),
      y1: String(EMO_PAD_TOP + plotH),
      y2: String(EMO_PAD_TOP + plotH),
    });
    xAxis.style.stroke = "var(--background-modifier-border)";
    xAxis.setAttribute("stroke-width", "1");
    svg.appendChild(xAxis);

    // Clip the polyline + points to the plot rect so nothing draws past the right edge.
    const clipId = "chs-emo-clip-" + emoClipSeq++;
    const defs = makeSvgEl("defs", {});
    const clip = makeSvgEl("clipPath", {});
    clip.setAttribute("id", clipId);
    clip.appendChild(
      makeSvgEl("rect", {
        x: String(EMO_PAD_LEFT),
        y: String(EMO_PAD_TOP),
        width: String(EMO_PLOT_W),
        height: String(plotH),
      })
    );
    defs.appendChild(clip);
    svg.appendChild(defs);

    const poly = makeSvgEl("polyline", {
      points: "",
      fill: "none",
      "stroke-width": "2.5",
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    });
    poly.setAttribute("stroke", this.opts.color);
    poly.setAttribute("clip-path", "url(#" + clipId + ")");
    svg.appendChild(poly);
    this.polyEl = poly;

    const pointsG = makeSvgEl("g", {});
    pointsG.setAttribute("clip-path", "url(#" + clipId + ")");
    svg.appendChild(pointsG);
    this.pointsEl = pointsG;

    svg.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.onPointerDown(e as PointerEvent);
    });
    svg.addEventListener("pointermove", (e) => {
      if (this.pending || this.dragging) this.onPointerMove(e as PointerEvent);
    });
    const finish = () => this.onPointerUp();
    svg.addEventListener("pointerup", finish);
    svg.addEventListener("pointercancel", finish);
    svg.addEventListener("pointerleave", finish);

    scroll.appendChild(svg);
    this.svgEl = svg as SVGSVGElement;
    this.updateLine();
  }

  private onPointerDown(e: PointerEvent): void {
    const svg = this.svgEl;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    this.downX = e.clientX - rect.left;
    this.downY = e.clientY - rect.top;
    this.pending = true;
    this.dragging = false;
    this.dragIndex = this.nearestPoint(this.downX, this.downY);
  }

  private onPointerMove(e: PointerEvent): void {
    const svg = this.svgEl;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    if (this.pending) {
      const dx = px - this.downX;
      const dy = py - this.downY;
      if (dx * dx + dy * dy < 36) return; // < 6px: still a tap
      // Commit to a drag.
      this.pending = false;
      if (this.eraser) {
        this.dragging = false;
        return;
      }
      if (this.dragIndex !== -1) {
        this.dragging = true;
      } else {
        this.dragIndex = this.insertAt(this.downX);
        this.data.splice(this.dragIndex, 0, this.levelAt(this.downY));
        this.dragging = true;
      }
    }

    if (this.dragging && this.dragIndex >= 0 && this.dragIndex < this.data.length) {
      this.data[this.dragIndex] = this.levelAt(py);
    }
    this.scheduleUpdate();
  }

  private onPointerUp(): void {
    if (this.pending) {
      this.pending = false;
      if (this.eraser) {
        if (this.dragIndex !== -1) {
          this.data.splice(this.dragIndex, 1);
          this.dragIndex = -1;
          this.render();
        }
      } else if (this.dragIndex === -1) {
        const insertAt = this.insertAt(this.downX);
        this.data.splice(insertAt, 0, this.levelAt(this.downY));
      }
    }
    this.dragging = false;
    this.dragIndex = -1;
    this.flushUpdate();
  }

  private insertAt(px: number): number {
    const n = this.data.length;
    if (n === 0) return 0;
    const rel = Math.max(0, Math.min(1, (px - EMO_PAD_LEFT) / EMO_PLOT_W));
    return Math.max(0, Math.min(n, Math.round(rel * n)));
  }

  private scheduleUpdate(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.updateLine();
    });
  }

  private flushUpdate(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.updateLine();
  }

  private levelAt(py: number): number {
    const plotH = EMO_HEIGHT - EMO_PAD_TOP - EMO_PAD_BOTTOM;
    const raw = EMOTION_LEVELS - ((py - EMO_PAD_TOP) / plotH) * (EMOTION_LEVELS - 1);
    return Math.max(1, Math.min(EMOTION_LEVELS, Math.round(raw)));
  }

  private nearestPoint(px: number, py: number): number {
    const n = this.data.length;
    for (let i = 0; i < n; i++) {
      if (Math.abs(this.xPx(i) - px) < 14 && Math.abs(this.yPx(this.data[i]) - py) < 14) {
        return i;
      }
    }
    return -1;
  }

  private updateLine(): void {
    if (!this.polyEl || !this.pointsEl) return;
    const n = this.data.length;
    const pts = this.data.map((v, i) => this.xPx(i) + "," + this.yPx(v));
    this.polyEl.setAttribute("points", pts.join(" "));
    this.polyEl.setAttribute("stroke", this.opts.color);

    while (this.pointsEl.firstChild) this.pointsEl.removeChild(this.pointsEl.firstChild);
    for (let i = 0; i < n; i++) {
      const c = makeSvgEl("circle", {
        cx: String(this.xPx(i)),
        cy: String(this.yPx(this.data[i])),
        r: "5",
      });
      c.setAttribute("fill", this.opts.color);
      this.pointsEl.appendChild(c);
    }
  }

  onClose(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.contentEl.empty();
  }
}
export class MoveNodeModal extends Modal {
  constructor(
    app: App,
    private opts: {
      targets: { id: string; name: string; type: "volume" | "unit" }[];
      onSelect: (targetId: string | null) => void;
    }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chs-modal");
    contentEl.createEl("h2", { text: "移动到…" });

    const list = contentEl.createDiv("chs-folder-list");
    const root = list.createEl("button", { cls: "chs-folder-item" });
    root.setText("📁 顶层（根）");
    root.addEventListener("click", () => {
      this.close();
      this.opts.onSelect(null);
    });

    for (const t of this.opts.targets) {
      const btn = list.createEl("button", { cls: "chs-folder-item" });
      btn.setText((t.type === "volume" ? "📚 " : "📦 ") + t.name);
      btn.addEventListener("click", () => {
        this.close();
        this.opts.onSelect(t.id);
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ==================================================== global note search (V2.1)

interface SearchItem {
  path: string;
  label: string;
  detail: string;
  body: string;
}

/** Fuzzy search across ALL notes of the current project (chapter cells, per-dim
 *  summaries, character notes). Keyword-match on label + frontmatter + body. */
export class FuzzySearchModal extends Modal {
  private book: BookData;
  private openNote: (path: string) => void;
  private input!: HTMLInputElement;
  private list!: HTMLElement;
  private items: SearchItem[] = [];
  private timer: number | null = null;

  constructor(app: App, opts: { book: BookData; onOpen: (path: string) => void }) {
    super(app);
    this.book = opts.book;
    this.openNote = opts.onOpen;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chs-modal", "chs-search-modal");
    contentEl.createEl("h2", { text: "全局查询 · " + this.book.bookInfo.title });

    this.input = contentEl.createEl("input", { type: "text" });
    this.input.addClass("chs-search-input");
    this.input.setAttribute("placeholder", "搜索笔记内容，如：主角 穿越");
    this.input.addEventListener("input", () => this.scheduleSearch());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = this.list.querySelector(".chs-search-item") as HTMLElement | null;
        first?.click();
      }
    });

    this.list = contentEl.createDiv("chs-search-results");
    this.list.createDiv("chs-search-empty").setText("加载索引中…");

    window.setTimeout(() => this.input.focus(), 50);
    void this.loadIndex();
  }

  private async loadIndex(): Promise<void> {
    const book = this.book;
    const meta = new Map<string, { label: string; detail: string }>();

    for (const ch of collectChapters(book.structure)) {
      for (const d of book.dimensions) {
        if (d.isChart) continue;
        const c = book.cells[cellKey(ch.id, d.id)];
        if (c?.filePath) meta.set(c.filePath, { label: ch.name + " · " + d.name, detail: "章节笔记" });
      }
    }
    for (const n of [...collectVolumes(book.structure), ...collectUnits(book.structure)]) {
      for (const d of book.dimensions) {
        if (d.isChart) continue;
        const p = n.summaryFiles?.[d.id];
        if (p) {
          meta.set(p, {
            label: n.name + " · " + d.name + "总结",
            detail: n.type === "volume" ? "卷总结" : "单元总结",
          });
        }
      }
    }
    for (const ch of book.characters ?? []) {
      for (const d of book.characterDimensions ?? []) {
        const c = book.characterCells?.[cellKey(ch.id, d.id)];
        if (c?.filePath) meta.set(c.filePath, { label: ch.name + " · " + d.name, detail: "人设笔记" });
      }
    }

    this.items = [];
    for (const [path, m] of meta) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) continue;
      let body = "";
      try {
        body = await this.app.vault.cachedRead(f);
      } catch (e) {
        /* ignore */
      }
      this.items.push({ path, label: m.label, detail: m.detail, body });
    }
    this.runSearch(this.input.value);
  }

  private scheduleSearch(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.runSearch(this.input.value);
    }, 150);
  }

  private runSearch(query: string): void {
    this.list.empty();
    const q = query.trim().toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);

    const results = this.items.filter((it) => {
      if (tokens.length === 0) return true;
      const hay = (it.label + "\n" + it.detail + "\n" + it.body).toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });

    if (results.length === 0) {
      this.list.createDiv("chs-search-empty").setText(q ? "无匹配结果" : "暂无笔记");
      return;
    }

    for (const it of results.slice(0, 50)) {
      const item = this.list.createDiv("chs-search-item");
      item.createDiv("chs-search-item-label").setText(it.label);
      item.createDiv("chs-search-item-detail").setText(it.detail);

      if (tokens.length > 0) {
        const idx = it.body.toLowerCase().indexOf(tokens[0]);
        if (idx >= 0) {
          const start = Math.max(0, idx - 20);
          const snippet = it.body.slice(start, start + 80).replace(/\s+/g, " ");
          item.createDiv("chs-search-item-snippet").setText((start > 0 ? "…" : "") + snippet + "…");
        }
      }
      item.addEventListener("click", () => {
        this.close();
        this.openNote(it.path);
      });
    }
  }

  onClose(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.contentEl.empty();
  }
}
