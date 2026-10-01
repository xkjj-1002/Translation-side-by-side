(() => {
  // src/shared/messages.js
  var MSG = {
    /**
     * content script → background：请求翻译**一批**文本。
     * 批量是 M2 的性能杠杆：整页 50 段从 50 次请求降到 5 次左右。
     * 约定：texts 与返回的 items 下标严格一一对应。
     */
    TRANSLATE: "itx:translate",
    /** content script → background：取「脱敏后的」配置与引擎元信息 */
    CONFIG: "itx:config",
    /** popup / options → background：查询当前配置与可用性 */
    STATUS: "itx:status",
    /** content script → background：增删本站的站点规则 */
    SITE_RULE: "itx:site-rule",
    /** options → background：翻译引擎已变更，请广播给所有标签页 */
    ENGINE_CHANGED: "itx:engine-changed",
    /** background → content script：快捷键与引擎变更命令 */
    COMMAND: "itx:command",
    /** content script → background：汇报进度，供 popup 展示 */
    PROGRESS: "itx:progress",
    /** content script → background：上报在网页里探测到的内置 AI 可用性 */
    PROBE_BUILTIN: "itx:probe-builtin",
    /**
     * content script → background：记住/清除「内置 AI 在这台机器上不可用」。
     *
     * 为什么必须持久化：判定一次要等十几秒到二十几秒。如果只记在单个页面里，
     * 用户每开一个新标签页都要再白等一遍 —— 那正是「插件坏了」的观感来源。
     */
    BUILTIN_STATE: "itx:builtin-state"
  };
  var CMD = {
    TRANSLATE: "translate",
    TOGGLE: "toggle",
    STOP: "stop",
    /** 引擎已切换：页面上若有旧引擎的译文，提示用户重译 */
    ENGINE_CHANGED: "engine-changed",
    /** 把当前选中的区域排除出翻译范围 */
    EXCLUDE_REGION: "exclude-region",
    /** 只翻译当前选中的区域 */
    INCLUDE_REGION: "include-region",
    /** 清除本站的全部规则 */
    CLEAR_SITE_RULE: "clear-site-rule",
    /** 切换本站的「自动翻译新增内容」 */
    TOGGLE_SITE_INCREMENTAL: "toggle-site-incremental",
    /**
     * 请网页里的内容脚本探测内置 AI 到底能不能用。
     *
     * 必须由网页来答：内置 AI 只在页面上下文可用，设置页（扩展页面）里探测
     * 很可能拿不到 Translator，从而给出「浏览器不支持」这种错误结论。
     * availability() 是非破坏性的，不会触发语言包下载。
     */
    PROBE_BUILTIN: "probe-builtin"
  };

  // src/shared/hash.js
  async function hashText(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  }
  function quickHash(input) {
    const text = String(input ?? "");
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  // src/shared/platform.js
  function isMac() {
    if (typeof navigator === "undefined") return false;
    if (navigator.userAgentData?.platform) {
      return navigator.userAgentData.platform === "macOS";
    }
    return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
  }
  function formatShortcut(spec) {
    if (isMac()) {
      return spec.replace(/Alt|Option/gi, "Option").replace(/\bCtrl\b|Control/gi, "Control").replace(/\bCmd\b|Meta/gi, "Command");
    }
    return spec.replace(/Option/gi, "Alt").replace(/Command/gi, "Ctrl");
  }

  // src/shared/batch.js
  function planBatches(items, limits = {}) {
    const maxSegments = Math.max(1, limits.maxSegments ?? 1);
    const maxChars = limits.maxChars ?? Number.POSITIVE_INFINITY;
    const batches = [];
    let current = [];
    let size = 0;
    const flush = () => {
      if (current.length) batches.push(current);
      current = [];
      size = 0;
    };
    for (const item of items) {
      const length = Array.from(String(item?.text ?? "")).length;
      if (maxSegments <= 1 || length > maxChars) {
        flush();
        batches.push([item]);
        continue;
      }
      const projected = size + length + (current.length > 0 ? 1 : 0);
      if (current.length && (current.length >= maxSegments || projected > maxChars)) flush();
      current.push(item);
      size += length + (current.length > 1 ? 1 : 0);
    }
    flush();
    return batches;
  }

  // src/shared/providers/mock.js
  var mockProvider = {
    id: "mock",
    label: "\u672C\u5730\u6F14\u793A\uFF08\u65E0\u9700\u5BC6\u94A5\uFF09",
    host: "network",
    demo: true,
    note: "\u8BD1\u6587\u4F1A\u5E26\u4E0A\u3010\u6A21\u62DF\u8BD1\u6587\u3011\u524D\u7F00\uFF0C\u4EC5\u7528\u4E8E\u9A8C\u8BC1\u754C\u9762\u6548\u679C\uFF0C\u8BF7\u4E0D\u8981\u5F53\u6210\u771F\u5B9E\u7FFB\u8BD1\u7ED3\u679C\u3002",
    fields: [],
    isReady: () => true,
    batch: { maxSegments: 16, maxChars: 3e3 },
    cacheScope: () => "",
    async translateBatch(texts) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return texts.map((text) => `\u3010\u6A21\u62DF\u8BD1\u6587\u3011${text}`);
    }
  };

  // src/shared/providers/errors.js
  var TranslationError = class extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = "TranslationError";
      this.code = options.code;
      this.retryable = Boolean(options.retryable);
      this.fatal = Boolean(options.fatal);
      this.needConfig = Boolean(options.needConfig);
      this.segmentSpecific = Boolean(options.segmentSpecific);
    }
  };

  // src/shared/providers/config.js
  function fieldsDefaults(fields = []) {
    const out = {};
    for (const field of fields) {
      if (field.type === "checkbox") out[field.key] = Boolean(field.default);
      else if (field.type === "number") out[field.key] = Number(field.default ?? 0);
      else if (field.type === "select") {
        out[field.key] = field.default ?? field.options?.[0]?.value ?? "";
      } else out[field.key] = field.default ?? "";
    }
    return out;
  }
  function providerConfig(settings, id) {
    return settings?.providers?.[id] ?? {};
  }

  // src/shared/providers/youdao.js
  var ENDPOINT = "https://openapi.youdao.com/api";
  var MAX_QUERY_LENGTH = 5e3;
  function truncate(q) {
    const len = Array.from(q).length;
    if (len <= 20) return q;
    const chars = Array.from(q);
    return chars.slice(0, 10).join("") + len + chars.slice(-10).join("");
  }
  async function sha256Hex(input) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function buildSign({ appKey, appSecret, q, salt, curtime }) {
    return sha256Hex(appKey + truncate(q) + salt + curtime + appSecret);
  }
  var RETRYABLE = /* @__PURE__ */ new Set(["411", "412"]);
  var FATAL_CODES = /* @__PURE__ */ new Set(["108", "110", "202", "206", "401", "403"]);
  var FATAL = {
    108: "\u5E94\u7528ID\uFF08appKey\uFF09\u65E0\u6548\u3002\u8BF7\u5230\u8BBE\u7F6E\u9875\u6838\u5BF9\uFF0C\u6CE8\u610F\u4E0D\u8981\u590D\u5236\u5230\u591A\u4F59\u7A7A\u683C",
    110: "\u8FD9\u4E2A\u5E94\u7528\u6CA1\u6709\u7ED1\u5B9A\u300C\u6587\u672C\u7FFB\u8BD1\u300D\u670D\u52A1\u3002\u8BF7\u5230\u6709\u9053\u667A\u4E91\u63A7\u5236\u53F0\u68C0\u67E5\u5E94\u7528\u7684\u670D\u52A1\u5E73\u53F0\u7C7B\u578B",
    202: "\u7B7E\u540D\u6821\u9A8C\u5931\u8D25\u3002\u901A\u5E38\u662F\u5E94\u7528\u5BC6\u94A5\uFF08appSecret\uFF09\u590D\u5236\u6709\u8BEF\u6216\u5E26\u4E86\u7A7A\u683C\uFF0C\u8BF7\u91CD\u65B0\u590D\u5236\u4E00\u6B21",
    206: "\u65F6\u95F4\u6233\u65E0\u6548\u3002\u8BF7\u68C0\u67E5\u7535\u8111\u7684\u7CFB\u7EDF\u65F6\u95F4\u662F\u5426\u51C6\u786E",
    207: "\u8BF7\u6C42\u88AB\u5224\u5B9A\u4E3A\u91CD\u590D\uFF08\u9632\u91CD\u653E\u673A\u5236\uFF09\u3002\u8BF7\u7A0D\u7B49\u51E0\u79D2\u518D\u8BD5",
    310: "\u672A\u5F00\u901A\u9886\u57DF\u7FFB\u8BD1\u670D\u52A1\u3002\u8BF7\u5230\u8BBE\u7F6E\u9875\u628A\u300C\u9886\u57DF\u4F18\u5316\u300D\u6539\u4E3A\u300C\u901A\u7528\u300D\uFF0C\u6216\u53BB\u6709\u9053\u63A7\u5236\u53F0\u5F00\u901A\u8BE5\u9886\u57DF",
    401: "\u6709\u9053\u8D26\u6237\u5DF2\u6B20\u8D39\uFF0C\u8BF7\u5148\u5145\u503C\u540E\u518D\u8BD5",
    403: "\u4F59\u989D\u4E0D\u8DB3\u6216\u6743\u9650\u53D7\u9650\uFF0C\u8BF7\u5230\u6709\u9053\u63A7\u5236\u53F0\u67E5\u770B\u8D26\u6237\u72B6\u6001",
    411: "\u8BBF\u95EE\u9891\u7387\u53D7\u9650\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5",
    412: "\u957F\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5",
    113: "\u5F85\u7FFB\u8BD1\u5185\u5BB9\u4E3A\u7A7A",
    103: "\u6587\u672C\u8FC7\u957F\uFF08\u6709\u9053\u5355\u6B21\u4E0A\u9650 5000 \u5B57\u7B26\uFF09"
  };
  async function requestQ(q, { appKey, appSecret, from, to, domain }) {
    const salt = crypto.randomUUID();
    const curtime = Math.floor(Date.now() / 1e3);
    const sign = await buildSign({ appKey, appSecret, q, salt, curtime });
    const body = new URLSearchParams({
      q,
      from,
      to,
      appKey,
      salt,
      sign,
      signType: "v3",
      curtime: String(curtime)
    });
    if (domain && domain !== "general") body.set("domain", domain);
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!response.ok) {
      throw new TranslationError(`\u7F51\u7EDC\u9519\u8BEF HTTP ${response.status}`, { retryable: true });
    }
    const data = await response.json();
    const code = String(data.errorCode ?? "");
    if (code === "0") {
      const parts = Array.isArray(data.translation) ? data.translation : [data.translation];
      const cleaned = parts.map((p) => String(p ?? "").replace(/\r/g, ""));
      if (!cleaned.length || cleaned.every((p) => !p.trim())) {
        throw new TranslationError("\u6709\u9053\u672A\u8FD4\u56DE\u8BD1\u6587\uFF08\u539F\u56E0\u672A\u63D0\u4F9B\uFF0C\u53EF\u5C1D\u8BD5\u5207\u6362\u5F15\u64CE\uFF09", {
          code: "empty-translation",
          segmentSpecific: true
        });
      }
      return cleaned;
    }
    if (FATAL[code]) {
      throw new TranslationError(FATAL[code], { code, fatal: FATAL_CODES.has(code) });
    }
    throw new TranslationError(`\u6709\u9053\u8FD4\u56DE\u9519\u8BEF\u7801 ${code}`, {
      code,
      retryable: RETRYABLE.has(code)
    });
  }
  async function requestBatch(texts, options) {
    const oversized = texts.find((t) => Array.from(t).length > MAX_QUERY_LENGTH);
    if (oversized) {
      throw new TranslationError("\u6BB5\u843D\u8D85\u8FC7 5000 \u5B57\u7B26\uFF0C\u6682\u4E0D\u652F\u6301\u81EA\u52A8\u5207\u5206", {
        segmentSpecific: true
      });
    }
    if (texts.length === 1) {
      const parts2 = await requestQ(texts[0], options);
      return [parts2.join("\n")];
    }
    const parts = await requestQ(texts.join("\n"), options);
    const segments = parts.length === 1 && texts.length > 1 ? parts[0].split("\n") : parts;
    if (segments.length !== texts.length) {
      throw new TranslationError(
        `\u6279\u91CF\u8BD1\u6587\u6BB5\u6570\u4E0E\u539F\u6587\u4E0D\u4E00\u81F4\uFF08\u539F\u6587 ${texts.length} \u6BB5\uFF0C\u8FD4\u56DE ${segments.length} \u6BB5\uFF09\uFF0C\u5DF2\u9000\u56DE\u9010\u6BB5\u7FFB\u8BD1`,
        { segmentSpecific: true }
      );
    }
    return segments.map((s) => s.trim());
  }
  var youdaoProvider = {
    id: "youdao",
    label: "\u6709\u9053\u667A\u4E91",
    host: "network",
    /** 老版本把凭据存在 settings.youdao，storage 的迁移逻辑据此自动搬运 */
    legacyKey: "youdao",
    /** 老版本还有个顶层 settings.youdaoDomain，搬进本 provider 的 domain 字段 */
    legacyGlobal: { youdaoDomain: "domain" },
    fields: [
      {
        key: "appKey",
        label: "\u5E94\u7528ID\uFF08appKey\uFF09",
        placeholder: "\u4F8B\u5982 4f2a************",
        secret: false
      },
      {
        key: "appSecret",
        label: "\u5E94\u7528\u5BC6\u94A5\uFF08appSecret\uFF09",
        placeholder: "\u5E94\u7528\u7BA1\u7406\u9875\u53EF\u67E5\u770B",
        secret: true
      },
      {
        key: "domain",
        label: "\u9886\u57DF\u4F18\u5316",
        type: "select",
        default: "computers",
        options: [
          { value: "general", label: "\u901A\u7528" },
          { value: "computers", label: "\u8BA1\u7B97\u673A\uFF08\u6280\u672F\u6587\u6863\u63A8\u8350\uFF09" },
          { value: "finance", label: "\u91D1\u878D\u7ECF\u6D4E" },
          { value: "medicine", label: "\u533B\u5B66" },
          { value: "game", label: "\u6E38\u620F" }
        ],
        note: "\u9886\u57DF\u7FFB\u8BD1\u9700\u8981\u5148\u5728\u63A7\u5236\u53F0\u5F00\u901A\uFF1B\u672A\u5F00\u901A\u65F6\u63D2\u4EF6\u4F1A\u81EA\u52A8\u9000\u56DE\u901A\u7528\u7FFB\u8BD1\u5E76\u7EE7\u7EED\uFF0C\u4E0D\u4F1A\u8BA9\u7FFB\u8BD1\u5931\u8D25\u3002"
      }
    ],
    isReady: (config) => Boolean(config.appKey && config.appSecret),
    /** 有道官方上限 5000 字符，这里留出换行与余量 */
    batch: { maxSegments: 16, maxChars: 4e3 },
    /** 领域变了，译文也该变 —— 缓存必须跟着隔离 */
    cacheScope: (config) => config.domain || "general",
    async translateBatch(texts, settings) {
      const config = { ...fieldsDefaults(youdaoProvider.fields), ...providerConfig(settings, "youdao") };
      if (!config.appKey || !config.appSecret) {
        throw new TranslationError("\u7F3A\u5C11\u6709\u9053\u5E94\u7528ID\u6216\u5E94\u7528\u5BC6\u94A5\uFF0C\u8BF7\u5230\u8BBE\u7F6E\u9875\u586B\u5199", {
          needConfig: true,
          fatal: true
        });
      }
      const options = {
        appKey: config.appKey,
        appSecret: config.appSecret,
        from: settings.from || "auto",
        to: settings.to || "zh-CHS",
        domain: config.domain
      };
      try {
        return await requestBatch(texts, options);
      } catch (err) {
        const requestedDomain = options.domain && options.domain !== "general";
        if (requestedDomain && err instanceof TranslationError && err.code === "310") {
          console.warn("[itx] \u8BE5\u8D26\u53F7\u672A\u5F00\u901A\u9886\u57DF\u7FFB\u8BD1\uFF0C\u5DF2\u81EA\u52A8\u9000\u56DE\u901A\u7528\u7FFB\u8BD1");
          return requestBatch(texts, { ...options, domain: "general" });
        }
        throw err;
      }
    }
  };

  // src/shared/lang-map.js
  var TO_BUILTIN = {
    "zh-CHS": "zh-Hans",
    "zh-CHT": "zh-Hant",
    // Edge 的本地模型按书写系统区分中文，不能只传 zh。
    zh: "zh-Hans",
    "zh-Hans": "zh-Hans",
    "zh-Hant": "zh-Hant",
    en: "en",
    ja: "ja",
    ko: "ko",
    fr: "fr",
    de: "de",
    es: "es",
    pt: "pt",
    it: "it",
    ru: "ru",
    uk: "uk",
    pl: "pl",
    nl: "nl",
    sv: "sv",
    da: "da",
    no: "no",
    fi: "fi",
    cs: "cs",
    sk: "sk",
    sl: "sl",
    hr: "hr",
    ro: "ro",
    hu: "hu",
    el: "el",
    bg: "bg",
    tr: "tr",
    ar: "ar",
    he: "he",
    hi: "hi",
    bn: "bn",
    ta: "ta",
    te: "te",
    kn: "kn",
    mr: "mr",
    th: "th",
    vi: "vi",
    id: "id"
  };
  function toBuiltinLang(code) {
    if (!code) return null;
    return TO_BUILTIN[code] ?? null;
  }
  var SCRIPT_RULES = [
    [/[\u3040-\u30ff]/, "ja"],
    // 假名：必须排在汉字之前，日文里含大量汉字
    [/[\uac00-\ud7af]/, "ko"],
    [/[\u0400-\u04ff]/, "ru"],
    [/[\u0600-\u06ff]/, "ar"],
    [/[\u0e00-\u0e7f]/, "th"],
    [/[\u0900-\u097f]/, "hi"]
  ];
  var HAN_RATIO_THRESHOLD = 0.15;
  function detectSourceLanguage(text) {
    const sample = String(text ?? "");
    for (const [pattern, lang] of SCRIPT_RULES) {
      if (pattern.test(sample)) return lang;
    }
    const chars = Array.from(sample);
    if (chars.length) {
      const han = chars.filter((ch) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch)).length;
      if (han > 0 && han / chars.length >= HAN_RATIO_THRESHOLD) return "zh";
    }
    return "en";
  }
  var LANGUAGE_LABELS = {
    "zh-CHS": "\u7B80\u4F53\u4E2D\u6587",
    "zh-CHT": "\u7E41\u4F53\u4E2D\u6587",
    en: "\u82F1\u8BED",
    ja: "\u65E5\u8BED",
    ko: "\u97E9\u8BED",
    fr: "\u6CD5\u8BED",
    de: "\u5FB7\u8BED",
    es: "\u897F\u73ED\u7259\u8BED",
    ru: "\u4FC4\u8BED",
    pt: "\u8461\u8404\u7259\u8BED",
    it: "\u610F\u5927\u5229\u8BED",
    ar: "\u963F\u62C9\u4F2F\u8BED",
    hi: "\u5370\u5730\u8BED",
    th: "\u6CF0\u8BED",
    vi: "\u8D8A\u5357\u8BED"
  };
  function languageLabel(code) {
    return LANGUAGE_LABELS[code] ?? code ?? "\u672A\u77E5";
  }

  // src/shared/providers/llm.js
  var PROMPT_VERSION = 1;
  var PRESETS = [
    {
      id: "deepseek",
      label: "DeepSeek Flash",
      patch: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash" },
      note: "DeepSeek V4.1 Flash\uFF0C\u7FFB\u8BD1\u4F7F\u7528\u975E\u601D\u8003\u6A21\u5F0F"
    },
    {
      id: "openai",
      label: "OpenAI GPT-6 Luna",
      patch: { baseUrl: "https://api.openai.com/v1", model: "gpt-6-luna" },
      note: "\u9700\u8981\u53EF\u8BBF\u95EE\u7684\u7F51\u7EDC\u73AF\u5883"
    },
    {
      id: "anthropic",
      label: "Claude Haiku 4.5",
      patch: { baseUrl: "https://api.anthropic.com/v1", model: "claude-haiku-4-5" },
      note: "Claude Haiku 4.5\uFF0C\u4F7F\u7528 Anthropic \u5B98\u65B9\u63A5\u53E3"
    },
    { id: "custom", label: "\u81EA\u5B9A\u4E49", patch: {}, note: "\u4EFB\u4F55 OpenAI \u517C\u5BB9\u63A5\u53E3\u90FD\u884C\uFF08\u5982\u672C\u5730 Ollama\u3001vLLM\uFF09" }
  ];
  function defaultSystemPrompt(targetLabel) {
    return [
      `\u4F60\u662F\u4E13\u4E1A\u7684\u7FFB\u8BD1\u5F15\u64CE\u3002\u628A\u7528\u6237\u63D0\u4F9B\u7684\u6BCF\u4E2A\u7F16\u53F7\u6BB5\u843D\u7FFB\u8BD1\u6210${targetLabel}\u3002`,
      "\u5FC5\u987B\u4E25\u683C\u9075\u5B88\uFF1A",
      "1. \u539F\u6837\u4FDD\u7559\u6BCF\u6BB5\u5F00\u5934\u7684 [n] \u6807\u8BB0\uFF0C\u9010\u6BB5\u5BF9\u5E94\uFF0C\u4E0D\u5F97\u5408\u5E76\u3001\u62C6\u5206\u3001\u589E\u5220\u6BB5\u843D\uFF1B",
      "2. \u53EA\u8F93\u51FA\u7FFB\u8BD1\u7ED3\u679C\uFF0C\u4E0D\u8981\u4EFB\u4F55\u89E3\u91CA\u3001\u524D\u8A00\u3001\u603B\u7ED3\u6216 Markdown \u4EE3\u7801\u5757\uFF1B",
      "3. \u4E0D\u8981\u7FFB\u8BD1\u4EE3\u7801\u3001URL\u3001\u4E13\u6709\u540D\u8BCD\u7684\u5927\u5C0F\u5199\u4E0E\u6570\u5B57\u3002"
    ].join("\n");
  }
  function buildMessages(texts, { to, systemPrompt } = {}) {
    const system = String(systemPrompt ?? "").trim() || defaultSystemPrompt(languageLabel(to));
    const user = texts.map((text, i) => `[${i + 1}] ${text}`).join("\n");
    return [
      { role: "system", content: system },
      { role: "user", content: user }
    ];
  }
  function stripFence(text) {
    const match = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
    return match ? match[1].trim() : text;
  }
  function formatError(message) {
    return new TranslationError(message, { code: "llm-format" });
  }
  function parseNumbered(raw, expectedCount) {
    const text = stripFence(String(raw ?? "").trim());
    const marks = [...text.matchAll(/^[ \t]*[[【](\d+)[\]】][ \t]*/gm)];
    if (marks.length !== expectedCount) {
      throw formatError(`\u6A21\u578B\u8FD4\u56DE ${marks.length} \u6BB5\uFF0C\u539F\u6587 ${expectedCount} \u6BB5`);
    }
    for (let i = 0; i < marks.length; i += 1) {
      if (Number(marks[i][1]) !== i + 1) {
        throw formatError(`\u6A21\u578B\u8FD4\u56DE\u7684\u7F16\u53F7\u987A\u5E8F\u4E0D\u5BF9\uFF08\u7B2C ${i + 1} \u4E2A\u662F [${marks[i][1]}]\uFF09`);
      }
    }
    const out = [];
    for (let i = 0; i < marks.length; i += 1) {
      const start = marks[i].index + marks[i][0].length;
      const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
      const segment = text.slice(start, end).trim();
      if (!segment) throw formatError(`\u7B2C ${i + 1} \u6BB5\u8BD1\u6587\u4E3A\u7A7A`);
      out.push(segment);
    }
    return out;
  }
  function chatUrl(baseUrl) {
    const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!base) return "";
    if (/\/chat\/completions$/.test(base)) return base;
    return `${base}/chat/completions`;
  }
  function httpError(status, detail) {
    const suffix = detail ? `\uFF1A${detail.slice(0, 120)}` : "";
    if (status === 401 || status === 403) {
      return new TranslationError(`API Key \u88AB\u62D2\u7EDD\uFF08HTTP ${status}\uFF09\uFF0C\u8BF7\u5230\u8BBE\u7F6E\u9875\u6838\u5BF9${suffix}`, {
        code: String(status),
        fatal: true,
        needConfig: true
      });
    }
    if (status === 402) {
      return new TranslationError(`\u8D26\u6237\u4F59\u989D\u4E0D\u8DB3\uFF08HTTP 402\uFF09\uFF0C\u8BF7\u5148\u5145\u503C${suffix}`, {
        code: "402",
        fatal: true
      });
    }
    if (status === 404) {
      return new TranslationError(`\u63A5\u53E3\u5730\u5740\u6216\u6A21\u578B\u540D\u4E0D\u5BF9\uFF08HTTP 404\uFF09${suffix}`, {
        code: "404",
        fatal: true,
        needConfig: true
      });
    }
    if (status === 429) {
      return new TranslationError(`\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF08HTTP 429\uFF09\uFF0C\u7A0D\u540E\u4F1A\u81EA\u52A8\u91CD\u8BD5${suffix}`, {
        code: "429",
        retryable: true
      });
    }
    if (status >= 500) {
      return new TranslationError(`\u6A21\u578B\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528\uFF08HTTP ${status}\uFF09\uFF0C\u7A0D\u540E\u4F1A\u81EA\u52A8\u91CD\u8BD5${suffix}`, {
        code: String(status),
        retryable: true
      });
    }
    return new TranslationError(`\u8BF7\u6C42\u5931\u8D25\uFF08HTTP ${status}\uFF09${suffix}`, { code: String(status) });
  }
  async function safeText(response) {
    try {
      return (await response.text())?.replace(/\s+/g, " ").trim();
    } catch {
      return "";
    }
  }
  async function chat(messages, config) {
    const url = chatUrl(config.baseUrl);
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    };
    if (/api\.anthropic\.com/.test(url)) {
      headers["anthropic-dangerous-direct-browser-access"] = "true";
    }
    const modelOptions = {};
    const hostname = new URL(url).hostname;
    if (hostname === "api.openai.com" && config.model === "gpt-6-luna") {
      modelOptions.reasoning_effort = "none";
    }
    if (hostname === "api.deepseek.com" && config.model === "deepseek-flash") {
      modelOptions.thinking = { type: "disabled" };
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        ...modelOptions,
        messages,
        temperature: Number(config.temperature ?? 0) || 0
      })
    });
    if (!response.ok) throw httpError(response.status, await safeText(response));
    let data;
    try {
      data = await response.json();
    } catch {
      throw new TranslationError("\u6A21\u578B\u8FD4\u56DE\u7684\u4E0D\u662F\u5408\u6CD5 JSON", { code: "llm-format" });
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new TranslationError("\u6A21\u578B\u8FD4\u56DE\u5185\u5BB9\u4E3A\u7A7A", { code: "llm-format" });
    }
    return content;
  }
  var llmProvider = {
    id: "llm",
    label: "\u5927\u6A21\u578B API\uFF08OpenAI / DeepSeek / Claude \u517C\u5BB9\uFF09",
    host: "network",
    note: "\u8BD1\u6587\u7531\u5927\u6A21\u578B\u751F\u6210\uFF0C\u53EF\u80FD\u51FA\u73B0\u589E\u5220\u6216\u610F\u8BD1\u3002\u91CD\u8981\u5185\u5BB9\u8BF7\u5BF9\u7167\u539F\u6587\uFF1B\u957F\u6587\u7FFB\u8BD1\u4F1A\u4EA7\u751F\u8D39\u7528\u3002",
    fields: [
      {
        key: "baseUrl",
        label: "\u63A5\u53E3\u5730\u5740",
        placeholder: "https://api.deepseek.com/v1",
        default: "https://api.deepseek.com/v1",
        note: "\u586B\u5230 /v1 \u5373\u53EF\uFF0C\u4E5F\u53EF\u4EE5\u76F4\u63A5\u586B\u5B8C\u6574\u7684 /chat/completions"
      },
      { key: "apiKey", label: "API Key", secret: true, placeholder: "sk-..." },
      { key: "model", label: "\u6A21\u578B\u540D\u79F0", placeholder: "deepseek-flash", default: "deepseek-flash", note: "\u53EF\u76F4\u63A5\u586B\u5199\u670D\u52A1\u5546\u63D0\u4F9B\u7684\u6A21\u578B ID\uFF1B\u70B9\u51FB\u4E0A\u65B9\u9884\u8BBE\u53EF\u66F4\u65B0\u578B\u53F7\u3002" },
      {
        key: "temperature",
        label: "\u91C7\u6837\u6E29\u5EA6",
        type: "number",
        default: 0,
        min: 0,
        max: 2,
        step: 0.1,
        note: "\u7FFB\u8BD1\u4EFB\u52A1\u5EFA\u8BAE\u4FDD\u6301 0\uFF0C\u6570\u503C\u8D8A\u9AD8\u8D8A\u5BB9\u6613\u8DD1\u504F"
      },
      {
        key: "systemPrompt",
        label: "\u81EA\u5B9A\u4E49\u63D0\u793A\u8BCD\uFF08\u9AD8\u7EA7\uFF09",
        type: "textarea",
        advanced: true,
        default: "",
        placeholder: "\u7559\u7A7A\u5373\u4F7F\u7528\u5185\u7F6E\u6A21\u677F\u3002\u6539\u574F\u6A21\u677F\u4F1A\u5BFC\u81F4\u5206\u6BB5\u9519\u4F4D\uFF0C\u63D2\u4EF6\u4F1A\u81EA\u52A8\u9000\u56DE\u9010\u6BB5\u7FFB\u8BD1\u3002"
      }
    ],
    presets: PRESETS,
    isReady: (config) => Boolean(config.apiKey && config.model && config.baseUrl),
    // 大模型的上下文和成本都随段数增长，批不宜太大
    batch: { maxSegments: 12, maxChars: 4e3 },
    /**
     * 自定义接口地址需要运行时的 host 权限才能从后台发请求。
     * 由 provider 自己声明要申请哪些来源，设置页因此不需要知道是哪家引擎。
     */
    permissionOrigins: (config) => config.baseUrl ? [config.baseUrl] : [],
    // 换了模型或改了提示词，旧译文必须失效
    cacheScope: (config) => `${config.model || "unknown"}|p${PROMPT_VERSION}|${quickHash(config.systemPrompt || "")}`,
    async translateBatch(texts, settings) {
      const config = { ...fieldsDefaults(llmProvider.fields), ...providerConfig(settings, "llm") };
      if (!config.apiKey) {
        throw new TranslationError("\u8FD8\u6CA1\u586B API Key\uFF0C\u8BF7\u5230\u8BBE\u7F6E\u9875\u586B\u5199", {
          needConfig: true,
          fatal: true
        });
      }
      if (!config.baseUrl || !config.model) {
        throw new TranslationError("\u63A5\u53E3\u5730\u5740\u6216\u6A21\u578B\u540D\u79F0\u6CA1\u586B\uFF0C\u8BF7\u5230\u8BBE\u7F6E\u9875\u8865\u9F50", {
          needConfig: true,
          fatal: true
        });
      }
      if (texts.length === 1) {
        const raw2 = await chat(
          [
            {
              role: "system",
              content: String(config.systemPrompt ?? "").trim() || `\u4F60\u662F\u4E13\u4E1A\u7FFB\u8BD1\u5F15\u64CE\u3002\u628A\u7528\u6237\u63D0\u4F9B\u7684\u6587\u672C\u7FFB\u8BD1\u6210${languageLabel(settings.to)}\u3002\u53EA\u8F93\u51FA\u8BD1\u6587\uFF0C\u4E0D\u8981\u4EFB\u4F55\u89E3\u91CA\u6216\u4EE3\u7801\u5757\u3002`
            },
            { role: "user", content: texts[0] }
          ],
          config
        );
        return [raw2.trim()];
      }
      const raw = await chat(
        buildMessages(texts, { to: settings.to, systemPrompt: config.systemPrompt }),
        config
      );
      try {
        return parseNumbered(raw, texts.length);
      } catch (err) {
        const isFormat = err instanceof TranslationError && err.code === "llm-format";
        if (!isFormat) throw err;
        console.warn("[itx] \u5927\u6A21\u578B\u5206\u6BB5\u6821\u9A8C\u672A\u901A\u8FC7\uFF0C\u5DF2\u9000\u56DE\u9010\u6BB5\u8BF7\u6C42\uFF1A", err.message);
        const out = [];
        for (const text of texts) {
          const single = await chat(
            [
              {
                role: "system",
                content: String(config.systemPrompt ?? "").trim() || `\u4F60\u662F\u4E13\u4E1A\u7FFB\u8BD1\u5F15\u64CE\u3002\u628A\u7528\u6237\u63D0\u4F9B\u7684\u6587\u672C\u7FFB\u8BD1\u6210${languageLabel(settings.to)}\u3002\u53EA\u8F93\u51FA\u8BD1\u6587\uFF0C\u4E0D\u8981\u4EFB\u4F55\u89E3\u91CA\u6216\u4EE3\u7801\u5757\u3002`
              },
              { role: "user", content: text }
            ],
            config
          );
          out.push(single.trim());
        }
        return out;
      }
    }
  };

  // src/shared/providers/builtin.js
  var instances = /* @__PURE__ */ new Map();
  var DEFAULT_STALL_TIMEOUT_MS = 12e3;
  var DEFAULT_FIRST_PROGRESS_TIMEOUT_MS = 25e3;
  function hasApi() {
    try {
      return typeof globalThis.Translator !== "undefined" && globalThis.Translator !== null;
    } catch {
      return false;
    }
  }
  function targetCode(settings) {
    const code = toBuiltinLang(settings?.to);
    if (!code) {
      throw new TranslationError(
        `\u6D4F\u89C8\u5668\u5185\u7F6E AI \u4E0D\u652F\u6301\u628A\u6587\u672C\u7FFB\u8BD1\u6210\u300C${settings?.to ?? "\u672A\u77E5\u8BED\u8A00"}\u300D`,
        { fatal: true, needConfig: true }
      );
    }
    return code;
  }
  function resolveSource(text, settings) {
    if (settings?.from && settings.from !== "auto") {
      return toBuiltinLang(settings.from) ?? toBuiltinLang(detectSourceLanguage(text));
    }
    return toBuiltinLang(detectSourceLanguage(text));
  }
  function pairOptions(source, target) {
    return { sourceLanguage: source, targetLanguage: target };
  }
  function stallTimeoutOf(settings) {
    const configured = Number(settings?.builtinStallTimeoutMs);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STALL_TIMEOUT_MS;
  }
  function firstProgressTimeoutOf(settings) {
    const configured = Number(settings?.builtinFirstProgressTimeoutMs);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_FIRST_PROGRESS_TIMEOUT_MS;
  }
  function stallError(source, target, ms, sawProgress) {
    const detail = sawProgress ? `${Math.round(ms / 1e3)} \u79D2\u5185\u6CA1\u6709\u4EFB\u4F55\u65B0\u7684\u4E0B\u8F7D\u8FDB\u5EA6` : `\u7B49\u4E86 ${Math.round(ms / 1e3)} \u79D2\u90FD\u6CA1\u6709\u5F00\u59CB\u4E0B\u8F7D`;
    return new TranslationError(
      `\u5185\u7F6E AI \u7684\u8BED\u8A00\u5305\uFF08${source} \u2192 ${target}\uFF09\u4E0B\u4E0D\u4E0B\u6765\uFF1A${detail}\u3002\u4F60\u6240\u5728\u7684\u7F51\u7EDC\u5F88\u53EF\u80FD\u8BBF\u95EE\u4E0D\u5230\u6D4F\u89C8\u5668\u4E0B\u8F7D\u6A21\u578B\u7684\u670D\u52A1\u5668\uFF08\u4E2D\u56FD\u5927\u9646\u5E38\u89C1\uFF09\u3002\u5EFA\u8BAE\u5728\u8BBE\u7F6E\u9875\u6539\u7528\u300C\u6709\u9053\u667A\u4E91\u300D\u6216\u300C\u5927\u6A21\u578B API\u300D\u3002`,
      { code: "builtin-stall", fatal: true, needConfig: true }
    );
  }
  function cancelledError() {
    return new TranslationError("\u5DF2\u53D6\u6D88\u4E0B\u8F7D\u5185\u7F6E AI \u8BED\u8A00\u5305", {
      code: "builtin-cancelled",
      fatal: true
    });
  }
  function classifyCreateError(err, source, target) {
    const name = err?.name || "";
    if (name === "NotAllowedError") {
      return new TranslationError(
        "\u5185\u7F6E AI \u7684\u8BED\u8A00\u5305\u4E0B\u8F7D\u9700\u8981\u7528\u6237\u624B\u52BF\u786E\u8BA4\uFF08\u6309\u5FEB\u6377\u952E\u540E\u8BF7\u52FF\u5207\u8D70\u9875\u9762\uFF09\uFF0C\u672C\u6B21\u5DF2\u6539\u7528\u5176\u4ED6\u5F15\u64CE",
        { code: "NotAllowedError", fatal: true }
      );
    }
    if (name === "NotSupportedError") {
      return new TranslationError(`\u5185\u7F6E AI \u65E0\u6CD5\u521D\u59CB\u5316 ${source} \u2192 ${target}\uFF08${name}\uFF09\uFF1A${err?.message || "\u6D4F\u89C8\u5668\u672A\u63D0\u4F9B\u8BE6\u7EC6\u539F\u56E0"}\u3002\u8FD9\u4E5F\u53EF\u80FD\u662F\u6D4F\u89C8\u5668\u7FFB\u8BD1\u670D\u52A1\u542F\u52A8\u5931\u8D25\uFF0C\u8BF7\u66F4\u65B0\u5E76\u91CD\u542F\u6D4F\u89C8\u5668\u540E\u91CD\u8BD5\u3002`, {
        code: "NotSupportedError",
        fatal: true,
        needConfig: true
      });
    }
    if (name === "QuotaExceededError") {
      return new TranslationError("\u8BBE\u5907\u53EF\u7528\u5B58\u50A8\u7A7A\u95F4\u4E0D\u8DB3\uFF0C\u65E0\u6CD5\u4E0B\u8F7D\u8BED\u8A00\u5305", {
        code: "QuotaExceededError",
        fatal: true
      });
    }
    return new TranslationError(err?.message || "\u5185\u7F6E AI \u521D\u59CB\u5316\u5931\u8D25", { fatal: true });
  }
  async function ensureTranslator(source, target, options = {}) {
    const key = `${source}|${target}`;
    const cached2 = instances.get(key);
    if (cached2) return cached2;
    const {
      onProgress: onProgress2,
      shouldCancel,
      stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
      firstProgressTimeoutMs = DEFAULT_FIRST_PROGRESS_TIMEOUT_MS
    } = options;
    const pair = pairOptions(source, target);
    if (shouldCancel?.()) throw cancelledError();
    let settled = false;
    let timer = null;
    let cancelPoll = null;
    let rejectInner = null;
    const promise = new Promise((resolve, reject) => {
      rejectInner = reject;
      let sawProgress = false;
      const armWatchdog = () => {
        if (timer) clearTimeout(timer);
        const budget = sawProgress ? stallTimeoutMs : firstProgressTimeoutMs;
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          instances.delete(key);
          reject(stallError(source, target, budget, sawProgress));
        }, budget);
      };
      armWatchdog();
      globalThis.Translator.create({
        ...pair,
        monitor(m) {
          m.addEventListener("downloadprogress", (event) => {
            if (settled) return;
            sawProgress = true;
            armWatchdog();
            const total = Number(event?.total) || 1;
            const percent = Math.min(100, Math.max(0, Math.round((Number(event?.loaded) || 0) / total * 100)));
            onProgress2?.(percent);
          });
        }
      }).then(
        (translator) => {
          if (settled) {
            translator.destroy?.();
            return;
          }
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(translator);
        },
        (err) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          instances.delete(key);
          reject(classifyCreateError(err, source, target));
        }
      );
      if (shouldCancel) {
        cancelPoll = setInterval(() => {
          if (settled) return;
          if (!shouldCancel()) return;
          settled = true;
          if (timer) clearTimeout(timer);
          instances.delete(key);
          reject(cancelledError());
        }, 120);
      }
    });
    const cleanup = () => {
      if (cancelPoll) {
        clearInterval(cancelPoll);
        cancelPoll = null;
      }
    };
    promise.then(cleanup, cleanup);
    instances.set(key, promise);
    return promise;
  }
  var builtinProvider = {
    id: "builtin",
    label: "\u6D4F\u89C8\u5668\u5185\u7F6E AI\uFF08\u514D\u8D39 \xB7 \u672C\u5730\uFF09",
    host: "content",
    note: "\u5B8C\u5168\u5728\u672C\u673A\u8FD0\u884C\uFF0C\u6587\u672C\u4E0D\u4E0A\u4F20\uFF1B\u9700\u8981 Chrome 138+ / Edge 148+ \u684C\u9762\u7248\uFF0C\u4E14\u8BBE\u5907\u6EE1\u8DB3\u5185\u5B58\u4E0E\u5B58\u50A8\u8981\u6C42\u3002\u9996\u6B21\u4F7F\u7528\u9700\u4E0B\u8F7D\u8BED\u8A00\u5305\u3002",
    fields: [],
    /**
     * 这里只判断「环境有没有这个能力」。
     * 具体语言对是否可用要等 prepare() —— 那需要一段真实样本来判定 auto 源语言。
     */
    isReady: () => true,
    batch: { maxSegments: 1, maxChars: Number.POSITIVE_INFINITY },
    /** 内置 AI 没有模型参数可选，也没有领域概念 */
    cacheScope: () => "builtin",
    async describe(settings) {
      if (!hasApi()) {
        return {
          available: false,
          reason: "\u5F53\u524D\u6D4F\u89C8\u5668\u6CA1\u6709\u5185\u7F6E AI \u7FFB\u8BD1\u80FD\u529B\uFF08\u9700\u8981 Chrome 138+ \u6216 Edge 148+ \u684C\u9762\u7248\uFF09"
        };
      }
      const target = toBuiltinLang(settings?.to);
      if (!target) {
        return { available: false, reason: `\u5185\u7F6E AI \u4E0D\u652F\u6301\u300C${settings?.to ?? "\u8BE5\u8BED\u8A00"}\u300D\u4F5C\u4E3A\u76EE\u6807\u8BED\u8A00` };
      }
      return { available: true, reason: null };
    },
    /**
     * 预检语言对并（必要时）下载语言包。
     *
     * 必须在用户手势的有效期内尽早调用 —— 内容脚本在 keydown 里会**立刻**
     * 调它，而不是等一轮消息往返之后再调，否则会丢用户激活。
     *
     * 三种「不成功」都会被明确抛出来，交给上层回落：
     * 环境不支持（fatal）、用户取消（builtin-cancelled）、下载卡住（builtin-stall）。
     * 绝不返回一个永远 pending 的 Promise。
     */
    async prepare(settings, { sampleText, onProgress: onProgress2, shouldCancel } = {}) {
      if (!hasApi()) {
        throw new TranslationError("\u5F53\u524D\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u5185\u7F6E AI", { fatal: true, needConfig: true });
      }
      const target = targetCode(settings);
      const stallTimeoutMs = stallTimeoutOf(settings);
      const firstProgressTimeoutMs = firstProgressTimeoutOf(settings);
      const sources = /* @__PURE__ */ new Set();
      if (settings.from && settings.from !== "auto") {
        sources.add(toBuiltinLang(settings.from) ?? toBuiltinLang(detectSourceLanguage(sampleText ?? "")));
      } else {
        sources.add(toBuiltinLang(detectSourceLanguage(sampleText ?? "")));
      }
      for (const source of sources) {
        if (source === target) continue;
        await ensureTranslator(source, target, {
          onProgress: onProgress2,
          shouldCancel,
          stallTimeoutMs,
          firstProgressTimeoutMs
        });
      }
      return true;
    },
    async translateBatch(texts, settings) {
      if (!hasApi()) {
        throw new TranslationError("\u5F53\u524D\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u5185\u7F6E AI", { fatal: true, needConfig: true });
      }
      const target = targetCode(settings);
      const out = [];
      for (const text of texts) {
        const source = resolveSource(text, settings);
        if (source === target) {
          out.push(text);
          continue;
        }
        const translator = await ensureTranslator(source, target);
        try {
          out.push(await translator.translate(text));
        } catch (err) {
          throw new TranslationError(err?.message || "\u5185\u7F6E AI \u7FFB\u8BD1\u5931\u8D25", { fatal: false });
        }
      }
      return out;
    }
  };

  // src/shared/providers/registry.js
  var REGISTRY = /* @__PURE__ */ new Map([
    [mockProvider.id, mockProvider],
    [youdaoProvider.id, youdaoProvider],
    [llmProvider.id, llmProvider],
    [builtinProvider.id, builtinProvider]
  ]);
  function getProvider(id) {
    return REGISTRY.get(id) ?? null;
  }

  // src/shared/text.js
  function normalizeText(input) {
    return String(input ?? "").replace(/[\t\r\n\f\v\u00a0\u2000-\u200a\u2028\u2029\u3000]+/g, " ").replace(/ {2,}/g, " ").trim();
  }
  function cjkRatio(text) {
    const chars = Array.from(text);
    if (chars.length === 0) return 0;
    let cjk = 0;
    for (const ch of chars) {
      const code = ch.codePointAt(0);
      const isCJK = code >= 12352 && code <= 12543 || // 日文假名
      code >= 13312 && code <= 19903 || // 扩展 A
      code >= 19968 && code <= 40959 || // 基本汉字
      code >= 63744 && code <= 64255 || // 兼容汉字
      code >= 44032 && code <= 55215;
      if (isCJK) cjk += 1;
    }
    return cjk / chars.length;
  }
  function looksLikeUiString(text, { threshold = 30 } = {}) {
    if (text.length >= threshold) return false;
    return !/[.。!！?？:：;；,，、"'”’)\]}»]$/.test(text.trim());
  }

  // src/content/detect/selectors.js
  var BASE_CANDIDATES = [
    "p",
    "li",
    "td",
    "th",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "dd",
    "dt",
    "figcaption",
    "summary",
    "caption",
    "a[href]"
  ];
  var NESTED_BLOCK = "p, li, ul, ol, div, table, blockquote, pre";
  var EXCLUDE = [
    "script",
    "style",
    "noscript",
    "template",
    "code",
    "pre",
    "kbd",
    "samp",
    "var",
    "svg",
    "math",
    "canvas",
    "iframe",
    "video",
    "audio",
    "nav",
    "header",
    "footer",
    "aside",
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '[role="search"]',
    '[role="toolbar"]',
    '[role="menu"]',
    '[aria-hidden="true"]',
    "[hidden]",
    '[contenteditable="true"]',
    '[translate="no"]',
    ".notranslate",
    "button",
    "select",
    "textarea",
    "input",
    "label",
    "option",
    "form",
    "dialog"
  ];
  var NOISE_CONTAINER = [
    "nav",
    "footer",
    '[role="banner"]',
    '[role="contentinfo"]',
    '[role="navigation"]',
    '[role="toolbar"]',
    '[class*="pagination" i]',
    '[id*="pagination" i]',
    '[class*="breadcrumb" i]',
    '[aria-label*="breadcrumb" i]',
    '[class*="site-nav" i]',
    '[class*="navbar" i]',
    '[class*="topbar" i]',
    '[class*="top-bar" i]',
    '[class*="site-header" i]',
    '[class*="masthead" i]',
    '[class*="site-footer" i]',
    '[class*="page-footer" i]'
  ];
  var CANDIDATE_SELECTOR = BASE_CANDIDATES.join(",");
  var EXCLUDE_SELECTOR = EXCLUDE.join(",");
  var NOISE_CONTAINER_SELECTOR = NOISE_CONTAINER.join(",");
  var HEADING = /^H[1-6]$/;
  var ANCHOR_MIN_LENGTH = 20;
  function isExcluded(el) {
    if (!el || el.nodeType !== 1) return true;
    if (HEADING.test(el.tagName)) {
      if (el.closest('[role="banner"], [role="contentinfo"]')) return true;
      if (el.closest('nav, [role="navigation"]')) return true;
      return false;
    }
    if (el.matches(EXCLUDE_SELECTOR)) return true;
    if (el.closest(EXCLUDE_SELECTOR)) return true;
    if (el.closest("[data-itx]")) return true;
    return false;
  }
  function isNoiseLink(el) {
    if (el.tagName !== "A") return false;
    if (isExcluded(el)) return true;
    return Boolean(el.closest(NOISE_CONTAINER_SELECTOR));
  }
  function linkMinTextLength(options = {}) {
    return Math.max(options.minTextLength ?? 12, ANCHOR_MIN_LENGTH);
  }
  function hasNestedBlock(el) {
    const tag = el.tagName;
    if (tag === "A") return Boolean(el.querySelector("p,li,div,table,blockquote,h1,h2,h3,h4,h5,h6"));
    if (tag !== "TD" && tag !== "TH" && tag !== "LI" && tag !== "DD") return false;
    return Array.from(el.children).some(
      (child) => child.nodeType === 1 && child.matches(NESTED_BLOCK) && // 我们自己注入的译文节点不算「原有块级子元素」，
      // 否则表格单元在翻译过一轮之后就再也不参与识别了
      !child.matches('[data-itx="trans"]')
    );
  }

  // src/content/detect/lang.js
  function isTranslatable(text, options = {}) {
    const { minTextLength = 12, allowUiString = false } = options;
    if (!text) return { ok: false, reason: "empty" };
    if (text.length < minTextLength) return { ok: false, reason: "too-short" };
    if (cjkRatio(text) > 0.3) return { ok: false, reason: "already-cjk" };
    if (!/[A-Za-z\u00c0-\u024f\u0400-\u04ff]/.test(text)) {
      return { ok: false, reason: "no-letters" };
    }
    if (!allowUiString) {
      if (looksLikeUiString(text)) return { ok: false, reason: "ui-string" };
    }
    return { ok: true, reason: null };
  }

  // src/shared/site-rules.js
  function matchesSelectorSafe(el, selector) {
    if (!el || el.nodeType !== 1 || typeof selector !== "string" || !selector) return false;
    try {
      return Boolean(el.closest(selector));
    } catch {
      return false;
    }
  }
  function normalizeRule(rule) {
    return {
      exclude: Array.isArray(rule?.exclude) ? rule.exclude.filter(Boolean) : [],
      include: Array.isArray(rule?.include) ? rule.include.filter(Boolean) : [],
      incremental: typeof rule?.incremental === "boolean" ? rule.incremental : null
    };
  }
  function isAllowedByRules(el, rule) {
    const normalized = normalizeRule(rule);
    for (const selector of normalized.exclude) {
      if (matchesSelectorSafe(el, selector)) return false;
    }
    if (normalized.include.length) {
      return normalized.include.some((selector) => matchesSelectorSafe(el, selector));
    }
    return true;
  }

  // src/content/detect/index.js
  function directText(el) {
    let out = "";
    const visit = (parent) => {
      for (const node of parent.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) out += node.data;
        else if (node.nodeType === Node.ELEMENT_NODE && !isExcluded(node)) {
          if (node.tagName === "BR") out += " ";
          else if (/^(A|SPAN|B|STRONG|I|EM|U|S|SMALL|MARK|SUB|SUP|ABBR|TIME|CITE|Q)$/.test(node.tagName)) visit(node);
        }
      }
    };
    visit(el);
    return normalizeText(out);
  }
  var seq = 0;
  function detectUnit(el, options = {}) {
    if (isExcluded(el)) return null;
    if (hasNestedBlock(el)) return null;
    if (!isAllowedByRules(el, options.rules)) return null;
    const text = directText(el);
    const isLink = el.tagName === "A";
    if (isNoiseLink(el)) return null;
    const isCell = el.tagName === "TD" || el.tagName === "TH";
    const isListItem = el.tagName === "LI";
    const isHeading = /^H[1-6]$/.test(el.tagName);
    const compact = isCell || isListItem;
    const verdict = isTranslatable(text, {
      minTextLength: isLink ? linkMinTextLength(options) : compact ? Math.min(options.minTextLength ?? 12, 4) : options.minTextLength,
      // 表格单元天然短，标题天然短，都放宽句末标点要求
      allowUiString: isCell || isHeading
    });
    if (!verdict.ok) return null;
    return {
      id: `u${seq += 1}`,
      el,
      text,
      inCell: isCell,
      translated: false,
      failed: false,
      node: null
    };
  }
  function collectUnits(root, options = {}) {
    const units = [];
    if (!root || !root.querySelectorAll) return units;
    const elements = [];
    if (root.nodeType === 1 && root.matches(CANDIDATE_SELECTOR)) elements.push(root);
    elements.push(...root.querySelectorAll(CANDIDATE_SELECTOR));
    const accepted = /* @__PURE__ */ new Set();
    for (const el of elements) {
      if (el.closest('[data-itx="trans"]')) continue;
      let ancestor = el.parentElement;
      while (ancestor && !accepted.has(ancestor)) ancestor = ancestor.parentElement;
      if (ancestor) continue;
      const unit = detectUnit(el, options);
      if (unit) {
        units.push(unit);
        accepted.add(el);
      }
    }
    return units;
  }
  function sortByDocumentOrder(units) {
    return units.slice().sort((a, b) => {
      const rel = a.el.compareDocumentPosition(b.el);
      if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  // src/content/schedule.js
  function createRun({
    translate,
    onGroupResult,
    onProgress: onProgress2,
    shouldCancel,
    intervalMs = 0,
    concurrency = 3
  }) {
    const queue = [];
    let cursor = 0;
    let done = 0;
    let active = 0;
    let aborted = false;
    let idleWaiters = [];
    let lastDispatch = 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const cancelled = () => aborted || Boolean(shouldCancel?.());
    function settleIfIdle() {
      if (cancelled() || cursor >= queue.length && active === 0) {
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
    function pump() {
      if (cancelled()) {
        settleIfIdle();
        return;
      }
      while (active < concurrency && cursor < queue.length) {
        const job = queue[cursor];
        cursor += 1;
        active += 1;
        void runJob(job);
      }
      settleIfIdle();
    }
    async function runJob(job) {
      try {
        if (intervalMs > 0) {
          const wait = lastDispatch + intervalMs - Date.now();
          if (wait > 0) await sleep(wait);
          lastDispatch = Date.now();
        }
        if (cancelled()) return;
        const texts = job.groups.map((group) => group.text);
        let items;
        try {
          items = await translate(texts);
        } catch (err) {
          items = job.groups.map(() => ({
            ok: false,
            error: err?.message || String(err),
            needConfig: err?.needConfig,
            rateNotice: err?.rateNotice
          }));
        }
        if (cancelled()) return;
        for (let i = 0; i < job.groups.length; i += 1) {
          const group = job.groups[i];
          const result = items?.[i] ?? { ok: false, error: "\u540E\u53F0\u6CA1\u6709\u8FD4\u56DE\u8FD9\u4E00\u6BB5\u7684\u7ED3\u679C" };
          onGroupResult(group, result);
          done += 1;
        }
      } finally {
        active -= 1;
        onProgress2?.(done, queue.length);
        pump();
      }
    }
    return {
      /** 追加待翻译的批次。job = { groups: [{hash, text, units}] } */
      push(jobs) {
        for (const job of jobs ?? []) {
          if (job?.groups?.length) queue.push(job);
        }
        pump();
      },
      /** 当前队列跑空（含之后 push 进来的）时 resolve；被取消时立即 resolve */
      whenIdle() {
        if (cancelled() || cursor >= queue.length && active === 0) return Promise.resolve();
        return new Promise((resolve) => idleWaiters.push(resolve));
      },
      abort() {
        aborted = true;
        pump();
      },
      get cancelled() {
        return cancelled();
      },
      stats() {
        return { done, total: queue.length, queued: Math.max(0, queue.length - cursor), active };
      }
    };
  }

  // src/content/incremental.js
  var OURS = "[data-itx]";
  var MAX_ELEMENTS_PER_FLUSH = 800;
  var MAX_UNITS_PER_FLUSH = 120;
  function isOurs(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el) return true;
    try {
      return Boolean(el.closest?.(OURS));
    } catch {
      return true;
    }
  }
  function countElements(node) {
    try {
      return 1 + (node.querySelectorAll?.("*").length ?? 0);
    } catch {
      return 1;
    }
  }
  function createIncremental({
    root,
    options,
    onUnits,
    onOverflow,
    isBlocked,
    debounceMs = 700,
    maxPerMinute = 60,
    maxPerFlush = MAX_UNITS_PER_FLUSH
  }) {
    let observer = null;
    let timer = null;
    let pending = /* @__PURE__ */ new Set();
    const spent = [];
    function budgetLeft() {
      const now = Date.now();
      while (spent.length && now - spent[0].t > 6e4) spent.shift();
      return maxPerMinute - spent.reduce((sum, entry) => sum + entry.units, 0);
    }
    function flush() {
      timer = null;
      if (isBlocked?.()) {
        pending.clear();
        return;
      }
      const nodes = Array.from(pending);
      pending.clear();
      const elementCount = nodes.reduce((sum, node) => sum + countElements(node), 0);
      if (elementCount > MAX_ELEMENTS_PER_FLUSH) return;
      const units = [];
      for (const node of nodes) {
        if (!node.isConnected) continue;
        units.push(...collectUnits(node, options));
      }
      if (!units.length) return;
      if (units.length > maxPerFlush || units.length > budgetLeft()) {
        stop();
        onOverflow?.();
        return;
      }
      spent.push({ t: Date.now(), units: units.length });
      onUnits(units);
    }
    function handle(mutations) {
      if (isBlocked?.()) return;
      for (const mutation of mutations) {
        if (mutation.type !== "childList") continue;
        if (isOurs(mutation.target)) continue;
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (isOurs(node)) continue;
          pending.add(node);
        }
      }
      if (!pending.size) return;
      clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    }
    function start() {
      if (observer || !root) return;
      const Ctor = root.ownerDocument?.defaultView?.MutationObserver ?? globalThis.MutationObserver;
      if (!Ctor) return;
      observer = new Ctor(handle);
      observer.observe(root, { childList: true, subtree: true });
    }
    function stop() {
      clearTimeout(timer);
      timer = null;
      pending.clear();
      if (observer) {
        observer.disconnect();
        observer = null;
      }
    }
    return {
      start,
      stop,
      get active() {
        return Boolean(observer);
      }
    };
  }

  // src/content/detect/selector.js
  var SEMANTIC = /^[a-z][a-z0-9-]{2,}$/;
  var HEX_RUN = /(?=[0-9a-f]*\d)[0-9a-f]{6,}/i;
  var SUFFIX_HASH = /^[a-z][a-z0-9]*-([0-9a-z]{5,})$/i;
  var NUMERIC_TAIL = /(^|[-_])[0-9]{3,}([-_]|$)/;
  function looksGenerated(value) {
    const text = String(value ?? "");
    if (HEX_RUN.test(text)) return true;
    const suffix = SUFFIX_HASH.exec(text);
    if (suffix && /\d/.test(suffix[1])) return true;
    return NUMERIC_TAIL.test(text);
  }
  var LANDMARK_TAGS = /* @__PURE__ */ new Set([
    "ASIDE",
    "NAV",
    "SECTION",
    "ARTICLE",
    "MAIN",
    "FIGURE",
    "HEADER",
    "FOOTER",
    "FORM",
    "TABLE"
  ]);
  var CONTAINER_TAGS = /* @__PURE__ */ new Set(["DIV", "UL", "OL"]);
  function cssEscape(value) {
    const text = String(value);
    if (typeof globalThis.CSS?.escape === "function") return globalThis.CSS.escape(text);
    return text.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
  }
  function isStableId(id) {
    const text = String(id ?? "");
    if (!text || text.length > 64) return false;
    if (!/^[A-Za-z][\w:.-]*$/.test(text)) return false;
    return !looksGenerated(text);
  }
  function stableClasses(el) {
    if (!el?.classList) return [];
    return Array.from(el.classList).filter((name) => SEMANTIC.test(name) && !looksGenerated(name)).slice(0, 2);
  }
  function buildSelector(el, { maxDepth = 4, root = null } = {}) {
    if (!el || el.nodeType !== 1) return null;
    const boundary = root ?? el.ownerDocument?.body ?? null;
    if (isStableId(el.id)) return `#${cssEscape(el.id)}`;
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1) {
      if (node === boundary || node.tagName === "HTML" || node.tagName === "BODY") break;
      if (isStableId(node.id)) {
        parts.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      if (depth < maxDepth) {
        const tag = node.tagName.toLowerCase();
        const classes = stableClasses(node);
        if (classes.length) {
          parts.unshift(`${tag}.${classes.map(cssEscape).join(".")}`);
        } else {
          const parent = node.parentElement;
          if (parent) {
            const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
            if (sameTag.length > 1) parts.unshift(`${tag}:nth-of-type(${sameTag.indexOf(node) + 1})`);
            else parts.unshift(tag);
          } else {
            parts.unshift(tag);
          }
        }
        depth += 1;
      }
      node = node.parentElement;
    }
    return parts.length ? parts.join(" > ") : null;
  }
  function selectorHits(doc, selector, el) {
    if (!selector) return false;
    try {
      const matches = doc.querySelectorAll(selector);
      if (matches.length !== 1) return false;
      return matches[0].contains(el);
    } catch {
      return false;
    }
  }
  function resolveSelectionTarget(win) {
    const selection = win?.getSelection?.();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    if (!String(selection.toString() ?? "").trim()) return null;
    const container = selection.getRangeAt(0).commonAncestorContainer;
    const el = container?.nodeType === 1 ? container : container?.parentElement;
    if (!el) return null;
    let landmark = null;
    let containerEl = null;
    let cursor = el;
    for (let depth = 0; depth < 4 && cursor; depth += 1) {
      if (!landmark && LANDMARK_TAGS.has(cursor.tagName)) landmark = cursor;
      if (!containerEl && CONTAINER_TAGS.has(cursor.tagName)) containerEl = cursor;
      if (landmark) break;
      cursor = cursor.parentElement;
    }
    return landmark ?? containerEl ?? el;
  }

  // src/content/config.js
  var cached = null;
  async function loadConfig({ force = false } = {}) {
    if (cached && !force) return cached;
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({ type: MSG.CONFIG });
    } catch (err) {
      console.warn("[itx] \u8BFB\u53D6\u914D\u7F6E\u5931\u8D25", err);
      response = null;
    }
    if (!response?.ok) return null;
    cached = response;
    return cached;
  }
  function cachedConfig() {
    return cached;
  }
  function invalidateConfig() {
    cached = null;
  }
  function siteRule(config) {
    const host = location.hostname;
    const rule = config?.settings?.siteRules?.[host];
    return {
      exclude: Array.isArray(rule?.exclude) ? rule.exclude : [],
      include: Array.isArray(rule?.include) ? rule.include : [],
      incremental: typeof rule?.incremental === "boolean" ? rule.incremental : null
    };
  }

  // src/content/render/styles.js
  var STYLE_ID = "itx-style";
  var CSS = `
:root {
  --itx-accent: #3b82f6;
  --itx-bg: rgba(59, 130, 246, 0.07);
  --itx-text: #1f2937;
  --itx-muted: #6b7280;
  --itx-error: #dc2626;
}

/* \u8DDF\u968F\u5BBF\u4E3B\u9875\u9762\u7684\u660E\u6697\uFF0C\u800C\u4E0D\u662F\u64CD\u4F5C\u7CFB\u7EDF \u2014\u2014 \u7531 theme.js \u63A2\u6D4B\u540E\u5199\u5165 */
html[data-itx-theme="dark"] {
  --itx-text: #e5e7eb;
  --itx-muted: #9ca3af;
  --itx-bg: rgba(96, 165, 250, 0.16);
  --itx-error: #f87171;
}

/*
 * \u5BBF\u4E3B\u9875\u9762\u7684\u6837\u5F0F\u4F1A\u62A2\u5728\u6211\u4EEC\u524D\u9762\u628A\u8BD1\u6587\u85CF\u8D77\u6765\uFF0C\u6240\u4EE5\u300C\u53EF\u89C1\u6027\u300D\u76F8\u5173\u7684\u5C5E\u6027\u4E00\u5F8B\u5E26 !important\u3002
 *
 * \u771F\u5B9E\u6848\u4F8B\uFF08China Daily \u9996\u9875\uFF09\uFF1A\u7AD9\u70B9\u6709\u300C#topNav div { display: none }\u300D\uFF0C
 * \u7279\u5F02\u6027 (1,0,1) \u538B\u8FC7\u6211\u4EEC\u7684\u300C[data-itx="trans"]\u300D(0,1,0)\uFF0C\u4E8E\u662F\u53F3\u4FA7 "Top Views"
 * \u680F\u91CC\u7684\u8BD1\u6587\u8282\u70B9\u5168\u88AB display:none \u2014\u2014 \u8BC6\u522B\u548C\u7FFB\u8BD1\u90FD\u6210\u529F\uFF0C\u7528\u6237\u5374\u4EC0\u4E48\u4E5F\u770B\u4E0D\u5230\u3002
 * \u7AD9\u70B9\u81EA\u5DF1\u7528 !important \u9690\u85CF\u7684\u4E1C\u897F\u6211\u4EEC\u4ECD\u7136\u8BA9\u4F4D\uFF08\u90A3\u662F\u5B83\u6709\u610F\u4E3A\u4E4B\uFF09\u3002
 *
 * \u53EA\u7ED9\u53EF\u89C1\u6027\u5C5E\u6027\u52A0 !important\uFF1A\u5B57\u4F53\u3001\u989C\u8272\u3001\u8FB9\u8DDD\u8FD9\u4E9B\u4ECD\u7136\u53EF\u4EE5\u88AB\u7AD9\u70B9\u5408\u7406\u5F71\u54CD\u3002
 */
html[data-itx-state="hidden"] [data-itx="trans"] { display: none !important; }
html[data-itx-state="showing"] [data-itx="progress"] { display: flex !important; }
html[data-itx-state="done"] [data-itx="progress"] { display: none !important; }

[data-itx="trans"] {
  display: block !important;
  contain: content;
  margin: 0.45em 0 1em 0;
  padding: 0.4em 0 0.4em 0.75em;
  border-left: 2px solid var(--itx-accent);
  background: var(--itx-bg);
  color: var(--itx-text);
  font-size: 0.96em;
  line-height: 1.62;
  font-style: normal;
  text-align: left;
  white-space: normal;
  word-break: normal;
  overflow-wrap: break-word;
}

/*
 * \u8BD1\u6587\u88AB\u632A\u51FA\u4E86\u88AB\u9650\u9AD8\u7684\u5BBF\u4E3B\u5BB9\u5668\uFF08\u89C1 inject.js \u7684 findClippedAncestor\uFF09\u3002
 * \u6B64\u65F6\u5B83\u7D27\u8DDF\u5728\u5361\u7247/\u6761\u76EE\u4E4B\u540E\uFF0C\u6700\u6015\u81EA\u5DF1\u592A\u5360\u5730\u65B9\u628A\u4E0B\u4E00\u884C\u6324\u8D70 \u2014\u2014
 * \u6362\u6210\u7D27\u51D1\u6837\u5F0F\uFF1A\u4E0D\u94FA\u5E95\u8272\u3001\u53BB\u6389\u591A\u4F59\u4E0A\u4E0B\u7559\u767D\uFF0C\u53EA\u7559\u90A3\u6761\u84DD\u8272\u7AD6\u7EBF\u505A\u6807\u8BB0\u3002
 */
[data-itx="trans"][data-itx-in="clipped-host"] {
  margin: 0 0 0.35em 0;
  padding: 0 0 0 0.5em;
  background: transparent;
  font-size: 0.9em;
  line-height: 1.4;
}

[data-itx="trans"][data-itx-pending] { color: var(--itx-muted); }

[data-itx="trans"][data-itx-error] {
  border-left-color: var(--itx-error);
  color: var(--itx-error);
  background: rgba(220, 38, 38, 0.06);
}

[data-itx="toast"] {
  /* \u540C\u6837\u662F\u300C\u53EF\u89C1\u6027\u5C5E\u6027\u5E26 !important\u300D\uFF1Atoast \u88AB\u7AD9\u70B9\u6837\u5F0F\u85CF\u8D77\u6765\u7684\u8BDD\uFF0C
     \u7528\u6237\u5C31\u5B8C\u5168\u770B\u4E0D\u5230\u5931\u8D25\u539F\u56E0\u4E86\uFF0C\u90A3\u6BD4\u7FFB\u4E0D\u51FA\u6765\u66F4\u7CDF */
  position: fixed !important;
  top: 16px !important;
  right: 16px !important;
  left: auto !important;
  bottom: auto !important;
  display: block !important;
  visibility: visible !important;
  z-index: 2147483000 !important;
  max-width: 300px;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(17, 24, 39, 0.93);
  color: #f9fafb;
  font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.22);
  opacity: 0;
  transform: translateY(-6px);
  transition: opacity 0.18s ease, transform 0.18s ease;
  pointer-events: none;
}

[data-itx="toast"][data-itx-visible] {
  opacity: 1;
  transform: translateY(0);
}

[data-itx="toast"][data-itx-error] { background: rgba(153, 27, 27, 0.95); }

/* \u52A8\u4F5C\u6309\u94AE\uFF1Atoast \u6574\u4F53\u662F pointer-events:none\uFF0C\u6309\u94AE\u5FC5\u987B\u5355\u72EC\u6253\u5F00\uFF0C
   \u5426\u5219\u300C\u91CD\u65B0\u7FFB\u8BD1\u300D\u6C38\u8FDC\u70B9\u4E0D\u5230 */
[data-itx="action"] {
  display: block !important;
  visibility: visible !important;
  margin-top: 8px;
  padding: 4px 10px;
  border: 1px solid rgba(147, 197, 253, 0.8);
  border-radius: 5px;
  background: rgba(59, 130, 246, 0.22);
  color: #dbeafe;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  pointer-events: auto;
}

[data-itx="action"]:hover { background: rgba(59, 130, 246, 0.42); }

[data-itx="action"][hidden] { display: none !important; }

[data-itx="progress"] {
  display: none;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  color: #d1d5db;
  font-size: 12px;
}

[data-itx="progress"]::before {
  content: "";
  width: 10px;
  height: 10px;
  border: 2px solid rgba(209, 213, 219, 0.35);
  border-top-color: #93c5fd;
  border-radius: 50%;
  animation: itx-spin 0.7s linear infinite;
}

@keyframes itx-spin { to { transform: rotate(360deg); } }
`;
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  // src/content/render/theme.js
  function parseColor(input) {
    const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/i.exec(
      input || ""
    );
    if (!match) return null;
    return {
      r: Number(match[1]),
      g: Number(match[2]),
      b: Number(match[3]),
      a: match[4] === void 0 ? 1 : Number(match[4])
    };
  }
  function luminance({ r, g, b }) {
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }
  function effectiveBackground(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      const color = parseColor(getComputedStyle(node).backgroundColor);
      if (color && color.a > 0.5) return color;
      node = node.parentElement;
    }
    return null;
  }
  function detectPageTheme() {
    for (const el of [document.documentElement, document.body].filter(Boolean)) {
      const bg = effectiveBackground(el);
      if (bg) return luminance(bg) < 0.45 ? "dark" : "light";
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function applyPageTheme() {
    const theme = detectPageTheme();
    document.documentElement.setAttribute("data-itx-theme", theme);
    return theme;
  }

  // src/content/render/inject.js
  var CLAMP_MAX_DEPTH = 6;
  var CLAMP_MAX_HEIGHT = 200;
  function findClippedAncestor(el) {
    let node = el && el.parentElement;
    let depth = 0;
    while (node && depth < CLAMP_MAX_DEPTH) {
      if (node.nodeType === 1) {
        const style = typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
        const overflow = style ? `${style.overflowY} ${style.overflow}` : "";
        const clipped = /hidden|clip/.test(overflow);
        const height = style ? parseFloat(style.height) : NaN;
        if (clipped && Number.isFinite(height) && height > 0 && height <= CLAMP_MAX_HEIGHT) return node;
      }
      node = node.parentElement;
      depth += 1;
    }
    return null;
  }
  function setState(state) {
    document.documentElement.setAttribute("data-itx-state", state);
  }
  function makeNode(unit, hash) {
    const node = document.createElement("div");
    node.setAttribute("data-itx", "trans");
    node.setAttribute("data-itx-src", hash);
    node.setAttribute("dir", "auto");
    if (unit.inCell) node.style.display = "block";
    return node;
  }
  function escapeAttrValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
  function findTranslationNode(hash) {
    if (!hash) return null;
    return document.querySelector(`[data-itx="trans"][data-itx-src="${escapeAttrValue(hash)}"]`);
  }
  function injectTranslation(unit, translation, hash, { force = false } = {}) {
    const existing = unit.node?.isConnected ? unit.node : findTranslationNode(hash);
    const fresh = !!existing && existing.getAttribute("data-itx-src") === hash && !existing.hasAttribute("data-itx-error");
    const ours = !!existing && isAnchoredTo(unit, existing);
    if (ours) {
      if (fresh && !force) {
        unit.node = existing;
        unit.translated = true;
        unit.failed = false;
        return "skipped";
      }
      existing.setAttribute("data-itx-src", hash);
      existing.textContent = translation;
      existing.removeAttribute("data-itx-pending");
      existing.removeAttribute("data-itx-error");
      unit.node = existing;
      unit.translated = true;
      unit.failed = false;
      return "updated";
    }
    const node = makeNode(unit, hash);
    node.textContent = translation;
    insertNode(unit, node);
    unit.node = node;
    unit.translated = true;
    unit.failed = false;
    return "created";
  }
  function isAnchoredTo(unit, node) {
    if (unit.inCell) return node.parentElement === unit.el;
    const clipped = findClippedAncestor(unit.el);
    if (clipped) return node.previousElementSibling === clipped;
    return unit.el.nextElementSibling === node;
  }
  function insertNode(unit, node) {
    if (unit.inCell) {
      unit.el.appendChild(node);
      return;
    }
    const clipped = findClippedAncestor(unit.el);
    if (clipped) {
      clipped.insertAdjacentElement("afterend", node);
      node.setAttribute("data-itx-in", "clipped-host");
      return;
    }
    unit.el.insertAdjacentElement("afterend", node);
  }
  function injectError(unit, message) {
    if (!unit.node || !unit.node.isConnected) {
      const node = makeNode(unit, unit.hash || "error");
      insertNode(unit, node);
      unit.node = node;
    }
    if (unit.hash) unit.node.setAttribute("data-itx-src", unit.hash);
    unit.translated = false;
    unit.node.textContent = `\u7FFB\u8BD1\u5931\u8D25\uFF1A${message}\uFF08\u539F\u6587\u4FDD\u7559\uFF09`;
    unit.node.setAttribute("data-itx-error", "");
    unit.node.removeAttribute("data-itx-pending");
    unit.failed = true;
  }
  function countInjected() {
    return document.querySelectorAll('[data-itx="trans"]').length;
  }
  function countTranslated() {
    return document.querySelectorAll('[data-itx="trans"]:not([data-itx-error])').length;
  }
  function removeTranslationsOutsideRules(rules) {
    if (!rules || !rules.exclude?.length && !rules.include?.length) return 0;
    let removed = 0;
    for (const node of document.querySelectorAll('[data-itx="trans"]')) {
      const owner = translationOwner(node);
      if (!owner) continue;
      if (!isAllowedByRules(owner, rules)) {
        node.remove();
        removed += 1;
      }
    }
    return removed;
  }
  function translationOwner(node) {
    const parent = node.parentElement;
    if (!parent) return null;
    if (/^(TD|TH)$/.test(parent.tagName)) return parent;
    if (node.getAttribute("data-itx-in") === "clipped-host") {
      let prev = node.previousElementSibling;
      while (prev && prev.hasAttribute("data-itx")) prev = prev.previousElementSibling;
      return prev;
    }
    return node.previousElementSibling;
  }

  // src/content/render/toast.js
  var toastEl = null;
  var hideTimer = null;
  var progressEl = null;
  var textEl = null;
  var actionEl = null;
  function ensureToast() {
    if (toastEl && toastEl.isConnected) return toastEl;
    toastEl = document.createElement("div");
    toastEl.setAttribute("data-itx", "toast");
    textEl = document.createElement("div");
    textEl.setAttribute("data-itx", "text");
    progressEl = document.createElement("div");
    progressEl.setAttribute("data-itx", "progress");
    actionEl = document.createElement("button");
    actionEl.setAttribute("data-itx", "action");
    actionEl.type = "button";
    actionEl.hidden = true;
    toastEl.append(textEl, progressEl, actionEl);
    document.body.appendChild(toastEl);
    return toastEl;
  }
  function showToast(message, { error = false, progress = null, action = null, duration } = {}) {
    const el = ensureToast();
    clearTimeout(hideTimer);
    textEl.textContent = message;
    el.toggleAttribute("data-itx-error", Boolean(error));
    el.setAttribute("data-itx-visible", "");
    if (progress) {
      progressEl.textContent = progress;
      document.documentElement.setAttribute("data-itx-state", "showing");
    } else {
      progressEl.textContent = "";
      if (document.documentElement.getAttribute("data-itx-state") === "showing") {
        document.documentElement.setAttribute("data-itx-state", "done");
      }
    }
    if (action && typeof action.onClick === "function") {
      actionEl.hidden = false;
      actionEl.textContent = action.label;
      actionEl.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        hideToast();
        try {
          action.onClick();
        } catch (err) {
          console.warn("[itx] toast \u52A8\u4F5C\u6267\u884C\u5931\u8D25", err);
        }
      };
    } else {
      actionEl.hidden = true;
      actionEl.textContent = "";
      actionEl.onclick = null;
    }
    const fallback = action ? 9e3 : error ? 4e3 : 1800;
    const stay = typeof duration === "number" ? duration : fallback;
    hideTimer = setTimeout(hideToast, stay);
  }
  function hideToast() {
    clearTimeout(hideTimer);
    ensureToast().removeAttribute("data-itx-visible");
  }

  // src/content/index.js
  var IS_TOP = window.top === window.self;
  var KEY_TRANSLATE = formatShortcut("Alt+T");
  var mounted = false;
  var phase = "idle";
  var allUnits = [];
  var run = null;
  var incrementalRun = null;
  var incremental = null;
  var activeProvider = null;
  var activeSettings = null;
  var lastProgressAt = 0;
  var pendingConfigGuide = false;
  var pendingConfigReason = null;
  var lastRateNotice = null;
  var preparePromise = null;
  var incrementalCount = 0;
  var prepareCancelRequested = false;
  var builtinBlocked = null;
  var BUILTIN_BLOCK_TTL_MS = 6 * 60 * 60 * 1e3;
  var builtinIssueHydrated = false;
  function reportBuiltinIssue(issue) {
    chrome.runtime.sendMessage({ type: MSG.BUILTIN_STATE, issue }).catch(() => {
    });
  }
  function clearBuiltinIssue() {
    chrome.runtime.sendMessage({ type: MSG.BUILTIN_STATE, clear: true }).catch(() => {
    });
  }
  var PREPARE_NOTICE_DELAY_MS = 400;
  var activeFallback = null;
  var translatedSignature = null;
  var translatedRules = null;
  var repeatFailures = /* @__PURE__ */ new Map();
  var REPEAT_FAILURE_LIMIT = 2;
  function looksEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    return /^(input|textarea|select)$/i.test(el.tagName);
  }
  function openOptions(reason = null) {
    chrome.runtime.sendMessage({ type: MSG.STATUS, action: "open-options", reason }).catch(() => {
    });
  }
  function batchLimits(provider, settings) {
    const declared = provider.batch ?? {};
    return {
      maxSegments: Math.min(declared.maxSegments ?? 1, settings.batchMaxSegments ?? 16),
      maxChars: Math.min(declared.maxChars ?? Number.POSITIVE_INFINITY, settings.batchMaxChars ?? 4e3)
    };
  }
  function engineSignature(provider, settings) {
    let scope = "";
    try {
      scope = provider.cacheScope?.(settings.providers?.[provider.id] ?? {}, settings) ?? "";
    } catch {
      scope = "";
    }
    return `${provider.id}|${settings.from}|${settings.to}|${scope}`;
  }
  function makeTransport(provider, settings) {
    if (provider.host === "content") {
      return async (texts) => {
        const list = await provider.translateBatch(texts, settings);
        return list.map(
          (translation) => typeof translation === "string" && translation.length ? { ok: true, translation } : { ok: false, error: "\u7FFB\u8BD1\u7ED3\u679C\u4E3A\u7A7A" }
        );
      };
    }
    return async (texts) => {
      const response = await chrome.runtime.sendMessage({ type: MSG.TRANSLATE, texts });
      if (!response) throw new Error("\u540E\u53F0\u65E0\u54CD\u5E94");
      if (!response.ok) throw new Error(response.error || "\u7FFB\u8BD1\u5931\u8D25");
      return response.items;
    };
  }
  function ownText(el) {
    let out = "";
    for (const node of el.childNodes) {
      if (node.nodeType === 3) out += node.data;
      else if (node.nodeType === 1 && !node.hasAttribute("data-itx")) out += ownText(node);
    }
    return out.trim();
  }
  function pageSample() {
    const minAnchorLength = linkMinTextLength({});
    for (const el of document.querySelectorAll("p, li, td, h1, h2, article, a[href]")) {
      if (el.closest("[data-itx]")) continue;
      if (el.tagName === "A") {
        if (isNoiseLink(el)) continue;
        if (!isTranslatable(ownText(el), { minTextLength: minAnchorLength }).ok) continue;
      }
      const text = ownText(el);
      if (text.length >= 12) return text.slice(0, 200);
    }
    return (document.title || "").slice(0, 200);
  }
  function kickoffPrepare() {
    const config = cachedConfig();
    if (!config || config.engine?.host !== "content") {
      preparePromise = null;
      return null;
    }
    const provider = getProvider(config.engine.id);
    if (typeof provider?.prepare !== "function") return null;
    prepareCancelRequested = false;
    preparePromise = provider.prepare(config.settings, {
      sampleText: pageSample(),
      shouldCancel: () => prepareCancelRequested,
      onProgress(percent) {
        showToast(`\u6B63\u5728\u4E0B\u8F7D\u5185\u7F6E AI \u8BED\u8A00\u5305\uFF08\u4EC5\u9996\u6B21\u9700\u8981\uFF09\u2026 ${percent}%`, {
          progress: "\u4E0B\u8F7D\u4E2D",
          action: { label: "\u53D6\u6D88\uFF0C\u6539\u7528\u5176\u4ED6\u5F15\u64CE", onClick: cancelPrepare },
          duration: 12e4
        });
      }
    }).catch((err) => err);
    return preparePromise;
  }
  function cancelPrepare() {
    prepareCancelRequested = true;
  }
  async function ensurePrepared(provider, settings) {
    if (typeof provider.prepare !== "function") return { ok: true };
    prepareCancelRequested = false;
    const notice = setTimeout(() => {
      showToast(`\u6B63\u5728\u51C6\u5907\u300C${provider.label}\u300D\u2026\u9996\u6B21\u4F7F\u7528\u9700\u8981\u4E0B\u8F7D\u8BED\u8A00\u5305`, {
        progress: "\u51C6\u5907\u4E2D",
        action: { label: "\u53D6\u6D88\uFF0C\u6539\u7528\u5176\u4ED6\u5F15\u64CE", onClick: cancelPrepare },
        duration: 12e4
      });
    }, PREPARE_NOTICE_DELAY_MS);
    const pending = preparePromise;
    preparePromise = null;
    try {
      if (pending) {
        const outcome = await pending;
        if (outcome instanceof Error) throw outcome;
      } else {
        await provider.prepare(settings, {
          sampleText: pageSample(),
          shouldCancel: () => prepareCancelRequested
        });
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: err?.message || "\u5185\u7F6E AI \u4E0D\u53EF\u7528",
        code: err?.code,
        cancelled: err?.code === "builtin-cancelled"
      };
    } finally {
      clearTimeout(notice);
    }
  }
  var pendingDownloadOffer = null;
  var currentDownloadTarget = null;
  function offerLanguagePackDownload(message, { retry = false } = {}) {
    const start = () => {
      const active = currentDownloadTarget;
      if (!active) return;
      prepareCancelRequested = false;
      showToast("\u6B63\u5728\u8FDE\u63A5\u5185\u7F6E AI \u5E76\u51C6\u5907\u8BED\u8A00\u5305\u2026\u9996\u6B21\u8FDE\u63A5\u53EF\u80FD\u9700\u8981\u51E0\u79D2", {
        progress: "\u51C6\u5907\u4E2D",
        action: { label: "\u53D6\u6D88", onClick: cancelPrepare },
        duration: 12e4
      });
      const download = active.provider.prepare(active.settings, {
        sampleText: pageSample(),
        shouldCancel: () => prepareCancelRequested,
        onProgress(percent) {
          showToast(`\u6B63\u5728\u4E0B\u8F7D\u5185\u7F6E AI \u8BED\u8A00\u5305\uFF08\u4EC5\u9996\u6B21\u9700\u8981\uFF09\u2026 ${percent}%`, {
            progress: "\u4E0B\u8F7D\u4E2D",
            action: { label: "\u53D6\u6D88", onClick: cancelPrepare },
            duration: 12e4
          });
        }
      }).then(
        (value) => value,
        (err) => err
      );
      download.then((outcome) => {
        if (outcome instanceof Error) {
          showToast(`\u5185\u7F6E AI \u51C6\u5907\u5931\u8D25\uFF1A${outcome.message}`, { error: true, duration: 8e3 });
          return;
        }
        builtinBlocked = null;
        clearBuiltinIssue();
        showToast("\u8BED\u8A00\u5305\u5DF2\u5C31\u7EEA\uFF0C\u6B63\u5728\u7528\u5185\u7F6E AI \u91CD\u65B0\u7FFB\u8BD1\u2026");
        translatePage({ force: true });
      });
    };
    showToast(message, {
      error: true,
      action: { label: retry ? "\u91CD\u8BD5\u4E0B\u8F7D\u8BED\u8A00\u5305" : "\u4E0B\u8F7D\u8BED\u8A00\u5305", onClick: start },
      duration: 3e4
    });
  }
  function makeGroupResultHandler(force) {
    return (group, result) => {
      if (result?.ok) {
        for (const unit of group.units) {
          injectTranslation(unit, result.translation, group.hash, { force });
        }
        repeatFailures.delete(group.hash);
        return;
      }
      if (result?.needConfig) {
        pendingConfigGuide = true;
        pendingConfigReason = result.error || null;
      }
      if (result?.rateNotice) lastRateNotice = result.rateNotice;
      repeatFailures.set(group.hash, (repeatFailures.get(group.hash) ?? 0) + 1);
      for (const unit of group.units) injectError(unit, result?.error || "\u672A\u77E5\u9519\u8BEF");
    };
  }
  function stuckFailureCount() {
    let n = 0;
    for (const unit of allUnits) {
      if (unit.failed && (repeatFailures.get(unit.hash) ?? 0) >= REPEAT_FAILURE_LIMIT) n += 1;
    }
    return n;
  }
  function onProgress(done, total) {
    const now = Date.now();
    if (now - lastProgressAt < 250 && done !== total) return;
    lastProgressAt = now;
    if (lastRateNotice) {
      showToast(lastRateNotice, { progress: `${done}/${total} \u6BB5` });
      return;
    }
    showToast(`\u7FFB\u8BD1\u4E2D\u2026 ${done}/${total}`, { progress: `${done}/${total} \u6BB5` });
  }
  async function sendRule(payload) {
    try {
      return await chrome.runtime.sendMessage({ type: MSG.SITE_RULE, ...payload });
    } catch {
      return null;
    }
  }
  async function addRuleFromSelection(kind) {
    const target = resolveSelectionTarget(window);
    if (!target) return { ok: false, reason: "\u8BF7\u5148\u5728\u9875\u9762\u4E0A\u9009\u4E2D\u4E00\u6BB5\u6587\u5B57\uFF0C\u518D\u70B9\u8FD9\u4E2A\u6309\u94AE" };
    const selector = buildSelector(target);
    if (!selector || !selectorHits(document, selector, target)) {
      return { ok: false, reason: "\u8FD9\u4E00\u5757\u6CA1\u6CD5\u751F\u6210\u7A33\u5B9A\u7684\u9009\u62E9\u5668\uFF0C\u6362\u4E00\u4E2A\u66F4\u89C4\u6574\u7684\u533A\u57DF\u518D\u8BD5" };
    }
    const response = await sendRule({
      host: location.hostname,
      action: kind === "exclude" ? "add-exclude" : "set-include",
      selector
    });
    if (!response?.ok) return { ok: false, reason: response?.error || "\u4FDD\u5B58\u89C4\u5219\u5931\u8D25" };
    invalidateConfig();
    const fresh = await loadConfig({ force: true });
    const removed = removeTranslationsOutsideRules(siteRule(fresh));
    showToast(
      kind === "exclude" ? `\u5DF2\u6392\u9664\u8BE5\u533A\u57DF${removed ? `\uFF0C\u5DF2\u79FB\u9664\u5176\u4E2D ${removed} \u6761\u8BD1\u6587` : ""}` : `\u5DF2\u8BBE\u4E3A\u53EA\u7FFB\u8BD1\u8BE5\u533A\u57DF${removed ? `\uFF0C\u533A\u57DF\u5916\u7684 ${removed} \u6761\u8BD1\u6587\u5DF2\u79FB\u9664` : ""}\u3002\u6309 ${KEY_TRANSLATE} \u7FFB\u8BD1\u8FD9\u4E00\u5757`,
      { duration: 7e3 }
    );
    return { ok: true, selector, rule: response.rule, removed };
  }
  async function clearSiteRuleForHost() {
    const response = await sendRule({ host: location.hostname, action: "clear" });
    invalidateConfig();
    if (!response?.ok) {
      showToast("\u6E05\u9664\u672C\u7AD9\u89C4\u5219\u5931\u8D25", { error: true });
      return { ok: false };
    }
    showToast("\u5DF2\u6E05\u9664\u672C\u7AD9\u7684\u5168\u90E8\u89C4\u5219");
    return { ok: true };
  }
  async function toggleSiteIncremental() {
    const config = await loadConfig({ force: true });
    const rule = siteRule(config);
    const effective = rule.incremental === null ? Boolean(config?.settings?.incremental) : rule.incremental;
    const next = !effective;
    const response = await sendRule({
      host: location.hostname,
      action: "set-incremental",
      value: next
    });
    invalidateConfig();
    if (!response?.ok) {
      showToast("\u4FDD\u5B58\u5931\u8D25", { error: true });
      return { ok: false };
    }
    const fresh = await loadConfig({ force: true });
    if (next) {
      startIncremental(fresh);
      showToast("\u672C\u7AD9\u5DF2\u5F00\u542F\uFF1A\u81EA\u52A8\u7FFB\u8BD1\u65B0\u589E\u5185\u5BB9");
    } else {
      stopIncremental();
      showToast("\u672C\u7AD9\u5DF2\u5173\u95ED\uFF1A\u4E0D\u518D\u81EA\u52A8\u7FFB\u8BD1\u65B0\u589E\u5185\u5BB9");
    }
    return { ok: true, value: next };
  }
  function stopIncremental() {
    incremental?.stop();
    incremental = null;
    incrementalRun?.abort();
    incrementalRun = null;
    incrementalCount = 0;
  }
  function startIncremental(config) {
    if (!config?.settings?.incremental) return;
    const rule = siteRule(config);
    if (rule.incremental === false) return;
    if (incremental) return;
    incremental = createIncremental({
      root: document.body,
      options: { minTextLength: config.settings.minTextLength, rules: rule },
      isBlocked: () => phase === "working",
      debounceMs: config.settings.incrementalDebounceMs,
      maxPerMinute: config.settings.incrementalMaxPerMinute,
      onUnits: (units) => {
        queueIncremental(units, config).catch((err) => console.warn("[itx] \u589E\u91CF\u7FFB\u8BD1\u5931\u8D25", err));
      },
      onOverflow: () => {
        showToast(`\u65B0\u589E\u5185\u5BB9\u592A\u591A\uFF0C\u5DF2\u6682\u505C\u81EA\u52A8\u7FFB\u8BD1\u3002\u6309 ${KEY_TRANSLATE} \u53EF\u4EE5\u7EE7\u7EED`, {
          error: true,
          duration: 7e3
        });
      }
    });
    incremental.start();
  }
  async function queueIncremental(units, config) {
    const provider = activeProvider;
    const settings = activeSettings ?? config?.settings;
    if (!provider || !settings) return;
    const claimedNodes = /* @__PURE__ */ new Set();
    const groups = /* @__PURE__ */ new Map();
    for (const unit of units) {
      const hash = await hashText(unit.text);
      unit.hash = hash;
      const existing = claimExistingTranslation(unit, hash, claimedNodes);
      if (existing) {
        unit.node = existing;
        unit.translated = true;
        claimedNodes.add(existing);
        continue;
      }
      if (!groups.has(hash)) groups.set(hash, { hash, text: unit.text, units: [] });
      groups.get(hash).units.push(unit);
    }
    const pending = Array.from(groups.values()).filter(
      (group) => group.units.some((unit) => !unit.translated)
    );
    if (!pending.length) return;
    allUnits.push(...units);
    if (!incrementalRun) {
      incrementalRun = createRun({
        translate: makeTransport(provider, settings),
        concurrency: provider.host === "content" ? 1 : Math.max(1, Math.min(6, settings.concurrency ?? 3)),
        intervalMs: provider.host === "content" ? 0 : settings.requestIntervalMs ?? 120,
        onGroupResult: makeGroupResultHandler(false),
        onProgress: (done, total) => {
          if (total > 1) showToast(`\u5DF2\u7FFB\u8BD1\u65B0\u589E\u5185\u5BB9\u2026 ${done}/${total}`, { progress: "\u589E\u91CF" });
        }
      });
    }
    incrementalRun.push(
      planBatches(pending, batchLimits(provider, settings)).map((batch) => ({ groups: batch }))
    );
    incrementalCount += pending.length;
    await incrementalRun.whenIdle();
    setState(document.documentElement.getAttribute("data-itx-state") === "hidden" ? "hidden" : "done");
    const failed = pending.reduce(
      (sum, group) => sum + group.units.filter((unit) => unit.failed).length,
      0
    );
    showToast(
      failed ? `\u65B0\u589E\u5185\u5BB9\u5DF2\u7FFB\u8BD1 ${incrementalCount} \u6BB5\uFF0C${failed} \u6BB5\u5931\u8D25` : `\u5DF2\u81EA\u52A8\u7FFB\u8BD1\u65B0\u589E\u5185\u5BB9 ${pending.length} \u6BB5`,
      { error: failed > 0 }
    );
  }
  async function stopTranslation(reason = "\u5DF2\u505C\u6B62\u7FFB\u8BD1") {
    stopIncremental();
    if (run) {
      run.abort();
      run = null;
    }
    phase = "done";
    setState("done");
    showToast(reason);
  }
  async function reportFinish(forcedWith = null) {
    const injected = countTranslated();
    const failed = allUnits.filter((u) => u.failed).length;
    const fallbackNote = activeFallback ? `\uFF08${activeFallback.reason}\uFF0C\u672C\u6B21\u6539\u7528\u300C${activeFallback.to}\u300D\uFF09` : "";
    let summary;
    if (injected === 0 && failed === 0) {
      summary = `\u8FD9\u4E00\u9875\u6CA1\u627E\u5230\u9002\u5408\u7FFB\u8BD1\u7684\u6B63\u6587${fallbackNote}`;
    } else if (failed > 0) {
      summary = `\u5DF2\u7FFB\u8BD1 ${injected} \u6BB5\uFF0C${failed} \u6BB5\u5931\u8D25${fallbackNote}`;
    } else if (forcedWith) {
      summary = `\u5DF2\u7528\u300C${forcedWith}\u300D\u91CD\u65B0\u7FFB\u8BD1 ${injected} \u6BB5${fallbackNote}`;
    } else {
      summary = `\u5DF2\u7FFB\u8BD1 ${injected} \u6BB5\uFF0C\u6309 ${KEY_TRANSLATE} \u53EF\u9690\u85CF${fallbackNote}`;
    }
    if (pendingDownloadOffer) {
      const offer = pendingDownloadOffer;
      pendingDownloadOffer = null;
      offerLanguagePackDownload(`${summary}\uFF1B\u60F3\u6539\u7528\u514D\u8D39\u7684\u5185\u7F6E AI \u5C31\u70B9\u4E0B\u9762\u6309\u94AE`, offer);
    } else if (failed > 0) {
      const advice = stuckFailureCount() > 0 ? "\uFF1B\u90E8\u5206\u6BB5\u843D\u591A\u6B21\u5931\u8D25\uFF0C\u53EF\u7EE7\u7EED\u91CD\u8BD5\uFF0C\u4E5F\u53EF\u5728\u8BBE\u7F6E\u4E2D\u6362\u5F15\u64CE" : "";
      showToast(summary + advice, {
        error: true,
        action: { label: `\u91CD\u8BD5\u5931\u8D25\u7684 ${failed} \u6BB5`, onClick: () => translatePage({ force: false }) },
        duration: 12e3
      });
    } else {
      showToast(summary, { error: injected === 0 });
    }
    if (pendingConfigGuide) {
      pendingConfigGuide = false;
      openOptions(pendingConfigReason || "\u5F53\u524D\u5F15\u64CE\u7684\u914D\u7F6E\u6709\u95EE\u9898");
    }
  }
  function claimExistingTranslation(unit, hash, claimed) {
    const local = unit.el?.nextElementSibling;
    if (local && local.getAttribute("data-itx") === "trans" && !claimed.has(local)) return local;
    for (const node of document.querySelectorAll('[data-itx="trans"]')) {
      if (claimed.has(node)) continue;
      if (node.getAttribute("data-itx-src") === hash) return node;
    }
    return null;
  }
  async function translatePage({ force = false, toggleExisting = false } = {}) {
    if (phase === "working") {
      await stopTranslation();
      if (toggleExisting) {
        setState("hidden");
        hideToast();
      }
      return;
    }
    const config = await loadConfig({ force: true });
    if (!config) {
      showToast("\u6269\u5C55\u540E\u53F0\u6CA1\u6709\u54CD\u5E94\uFF0C\u8BF7\u5230\u6269\u5C55\u7BA1\u7406\u9875\u5237\u65B0\u4E00\u6B21\u6269\u5C55", { error: true });
      return;
    }
    const settings = config.settings;
    let provider = getProvider(config.engine.id);
    if (!provider) {
      showToast(`\u672A\u77E5\u7684\u7FFB\u8BD1\u670D\u52A1\uFF1A${config.engine.id}`, { error: true });
      return;
    }
    if (provider.host === "network" && !config.engine.ready) {
      const reason = `\u300C${config.engine.label}\u300D\u8FD8\u6CA1\u914D\u7F6E\u597D\uFF08\u7F3A\u5C11\u5BC6\u94A5\uFF09`;
      showToast(`${reason}\uFF0C\u5DF2\u6253\u5F00\u8BBE\u7F6E\u9875`, { error: true });
      openOptions(reason);
      return;
    }
    const signature = engineSignature(provider, settings);
    const shouldForce = force || translatedSignature !== null && translatedSignature !== signature;
    const rulesSignature = JSON.stringify(siteRule(config));
    if (toggleExisting && !shouldForce && translatedRules === rulesSignature && countTranslated() > 0) {
      toggleVisibility();
      return;
    }
    translatedRules = rulesSignature;
    injectStyles();
    applyPageTheme();
    const rules = siteRule(config);
    removeTranslationsOutsideRules(rules);
    setState("hidden");
    for (const node of document.querySelectorAll('[data-itx="trans"][data-itx-error]')) node.remove();
    allUnits = sortByDocumentOrder(
      collectUnits(document.body, {
        minTextLength: settings.minTextLength,
        rules
      })
    );
    const claimedNodes = /* @__PURE__ */ new Set();
    const groups = /* @__PURE__ */ new Map();
    for (const unit of allUnits) {
      const hash = await hashText(unit.text);
      unit.hash = hash;
      if (!shouldForce) {
        const existing = claimExistingTranslation(unit, hash, claimedNodes);
        if (existing) {
          unit.node = existing;
          unit.translated = true;
          unit.failed = existing.hasAttribute("data-itx-error");
          if (unit.failed) {
            existing.remove();
            unit.node = null;
            unit.translated = false;
            claimedNodes.delete(existing);
          } else {
            claimedNodes.add(existing);
          }
        }
      }
      if (!groups.has(hash)) groups.set(hash, { hash, text: unit.text, units: [] });
      groups.get(hash).units.push(unit);
    }
    const pending = Array.from(groups.values()).filter(
      (group) => group.units.some((unit) => !unit.translated)
    );
    if (pending.length === 0) {
      phase = "done";
      translatedSignature = signature;
      setState(countInjected() > 0 ? "shown" : "hidden");
      showToast(countInjected() > 0 ? "\u8FD9\u4E00\u9875\u5DF2\u7ECF\u7FFB\u8BD1\u8FC7\u4E86" : "\u8FD9\u4E00\u9875\u6CA1\u6709\u9700\u8981\u7FFB\u8BD1\u7684\u5185\u5BB9");
      startIncremental(config);
      return;
    }
    activeFallback = null;
    if (provider.host === "content") {
      if (!builtinIssueHydrated) {
        builtinIssueHydrated = true;
        const persisted = config.builtinIssue;
        if (persisted && persisted.engineId === provider.id && Date.now() - (persisted.at ?? 0) < BUILTIN_BLOCK_TTL_MS && !builtinBlocked) {
          builtinBlocked = persisted;
        }
      }
      const blocked = builtinBlocked && builtinBlocked.engineId === provider.id && Date.now() - builtinBlocked.at < BUILTIN_BLOCK_TTL_MS ? builtinBlocked : null;
      let reason = blocked?.reason ?? null;
      let ready = false;
      let failureCode = null;
      if (blocked) {
        console.info("[itx] \u521A\u5931\u8D25\u8FC7\uFF0C\u672C\u6B21\u76F4\u63A5\u7528\u56DE\u843D\u5F15\u64CE\uFF1A", blocked.reason);
        failureCode = blocked.code;
      } else {
        const described = await Promise.resolve().then(() => provider.describe(settings)).catch((err) => ({ available: false, reason: err?.message || "\u5185\u7F6E AI \u4E0D\u53EF\u7528" }));
        ready = described.available;
        reason = described.reason;
        if (ready) {
          const prepared = await ensurePrepared(provider, settings);
          ready = prepared.ok;
          if (!prepared.ok) {
            reason = prepared.reason;
            failureCode = prepared.code;
          }
        }
      }
      if (ready) {
        builtinBlocked = null;
        if (builtinIssueHydrated) clearBuiltinIssue();
      } else {
        builtinBlocked = { engineId: provider.id, reason, code: failureCode, at: Date.now() };
        reportBuiltinIssue(builtinBlocked);
        const fallback = config.fallback ? getProvider(config.fallback.id) : null;
        const fixable = failureCode === "NotAllowedError" || failureCode === "builtin-stall";
        if (fixable) {
          currentDownloadTarget = { provider, settings };
          pendingDownloadOffer = { retry: failureCode === "builtin-stall" };
          if (!fallback) {
            offerLanguagePackDownload(
              "\u5185\u7F6E AI \u7684\u8BED\u8A00\u5305\u8FD8\u6CA1\u4E0B\u8F7D\u3002\u70B9\u4E0B\u9762\u6309\u94AE\u5F00\u59CB\u4E0B\u8F7D\uFF08\u53EA\u6709\u7B2C\u4E00\u6B21\u9700\u8981\uFF0C\u4E4B\u540E\u4E00\u76F4\u53EF\u7528\uFF09",
              pendingDownloadOffer
            );
            pendingDownloadOffer = null;
            return;
          }
          activeFallback = { reason, to: fallback.label };
          provider = fallback;
        } else if (!fallback) {
          showToast(`${reason}\uFF1B\u4E5F\u6CA1\u6709\u53EF\u7528\u7684\u5907\u7528\u5F15\u64CE\uFF0C\u5DF2\u6253\u5F00\u8BBE\u7F6E\u9875`, { error: true, duration: 8e3 });
          openOptions(reason);
          return;
        } else {
          showToast(`${reason}\uFF0C\u672C\u6B21\u6539\u7528\u300C${fallback.label}\u300D`, { error: true, duration: 8e3 });
          activeFallback = { reason, to: fallback.label };
          provider = fallback;
        }
      }
    }
    activeProvider = provider;
    activeSettings = settings;
    stopIncremental();
    document.documentElement.setAttribute("data-itx-engine", provider.id);
    document.documentElement.toggleAttribute("data-itx-engine-fallback", Boolean(activeFallback));
    phase = "working";
    setState("showing");
    lastRateNotice = null;
    lastProgressAt = 0;
    showToast(`\u7FFB\u8BD1\u4E2D\u2026 0/${pending.length}`, { progress: "\u51C6\u5907\u4E2D" });
    const thisRun = createRun({
      translate: makeTransport(provider, settings),
      concurrency: provider.host === "content" ? 1 : Math.max(1, Math.min(6, settings.concurrency ?? 3)),
      intervalMs: provider.host === "content" ? 0 : settings.requestIntervalMs ?? 120,
      onGroupResult: makeGroupResultHandler(shouldForce),
      onProgress
    });
    run = thisRun;
    thisRun.push(
      planBatches(pending, batchLimits(provider, settings)).map((batch) => ({ groups: batch }))
    );
    await thisRun.whenIdle();
    if (run !== thisRun) return;
    run = null;
    phase = "done";
    translatedSignature = signature;
    setState("done");
    await reportFinish(shouldForce ? provider.label : null);
    startIncremental(config);
  }
  function toggleVisibility() {
    const current = document.documentElement.getAttribute("data-itx-state");
    const next = current === "hidden" ? "shown" : "hidden";
    setState(next);
    hideToast();
  }
  async function onEngineChanged(payload) {
    invalidateConfig();
    stopIncremental();
    builtinBlocked = null;
    clearBuiltinIssue();
    repeatFailures.clear();
    const label = payload?.label || "\u65B0\u7684\u7FFB\u8BD1\u5F15\u64CE";
    await loadConfig({ force: true });
    if (countInjected() === 0) {
      showToast(`\u7FFB\u8BD1\u5F15\u64CE\u5DF2\u5207\u6362\u4E3A\u300C${label}\u300D`);
      return;
    }
    showToast(`\u7FFB\u8BD1\u5F15\u64CE\u5DF2\u5207\u6362\u4E3A\u300C${label}\u300D\uFF0C\u5F53\u524D\u9875\u663E\u793A\u7684\u8FD8\u662F\u65E7\u5F15\u64CE\u7684\u8BD1\u6587`, {
      action: { label: `\u91CD\u65B0\u7FFB\u8BD1\uFF08${KEY_TRANSLATE}\uFF09`, onClick: () => translatePage({ force: true }) },
      duration: 15e3
    });
  }
  function fireAndForget(promise) {
    Promise.resolve(promise).catch((err) => console.warn("[itx] \u547D\u4EE4\u6267\u884C\u5931\u8D25", err));
    return null;
  }
  async function probeBuiltin() {
    const config = await loadConfig({ force: true });
    const settings = config?.settings ?? { to: "zh-CHS", from: "auto" };
    const provider = getProvider("builtin");
    const described = await Promise.resolve().then(() => provider.describe(settings)).catch((err) => ({ available: false, reason: err?.message || "\u63A2\u6D4B\u5931\u8D25" }));
    const target = toBuiltinLang(settings.to) ?? "zh-Hans";
    let availability = null;
    try {
      if (typeof Translator !== "undefined" && Translator) {
        availability = await Translator.availability({ sourceLanguage: "en", targetLanguage: target });
      }
    } catch (err) {
      availability = `error:${err?.name || err?.message || "unknown"}`;
    }
    const result = {
      ok: true,
      supported: Boolean(described.available) && availability !== null,
      reason: described.available ? null : described.reason,
      availability,
      target,
      blocked: builtinBlocked?.reason ?? null,
      href: location.href
    };
    chrome.runtime.sendMessage({ type: MSG.PROBE_BUILTIN, result }).catch(() => {
    });
    return result;
  }
  function onCommand(command, payload) {
    if (command === CMD.TRANSLATE) return fireAndForget(translatePage());
    if (command === CMD.TOGGLE) return fireAndForget(translatePage({ toggleExisting: true }));
    if (command === CMD.STOP) return fireAndForget(stopTranslation());
    if (command === CMD.ENGINE_CHANGED) return fireAndForget(onEngineChanged(payload));
    if (command === CMD.EXCLUDE_REGION) return addRuleFromSelection("exclude");
    if (command === CMD.INCLUDE_REGION) return addRuleFromSelection("include");
    if (command === CMD.CLEAR_SITE_RULE) return clearSiteRuleForHost();
    if (command === CMD.TOGGLE_SITE_INCREMENTAL) return toggleSiteIncremental();
    if (command === CMD.PROBE_BUILTIN) return probeBuiltin();
    return null;
  }
  function onKeydown(event) {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.code !== "KeyT") return;
    if (looksEditable(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (phase !== "working" && countTranslated() === 0) kickoffPrepare();
    fireAndForget(translatePage({ toggleExisting: true }));
  }
  function mount() {
    if (mounted || !IS_TOP) return;
    mounted = true;
    injectStyles();
    applyPageTheme();
    setState("hidden");
    loadConfig().catch(() => {
    });
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message.type !== "string") return false;
      if (message.type === MSG.COMMAND) {
        const result = onCommand(message.command, message.payload);
        if (result && typeof result.then === "function") {
          result.then((value) => {
            try {
              sendResponse(value ?? { ok: true });
            } catch {
            }
          }).catch((err) => {
            try {
              sendResponse({ ok: false, reason: err?.message || String(err) });
            } catch {
            }
          });
          return true;
        }
        return false;
      }
      if (message.type === MSG.PROGRESS) {
        const stats = run?.stats() ?? incrementalRun?.stats() ?? { done: 0, total: 0 };
        try {
          sendResponse({ phase, total: allUnits.length, ...stats });
        } catch {
        }
        return false;
      }
      return false;
    });
    document.addEventListener("keydown", onKeydown, true);
  }
  mount();
})();
