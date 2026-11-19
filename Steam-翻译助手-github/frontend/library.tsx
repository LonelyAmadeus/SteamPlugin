import { translateBounded } from '../shared/translate';
import { menuUI } from '../shared/menu';
import { installInline } from '../shared/inline';
import { classMapList, definePlugin } from 'millennium';

const groups = [
  ['EventDetailsPageContainer', 'EventBodyCtn', 'MajorEvent_Ctn', 'AppDetailsSpotlightContainer', 'MajorEventTextCtn', 'RecentNewsItem', 'AchievementRow', 'GlobalAchievementListItem', 'AchievementHoverContainer'],
  ['EventBody', 'EventDetailsBody', 'EventDetailsDescription', 'EventDetailTitle', 'EventSummary', 'AchievementDescription', 'AchievementTitle'],
];

// Reading components found in the installed Steam build, including lazy-loaded modules.
const installedClasses = [
  '_3o4SVY-lALGHvkOPxiClcu _1-An2oorO8mDpzICH9p0_S _2_kU7nUB6wwDu-LsbQZmNc _1zDJ1bfFg-UkuAluUAoGKj Ojdg2vBD3O1oroxYVU2zB _2CK1m9x0gtA_oSAQa2FpS3 _2Ptras-ZC31rwdT6pD-t0a _316Uo4SBrQ_beBdSYn2HNO _3eNE5TKtDTnfNBAsCqfcP0 _3SGC6De_ZUjSViw20mnvYv ZjLfk-YYYg2BeAX0wJt3k',
  '_17dhGq-FsL8xZBes7dOOlN _1hCng1RGOB0Usr_3Uz2ZXg _1i7oUcMQndXEBMEQz2zZ-r _1suo0A05iiYmqbvCk66cm_ _1WP2YDDWrL5LPHoS04AKx8 _207nc4Kas-7zR1DpqbnMqA _2orfVuUro8BNFNNhRfGk4n _2y-2VLgw8KpeOlvqXRvE9m _2yGvZNxeAaVt8SbGgyGMbe _3aht--c1L66YvvpY-Il67f _3NW5vEM9HgfQrgR4W-Xy_s _3XQU8OYiF1A4HeocnI6sdV A_A2B6fTn_MPLlGCmsLtd gK1HBk7JSxeVVDT4FEdOj I0sr90EArZw2mvxW7WgVV LRVqOMfI5WTkpNe1dAnmZ NEMXhMlqXOCJwfgWlHXhT p8bs-3zEou4ZHLLrZozzu TqEPC9bhvVpZ1rb3Z8Mbd UE_Mse5yL68-_H3qFd0Mm',
];

type Popup = { window?: Window };
type Manager = {
  m_mapPopups: Map<string, Popup>;
  AddPopupCreatedCallback(cb: (popup: Popup) => void): { unregister(): void };
};

export default definePlugin(() => {
  const controller = new AbortController();
  const { signal } = controller;
  const attached = new WeakSet<Document>();
  // 最近一次已知的自动翻译开关状态，用来让菜单一打开就是正确勾选
  let autoFlag = false;
  const originals = new WeakMap<Text, { raw: string; output: string }>();

  const menus = new Set<HTMLElement>();
  const selectors = groups.map((names, index) => {
    const classes = new Set(installedClasses[index].split(' '));
    for (const mod of (classMapList || [])) for (const name of names) {
      if (typeof mod[name] === 'string') for (const token of mod[name].split(/\s+/)) if (token) classes.add(token);
    }
    return [...classes].map(c => '.' + CSS.escape(c)).join(',');
  });

  function attach(win?: Window) {
    const doc = win?.document;
    if (!win || !doc || attached.has(doc)) return;
    attached.add(doc);
    // 上一次「还原原文」之前保存的译文快照，用于「还原翻译」
    let snapshot: { node: Text; raw: string; output: string }[] = [];
    const ui = menuUI(doc);
    installInline(doc, msg => { backend.noteFromWeb('inline: ' + msg).catch(() => undefined); });
    let menu: HTMLElement | undefined;
    function close() {
      if (menu) { menu.remove(); menus.delete(menu); menu = undefined; }
    }
    let active: Element | undefined;
    let observer: MutationObserver | undefined;
    let version = 0;
    let running = false;
    let dirty = false;
    let failure = '';
    const cache = new Map<string, string>();
    // 归一化索引：把多空白压成单空格，解决网页侧/客户端侧同一句话
    // 因为换行、缩进不同而 cache miss 的问题。
    const cacheNorm = new Map<string, string>();
    const normKey = (s: string) => s.replace(/\s+/g, ' ').trim();
    // 与网页侧共用同一个磁盘缓存：启动时装载，翻译后回写，
    // 否则库内界面每次开 Steam 都要重新翻一遍。
    const pendingPersist = new Map<string, string>();
    let persistTimer: number | undefined;
    function queuePersist(key: string, value: string) {
      pendingPersist.set(key, value);
      if (persistTimer !== undefined) return;
      persistTimer = win!.setTimeout(() => { persistTimer = undefined; void flushPersist(); }, 1200);
    }
    async function flushPersist() {
      if (!pendingPersist.size) return;
      const entries: Record<string, string> = {};
      for (const [k, v] of pendingPersist) entries[k] = v;
      pendingPersist.clear();
      try { await backend.putCache(JSON.stringify({ entries })); } catch { /* ignore */ }
    }
    const cacheReady = (async () => {
      try {
        const raw: unknown = await backend.getCache();
        const obj = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { map?: Record<string, string> } & Record<string, string>;
        const map = obj?.map ?? obj;
        if (map && typeof map === 'object') {
          for (const [k, v] of Object.entries(map)) {
            if (typeof v !== 'string' || !v) continue;
            cache.set(k, v);
            cacheNorm.set(normKey(k), v);
          }
        }
      } catch { /* 读取失败就退回纯内存缓存 */ }
      void backend.noteFromWeb('fe cache ready size=' + cache.size).catch(() => undefined);
    })();

    function stop() {
      version++;
      observer?.disconnect();
      active = undefined;
      running = dirty = false;
      cache.clear();
      failure = '';
    }

    function scan(root: Element) {
      const pending = new Map<string, Text[]>();
      const translated: Text[] = [];
      const walker = root.ownerDocument.createTreeWalker(root, 4);
      for (let n = walker.nextNode() as Text; n; n = walker.nextNode() as Text) {
        if (n.parentElement?.closest('script,style,textarea,[contenteditable],code,pre')) continue;
        if (n.parentElement?.closest('#ds-tr-inline-wrap,#ds-tr-menu,#ds-tr-panel,#ds-tr-toast')) continue;
        // 展开/折叠这类开关行（带 aria-expanded）不翻，避免改文本打断它的状态切换
        if (n.parentElement?.closest('[aria-expanded]')) continue;
        if (originals.get(n)?.output === n.data) { translated.push(n); continue; }
        const key = n.data.trim();
        {
          const latin = (key.match(/[A-Za-z]/g) || []).length;
          const han = (key.match(/[\u4e00-\u9fff]/g) || []).length;
          if (latin === 0 || han >= latin) continue;
        }
        if (!pending.has(key)) pending.set(key, []);
        pending.get(key)!.push(n);
      }
      return { pending, translated };
    }

    async function update() {
      dirty = true;
      if (running || !active) return;
      await cacheReady;
      running = true;
      const root = active;
      const epoch = version;
      const current = () => version === epoch && root.isConnected && !signal.aborted;
      try {
        while (dirty && current()) {
          dirty = false;
          const { pending } = scan(root);
          function apply(key: string, tr: string) {
            for (const n of pending.get(key)!) {
              if (!root.contains(n) || n.data.trim() !== key) continue;
              const output = n.data.replace(/\S[\s\S]*\S|\S/u, () => tr);
              originals.set(n, {raw: n.data, output});
              if (n.data !== output) n.data = output;
            }
          }
          const keys: string[] = [];
          for (const key of pending.keys()) {
            const hit = cache.get(key) ?? cacheNorm.get(normKey(key));
            if (hit) apply(key, hit);
            else keys.push(key);
          }
          async function request(batch: string[]): Promise<void> {
            if (!current()) return;
            void backend.noteFromWeb('fe req n=' + batch.length).catch(() => undefined);
            const res = await translateBounded(batch, current);
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

    const spotlight = '.Ojdg2vBD3O1oroxYVU2zB,._2nr7NuawYs9NhC8OUkY0fK,._1zDJ1bfFg-UkuAluUAoGKj,._2_kU7nUB6wwDu-LsbQZmNc';
    const dialog = '[role="dialog"],dialog,._2Ptras-ZC31rwdT6pD-t0a';
    const suppressed = new WeakSet<Element>();
    let last: Element | null | undefined;
    // 用户点了「还原原文」后，当前页面不要再被自动翻译接管；
    // 换游戏/换页面（详情容器或 appid 变了）才恢复自动翻译。
    let restoreGuard: { root: Element; details: Element | null; appid: string | null } | null = null;
    function appIdOf(details: Element | null): string | null {
      if (!details) return null;
      const withId = details.querySelector('[data-appid]');
      return withId ? withId.getAttribute('data-appid') : null;
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
        try { await backend.deleteCache(JSON.stringify({ keys: Array.from(keys) })); } catch { /* ignore */ }
      }
      void backend.noteFromWeb('fe forget texts=' + keys.size + ' removed=' + removed).catch(() => undefined);
    }
    function start(root: Element) {
      stop();
      active = root;
      // 同样避开 React 提交阶段：下一帧再扫，否则展开/折叠状态会被回滚
      observer = new MutationObserver(() => { win!.requestAnimationFrame(() => { void update(); }); });
      observer.observe(root, {subtree: true, childList: true, characterData: true});
      return update();
    }
    // 刚启动时 backend 可能还没就绪
    async function configWithRetry(tries = 4): Promise<any> {
      for (let i = 0; i < tries; i++) {
        try {
          const raw = await backend.getConfig();
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

    async function discover(force = false) {
      // 好友列表窗口不自动翻译（会把人名翻掉），聊天窗口不在此列
      if (/好友列表|friends\s*list/i.test(doc.title || '')) return;
      // 自动翻译只作用于「游戏详情页」和「聊天窗口」。
      // 库首页（最近游玩、货架）不自动翻，避免把主页文字翻掉、也避免还原失效。
      const root: Element | null = currentRoot();
      if (!root) return;
      // 已经在这个 root 上自动翻译时才跳过；否则（被还原过/换过页）继续接管
      if (!force && root === last && active === root) return;
      last = root;
      const ticket = ++check;
      try {
        const cfg = await configWithRetry();
        if (ticket !== check || signal.aborted || !root.isConnected) return;
        autoFlag = cfg.autoTranslate === true;
        if (cfg.autoTranslate === true) {
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
    discovery.observe(doc, {childList: true, subtree: true});

    // 列表虚拟滚动会重建节点：新节点一出现就用缓存立刻回填，
    // 避免“滑走闪回原文、滑回来再翻一次”；还原之后（active 为空）停止补翻。
    function applyCachedText(node: Node) {
      if (node.nodeType === 3) {
        const raw = node.nodeValue || '';
        const text = raw.trim();
        if (!text) return;
        const tr = cache.get(text);
        if (!tr || tr === text) return;
        const record = originals.get(node as Text);
        if (record && record.output === raw) return;
        const output = raw.replace(/\S[\s\S]*\S|\S/u, () => tr);
        originals.set(node as Text, { raw, output });
        (node as Text).data = output;
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node as Element;
      if (el.closest && el.closest('script,style,textarea,[contenteditable="true"]')) return;
      if (el.closest && el.closest('#ds-tr-inline-wrap,#ds-tr-menu,#ds-tr-panel,#ds-tr-toast')) return;
      if (el.closest && el.closest('[aria-expanded]')) return;
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
        for (const n of batch) { if (n.isConnected) applyCachedText(n); }
      });
    });
    cacheApplier.observe(doc.body, { childList: true, subtree: true });
    signal.addEventListener('abort', () => cacheApplier.disconnect(), { once: true });
    void discover();
    win.setTimeout(() => void discover(true), 2500);
    win.setTimeout(() => void discover(true), 7000);
    // 自动翻译开着时定期兜底，防止某次 stop/还原后不再接管
    win.setInterval(() => void discover(), 4000);
    win.addEventListener('focus', () => void discover(true), {signal});
    function cleanup() {
      check++;
      discovery.disconnect();
      win?.clearTimeout(timer);
      stop();
      close();
    }
    signal.addEventListener('abort', cleanup, {once: true});
    win.addEventListener('mousedown', e => { if (e.button !== 2 && !menu?.contains(e.target as Node)) close(); }, { capture: true, signal });
    win.addEventListener('pagehide', cleanup, { signal });
    const detailsPage = [
      '_3fp5y6tdU77MdrCQZt_aS9', '_2-ns_GqXzymHk0jsXBBWJ1', '_1DLmEVjfX3d7Ec8CW7vJnt',
      '_2Nq6ov7A1hGcHXVOXNt_OE', '_3YbIHh6FwfB9zQVNU18OSy', 'ETHkFxrlPF1znTFXFtjtK',
    ];
    for (const mod of classMapList || []) {
      for (const key of ['AppDetailsRoot', 'AppDetailsContainer', 'AppDetailsMain', 'AppDetails']) {
        if (typeof mod[key] === 'string') detailsPage.push(...mod[key].split(/\s+/).filter(Boolean));
      }
    }
    const pageSelector = detailsPage.map(c => '.' + CSS.escape(c)).join(',');
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
      const hit = selectors.reduce<Element | null>((found, s) => found || (s ? el.closest(s) : null), null);
      const page = el.closest(pageSelector);
      // 聊天窗口没有“页面”概念；Millennium 设置页也不在组件选择器里。
      // 这两种情况下允许右键出菜单，但输入框里保留 Steam 自带菜单。
      const inEditable = !!(el.closest && el.closest('textarea, input, [contenteditable="true"]'));
      const isChat = !inEditable && !!doc.querySelector('.chatTextarea, .chatHistory, [class*="chatHistory"]');
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
      });
      menu = box;
      menus.add(box);
      root.ownerDocument.body.appendChild(box);
      void backend.noteFromWeb('cm appended').catch(() => undefined);
      const toggle = box.querySelector<HTMLInputElement>('#ds-tr-auto')!;
      void backend.getConfig().then(raw => {
        const config = typeof raw === 'string' ? JSON.parse(raw) : raw;
        // 用户刚点过就以用户的为准，别用旧配置把它盖回未勾选
        if (toggle.dataset.userToggled !== '1') toggle.checked = config.autoTranslate === true;
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
          if (!item.node.isConnected) continue;
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
    win.addEventListener('ds-tr-cache-cleared', () => { cache.clear(); cacheNorm.clear(); });
    for (const type of ['mousedown', 'mouseup', 'pointerup', 'auxclick'] as const) {
      win.addEventListener(type, consumeRightButton, { capture: true, signal });
    }
    win.addEventListener('contextmenu', openMenu, { capture: true, signal });
    win.addEventListener('error', ev => {
      void backend.noteFromWeb('cm window error: ' + String((ev as ErrorEvent).message || '')).catch(() => undefined);
    }, { capture: true, signal });
    win.addEventListener('contextmenu', ev => {
      const target = ev.target as Element;
      void backend.noteFromWeb('cm event target=' + (target ? target.tagName + '.' + String(target.className || '').slice(0, 40) : 'null') + ' doc=' + JSON.stringify(doc.title || '')).catch(() => undefined);
    }, { capture: true, signal });
  }

  attach(window);
  const manager = (window as Window & {g_PopupManager?: Manager}).g_PopupManager;
  const hook = manager?.AddPopupCreatedCallback(p => attach(p.window));
  manager?.m_mapPopups.forEach(p => attach(p.window));
  return { icon: <span>译</span>, onDismount() {
    controller.abort();
    hook?.unregister();
    menus.forEach(m => m.remove());
  }};
});
