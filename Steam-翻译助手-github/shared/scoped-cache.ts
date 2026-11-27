type CacheResult = { ok?: boolean; error?: string; scope?: string; map?: Record<string, string> };

function decode(raw: unknown): CacheResult {
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as CacheResult;
}

export async function lookupScopedCache(texts: string[], scope: string): Promise<Record<string, string>> {
  if (!texts.length) return {};
  const map: Record<string, string> = Object.create(null);
  for (let index = 0; index < texts.length; index += 1800) {
    const raw = await (backend as any).lookupCache(JSON.stringify({ texts: texts.slice(index, index + 1800), scope }));
    const result = decode(raw);
    if (!result?.ok || result.scope !== scope) throw Error(result?.error || 'SCOPE_CHANGED');
    for (const [key, value] of Object.entries(result.map || {})) map[key] = value;
  }
  return map;
}

export async function putScopedCache(entries: Record<string, string>, scope: string): Promise<void> {
  const keys = Object.keys(entries);
  for (let index = 0; index < keys.length; index += 200) {
    const batch: Record<string, string> = Object.create(null);
    for (const key of keys.slice(index, index + 200)) batch[key] = entries[key];
    const raw = await (backend as any).putCache(JSON.stringify({ entries: batch, scope }));
    const result = decode(raw);
    if (!result?.ok || result.scope !== scope) throw Error(result?.error || 'SCOPE_CHANGED');
  }
}

export async function deleteScopedCache(keys: string[], scope: string): Promise<void> {
  for (let index = 0; index < keys.length; index += 1000) {
    const raw = await (backend as any).deleteCache(JSON.stringify({ keys: keys.slice(index, index + 1000), scope }));
    const result = decode(raw);
    if (!result?.ok || result.scope !== scope) throw Error(result?.error || 'SCOPE_CHANGED');
  }
}
