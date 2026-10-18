import { normalizeCommunityActor } from './github.js';

export const COMMUNITY_KINDS = Object.freeze(['pull_request', 'issue', 'review', 'comment', 'fork', 'contributor']);
const kindSet = new Set(COMMUNITY_KINDS);
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const timestamp = value => validDate(value) ? new Date(value).toISOString() : null;
const isOpen = item => item.state === 'open' || item.state === 'draft';
const lifecycleKind = kind => kind === 'pull_request' || kind === 'issue';
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const safeUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port ? url.href : null; }
  catch { return null; }
};

/** Collaboration objects are distinct from commits and file changes. */
export function buildCommunityModel(dataset) {
  if (!dataset?.repository || !Array.isArray(dataset.items) || !Array.isArray(dataset.events)) throw new Error('Collaboration activity is missing its repository, items or events.');
  const byId = new Map();
  for (const raw of dataset.items) {
    if (!raw || typeof raw.id !== 'string' || !kindSet.has(raw.kind) || byId.has(raw.id)) continue;
    byId.set(raw.id, { ...raw, title: String(raw.title || raw.kind), url: safeUrl(raw.url), actor: normalizeCommunityActor(raw.actor),
      createdAt: timestamp(raw.createdAt), updatedAt: timestamp(raw.updatedAt),
      state: typeof raw.state === 'string' ? raw.state : null,
      contributions: raw.kind === 'contributor' ? Math.max(0, Math.floor(Number(raw.contributions) || 0)) : undefined });
  }
  const eventIds = new Set();
  const events = dataset.events.filter(event => event && typeof event.id === 'string' && !eventIds.has(event.id) && byId.has(event.itemId) && validDate(event.date) && (eventIds.add(event.id), true))
    .map(event => ({ ...event, kind: byId.get(event.itemId).kind, date: timestamp(event.date), actor: normalizeCommunityActor(event.actor) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const items = [...byId.values()];
  const actors = new Map();
  function addActor(actor, field, kind) {
    if (!actor.login) return;
    const key = actor.login.toLowerCase();
    if (!actors.has(key)) actors.set(key, { ...actor, itemCount: 0, eventCount: 0, kinds: new Set() });
    const record = actors.get(key); record[field]++; record.kinds.add(kind);
  }
  for (const item of items) addActor(item.actor, 'itemCount', item.kind);
  for (const event of events) addActor(event.actor, 'eventCount', event.kind);
  const kindStats = Object.fromEntries(COMMUNITY_KINDS.map(kind => {
    const records = items.filter(item => item.kind === kind);
    const loaded = records.length, loadedOpen = lifecycleKind(kind) ? records.filter(isOpen).length : null;
    const raw = dataset.counts?.[kind];
    const total = Math.max(loaded, validCount(raw?.total) ? raw.total : 0, lifecycleKind(kind) && validCount(raw?.open) ? raw.open : 0);
    const open = lifecycleKind(kind) ? Math.max(loadedOpen, validCount(raw?.open) ? raw.open : 0) : null;
    return [kind, { total, open, loaded, loadedOpen, exact: Boolean(raw?.exact === true && validCount(raw.total) && raw.total === total), openExact: Boolean(lifecycleKind(kind) && raw?.openExact === true && validCount(raw.open) && raw.open === open) }];
  }));
  return { dataset, repository: dataset.repository, items, byId, events, kindStats,
    actors: [...actors.values()].map(actor => ({ ...actor, kinds: [...actor.kinds] })).sort((a, b) => a.login.localeCompare(b.login)) };
}

/** Cursor hides objects not yet created; it never fabricates past states/counts. */
export function filterCommunityItems(model, { query = '', kinds = [], actor = '', state = '', historyKind = null } = {}, cursorDate = null) {
  const search = String(query).trim().toLowerCase();
  const selectedKinds = new Set(kinds || []);
  const historicalKind = selectedKinds.size === 1 && selectedKinds.has(historyKind) && lifecycleKind(historyKind) ? historyKind : null;
  const selectedActor = String(actor || '').toLowerCase();
  const cursor = cursorDate instanceof Date ? cursorDate.getTime() : validDate(cursorDate) ? Date.parse(cursorDate) : null;
  const related = new Set();
  if (selectedActor) for (const event of model.events) {
    if (event.actor.login?.toLowerCase() === selectedActor && (cursor === null || Date.parse(event.date) <= cursor)) related.add(event.itemId);
  }
  return model.items.filter(item => (!selectedKinds.size || selectedKinds.has(item.kind))
    && (!lifecycleKind(item.kind) || isOpen(item) || historicalKind === item.kind)
    && (!state || (state === 'open' ? isOpen(item) : item.state === state))
    && (!selectedActor || item.actor.login?.toLowerCase() === selectedActor || related.has(item.id))
    && (!search || [item.title, item.id, item.actor.login || '', item.number == null ? '' : `#${item.number}`, item.state || ''].some(value => String(value).toLowerCase().includes(search)))
    && (cursor === null || item.kind === 'contributor' || !item.createdAt || Date.parse(item.createdAt) <= cursor));
}
