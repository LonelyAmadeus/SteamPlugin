import { definePlugin } from 'millennium';

const box: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, padding: 4 };
const label: React.CSSProperties = { fontSize: 12, color: '#8ba6b8' };
const input: React.CSSProperties = {
	width: '100%',
	maxWidth: 520,
	background: '#101822',
	border: '1px solid #2a475e',
	color: '#c7d5e0',
	padding: '6px 8px',
	borderRadius: 3,
	fontSize: 13,
	boxSizing: 'border-box',
};

async function load() {
	const status = document.getElementById('ds-tr-status');
	try {
		const raw: any = await backend.getConfig();
		const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
		const set = (id: string, v: string) => {
			const el = document.getElementById(id) as HTMLInputElement | null;
			if (el) el.value = v || '';
		};
		set('ds-tr-key', cfg?.apiKey);
		set('ds-tr-url', cfg?.url);
		set('ds-tr-model', cfg?.model);
		if (status) status.textContent = '已读取当前配置';
	} catch (e) {
		if (status) status.textContent = '读取失败: ' + String(e);
	}
}

async function save() {
	const get = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
	const status = document.getElementById('ds-tr-status');
	try {
		const res: any = await backend.setConfig(
			JSON.stringify({ apiKey: get('ds-tr-key'), url: get('ds-tr-url'), model: get('ds-tr-model') }),
		);
		if (status) status.textContent = res?.ok ? '已保存，立即生效' : '保存失败';
	} catch (e) {
		if (status) status.textContent = '保存失败: ' + String(e);
	}
}

function SettingsContent() {
	return (
		<div style={box}>
			<div style={{ fontSize: 16, fontWeight: 600 }}>Steam 翻译助手</div>
			<div style={{ fontSize: 12, color: '#8ba6b8' }}>
				在工坊页面右键 → 翻译此页；再右键 → 还原原文。只替换文字，图片与排版保持不变。
			</div>

			<div style={label}>API Key</div>
			<input id="ds-tr-key" style={input} placeholder="sk-..." />

			<div style={label}>接口地址（OpenAI 兼容）</div>
			<input id="ds-tr-url" style={input} placeholder="https://api.deepseek.com/chat/completions" />

			<div style={label}>模型</div>
			<input id="ds-tr-model" style={input} placeholder="deepseek-chat" />

			<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
				<button
					onClick={save}
					style={{ background: '#2a475e', color: '#fff', border: 'none', borderRadius: 3, padding: '7px 18px', cursor: 'pointer' }}
				>
					保存
				</button>
				<button
					onClick={load}
					style={{ background: '#1b2838', color: '#c7d5e0', border: '1px solid #2a475e', borderRadius: 3, padding: '7px 14px', cursor: 'pointer' }}
				>
					读取当前配置
				</button>
				<span id="ds-tr-status" style={{ fontSize: 12, color: '#8ba6b8' }} />
			</div>
		</div>
	);
}

export default definePlugin(() => {
	return {
		title: 'Steam 翻译助手',
		content: <SettingsContent />,
	};
});
