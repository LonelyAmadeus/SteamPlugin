/**
 * 输入框一键翻译控件（语言下拉 + 译）。
 * 独立于菜单样式，自己注入 <style>，可挂到任意 document（包括 Steam 的聊天窗口）。
 * 只处理 textarea / 文本类 input / contenteditable，永远不会翻译输入框里的内容。
 */

const LANGS = ['English', '简体中文', '繁體中文', '日本語', '한국어', 'Русский', 'Français', 'Deutsch', 'Español'];

const EDITABLE_SELECTOR = [
  'textarea',
  'input[type="text"]', 'input[type="search"]', 'input[type="url"]', 'input[type="email"]',
  'input:not([type])',
  '[contenteditable="true"]', '[contenteditable=""]',
].join(',');

const STYLE_ID = 'ds-tr-inline-style';

function injectStyle(doc: Document) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
#ds-tr-inline-wrap {
  position: fixed; z-index: 2147483647; display: none;
  align-items: center; gap: 4px; font-family: inherit;
}
#ds-tr-inline-lang {
  height: 24px; max-width: 96px;
  background: #101822; color: #c7d5e0;
  border: 1px solid #2a475e; border-radius: 4px;
  font-size: 12px; font-family: inherit; padding: 0 3px; cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,.6);
}
#ds-tr-inline-lang:hover { border-color: #66c0f4; }
#ds-tr-inline {
  position: static; display: block;
  width: 30px; height: 24px; padding: 0; line-height: 22px;
  background: #2a475e; color: #fff; border: 1px solid #66c0f4;
  border-radius: 4px; font-size: 12px; cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,.6); font-family: inherit;
}
#ds-tr-inline:hover { background: #66c0f4; color: #0b1a26; }
#ds-tr-inline:disabled { opacity: .7; cursor: default; }
#ds-tr-toast {
  position: fixed; z-index: 2147483647; display: none;
  left: 50%; bottom: 56px; transform: translateX(-50%);
  background: rgba(16, 24, 34, .96); color: #c7d5e0;
  border: 1px solid #2a475e; border-radius: 4px;
  padding: 7px 14px; font-size: 12px; font-family: inherit;
  box-shadow: 0 4px 16px rgba(0,0,0,.6); pointer-events: none;
}`;
  (doc.head || doc.documentElement).appendChild(style);
}

export function installInline(doc: Document, onNotice?: (msg: string) => void) {
  const win = doc.defaultView;
  if (!win || !doc.body) return;
  // 同一个 document 只装一次：Steam 会重建 body，只靠 body 上的标记会重复安装
  const marker = doc as Document & { __dsTrInlineInstalled?: boolean };
  if (marker.__dsTrInlineInstalled) return;
  marker.__dsTrInlineInstalled = true;

  injectStyle(doc);

  let targetLang = 'English';
  let wrap: HTMLDivElement | null = null;
  let btn: HTMLButtonElement | null = null;
  let sel: HTMLSelectElement | null = null;
  let target: HTMLElement | null = null;
  let lastText = '';
  const recent: HTMLElement[] = [];
  let hideTimer: number | undefined;
  let toast: HTMLDivElement | null = null;

  const notice = (msg: string) => {
    try { onNotice?.(msg); } catch { /* ignore */ }
  };

  function showToast(text: string) {
    if (!toast || !toast.isConnected) {
      toast = doc.createElement('div');
      toast.id = 'ds-tr-toast';
      doc.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.display = 'block';
    win!.clearTimeout((toast as unknown as { __t?: number }).__t);
    (toast as unknown as { __t?: number }).__t = win!.setTimeout(() => {
      if (toast) toast.style.display = 'none';
    }, 1800);
  }

  async function refreshLang() {
    try {
      const raw: unknown = await backend.getConfig();
      const cfg = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { targetLang?: string };
      if (cfg?.targetLang) {
        targetLang = cfg.targetLang;
        if (sel) sel.value = targetLang;
        if (btn) btn.title = '翻译为' + targetLang;
      }
    } catch { /* 读不到就沿用旧值 */ }
  }

  // 注意：弹窗里的元素属于另一个 realm，`instanceof HTMLTextAreaElement` 会失败，
  // 所以一律按 tagName 判断。
  function isField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
    return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
  }

  function editableOf(node: EventTarget | null): HTMLElement | null {
    const el = node as Element | null;
    if (!el || el.nodeType !== 1 || !el.closest) return null;
    const found = el.closest(EDITABLE_SELECTOR) as HTMLElement | null;
    if (!found) return null;
    if (found.closest('#ds-tr-panel')) return null;
    if (found.tagName === 'INPUT') {
      const type = ((found as HTMLInputElement).type || 'text').toLowerCase();
      if (!['text', 'search', 'url', 'email'].includes(type)) return null;
    }
    return found;
  }

  function readEditable(el: HTMLElement): string {
    if (isField(el)) {
      return el.value || el.defaultValue || el.textContent || '';
    }
    return el.innerText || '';
  }

  function writeEditable(el: HTMLElement, value: string) {
    if (isField(el)) {
      // 先按“模拟输入”写：Steam 聊天框是受控组件，直接改 value 会被它自己的状态冲掉
      try {
        el.focus();
        doc.execCommand('selectAll', false);
        if (doc.execCommand('insertText', false, value)) {
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      } catch { /* 落到下面的 setter 方案 */ }
      const view = el.ownerDocument.defaultView;
      const proto = el.tagName === 'TEXTAREA'
        ? view!.HTMLTextAreaElement.prototype
        : view!.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    // 富文本编辑器（Steam 聊天框）直接改 innerText 会被内部状态冲掉，
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

  function copyText(text: string): boolean {
    try {
      const ta = doc.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      doc.body.appendChild(ta);
      ta.select();
      const ok = doc.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }

  function place(el: HTMLElement) {
    if (!wrap) return;
    const rect = el.getBoundingClientRect();
    wrap.style.display = 'flex';
    const width = wrap.offsetWidth || 120;
    const top = rect.height >= 28 ? rect.top + (rect.height - 24) / 2 : rect.top - 26;
    wrap.style.top = Math.max(4, top) + 'px';
    wrap.style.left = Math.max(4, rect.right - width - 6) + 'px';
  }

  function hide() {
    if (wrap) wrap.style.display = 'none';
    target = null;
  }

  async function translateCurrent() {
    if (!btn) return;
    // Steam 可能重建聊天框节点，target 会变成已脱离文档的旧节点；
    // 点击时重新解析：当前焦点 → 最近的输入框 → 页面上第一个有内容的输入框
    let el: HTMLElement | null = target && target.isConnected ? target : null;
    if (!el) {
      const active = doc.activeElement as HTMLElement | null;
      el = (active && editableOf(active)) || null;
    }
    if (!el) el = recent.filter(n => n.isConnected).pop() || null;
    let text = el ? readEditable(el).trim() : '';
    if (!text) {
      for (const cand of Array.from(doc.querySelectorAll(EDITABLE_SELECTOR))) {
        const value = readEditable(cand as HTMLElement).trim();
        if (value) { el = cand as HTMLElement; text = value; break; }
      }
    }
    if (!text) text = lastText.trim();
    notice('inline click el=' + (el ? el.tagName + '.' + String((el as HTMLElement).className || '') : 'null') + ' len=' + text.length);
    if (!text) {
      try {
        const list = Array.from(doc.querySelectorAll(EDITABLE_SELECTOR)) as HTMLElement[];
        const active = doc.activeElement as HTMLElement | null;
        notice('inline dump title=' + JSON.stringify(doc.title || '') +
          ' active=' + (active ? active.tagName + '.' + String(active.className || '') : 'null') +
          ' editables=' + list.length);
        list.slice(0, 4).forEach((n, i) => {
          const ta = n as HTMLTextAreaElement;
          notice('inline dump #' + i + ' ' + n.tagName + '.' + String(n.className || '').slice(0, 40) +
            ' value=' + (ta.value || '').length + ' def=' + (ta.defaultValue || '').length +
            ' text=' + (n.textContent || '').length + ' conn=' + n.isConnected +
            ' vis=' + !!(n.offsetWidth || n.offsetHeight));
        });
      } catch { /* ignore */ }
      showToast('没读到输入框内容');
      notice('inline click: empty text');
      return;
    }
    const lang = sel?.value || targetLang;
    const label = btn.textContent || '译';
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const raw: unknown = await backend.translateText(JSON.stringify({ text, lang }));
      const res = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { ok?: boolean; text?: string; error?: string };
      if (!res?.ok || !res.text) throw Error(res?.error || '翻译失败');
      const out = res.text.trim();
      if (out === text) {
        btn.textContent = '＝';
        showToast('原文已是' + lang);
        notice('inline same as source, target=' + lang);
        win!.setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 1200);
        return;
      }
      const before = readEditable(el);
      writeEditable(el, out);
      // Steam 的输入框是受控/富文本组件：写进去后它可能用自己的状态把值冲回原文，
      // 表现为“先变译文再变原文”。这里短时间盯一下，被冲回就再写一次。
      const keepWritten = (attempt: number) => {
        if (!el.isConnected || attempt > 4) return;
        const nowText = readEditable(el).trim();
        if (nowText === out.trim()) return;
        if (nowText === before.trim()) writeEditable(el, out);
        win!.setTimeout(() => keepWritten(attempt + 1), 400);
      };
      win!.setTimeout(() => keepWritten(0), 250);
      btn.textContent = '✓';
      let copied = false;
      const ensureKept = () => {
        if (copied || !before) return;
        if (readEditable(el)) return;
        copied = true;
        copyText(out);
        showToast('译文已复制，按 Ctrl+V 粘贴');
        notice('inline fallback clipboard (editor rejected write)');
      };
      win!.setTimeout(ensureKept, 500);
      win!.setTimeout(ensureKept, 1600);
      win!.setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 900);
      notice('inline ok, target=' + lang);
    } catch (e) {
      notice('inline failed: ' + String(e));
      btn.textContent = '×';
      win!.setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 1200);
      showToast(String(e).includes('NO_KEY') ? '还没配置 API Key' : '翻译失败');
    }
  }

  function ensureUI() {
    if (wrap && wrap.isConnected) return;
    wrap = doc.createElement('div');
    wrap.id = 'ds-tr-inline-wrap';

    sel = doc.createElement('select');
    sel.id = 'ds-tr-inline-lang';
    sel.title = '选择目标语言';
    for (const lang of LANGS) sel.add(new Option(lang, lang));
    sel.value = targetLang;
    sel.addEventListener('change', () => {
      targetLang = sel!.value;
      if (btn) btn.title = '翻译为' + targetLang;
      backend.setConfig(JSON.stringify({ targetLang })).catch(() => undefined);
    });

    btn = doc.createElement('button');
    btn.id = 'ds-tr-inline';
    btn.type = 'button';
    btn.textContent = '译';
    btn.title = '翻译为' + targetLang;
    btn.addEventListener('mousedown', ev => { ev.preventDefault(); ev.stopPropagation(); });
    btn.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); void translateCurrent(); });

    wrap.append(sel, btn);
    doc.body.appendChild(wrap);
    void refreshLang();
  }

  doc.addEventListener('focusin', ev => {
    const el = editableOf(ev.target);
    if (!el) return;
    win!.clearTimeout(hideTimer);
    target = el;
    lastText = readEditable(el);
    recent.push(el);
    if (recent.length > 6) recent.shift();
    ensureUI();
    if (btn) { btn.disabled = false; btn.textContent = '译'; }
    if (sel) sel.value = targetLang;
    place(el);
  }, true);

  doc.addEventListener('input', ev => {
    const el = editableOf(ev.target);
    if (el) lastText = readEditable(el);
  }, true);

  doc.addEventListener('pointerdown', ev => {
    if (ev.target instanceof Element && ev.target.closest('#ds-tr-inline-wrap')) {
      notice('inline pointerdown on widget');
    }
  }, true);

  doc.addEventListener('focusout', () => {
    if (!target) return;
    win!.clearTimeout(hideTimer);
    hideTimer = win!.setTimeout(() => {
      if (wrap && wrap.contains(doc.activeElement)) return;
      hide();
    }, 200);
  }, true);

  win.addEventListener('scroll', () => hide(), true);
  win.addEventListener('resize', () => hide(), true);

  // 临时自测：配置里 debugInline=true 时，6 秒后拿窗口里第一个输入框试一次
  void (async () => {
    try {
      const raw: unknown = await backend.getConfig();
      const cfg = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { debugInline?: boolean };
      if (!cfg?.debugInline) return;
      win!.setTimeout(async () => {
        const all = doc.querySelectorAll(EDITABLE_SELECTOR);
        notice('selftest editables=' + all.length + ' title=' + JSON.stringify(doc.title || ''));
        const el = all[0] as HTMLElement | undefined;
        if (!el) return;
        notice('selftest el=' + el.tagName + ' ce=' + (el as HTMLElement).isContentEditable + ' cls=' + String((el as HTMLElement).className || '').slice(0, 60));
        writeEditable(el, '这是一个测试');
        el.focus();
        el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        await new Promise(r => win!.setTimeout(r, 600));
        if (!btn) { notice('selftest no button'); return; }
        btn.click();
        await new Promise(r => win!.setTimeout(r, 4500));
        notice('selftest result title=' + JSON.stringify(doc.title || '') + ' value=' + JSON.stringify(readEditable(el)).slice(0, 140));
      }, 6000);
    } catch { /* ignore */ }
  })();
  const editables = doc.querySelectorAll(EDITABLE_SELECTOR).length;
  notice('inline installed title=' + JSON.stringify(doc.title || '') + ' editables=' + editables);
}
