import { App, normalizePath, PluginSettingTab, Setting } from "obsidian";
import type ChaiShuMatrixPlugin from "./main";
import { ConfirmModal } from "./modals";
import { normalizeYAxisLabels, sanitizeFileName } from "./store";
import type { BookData, Dimension } from "./types";

export class ChaiShuSettingTab extends PluginSettingTab {
  plugin: ChaiShuMatrixPlugin;

  constructor(app: App, plugin: ChaiShuMatrixPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "ChaiShu Matrix Pro 设置" });

    new Setting(containerEl)
      .setName("默认章节数")
      .setDesc("新建拆书时自动生成的章节数量（1–500）")
      .addText((t) => {
        t.setValue(String(this.plugin.settings.defaultChapterCount)).onChange((v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.defaultChapterCount =
            Number.isFinite(n) && n > 0 ? Math.min(500, n) : 5;
          void this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("默认分析维度")
      .setDesc("新建拆书时自动创建的维度，用逗号分隔（名为「情绪」的维度自动开启折线画板）")
      .addText((t) => {
        t.setValue(this.plugin.settings.defaultDimensionNames).onChange((v) => {
          this.plugin.settings.defaultDimensionNames = v;
          void this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("默认拆书存放位置")
      .setDesc("新建拆书时的默认归档文件夹（留空 = 库根目录）")
      .addText((t) => {
        t.setValue(this.plugin.settings.defaultStoragePath).onChange((v) => {
          this.plugin.settings.defaultStoragePath = normalizePath(v);
          void this.plugin.saveSettings();
        });
      });

    this.renderDimensionManagement(containerEl);

    containerEl.createEl("h3", { text: "危险操作" });

    new Setting(containerEl)
      .setName("重置所有数据")
      .setDesc("清空所有拆书项目的矩阵配置（不会删除仓库中的笔记文件）")
      .addButton((b) => {
        b.setButtonText("重置").setWarning().onClick(() => {
          new ConfirmModal(this.app, {
            title: "重置所有数据",
            message: "将清空所有拆书项目的矩阵配置。仓库中的笔记文件不会被删除。",
            confirmText: "确认重置",
            danger: true,
            onConfirm: async () => {
              this.plugin.settings.books = [];
              this.plugin.settings.activeBookId = "";
              await this.plugin.saveSettings();
              this.plugin.notifyViews();
              this.display();
            },
          }).open();
        });
      });
  }

  private renderDimensionManagement(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "维度管理" });
    const books = this.plugin.settings.books;
    if (books.length === 0) {
      containerEl.createEl("p", { text: "暂无拆书项目" }).addClass("chs-setting-note");
      return;
    }

    let bookId = books[0].id;
    new Setting(containerEl).setName("选择拆书").addDropdown((d) => {
      for (const b of books) d.addOption(b.id, b.bookInfo.title || b.id);
      d.setValue(bookId);
      d.onChange((v) => {
        bookId = v;
        this.display();
      });
    });

    const book = books.find((b) => b.id === bookId) ?? books[0];
    if (book.dimensions.length === 0) {
      containerEl.createEl("p", { text: "该项目暂无维度" }).addClass("chs-setting-note");
      return;
    }

    for (const dim of book.dimensions) {
      this.renderDimensionRow(containerEl, book, dim);
    }
  }

  private renderDimensionRow(containerEl: HTMLElement, book: BookData, dim: Dimension): void {
    new Setting(containerEl)
      .setName("维度标签")
      .setDesc("修改后，表头与已有笔记的「维度」属性自动同步")
      .addText((t) => {
        t.setValue(dim.name);
        t.inputEl.addEventListener("blur", () => {
          const name = sanitizeFileName(t.getValue());
          if (name && name !== dim.name) {
            void this.plugin.renameDimension(book.id, dim.id, name);
          }
        });
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") t.inputEl.blur();
        });
      })
      .addColorPicker((cp) => {
        cp.setValue(dim.color).onChange((c) => {
          dim.color = c;
          void this.plugin.saveSettings();
          this.plugin.notifyViews();
        });
      });

    new Setting(containerEl)
      .setName(dim.name + " · 情绪折线")
      .setDesc("开启后该维度拥有专属折线绘制")
      .addToggle((t) => {
        t.setValue(dim.isChart).onChange((v) => {
          dim.isChart = v;
          void this.plugin.saveSettings();
          this.plugin.notifyViews();
          this.display();
        });
      });

    if (dim.isChart) {
      new Setting(containerEl)
        .setName("Y轴 5 层级名称")
        .setDesc("从低到高 5 层，逗号分隔（第 3 层为基准线）")
        .addText((t) => {
          t.setValue(dim.yAxisLabels.join(","));
          t.inputEl.addEventListener("blur", () => {
            dim.yAxisLabels = normalizeYAxisLabels(t.getValue().split(/[,，、\s]+/).filter(Boolean));
            void this.plugin.saveSettings();
            this.plugin.notifyViews();
          });
          t.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") t.inputEl.blur();
          });
        });
    }
  }
}
