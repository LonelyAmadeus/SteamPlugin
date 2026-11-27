import { menuUI } from '../shared/menu';

const settings = menuUI(document);

export function SettingsContent() {
	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 4 }}>
			<div style={{ fontSize: 16, fontWeight: 600 }}>Steam 翻译助手</div>
			<button
				onClick={() => { settings.ensureStyle(); settings.openPanel(); }}
				style={{ alignSelf: 'flex-start', background: '#2a475e', color: '#fff', border: 'none', borderRadius: 3, padding: '7px 16px', cursor: 'pointer' }}
			>
				打开翻译设置
			</button>
		</div>
	);
}
