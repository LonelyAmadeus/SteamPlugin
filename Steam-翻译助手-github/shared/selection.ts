import { privateFields } from './policy';

const RESULT_ID = 'ds-tr-selection-result';
const requestVersions = new WeakMap<Document, number>();

type SelectionSnapshot = { raw: string; text: string };

function selectionSnapshot(doc: Document): SelectionSnapshot | null {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  for (const node of [selection.anchorNode, selection.focusNode]) {
    const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
    if (element?.closest(privateFields)) return null;
  }
  for (const element of Array.from(doc.querySelectorAll(privateFields))) {
    if (range.intersectsNode(element)) return null;
  }
  const raw = selection.toString();
  const text = raw.trim();
  return text ? { raw, text } : null;
}

function closeResult(doc: Document) {
  doc.getElementById(RESULT_ID)?.remove();
}

function copyText(doc: Document, text: string): boolean {
  try {
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('aria-hidden', 'true');
    area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    doc.body.appendChild(area);
    area.select();
    const copied = doc.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

function showResult(doc: Document, text: string, isError = false) {
  closeResult(doc);
  const panel = doc.createElement('section');
  panel.id = RESULT_ID;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '选区翻译结果');
  panel.style.cssText = [
    'position:fixed', 'right:24px', 'top:24px', 'z-index:2147483647',
    'width:min(460px,calc(100vw - 48px))', 'max-height:60vh', 'overflow:auto',
    'box-sizing:border-box', 'padding:14px', 'border:1px solid #2a475e', 'border-radius:6px',
    'background:#1b2838', 'color:#c7d5e0', 'box-shadow:0 8px 30px rgba(0,0,0,.65)',
    'font-family:inherit', 'font-size:13px', 'line-height:1.5',
  ].join(';');

  const actions = doc.createElement('div');
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-bottom:8px';
  const copy = doc.createElement('button');
  copy.type = 'button';
  copy.textContent = '复制译文';
  copy.style.cssText = 'background:#2a475e;color:#fff;border:0;border-radius:3px;padding:5px 10px;cursor:pointer';
  const close = doc.createElement('button');
  close.type = 'button';
  close.textContent = '关闭';
  close.style.cssText = 'background:#101822;color:#c7d5e0;border:1px solid #2a475e;border-radius:3px;padding:5px 10px;cursor:pointer';
  const output = doc.createElement('div');
  output.textContent = text;
  output.style.cssText = `white-space:pre-wrap;overflow-wrap:anywhere;${isError ? 'color:#ffb4ab' : ''}`;
  copy.disabled = isError;
  copy.addEventListener('click', () => {
    if (copyText(doc, text)) copy.textContent = '已复制';
    else copy.textContent = '复制失败';
  });
  close.addEventListener('click', () => closeResult(doc));
  actions.append(copy, close);
  panel.append(actions, output);
  doc.body.appendChild(panel);
}

export function addSelectionAction(doc: Document, menu: HTMLElement, closeMenu: () => void) {
  menu.querySelector('#ds-tr-selection-action')?.remove();
  const item = doc.createElement('div');
  item.id = 'ds-tr-selection-action';
  item.className = 'item';
  item.setAttribute('role', 'menuitem');
  const snapshot = selectionSnapshot(doc);
  if (!snapshot) item.classList.add('hidden');
  else item.textContent = '翻译选中文本';

  item.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault(); });

  item.addEventListener('click', async event => {
    event.preventDefault();
    event.stopPropagation();
    if (!snapshot || item.classList.contains('disabled')) return;
    const current = selectionSnapshot(doc);
    if (!current || current.raw !== snapshot.raw) {
      showResult(doc, '选区已更改，请重新选择文本后翻译。', true);
      closeMenu();
      return;
    }
    if (snapshot.text.length > 12000) {
      showResult(doc, '所选文本过长（最多 12,000 字符）。请缩小选区后重试。', true);
      closeMenu();
      return;
    }

    closeResult(doc);
    closeMenu();
    item.classList.add('disabled');
    item.textContent = '翻译中…';
    const version = (requestVersions.get(doc) || 0) + 1;
    requestVersions.set(doc, version);
    try {
      const cfgRaw: unknown = await (backend as any).getPublicConfig();
      const cfg = (typeof cfgRaw === 'string' ? JSON.parse(cfgRaw) : cfgRaw) as { scope?: string };
      const beforeRequest = selectionSnapshot(doc);
      if (requestVersions.get(doc) !== version || !beforeRequest || beforeRequest.raw !== snapshot.raw) return;
      const raw: unknown = await backend.translateText(JSON.stringify({ text: snapshot.text, purpose: 'selection', scope: cfg?.scope }));
      const result = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { ok?: boolean; text?: string };
      if (requestVersions.get(doc) !== version) return;
      const after = selectionSnapshot(doc);
      if (!after || after.raw !== snapshot.raw) return;
      if (!result?.ok || typeof result.text !== 'string' || !result.text.trim()) {
        showResult(doc, '翻译失败，请检查网络和 API 设置。', true);
        return;
      }
      showResult(doc, result.text.trim());
    } catch {
      const after = selectionSnapshot(doc);
      if (requestVersions.get(doc) === version && after?.raw === snapshot.raw) {
        showResult(doc, '翻译失败，请检查网络和 API 设置。', true);
      }
    } finally {
      if (item.isConnected) {
        item.classList.remove('disabled');
        item.textContent = '翻译选中文本';
      }
    }
  });

  const separator = menu.querySelector('.sep');
  if (separator) menu.insertBefore(item, separator);
  else menu.appendChild(item);
  return item;
}
