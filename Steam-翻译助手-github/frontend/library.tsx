import { translateBounded } from '../shared/translate';
import { menuUI } from '../shared/menu';
import { installInline } from '../shared/inline';
import { automaticTranslationEnabled, isPageTextCandidate, privateFields, renderedTranslation, translationContext } from '../shared/policy';
import { deleteScopedCache, lookupScopedCache, putScopedCache } from '../shared/scoped-cache';
import { addSelectionAction } from '../shared/selection';
import { definePlugin } from 'millennium';
import { SettingsContent } from './index';

type Popup = { window?: Window };
const skippedText = `script,style,textarea,[contenteditable],code,pre,[aria-expanded],#ds-tr-inline-wrap,#ds-tr-menu,#ds-tr-toast,#ds-tr-selection-result,${privateFields}`;
type Manager = {
  m_mapPopups: Map<string, Popup>;
  AddPopupCreatedCallback(cb: (popup: Popup) => void): { unregister(): void };
};

export default definePlugin(() => {
  const controller = new AbortController();
  const { signal } = controller;
  const attached = new WeakSet<Document>();
  const originals = new WeakMap<Text, { raw: string; output: string }>();

  const menus = new Set<HTMLElement>();
  function attach(win?: Window) {
    if (!win) return;
    const doc = win.document;
    if (attached.has(doc)) return;
    attached.add(doc);
    let autoFlag = false;
    // 上一次「还原原文」之前保存的译文快照，用于「还原翻译」
    let snapshot: { node: Text; raw: string; output: string }[] = [];
    const ui = menuUI(doc);
    installInline(doc, msg => { backend.noteFromWeb('inline: ' + msg).catch(() => undefined); }, signal);
    let menu: HTMLElement | undefined;
    function close() {
      if (menu) { menu.remove(); menus.delete(menu); menu = undefined; }
    }
    let active: Element | undefined;
    let activeContext = '';
    let observer: MutationObserver | undefined;
    let version = 0;
    let running = false;
    let dirty = false;
    let failure = '';
    let cacheScope = '';
    let pageLanguage = '简体中文';
    let displayMode: 'replace' | 'bilingual' = 'replace';
    let cacheClearPending = false;
    let cacheImportPending = false;
    const cache = new Map<string, string>();
    // 归一化索引：把多空白压成单空格，解决网页侧/客户端侧同一句话
    // 因为换行、缩进不同而 cache miss 的问题。
    const cacheNorm = new Map<string, string>();
    const normKey = (s: string) => s.replace(/\s+/g, ' ').trim();
    // 与网页侧共用同一个磁盘缓存：启动时装载，翻译后回写，
    // 否则库内界面每次开 Steam 都要重新翻一遍。
    const pendingPersist = new Map<string, string>();
    let persistTimer: number | undefined;
    let pendingPersistScope = '';
    function queuePersist(key: string, value: string) {
      if (pendingPersist.size && pendingPersistScope !== cacheScope) void flushPersist();
      if (!pendingPersist.size) pendingPersistScope = cacheScope;
      pendingPersist.set(key, value);
      if (persistTimer !== undefined) return;
      persistTimer = win!.setTimeout(() => { persistTimer = undefined; void flushPersist(); }, 1200);
    }
    async function flushPersist() {
      if (!pendingPersist.size) return;
      const entries: Record<string, string> = Object.create(null);
      for (const [k, v] of pendingPersist) entries[k] = v;
      const scope = pendingPersistScope;
      pendingPersist.clear();
      pendingPersistScope = '';
      try { await putScopedCache(entries, scope); } catch { /* ignore */ }
    }
    const cacheReady = (async () => {
      try {
        const raw: unknown = await (backend as any).getPublicConfig();
        const cfg = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { scope?: string; displayMode?: string; pageTargetLang?: string };
        cacheScope = cfg?.scope || '';
        pageLanguage = cfg?.pageTargetLang || '简体中文';
        displayMode = cfg?.displayMode === 'bilingual' ? 'bilingual' : 'replace';
      } catch { /* cache is unavailable until settings can be read */ }
    })();

    function stop() {
      version++;
      observer?.disconnect();
      active = undefined;
      activeContext = '';
      running = dirty = false;
      cache.clear();
      cacheNorm.clear();
      failure = '';
    }

    function scan(root: Element) {
      const pending = new Map<string, Text[]>();
      const translated: Text[] = [];
      const walker = root.ownerDocument.createTreeWalker(root, 4);
      for (let n = walker.nextNode() as Text; n; n = walker.nextNode() as Text) {
        if (n.parentElement?.closest(skippedText)) continue;
        if (originals.get(n)?.output === n.data) { translated.push(n); continue; }
        const key = n.data.trim();
        if (!isPageTextCandidate(key, pageLanguage)) continue;
        if (!pending.has(key)) pending.set(key, []);
        pending.get(key)!.push(n);
      }
      return { pending, translated };
    }

    async function update() {
      dirty = true;
      if (running || !active) return;
      running = true;
      const root = active;
      const epoch = version;
      await cacheReady;
      if (version !== epoch) return;
      const scope = cacheScope;
      const context = activeContext;
      const current = () => version === epoch && root.isConnected && cacheScope === scope && !signal.aborted
        && translationContext(doc, root).key === context;
      try {
        while (dirty && current()) {
          dirty = false;
          const { pending } = scan(root);
          function apply(key: string, tr: string) {
            for (const n of pending.get(key)!) {
              if (!root.contains(n) || n.data.trim() !== key) continue;
              const output = renderedTranslation(n.data, tr, displayMode);
              originals.set(n, {raw: n.data, output});
              if (n.data !== output) n.data = output;
            }
          }
          const pendingKeys = Array.from(pending.keys());
          const lookupKeys = pendingKeys.flatMap(key => [key, normKey(key)]);
          const stored = await lookupScopedCache(lookupKeys, scope);
          if (!current()) return;
          const keys: string[] = [];
          for (const key of pending.keys()) {
            const normalized = normKey(key);
            const hit = cache.get(key) ?? cacheNorm.get(normalized) ?? stored[key] ?? stored[normalized];
            if (hit) {
              cache.set(key, hit);
              cacheNorm.set(normalized, hit);
              apply(key, hit);
            } else keys.push(key);
          }
          async function request(batch: string[]): Promise<void> {
            if (!current()) return;
            void backend.noteFromWeb('fe req n=' + batch.length).catch(() => undefined);
            const res = await translateBounded(batch, current, { scope });
            if (!current()) return;

            if (!Array.isArray(res.texts) || res.texts.length !== batch.length ||
                !res.texts.every((s: unknown) => typeof s === 'string' && s.trim())) {
              if (batch.length === 1) throw Error('未收到此段的完整译文');
              const mid = Math.ceil(batch.length / 2);
              await request(batch.slice(0, mid));
              await request(batch.slice(mid));
              return;
            }
            batch.forEach((key, i) => {
              const tr = res.texts[i].trim();
              cache.set(key, tr);
              cacheNorm.set(normKey(key), tr);
              queuePersist(key, tr);
              queuePersist(normKey(key), tr);
              apply(key, tr);
            });
          }
          for (let i = 0; i < keys.length && current();) {
            const batch = keys.slice(i, i + (i ? 16 : 4));
            i += batch.length;
            await request(batch);
          }
        }
      } catch (err) {
        if (current()) {
          failure = String(err);
          observer?.disconnect();
          ui.showFailure();
        }
      } finally { if (epoch === version) running = false; }
    }

    const suppressed = new WeakSet<Element>();
    let last: Element | null | undefined;
    // 用户点了「还原原文」后，当前页面不要再被自动翻译接管；
    // 换游戏/换页面（详情容器或 appid 变了）才恢复自动翻译。
    let restoreGuard: { root: Element; details: Element | null; appid: string | null } | null = null;
    function appIdOf(details: Element | null): string | null {
      if (!details) return null;
      const withId = details.querySelector('[data-appid]');
      return details.getAttribute('data-appid') || withId?.getAttribute('data-appid') || null;
    }
    let check = 0;
    let timer: number | undefined;
    let automatic = false;

    // 「重新翻译」= 像第一次进页面一样：先清掉这个根下的缓存，再完整重翻
    async function forgetRootTexts(root: Element) {
      const keys = new Set<string>();
      const scanned = scan(root);
      for (const k of scanned.pending.keys()) keys.add(k);
      for (const node of scanned.translated) {
        const record = originals.get(node);
        if (record) {
          const raw = record.raw.trim();
          if (raw) keys.add(raw);
        }
      }
      let removed = 0;
      for (const k of keys) {
        if (cache.delete(k)) removed++;
        cacheNorm.delete(normKey(k));
      }
      if (keys.size) {
        for (const key of Array.from(keys)) keys.add(normKey(key));
        try { await deleteScopedCache(Array.from(keys), cacheScope); } catch { /* ignore */ }
      }
      void backend.noteFromWeb('fe forget texts=' + keys.size + ' removed=' + removed).catch(() => undefined);
    }
    function start(root: Element) {
      stop();
      active = root;
      activeContext = translationContext(doc, root).key;
      // 同样避开 React 提交阶段：下一帧再扫，否则展开/折叠状态会被回滚
      observer = new MutationObserver(() => { win!.requestAnimationFrame(() => { void update(); }); });
      observer.observe(root, {subtree: true, childList: true, characterData: true});
      return update();
    }
    // 刚启动时 backend 可能还没就绪
    async function configWithRetry(tries = 4): Promise<any> {
      for (let i = 0; i < tries; i++) {
        try {
          const raw = await (backend as any).getPublicConfig();
          return typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (e) {
          if (i === tries - 1) throw e;
          await new Promise(r => win!.setTimeout(r, 600 * (i + 1)));
        }
      }
      return {};
    }

    // 当前窗口该翻哪个根：
    //  - 详情页可见 → MainPanel（左侧列表 + 右侧详情）
    //  - 聊天窗口   → body
    //  - 其他（库首页/好友列表）→ null，不自动翻
    function currentRoot(): Element | null {
      if (/好友列表|friends\s*list/i.test(doc.title || '')) return null;
      const details = doc.querySelector('.AppDetailsMain') as HTMLElement | null;
      if (details && details.offsetParent) {
        return (doc.querySelector('.MainPanel') as Element) || details;
      }
      if (doc.querySelector('.chatTextarea, .chatHistory, [class*="chatHistory"]')) return doc.body;
      return null;
    }

    function restoreRoot(root: Element) {
      for (const node of scan(root).translated) {
        const record = originals.get(node);
        if (!record) continue;
        node.data = record.raw;
        originals.delete(node);
      }
    }

    async function refreshSettings() {
      const clearOnly = cacheClearPending && !cacheImportPending;
      const cacheImported = cacheImportPending;
      cacheClearPending = false;
      cacheImportPending = false;
      let cfg: any;
      try { cfg = await configWithRetry(); } catch { return; }
      const root = active || currentRoot();
      const wasActive = !!active;
      const wasAutomatic = automatic;
      const oldScope = cacheScope;
      const oldDisplayMode = displayMode;
      const nextScope = typeof cfg.scope === 'string' ? cfg.scope : '';
      cacheScope = nextScope;
      pageLanguage = cfg.pageTargetLang || '简体中文';
      displayMode = cfg.displayMode === 'bilingual' ? 'bilingual' : 'replace';
      const enabled = root ? automaticTranslationEnabled(cfg, translationContext(doc, root)) : cfg.autoTranslate === true;
      autoFlag = enabled;
      const settingsChanged = oldScope !== cacheScope || oldDisplayMode !== displayMode;
      if (clearOnly) {
        cache.clear();
        cacheNorm.clear();
        running = false;
        dirty = false;
        return;
      }
      if (settingsChanged) {
        void flushPersist();
        cache.clear();
        cacheNorm.clear();
        snapshot = [];
      }
      if (wasActive && root && (settingsChanged || wasAutomatic !== enabled)) {
        restoreRoot(root);
        stop();
        const shouldResume = settingsChanged ? (enabled || (!wasAutomatic && (oldScope === cacheScope || cacheImported))) : enabled;
        if (shouldResume && root.isConnected) {
          automatic = enabled;
          suppressed.delete(root);
          await start(root);
        } else {
          automatic = false;
        }
      } else if (!wasActive && root && enabled) {
        automatic = true;
        suppressed.delete(root);
        await start(root);
      }
    }

    async function discover(force = false): Promise<void> {
      // 好友列表窗口不自动翻译（会把人名翻掉），聊天窗口不在此列
      if (/好友列表|friends\s*list/i.test(doc.title || '')) return;
      // 自动翻译只作用于「游戏详情页」和「聊天窗口」。
      // 库首页（最近游玩、货架）不自动翻，避免把主页文字翻掉、也避免还原失效。
      const root: Element | null = currentRoot();
      if (!root) {
        if (automatic && active) { stop(); automatic = false; }
        return;
      }
      const context = translationContext(doc, root);
      if (active && active === root && activeContext !== context.key) {
        stop();
        snapshot = [];
        automatic = false;
      }
      // 已经在这个 root 上自动翻译时才跳过；否则（被还原过/换过页）继续接管
      if (!force && root === last && active === root) return;
      last = root;
      const ticket = ++check;
      try {
        const cfg = await configWithRetry();
        if (ticket !== check || signal.aborted || !root.isConnected || translationContext(doc, root).key !== context.key) return;
        const priorScope = cacheScope;
        cacheScope = typeof cfg.scope === 'string' ? cfg.scope : cacheScope;
        pageLanguage = cfg.pageTargetLang || '简体中文';
        displayMode = cfg.displayMode === 'bilingual' ? 'bilingual' : 'replace';
        if (priorScope !== cacheScope) { cache.clear(); cacheNorm.clear(); }
        autoFlag = automaticTranslationEnabled(cfg, context);
        if (autoFlag) {
          if (restoreGuard) {
            const detailsNow = win!.document.querySelector('.AppDetailsMain');
            const samePage = restoreGuard.root === root
              && detailsNow === restoreGuard.details
              && appIdOf(detailsNow) === restoreGuard.appid;
            if (samePage) return;      // 同一页面被还原过：保持原文
            restoreGuard = null;       // 换页了，恢复自动翻译
          }
          // 自动翻译开着就是最高优先级：换了界面/新内容都重新接管
          if (active !== root) {
            automatic = true;
            suppressed.delete(root);
            await start(root);
          }
        } else {
          if (automatic) { stop(); automatic = false; }
          if (suppressed.has(root) || (active?.isConnected && !automatic && active !== root)) return;
        }
      } catch { /* Keep the manual translation action available. */ }
    }
    const discovery = new MutationObserver(() => {
      if (timer !== undefined) return;
      timer = win.setTimeout(() => { timer = undefined; void discover(); }, 180);
    });
    discovery.observe(doc, {childList: true, subtree: true, attributes: true, attributeFilter: ['data-appid']});

    // 列表虚拟滚动会重建节点：新节点一出现就用缓存立刻回填，
    // 避免“滑走闪回原文、滑回来再翻一次”；还原之后（active 为空）停止补翻。
    function applyCachedText(node: Node) {
      if ((node.nodeType === 1 ? node as Element : node.parentElement)?.closest(skippedText)) return;
      if (node.nodeType === 3) {
        const raw = node.nodeValue || '';
        const text = raw.trim();
        if (!text) return;
        const tr = cache.get(text);
        if (!tr || tr === text) return;
        const record = originals.get(node as Text);
        if (record && record.output === raw) return;
        const output = renderedTranslation(raw, tr, displayMode);
        originals.set(node as Text, { raw, output });
        (node as Text).data = output;
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node as Element;
      const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = walker.nextNode())) applyCachedText(n);
    }

    let applyRaf = 0;
    const pendingApply: Node[] = [];
    const cacheApplier = new MutationObserver(mutations => {
      if (!active) return;
      for (const m of mutations) {
        m.addedNodes.forEach(n => { if (n.isConnected) pendingApply.push(n); });
      }
      if (applyRaf) return;
      // 等到下一帧再改文本：在 React 提交阶段同步改 DOM 会打断它自己的更新，
      // 表现为列表展开后状态被回滚、要点两下才折叠。
      applyRaf = win!.requestAnimationFrame(() => {
        applyRaf = 0;
        const batch = pendingApply.splice(0);
        if (!active || translationContext(doc, active).key !== activeContext) return;
        for (const n of batch) { if (active.contains(n)) applyCachedText(n); }
      });
    });
    cacheApplier.observe(doc.body, { childList: true, subtree: true });
    signal.addEventListener('abort', () => cacheApplier.disconnect(), { once: true });
    void discover();
    const firstRetry = win.setTimeout((): void => { void discover(true); }, 2500);
    const secondRetry = win.setTimeout((): void => { void discover(true); }, 7000);
    // 自动翻译开着时定期兜底，防止某次 stop/还原后不再接管
    const discoverTimer = win.setInterval((): void => { void discover(); }, 4000);
    win.addEventListener('focus', () => void discover(true), {signal});
    win.addEventListener('ds-tr-settings-changed', () => { void refreshSettings(); }, {signal});
    function cleanup() {
      check++;
      discovery.disconnect();
      win?.clearTimeout(timer);
      win?.clearTimeout(firstRetry);
      win?.clearTimeout(secondRetry);
      win?.clearInterval(discoverTimer);
      win?.clearTimeout(persistTimer);
      if (applyRaf) win?.cancelAnimationFrame(applyRaf);
      void flushPersist();
      ui.closePanel();
      stop();
      close();
    }
    signal.addEventListener('abort', cleanup, {once: true});
    win.addEventListener('mousedown', e => { if (e.button !== 2 && !menu?.contains(e.target as Node)) close(); }, { capture: true, signal });
    win.addEventListener('pagehide', cleanup, { signal });
    let ownsRightClick = false;
    function consume(e: Event) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    function consumeRightButton(e: MouseEvent) {
      if (ownsRightClick && e.button === 2) consume(e);
    }
    // Millennium 设置页：找到写着 “MILLENNIUM” 的那个可见标题，
    // 再往上找一个同时包含它的容器，用来判断右键是否落在设置面板里。
    function millenniumContainerFor(el: Element): Element | null {
      const nodes = doc.querySelectorAll('span, div, h1, h2, h3');
      for (const node of Array.from(nodes)) {
        const candidate = node as HTMLElement;
        if (candidate.children.length) continue;
        if (!/^MILLENNIUM$/i.test((candidate.textContent || '').trim())) continue;
        if (!candidate.offsetParent) continue;
        let parent: Element | null = candidate;
        for (let i = 0; parent && i < 9; i++, parent = parent.parentElement) {
          if (parent.contains(el)) return parent;
        }
      }
      return null;
    }

    function openMenu(e: MouseEvent) {
      if (e.shiftKey && e.button === 2) { ownsRightClick = false; return; }
      if (e.type === 'pointerdown') ownsRightClick = false;
      if (e.type === 'contextmenu' && (menu?.contains(e.target as Node) || (ownsRightClick && e.button === 2))) {
        void backend.noteFromWeb('cm early: ' + (menu?.contains(e.target as Node) ? 'inside-menu' : 'ownsRightClick') + ' menu=' + !!menu).catch(() => undefined);
        ownsRightClick = false;
        consume(e);
        return;
      }
      if (e.type === 'pointerdown' && e.button !== 2) return;
      const el = e.target as Element;
      if (!el?.closest) return;
      if (el.closest(`#ds-tr-selection-result,${privateFields}`)) return;
      // 聊天窗口没有“页面”概念；Millennium 设置页也不在组件选择器里。
      // 这两种情况下允许右键出菜单，但输入框里保留 Steam 自带菜单。
      const inEditable = !!(el.closest && el.closest('textarea, input, [contenteditable]'));
      if (inEditable) return;
      const settingsRoot = inEditable ? null : millenniumContainerFor(el);
      // 只接管「游戏详情页（AppDetailsMain 内部）/ 弹窗 / 聊天 / Millennium 设置页」。
      // 库首页、左侧游戏列表这类地方 Steam 自带右键菜单有实用功能（收藏、属性、隐藏），不能抢。
      const root = settingsRoot ? (settingsRoot as Element) : currentRoot();
            // 只在“有翻译根”的地方接管：详情页、聊天窗口、Millennium 设置页。
      // 库首页 / 好友列表保留 Steam 原生右键菜单。
      if (!root) return;
      ownsRightClick = e.type === 'pointerdown';
      consume(e);
      close();
      const context = settingsRoot
        ? { key: 'steam:other', label: 'Steam 设置', fallbackKeys: ['steam:other'] }
        : translationContext(doc, root);
      const { translated, pending } = scan(root);
      void backend.noteFromWeb('cm scan pending=' + pending.size + ' translated=' + translated.length).catch(() => undefined);
      ui.ensureStyle();
      const box = ui.buildMenu(autoFlag, true, enabled => {
        check++;
        close();
        autoFlag = enabled;
        void backend.noteFromWeb('auto changed=' + enabled + ' root=' + (root ? (root.tagName + '.' + String(root.className || '').slice(0, 30)) : 'null')).catch(() => undefined);
        if (enabled) {
          automatic = true;
          suppressed.delete(root);
          void start(root);
        } else { stop(); automatic = false; }
      }, context.key, context.label + ' · ');
      addSelectionAction(doc, box, close);
      menu = box;
      menus.add(box);
      root.ownerDocument.body.appendChild(box);
      void backend.noteFromWeb('cm appended').catch(() => undefined);
      const toggle = box.querySelector<HTMLInputElement>('#ds-tr-auto')!;
      void (backend as any).getPublicConfig().then((raw: unknown) => {
        const config = typeof raw === 'string' ? JSON.parse(raw) : raw;
        // 用户刚点过就以用户的为准，别用旧配置把它盖回未勾选
        if (toggle.dataset.userToggled !== '1') toggle.checked = automaticTranslationEnabled(config, context);
        toggle.disabled = false;
      }).catch(() => { toggle.title = '读取设置失败'; });
      const retry = active === root && !!failure;
      const restore = !retry && (active === root || (!pending.size && translated.length > 0));
      const busy = active === root && running;
      const action = box.querySelector<HTMLElement>('#ds-tr-action')!;
      action.textContent = busy ? '翻译中…' : retry ? '重试翻译' : restore ? '还原原文' : (snapshot.length ? '重新翻译' : '翻译此页');
      action.dataset.mode = restore ? 'restore' : 'translate';
      if (retry) action.title = failure;
      action.classList.toggle('disabled', busy || (!restore && !pending.size));

      const redo = box.querySelector<HTMLElement>('#ds-tr-redo')!;
      redo.classList.toggle('hidden', busy || restore || !snapshot.length);
      redo.onclick = () => {
        close();
        let applied = 0;
        for (const item of snapshot) {
          if (!item.node.isConnected || item.node.data !== item.raw) continue;
          item.node.data = item.output;
          originals.set(item.node, { raw: item.raw, output: item.output });
          applied++;
        }
        void backend.noteFromWeb('redo applied=' + applied + '/' + snapshot.length).catch(() => undefined);
        // 恢复快照后继续补扫：新增/被重绘的节点用缓存补上，
        // 否则“还原翻译”后只有旧节点变回中文，其余仍是英文。
        restoreGuard = null;
        if (!root.isConnected) return;
        automatic = false;
        suppressed.delete(root);
        void start(root);
      };
      box.querySelector<HTMLElement>('#ds-tr-cfg')!.onclick = () => { close(); ui.openPanel(); };
      box.style.display = 'block';
      void backend.noteFromWeb('cm menu shown at ' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ' size=' + box.offsetWidth + 'x' + box.offsetHeight).catch(() => undefined);
      box.style.left = Math.max(0, Math.min(e.clientX, win!.innerWidth - box.offsetWidth - 6)) + 'px';
      box.style.top = Math.max(0, Math.min(e.clientY, win!.innerHeight - box.offsetHeight - 6)) + 'px';
      action.onclick = async () => {
        if (action.classList.contains('disabled')) return;
        check++;
        automatic = false;
        stop();
        if (action.dataset.mode === 'restore') {
          suppressed.add(root);
          const detailsNow = doc.querySelector('.AppDetailsMain');
          restoreGuard = { root, details: detailsNow, appid: appIdOf(detailsNow) };
          const saved: { node: Text; raw: string; output: string }[] = [];
          for (const n of scan(root).translated) {
            const record = originals.get(n);
            if (record) saved.push({ node: n, raw: record.raw, output: record.output });
            n.data = record ? record.raw : n.data;
            originals.delete(n);
          }
          if (saved.length) snapshot = saved;
          close();
          return;
        }
        suppressed.delete(root);
        restoreGuard = null;
        close();
        // 还原之后出现的「重新翻译」：按第一次翻译处理，先清掉本页缓存
        if (snapshot.length) {
          await forgetRootTexts(root);
          snapshot = [];
        }
        await start(root);
      };
    }
    win.addEventListener('pointerdown', openMenu, { capture: true, signal });
    win.addEventListener('ds-tr-cache-cleared', () => {
      cache.clear();
      cacheNorm.clear();
      cacheClearPending = true;
      version++;
      running = false;
    }, {signal});
    win.addEventListener('ds-tr-cache-imported', () => {
      cache.clear();
      cacheNorm.clear();
      cacheImportPending = true;
      version++;
      running = false;
    }, {signal});
    for (const type of ['mousedown', 'mouseup', 'pointerup', 'auxclick'] as const) {
      win.addEventListener(type, consumeRightButton, { capture: true, signal });
    }
    win.addEventListener('contextmenu', openMenu, { capture: true, signal });
  }

  attach(window);
  const manager = (window as Window & {g_PopupManager?: Manager}).g_PopupManager;
  const hook = manager?.AddPopupCreatedCallback(p => attach(p.window));
  manager?.m_mapPopups.forEach(p => attach(p.window));
  return { icon: <span>译</span>, title: 'Steam 翻译助手', content: <SettingsContent />, onDismount() {
    controller.abort();
    hook?.unregister();
    menus.forEach(m => m.remove());
  }};
});
