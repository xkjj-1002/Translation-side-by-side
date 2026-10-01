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

// src/popup/popup.js
var el = (id) => document.getElementById(id);
if (!extensionContextAvailable()) {
  renderNotExtensionPage({
    title: "\u8FD9\u4E0D\u662F\u6269\u5C55\u7684\u5F39\u51FA\u9762\u677F",
    steps: [
      "\u70B9\u6D4F\u89C8\u5668\u5DE5\u5177\u680F\u4E0A\u7684\u300C\u5373\u65F6\u7FFB\u8BD1\u300D\u56FE\u6807\uFF08\u84DD\u8272 T\uFF09\u6253\u5F00\u5B83",
      "\u5DE5\u5177\u680F\u4E0A\u627E\u4E0D\u5230\u56FE\u6807\u65F6\uFF0C\u5728\u6269\u5C55\u7BA1\u7406\u9875\u91CC\u628A\u5B83\u300C\u663E\u793A\u5728\u5DE5\u5177\u680F\u300D"
    ]
  });
  throw new Error("[itx] \u975E\u6269\u5C55\u4E0A\u4E0B\u6587\uFF0C\u5DF2\u505C\u6B62\u521D\u59CB\u5316");
}
var activeTab = null;
var siteHost = null;
async function findActiveTab() {
  if (activeTab) return activeTab;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab ?? null;
  if (tab?.url) {
    try {
      siteHost = new URL(tab.url).hostname;
    } catch {
      siteHost = null;
    }
  }
  return activeTab;
}
function setStatus(text, kind = "") {
  el("status").textContent = text;
  el("status").className = kind;
}
function setRuleStatus(text, kind = "") {
  el("rule-status").textContent = text;
  el("rule-status").className = `hint small ${kind}`.trim();
}
async function send(command, { close = true } = {}) {
  const tab = await findActiveTab();
  if (!tab?.id) {
    setStatus("\u6CA1\u6709\u53EF\u64CD\u4F5C\u7684\u6807\u7B7E\u9875");
    return null;
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: MSG.COMMAND, command });
    if (close) window.close();
    return response ?? null;
  } catch {
    setStatus("\u5F53\u524D\u9875\u9762\u65E0\u6CD5\u64CD\u4F5C\uFF08\u6269\u5C55\u672A\u6CE8\u5165\u6216\u5C5E\u4E8E\u53D7\u9650\u9875\u9762\uFF09", "warn");
    return null;
  }
}
el("translate").addEventListener("click", () => send(CMD.TRANSLATE));
el("toggle").addEventListener("click", () => send(CMD.TOGGLE));
el("stop").addEventListener("click", () => send(CMD.STOP));
el("options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
for (const [id, command] of [
  ["exclude-region", CMD.EXCLUDE_REGION],
  ["include-region", CMD.INCLUDE_REGION]
]) {
  el(id).addEventListener("click", async () => {
    setRuleStatus("\u5904\u7406\u4E2D\u2026");
    const response = await send(command, { close: false });
    if (!response) return;
    if (response.ok) {
      setRuleStatus(`\u5DF2\u4FDD\u5B58\u89C4\u5219 ${response.selector}\u3002\u91CD\u65B0\u7FFB\u8BD1\u540E\u751F\u6548\u3002`);
      await refreshRules();
    } else {
      setRuleStatus(response.reason || "\u4FDD\u5B58\u5931\u8D25", "warn");
    }
  });
}
el("clear-site-rule").addEventListener("click", async () => {
  const response = await send(CMD.CLEAR_SITE_RULE, { close: false });
  if (response?.ok) {
    setRuleStatus("\u5DF2\u6E05\u9664\u672C\u7AD9\u7684\u5168\u90E8\u89C4\u5219");
    await refreshRules();
  } else {
    setRuleStatus("\u6E05\u9664\u5931\u8D25", "warn");
  }
});
el("site-incremental").addEventListener("change", async () => {
  const response = await send(CMD.TOGGLE_SITE_INCREMENTAL, { close: false });
  if (response?.ok) {
    setRuleStatus(response.value ? "\u672C\u7AD9\u5DF2\u5F00\u542F\u81EA\u52A8\u7FFB\u8BD1\u65B0\u589E\u5185\u5BB9" : "\u672C\u7AD9\u5DF2\u5173\u95ED\u81EA\u52A8\u7FFB\u8BD1\u65B0\u589E\u5185\u5BB9");
    await refreshRules();
  } else {
    setRuleStatus("\u5207\u6362\u5931\u8D25", "warn");
    await refreshRules();
  }
});
async function showShortcut() {
  let commands = [];
  try {
    commands = await chrome.commands.getAll();
  } catch {
    el("shortcut").textContent = formatShortcut("Alt+T");
    return;
  }
  const toggle = commands.find((c) => c.name === "toggle-translate");
  const visibility = commands.find((c) => c.name === "toggle-visibility");
  if (toggle?.shortcut) {
    el("shortcut").textContent = formatShortcut(toggle.shortcut);
  } else {
    el("shortcut").textContent = "\u672A\u7ED1\u5B9A";
    const warning = el("shortcut-warning");
    warning.hidden = false;
    warning.textContent = "\u7CFB\u7EDF\u6CA1\u80FD\u81EA\u52A8\u7ED1\u5B9A\u5FEB\u6377\u952E\uFF08Mac \u4E0A Option \u7EC4\u5408\u8F83\u5E38\u89C1\uFF09\u3002\u8BF7\u624B\u52A8\u6307\u5B9A\u4E00\u4E2A\u3002";
  }
  if (visibility?.shortcut) {
    el("shortcut").title = `\u663E\u793A/\u9690\u85CF\u8BD1\u6587\uFF1A${formatShortcut(visibility.shortcut)}`;
  }
}
async function wireShortcutsLink() {
  el("shortcut-fallback").textContent = `\uFF08\u6216\u624B\u52A8\u6253\u5F00 ${shortcutsUrl()}\uFF09`;
  el("open-shortcuts").addEventListener("click", async (event) => {
    event.preventDefault();
    if (await openShortcutsPage()) window.close();
  });
}
async function refreshRules() {
  await findActiveTab();
  el("site-host").textContent = siteHost || "\u2014";
  if (!siteHost) {
    el("site-incremental").disabled = true;
    return;
  }
  let config = null;
  try {
    config = await chrome.runtime.sendMessage({ type: MSG.CONFIG });
  } catch {
    config = null;
  }
  const rule = normalizeRule(config?.settings?.siteRules?.[siteHost]);
  const globalIncremental = Boolean(config?.settings?.incremental);
  const effective = rule.incremental === null ? globalIncremental : rule.incremental;
  el("site-incremental").checked = effective;
  setRuleStatus(
    rule.incremental === null ? `${describeRule(rule)}\uFF08\u589E\u91CF\u8DDF\u968F\u5168\u5C40\uFF1A${globalIncremental ? "\u5F00" : "\u5173"}\uFF09` : describeRule(rule)
  );
}
async function refresh() {
  try {
    const status = await chrome.runtime.sendMessage({ type: MSG.STATUS });
    if (!status) {
      setStatus("\u540E\u53F0\u672A\u54CD\u5E94");
      return;
    }
    if (status.rate?.notice) {
      setStatus(status.rate.notice, "warn");
      return;
    }
    const hitRate = status.cache?.hitRate ?? 0;
    const cache = status.cache?.size ?? 0;
    const suffix = `\u7F13\u5B58 ${cache} \u6761 \xB7 \u547D\u4E2D ${hitRate}%`;
    if (status.providerHost === "content") {
      setStatus(`\u5F53\u524D\u5F15\u64CE\uFF1A${status.providerLabel}\uFF08\u53EF\u7528\u6027\u5728\u9875\u9762\u5185\u5224\u5B9A\uFF09 \xB7 ${suffix}`);
      return;
    }
    if (status.demo) {
      setStatus(`\u5F53\u524D\u5F15\u64CE\uFF1A${status.providerLabel} \u2014\u2014 \u8FD9\u53EA\u662F\u6F14\u793A\uFF0C\u4E0D\u4F1A\u771F\u7684\u7FFB\u8BD1 \xB7 ${suffix}`, "warn");
      return;
    }
    if (status.ready) {
      setStatus(`\u5F53\u524D\u5F15\u64CE\uFF1A${status.providerLabel} \xB7 ${suffix}`);
    } else {
      setStatus(`\u300C${status.providerLabel}\u300D\u8FD8\u6CA1\u914D\u7F6E\u5BC6\u94A5\uFF0C\u8BF7\u5230\u8BBE\u7F6E\u9875\u586B\u5199`, "warn");
    }
  } catch {
    setStatus("\u540E\u53F0\u672A\u5C31\u7EEA");
  }
}
wireShortcutsLink();
showShortcut();
refresh();
refreshRules();
