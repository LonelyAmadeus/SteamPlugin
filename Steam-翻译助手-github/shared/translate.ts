// Bound the UTF-8 size of the source text, including the separators used by Lua.
const budget = 3200;
const encoder = new TextEncoder();

function splitLong(text: string, limit: number): string[] {
  const parts: string[] = [];
  let start = 0, bytes = 0, offset = 0, boundary = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) {
      const end = boundary > start ? boundary : offset;
      parts.push(text.slice(start, end));
      start = end;
      bytes = encoder.encode(text.slice(start, offset)).length;
      if (bytes + size > limit) {
        parts.push(text.slice(start, offset));
        start = offset;
        bytes = 0;
      }
    }
    bytes += size;
    offset += char.length;
    if (/[\s。！？.!?]/u.test(char)) boundary = offset;
  }
  if (offset > start) parts.push(text.slice(start));
  return parts;
}

export async function translateBounded(texts: string[], current: () => boolean) {
  const output: string[][] = texts.map(() => []);
  const pieces = texts.flatMap((text, index) =>
    splitLong(text, budget).map(part => ({part, index})));
  type Piece = typeof pieces[number];
  async function send(batch: Piece[]): Promise<void> {
    if (!current()) return;
    const raw = await backend.translateAll(JSON.stringify({texts: batch.map(p => p.part.trim())}));
    if (!current()) return;
    const res = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const limited = ['OUTPUT_LIMIT', 'HTTP 413'].includes(res.error);
    if (!res.ok && !limited) throw Error(res.error);
    if (limited || !Array.isArray(res.texts) || res.texts.length !== batch.length ||
        !res.texts.every((s: unknown) => typeof s === 'string' && s.trim())) {
      if (batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        await send(batch.slice(0, mid));
        await send(batch.slice(mid));
        return;
      }
      const {part, index} = batch[0];
      const size = encoder.encode(part).length;
      if (size > 128) {
        for (const piece of splitLong(part, Math.ceil(size / 2))) {
          if (piece.trim()) await send([{part: piece, index}]);
          else output[index].push(piece);
        }
      } else output[index].push('');
      return;
    }
    batch.forEach(({part, index}, i) => output[index].push(
      part.replace(/\S[\s\S]*\S|\S/u, () => res.texts[i].trim())));
  }
  let batch: Piece[] = [], bytes = 0;
  for (const piece of pieces) {
    if (!current()) break;
    const size = encoder.encode(piece.part).length;
    if (batch.length && (bytes + 5 + size > budget || !piece.part.trim())) {
      await send(batch);
      batch = [];
      bytes = 0;
    }
    if (!piece.part.trim()) { output[piece.index].push(piece.part); continue; }
    bytes += size + (batch.length ? 5 : 0);
    batch.push(piece);
  }
  if (batch.length) await send(batch);
  return {ok: true, texts: output.map(parts => parts.includes('') ? '' : parts.join(''))};
}
