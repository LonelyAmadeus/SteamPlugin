import { settingsUI } from './settings';

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
  position: static; display: block;
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
  max-height: 90vh; overflow: auto;
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
  const settings = settingsUI(document);

  function ensureStyle() {
    if (document.getElementById('ds-tr-style')) return;
    const style = document.createElement('style');
    style.id = 'ds-tr-style';
    style.textContent = menuCSS;
    document.head.appendChild(style);
  }

  function buildMenu(
    autoTranslate: boolean,
    preferenceReady: boolean,
    changed: (enabled: boolean) => void,
    ruleKey = 'steam:other',
    ruleLabel = '当前页面',
  ): HTMLElement {
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
    label.title = '此游戏或页面的规则覆盖全局默认';
    label.append(toggle, ruleLabel + '自动翻译');
    row.append(action, label);
    menu.appendChild(row);
    toggle.addEventListener('change', async () => {
      const enabled = toggle.checked;
      // 用户已经手动改过：后续的异步 getConfig 不许再覆盖勾选状态
      toggle.dataset.userToggled = '1';
      toggle.disabled = true;
      try {
        const raw = await backend.setConfig(JSON.stringify({ rulePatch: { key: ruleKey, mode: enabled ? 'on' : 'off' } }));
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        try { await backend.noteFromWeb('auto save enabled=' + enabled + ' ok=' + !!(result && result.ok) + ' err=' + String((result && result.error) || '')); } catch { /* ignore */ }
        if (!result.ok) throw Error(result.error);

        changed(enabled);
        const view = document.defaultView;
        if (view) {
          view.dispatchEvent(new view.CustomEvent('ds-tr-settings-changed'));
          document.dispatchEvent(new view.CustomEvent('ds-tr-settings-changed'));
        }
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

  function openPanel() {
    settings.openPanel();
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

  return { ensureStyle, buildMenu, openPanel, closePanel: settings.closePanel, showFailure, field: (id: string) => document.getElementById(id) as HTMLInputElement | null, setStatus: settings.setStatus };
}
