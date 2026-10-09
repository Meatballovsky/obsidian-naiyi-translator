import { App, Notice, PluginSettingTab, Setting } from "obsidian";

import type { EngineId, OrbPosition, TranslationStyle } from "./settings";
import type TranslatorOrbPlugin from "./main";
import { FULL_LOGO_SVG } from "./ui/icons";
import { t, type TranslationKey } from "./i18n";

const LANGUAGES: [string, string][] = [
  ["auto", "Auto detect (自动检测)"],
  ["zh-CN", "简体中文 (Simplified Chinese)"],
  ["zh-TW", "繁體中文 (Traditional Chinese)"],
  ["en", "English"],
  ["ja", "日本語 (Japanese)"],
  ["ko", "한국어 (Korean)"],
  ["fr", "Français (French)"],
  ["de", "Deutsch (German)"],
  ["es", "Español (Spanish)"],
  ["ru", "Русский (Russian)"],
  ["pt", "Português (Portuguese)"],
  ["it", "Italiano (Italian)"],
  ["ar", "العربية (Arabic)"],
  ["vi", "Tiếng Việt (Vietnamese)"],
];

const ENGINES: [EngineId, string][] = [
  ["google", "Google (free, no key)"],
  ["microsoft", "Microsoft Edge (free, no key)"],
  ["ai", "Custom AI endpoint (OpenAI / Ollama / OMLX)"],
];

const ORB_POSITIONS: [OrbPosition, TranslationKey][] = [
  ["right-middle", "posRightMiddle"],
  ["left-middle", "posLeftMiddle"],
  ["custom", "posCustom"],
];

export class TranslatorSettingTab extends PluginSettingTab {
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App, private plugin: TranslatorOrbPlugin) {
    super(app, plugin);
  }

  /** Text fields fire per keystroke; coalesce them into one data.json write. */
  private debouncedSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.plugin.saveSettings();
    }, 400);
  }

  hide(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.plugin.saveSettings();
    }
    super.hide();
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.plugin.settings;
    containerEl.empty();

    // Hero Banner with Flat Logo
    const heroEl = containerEl.createDiv({ cls: "obstr-settings-hero" });
    const logoEl = heroEl.createDiv({ cls: "obstr-settings-hero-logo" });
    logoEl.innerHTML = FULL_LOGO_SVG;

    const textEl = heroEl.createDiv({ cls: "obstr-settings-hero-text" });
    textEl.createEl("h3", { text: t("pluginTitle"), cls: "obstr-settings-hero-title" });
    textEl.createEl("p", { text: t("pluginSubtitle"), cls: "obstr-settings-hero-subtitle" });

    const commit = () => this.debouncedSave();

    const numberField = (
      label: string,
      desc: string,
      value: number,
      min: number,
      apply: (parsed: number) => void
    ) => {
      new Setting(containerEl)
        .setName(label)
        .setDesc(desc)
        .addText((text) =>
          text.setValue(String(value)).onChange((raw) => {
            const parsed = Number.parseInt(raw, 10);
            if (Number.isFinite(parsed) && parsed >= min) {
              apply(parsed);
              commit();
            }
          })
        );
    };

    // Engine Section
    new Setting(containerEl).setName(t("engineHeading")).setHeading();

    new Setting(containerEl)
      .setName(t("engineSelect"))
      .setDesc(t("engineDesc"))
      .addDropdown((dropdown) => {
        for (const [value, label] of ENGINES) dropdown.addOption(value, label);
        dropdown.setValue(settings.engine).onChange(async (value) => {
          settings.engine = value as EngineId;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName(t("probeEngine"))
      .setDesc(t("probeEngineDesc"))
      .addButton((button) => {
        button.setButtonText("Test").onClick(async () => {
          button.setDisabled(true);
          new Notice(await this.plugin.probeEngine(), 6000);
          button.setDisabled(false);
        });
      });

    // Style Section
    new Setting(containerEl).setName(t("styleHeading")).setHeading();

    new Setting(containerEl)
      .setName(t("translationStyle"))
      .setDesc(t("translationStyleDesc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("card", t("styleCard"));
        dropdown.addOption("quote", t("styleQuote"));
        dropdown.addOption("minimal", t("styleMinimal"));
        dropdown.setValue(settings.translationStyle).onChange(async (value) => {
          settings.translationStyle = value as TranslationStyle;
          await this.plugin.saveSettings();
        });
      });

    // Languages Section
    new Setting(containerEl).setName(t("langHeading")).setHeading();

    const languageDropdown = (
      label: string,
      current: string,
      apply: (value: string) => void
    ) => {
      new Setting(containerEl)
        .setName(label)
        .addDropdown((dropdown) => {
          for (const [value, name] of LANGUAGES) dropdown.addOption(value, name);
          dropdown.setValue(current).onChange(async (value) => {
            apply(value);
            commit();
          });
        });
    };
    languageDropdown(t("targetLang"), settings.targetLang, (value) => {
      settings.targetLang = value;
    });
    languageDropdown(t("sourceLang"), settings.sourceLang, (value) => {
      settings.sourceLang = value;
    });

    // Markdown Section
    new Setting(containerEl).setName(t("mdHeading")).setHeading();

    new Setting(containerEl)
      .setName(t("renderMd"))
      .setDesc(t("renderMdDesc"))
      .addToggle((toggle) =>
        toggle.setValue(settings.renderMarkdown).onChange(async (value) => {
          settings.renderMarkdown = value;
          commit();
        })
      );

    // Custom AI Endpoint Section
    new Setting(containerEl).setName(t("aiHeading")).setHeading();

    new Setting(containerEl)
      .setName(t("aiBaseUrl"))
      .setDesc(t("aiBaseUrlDesc"))
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:11434/v1")
          .setValue(settings.ai.baseUrl)
          .onChange(async (value) => {
            settings.ai.baseUrl = value.trim();
            commit();
          })
      );

    new Setting(containerEl)
      .setName(t("aiModel"))
      .addText((text) =>
        text
          .setPlaceholder("qwen2.5:7b")
          .setValue(settings.ai.model)
          .onChange(async (value) => {
            settings.ai.model = value.trim();
            commit();
          })
      );

    new Setting(containerEl)
      .setName(t("aiFetchModels"))
      .setDesc(t("aiFetchModelsDesc"))
      .addButton((button) => {
        button.setButtonText("Fetch").onClick(async () => {
          button.setDisabled(true);
          new Notice(await this.plugin.fetchModels(), 4000);
          button.setDisabled(false);
          this.display();
        });
      });

    if (this.plugin.availableModels.length > 0) {
      new Setting(containerEl)
        .setName(t("aiPickModel"))
        .addDropdown((dropdown) => {
          dropdown.addOption("", "Choose…");
          for (const id of this.plugin.availableModels) dropdown.addOption(id, id);
          dropdown.setValue(settings.ai.model).onChange(async (value) => {
            if (!value) return;
            settings.ai.model = value;
            await this.plugin.saveSettings();
            this.display();
          });
        });
    }

    new Setting(containerEl)
      .setName(t("aiApiKey"))
      .setDesc(t("aiApiKeyDesc"))
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(settings.ai.apiKey).onChange(async (value) => {
          settings.ai.apiKey = value.trim();
          commit();
        });
      });

    new Setting(containerEl)
      .setName(t("aiTemperature"))
      .addSlider((slider) => {
        slider.setLimits(0, 1, 0.05).setValue(settings.ai.temperature).setDynamicTooltip();
        slider.setInstant(false);
        slider.onChange((value) => {
          settings.ai.temperature = value;
          commit();
        });
      });

    new Setting(containerEl)
      .setName(t("aiDisableThinking"))
      .setDesc(t("aiDisableThinkingDesc"))
      .addToggle((toggle) =>
        toggle.setValue(settings.ai.disableThinking).onChange(async (value) => {
          settings.ai.disableThinking = value;
          commit();
        })
      );

    numberField(
      t("aiTimeout"),
      t("aiTimeoutDesc"),
      settings.ai.timeoutMs,
      1000,
      (value) => {
        settings.ai.timeoutMs = value;
      }
    );

    new Setting(containerEl)
      .setName(t("systemPrompt"))
      .setDesc(t("systemPromptDesc"))
      .addTextArea((area) =>
        area.setValue(settings.ai.systemPrompt).onChange(async (value) => {
          settings.ai.systemPrompt = value;
          commit();
        })
      );

    new Setting(containerEl)
      .setName(t("userPrompt"))
      .setDesc(t("userPromptDesc"))
      .addTextArea((area) =>
        area.setValue(settings.ai.userPrompt).onChange(async (value) => {
          settings.ai.userPrompt = value;
          commit();
        })
      );

    // Requests Section
    new Setting(containerEl).setName(t("requestsHeading")).setHeading();

    numberField(
      t("preloadBand"),
      t("preloadBandDesc"),
      settings.preloadMarginPx,
      0,
      (value) => {
        settings.preloadMarginPx = value;
      }
    );
    numberField(
      t("requestCapacity"),
      t("requestCapacityDesc"),
      settings.requestCapacity,
      1,
      (value) => {
        settings.requestCapacity = value;
      }
    );
    numberField(
      t("requestRate"),
      t("requestRateDesc"),
      settings.requestRate,
      1,
      (value) => {
        settings.requestRate = value;
      }
    );
    numberField(
      t("batchItems"),
      t("batchItemsDesc"),
      settings.maxItemsPerBatch,
      1,
      (value) => {
        settings.maxItemsPerBatch = value;
      }
    );
    numberField(
      t("batchChars"),
      "",
      settings.maxCharsPerBatch,
      1,
      (value) => {
        settings.maxCharsPerBatch = value;
      }
    );
    numberField(
      t("requestTimeout"),
      "",
      settings.requestTimeoutMs,
      1000,
      (value) => {
        settings.requestTimeoutMs = value;
      }
    );
    numberField(t("maxRetries"), "", settings.maxRetries, 0, (value) => {
      settings.maxRetries = value;
    });

    // Filter Section
    new Setting(containerEl).setName(t("filterHeading")).setHeading();
    numberField(
      t("minChars"),
      "",
      settings.minCharactersPerNode,
      0,
      (value) => {
        settings.minCharactersPerNode = value;
      }
    );
    numberField(t("minWords"), "", settings.minWordsPerNode, 0, (value) => {
      settings.minWordsPerNode = value;
    });

    // Floating Orb Section
    new Setting(containerEl).setName(t("orbHeading")).setHeading();

    new Setting(containerEl)
      .setName(t("showOrb"))
      .setDesc(t("showOrbDesc"))
      .addToggle((toggle) =>
        toggle.setValue(settings.showOrb).onChange(async (value) => {
          settings.showOrb = value;
          commit();
        })
      );

    new Setting(containerEl)
      .setName(t("orbOpacity"))
      .addSlider((slider) => {
        slider.setLimits(0.05, 1, 0.05).setValue(settings.orbOpacity).setDynamicTooltip();
        slider.setInstant(false);
        slider.onChange((value) => {
          settings.orbOpacity = value;
          commit();
        });
      });

    new Setting(containerEl)
      .setName(t("orbPosition"))
      .addDropdown((dropdown) => {
        for (const [pos, key] of ORB_POSITIONS) {
          dropdown.addOption(pos, t(key));
        }
        dropdown.setValue(settings.orbPosition).onChange(async (value) => {
          settings.orbPosition = value as OrbPosition;
          if (value !== "custom") {
            settings.orbCustomX = null;
            settings.orbCustomY = null;
          }
          commit();
        });
      });

    new Setting(containerEl)
      .setName(t("autoTranslateSelect"))
      .setDesc(t("autoTranslateSelectDesc"))
      .addToggle((toggle) =>
        toggle.setValue(settings.autoTranslateOnSelect).onChange(async (value) => {
          settings.autoTranslateOnSelect = value;
          commit();
        })
      );

    // Cache Section
    new Setting(containerEl).setName(t("cacheHeading")).setHeading();

    new Setting(containerEl)
      .setName(t("enableCache"))
      .setDesc(t("enableCacheDesc"))
      .addToggle((toggle) =>
        toggle.setValue(settings.enableCache).onChange(async (value) => {
          settings.enableCache = value;
          commit();
        })
      );

    numberField(t("cacheTtl"), "", settings.cacheTtlDays, 0, (value) => {
      settings.cacheTtlDays = value;
    });
    numberField(t("cacheMax"), "", settings.cacheMaxEntries, 1, (value) => {
      settings.cacheMaxEntries = value;
    });

    new Setting(containerEl)
      .setName(t("clearCache"))
      .setDesc(t("clearCacheDesc"))
      .addButton((button) => {
        button.setButtonText("Clear").onClick(() => {
          this.plugin.clearCache();
          new Notice(t("cacheCleared"), 2500);
        });
      });
  }
}
