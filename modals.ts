import {
  App,
  ButtonComponent,
  Modal,
  Notice,
  Setting,
  TextAreaComponent,
} from "obsidian";
import {
  DIMENSION_COLOR_NAMES,
  DIMENSION_COLORS,
  Dimension,
} from "./types";

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
  private isEdit = false;

  constructor(
    app: App,
    private opts: {
      title: string;
      initial?: Dimension;
      onSave: (name: string, color: string) => void;
      onDelete?: () => void;
    }
  ) {
    super(app);
    if (opts.initial) {
      this.name = opts.initial.name;
      this.color = opts.initial.color;
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
        .setPlaceholder("例如：长期期待")
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
    this.opts.onSave(name, this.color || DIMENSION_COLORS[0]);
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
      "在此输入分析内容…\n支持多行文本，保存后自动归档为笔记"
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

    // Focus after the modal is mounted so the soft keyboard opens on mobile.
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
