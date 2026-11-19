import { translateBounded } from '../shared/translate';
import { menuUI } from '../shared/menu';
const { ensureStyle, buildMenu, openPanel, showFailure, field } = menuUI(document);
/**
 * Steam 翻译助手 — injected into Steam's web views.
 * Right-click menu: 翻译此页 / 还原原文 / 还原翻译 / API 设置…
 * Only text nodes are replaced, images and layout stay intact.
 *
 * v0.2.0
 *  - 译文缓存落盘（backend getCache/putCache）：换页、重启后仍是译文
 *  - 后出现的内容（工坊卡片悬停简介、评论、懒加载）走快通道：
 *    缓存命中立即回填；未命中 60ms 内即发出请求，不再等 250ms/20 条一批
 */

const TAG = '[ds-tr]';

type Phase = 'idle' | 'busy' | 'done';

const STEAM_HOSTS = /(^|\.)(steamcommunity\.com|store\.steampowered\.com|help\.steampowered\.com|steam\.tv)$/;

const SKIP_SELECTOR = [
  'script', 'style', 'noscript', 'svg', 'img', 'code', 'pre',
  'textarea', '[contenteditable]', '#ds-tr-inline', '#ds-tr-inline-wrap', '#ds-tr-inline-lang', '#ds-tr-error', '#ds-tr-panel', '#ds-tr-menu', '#ds-tr-mask',
].join(',');

const state = { phase: 'idle' as Phase };
const origToTr = new Map<string, string>();
let originals = new WeakMap<Node, { raw: string; output: string }>();
const attempted = new Set<string>();

let generation = 0;
let lastSnapshot: { node: Node; raw: string; output: string }[] = [];
const touched = new Set<Node>();

function log(...args: unknown[]) {
  console.log(TAG, ...args);
}

function note(msg: string) {
  backend.noteFromWeb(msg).catch(() => undefined);
}

function isSteamPage() {
  if (!STEAM_HOSTS.test(location.hostname)) return false;
  if (/^\/(checkout|login|register)\b/i.test(location.pathname)) return false;
  return true;
}

function hideMenu() {
  const menu = document.getElementById('ds-tr-menu');
  if (menu) menu.style.display = 'none';
}

function menuLabel(): string {
  if (state.phase === 'busy') return '翻译中…';
  if (state.phase === 'done') return '还原原文';
  return lastSnapshot.length ? '重新翻译' : '翻译此页';
}

let autoTranslate = false;
let preferenceReady = false;

function showMenu(x: number, y: number) {
  let menu = document.getElementById('ds-tr-menu');
  if (!menu) {
    menu = buildMenu(autoTranslate, preferenceReady, enabled => {
      autoTranslate = enabled;
      hideMenu();
      if (enabled) void translate();
      else {
        generation++;
        observer.disconnect();
        quickObserver.disconnect();
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
        state.phase = origToTr.size ? 'done' : 'idle';
      }
    });
    document.body.appendChild(menu);
  }
  const action = document.getElementById('ds-tr-action') as HTMLElement;
  action.dataset.mode = state.phase === 'done' ? 'restore' : 'translate';
  action.classList.toggle('disabled', state.phase === 'busy');
  action.textContent = menuLabel();
  const redo = document.getElementById('ds-tr-redo');
  if (redo) redo.classList.toggle('hidden', !(state.phase !== 'done' && lastSnapshot.length));

  menu.style.display = 'block';
  const w = menu.offsetWidth || 170;
  const h = menu.offsetHeight || 90;
  menu.style.left = Math.min(x, window.innerWidth - w - 6) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - h - 6) + 'px';
}

const fields = ['title', 'alt', 'placeholder', 'aria-label', 'value'];
let observer: MutationObserver;
let quickObserver: MutationObserver;
let timer: number | undefined;
let dirty = false;

// ── 译文缓存持久化 ───────────────────────────────────────────────────────────
const pendingPersist = new Map<string, string>();
let persistTimer: number | undefined;

function queuePersist(src: string, tr: string) {
  pendingPersist.set(src, tr);
  if (persistTimer !== undefined) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = undefined;
    void flushPersist();
  }, 1200);
}

async function flushPersist() {
  if (!pendingPersist.size) return;
  const entries: Record<string, string> = {};
  for (const [k, v] of pendingPersist) entries[k] = v;
  pendingPersist.clear();
  try {
    await backend.putCache(JSON.stringify({ entries }));
  } catch (e) {
    note('cache write failed: ' + String(e));
  }
}

async function hydrateCache() {
  try {
    const raw = await backend.getCache();
    const obj: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const map = (obj as { map?: Record<string, string> })?.map ?? (obj as Record<string, string>);
    if (map && typeof map === 'object') {
      for (const [k, v] of Object.entries(map)) {
        if (k && typeof v === 'string' && v) origToTr.set(k, v);
      }
    }
    note('cache hydrated ' + origToTr.size);
  } catch (e) {
    note('cache hydrate failed: ' + String(e));
  }
}

function schedule() {
  dirty = true;
  if (state.phase !== 'done' || timer !== undefined) return;
  timer = window.setTimeout(() => {
    timer = undefined;
    if (state.phase === 'done') void translate();
  }, 250);
}

// ── 快通道：处理翻译完成后才出现的内容（悬停简介、懒加载） ─────────────────
const quickPending = new Map<string, Node[]>();
let quickTimer: number | undefined;

function isTranslatable(text: string) {
  if (!text || text.length < 2) return false;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const han = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  if (latin === 0) return false;
  // 中文为主的文本（例如 "[DG]简易洗衣机"、中文简介里夹几个英文缩写）不再送翻，
  // 否则每次悬停都会白花一次请求，还会因为“译文=原文”不进缓存而反复调用。
  if (han >= latin) return false;
  return true;
}

function apply(node: Node, text: string, tr: string) {
  const raw = node.nodeValue;
  if (!raw || raw.trim() !== text || text === tr) return;
  const output = raw.replace(/\S[\s\S]*\S|\S/u, () => tr);
  originals.set(node, { raw, output });
  node.nodeValue = output;
  touched.add(node);
}

function applyCachedNode(node: Node) {
  const raw = node.nodeValue || '';
  const text = raw.trim();
  const tr = lookupCached(text);
  if (!tr || tr === text) return;
  const record = originals.get(node);
  if (record && record.output === raw) return;
  apply(node, text, tr);
}

function collectQuick(node: Node) {
  const raw = node.nodeValue || '';
  const text = raw.trim();
  if (!isTranslatable(text)) return;
  if (origToTr.has(text) || origToTr.has(normText(text)) || attempted.has(text) || lookupCached(text)) return;
  let nodes = quickPending.get(text);
  if (!nodes) quickPending.set(text, nodes = []);
  nodes.push(node);
}

function scanQuick(node: Node) {
  if (node.nodeType === 3) {
    applyCachedNode(node);
    collectQuick(node);
    return;
  }
  if (node.nodeType === 1 && (node as Element).matches(SKIP_SELECTOR)) return;
  walkTargets(node as Element | ShadowRoot, child => {
    applyCachedNode(child);
    collectQuick(child);
  });
}

function flushQuick() {
  quickTimer = undefined;
  if (state.phase !== 'done' || !quickPending.size) return;
  const texts = Array.from(quickPending.keys()).slice(0, 8);
  for (const t of texts) attempted.add(t);
  const version = generation;
  translateBounded(texts, () => generation === version)
    .then(res => {
      if (generation !== version) { state.phase = 'idle'; return; }
      if (!res || !Array.isArray(res.texts) || res.texts.length !== texts.length) return;
      let hits = 0;
      texts.forEach((text, i) => {
        const tr = res.texts[i].trim();
        if (!tr) return;
        if (normText(tr) === normText(text)) {
          // 原文已经是目标语言（例如 "RimWorld 创意工坊"）：把“不需要翻译”也记下来，
          // 否则每次悬停/重绘都会再请求一遍，就是那 0.5 秒的来源。
          origToTr.set(text, text);
          origToTr.set(normText(text), text);
          attempted.add(text);
          queuePersist(text, text);
          return;
        }
        origToTr.set(text, tr);
        origToTr.set(normText(text), tr);
        queuePersist(text, tr);
        for (const node of quickPending.get(text) || []) {
          if (node.isConnected) apply(node, text, tr);
        }
        hits++;
      });
      quickPending.clear();
      // 悬停浮窗常常是独立窗口且关得很快：立刻落盘，别等 1.2 秒防抖，
      // 否则第二次悬停时新窗口读不到这条译文，又要重翻。
      void flushPersist();
      note(`quick done texts=${texts.length} applied=${hits}`);
    })
    .catch(e => note('quick failed: ' + String(e)));
}

function quickScan(added: Node[]) {
  if (!added.length) return;
  for (const node of added) {
    if (!node.isConnected) continue;
    scanQuick(node);
  }
  if (quickPending.size && quickTimer === undefined) {
    quickTimer = window.setTimeout(flushQuick, 60);
  }
}

function walkTargets(root: Element | ShadowRoot, visit: (node: Node) => void) {
  observer.observe(root, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: fields });
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === 1 && (node as Element).matches(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let item: Node | null;
  while ((item = walker.nextNode())) {
    if (item.nodeType === 3) {
      visit(item);
      continue;
    }
    const el = item as Element;
    for (const name of fields) {
      if (name === 'value' && !el.matches('input[type=button],input[type=submit],input[type=reset]')) continue;
      const attr = el.getAttributeNode(name);
      if (attr) visit(attr);
    }
    if (el.shadowRoot) walkTargets(el.shadowRoot, visit);
    if (el.localName === 'iframe') {
      const frame = el as HTMLIFrameElement;
      frame.addEventListener('load', schedule);
      const doc = frame.contentDocument;
      if (doc?.body && STEAM_HOSTS.test(doc.location.hostname) && !/^\/(checkout|login|register)\b/i.test(doc.location.pathname)) walkTargets(doc.body, visit);
    }
  }
}

// 还原原文之后点「还原翻译」：先把快照贴回去，剩下的交给一次正常翻译扫描（缓存命中为主）
function redoTranslation() {
  if (!lastSnapshot.length) return;
  let applied = 0;
  for (const item of lastSnapshot) {
    if (!item.node.isConnected) continue;
    item.node.nodeValue = item.output;
    originals.set(item.node, { raw: item.raw, output: item.output });
    touched.add(item.node);
    applied++;
  }
  note('redo translation applied=' + applied + '/' + lastSnapshot.length);
  state.phase = 'idle';
  void translate();
}

function restore() {
  const snapshot: { node: Node; raw: string; output: string }[] = [];
  for (const node of touched) {
    const record = originals.get(node);
    if (record && node.isConnected) snapshot.push({ node, raw: record.raw, output: record.output });
  }
  if (snapshot.length) lastSnapshot = snapshot;
  generation++;
  state.phase = 'idle';
  walkTargets(document.body, node => {
    const record = originals.get(node);
    if (record && node.nodeValue === record.output) node.nodeValue = record.raw;
  });
  originals = new WeakMap();
  touched.clear();
  // 不清空 origToTr：它只是“译文缓存”，和页面当前显示什么无关。
  // 清掉会导致还原后再点「还原翻译」/悬停简介时全部重新请求（就是那 1 秒延迟）。
  attempted.clear();
  quickPending.clear();
  observer.disconnect();
  quickObserver.disconnect();
  void flushPersist();
  note('restore');
}

// 「重新翻译」：像第一次进页面一样，先洗掉本页的缓存再重翻
async function forgetPageTexts() {
  const keys: string[] = [];
  walkTargets(document.body, node => {
    const raw = node.nodeValue || '';
    const text = raw.trim();
    if (!text) return;
    if (origToTr.delete(text)) keys.push(text);
    origToTr.delete(normText(text));
    attempted.delete(text);
  });
  if (keys.length) {
    try { await backend.deleteCache(JSON.stringify({ keys })); } catch { /* ignore */ }
  }
  note('forget page texts=' + keys.length);
}

async function translate() {
  note('translate begin phase=' + state.phase);
  if (state.phase === 'busy') { note('translate skip: busy'); return; }
  dirty = false;
  const version = generation;
  const pending = new Map<string, Node[]>();
  try {
    walkTargets(document.body, node => {
      const raw = node.nodeValue || '';
      const text = raw.trim();
      if (originals.get(node)?.output === raw || !isTranslatable(text)) return;
      const cached = lookupCached(text);
      if (cached) apply(node, text, cached);
      else if (!attempted.has(text)) {
        let nodes = pending.get(text);
        if (!nodes) pending.set(text, nodes = []);
        nodes.push(node);
      }
    });
    // 全部命中缓存：不要亮“翻译中”，直接把页面填成译文就结束
    if (pending.size === 0) {
      state.phase = 'done';
      note('translate end pending=0 (all cached)');
      void flushPersist();
      return;
    }
    state.phase = 'busy';

    let incomplete = false;
    async function request(group: string[]): Promise<void> {
      if (generation !== version) { state.phase = 'idle'; return; }
      const res = await translateBounded(group, () => generation === version);
      if (generation !== version) { state.phase = 'idle'; return; }

      if (!Array.isArray(res.texts) || res.texts.length !== group.length ||
          !res.texts.every((s: unknown) => typeof s === 'string' && s.trim())) {
        if (group.length === 1) { incomplete = true; return; }
        const mid = Math.ceil(group.length / 2);
        await request(group.slice(0, mid));
        await request(group.slice(mid));
        return;
      }
      group.forEach((text, index) => {
        const tr = res.texts[index].trim();
        attempted.add(text);
        if (tr === text) {
          origToTr.set(text, text);
          origToTr.set(normText(text), text);
          return;
        }
        origToTr.set(text, tr);
        origToTr.set(normText(text), tr);
        queuePersist(text, tr);
        for (const node of pending.get(text)!) apply(node, text, tr);
      });
    }
    const keys = Array.from(pending.keys());
    for (let i = 0; i < keys.length && generation === version;) {
      const group = keys.slice(i, i + (i === 0 ? 4 : 20));
      i += group.length;
      await request(group);
    }
    if (generation !== version) { state.phase = 'idle'; return; }
    if (incomplete) {
      state.phase = 'done';
      observer.disconnect();
      showFailure('部分评论未收到完整译文，可右键选择「重新翻译」重试。');
      return;
    }
    state.phase = 'done';
    note('translate end pending=' + pending.size);
    void flushPersist();
    schedulePrefetch(version);
    if (dirty) schedule();
  } catch (e) {
    if (generation !== version) { state.phase = 'idle'; return; }
    state.phase = origToTr.size ? 'done' : 'idle';
    note('translate error: ' + String(e));
    observer.disconnect();
    showFailure();
  }
}

// ── 输入框一键翻译（手动触发，自选目标语言，和自动翻译无关） ──────────────
const LANGS = ['English', '简体中文', '繁體中文', '日本語', '한국어', 'Русский', 'Français', 'Deutsch', 'Español'];

const EDITABLE_SELECTOR = [
  'textarea',
  'input[type="text"]', 'input[type="search"]', 'input[type="url"]', 'input[type="email"]',
  'input:not([type])',
  '[contenteditable="true"]', '[contenteditable=""]',
].join(',');

let targetLang = 'English';
let inlineWrap: HTMLDivElement | null = null;
let inlineBtn: HTMLButtonElement | null = null;
let inlineSelect: HTMLSelectElement | null = null;
let inlineTarget: HTMLElement | null = null;
let inlineHideTimer: number | undefined;

async function refreshTargetLang() {
  try {
    const raw: unknown = await backend.getConfig();
    const cfg = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { targetLang?: string };
    if (cfg?.targetLang) {
      targetLang = cfg.targetLang;
      if (inlineSelect && !inlineSelect.value) inlineSelect.value = targetLang;
    }
  } catch { /* 读不到就沿用旧值 */ }
}

let toastEl: HTMLDivElement | null = null;
function showToast(text: string) {
  if (!toastEl || !toastEl.isConnected) {
    toastEl = document.createElement('div');
    toastEl.id = 'ds-tr-toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.style.display = 'block';
  window.clearTimeout((toastEl as any).__timer);
  (toastEl as any).__timer = window.setTimeout(() => { if (toastEl) toastEl.style.display = 'none'; }, 1800);
}

function editableOf(target: EventTarget | null): HTMLElement | null {
  const el = target as Element | null;
  if (!el || el.nodeType !== 1 || !(el as Element).closest) return null;
  const found = (el as Element).closest(EDITABLE_SELECTOR) as HTMLElement | null;
  if (!found) return null;
  // 插件自己的设置面板里不弹
  if (found.closest('#ds-tr-panel')) return null;
  if (found instanceof HTMLInputElement) {
    const type = (found.type || 'text').toLowerCase();
    if (!['text', 'search', 'url', 'email'].includes(type)) return null;
  }
  return found;
}

function readEditable(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  return el.innerText || '';
}

function writeEditable(el: HTMLElement, value: string) {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  // 富文本编辑器（Steam 聊天框）直接改 innerText 会被它的内部状态冲掉，
  // 用 execCommand 走一次“全选 + 插入”，编辑器才会同步
  try {
    el.focus();
    doc.execCommand('selectAll', false);
    const ok = doc.execCommand('insertText', false, value);
    if (!ok) {
      el.innerText = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }
  } catch {
    el.innerText = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }
}

function placeInline(el: HTMLElement) {
  if (!inlineWrap) return;
  const rect = el.getBoundingClientRect();
  inlineWrap.style.display = 'flex';
  // 贴在输入框右端、垂直居中，像一个内嵌按钮；太矮的输入框就放到上方
  const width = inlineWrap.offsetWidth || 120;
  const top = rect.height >= 28 ? rect.top + (rect.height - 24) / 2 : rect.top - 26;
  inlineWrap.style.top = Math.max(4, top) + 'px';
  inlineWrap.style.left = Math.max(4, rect.right - width - 6) + 'px';
}

function hideInline() {
  if (inlineWrap) inlineWrap.style.display = 'none';
  inlineTarget = null;
}

async function translateInline() {
  const el = inlineTarget;
  const btn = inlineBtn;
  if (!el || !btn) return;
  const text = readEditable(el).trim();
  if (!text) return;
  const lang = inlineSelect?.value || targetLang;
  const label = btn.textContent || '译';
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const raw: unknown = await backend.translateText(JSON.stringify({ text, lang }));
    const res = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { ok?: boolean; text?: string; error?: string };
    if (!res?.ok || !res.text) throw Error(res?.error || '翻译失败');
    const translated = res.text.trim();
    if (translated === text) {
      btn.textContent = '＝';
      showToast('原文已是' + lang);
      note('inline same as source, target=' + lang);
      window.setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 1200);
      return;
    }
    writeEditable(el, translated);
    btn.textContent = '✓';
    const expected = translated;
    window.setTimeout(() => {
      if (readEditable(el) !== expected) note('inline value reverted');
    }, 600);
    window.setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 900);
  } catch (e) {
    note('inline translate failed: ' + String(e));
    btn.textContent = '×';
    window.setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 1200);
    if (String(e).includes('NO_KEY')) showFailure('还没配置 API Key：右键 → API 设置…');
  }
}

function ensureInlineUI(): void {
  if (inlineWrap && inlineWrap.isConnected) return;

  const wrap = document.createElement('div');
  wrap.id = 'ds-tr-inline-wrap';

  const sel = document.createElement('select');
  sel.id = 'ds-tr-inline-lang';
  sel.title = '选择目标语言';
  for (const lang of LANGS) sel.add(new Option(lang, lang));
  sel.value = targetLang;
  sel.addEventListener('change', async () => {
    targetLang = sel.value;
    if (inlineBtn) inlineBtn.title = '翻译为' + targetLang;
    try { await backend.setConfig(JSON.stringify({ targetLang })); } catch { /* 保存失败不影响本次使用 */ }
  });

  const btn = document.createElement('button');
  btn.id = 'ds-tr-inline';
  btn.type = 'button';
  btn.textContent = '译';
  btn.style.display = 'block';
  btn.title = '翻译为' + targetLang;
  btn.addEventListener('mousedown', ev => { ev.preventDefault(); ev.stopPropagation(); });
  btn.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); openPanel(); });
  btn.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); void translateInline(); });

  wrap.append(sel, btn);
  document.body.appendChild(wrap);

  inlineWrap = wrap;
  inlineSelect = sel;
  inlineBtn = btn;
}

function setupInlineTranslator() {
  document.addEventListener('focusin', ev => {
    const el = editableOf(ev.target);
    if (!el) return;
    window.clearTimeout(inlineHideTimer);
    inlineTarget = el;
    ensureInlineUI();
    if (inlineBtn) { inlineBtn.disabled = false; inlineBtn.textContent = '译'; }
    if (inlineSelect) inlineSelect.value = targetLang;
    placeInline(el);
  }, true);

  document.addEventListener('focusout', () => {
    if (!inlineTarget) return;
    window.clearTimeout(inlineHideTimer);
    inlineHideTimer = window.setTimeout(() => {
      if (inlineWrap && inlineWrap.contains(document.activeElement)) return;
      hideInline();
    }, 200);
  }, true);

  window.addEventListener('scroll', () => hideInline(), true);
  window.addEventListener('resize', () => hideInline(), true);
}
// ── 预翻译工坊简介：悬停弹窗的内容是异步取的，提前翻好放进缓存，
//    这样第一次悬停也是秒出中文，且之后永远命中缓存 ────────────────────────
let prefetchDone = false;

let prefetchTimer: number | undefined;
const prefetchedIds = new Set<string>();

function normText(s: string) {
  return s.replace(/\s+/g, ' ').trim();
}

// 悬停简介经常被 Steam 截断（末尾带 …），和预取到的完整文本对不上，
// 所以查缓存时允许“缓存 key 以当前文本开头”的前缀匹配。
function lookupCached(text: string): string | undefined {
  const exact = origToTr.get(text) ?? origToTr.get(normText(text));
  if (exact) return exact;
  const needle = normText(text);
  if (needle.length < 20) return undefined;
  for (const [key, value] of origToTr) {
    if (normText(key).startsWith(needle)) return value;
  }
  return undefined;
}

async function translateAndCache(texts: string[]) {
  const list = texts.filter(x => x && !lookupCached(x)).slice(0, 40);
  if (!list.length) return;
  for (let i = 0; i < list.length; i += 20) {
    const group = list.slice(i, i + 20);
    try {
      const res = await translateBounded(group, () => true);
      if (!res || !Array.isArray(res.texts) || res.texts.length !== group.length) continue;
      group.forEach((text, index) => {
        const tr = (res.texts[index] || '').trim();
        if (!tr || tr === text) return;
        origToTr.set(text, tr);
        origToTr.set(normText(text), tr);
        queuePersist(text, tr);
      });
    } catch { /* ignore */ }
  }
  void flushPersist();
}

async function previewTextsOf(id: string): Promise<string[]> {
  try {
    const res = await fetch('/sharedfiles/getitempreview/?id=' + id, { credentials: 'include' });
    if (res.status === 403) { note('prefetch throttled 403'); return []; }
    if (!res.ok) { note('prefetch http ' + res.status + ' id=' + id); return []; }
    const html = await res.text();
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const out: string[] = [];
    parsed.body?.querySelectorAll('*').forEach(node => {
      if ((node as Element).childElementCount > 0) return;
      const text = (node.textContent || '').trim();
      if (!isTranslatable(text)) return;
      if (out.indexOf(text) < 0) out.push(text);
    });
    return out;
  } catch (e) {
    note('prefetch fetch error id=' + id + ': ' + String(e));
    return [];
  }
}

// 悬停预热队列：鼠标一进卡片就先把简介翻好，等浮窗弹出来时直接命中缓存
const warmQueue: string[] = [];
let warming = false;
async function drainWarm() {
  if (warming) return;
  warming = true;
  while (warmQueue.length) {
    const id = warmQueue.shift()!;
    const texts = await previewTextsOf(id);
    if (texts.length) await translateAndCache(texts);
    await new Promise(r => window.setTimeout(r, 150));
  }
  warming = false;
}

function warmItem(id: string, priority = false) {
  if (prefetchedIds.has(id)) return;
  prefetchedIds.add(id);
  if (priority) warmQueue.unshift(id); else warmQueue.push(id);
  void drainWarm();
}

// 把当前视野附近的卡片全部排队预热（还原翻译/翻译完成后立刻做）
function warmVisible() {
  const ids: string[] = [];
  document.querySelectorAll('a[href*="filedetails/?id="]').forEach(a => {
    const rect = (a as HTMLElement).getBoundingClientRect();
    if (rect.bottom < -400 || rect.top > window.innerHeight * 1.5) return;
    const m = /[?&]id=(\d+)/.exec((a as HTMLAnchorElement).href || '');
    if (m && !prefetchedIds.has(m[1])) ids.push(m[1]);
  });
  ids.slice(0, 40).forEach(id => warmItem(id));
}

function installHoverWarm() {
  if ((window as unknown as { __dsTrHoverWarm?: boolean }).__dsTrHoverWarm) return;
  (window as unknown as { __dsTrHoverWarm?: boolean }).__dsTrHoverWarm = true;
  document.addEventListener('mouseover', ev => {
    const el = ev.target as Element | null;
    const link = el?.closest?.('a[href*="filedetails/?id="]') as HTMLAnchorElement | null;
    if (!link) return;
    const m = /[?&]id=(\d+)/.exec(link.href || '');
    if (m) warmItem(m[1], true);
  }, true);
}

async function prefetchPreviews(version: number) {
  if (!/(^|\.)steamcommunity\.com$/.test(location.hostname)) return;
  if (!/workshop|\/sharedfiles\//i.test(location.pathname)) return;

  const ids: string[] = [];
  document.querySelectorAll('a[href*="filedetails/?id="]').forEach(a => {
    const rect = (a as HTMLElement).getBoundingClientRect();
    if (rect.bottom < -300 || rect.top > window.innerHeight * 1.5) return;
    const m = /[?&]id=(\d+)/.exec((a as HTMLAnchorElement).href || '');
    if (m && !prefetchedIds.has(m[1])) ids.push(m[1]);
  });
  const list = ids.slice(0, 8);
  if (!list.length) return;
  list.forEach(id => prefetchedIds.add(id));
  note('prefetch start ids=' + list.length);

  for (const id of list) {
    if (generation !== version) { state.phase = 'idle'; return; }
    const texts = await previewTextsOf(id);
    if (texts.length) await translateAndCache(texts);
    await new Promise(r => window.setTimeout(r, 150));
    await new Promise(r => window.setTimeout(r, 180));
  }
  note('prefetch done cached=' + origToTr.size);
}

function schedulePrefetch(version: number) {
  installHoverWarm();
  warmVisible();
  void prefetchPreviews(version);
  if (prefetchTimer !== undefined) return;
  prefetchTimer = window.setInterval(() => {
    if (state.phase !== 'done') return;
    warmVisible();
  }, 5000);
  // 滚动后新出现的卡片也补进预热队列
  window.addEventListener('scroll', () => {
    if (state.phase !== 'done') return;
    warmVisible();
  }, { passive: true });
}
function watchForRerender() {
  observer = new MutationObserver(schedule);
  // 后出现的内容（悬停简介等）单独走快通道，不受 settle 的 250ms/20 条限制
  quickObserver = new MutationObserver(mutations => {
    if (state.phase !== 'done') return;
    const added: Node[] = [];
    for (const m of mutations) {
      if (m.type === 'childList') m.addedNodes.forEach(n => added.push(n));
      else if (m.type === 'characterData' && m.target) added.push(m.target);
    }
    quickScan(added);
  });
  quickObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
}

// 自测：URL 带 &dstrtest=1（自造 textarea）或 &dstrtest=2（用页面真实搜索框），
// 自动点一次「译」并把结果写日志。平时不触发。
async function inlineSelfTest() {
  const mode = new URLSearchParams(location.search).get('dstrtest');
  if (!mode) return;
  window.setTimeout(async () => {
    let box: HTMLElement | null = null;
    if (mode === '2') {
      box = document.querySelector('input[type="search"], input[type="text"], input[name="search"]') as HTMLElement | null;
    }
    if (!box) {
      const area = document.createElement('textarea');
      area.style.cssText = 'position:fixed;left:20px;top:220px;width:320px;height:90px;z-index:2147483647';
      document.body.appendChild(area);
      box = area;
    }
    const seed = (mode === '3' || mode === '4') ? '传送门' : 'Hello, this is a test message from the workshop comment box.';
    writeEditable(box, seed);
    box.focus();
    box.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    const sel = document.getElementById('ds-tr-inline-lang') as HTMLSelectElement | null;
    if (mode === '4' && sel) {
      sel.value = 'English';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
    }
    const btn = document.getElementById('ds-tr-inline') as HTMLButtonElement | null;
    const wrap = document.getElementById('ds-tr-inline-wrap');
    let geo = 'none';
    if (wrap) {
      const r = wrap.getBoundingClientRect();
      const cs = getComputedStyle(wrap);
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      geo = cs.display + ' ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' hit=' + (hit ? hit.id || hit.tagName : 'null');
    }
    let bgeo = 'none';
    if (btn) {
      const br = btn.getBoundingClientRect();
      const cs2 = getComputedStyle(btn);
      const hit2 = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
      bgeo = cs2.display + ' ' + Math.round(br.left) + ',' + Math.round(br.top) + ' ' + Math.round(br.width) + 'x' + Math.round(br.height) + ' hit=' + (hit2 ? hit2.id || hit2.tagName : 'null');
    }
    note('selftest mode=' + mode + ' box=' + box.tagName + ' wrap=' + geo + ' btn=' + bgeo);
    if (!btn) return;
    btn.click();
    await new Promise(r => setTimeout(r, 1500));
    note('selftest t1=' + JSON.stringify(readEditable(box)).slice(0, 180));
    await new Promise(r => setTimeout(r, 3500));
    note('selftest t4=' + JSON.stringify(readEditable(box)).slice(0, 180));
  }, 3000);
}
export default async function main() {
  log('preload attached', location.href);
  try {
    await backend.noteFromWeb('preload ' + location.href);
  } catch (e) {
    log('note failed', String(e));
  }
  if (!isSteamPage()) return;

  ensureStyle();
  setupInlineTranslator();
  void refreshTargetLang();
  window.setInterval(() => { void refreshTargetLang(); }, 20000);
  watchForRerender();
  await hydrateCache();

  document.addEventListener(
    'contextmenu',
    (ev) => {
      if (!isSteamPage()) return;
      ev.preventDefault();
      ev.stopPropagation();
      showMenu(ev.clientX, ev.clientY);
    },
    true,
  );

  document.addEventListener('mousedown', (ev) => {
    const menu = document.getElementById('ds-tr-menu');
    if (menu && !menu.contains(ev.target as Node)) hideMenu();
  });

  document.addEventListener(
    'click',
    async (ev) => {
      const target = ev.target as Node;
      const action = document.getElementById('ds-tr-action');
      const cfg = document.getElementById('ds-tr-cfg');

      if (action && action.contains(target)) {
        ev.preventDefault();
        ev.stopPropagation();
        if (state.phase === 'busy') return;
        hideMenu();
        note('menu action mode=' + (action.dataset.mode || '?'));
        if (action.dataset.mode === 'restore') {
          restore();
          return;
        }
        // 还原之后出现的「重新翻译」：按第一次翻译处理，先清掉本页缓存
        if (lastSnapshot.length) {
          await forgetPageTexts();
          lastSnapshot = [];
        }
        await translate();
        return;
      }


      const redoItem = document.getElementById('ds-tr-redo');
      if (redoItem && redoItem.contains(target)) note('redo clicked');
      if (redoItem && redoItem.contains(target)) {
        ev.preventDefault();
        ev.stopPropagation();
        hideMenu();
        redoTranslation();
        return;
      }

      if (cfg && cfg.contains(target)) {
        ev.preventDefault();
        ev.stopPropagation();
        hideMenu();
        openPanel();
      }
    },
    true,
  );

  window.addEventListener('scroll', () => hideMenu(), true);
  window.addEventListener('resize', () => hideMenu(), true);
  window.addEventListener('ds-tr-cache-cleared', () => { origToTr.clear(); attempted.clear(); });
  window.addEventListener('pagehide', () => { void flushPersist(); });

  // 刚启动时 backend 可能还没就绪，读配置失败就重试几次
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const raw = await backend.getConfig();
      const config = typeof raw === 'string' ? JSON.parse(raw) : raw;
      autoTranslate = config.autoTranslate === true;
      break;
    } catch (e) {
      if (attempt === 3) note('无法读取自动翻译设置: ' + String(e));
      else await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  preferenceReady = true;
  const toggle = field('ds-tr-auto');
  if (toggle) { toggle.checked = autoTranslate; toggle.disabled = false; }
  if (autoTranslate && isSteamPage()) {
    void translate();
    // 页面可能还没渲染完，2.5 秒后如果没在翻译就再补一次
    window.setTimeout(() => { if (state.phase === 'idle' && !lastSnapshot.length) void translate(); }, 2500);
  }
  void inlineSelfTest();
}
