import { App, Notice, PluginSettingTab, Setting } from "obsidian";

import type { EngineId, OrbPosition, TranslatorSettings } from "./settings";
import type TranslatorOrbPlugin from "./main";

const LANGUAGES: [string, string][] = [
  ["auto", "Auto detect"],
  ["en", "English"],
  ["zh-CN", "Chinese (Simplified)"],
  ["zh-TW", "Chinese (Traditional)"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["fr", "French"],
  ["de", "German"],
  ["es", "Spanish"],
  ["ru", "Russian"],
  ["pt", "Portuguese"],
  ["it", "Italian"],
  ["ar", "Arabic"],
  ["vi", "Vietnamese"],
];

const ENGINES: [EngineId, string][] = [
  ["google", "Google (free, no key)"],
  ["microsoft", "Microsoft Edge (free, no key)"],
  ["ai", "Custom AI endpoint"],
];

const ORB_POSITIONS: OrbPosition[] = ["right-middle", "left-middle", "custom"];

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

    new Setting(containerEl).setName("Engine").setHeading();

    new Setting(containerEl)
      .setName("Translation engine")
      .addDropdown((dropdown) => {
        for (const [value, label] of ENGINES) dropdown.addOption(value, label);
        dropdown.setValue(settings.engine).onChange(async (value) => {
          settings.engine = value as EngineId;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Probe engine")
      .setDesc("Sends one short sentence to the active engine and shows the result.")
      .addButton((button) => {
        button.setButtonText("Test").onClick(async () => {
          button.setDisabled(true);
          new Notice(await this.plugin.probeEngine(), 6000);
          button.setDisabled(false);
        });
      });

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
    languageDropdown("Target language", settings.targetLang, (value) => {
      settings.targetLang = value;
    });
    languageDropdown("Source language", settings.sourceLang, (value) => {
      settings.sourceLang = value;
    });

    new Setting(containerEl)
      .setName("Render translation as Markdown")
      .setDesc("Needed when the AI engine returns lists, bold text or links.")
      .addToggle((toggle) =>
        toggle.setValue(settings.renderMarkdown).onChange(async (value) => {
          settings.renderMarkdown = value;
          commit();
        })
      );

    new Setting(containerEl).setName("Custom AI endpoint").setHeading();

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc(
        "Any OpenAI-compatible server. Local endpoints work on 127.0.0.1: Obsidian sends requests through its own network layer, so there is no CORS or private-network preflight to work around."
      )
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:8000/v1")
          .setValue(settings.ai.baseUrl)
          .onChange(async (value) => {
            settings.ai.baseUrl = value.trim();
            commit();
          })
      );

    new Setting(containerEl)
      .setName("Model")
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
      .setName("Fetch model list")
      .setDesc("Reads /v1/models from the endpoint above.")
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
        .setName("Pick model")
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
      .setName("API key")
      .setDesc("Only needed for hosted endpoints. Stored in this vault's plugin data.json.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(settings.ai.apiKey).onChange(async (value) => {
          settings.ai.apiKey = value.trim();
          commit();
        });
      });

    new Setting(containerEl)
      .setName("Temperature")
      .addSlider((slider) => {
        slider.setLimits(0, 1, 0.05).setValue(settings.ai.temperature).setDynamicTooltip();
        // Non-instant so the request budget is not rewritten on every drag frame.
        slider.setInstant(false);
        slider.onChange((value) => {
          settings.ai.temperature = value;
          commit();
        });
      });

    new Setting(containerEl)
      .setName("Disable model thinking")
      .setDesc(
        "Sends reasoning_effort=none. Chain of thought doubles latency on a local model and does not improve translation."
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.ai.disableThinking).onChange(async (value) => {
          settings.ai.disableThinking = value;
          commit();
        })
      );

    numberField(
      "AI request timeout (ms)",
      "Local models pay loading cost on the first request, so this is separate from the free-API timeout.",
      settings.ai.timeoutMs,
      1000,
      (value) => {
        settings.ai.timeoutMs = value;
      }
    );

    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("Placeholders: {{targetLang}} {{sourceLang}}")
      .addTextArea((area) =>
        area.setValue(settings.ai.systemPrompt).onChange(async (value) => {
          settings.ai.systemPrompt = value;
          commit();
        })
      );

    new Setting(containerEl)
      .setName("User prompt")
      .setDesc("Placeholders: {{input}} {{targetLang}}")
      .addTextArea((area) =>
        area.setValue(settings.ai.userPrompt).onChange(async (value) => {
          settings.ai.userPrompt = value;
          commit();
        })
      );

    new Setting(containerEl).setName("Requests").setHeading();

    numberField(
      "Preload band (px)",
      "How far ahead of the viewport paragraphs get translated.",
      settings.preloadMarginPx,
      0,
      (value) => {
        settings.preloadMarginPx = value;
      }
    );
    numberField(
      "Max concurrent requests",
      "Token bucket capacity. Free endpoints rate-limit aggressively, so keep this small.",
      settings.requestCapacity,
      1,
      (value) => {
        settings.requestCapacity = value;
      }
    );
    numberField(
      "Requests per second",
      "Token refill rate. Google's free endpoint starts returning 429 well before a local model does.",
      settings.requestRate,
      1,
      (value) => {
        settings.requestRate = value;
      }
    );
    numberField(
      "Batch size (paragraphs)",
      "Ignored for Google, whose reply cannot be mapped back 1:1.",
      settings.maxItemsPerBatch,
      1,
      (value) => {
        settings.maxItemsPerBatch = value;
      }
    );
    numberField(
      "Batch size (characters)",
      "Ceiling on one request's payload.",
      settings.maxCharsPerBatch,
      1,
      (value) => {
        settings.maxCharsPerBatch = value;
      }
    );
    numberField(
      "Free-API request timeout (ms)",
      "Does not apply to the AI endpoint, which uses its own budget.",
      settings.requestTimeoutMs,
      1000,
      (value) => {
        settings.requestTimeoutMs = value;
      }
    );
    numberField("Retries", "", settings.maxRetries, 0, (value) => {
      settings.maxRetries = value;
    });
    numberField(
      "Skip paragraphs under (characters)",
      "0 translates everything including single words.",
      settings.minCharactersPerNode,
      0,
      (value) => {
        settings.minCharactersPerNode = value;
      }
    );
    numberField("Skip paragraphs under (words)", "", settings.minWordsPerNode, 0, (value) => {
      settings.minWordsPerNode = value;
    });

    new Setting(containerEl).setName("Floating orb").setHeading();

    new Setting(containerEl)
      .setName("Show orb")
      .addToggle((toggle) =>
        toggle.setValue(settings.showOrb).onChange(async (value) => {
          settings.showOrb = value;
          commit();
        })
      );

    new Setting(containerEl)
      .setName("Resting opacity")
      .addSlider((slider) => {
        slider.setLimits(0.05, 1, 0.05).setValue(settings.orbOpacity).setDynamicTooltip();
        slider.setInstant(false);
        slider.onChange((value) => {
          settings.orbOpacity = value;
          commit();
        });
      });

    new Setting(containerEl)
      .setName("Dock side")
      .setDesc("Dragging the orb overrides this; it snaps to the nearer edge.")
      .addDropdown((dropdown) => {
        for (const value of ORB_POSITIONS) dropdown.addOption(value, value);
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
      .setName("Translate on selection")
      .setDesc("Translates the paragraphs a selection touches when you release the mouse.")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoTranslateOnSelect).onChange(async (value) => {
          settings.autoTranslateOnSelect = value;
          commit();
        })
      );

    new Setting(containerEl).setName("Cache").setHeading();

    new Setting(containerEl)
      .setName("Reuse cached translations")
      .addToggle((toggle) =>
        toggle.setValue(settings.enableCache).onChange(async (value) => {
          settings.enableCache = value;
          commit();
        })
      );

    numberField("Cache TTL (days)", "0 keeps entries forever.", settings.cacheTtlDays, 0, (value) => {
      settings.cacheTtlDays = value;
    });
    numberField("Max cached entries", "", settings.cacheMaxEntries, 1, (value) => {
      settings.cacheMaxEntries = value;
    });

    new Setting(containerEl)
      .setName("Clear cache")
      .setDesc("Paragraphs already translated in this vault forget their results.")
      .addButton((button) => {
        button.setButtonText("Clear").onClick(() => {
          this.plugin.clearCache();
          new Notice("Translation cache cleared.", 2500);
        });
      });
  }
}
