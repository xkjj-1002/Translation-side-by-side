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
function providerMeta(provider) {
  return {
    id: provider.id,
    label: provider.label,
    host: provider.host,
    demo: Boolean(provider.demo),
    note: provider.note ?? null,
    fields: (provider.fields ?? []).map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type ?? "text",
      secret: Boolean(f.secret),
      placeholder: f.placeholder ?? "",
      note: f.note ?? null,
      advanced: Boolean(f.advanced),
      options: f.options ?? null,
      min: f.min ?? null,
      max: f.max ?? null,
      step: f.step ?? null,
      default: f.default ?? null
    })),
    presets: provider.presets ?? null
  };
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

// src/shared/hash.js
function quickHash(input) {
  const text = String(input ?? "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

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
  const cached = instances.get(key);
  if (cached) return cached;
  const {
    onProgress,
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
          onProgress?.(percent);
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
  async prepare(settings, { sampleText, onProgress, shouldCancel } = {}) {
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
        onProgress,
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
function listProviders() {
  return Array.from(REGISTRY.values());
}
function getProvider(id) {
  return REGISTRY.get(id) ?? null;
}
function listProviderMeta() {
  return listProviders().map(providerMeta);
}

// src/shared/storage.js
var DEFAULT_SETTINGS = {
  /**
   * 默认内置 AI：免费、完全本地、零配置即可用。
   * 设备/浏览器不支持时会自动回落到已配置的其他引擎，并如实提示（见 content/index.js）。
   */
  provider: "builtin",
  /** { [providerId]: { ...字段 } }，由各 provider 的 fields 推导默认值 */
  providers: {},
  from: "auto",
  to: "zh-CHS",
  minTextLength: 12,
  showToast: true,
  concurrency: 3,
  requestIntervalMs: 120,
  /**
   * 主动限速参数。有道对访问频率的限制比「每小时 100 万次」那个配额严格得多，
   * 免费/新账号尤其敏感，所以默认按保守速率放行。
   * 调大 = 更不容易被限流，但整页翻译更慢。
   */
  rateMinIntervalMs: 1100,
  rateCooldownMs: 6e3,
  /** 批量合并的上限：请求数少一个数量级，整页翻译从「一分钟」掉到「十秒内」 */
  batchMaxChars: 4e3,
  batchMaxSegments: 16,
  /** 动态内容（无限滚动 / SPA 切页）自动增量翻译 */
  incremental: true,
  incrementalDebounceMs: 700,
  /** 增量速率上限：防止无限滚动页面把额度翻光 */
  incrementalMaxPerMinute: 60,
  /**
   * 内置 AI 语言包「多久没有任何下载进度就判定为卡住」。
   *
   * 语言包由浏览器从厂商服务器下载，在部分网络环境下会一直挂着且不报错；
   * 没有这个上限的话整个翻译流程会静默挂死。它衡量的是两次进度之间的间隔，
   * 所以正常的慢速下载不会误伤。网络特别差时可以调大。
   */
  builtinStallTimeoutMs: 12e3,
  /** 内置 AI 语言包「第一次进度」的等待上限（慢启动 vs 被墙的区分线） */
  builtinFirstProgressTimeoutMs: 25e3,
  /** { [host]: { exclude: string[], include: string[], incremental: boolean|null } } */
  siteRules: {}
};
function buildProviders(saved = {}) {
  const out = {};
  for (const provider of listProviders()) {
    const base = fieldsDefaults(provider.fields);
    const legacy = provider.legacyKey ? saved[provider.legacyKey] : null;
    const current = saved.providers?.[provider.id];
    const merged = { ...base, ...legacy ?? {}, ...current ?? {} };
    const explicit = current ?? {};
    for (const [globalKey, fieldKey] of Object.entries(provider.legacyGlobal ?? {})) {
      if (saved[globalKey] !== void 0 && explicit[fieldKey] === void 0) {
        merged[fieldKey] = saved[globalKey];
      }
    }
    out[provider.id] = merged;
  }
  for (const [id, config] of Object.entries(saved.providers ?? {})) {
    if (!(id in out)) out[id] = { ...config };
  }
  return out;
}
function legacyGlobalKeys() {
  const keys = /* @__PURE__ */ new Set();
  for (const provider of listProviders()) {
    for (const key of Object.keys(provider.legacyGlobal ?? {})) keys.add(key);
  }
  return keys;
}
function normalizeSettings(saved = {}) {
  const out = {
    ...DEFAULT_SETTINGS,
    ...saved,
    providers: buildProviders(saved),
    siteRules: { ...saved.siteRules ?? {} }
  };
  for (const provider of listProviders()) {
    if (provider.legacyKey) delete out[provider.legacyKey];
  }
  for (const key of legacyGlobalKeys()) delete out[key];
  return out;
}
async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return normalizeSettings(stored?.settings ?? {});
}
async function saveSettings(patch) {
  const current = await getSettings();
  const next = {
    ...current,
    ...patch,
    providers: { ...current.providers }
  };
  for (const [id, config] of Object.entries(patch?.providers ?? {})) {
    next.providers[id] = { ...current.providers[id] ?? {}, ...config };
  }
  await chrome.storage.local.set({ settings: next });
  return next;
}
function isProviderReady(settings, providerId) {
  const provider = getProvider(providerId);
  if (!provider) return false;
  try {
    return Boolean(provider.isReady(providerConfig(settings, providerId), settings));
  } catch {
    return false;
  }
}

// src/shared/site-rules.js
function normalizeRule(rule) {
  return {
    exclude: Array.isArray(rule?.exclude) ? rule.exclude.filter(Boolean) : [],
    include: Array.isArray(rule?.include) ? rule.include.filter(Boolean) : [],
    incremental: typeof rule?.incremental === "boolean" ? rule.incremental : null
  };
}
function describeRule(rule) {
  const { exclude, include, incremental } = normalizeRule(rule);
  const parts = [];
  if (exclude.length) parts.push(`\u6392\u9664 ${exclude.length} \u4E2A\u533A\u57DF`);
  if (include.length) parts.push("\u53EA\u7FFB\u8BD1\u6307\u5B9A\u533A\u57DF");
  if (incremental === true) parts.push("\u81EA\u52A8\u7FFB\u8BD1\u65B0\u589E\u5185\u5BB9");
  if (incremental === false) parts.push("\u4E0D\u81EA\u52A8\u7FFB\u8BD1\u65B0\u589E\u5185\u5BB9");
  return parts.length ? parts.join(" \xB7 ") : "\u672A\u8BBE\u7F6E\u672C\u7AD9\u89C4\u5219";
}

// src/shared/platform.js
function isMac() {
  if (typeof navigator === "undefined") return false;
  if (navigator.userAgentData?.platform) {
    return navigator.userAgentData.platform === "macOS";
  }
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
}
function isEdge() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /\bEdg[A-Z]?\//.test(ua) || /\bEdge\//.test(ua);
}
function shortcutsUrl() {
  return isEdge() ? "edge://extensions/shortcuts" : "chrome://extensions/shortcuts";
}
async function openShortcutsPage() {
  try {
    await chrome.tabs.create({ url: shortcutsUrl() });
    return true;
  } catch {
    return false;
  }
}
function formatShortcut(spec) {
  if (isMac()) {
    return spec.replace(/Alt|Option/gi, "Option").replace(/\bCtrl\b|Control/gi, "Control").replace(/\bCmd\b|Meta/gi, "Command");
  }
  return spec.replace(/Option/gi, "Alt").replace(/Command/gi, "Ctrl");
}

// src/shared/dom-guard.js
function extensionContextAvailable() {
  try {
    return Boolean(globalThis.chrome?.runtime?.id);
  } catch {
    return false;
  }
}
function renderNotExtensionPage({ title, steps }) {
  const items = steps.map((s) => `<li>${s}</li>`).join("");
  document.body.innerHTML = `
    <div style="max-width:620px;margin:60px auto;padding:0 24px;font:15px/1.8 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#111827">
      <h1 style="font-size:20px;margin:0 0 10px">\u26A0\uFE0F ${title}</h1>
      <p style="color:#6b7280;margin:0 0 16px">
        \u8FD9\u4E2A\u9875\u9762\u5FC5\u987B\u7531\u6D4F\u89C8\u5668\u6269\u5C55\u73AF\u5883\u6253\u5F00\u3002\u76F4\u63A5\u5728\u6587\u4EF6\u7BA1\u7406\u5668\u91CC\u53CC\u51FB HTML \u662F\u6253\u4E0D\u5F00\u7684
        \u2014\u2014 \u90A3\u6837 <code style="background:rgba(0,0,0,.07);padding:1px 5px;border-radius:4px">chrome.runtime</code>
        \u4E0D\u5B58\u5728\uFF0C\u6240\u6709\u6309\u94AE\u90FD\u4E0D\u4F1A\u6709\u53CD\u5E94\u3002
      </p>
      <ol style="padding-left:22px;margin:0 0 16px">${items}</ol>
      <p style="color:#6b7280;font-size:13px;margin:0">
        \u5224\u65AD\u65B9\u6CD5\uFF1A\u5730\u5740\u680F\u5E94\u8BE5\u4EE5
        <code style="background:rgba(0,0,0,.07);padding:1px 5px;border-radius:4px">chrome-extension://</code>
        \u5F00\u5934\u3002\u5982\u679C\u662F <code style="background:rgba(0,0,0,.07);padding:1px 5px;border-radius:4px">file://</code>\uFF0C
        \u5C31\u662F\u6253\u5F00\u65B9\u5F0F\u4E0D\u5BF9\u3002
      </p>
    </div>`;
}

// src/options/options.js
var STATIC_FIELDS = [
  "provider",
  "from",
  "to",
  "minTextLength",
  "showToast",
  "incremental",
  "batchMaxChars",
  "batchMaxSegments",
  "rateMinIntervalMs",
  "rateCooldownMs",
  "concurrency"
];
var el = (id) => document.getElementById(id);
var saveTimer = null;
var currentSettings = null;
var lastProviderId = null;
if (!extensionContextAvailable()) {
  renderNotExtensionPage({
    title: "\u8FD9\u4E0D\u662F\u6269\u5C55\u7684\u8BBE\u7F6E\u9875",
    steps: [
      "\u70B9\u6D4F\u89C8\u5668\u5DE5\u5177\u680F\u4E0A\u7684\u300C\u5373\u65F6\u7FFB\u8BD1\u300D\u56FE\u6807 \u2192\u300C\u8BBE\u7F6E\u300D",
      "\u6216\u5230\u6269\u5C55\u7BA1\u7406\u9875\u627E\u5230\u300C\u5373\u65F6\u7FFB\u8BD1\u300D\u2192\u300C\u8BE6\u7EC6\u4FE1\u606F\u300D\u2192 \u5C55\u5F00\u300C\u6269\u5C55\u7A0B\u5E8F\u9009\u9879\u300D",
      'Edge \u7684\u6269\u5C55\u7BA1\u7406\u9875\u5728 <code style="background:rgba(0,0,0,.07);padding:1px 5px;border-radius:4px">edge://extensions</code>\uFF0CChrome \u662F <code style="background:rgba(0,0,0,.07);padding:1px 5px;border-radius:4px">chrome://extensions</code>'
    ]
  });
  throw new Error("[itx] \u975E\u6269\u5C55\u4E0A\u4E0B\u6587\uFF0C\u5DF2\u505C\u6B62\u521D\u59CB\u5316");
}
function fieldNode(field, value) {
  const wrap = document.createElement("label");
  wrap.className = field.type === "checkbox" ? "field inline" : "field";
  const label = document.createElement("span");
  label.textContent = field.label;
  let control;
  if (field.type === "select") {
    control = document.createElement("select");
    for (const option of field.options ?? []) {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      control.appendChild(node);
    }
  } else if (field.type === "textarea") {
    control = document.createElement("textarea");
    control.rows = 4;
  } else {
    control = document.createElement("input");
    control.type = field.type === "number" ? "number" : field.secret ? "password" : "text";
    if (field.type === "number") {
      if (field.min !== null && field.min !== void 0) control.min = String(field.min);
      if (field.max !== null && field.max !== void 0) control.max = String(field.max);
      if (field.step !== null && field.step !== void 0) control.step = String(field.step);
    }
    control.autocomplete = "off";
    control.spellcheck = false;
    if (field.placeholder) control.placeholder = field.placeholder;
  }
  control.dataset.field = field.key;
  if (field.type === "checkbox") control.checked = Boolean(value);
  else control.value = value ?? "";
  if (field.type === "checkbox") wrap.append(control, label);
  else wrap.append(label, control);
  if (field.note) {
    const note = document.createElement("p");
    note.className = "note field-note";
    note.textContent = field.note;
    const holder = document.createElement("div");
    holder.className = "field-block";
    holder.append(wrap, note);
    return holder;
  }
  return wrap;
}
function presetRow(meta) {
  const row = document.createElement("div");
  row.className = "row presets";
  const label = document.createElement("span");
  label.className = "note";
  label.textContent = "\u5FEB\u901F\u586B\u5145\uFF1A";
  row.appendChild(label);
  for (const preset of meta.presets ?? []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = preset.label;
    if (preset.note) button.title = preset.note;
    button.addEventListener("click", () => {
      for (const [key, value] of Object.entries(preset.patch ?? {})) {
        const node = document.querySelector(`#provider-fields [data-field="${key}"]`);
        if (node) node.value = value;
      }
      scheduleSave();
      flash(`\u5DF2\u5957\u7528\u300C${preset.label}\u300D\u9884\u8BBE`);
    });
    row.appendChild(button);
  }
  return row;
}
function renderProviderFields(meta, config) {
  const holder = el("provider-fields");
  holder.textContent = "";
  if (!meta) return;
  const basic = (meta.fields ?? []).filter((f) => !f.advanced);
  const advanced = (meta.fields ?? []).filter((f) => f.advanced);
  for (const field of basic) holder.appendChild(fieldNode(field, config?.[field.key]));
  if (advanced.length) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "\u9AD8\u7EA7\u9009\u9879";
    details.appendChild(summary);
    for (const field of advanced) details.appendChild(fieldNode(field, config?.[field.key]));
    holder.appendChild(details);
  }
  if (meta.presets?.length) holder.appendChild(presetRow(meta));
}
function collectProviderValues() {
  const out = {};
  for (const node of document.querySelectorAll("#provider-fields [data-field]")) {
    const key = node.dataset.field;
    if (node.type === "checkbox") out[key] = node.checked;
    else if (node.type === "number") out[key] = Number(node.value);
    else out[key] = String(node.value ?? "").trim();
  }
  return out;
}
function renderProviderSelect(settings) {
  const select = el("provider");
  select.textContent = "";
  for (const meta of listProviderMeta()) {
    const option = document.createElement("option");
    option.value = meta.id;
    option.textContent = meta.demo ? `${meta.label} \xB7 \u6F14\u793A` : meta.label;
    select.appendChild(option);
  }
  select.value = settings.provider;
}
function refreshProviderUI(settings) {
  const meta = listProviderMeta().find((m) => m.id === settings.provider);
  const config = providerConfig(settings, settings.provider);
  renderProviderFields(meta, config);
  const note = el("provider-note");
  note.textContent = meta?.note ?? "";
  note.hidden = !meta?.note;
}
function collect() {
  const values = {};
  for (const key of STATIC_FIELDS) {
    const node = el(key);
    if (!node) continue;
    if (node.type === "checkbox") values[key] = node.checked;
    else if (node.type === "number") values[key] = Number(node.value);
    else values[key] = node.value;
  }
  values.providers = { [values.provider]: collectProviderValues() };
  return values;
}
function applyValues(settings) {
  for (const key of STATIC_FIELDS) {
    const node = el(key);
    if (!node) continue;
    if (node.type === "checkbox") node.checked = Boolean(settings[key]);
    else if (key !== "provider") node.value = settings[key];
  }
  renderProviderSelect(settings);
  refreshProviderUI(settings);
  renderSiteRules(settings);
}
function flash(message, kind = "ok") {
  const node = el("save-state");
  node.textContent = message;
  node.className = `result ${kind}`;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => {
    node.textContent = "";
    node.className = "result";
  }, 2400);
}
async function persist() {
  const patch = collect();
  const next = await saveSettings(patch);
  currentSettings = next;
  renderSiteRules(next);
  if (lastProviderId && lastProviderId !== next.provider) {
    const provider = getProvider(next.provider);
    chrome.runtime.sendMessage({
      type: MSG.ENGINE_CHANGED,
      providerId: next.provider,
      label: provider?.label ?? next.provider
    }).catch(() => {
    });
  }
  lastProviderId = next.provider;
  flash("\u5DF2\u4FDD\u5B58");
  return next;
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    persist().catch((err) => flash(`\u4FDD\u5B58\u5931\u8D25\uFF1A${err.message}`, "err"));
  }, 400);
}
function renderSiteRules(settings) {
  const holder = el("site-rules");
  holder.textContent = "";
  const rules = settings?.siteRules ?? {};
  const hosts = Object.keys(rules);
  if (!hosts.length) {
    const empty = document.createElement("p");
    empty.className = "note";
    empty.textContent = "\u8FD8\u6CA1\u6709\u4EFB\u4F55\u7AD9\u70B9\u89C4\u5219\u3002";
    holder.appendChild(empty);
    return;
  }
  for (const host of hosts) {
    const rule = normalizeRule(rules[host]);
    const row = document.createElement("div");
    row.className = "rule-row";
    const name = document.createElement("div");
    name.className = "rule-host";
    name.textContent = host;
    const desc = document.createElement("div");
    desc.className = "note";
    desc.textContent = describeRule(rule);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost";
    remove.textContent = "\u5220\u9664";
    remove.addEventListener("click", async () => {
      const next = { ...currentSettings?.siteRules ?? {} };
      delete next[host];
      currentSettings = await saveSettings({ siteRules: next });
      renderSiteRules(currentSettings);
      flash(`\u5DF2\u5220\u9664 ${host} \u7684\u89C4\u5219`);
    });
    const text = document.createElement("div");
    text.append(name, desc);
    row.append(text, remove);
    holder.appendChild(row);
  }
}
async function probeBuiltinInPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    return await chrome.tabs.sendMessage(tab.id, {
      type: MSG.COMMAND,
      command: CMD.PROBE_BUILTIN
    });
  } catch {
    return null;
  }
}
async function ensurePermissions(provider, config) {
  let origins = [];
  try {
    origins = (provider.permissionOrigins?.(config) ?? []).map((url) => `${new URL(url).origin}/*`).filter(Boolean);
  } catch {
    return false;
  }
  if (!origins.length || !chrome.permissions?.request) return true;
  try {
    if (await chrome.permissions.contains({ origins })) return true;
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}
el("test").addEventListener("click", async () => {
  const button = el("test");
  const result = el("test-result");
  const show = (text, kind = "") => {
    result.textContent = text;
    result.className = `result ${kind}`.trim();
  };
  el("diag").dataset.clicked = "1";
  el("diag").textContent = diagText("\u5DF2\u70B9\u51FB\u6D4B\u8BD5\u6309\u94AE");
  button.disabled = true;
  show("\u6B63\u5728\u6D4B\u8BD5\u2026");
  try {
    try {
      await persist();
    } catch (err) {
      show(`\u4FDD\u5B58\u8BBE\u7F6E\u5931\u8D25\uFF1A${err.message}`, "err");
      return;
    }
    const settings = await getSettings();
    const provider = getProvider(settings.provider);
    if (!provider) {
      show("\u672A\u77E5\u7684\u7FFB\u8BD1\u670D\u52A1", "err");
      return;
    }
    if (provider.host === "content") {
      const probe = await probeBuiltinInPage();
      if (!probe) {
        show("\u5185\u7F6E AI \u53EA\u80FD\u5728\u7F51\u9875\u91CC\u9A8C\u8BC1\uFF1A\u5148\u6253\u5F00\u4EFB\u610F\u666E\u901A\u7F51\u9875\uFF08\u522B\u505C\u5728\u8BBE\u7F6E\u9875\u6216\u7A7A\u767D\u65B0\u6807\u7B7E\u9875\uFF09\uFF0C\u518D\u70B9\u4E00\u6B21\u300C\u6D4B\u8BD5\u8FDE\u63A5\u300D", "err");
        return;
      }
      if (probe.availability === "available") {
        show("\u2705 \u8BED\u8A00\u5305\u5DF2\u5C31\u7EEA\uFF0C\u5185\u7F6E AI \u53EF\u4EE5\u76F4\u63A5\u7528\u3002", "ok");
      } else if (probe.availability === "downloadable" || probe.availability === "downloading") {
        show("\u2B07\uFE0F \u4E2D\u6587\u8BED\u8A00\u5305\u8FD8\u6CA1\u4E0B\u597D\uFF1A\u56DE\u5230\u7F51\u9875\u6309\u4E00\u6B21\u5FEB\u6377\u952E\uFF0C\u5728\u63D0\u793A\u91CC\u70B9\u300C\u4E0B\u8F7D\u8BED\u8A00\u5305\u300D\u5373\u53EF\uFF08\u53EA\u6709\u7B2C\u4E00\u6B21\u9700\u8981\uFF09\u3002", "err");
      } else {
        show(`\u274C ${probe.reason || "\u8FD9\u53F0\u8BBE\u5907\u7528\u4E0D\u4E86\u5185\u7F6E AI"}\uFF08\u8BED\u8A00\u5305\u72B6\u6001\uFF1A${probe.availability}\uFF09`, "err");
      }
      return;
    }
    if (!isProviderReady(settings, provider.id)) {
      show("\u8BF7\u5148\u5728\u4E0A\u9762\u628A\u8FD9\u5BB6\u5F15\u64CE\u7684\u5FC5\u586B\u9879\u586B\u597D\uFF0C\u518D\u70B9\u6D4B\u8BD5", "err");
      return;
    }
    if (typeof provider.permissionOrigins === "function") {
      const granted = await ensurePermissions(provider, providerConfig(settings, provider.id));
      if (!granted) {
        show("\u9700\u8981\u6388\u6743\u8BBF\u95EE\u8BE5\u63A5\u53E3\u5730\u5740\uFF0C\u5426\u5219\u6269\u5C55\u540E\u53F0\u53D1\u4E0D\u51FA\u8BF7\u6C42", "err");
        return;
      }
    }
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: MSG.TRANSLATE,
        texts: ["This is a connection test for the translation extension."]
      });
    } catch (err) {
      show(`\u65E0\u6CD5\u8FDE\u63A5\u6269\u5C55\u540E\u53F0\uFF1A${err.message}\u3002\u8BF7\u5230\u6269\u5C55\u7BA1\u7406\u9875\u5237\u65B0\u4E00\u6B21\u6269\u5C55\u3002`, "err");
      return;
    }
    if (!response) {
      show("\u6269\u5C55\u540E\u53F0\u6CA1\u6709\u54CD\u5E94\u3002\u8BF7\u5230\u6269\u5C55\u7BA1\u7406\u9875\u5237\u65B0\u4E00\u6B21\u6269\u5C55\u540E\u91CD\u8BD5\u3002", "err");
      return;
    }
    if (!response.ok) {
      show(`\u274C ${response.error || "\u6D4B\u8BD5\u5931\u8D25"}`, "err");
      return;
    }
    const item = response.items?.[0];
    if (item?.ok) {
      show(`\u2705 \u8FDE\u63A5\u6B63\u5E38\uFF0C\u8FD4\u56DE\uFF1A${item.translation}`, "ok");
      return;
    }
    const code = item?.code ? `\uFF08\u9519\u8BEF\u7801 ${item.code}\uFF09` : "";
    show(`\u274C ${item?.error || "\u6D4B\u8BD5\u5931\u8D25"}${code}`, "err");
  } finally {
    button.disabled = false;
  }
});
el("clear-cache").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: MSG.STATUS, action: "clear-cache" });
  await refreshCacheInfo();
  flash("\u7F13\u5B58\u5DF2\u6E05\u7A7A");
});
el("provider").addEventListener("change", () => {
  const settings = normalizeSettings({
    ...currentSettings ?? {},
    provider: el("provider").value
  });
  refreshProviderUI(settings);
  el("engine-issue").hidden = true;
  chrome.storage.local.remove("lastEngineIssue").catch(() => {
  });
  scheduleSave();
});
for (const id of STATIC_FIELDS) {
  if (id === "provider") continue;
  const node = el(id);
  if (!node) continue;
  node.addEventListener("change", scheduleSave);
}
el("provider-fields").addEventListener("change", scheduleSave);
async function refreshCacheInfo() {
  try {
    const status = await chrome.runtime.sendMessage({ type: MSG.STATUS });
    if (status?.cache) {
      el("cache-info").textContent = `\u7F13\u5B58 ${status.cache.size} \u6761 \xB7 \u547D\u4E2D\u7387 ${status.cache.hitRate}%`;
    }
  } catch {
    el("cache-info").textContent = "";
  }
}
function diagText(extra = "") {
  let version = "?";
  let id = "?";
  try {
    version = chrome.runtime.getManifest().version;
    id = chrome.runtime.id.slice(0, 8);
  } catch {
    version = "\u8BFB\u4E0D\u5230\uFF08\u6269\u5C55\u4E0A\u4E0B\u6587\u5F02\u5E38\uFF09";
  }
  const stamp = (/* @__PURE__ */ new Date()).toLocaleTimeString("zh-CN", { hour12: false });
  const clicked = el("diag").dataset.clicked === "1" ? "\u6D4B\u8BD5\u6309\u94AE\u5DF2\u7ED1\u5B9A" : "\u6D4B\u8BD5\u6309\u94AE\u5F85\u547D";
  return `v${version} \xB7 \u6269\u5C55 ${id} \xB7 ${clicked}${extra ? ` \xB7 ${extra}` : ""} \xB7 ${stamp}`;
}
function wireShortcutsLink() {
  const link = el("open-shortcuts");
  link.title = shortcutsUrl();
  link.addEventListener("click", async (event) => {
    event.preventDefault();
    if (!await openShortcutsPage()) {
      flash(`\u8BF7\u624B\u52A8\u6253\u5F00 ${shortcutsUrl()}`, "err");
    }
  });
}
async function refreshShortcutLabels() {
  let commands = [];
  try {
    commands = await chrome.commands.getAll();
  } catch {
    return;
  }
  const find = (name) => commands.find((c) => c.name === name)?.shortcut;
  const translate = find("toggle-translate");
  const visibility = find("toggle-visibility");
  el("key-translate").textContent = translate ? formatShortcut(translate) : `${formatShortcut("Alt+T")}\uFF08\u672A\u7ED1\u5B9A\uFF09`;
  el("key-visibility").textContent = visibility ? formatShortcut(visibility) : `${formatShortcut("Alt+Shift+T")}\uFF08\u672A\u7ED1\u5B9A\uFF09`;
}
async function renderEngineIssue(settings) {
  const node = el("engine-issue");
  let issue = null;
  try {
    const stored = await chrome.storage.local.get("lastEngineIssue");
    issue = stored?.lastEngineIssue ?? null;
  } catch {
    issue = null;
  }
  const fresh = issue && Date.now() - (issue.at ?? 0) < 10 * 60 * 1e3;
  if (!fresh) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  node.textContent = "";
  const title = document.createElement("h2");
  title.textContent = "\u26A0\uFE0F \u521A\u624D\u8FD9\u4E00\u9875\u6CA1\u80FD\u7FFB\u8BD1";
  const reason = document.createElement("p");
  reason.textContent = issue.reason;
  const hint = document.createElement("p");
  hint.textContent = settings.provider === "builtin" ? "\u5185\u7F6E AI \u9700\u8981 Chrome 138+ / Edge 148+ \u684C\u9762\u7248\u4E14\u786C\u4EF6\u8FBE\u6807\uFF0C\u9996\u6B21\u4F7F\u7528\u8FD8\u8981\u4E0B\u8F7D\u8BED\u8A00\u5305\u3002\u5982\u679C\u8FD9\u53F0\u673A\u5668\u4E0A\u7528\u4E0D\u4E86\uFF0C\u8BF7\u5728\u4E0B\u9762\u6539\u9009\u300C\u6709\u9053\u667A\u4E91\u300D\u6216\u300C\u5927\u6A21\u578B API\u300D\uFF08\u4E24\u8005\u90FD\u9700\u8981\u586B\u5BC6\u94A5\uFF09\uFF0C\u7136\u540E\u56DE\u7F51\u9875\u91CD\u65B0\u6309\u4E00\u6B21\u5FEB\u6377\u952E\u3002" : "\u8BF7\u68C0\u67E5\u4E0B\u9762\u8FD9\u9879\u7684\u914D\u7F6E\u662F\u5426\u6B63\u786E\uFF0C\u6539\u5B8C\u56DE\u5230\u7F51\u9875\u91CD\u65B0\u6309\u4E00\u6B21\u5FEB\u6377\u952E\u3002";
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "ghost";
  dismiss.textContent = "\u77E5\u9053\u4E86";
  dismiss.addEventListener("click", async () => {
    try {
      await chrome.storage.local.remove("lastEngineIssue");
    } catch {
    }
    node.hidden = true;
  });
  node.append(title, reason, hint, dismiss);
  node.hidden = false;
}
async function main() {
  const settings = await getSettings();
  currentSettings = settings;
  lastProviderId = settings.provider;
  applyValues(settings);
  await renderEngineIssue(settings);
  wireShortcutsLink();
  el("diag").textContent = diagText();
  await Promise.all([refreshCacheInfo(), refreshShortcutLabels()]);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings?.newValue) return;
    const next = normalizeSettings(changes.settings.newValue);
    currentSettings = next;
    lastProviderId = next.provider;
    applyValues(next);
  });
}
main();
