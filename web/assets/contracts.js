// Forge Contracts — browser-safe pure logic over contracts-catalog.json.
// No node/browser-only imports at module scope (loadCatalog uses fetch, called only in browser).

export function parseCatalog(text) {
  const c = JSON.parse(text);
  if (!c || !Array.isArray(c.templates)) throw new Error('contracts-catalog: bad shape');
  return c;
}

export async function loadCatalog(url = '/assets/contracts-catalog.json') {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error('contracts-catalog: HTTP ' + res.status);
  return parseCatalog(await res.text());
}

export function getTemplate(catalog, id) {
  if (!catalog || !id) return null;
  return catalog.templates.find((t) => t.id === id) || null;
}

// Templates to show in browse/pick surfaces (catalog page, escrow picker). Drops `hidden`
// entries (staging gate) while preserving catalog order. getTemplate() is intentionally NOT
// filtered — an existing deal on a hidden template must still resolve its metadata for display.
export function visibleTemplates(catalog) {
  const list = catalog && Array.isArray(catalog.templates) ? catalog.templates : [];
  return list.filter((t) => t && !t.hidden);
}

export function classOf(tmpl) {
  return tmpl && tmpl.class;
}

export function windowForShipping(tmpl, geo) {
  const map = tmpl && tmpl.window_by_shipping;
  if (map && Object.prototype.hasOwnProperty.call(map, geo)) return map[geo];
  return tmpl ? tmpl.window_default : 0;
}

export function evidenceState(tmpl, msgs) {
  const list = (msgs || []);
  const hasTrack = list.some((m) => m && m.t === 'track');
  const hasMedia = list.some((m) => m && m.t === 'media');
  return (tmpl && tmpl.evidence ? tmpl.evidence : []).map((e) => ({
    id: e.id,
    label: e.label,
    kind: e.kind,
    required: !!e.required,
    done: e.kind === 'tracking' ? hasTrack : e.kind === 'file' ? hasMedia : false,
  }));
}

export function loc(obj, lang) {
  return (obj && (obj[lang] || obj.en)) || '';
}
