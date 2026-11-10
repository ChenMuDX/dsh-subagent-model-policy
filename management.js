// Session-scoped strategy library, model pool, shared limits and new-session
// default. Pure rules only: no Host access, no storage, no timers.
//
// Storage compatibility: a `policies` record may still be the v1 shape
// {revision, policy}. Such a record is read as a *legacy* library view and is
// never rewritten by a read. The first explicit library mutation materializes
// it, preserving the legacy strategy (including `mode=inherit`) instead of
// silently converting it to fixed/auto.
import { defaults, fail, routeKey, sameRoute } from './policy.js';

export const LIBRARY_VERSION = 1;
export const MAX_MODELS = 24;
export const MAX_NAME = 60;
export const MAX_TEXT = 2000;
export const MAX_PURPOSE = 500;
export const MAX_NOTE = 500;
export const PLUGIN_MAX_ACTIVE = 32;
export const MAX_SKIPPED = 24;
export const STRATEGY_TYPES = Object.freeze(['fixed', 'auto']);
// Why a saved default route was not imported into a brand-new session.
export const SKIP_REASONS = Object.freeze(['unauthorized', 'fixed-target-unauthorized']);
export const LEGACY_STRATEGY_ID = 'legacy';
export const LEGACY_INHERIT_ID = 'legacy-inherit';

const clone = (value) => structuredClone(value);
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const routeOf = (value) => ({ provider: value.provider, model: value.model });
export const routeKeyOf = (value) => routeKey(value);

function textValue(value, max, field, opts = {}) {
  const fallback = opts.fallback ?? '';
  if (value === undefined && opts.optional) return fallback;
  if (typeof value !== 'string') fail(`${field} 必须是字符串`);
  if (value.length > max) fail(`${field} 过长（最多 ${max} 字符）`);
  const trimmed = opts.trim === false ? value : value.trim();
  if (!opts.allowEmpty && !trimmed) fail(`${field} 不能为空`);
  return trimmed;
}

function intValue(value, min, max, field) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${field} 必须是 ${min}–${max} 的整数`);
  return value;
}

function requestObject(raw, allowed, field) {
  if (!isObject(raw)) fail(`${field} 必须是对象`);
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) fail(`${field} 存在未知字段：${key}`);
  return raw;
}

/** Validate a route array for a request; duplicate routes are rejected. */
export function readRoutes(raw, field = '模型', max = MAX_MODELS) {
  if (!Array.isArray(raw)) fail(`${field}必须是数组`);
  if (raw.length > max) fail(`${field}最多 ${max} 项`);
  const seen = new Set();
  return raw.map((item) => {
    requestObject(item, ['provider', 'model'], field);
    const route = {
      provider: textValue(item.provider, 200, `${field} provider`),
      model: textValue(item.model, 200, `${field} model`),
    };
    const key = routeKey(route);
    if (seen.has(key)) fail(`${field}存在重复路由：${route.provider}/${route.model}`);
    seen.add(key);
    return route;
  });
}

/** Validate one pool entry as sent by the client. */
export function readPoolEntries(raw, field = '模型池') {
  if (!Array.isArray(raw)) fail(`${field}必须是数组`);
  if (raw.length > MAX_MODELS) fail(`${field}最多 ${MAX_MODELS} 项`);
  const seen = new Set();
  return raw.map((item) => {
    requestObject(item, ['provider', 'model', 'purpose', 'note'], field);
    const entry = {
      provider: textValue(item.provider, 200, `${field} provider`),
      model: textValue(item.model, 200, `${field} model`),
      purpose: textValue(item.purpose, MAX_PURPOSE, '简短用途', { optional: true, allowEmpty: true }),
      note: textValue(item.note, MAX_NOTE, '通用使用说明', { optional: true, allowEmpty: true }),
    };
    const key = routeKey(entry);
    if (seen.has(key)) fail(`${field}存在重复模型：${entry.provider}/${entry.model}`);
    seen.add(key);
    return entry;
  });
}

/** Validate a strategy form. Type is restricted to the two page types. */
export function readStrategyDraft(raw, field = '策略') {
  requestObject(raw, ['id', 'name', 'type', 'models', 'fixedProvider', 'fixedModel', 'strategyText'], field);
  const draft = {
    id: raw.id === undefined ? undefined : textValue(raw.id, 120, '策略 id'),
    name: textValue(raw.name, MAX_NAME, '策略名称'),
    type: raw.type,
    models: readRoutes(raw.models, '策略引用模型'),
    fixedProvider: textValue(raw.fixedProvider, 200, '固定提供方', { optional: true, allowEmpty: true }),
    fixedModel: textValue(raw.fixedModel, 200, '固定模型', { optional: true, allowEmpty: true }),
    strategyText: textValue(raw.strategyText, MAX_TEXT, '选择说明', { optional: true, allowEmpty: true }),
  };
  if (!STRATEGY_TYPES.includes(draft.type)) fail('策略类型必须是固定模型或 Agent 自选');
  if (!draft.models.length) fail('至少选择一个模型');
  if (draft.type === 'fixed') {
    if (draft.models.length !== 1) fail('固定模型策略只能选择一个模型');
    const only = draft.models[0];
    if ((draft.fixedProvider && draft.fixedProvider !== only.provider) || (draft.fixedModel && draft.fixedModel !== only.model)) {
      fail('固定模型必须来自策略中选择的模型');
    }
    draft.fixedProvider = only.provider;
    draft.fixedModel = only.model;
    draft.strategyText = '';
  } else {
    if (draft.fixedProvider || draft.fixedModel) fail('Agent 自选策略不应包含固定模型');
    draft.fixedProvider = '';
    draft.fixedModel = '';
  }
  return draft;
}

/** Validate a strategy persisted in a library record (never trims away data). */
function readStoredStrategy(raw, field = '已保存策略') {
  if (!isObject(raw)) fail(`${field}必须是对象`);
  const legacy = raw.legacy === true;
  const strategy = {
    id: textValue(raw.id, 120, `${field} id`),
    name: textValue(raw.name, MAX_NAME, `${field} 名称`),
    type: raw.type,
    models: readRoutes(raw.models, `${field} 引用模型`),
    fixedProvider: typeof raw.fixedProvider === 'string' ? raw.fixedProvider : '',
    fixedModel: typeof raw.fixedModel === 'string' ? raw.fixedModel : '',
    strategyText: typeof raw.strategyText === 'string' ? raw.strategyText : '',
    version: intValue(raw.version, 1, Number.MAX_SAFE_INTEGER, `${field} 版本`),
  };
  if (!STRATEGY_TYPES.includes(strategy.type) && strategy.type !== 'inherit') fail(`${field} 类型无效`);
  if (strategy.type === 'inherit') {
    if (!legacy) fail(`${field} 的跟随类型仅用于旧版只读策略`);
    strategy.legacy = true;
  } else if (strategy.type === 'fixed') {
    if (!strategy.models.length) fail(`${field} 固定模型至少需要一个路由`);
    // A v1 legacy fixed policy may keep several candidates and its fixed target
    // may be any one of them. New strategies stay strictly single-model.
    const target = { provider: strategy.fixedProvider, model: strategy.fixedModel };
    if (!strategy.models.some((route) => sameRoute(route, target))) fail(`${field} 固定路由不一致`);
    if (!legacy && strategy.models.length !== 1) fail(`${field} 固定模型必须只有一个路由`);
  } else if (!strategy.models.length) {
    fail(`${field} 至少需要一个引用模型`);
  }
  if (legacy) strategy.legacy = true;
  return strategy;
}

function readModelsInfo(raw, field = '模型说明') {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(`${field}必须是数组`);
  return raw.map((item) => {
    if (!isObject(item)) fail(`${field} 必须是对象`);
    return {
      provider: textValue(item.provider, 200, `${field} provider`),
      model: textValue(item.model, 200, `${field} model`),
      name: typeof item.name === 'string' ? item.name : String(item.model),
      purpose: typeof item.purpose === 'string' ? item.purpose : '',
      note: typeof item.note === 'string' ? item.note : '',
    };
  });
}

/**
 * Sanitize one skipped-import record. `initialized.skipped` is diagnostic
 * metadata, so an unreadable entry is dropped instead of making an otherwise
 * valid library unreadable; an old record simply has no `skipped` at all.
 */
function readSkippedEntry(raw) {
  if (!isObject(raw)) return null;
  if (!SKIP_REASONS.includes(raw.reason)) return null;
  const provider = typeof raw.provider === 'string' ? raw.provider.trim().slice(0, 200) : '';
  const model = typeof raw.model === 'string' ? raw.model.trim().slice(0, 200) : '';
  if (!provider || !model) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_NAME) : '';
  return { provider, model, ...(name ? { name } : {}), reason: raw.reason };
}

function readSkipped(raw) {
  if (!Array.isArray(raw)) return [];
  const skipped = [];
  for (const item of raw) {
    if (skipped.length >= MAX_SKIPPED) break;
    const entry = readSkippedEntry(item);
    if (entry) skipped.push(entry);
  }
  return skipped;
}

/** Build one sanitized skipped-import record from a route plus an optional name. */
function skippedRecord(route, name, reason) {
  const provider = typeof route?.provider === 'string' ? route.provider.trim().slice(0, 200) : '';
  const model = typeof route?.model === 'string' ? route.model.trim().slice(0, 200) : '';
  const label = typeof name === 'string' ? name.trim().slice(0, MAX_NAME) : '';
  return { provider, model, ...(label ? { name: label } : {}), reason };
}

function readLimits(raw, field = '会话限制') {
  if (raw === null || raw === undefined) return null;
  if (!isObject(raw)) fail(`${field} 必须是对象`);
  return {
    maxDepth: intValue(raw.maxDepth, 0, Math.min(32, PLUGIN_MAX_ACTIVE), `${field} 深度`),
    maxActive: intValue(raw.maxActive, 1, PLUGIN_MAX_ACTIVE, `${field} 并发子智能体数量`),
  };
}

function readSnapshot(raw, field = '已启用内容') {
  if (!isObject(raw)) fail(`${field} 必须是对象`);
  const legacy = raw.legacy === true;
  const snapshot = {
    version: intValue(raw.version, 1, Number.MAX_SAFE_INTEGER, `${field} 版本`),
    strategyId: typeof raw.strategyId === 'string' ? raw.strategyId : '',
    name: textValue(raw.name, MAX_NAME, `${field} 名称`),
    type: raw.type,
    models: readRoutes(raw.models, `${field} 模型`),
    fixedProvider: typeof raw.fixedProvider === 'string' ? raw.fixedProvider : '',
    fixedModel: typeof raw.fixedModel === 'string' ? raw.fixedModel : '',
    strategyText: typeof raw.strategyText === 'string' ? raw.strategyText : '',
    modelsInfo: readModelsInfo(raw.modelsInfo),
    capturedAt: Number.isSafeInteger(raw.capturedAt) ? raw.capturedAt : null,
  };
  if (!STRATEGY_TYPES.includes(snapshot.type) && snapshot.type !== 'inherit') fail(`${field} 类型无效`);
  if (snapshot.type === 'inherit' && !legacy) fail(`${field} 的跟随类型只能来自旧版只读快照`);
  if (snapshot.type === 'fixed') {
    if (!snapshot.models.length) fail(`${field} 固定模型至少需要一个路由`);
    // Legacy snapshots keep every v1 candidate and may target any of them.
    if (!snapshot.models.some((route) => sameRoute(route, { provider: snapshot.fixedProvider, model: snapshot.fixedModel }))) fail(`${field} 固定路由不一致`);
    if (!legacy && snapshot.models.length !== 1) fail(`${field} 固定模型必须只有一个路由`);
  }
  if (legacy) snapshot.legacy = true;
  return snapshot;
}

/** Read one persisted library. Unknown fields are tolerated; known fields are validated. */
export function readLibrary(raw) {
  if (!isObject(raw)) fail('策略库数据无效');
  if (raw.version !== LIBRARY_VERSION) fail(`策略库版本不受支持：${String(raw.version)}`);
  if (!Array.isArray(raw.strategies)) fail('策略库 strategies 无效');
  if (raw.strategies.length > 50) fail('策略库策略过多');
  const strategies = raw.strategies.map((strategy) => readStoredStrategy(strategy));
  const ids = new Set();
  for (const strategy of strategies) {
    if (ids.has(strategy.id)) fail(`策略库存在重复 id：${strategy.id}`);
    ids.add(strategy.id);
  }
  const pool = readPoolEntriesLenient(raw.pool);
  let active = null;
  if (raw.active !== null && raw.active !== undefined) {
    if (!isObject(raw.active)) fail('已启用策略记录无效');
    active = {
      strategyId: textValue(raw.active.strategyId, 120, '已启用策略 id'),
      appliedAt: Number.isSafeInteger(raw.active.appliedAt) ? raw.active.appliedAt : null,
      snapshot: readSnapshot(raw.active.snapshot),
    };
  }
  let initialized = null;
  if (isObject(raw.initialized)) {
    initialized = {
      at: Number.isSafeInteger(raw.initialized.at) ? raw.initialized.at : null,
      defaultRevision: Number.isSafeInteger(raw.initialized.defaultRevision) ? raw.initialized.defaultRevision : null,
      source: raw.initialized.source === 'default' ? 'default' : 'none',
    };
    // Additive and optional: `skipped` records default routes the Host did not
    // authorize at import time. Records written before it existed stay valid and
    // an empty list is never persisted as a field.
    const skipped = readSkipped(raw.initialized.skipped);
    if (skipped.length) initialized.skipped = skipped;
  }
  const legacyPolicy = isObject(raw.legacyPolicy) ? clone(raw.legacyPolicy) : undefined;
  return { version: LIBRARY_VERSION, strategies, pool, limits: readLimits(raw.limits), active, initialized, legacyPolicy };
}

function readPoolEntriesLenient(raw) {
  if (!Array.isArray(raw)) fail('模型池数据无效');
  if (raw.length > MAX_MODELS) fail('模型池条目过多');
  const seen = new Set();
  return raw.map((item) => {
    if (!isObject(item)) fail('模型池条目无效');
    const entry = {
      provider: textValue(item.provider, 200, '模型池 provider'),
      model: textValue(item.model, 200, '模型池 model'),
      purpose: typeof item.purpose === 'string' ? item.purpose.slice(0, MAX_PURPOSE) : '',
      note: typeof item.note === 'string' ? item.note.slice(0, MAX_NOTE) : '',
    };
    if (seen.has(routeKey(entry))) fail('模型池存在重复模型');
    seen.add(routeKey(entry));
    return entry;
  });
}

/** Read the global new-session default record. */
export function readDefault(raw) {
  if (!isObject(raw)) fail('新会话默认数据无效');
  if (raw.default === null || raw.default === undefined) return null;
  if (!isObject(raw.default)) fail('新会话默认内容无效');
  const value = raw.default;
  const snapshot = readSnapshot({ ...value, strategyId: value.sourceId || '' }, '新会话默认');
  const limits = readLimits(value.limits, '默认会话限制');
  const sourceId = typeof value.sourceId === 'string' ? value.sourceId : '';
  const sourceName = typeof value.sourceName === 'string' ? value.sourceName : '';
  if (snapshot.type === 'inherit') fail('新会话默认不能来自跟随类型');
  return { ...snapshot, sourceId, sourceName, sourceVersion: intValue(value.sourceVersion ?? snapshot.version, 1, Number.MAX_SAFE_INTEGER, '默认来源版本'), limits };
}

/** Legacy policy -> read-only library view (never persisted by a read). */
export function legacyLibrary(policy) {
  const pool = (policy.models || []).map((model) => ({
    provider: model.provider,
    model: model.model,
    purpose: model.scenarios || '',
    note: model.limitations || '',
  }));
  const type = policy.mode === 'inherit' ? 'inherit' : policy.mode;
  const strategy = {
    id: type === 'inherit' ? LEGACY_INHERIT_ID : LEGACY_STRATEGY_ID,
    name: type === 'inherit' ? '旧版跟随策略' : '旧版会话策略',
    type,
    models: pool.map(routeOf),
    fixedProvider: type === 'fixed' ? policy.fixedProvider : '',
    fixedModel: type === 'fixed' ? policy.fixedModel : '',
    strategyText: policy.strategyText || '',
    version: 1,
    legacy: true,
  };
  const limits = { maxDepth: policy.maxDepth, maxActive: policy.maxActive };
  const active = policy.enabled
    ? { strategyId: strategy.id, appliedAt: null, snapshot: snapshotForStrategy(strategy, pool, { now: null, limits, strategyId: strategy.id }) }
    : null;
  return { version: LIBRARY_VERSION, strategies: [strategy], pool, limits, active, initialized: null };
}

/** Materialize a legacy policy into an explicit library (lossless, not a type conversion). */
export function materializeLegacy(policy) {
  const library = legacyLibrary(policy);
  // Keep the exact legacy policy so pooled/limits-only edits do not change the
  // effective preset, model notes or cost/speed/source metadata until the user
  // explicitly saves the enabled strategy or enables another one.
  library.legacyPolicy = clone(policy);
  return library;
}

/** Empty explicit library for a brand-new root without a default. */
export function emptyLibrary({ now } = {}) {
  return {
    version: LIBRARY_VERSION,
    strategies: [],
    pool: [],
    limits: null,
    active: null,
    initialized: { at: Number.isSafeInteger(now) ? now : Date.now(), defaultRevision: null, source: 'none' },
  };
}

/** Build the effective runtime policy from an explicit library and current saved limits. */
export function buildPolicy(library, hostDepth) {
  const limits = library.limits;
  const active = library.active;
  const maxDepth = limits ? limits.maxDepth : hostDepth;
  const maxActive = limits ? limits.maxActive : PLUGIN_MAX_ACTIVE;
  const unset = !limits;
  if (!active) {
    return {
      ...defaults(hostDepth, []),
      enabled: false,
      maxDepth,
      maxActive,
      limitsUnset: unset,
    };
  }
  if (library.legacyPolicy && (active.strategyId === LEGACY_STRATEGY_ID || active.strategyId === LEGACY_INHERIT_ID)) {
    const legacy = clone(library.legacyPolicy);
    // pool.note/save/sync refresh only active.snapshot.modelsInfo, while the
    // legacy copy still drives the effective policy. Fold those descriptions in
    // by route so the next preview/injection sees them; preset, strategyText,
    // the fixed target and cost/speed/source stay exactly as saved.
    const infos = Array.isArray(active.snapshot?.modelsInfo) ? active.snapshot.modelsInfo : [];
    if (infos.length) {
      const byKey = new Map(infos.map((info) => [routeKey(info), info]));
      legacy.models = (legacy.models || []).map((model) => {
        const info = byKey.get(routeKey(model));
        return info
          ? { ...model, scenarios: info.purpose || '', limitations: info.note || '' }
          : model;
      });
    }
    legacy.maxDepth = maxDepth;
    legacy.maxActive = maxActive;
    legacy.limitsUnset = unset;
    return legacy;
  }
  const snapshot = active.snapshot;
  const infos = Array.isArray(snapshot.modelsInfo) && snapshot.modelsInfo.length
    ? snapshot.modelsInfo
    : (snapshot.models || []).map((route) => ({ ...route, name: route.model, purpose: '', note: '' }));
  const models = infos.map((info) => ({
    provider: info.provider,
    model: info.model,
    scenarios: info.purpose || '',
    limitations: info.note || '',
    cost: 'unknown',
    speed: 'unknown',
    source: 'unverified',
  }));
  return {
    enabled: true,
    mode: snapshot.type === 'inherit' ? 'inherit' : snapshot.type,
    preset: 'custom',
    strategyText: snapshot.strategyText || '',
    maxDepth,
    maxActive,
    limitsUnset: unset,
    fixedProvider: snapshot.fixedProvider || '',
    fixedModel: snapshot.fixedModel || '',
    models,
  };
}

/** Build a snapshot from a strategy + pool descriptions. */
export function snapshotForStrategy(strategy, pool, { now = Date.now(), limits = null, strategyId = strategy.id } = {}) {
  const byKey = new Map(pool.map((entry) => [routeKey(entry), entry]));
  const models = strategy.models.map(routeOf);
  const modelsInfo = models.map((route) => {
    const entry = byKey.get(routeKey(route));
    return {
      provider: route.provider,
      model: route.model,
      name: entry?.name || route.model,
      purpose: entry?.purpose || '',
      note: entry?.note || '',
    };
  });
  return {
    version: strategy.version,
    strategyId,
    name: strategy.name,
    type: strategy.type,
    models,
    fixedProvider: strategy.type === 'fixed' ? strategy.fixedProvider : '',
    fixedModel: strategy.type === 'fixed' ? strategy.fixedModel : '',
    // Legacy v1 policies can carry a non-empty fixed-mode strategyText; never
    // drop it from the view or the effective snapshot.
    strategyText: strategy.strategyText || '',
    modelsInfo,
    capturedAt: now,
    limits: limits ? clone(limits) : null,
    ...(strategy.legacy === true ? { legacy: true } : {}),
  };
}

/**
 * Refresh the descriptions of an active snapshot from the current session pool.
 * Only `purpose`/`note` follow the pool; display names, models, version and every
 * other field are preserved, so saving pool content never rewrites a strategy.
 */
export function refreshSnapshotInfo(snapshot, pool) {
  if (!snapshot) return null;
  const byKey = new Map(pool.map((entry) => [routeKey(entry), entry]));
  const modelsInfo = (snapshot.models || []).map((route) => {
    const known = (snapshot.modelsInfo || []).find((info) => sameRoute(info, route));
    const entry = byKey.get(routeKey(route));
    return {
      provider: route.provider,
      model: route.model,
      name: known?.name || entry?.name || route.model,
      purpose: entry?.purpose || '',
      note: entry?.note || '',
    };
  });
  return { ...clone(snapshot), modelsInfo };
}

/** Snapshot content comparison used for "no modification means no version bump". */
export function snapshotContent(snapshot) {
  if (!snapshot) return null;
  return {
    name: snapshot.name,
    type: snapshot.type,
    models: (snapshot.models || []).map(routeOf),
    fixedProvider: snapshot.fixedProvider || '',
    fixedModel: snapshot.fixedModel || '',
    strategyText: snapshot.strategyText || '',
    modelsInfo: (snapshot.modelsInfo || []).map((info) => ({
      provider: info.provider, model: info.model, name: info.name, purpose: info.purpose || '', note: info.note || '',
    })),
  };
}

export function sameSnapshotContent(left, right) {
  return JSON.stringify(snapshotContent(left)) === JSON.stringify(snapshotContent(right));
}

export function sameStrategyContent(left, right) {
  if (!left || !right) return false;
  return JSON.stringify(strategyContent(left)) === JSON.stringify(strategyContent(right));
}

export function strategyContent(strategy) {
  return {
    name: strategy.name,
    type: strategy.type,
    models: (strategy.models || []).map(routeOf),
    fixedProvider: strategy.fixedProvider || '',
    fixedModel: strategy.fixedModel || '',
    strategyText: strategy.strategyText || '',
  };
}

/** A strategy whose references left the pool (or whose fixed target did). */
export function stalePoolRefs(strategy, pool) {
  const keys = new Set(pool.map(routeKey));
  const stale = [];
  for (const route of strategy.models || []) if (!keys.has(routeKey(route))) stale.push(route);
  if (strategy.type === 'fixed' && strategy.fixedProvider && !keys.has(routeKey({ provider: strategy.fixedProvider, model: strategy.fixedModel }))) {
    if (!stale.some((route) => sameRoute(route, { provider: strategy.fixedProvider, model: strategy.fixedModel }))) {
      stale.push({ provider: strategy.fixedProvider, model: strategy.fixedModel });
    }
  }
  return stale;
}

export function strategyNeedsAdjust(strategy, pool) {
  return stalePoolRefs(strategy, pool).length > 0;
}

/** Saved strategy references must stay in the pool (existing stale refs may be kept). */
export function validateStrategyRefs(draft, pool, existing) {
  const poolKeys = new Set(pool.map(routeKey));
  const existingKeys = new Set(((existing && existing.models) || []).map(routeKey));
  const missing = draft.models.filter((route) => !poolKeys.has(routeKey(route)) && !existingKeys.has(routeKey(route)));
  if (missing.length) fail(`引用的模型不在会话池：${missing.map((route) => `${route.provider}/${route.model}`).join('、')}`);
  return true;
}

export function assertStrategyNameFree(library, name, selfId) {
  if (library.strategies.some((strategy) => strategy.id !== selfId && strategy.name === name)) fail(`已有同名策略：${name}`);
  return true;
}

/**
 * Validate a strategy before it becomes the new-session default. It must only
 * reference the session pool, and - when the Host's live authorization is
 * readable - every referenced route must be exactly authorized, because a new
 * session can only be born inside that allow-list. Availability is transient
 * (it changes between sessions) and limits do not belong to this gate, so
 * neither is checked here; they are handled when the new session imports.
 */
export function validateDefaultRefs(strategy, pool, { authorized = null } = {}) {
  const stale = stalePoolRefs(strategy, pool);
  if (stale.length) fail(`策略引用的模型不在会话池（${stale.map((route) => `${route.provider}/${route.model}`).join('、')}）；请先调整策略`);
  if (Array.isArray(authorized)) {
    const keys = new Set(authorized.map(routeKey));
    const denied = (strategy.models || []).filter((route) => !keys.has(routeKey(route)));
    if (denied.length) fail(`新会话默认引用的模型未获当前宿主授权：${denied.map((route) => `${route.provider}/${route.model}`).join('、')}`);
  }
  return true;
}

/** Shared gate for enabling a strategy and for saving the enabled strategy. */
export function validateForUse(strategy, pool, limits, { authorized, available, ceiling, hostActive = null, hostActiveKnown = false, hostActiveReason }) {
  const stale = stalePoolRefs(strategy, pool);
  if (stale.length) fail(`策略引用的模型不在会话池（${stale.map((route) => `${route.provider}/${route.model}`).join('、')}）；请先调整策略`);
  const auth = new Set((authorized || []).map(routeKey));
  const avail = new Set((available || []).map(routeKey));
  for (const route of strategy.models) {
    const key = routeKey(route);
    if (!auth.has(key)) fail(`模型未获当前宿主授权：${route.provider}/${route.model}`);
    if (!avail.has(key)) fail(`模型当前不可用：${route.provider}/${route.model}`);
  }
  // No saved local limits means the session inherits the Host limits: enabling a
  // strategy must not require a save just to persist the Host default values.
  // A saved local limit still has to fit the live Host capacity, and an unknown
  // Host capacity still rejects new enable/save-of-enabled writes as before.
  if (limits) {
    if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 0 || limits.maxDepth > Math.min(32, ceiling)) {
      fail(`已保存的最大递归深度 ${limits?.maxDepth} 超出宿主上限 ${Math.min(32, ceiling)}；请先在模型池调整并保存`);
    }
    assertHostActive(limits.maxActive, { maxActive: hostActive, maxActiveKnown: hostActiveKnown, maxActiveReason: hostActiveReason });
  } else if (!hostActiveKnown) {
    fail(`无法确认宿主并发子智能体数量${hostActiveReason ? `（${hostActiveReason}）` : ''}；已拒绝保存/启用`);
  }
  // A legacy fixed strategy may keep several candidates; its target is not
  // required to be the first route, only to be present.
  if (strategy.type === 'fixed' && !strategy.models.some((route) => sameRoute(route, { provider: strategy.fixedProvider, model: strategy.fixedModel }))) fail('固定模型必须来自策略中选择的模型');
  return true;
}

/**
 * Validate a saved live-child limit against the real Host capacity.
 * Unknown capacity is never treated as 32 or as "no limit".
 */
export function assertHostActive(maxActive, { maxActive: hostActive = null, maxActiveKnown = false, maxActiveReason } = {}) {
  if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > PLUGIN_MAX_ACTIVE) fail(`并发子智能体数量必须是 1–${PLUGIN_MAX_ACTIVE} 的整数`);
  if (!maxActiveKnown) fail(`无法确认宿主并发子智能体数量${maxActiveReason ? `（${maxActiveReason}）` : ''}；已拒绝保存/启用`);
  const bound = Math.min(PLUGIN_MAX_ACTIVE, hostActive);
  if (maxActive > bound) fail(`并发子智能体数量 ${maxActive} 超出宿主上限 ${bound}；请先在模型池调整并保存`);
  return true;
}

export function limitsConflict(limits, { maxDepth, maxActive = null, activeKnown = Number.isSafeInteger(maxActive) } = {}) {
  if (!limits) return null;
  const depthCeiling = Number.isSafeInteger(maxDepth) ? Math.min(32, maxDepth) : 32;
  const activeCeiling = activeKnown && Number.isSafeInteger(maxActive) ? Math.min(PLUGIN_MAX_ACTIVE, maxActive) : null;
  const depthOver = limits.maxDepth > depthCeiling;
  const activeOver = activeCeiling !== null && limits.maxActive > activeCeiling;
  if (!depthOver && !activeOver) return null;
  return { depthOver, activeOver, maxDepth, maxActive, activeKnown };
}

export function defaultConflict(value, ceilings = {}) {
  if (!value) return null;
  const activeKnown = ceilings.maxActiveKnown === true
    || (ceilings.maxActiveKnown === undefined && Number.isSafeInteger(ceilings.maxActive));
  return limitsConflict(value.limits, { ...ceilings, activeKnown });
}

/** Capture a saved strategy as an independent new-session default. */
export function defaultFromStrategy(strategy, pool, limits, { now = Date.now(), sourceVersion = strategy.version } = {}) {
  if (strategy.type === 'inherit') fail('跟随类型不能设为新会话默认；请先保存为固定或 Agent 自选策略');
  const snapshot = snapshotForStrategy(strategy, pool, { now, limits });
  return {
    ...snapshot,
    sourceId: strategy.id,
    sourceName: strategy.name,
    sourceVersion,
    limits: limits ? clone(limits) : null,
  };
}

/**
 * Import the default into a brand-new root: independent copy, never auto-enabled.
 *
 * `authorized` is the Host's live allow-list for the session being created, or
 * `null` when it cannot be read. `null` keeps the historical import exactly as
 * recorded, because there is nothing to filter against. An array narrows the
 * import: a default captured earlier may name a model the Host has revoked
 * since, and a new session must never be born referencing it.
 *
 * A fixed strategy is all-or-nothing on its routing target: if that target is
 * not authorized, no strategy and no pool are imported (the saved limits are
 * still copied) and every dropped route is recorded. An auto strategy keeps its
 * authorized subset and closes the same way when nothing remains.
 */
export function importDefault(value, { now = Date.now(), id, defaultRevision = null, authorized = null } = {}) {
  if (!id) fail('导入默认缺少策略 id');
  if (value.type === 'inherit') fail('默认内容不能是跟随类型');
  const allModels = value.models.map(routeOf);
  const infos = Array.isArray(value.modelsInfo) ? value.modelsInfo : [];
  const keys = Array.isArray(authorized) ? new Set(authorized.map(routeKey)) : null;
  const permitted = (route) => keys === null || keys.has(routeKey(route));
  const names = new Map();
  for (const info of infos) {
    if (typeof info?.name === 'string' && info.name.trim()) names.set(routeKey(info), info.name.trim());
  }
  // Dropped routes in a stable order: models first, then modelsInfo-only routes.
  const dropped = [];
  const droppedKeys = new Set();
  for (const route of allModels) {
    const key = routeKey(route);
    if (permitted(route) || droppedKeys.has(key)) continue;
    droppedKeys.add(key);
    dropped.push(route);
  }
  for (const info of infos) {
    const key = routeKey(info);
    if (permitted(info) || droppedKeys.has(key)) continue;
    droppedKeys.add(key);
    dropped.push(routeOf(info));
  }
  const models = keys === null ? allModels : allModels.filter(permitted);
  const target = value.type === 'fixed' ? { provider: value.fixedProvider, model: value.fixedModel } : null;
  const targetLost = !!target && keys !== null && !models.some((route) => sameRoute(route, target));
  const closed = targetLost || (keys !== null && models.length === 0);
  // The default remains the recorded source even when nothing could be imported;
  // `skipped` is what tells a reader why the library starts empty.
  const initialized = { at: now, defaultRevision, source: 'default' };
  const reason = targetLost ? 'fixed-target-unauthorized' : 'unauthorized';
  const skipped = dropped
    .slice(0, MAX_SKIPPED)
    .map((route) => skippedRecord(route, names.get(routeKey(route)), reason));
  if (skipped.length) initialized.skipped = skipped;
  if (closed) {
    return {
      version: LIBRARY_VERSION,
      strategies: [],
      pool: [],
      limits: value.limits ? clone(value.limits) : null,
      active: null,
      initialized,
    };
  }
  const pool = infos.filter(permitted).map((info) => ({
    provider: info.provider,
    model: info.model,
    purpose: info.purpose || '',
    note: info.note || '',
  }));
  for (const route of models) {
    if (!pool.some((entry) => sameRoute(entry, route))) {
      pool.push({ provider: route.provider, model: route.model, purpose: '', note: '' });
    }
  }
  const strategy = {
    id,
    name: value.name,
    type: value.type,
    models,
    fixedProvider: value.fixedProvider || '',
    fixedModel: value.fixedModel || '',
    strategyText: value.strategyText || '',
    version: 1,
    // A default captured from a v1 legacy multi-candidate fixed strategy keeps
    // that explicit legacy form so it stays readable after materialization.
    ...(value.legacy === true ? { legacy: true } : {}),
  };
  return {
    version: LIBRARY_VERSION,
    strategies: [strategy],
    pool,
    limits: value.limits ? clone(value.limits) : null,
    active: null,
    initialized,
  };
}

/** Pool save validation: additions need live Host authorization/availability. */
export function validatePoolSave(nextPool, previousPool, activeSnapshot, { authorized, available }) {
  const prevKeys = new Set(previousPool.map(routeKey));
  const auth = new Set((authorized || []).map(routeKey));
  const avail = new Set((available || []).map(routeKey));
  for (const entry of nextPool) {
    const key = routeKey(entry);
    if (!prevKeys.has(key)) {
      if (!auth.has(key)) fail(`不能把未获宿主授权的模型加入会话池：${entry.provider}/${entry.model}`);
      if (!avail.has(key)) fail(`不能把当前不可用的模型加入会话池：${entry.provider}/${entry.model}`);
    }
  }
  if (activeSnapshot) {
    const nextKeys = new Set(nextPool.map(routeKey));
    const referenced = (activeSnapshot.models || []).filter((route) => !nextKeys.has(routeKey(route)));
    if (referenced.length) {
      fail(`无法保存：当前启用策略生效中的内容「${activeSnapshot.name}」仍引用 ${referenced.map((route) => `${route.provider}/${route.model}`).join('、')}；请先调整该策略或关闭策略`);
    }
  }
  return true;
}

/**
 * Plan a "refresh candidates" sync: pool entries that are no longer supported
 * at the moment the sync is initiated (not Host-authorized or currently
 * unavailable) are removed instead of lingering because they were used before,
 * and the same unsupported routes are pruned out of strategy references so the
 * candidate list really shrinks instead of staying pinned by stale strategy
 * models. A fixed strategy's routing target is kept even when unsupported.
 * The applied snapshot of the currently enabled strategy is protected: if it
 * references any route the sync would remove (from the pool or from a strategy
 * row), the whole sync fails. Returns { kept, removed, pruned } where pruned
 * is [{ id, name, models, dropped }] carrying each strategy's new models array.
 */
export function planPoolSync(pool, { authorized, available }, activeSnapshot, strategies = []) {
  const auth = new Set((authorized || []).map(routeKey));
  const avail = new Set((available || []).map(routeKey));
  const supported = (route) => auth.has(routeKey(route)) && avail.has(routeKey(route));
  const kept = [];
  const removed = [];
  for (const entry of pool) {
    if (supported(entry)) kept.push(entry);
    else removed.push(entry);
  }
  const pruned = [];
  const unsupported = new Set(removed.map(routeKey));
  for (const strategy of strategies) {
    const dropped = [];
    const nextModels = [];
    for (const route of strategy.models || []) {
      const isTarget = strategy.type === 'fixed' && route.provider === strategy.fixedProvider && route.model === strategy.fixedModel;
      if (!supported(route) && !isTarget) {
        dropped.push(route);
        unsupported.add(routeKey(route));
      } else {
        nextModels.push(route);
      }
    }
    if (dropped.length) pruned.push({ id: strategy.id, name: strategy.name, models: nextModels, dropped });
  }
  if (activeSnapshot && unsupported.size) {
    const referenced = (activeSnapshot.models || []).filter((route) => unsupported.has(routeKey(route)));
    if (referenced.length) {
      const names = [...new Set(referenced.map((route) => `${route.provider}/${route.model}`))];
      fail(`无法刷新：当前启用策略生效中的内容「${activeSnapshot.name}」仍引用 ${names.join('、')}；请先调整该策略或关闭策略后再刷新`);
    }
  }
  return { kept, removed, pruned };
}

export { requestObject };
