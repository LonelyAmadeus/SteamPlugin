export type TranslationDisplayMode = 'replace' | 'bilingual';
export type AutomaticRuleMode = 'on' | 'off' | 'inherit';

export const privateFields = 'input[type="password" i],[autocomplete*="password" i],[autocomplete~="one-time-code" i],[autocomplete*="cc-" i],[data-sensitive],[data-private],#ds-tr-panel';

export function isPageTextCandidate(text: string, target: string): boolean {
  if (!text || !/\p{L}/u.test(text)) return false;
  if (!/^(?:简体中文|繁體中文|中文|Chinese\b|zh\b)/i.test(target)) return true;
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) return true;
  const han = text.match(/\p{Script=Han}/gu)?.length || 0;
  return !han || (text.match(/\p{L}/gu)?.length || 0) > 2 * han;
}

export type TranslationContext = {
  key: string;
  label: string;
  fallbackKeys: string[];
};

type AutomaticConfig = {
  autoTranslate?: boolean;
  autoRules?: Record<string, AutomaticRuleMode | boolean>;
};

function isAppId(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{1,12}$/.test(value);
}

function appIdFromRoot(root?: Element | null): string | null {
  if (!root) return null;
  const details = root.matches('.AppDetailsMain, [class*="AppDetailsMain"]')
    ? root
    : root.querySelector('.AppDetailsMain, [class*="AppDetailsMain"]');
  const value = details?.getAttribute('data-appid')
    || details?.querySelector('[data-appid]')?.getAttribute('data-appid')
    || root.closest('[data-appid]')?.getAttribute('data-appid');
  return isAppId(value) ? value : null;
}

function appIdFromUrl(url: URL): string | null {
  const pathMatch = /\/(?:app|agecheck\/app|games)\/(\d{1,12})(?:\/|$)/i.exec(url.pathname);
  const queryId = url.searchParams.get('appid') || url.searchParams.get('appId');
  const value = pathMatch?.[1] || queryId;
  return isAppId(value) ? value : null;
}

export function translationContext(doc: Document, root?: Element | null): TranslationContext {
  let url: URL;
  try {
    url = new URL(doc.location.href);
  } catch {
    return { key: 'steam:other', label: 'Steam 页面', fallbackKeys: ['steam:other'] };
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  const isCommunity = host === 'steamcommunity.com' || host.endsWith('.steamcommunity.com');
  const isStore = host === 'store.steampowered.com' || host.endsWith('.steampowered.com') && !host.startsWith('help.');
  const isHelp = host === 'help.steampowered.com';
  const inChat = !!doc.querySelector('.chatTextarea, .chatHistory, [class*="chatHistory"]');
  const isWorkshop = isCommunity && /\/sharedfiles\/|\/workshop\//i.test(path);
  const hasDetails = !!root && (root.matches('.AppDetailsMain, [class*="AppDetailsMain"]')
    || !!root.querySelector('.AppDetailsMain, [class*="AppDetailsMain"]'));
  const library = hasDetails || !!doc.querySelector('.AppDetailsMain, [class*="AppDetailsMain"]');

  if (inChat && (!isCommunity && !isStore && !isHelp || /\/chat\//i.test(path))) {
    return { key: 'steam:chat', label: '聊天窗口', fallbackKeys: ['steam:chat'] };
  }
  if (path.startsWith('/checkout') || path.startsWith('/cart')) {
    return { key: 'steam:checkout', label: '结账页面', fallbackKeys: ['steam:checkout'] };
  }
  if (isHelp) return { key: 'steam:help', label: 'Steam 帮助页', fallbackKeys: ['steam:help'] };

  const appId = (library ? appIdFromRoot(root) : null) || appIdFromUrl(url);
  if (appId && library) {
    return { key: `app:${appId}`, label: `游戏 ${appId}`, fallbackKeys: [`app:${appId}`, 'steam:library'] };
  }
  if (appId && isStore && /\/app\/|\/agecheck\/app\//i.test(path)) {
    return { key: `app:${appId}`, label: `游戏 ${appId}`, fallbackKeys: [`app:${appId}`, 'steam:store'] };
  }
  if (appId && isCommunity && /\/games\//i.test(path)) {
    return { key: `app:${appId}`, label: `游戏 ${appId}`, fallbackKeys: [`app:${appId}`, 'steam:community'] };
  }
  if (appId && isWorkshop) {
    return { key: `app:${appId}`, label: `游戏 ${appId}`, fallbackKeys: [`app:${appId}`, 'steam:workshop', 'steam:community'] };
  }
  if (library) return { key: 'steam:library', label: '游戏库页面', fallbackKeys: ['steam:library'] };
  if (isWorkshop) return { key: 'steam:workshop', label: '创意工坊页面', fallbackKeys: ['steam:workshop', 'steam:community'] };
  if (isCommunity) return { key: 'steam:community', label: 'Steam 社区页面', fallbackKeys: ['steam:community'] };
  if (isStore) return { key: 'steam:store', label: 'Steam 商店页面', fallbackKeys: ['steam:store'] };
  return { key: 'steam:other', label: 'Steam 页面', fallbackKeys: ['steam:other'] };
}

export function automaticTranslationEnabled(config: AutomaticConfig, context: TranslationContext): boolean {
  const rules = config.autoRules || {};
  for (const key of context.fallbackKeys) {
    const mode = rules[key];
    if (mode === 'on' || mode === true) return true;
    if (mode === 'off' || mode === false) return false;
  }
  return config.autoTranslate === true;
}

export function renderedTranslation(raw: string, translated: string, mode: TranslationDisplayMode): string {
  const replacement = mode === 'bilingual' ? `${translated} [${raw.trim()}]` : translated;
  return raw.replace(/\S[\s\S]*\S|\S/u, () => replacement);
}
