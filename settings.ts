import { App, normalizePath, PluginSettingTab, Setting } from "obsidian";
import type ChaiShuMatrixPlugin from "./main";
import { ConfirmModal } from "./modals";

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
        t.setValue(this.plugin.settings.defaultStoragePath)
          .onChange((v) => {
            this.plugin.settings.defaultStoragePath = normalizePath(v);
            void this.plugin.saveSettings();
          });
      });

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
}
