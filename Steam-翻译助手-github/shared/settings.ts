const languages = [
	'English',
	'简体中文',
	'繁體中文',
	'日本語',
	'한국어',
	'Русский',
	'Français',
	'Deutsch',
	'Español',
];

type CacheStats = { ok?: boolean; entries?: number; bytes?: number; currentEntries?: number; currentBytes?: number; scope?: string };

const ruleModes = [
	{ value: 'inherit', label: '跟随默认' },
	{ value: 'on', label: '强制开启' },
	{ value: 'off', label: '强制关闭' },
];

function parseResult(raw: unknown): any {
	return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

const settingsByDocument = new WeakMap<Document, ReturnType<typeof createSettings>>();

export function settingsUI(document: Document) {
	let settings = settingsByDocument.get(document);
	if (!settings) {
		settings = createSettings(document);
		settingsByDocument.set(document, settings);
	}
	return settings;
}

function createSettings(document: Document) {
	const field = (id: string) => document.getElementById(id) as HTMLInputElement | null;
	const setStatus = (text: string) => {
		const status = document.querySelector<HTMLSpanElement>('#ds-tr-panel .status');
		if (status) status.textContent = text;
	};
	const emit = (name: string) => {
		const view = document.defaultView;
		if (view) {
			view.dispatchEvent(new view.CustomEvent(name));
			document.dispatchEvent(new view.CustomEvent(name));
		}
	};

	let keyChanged = false;
	let configLoaded = false;
	let loadedConfig: any = {};
	let readRevision = 0;
	let keyRevision = 0;

	function maskKey() {
		keyRevision++;
		const key = field('ds-tr-in-key');
		if (key) {
			key.type = 'password';
			if (!keyChanged) key.value = '';
			key.placeholder = loadedConfig.hasKey ? '••••••••••••' : 'sk-...';
		}
		const button = document.getElementById('ds-tr-toggle-key');
		if (button) {
			button.setAttribute('aria-pressed', 'false');
			button.setAttribute('aria-label', '显示 API Key');
			button.title = '显示 API Key';
		}
		const slash = button?.querySelector<SVGElement>('.ds-tr-eye-slash');
		if (slash) slash.style.display = '';
	}

	function closePanel() {
		readRevision++;
		configLoaded = false;
		const mask = document.getElementById('ds-tr-mask');
		const panel = document.getElementById('ds-tr-panel');
		const saveButton = document.getElementById('ds-tr-save') as HTMLButtonElement | null;
		if (saveButton) saveButton.disabled = true;
		keyChanged = false;
		maskKey();
		if (mask) mask.style.display = 'none';
		if (panel) panel.style.display = 'none';
	}

	function makePanel() {
		const mask = document.createElement('div');
		mask.id = 'ds-tr-mask';
		mask.addEventListener('click', closePanel);
		document.body.appendChild(mask);

		const panel = document.createElement('div');
		panel.id = 'ds-tr-panel';
		panel.setAttribute('data-private', '');
		panel.innerHTML =
			'<h3>Steam 翻译助手 · 设置</h3>' +
			'<div class="hint">设置仅影响文本翻译。API Key 默认隐藏，点击眼睛才显示；留空不会替换现有 Key。</div>' +
			'<label for="ds-tr-in-key">API Key</label>' +
			'<div style="display:flex;gap:6px;align-items:center">' +
			'<input id="ds-tr-in-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-..." style="flex:1;min-width:0" />' +
			'<button id="ds-tr-toggle-key" class="ghost" type="button" aria-label="显示 API Key" aria-pressed="false" title="显示 API Key" style="padding:4px 9px;flex:none">' +
			'<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
			'<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />' +
			'<circle cx="12" cy="12" r="3" />' +
			'<path class="ds-tr-eye-slash" d="M3 3l18 18" />' +
			'</svg></button></div>' +
			'<label for="ds-tr-in-url">接口地址（OpenAI 兼容）</label>' +
			'<input id="ds-tr-in-url" placeholder="https://api.deepseek.com/chat/completions" />' +
			'<label for="ds-tr-in-model">模型</label>' +
			'<input id="ds-tr-in-model" placeholder="deepseek-chat" />' +
			'<label for="ds-tr-page-lang">页面翻译目标语言</label>' +
			'<select id="ds-tr-page-lang"></select>' +
			'<label for="ds-tr-inline-lang-setting">输入框翻译目标语言</label>' +
			'<select id="ds-tr-inline-lang-setting"></select>' +
		'<label for="ds-tr-display-mode">页面译文显示</label>' +
		'<select id="ds-tr-display-mode"><option value="replace">替换原文</option><option value="bilingual">双语对照</option></select>' +
			'<label for="ds-tr-glossary">术语表</label>' +
		'<textarea id="ds-tr-glossary" rows="4" placeholder="Steam Deck=Steam Deck&#10;Workshop=创意工坊" style="width:100%;box-sizing:border-box;background:#101822;color:#c7d5e0;border:1px solid #2a475e;border-radius:3px;padding:6px 8px;font-family:inherit;font-size:13px;line-height:1.5;resize:vertical"></textarea>' +
			'<div class="hint" style="margin:4px 0 0">每行一条，格式为“源词=译词”。</div>' +
		'<label style="display:flex;align-items:center;gap:8px;color:#c7d5e0"><input id="ds-tr-auto-default" type="checkbox" style="width:auto;margin:0" />自动翻译默认开启</label>' +
		'<div class="row" style="margin-top:6px">' +
		'<select id="ds-tr-rule-key" style="flex:1">' +
		'<option value="global">全局默认</option>' +
		'<option value="steam:store">Steam 商店</option>' +
		'<option value="steam:community">Steam 社区</option>' +
		'<option value="steam:workshop">创意工坊</option>' +
		'<option value="steam:help">Steam 帮助</option>' +
		'<option value="steam:checkout">结账页面</option>' +
		'<option value="steam:library">游戏库</option>' +
		'<option value="steam:chat">聊天</option>' +
		'<option value="steam:other">其他 Steam 页面</option>' +
		'<option value="app:custom">指定游戏 app:&lt;id&gt;</option>' +
		'</select>' +
		'<input id="ds-tr-app-id" inputmode="numeric" maxlength="12" placeholder="游戏 App ID" style="width:110px" />' +
		'<select id="ds-tr-rule-mode" style="width:130px"></select>' +
		'</div>' +
		'<div class="hint" style="margin:4px 0 0">页面规则覆盖全局默认；选择“跟随默认”会移除此页面规则。</div>' +
			'<div class="row" style="margin-top:12px;align-items:center">' +
			'<span class="hint" id="ds-tr-cache-stats" style="margin:0;flex:1">缓存：读取中…</span>' +
			'<button id="ds-tr-export-cache" class="ghost" style="padding:4px 10px">导出</button>' +
			'<button id="ds-tr-import-cache" class="ghost" style="padding:4px 10px">导入</button>' +
			'<button id="ds-tr-clear-cache" class="ghost" style="padding:4px 10px">清除</button>' +
			'<input id="ds-tr-cache-file" type="file" accept="application/json,.json" style="display:none" />' +
			'</div>' +
			'<div class="row">' +
			'<button id="ds-tr-save">保存</button>' +
			'<button id="ds-tr-read" class="ghost">读取当前</button>' +
			'<button id="ds-tr-close" class="ghost">关闭</button>' +
			'<span class="status"></span>' +
			'</div>';
		document.body.appendChild(panel);
		(panel.querySelector('#ds-tr-save') as HTMLButtonElement).disabled = true;

		const pageLang = panel.querySelector<HTMLSelectElement>('#ds-tr-page-lang')!;
		const inlineLang = panel.querySelector<HTMLSelectElement>('#ds-tr-inline-lang-setting')!;
		const ruleMode = panel.querySelector<HTMLSelectElement>('#ds-tr-rule-mode')!;
		for (const language of languages) {
			const pageOption = document.createElement('option');
			pageOption.value = language;
			pageOption.textContent = language;
			pageLang.appendChild(pageOption);
			const inlineOption = pageOption.cloneNode(true) as HTMLOptionElement;
			inlineLang.appendChild(inlineOption);
		}
		for (const mode of ruleModes) {
			const option = document.createElement('option');
			option.value = mode.value;
			option.textContent = mode.label;
			ruleMode.appendChild(option);
		}

		panel.querySelector('#ds-tr-close')?.addEventListener('click', closePanel);
		panel.querySelector('#ds-tr-save')?.addEventListener('click', saveConfig);
		panel.querySelector('#ds-tr-read')?.addEventListener('click', readConfig);
		panel.querySelector('#ds-tr-toggle-key')?.addEventListener('click', toggleKeyVisibility);
		panel.querySelector('#ds-tr-clear-cache')?.addEventListener('click', clearCache);
		panel.querySelector('#ds-tr-export-cache')?.addEventListener('click', exportCache);
		panel.querySelector('#ds-tr-import-cache')?.addEventListener('click', () => field('ds-tr-cache-file')?.click());
		panel.querySelector('#ds-tr-cache-file')?.addEventListener('change', importCacheFile);
		field('ds-tr-in-key')?.addEventListener('input', () => { keyChanged = true; keyRevision++; });
		panel.querySelector('#ds-tr-rule-key')?.addEventListener('change', () => updateRuleControls());
		field('ds-tr-app-id')?.addEventListener('input', () => updateRuleControls());
	}

	function updateRuleControls(config: any = loadedConfig) {
		const selected = (document.getElementById('ds-tr-rule-key') as HTMLSelectElement | null)?.value || 'global';
		const modeSelect = document.getElementById('ds-tr-rule-mode') as HTMLSelectElement | null;
		const appInput = field('ds-tr-app-id');
		const isApp = selected === 'app:custom';
		const isGlobal = selected === 'global';
		if (modeSelect) {
			modeSelect.disabled = isGlobal;
			const key = isApp && /^\d{1,12}$/.test(appInput?.value || '') ? 'app:' + appInput!.value : selected;
			const mode = isGlobal ? 'inherit' : config?.autoRules?.[key] || 'inherit';
			modeSelect.value = mode === true ? 'on' : mode === false ? 'off' : mode;
		}
		if (appInput) appInput.disabled = !isApp;
	}

	function setLanguage(select: HTMLSelectElement | null, language: unknown, fallback: string) {
		if (!select) return;
		const value = typeof language === 'string' && language ? language : fallback;
		if (![...select.options].some(option => option.value === value)) {
			const option = document.createElement('option');
			option.value = value;
			option.textContent = value;
			select.appendChild(option);
		}
		select.value = value;
	}

	async function toggleKeyVisibility() {
		const key = field('ds-tr-in-key');
		const button = document.getElementById('ds-tr-toggle-key');
		if (!key || !button || !configLoaded) return;
		if (button.getAttribute('aria-pressed') === 'true') { maskKey(); return; }
		const revision = ++keyRevision;
		button.setAttribute('aria-pressed', 'true');
		button.setAttribute('aria-label', '隐藏 API Key');
		button.title = '隐藏 API Key';
		const slash = button.querySelector<SVGElement>('.ds-tr-eye-slash');
		if (slash) slash.style.display = 'none';
		key.type = 'text';
		if (!keyChanged && loadedConfig.hasKey) {
			try {
				const cfg = parseResult(await backend.getConfig());
				if (revision !== keyRevision) return;
				if (typeof cfg?.apiKey !== 'string') throw Error();
				key.value = cfg.apiKey;
			} catch {
				if (revision !== keyRevision) return;
				maskKey();
				setStatus('读取 API Key 失败，请重试');
			}
		}
	}

	async function readConfig() {
		const revision = ++readRevision;
		configLoaded = false;
		keyChanged = false;
		maskKey();
		const saveButton = document.getElementById('ds-tr-save') as HTMLButtonElement | null;
		if (saveButton) saveButton.disabled = true;
		try {
			const raw = await (backend as any).getPublicConfig();
			if (revision !== readRevision) return;
			const cfg = parseResult(raw) as any;
			if (!cfg || typeof cfg !== 'object' || typeof cfg.hasKey !== 'boolean' ||
				typeof cfg.url !== 'string' || typeof cfg.model !== 'string') {
				throw new Error('配置数据不完整');
			}
			loadedConfig = cfg;
			maskKey();
			if (field('ds-tr-in-url')) field('ds-tr-in-url')!.value = cfg?.url || '';
			if (field('ds-tr-in-model')) field('ds-tr-in-model')!.value = cfg?.model || '';
			const pageLang = document.getElementById('ds-tr-page-lang') as HTMLSelectElement | null;
			const inlineLang = document.getElementById('ds-tr-inline-lang-setting') as HTMLSelectElement | null;
			setLanguage(pageLang, cfg?.pageTargetLang, '简体中文');
			setLanguage(inlineLang, cfg?.targetLang, 'English');
			const displayMode = document.getElementById('ds-tr-display-mode') as HTMLSelectElement | null;
			if (displayMode) displayMode.value = cfg?.displayMode === 'bilingual' ? 'bilingual' : 'replace';
			const glossary = document.getElementById('ds-tr-glossary') as HTMLTextAreaElement | null;
			if (glossary) glossary.value = cfg?.glossary || '';
			const autoDefault = document.getElementById('ds-tr-auto-default') as HTMLInputElement | null;
			if (autoDefault) autoDefault.checked = cfg?.autoTranslate === true;
			updateRuleControls(cfg);
			configLoaded = true;
			if (saveButton) saveButton.disabled = false;
			setStatus('已读取当前配置');
		} catch (error) {
			if (revision !== readRevision) return;
			maskKey();
			setStatus('读取失败：' + String(error));
		}
	}

	async function saveConfig() {
		if (!configLoaded) {
			setStatus('配置尚未成功读取，不能保存');
			return;
		}
		try {
			const payload: Record<string, unknown> = {
				url: field('ds-tr-in-url')?.value || '',
				model: field('ds-tr-in-model')?.value || '',
				pageTargetLang: (document.getElementById('ds-tr-page-lang') as HTMLSelectElement | null)?.value || '简体中文',
				targetLang: (document.getElementById('ds-tr-inline-lang-setting') as HTMLSelectElement | null)?.value || 'English',
				displayMode: (document.getElementById('ds-tr-display-mode') as HTMLSelectElement | null)?.value === 'bilingual' ? 'bilingual' : 'replace',
				glossary: (document.getElementById('ds-tr-glossary') as HTMLTextAreaElement | null)?.value || '',
				autoTranslate: (document.getElementById('ds-tr-auto-default') as HTMLInputElement | null)?.checked === true,
			};
			const selectedRule = (document.getElementById('ds-tr-rule-key') as HTMLSelectElement | null)?.value || 'global';
			if (selectedRule !== 'global') {
				const appId = field('ds-tr-app-id')?.value.trim() || '';
				if (selectedRule === 'app:custom' && !/^\d{1,12}$/.test(appId)) {
					setStatus('请输入 1 至 12 位数字的游戏 App ID');
					return;
				}
				const key = selectedRule === 'app:custom' ? 'app:' + appId : selectedRule;
				const mode = (document.getElementById('ds-tr-rule-mode') as HTMLSelectElement | null)?.value || 'inherit';
				payload.rulePatch = { key, mode };
			}
			const key = field('ds-tr-in-key');
			if (keyChanged && key?.value.trim()) payload.apiKey = key.value.trim();
			const result = parseResult(await backend.setConfig(JSON.stringify(payload))) as any;
			if (!result?.ok) {
				setStatus('保存失败' + (result?.error ? '：' + result.error : ''));
				return;
			}
			keyChanged = false;
			emit('ds-tr-settings-changed');
			if (document.getElementById('ds-tr-panel')?.style.display !== 'none') {
				await readConfig();
				setStatus(result.hasKey ? '已保存，立即生效' : '已保存（尚未配置 API Key）');
				await refreshCacheStats();
			}
		} catch (error) {
			setStatus('保存失败：' + String(error));
		}
	}

	async function refreshCacheStats() {
		const statsEl = document.getElementById('ds-tr-cache-stats');
		if (!statsEl) return;
		try {
			const stats = parseResult(await backend.getCacheStats()) as CacheStats;
			if (!stats?.ok) {
				statsEl.textContent = '缓存：读取失败';
				return;
			}
			const entryCount = stats.currentEntries ?? stats.entries ?? 0;
			const kb = (stats.currentBytes ?? stats.bytes ?? 0) / 1024;
			const size = kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(1) + ' KB';
			statsEl.textContent = '当前配置缓存：' + entryCount.toLocaleString() + ' 条 / ' + size;
		} catch {
			statsEl.textContent = '缓存：读取失败';
		}
	}

	async function clearCache() {
		if (!document.defaultView?.confirm('确定清除当前翻译配置对应的缓存？')) return;
		const button = document.getElementById('ds-tr-clear-cache') as HTMLButtonElement | null;
		if (button) button.disabled = true;
		try {
			const stats = parseResult(await backend.getCacheStats()) as CacheStats;
			if (!stats?.scope) throw new Error('未能获取当前缓存范围，已取消清理');
			const raw = await (backend as any).clearCache(JSON.stringify({ all: false, scope: stats?.scope }));
			const result = parseResult(raw) as any;
			setStatus(result?.ok ? '当前配置缓存已清除' : '清除失败');
			if (result?.ok) {
				emit('ds-tr-cache-cleared');
				emit('ds-tr-settings-changed');
			}
		} catch (error) {
			setStatus('清除失败：' + String(error));
		} finally {
			if (button) button.disabled = false;
			void refreshCacheStats();
		}
	}

	async function exportCache() {
		const button = document.getElementById('ds-tr-export-cache') as HTMLButtonElement | null;
		if (button) button.disabled = true;
		try {
			const result = parseResult(await (backend as any).exportCache()) as { ok?: boolean; data?: string };
			if (!result?.ok || typeof result.data !== 'string') throw new Error('导出服务返回数据无效');
			const url = URL.createObjectURL(new Blob([result.data], { type: 'application/json;charset=utf-8' }));
			const link = document.createElement('a');
			link.href = url;
			link.download = 'steamtranslator-cache.json';
			document.body.appendChild(link);
			link.click();
			link.remove();
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
			setStatus('已导出当前配置缓存');
		} catch (error) {
			setStatus('导出失败：' + String(error));
		} finally {
			if (button) button.disabled = false;
		}
	}

	async function importCacheFile() {
		const fileInput = field('ds-tr-cache-file') as HTMLInputElement | null;
		const file = fileInput?.files?.[0];
		if (!file) return;
		const button = document.getElementById('ds-tr-import-cache') as HTMLButtonElement | null;
		if (button) button.disabled = true;
		try {
			if (file.size > 40 * 1024 * 1024) throw new Error('文件超过 40 MB');
			const data = await file.text();
			const result = parseResult(await (backend as any).importCache(data)) as any;
			if (!result?.ok) throw new Error(result?.error || '文件格式或缓存内容无效');
			setStatus('已导入 ' + (result.added || 0).toLocaleString() + ' 条缓存');
			emit('ds-tr-cache-imported');
			emit('ds-tr-settings-changed');
			void refreshCacheStats();
		} catch (error) {
			setStatus('导入失败：' + String(error));
		} finally {
			if (fileInput) fileInput.value = '';
			if (button) button.disabled = false;
		}
	}

	function openPanel() {
		if (!document.getElementById('ds-tr-panel')) makePanel();
		const mask = document.getElementById('ds-tr-mask');
		const panel = document.getElementById('ds-tr-panel');
		if (mask) mask.style.display = 'block';
		if (panel) panel.style.display = 'block';
		void readConfig();
		void refreshCacheStats();
	}

	return { openPanel, closePanel, readConfig, setStatus };
}
