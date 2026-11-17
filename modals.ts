import {
  App,
  ButtonComponent,
  Modal,
  Notice,
  normalizePath,
  Setting,
  TextAreaComponent,
  TFile,
  TFolder,
} from "obsidian";
import {
  DIMENSION_COLOR_NAMES,
  DIMENSION_COLORS,
  Dimension,
} from "./types";
import { ensureFolder, sanitizeFileName } from "./store";

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
  private chart = false;
  private isEdit = false;

  constructor(
    app: App,
    private opts: {
      title: string;
      initial?: Dimension;
      onSave: (name: string, color: string, chart: boolean) => void;
      onDelete?: () => void;
    }
  ) {
    super(app);
    if (opts.initial) {
      this.name = opts.initial.name;
      this.color = opts.initial.color;
      this.chart = opts.initial.type === "chart";
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
      .setDesc("该维度将显示「情绪折线」绘制面板（type = chart）")
      .addToggle((t) => t.setValue(this.chart).onChange((v) => (this.chart = v)));

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
    this.opts.onSave(name, this.color || DIMENSION_COLORS[0], this.chart);
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
    }
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("chs-modal");
    contentEl.createEl("h2", { text: "拆书文件夹存放位置" });
    contentEl.createEl("p", {
      text: "该路径下将自动生成 《书名》/卷/单元/章节 的层级文件夹。",
    });

    new Setting(contentEl).setName("存放路径").setDesc("留空 = 库根目录").addText((t) => {
      t.setPlaceholder("例如：拆书项目")
        .setValue(this.opts.current)
        .onChange((v) => (this.pathInput = t.inputEl))
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
