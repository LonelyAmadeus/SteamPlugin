const menuCSS = `
#ds-tr-toast {
  position: fixed; z-index: 2147483647; display: none;
  left: 50%; bottom: 56px; transform: translateX(-50%);
  background: rgba(16, 24, 34, .96); color: #c7d5e0;
  border: 1px solid #2a475e; border-radius: 4px;
  padding: 7px 14px; font-size: 12px; font-family: inherit;
  box-shadow: 0 4px 16px rgba(0,0,0,.6); pointer-events: none;
}

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
  position: static; display: none;
  width: 30px; height: 24px; padding: 0; line-height: 22px;
  background: #2a475e; color: #fff; border: 1px solid #66c0f4;
  border-radius: 4px; font-size: 12px; cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,.6); font-family: inherit;
}
#ds-tr-inline:hover { background: #66c0f4; color: #0b1a26; }
#ds-tr-inline:disabled { opacity: .7; cursor: default; }

#ds-tr-menu {
  position: fixed; z-index: 2147483647; min-width: 160px;
  background: #1b2838; border: 1px solid #2a475e; border-radius: 3px;
  box-shadow: 0 4px 14px rgba(0,0,0,.6); padding: 4px 0;
  font-size: 13px; color: #c7d5e0; font-family: inherit; display: none;
}
#ds-tr-menu .item { padding: 6px 14px; cursor: pointer; white-space: nowrap; }
#ds-tr-menu .item:hover { background: #2a475e; color: #fff; }
#ds-tr-menu .item.disabled { opacity: .55; cursor: default; }
#ds-tr-menu .item.disabled:hover { background: transparent; color: #c7d5e0; }
#ds-tr-menu .item.hidden { display: none; }
#ds-tr-menu .sep { height: 1px; background: #2a475e; margin: 4px 0; }

#ds-tr-panel {
  position: fixed; z-index: 2147483647; top: 50%; left: 50%;
  transform: translate(-50%, -50%); width: 520px; max-width: 92vw;
  background: #1b2838; border: 1px solid #2a475e; border-radius: 4px;
  box-shadow: 0 8px 30px rgba(0,0,0,.7); padding: 16px; color: #c7d5e0;
  font-size: 13px; font-family: inherit; display: none;
}
#ds-tr-panel h3 { margin: 0 0 4px; font-size: 15px; color: #fff; }
#ds-tr-panel .hint { font-size: 12px; color: #8ba6b8; margin-bottom: 6px; }
#ds-tr-panel label { display: block; font-size: 12px; color: #8ba6b8; margin: 10px 0 4px; }
#ds-tr-panel input {
  width: 100%; box-sizing: border-box; background: #101822; color: #c7d5e0;
  border: 1px solid #2a475e; border-radius: 3px; padding: 6px 8px; font-size: 13px;
}
#ds-tr-panel select {
  width: 100%; box-sizing: border-box; background: #101822; color: #c7d5e0;
  border: 1px solid #2a475e; border-radius: 3px; padding: 6px 8px; font-size: 13px;
}
#ds-tr-panel .row { display: flex; gap: 8px; align-items: center; margin-top: 14px; }
#ds-tr-panel button {
  background: #2a475e; color: #fff; border: none; border-radius: 3px;
  padding: 7px 16px; font-size: 13px; cursor: pointer;
}
#ds-tr-panel button.ghost { background: #101822; border: 1px solid #2a475e; color: #c7d5e0; }
#ds-tr-panel .status { font-size: 12px; color: #8ba6b8; }
#ds-tr-mask {
  position: fixed; inset: 0; z-index: 2147483646; background: rgba(0,0,0,.55); display: none;
}
`;

export function menuUI(document: Document) {
  function ensureStyle() {
    if (document.getElementById('ds-tr-style')) return;
    const style = document.createElement('style');
    style.id = 'ds-tr-style';
    style.textContent = menuCSS;
    document.head.appendChild(style);
  }

  function buildMenu(autoTranslate: boolean, preferenceReady: boolean, changed: (enabled: boolean) => void): HTMLElement {
    const menu = document.createElement('div');
    menu.id = 'ds-tr-menu';

    const action = document.createElement('div');
    action.className = 'item';
    action.id = 'ds-tr-action';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:3px;font-size:11px;padding-right:8px;cursor:pointer';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = 'ds-tr-auto';
    toggle.checked = autoTranslate;
    toggle.disabled = !preferenceReady;
    label.append(toggle, '自动翻译');
    row.append(action, label);
    menu.appendChild(row);
    toggle.addEventListener('change', async () => {
      const enabled = toggle.checked;
      // 用户已经手动改过：后续的异步 getConfig 不许再覆盖勾选状态
      toggle.dataset.userToggled = '1';
      toggle.disabled = true;
      try {
        const raw = await backend.setConfig(JSON.stringify({autoTranslate: enabled}));
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        try { await backend.noteFromWeb('auto save enabled=' + enabled + ' ok=' + !!(result && result.ok) + ' err=' + String((result && result.error) || '')); } catch { /* ignore */ }
        if (!result.ok) throw Error(result.error);

        changed(enabled);
      } catch {
        toggle.checked = !enabled;
        label.title = '设置保存失败，请重试';
        label.lastChild!.textContent = '自动翻译（保存失败）';
      } finally { toggle.disabled = false; }
    });


    const redo = document.createElement('div');
    redo.className = 'item hidden';
    redo.id = 'ds-tr-redo';
    redo.textContent = '还原翻译';
    // 放在「重新翻译」上面
    menu.insertBefore(redo, menu.firstChild);

    const sep = document.createElement('div');
    sep.className = 'sep';
    menu.appendChild(sep);

    const cfg = document.createElement('div');
    cfg.className = 'item';
    cfg.id = 'ds-tr-cfg';
    cfg.textContent = 'API 设置…';
    menu.appendChild(cfg);

    return menu;
  }

  function field(id: string): HTMLInputElement | null {
    return document.getElementById(id) as HTMLInputElement | null;
  }

  function setStatus(text: string) {
    const el = document.querySelector('#ds-tr-panel .status');
    if (el) el.textContent = text;
  }

  async function readCfg() {
    try {
      const raw: any = await backend.getConfig();
      const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (field('ds-tr-in-key')) field('ds-tr-in-key')!.value = cfg?.apiKey || '';
      if (field('ds-tr-in-url')) field('ds-tr-in-url')!.value = cfg?.url || '';
      if (field('ds-tr-in-model')) field('ds-tr-in-model')!.value = cfg?.model || '';

      setStatus('已读取当前配置');
    } catch (e) {
      setStatus('读取失败');
    }
  }

  async function saveCfg() {
    try {
      const payload = {
        apiKey: field('ds-tr-in-key')?.value || '',
        url: field('ds-tr-in-url')?.value || '',
        model: field('ds-tr-in-model')?.value || '',
      };
      const res: any = await backend.setConfig(JSON.stringify(payload));
      if (!res?.ok) setStatus('保存失败');
      else if (res.hasKey) setStatus('已保存，立即生效');
      else setStatus('已保存（未填 Key，翻译时会提示设置）');
    } catch (e) {
      setStatus('保存失败');
    }
  }

  function closePanel() {
    const mask = document.getElementById('ds-tr-mask');
    const panel = document.getElementById('ds-tr-panel');
    if (mask) mask.style.display = 'none';
    if (panel) panel.style.display = 'none';
  }

  function openPanel() {
    let mask = document.getElementById('ds-tr-mask');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'ds-tr-mask';
      document.body.appendChild(mask);
      mask.addEventListener('click', closePanel);
    }

    let panel = document.getElementById('ds-tr-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'ds-tr-panel';
      panel.innerHTML =
        '<h3>Steam 翻译助手 · API 设置</h3>' +
        '<div class="hint">OpenAI 兼容接口。改完点保存，立即生效，无需重启。</div>' +
        '<label>API Key</label><input id="ds-tr-in-key" placeholder="sk-..." />' +
        '<label>接口地址</label><input id="ds-tr-in-url" placeholder="https://api.deepseek.com/chat/completions" />' +
        '<label>模型</label><input id="ds-tr-in-model" placeholder="deepseek-chat" />' +
        '<div class="row" style="margin-top:12px;align-items:center">' +
        '<span class="hint" id="ds-tr-cache-stats" style="margin:0;flex:1">缓存：读取中…</span>' +
        '<button id="ds-tr-clear-cache" class="ghost" style="padding:4px 10px">清除缓存</button>' +
        '</div>' +

        '<div class="row">' +
        '<button id="ds-tr-save">保存</button>' +
        '<button id="ds-tr-read" class="ghost">读取当前</button>' +
        '<button id="ds-tr-close" class="ghost">关闭</button>' +
        '<span class="status"></span>' +
        '</div>';
      document.body.appendChild(panel);

      panel.querySelector('#ds-tr-close')?.addEventListener('click', closePanel);
      panel.querySelector('#ds-tr-save')?.addEventListener('click', saveCfg);
      panel.querySelector('#ds-tr-read')?.addEventListener('click', readCfg);
      panel.querySelector('#ds-tr-clear-cache')?.addEventListener('click', clearCacheAll);
    }

    mask.style.display = 'block';
    panel.style.display = 'block';
    readCfg();
    void refreshCacheStats();
  }

  async function clearCacheAll() {
    const btn = document.getElementById('ds-tr-clear-cache') as HTMLButtonElement | null;
    if (!window.confirm('确定清除所有翻译缓存？\n之后所有页面都会重新调用 API 翻译。')) return;
    if (btn) btn.disabled = true;
    try {
      const raw: any = await (backend as any).clearCache();
      const res = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { ok?: boolean };
      setStatus(res?.ok ? '缓存已清除' : '清除失败');
      if (res?.ok) {
        // 通知当前页/窗口丢掉内存里的副本，避免“清了又写回”
        window.dispatchEvent(new CustomEvent('ds-tr-cache-cleared'));
        document.dispatchEvent(new CustomEvent('ds-tr-cache-cleared'));
      }
    } catch {
      setStatus('清除失败');
    } finally {
      if (btn) btn.disabled = false;
      await refreshCacheStats();
    }
  }

  async function refreshCacheStats() {
    const el = document.getElementById('ds-tr-cache-stats');
    if (!el) return;
    try {
      const raw: any = await (backend as any).getCacheStats();
      const res = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { ok?: boolean; entries?: number; bytes?: number };
      if (!res?.ok) { el.textContent = '缓存：读取失败'; return; }
      const kb = (res.bytes || 0) / 1024;
      const size = kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(1) + ' KB';
      el.textContent = '缓存：' + (res.entries || 0).toLocaleString() + ' 条 / ' + size;
    } catch {
      el.textContent = '缓存：读取失败';
    }
  }


  function showFailure(reason = '翻译失败，请检查 API 是否正确配置') {
    if (document.getElementById('ds-tr-error')) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'ds-tr-error';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-labelledby', 'ds-tr-error-message');
    dialog.style.cssText = 'position:fixed;inset:0;margin:auto;max-width:90vw;height:fit-content;padding:18px 22px;background:#781e29;color:white;border:1px solid #f0838d;border-radius:6px;box-shadow:0 8px 32px #0008;font:14px/1.5 sans-serif';
    const message = document.createElement('p');
    message.id = 'ds-tr-error-message';
    message.style.cssText = 'margin:0 0 14px;font-weight:600';
    message.textContent = reason;
    const settings = document.createElement('button');
    settings.textContent = 'API 设置…';
    settings.onclick = () => { dialog.close(); openPanel(); };
    const close = document.createElement('button');
    close.textContent = '关闭';
    close.style.marginLeft = '10px';
    close.onclick = () => dialog.close();
    dialog.append(message, settings, close);
    dialog.addEventListener('close', () => dialog.remove(), {once: true});
    document.body.appendChild(dialog);
    dialog.showModal();
  }

  return { ensureStyle, buildMenu, openPanel, showFailure, field, setStatus };
}
