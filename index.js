import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defaults, validatePolicy, renderContext, selectRoute, checkAdmission, sameRoute, routeKey, fail, executionEvidence } from './policy.js';
import {
  readLibrary, readDefault, legacyLibrary, materializeLegacy, emptyLibrary, buildPolicy,
  snapshotForStrategy, sameSnapshotContent, sameStrategyContent, readStrategyDraft,
  readPoolEntries, validateStrategyRefs, assertStrategyNameFree, validateForUse,
  validatePoolSave, defaultFromStrategy, importDefault, strategyNeedsAdjust,
  validateDefaultRefs,
  limitsConflict, readRoutes, LEGACY_STRATEGY_ID, LEGACY_INHERIT_ID,
  assertHostActive, PLUGIN_MAX_ACTIVE, refreshSnapshotInfo,
} from './management.js';

export const name = 'lez-subagent-policy';
export const inject = ['agents','sessions','commands','tools','systemPrompt','subagents','subagentModelSelection','sessionProjections','storageDomain','llm'];
const blob = z.unknown();
const storedPolicy = z.object({
  revision: z.number().int().nonnegative(),
  policy: z.object({ enabled: z.boolean() }).passthrough(),
  library: z.unknown().optional(),
}).passthrough();
const storedGlobal = z.object({ revision: z.number().int().nonnegative(), default: z.unknown().nullable() });
const spec = {
  name: 'lez_subagent_policy',
  version: 1,
  layout: 'per-record',
  // Adding `global` and the optional `library` field does not change the stored
  // version: legacy records still parse and are read as v1 records.
  global: { schema: storedGlobal, initial: { revision: 0, default: null } },
  tables: { policies: { valueSchema: storedPolicy }, runs: { valueSchema: blob } },
};
const evidenceDefinition = {
  key:'lezSubagentEvidence',stateVersion:1,stateSchema:z.object({requested:blob.optional(),actual:blob.optional(),requestSeq:z.number().optional(),responseSeq:z.number().optional(),floor:z.number()}),
  init:(_header,inherited)=>({floor:inherited}),
  apply:(s,e)=>executionEvidence(s,e,s.floor),
};
const clone = v => structuredClone(v);
const render = (_args,value)=>[{type:'text',text:JSON.stringify(value,null,2)}];
const COVERAGE = [
  {entry:'delegate_with_policy',status:'managed-local',detail:'本插件工具：模型参数选择、深度、并发子智能体数量、路由预检；仅本地 spawn/fork。'},
  ...['subagent','subagent_fork','workflow','spawn_teammate'].map(entry=>({entry,status:'local-admission',detail:'仅本地 Agent 创建及出站路由校验；不改写原生参数。入口未能指定目标模型时会拒绝，请改用策略工具。继承父上下文的 fork 类后端（如只读旁问）在子代路由未变时按继承放行。'})),
  {entry:'external backends',status:'not-covered',detail:'外部执行及其他插件直接调用模型不在本地 Agent 准入范围。'},
];
const ACTIONS = new Set([
  'read','save','reset',
  'pool.save','pool.note','pool.sync','limits.save',
  'strategy.save','strategy.enable','strategy.delete','strategy.close',
  'strategy.default','default.clear',
]);

const packageJsonUrl = () => new URL('./package.json', import.meta.url);
// The panel shows the installed package version and its GitHub page. Both are
// read from this plugin's own package.json once, in apply(); a missing or
// unreadable file simply omits the fields instead of hardcoding a value.
function repositoryHttpsUrl(repository) {
  let url = typeof repository === 'string' ? repository.trim()
    : repository && typeof repository.url === 'string' ? repository.url.trim() : '';
  if (!url) return '';
  if (url.startsWith('git+')) url = url.slice(4);
  if (url.startsWith('ssh://git@github.com/')) url = 'https://github.com/' + url.slice('ssh://git@github.com/'.length);
  else if (url.startsWith('git@github.com:')) url = 'https://github.com/' + url.slice('git@github.com:'.length);
  else if (url.startsWith('git://github.com/')) url = 'https://github.com/' + url.slice('git://github.com/'.length);
  else if (url.startsWith('http://github.com/')) url = 'https://github.com/' + url.slice('http://github.com/'.length);
  url = url.replace(/\.git$/i, '').replace(/\/+$/, '');
  return /^https:\/\/github\.com\/[^/?#\s]+\/[^/?#\s]+$/.test(url) ? url : '';
}
export function readPackageMeta(readText = () => readFileSync(packageJsonUrl(), 'utf8')) {
  try {
    const parsed = JSON.parse(readText());
    const version = parsed && typeof parsed.version === 'string' ? parsed.version.trim() : '';
    const repository = repositoryHttpsUrl(parsed && parsed.repository);
    return { ...(version ? { version } : {}), ...(repository ? { repository } : {}) };
  } catch { return {}; }
}

export async function apply(ctx) {
  return applyWithPackageMeta(ctx, readPackageMeta());
}

export async function applyWithPackageMeta(ctx, packageMeta) {
  const domain = await ctx.storageDomain.open(spec);
  ctx.effect(()=>()=>domain.close());
  const policies = domain.table('policies'), runs = domain.table('runs');
  const leases = new Map(), residents = new Map(), pending = new Map();
  let closed = false, writes = Promise.resolve();
  ctx.effect(()=>()=>{closed=true; leases.clear(); residents.clear(); pending.clear();});
  ctx.sessionProjections.register(evidenceDefinition);
  const session = agent => ctx.sessions.get(agent.id);
  // The Host exposes its depth ceiling directly. Its live-child capacity is a
  // public, volatile settings value: `settings.describe()` projects the active
  // plugin instance's resolved Config, so `value.maxActiveSubagents` is the
  // effective limit. The service is optional and must never be a hard inject.
  const SETTINGS_NS = 'subagent';
  const hostDepth = () => Math.min(32, ctx.subagents.resolveMaxDepth() ?? 32);
  const unknownCapacity = reason => ({ maxActive: null, maxActiveKnown: false, maxActiveReason: reason });
  const reasonOf = error => String(error?.message ?? error);
  function readHostCapacity() {
    if (typeof ctx.get !== 'function') return unknownCapacity('当前上下文不支持可选服务读取');
    let settings;
    try { settings = ctx.get('settings'); }
    catch (error) { return unknownCapacity(`settings 服务读取失败：${reasonOf(error)}`); }
    if (!settings || typeof settings.describe !== 'function') return unknownCapacity('settings 服务未挂载');
    let descriptors;
    try { descriptors = settings.describe({ redactSecrets: true }); }
    catch (error) { return unknownCapacity(`settings.describe 调用失败：${reasonOf(error)}`); }
    if (!Array.isArray(descriptors)) return unknownCapacity('settings.describe 未返回描述数组');
    // Never guess across namespaces: another plugin may expose a same-named field.
    const matches = descriptors.filter(item => item && typeof item === 'object' && item.ns === SETTINGS_NS && item.applies === 'live');
    if (!matches.length) return unknownCapacity(`未找到 ns=${SETTINGS_NS} 且 applies=live 的配置描述`);
    if (matches.length > 1) return unknownCapacity(`ns=${SETTINGS_NS} 且 applies=live 的配置描述不唯一（${matches.length} 条）`);
    const active = matches[0].value?.maxActiveSubagents;
    if (!Number.isSafeInteger(active) || active < 1) return unknownCapacity('value.maxActiveSubagents 不是正安全整数');
    return {
      maxActive: active, maxActiveKnown: true, namespace: SETTINGS_NS,
      ...(Number.isSafeInteger(matches[0].revision) ? { revision: matches[0].revision } : {}),
    };
  }
  const hostCeilings = () => {
    const capacity = readHostCapacity();
    return {
      maxDepth: hostDepth(),
      maxActive: capacity.maxActive,
      maxActiveKnown: capacity.maxActiveKnown,
      ...(capacity.maxActiveKnown
        ? { namespace: capacity.namespace, ...(capacity.revision === undefined ? {} : { revision: capacity.revision }) }
        : { maxActiveReason: capacity.maxActiveReason }),
    };
  };
  const globalState = () => {
    const value = domain.global.get();
    return value && typeof value === 'object' ? value : { revision: 0, default: null };
  };
  function rootId(agent) {
    let s = session(agent), id = agent.id;
    const seen = new Set();
    while(s?.header.origin === 'subagent' && s.header.parentSession) {
      if(seen.has(id)) fail('会话谱系循环');
      seen.add(id);
      const audit = runs.get(id);
      if(audit?.rootId) return audit.rootId;
      id=s.header.parentSession; s=ctx.sessions.get(id);
    }
    return id;
  }
  function frozenSnapshot(s) {
    if(!s) return undefined;
    const value=ctx.sessionProjections.stateOf(s,'subagentModelSelectionPolicy');
    return Array.isArray(value) ? value : undefined;
  }
  // Only a top-level, non-seeded Session re-reads the host's live allow-list. Child,
  // fork and seed Sessions keep their own frozen authorization snapshot, so a later
  // host change never retroactively widens an inherited boundary.
  function liveRootSession(s) {
    const header=s?.header;
    return !!header && header.origin!=='subagent' && header.isSeeded!==true;
  }
  // The host freezes its global allow-list into each brand-new top-level session and
  // never refreshes that projection, while its own settings keep changing. For an
  // eligible top-level root the live list is the real upper bound, so it is used even
  // when a snapshot exists; the snapshot is kept only as the recorded count. Child,
  // fork and seed sessions still intersect their own snapshot.
  function authorization(agent, current=currentSelection()) {
    if(!current?.enabled) return {source:'none', routes:[], frozen:null};
    const own=session(agent), root=ctx.sessions.get(rootId(agent));
    const frozen=frozenSnapshot(own) ?? frozenSnapshot(root);
    const allowed=new Set(current.allowedModels.map(routeKey));
    if(frozen && liveRootSession(own)) return {source:'host', frozen:frozen.length, routes:current.allowedModels.map(r=>({...r})).slice(0,24)};
    if(frozen) return {source:'session', frozen:frozen.length, routes:frozen.filter(r=>allowed.has(routeKey(r))).slice(0,24)};
    if(liveRootSession(root)) return {source:'host', frozen:null, routes:current.allowedModels.map(r=>({...r})).slice(0,24)};
    return {source:'none', frozen:null, routes:[]};
  }
  function officialRoutes(agent, current) { return authorization(agent, current).routes; }
  // The live selection read must never break a read or a brand-new session: an
  // unavailable or malformed value simply means "no live allow-list here".
  function currentSelection() {
    try {
      const value=ctx.subagentModelSelection.current();
      return value && typeof value === 'object' ? value : null;
    } catch { return null; }
  }
  // `null` means the Host selection is disabled, so no authorization filter
  // applies; an enabled selection with no readable list authorizes nothing.
  function liveAuthorized(selection) {
    if(selection?.enabled!==true) return null;
    return Array.isArray(selection.allowedModels) ? selection.allowedModels : [];
  }
  function baseline(agent) {
    const h=session(agent)?.requestHeader()?.config;
    return h ? {provider:h.provider,model:h.model} : {provider:agent.options?.provider,model:agent.options?.model};
  }
  function emptyLegacyView(policy) {
    return {version:1, strategies:[], pool:[], limits:{maxDepth:policy.maxDepth,maxActive:policy.maxActive}, active:null, initialized:null};
  }
  function viewLibrary(record) {
    if(record.library) return record.library;
    if(record.absent) return {version:1, strategies:[], pool:[], limits:null, active:null, initialized:null};
    const p=record.policy;
    if(!p?.enabled && !(p.models||[]).length && p.mode==='inherit') return emptyLegacyView(p);
    return legacyLibrary(p);
  }
  // Single record for both the effective policy and the library: one put writes
  // both, so the active policy can never be saved while the library update fails.
  function recordView(id, agent) {
    const stored=policies.get(id);
    if(!stored) return {revision:0, policy:defaults(hostDepth(),officialRoutes(agent)), library:null, explicit:false, absent:true};
    if(stored.library!==undefined) {
      try {
        const library=readLibrary(stored.library);
        return {revision:stored.revision, policy:buildPolicy(library,hostDepth()), library, explicit:true};
      } catch(error) {
        return {revision:stored.revision, policy:stored.policy, library:null, explicit:false, issue:`已保存的策略库无法读取，暂按旧版策略展示：${String(error.message ?? error)}`};
      }
    }
    return {revision:stored.revision, policy:stored.policy, library:null, explicit:false};
  }
  // This is the policy for FUTURE delegations, not an existing child's own LLM binding.
  function recordFor(agent) { return recordView(rootId(agent), agent); }
  function activeMeta(record) {
    if(record.library?.active) {
      const snap=record.library.active.snapshot;
      return {strategyId:record.library.active.strategyId, strategyName:snap.name, strategyVersion:snap.version, strategyType:snap.type};
    }
    if(!record.library && record.policy?.enabled) {
      return {strategyId:'legacy', strategyName:record.policy.mode==='inherit'?'旧版跟随策略':'旧版会话策略', strategyVersion:record.revision, strategyType:record.policy.mode};
    }
    return {strategyId:'', strategyName:'', strategyVersion:record.revision, strategyType:''};
  }
  function preview(agent,record=recordFor(agent),auth=authorization(agent)) {
    return renderContext(record,{depth:session(agent)?.header.delegationDepth ?? 0,ceiling:hostDepth(),authorized:auth.routes,authorizationSource:auth.source});
  }
  ctx.systemPrompt.context({name:'lez:subagent-policy',order:850,interpolate:false,required:true,text:({agent})=>agent ? preview(agent):''});

  function readDefaultSafe(global) {
    if(!global?.default) return {value:null, issue:null};
    try { return {value:readDefault(global), issue:null}; }
    catch(error) { return {value:null, issue:`新会话默认内容无法读取：${String(error.message ?? error)}`}; }
  }
  // Thinking levels are Host metadata: never hardcode names or an implicit
  // fallback order. Missing or malformed metadata becomes an explicit empty set.
  function reasoningOf(info) {
    const raw=info?.reasoning, efforts=[];
    if(Array.isArray(raw?.efforts)) for(const item of raw.efforts.slice(0,24)) {
      const id=typeof item?.id==='string'?item.id.trim():'';
      if(!id || id.length>80) continue;
      const name=typeof item?.name==='string'&&item.name.trim()?item.name.trim().slice(0,80):id;
      if(efforts.some(row=>row.id===id)) continue;
      efforts.push({id,name});
    }
    const wanted=typeof raw?.defaultEffort==='string'?raw.defaultEffort.trim():'';
    return {efforts,defaultEffort:efforts.some(row=>row.id===wanted)?wanted:''};
  }
  const noReasoning=()=>({efforts:[],defaultEffort:''});
  // Resolve one route through the Host's own catalog. A failing or unregistered
  // resolve is reported as unavailable, never guessed; callers keep whichever
  // fallback name (model id, pool name or recorded default name) they hold.
  function routeResolver(signal) {
    const registered=new Set(ctx.llm.listProviders().map(p=>p.id));
    return async route=>{
      const row={provider:route.provider,model:route.model,name:route.model,description:'',authorized:false,available:false,reasoning:noReasoning()};
      try {
        if(!registered.has(route.provider)) throw new Error('unregistered');
        const info=await ctx.llm.resolveModelInfo(route.provider,route.model,signal);
        row.name=info?.name || route.model; row.description=info?.description ?? ''; row.available=true;
        row.reasoning=reasoningOf(info);
      } catch { row.available=false; }
      return row;
    };
  }
  // Resolve display names/availability for every route this session knows about.
  async function modelCatalog(agent, library, authz, signal) {
    const routes=new Map();
    const add=list=>{for(const route of list||[]) if(route?.provider && route?.model) routes.set(routeKey(route),{provider:route.provider,model:route.model});};
    add(authz.routes); add(library?.pool); add(library?.strategies?.flatMap(s=>s.models)); add(library?.active?.snapshot?.models);
    const allowed=new Set(authz.routes.map(routeKey));
    const resolve=routeResolver(signal);
    await Promise.all([...routes.values()].map(async route=>{
      const row=await resolve(route);
      row.authorized=allowed.has(routeKey(route));
      routes.set(routeKey(route),row);
    }));
    return routes;
  }
  // The saved new-session default is reported on its own, never merged into
  // `candidates`: `unauthorized` routes are outside the Host's live allow-list,
  // `unavailable` routes are authorized but cannot be resolved right now. The
  // recorded default name is the label, so a model that cannot be resolved still
  // reads as the model the user saved.
  async function defaultModelConflict(value, current, signal) {
    const allowed=new Set((Array.isArray(current.allowedModels)?current.allowedModels:[]).map(routeKey));
    const names=new Map((value.modelsInfo||[]).map(info=>[routeKey(info),typeof info.name==='string'?info.name.trim():'']));
    const resolve=routeResolver(signal);
    const rows=await Promise.all((value.models||[]).map(async route=>{
      const name=names.get(routeKey(route)) || route.model;
      const entry={provider:route.provider,model:route.model,name};
      if(!allowed.has(routeKey(route))) return {kind:'unauthorized',entry};
      const row=await resolve(route);
      return row.available ? null : {kind:'unavailable',entry};
    }));
    return {
      unauthorized:rows.filter(row=>row?.kind==='unauthorized').map(row=>row.entry),
      unavailable:rows.filter(row=>row?.kind==='unavailable').map(row=>row.entry),
    };
  }
  async function availabilityOf(routes, signal) {
    const available=new Set();
    const registered=new Set(ctx.llm.listProviders().map(p=>p.id));
    await Promise.all(routes.map(async route=>{
      if(!registered.has(route.provider)) return;
      try { await ctx.llm.resolveModelInfo(route.provider,route.model,signal); available.add({provider:route.provider,model:route.model}); } catch { /* unavailable */ }
    }));
    return available;
  }
  function buildSnapshotFor(library, strategy, catalog, now) {
    const pool=library.pool.map(entry=>{
      const row=catalog.get(routeKey(entry));
      return {...entry,name:row?.name || entry.model};
    });
    return snapshotForStrategy(strategy,pool,{now,limits:null});
  }

  // Read actual responses, never child self-identification. Projection skips fork seed.
  async function auditView(row) {
    const live=ctx.sessions.get(row.id);
    let evidence=live ? ctx.sessionProjections.stateOf(live,'lezSubagentEvidence'):undefined;
    if(!evidence) evidence=row.evidenceSnapshot;
    const result={...row};
    delete result.policy; delete result.evidenceSnapshot;
    if(evidence?.actual) {
      result.actualProvider=evidence.actual.provider; result.actualModel=evidence.actual.model;
      result.evidence='assistant/message';
    } else if(evidence?.requested) {
      result.actualProvider=''; result.actualModel=''; result.evidence='request/header (尚无响应)';
    } else { result.actualProvider='';result.actualModel='';result.evidence='pending'; }
    return result;
  }
  async function snapshot(agent) {
    const id=rootId(agent), record=recordFor(agent), current=currentSelection(), authz=authorization(agent,current);
    const library=viewLibrary(record);
    const catalog=await modelCatalog(agent,library,authz);
    const global=globalState();
    const def=readDefaultSafe(global);
    const ceilings=hostCeilings();
    const active=library.active ? {strategyId:library.active.strategyId,appliedAt:library.active.appliedAt,snapshot:clone(library.active.snapshot)} : null;
    const strategies=library.strategies.map(strategy=>{
      // F-50: two separate states instead of one merged badge. `needsAdjust`
      // still means references outside the saved pool; `pendingRecovery` means
      // references that stay in the pool but are not Host-authorized or cannot
      // be resolved right now — they are kept and return on their own.
      const pendingRefs=(strategy.models||[]).filter(route=>{
        if(!library.pool.some(entry=>sameRoute(entry,route))) return false;
        const row=catalog.get(routeKey(route));
        return !row?.authorized || !row?.available;
      });
      return {...clone(strategy),needsAdjust:strategyNeedsAdjust(strategy,library.pool),pendingRecovery:pendingRefs.length>0};
    });
    const pool=library.pool.map(entry=>{
      const row=catalog.get(routeKey(entry));
      return {...clone(entry), name:row?.name || entry.model, authorized:!!row?.authorized, available:!!row?.available,
        reasoning:row?.reasoning?clone(row.reasoning):noReasoning()};
    });
    const defaultSetting={
      revision:global.revision,
      snapshot:def.value ? clone(def.value) : null,
      conflict:def.value ? limitsConflict(def.value.limits,{...ceilings,activeKnown:ceilings.maxActiveKnown}) : null,
      // Only meaningful while the Host selection is enabled: with it disabled a
      // new session is born without an authorization subset, so nothing can be
      // out of bounds there. Kept as a stable object with two lists.
      modelConflict:def.value && current?.enabled===true ? await defaultModelConflict(def.value,current) : null,
      hostKnown:ceilings.maxActiveKnown,
    };
    const rows=[...runs.entries()].map(([,r])=>r).filter(r=>r.rootId===id).sort((a,b)=>b.createdAt-a.createdAt).slice(0,50);
    const diagnostics=[];
    if(authz.source==='host') diagnostics.push(authz.frozen===null
      ? '本会话没有官方固化快照；固定/自选按宿主当前已启用路由临时生效，原生 subagent 仍不带模型参数，请使用 delegate_with_policy。'
      : `候选按宿主当前已启用列表实时显示；会话固化快照 ${authz.frozen} 条仅存记录；池新增与委派仍按发起瞬间实时校验。`);
    else if(!authz.routes.length) diagnostics.push(current?.enabled
      ? '当前会话没有官方显式模型选择授权快照，且该会话不满足兜底条件（例如 fork/种子会话）；可使用跟随模式。'
      : '官方子智能体模型选择未启用；当前只能使用跟随模式。');
    if(record.issue) diagnostics.push(record.issue);
    if(def.issue) diagnostics.push(def.issue);
    const libraryConflict=limitsConflict(library.limits,{...ceilings,activeKnown:ceilings.maxActiveKnown});
    if(libraryConflict?.depthOver) diagnostics.push(`已保存的本会话限制超出宿主深度上限 ${ceilings.maxDepth}；新的启用/保存生效会被拒绝，已启用内容不会自动停用。`);
    if(libraryConflict?.activeOver) diagnostics.push(`已保存的本会话限制超出宿主并发子智能体数量 ${Math.min(PLUGIN_MAX_ACTIVE,ceilings.maxActive)}；新的启用/保存生效会被拒绝，已启用内容不会自动停用。`);
    if(!ceilings.maxActiveKnown) diagnostics.push(`无法确认宿主并发子智能体数量（${ceilings.maxActiveReason}）；新的限制保存与启用/保存生效会被拒绝，已启用内容继续运行。`);
    return {sessionId:agent.id,rootId:id,inherited:id!==agent.id,revision:record.revision,canEdit:id===agent.id,
      ...(packageMeta && packageMeta.version ? {version:packageMeta.version} : {}),
      ...(packageMeta && packageMeta.repository ? {repository:packageMeta.repository} : {}),
      policy:clone(record.policy), candidates:[...catalog.values()].map(row=>clone(row)),ceilings:{maxDepth:ceilings.maxDepth},
      host:ceilings, preview:preview(agent,record,authz),coverage:COVERAGE,
      authorization:{hostEnabled:current?.enabled===true,hostAllowed:current?.enabled===true ? current.allowedModels.length : 0,
        sessionFrozen:authz.frozen, source:authz.source},
      management:{explicit:!!record.explicit, strategies, pool, limits:library.limits?clone(library.limits):null,
        active:active?clone(active):null, initialized:library.initialized?clone(library.initialized):null},
      defaultSetting,
      runs:await Promise.all(rows.map(auditView)),diagnostics};
  }

  const enqueue=fn=>{const result=writes.then(fn);writes=result.catch(()=>{});return result;};
  function ensureRoot(agent) { if(rootId(agent)!==agent.id) fail('子会话仅继承根会话策略，不可扩大授权'); }
  function expectedRevision(request) {
    if(!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision<0) fail('expectedRevision 无效');
    return request.expectedRevision;
  }
  function rejectUnknown(request, allowed) {
    for(const key of Object.keys(request)) if(!allowed.includes(key)) fail(`请求存在未知字段：${key}`);
  }
  async function mutate(agent, request, operation, signal) {
    ensureRoot(agent);
    return enqueue(async()=>{
      if(closed) fail('插件已卸载');
      signal?.throwIfAborted();
      const stored=policies.get(agent.id);
      const revision=stored?.revision ?? 0;
      if(expectedRevision(request)!==revision) fail('版本冲突：策略已在其他位置更新，请刷新后重试');
      const record=recordView(agent.id,agent);
      if(record.issue) fail(record.issue);
      const library=record.explicit ? readLibrary(record.library) : record.absent ? emptyLibrary({now:Date.now()}) : materializeLegacy(record.policy);
      const outcome=await operation({record,revision,library,signal});
      signal?.throwIfAborted();
      if(closed) fail('插件已卸载');
      if(outcome === false) return snapshot(agent);
      const nextLibrary=outcome.library ?? library;
      const nextPolicy=outcome.policy ?? buildPolicy(nextLibrary,hostDepth());
      await policies.put(agent.id,{revision:revision+1,policy:nextPolicy,library:nextLibrary});
      return snapshot(agent);
    });
  }
  async function preflight(policy, signal) {
    if(policy.enabled && policy.mode!=='inherit') for(const route of policy.models) await ctx.llm.resolveModelInfo(route.provider,route.model,signal);
  }
  function hostAuth(agent) { return authorization(agent); }

  async function saveStrategy(agent, request, {signal}={}) {
    return mutate(agent, request, async ({library,signal:innerSignal})=>{
      const draft=readStrategyDraft(request.strategy);
      const existing=draft.id ? library.strategies.find(strategy=>strategy.id===draft.id) : null;
      if(draft.id && !existing) fail(`策略不存在：${draft.id}`);
      assertStrategyNameFree(library,draft.name,draft.id);
      validateStrategyRefs(draft,library.pool,existing);
      const changed=!existing || !sameStrategyContent(existing,draft);
      const isActive=!!(existing && library.active && library.active.strategyId===existing.id);
      // A saved strategy that is not the enabled one only updates the library:
      // existing stale references may still be kept, and no enable-level gate runs.
      if(!isActive) {
        if(!changed) return false;
        if(existing) {
          const next={...existing,name:draft.name,type:draft.type,models:draft.models,fixedProvider:draft.fixedProvider,fixedModel:draft.fixedModel,strategyText:draft.strategyText,version:existing.version+1};
          delete next.legacy;
          delete existing.legacy;
          Object.assign(existing,next);
        } else {
          if(library.strategies.length>=50) fail('策略数量已达上限');
          library.strategies.push({id:randomUUID(),name:draft.name,type:draft.type,models:draft.models,fixedProvider:draft.fixedProvider,fixedModel:draft.fixedModel,strategyText:draft.strategyText,version:1});
        }
        return {library};
      }
      // A re-save with identical content and an already aligned snapshot version
      // writes nothing, so it must not depend on live Host capacity or current
      // model availability: this no-op check comes before those live gates.
      if(!changed && library.active.snapshot.version===existing.version) return false;
      // Saving the enabled strategy takes effect on the next model call: validate
      // the exact next content, then rebuild the active snapshot in the same
      // single-record write. Any failure here leaves the stored active state intact.
      // Older data whose snapshot version lags still needs one alignment write, so
      // it keeps this live validation.
      const host=hostCeilings(), authz=hostAuth(agent);
      const available=await availabilityOf(draft.models,innerSignal);
      validateForUse(draft,library.pool,library.limits,{authorized:authz.routes,available:[...available],ceiling:host.maxDepth,hostActive:host.maxActive,hostActiveKnown:host.maxActiveKnown,hostActiveReason:host.maxActiveReason});
      let version=existing.version+(changed?1:0);
      if(changed && library.active.snapshot.version>=version) version=library.active.snapshot.version+1;
      const candidate=changed?{...draft,version}:{...existing,version};
      const catalog=await modelCatalog(agent,library,authz,innerSignal);
      const applied=buildSnapshotFor(library,candidate,catalog,Date.now());
      if(changed) {
        const next={...existing,name:draft.name,type:draft.type,models:draft.models,fixedProvider:draft.fixedProvider,fixedModel:draft.fixedModel,strategyText:draft.strategyText,version};
        delete next.legacy;
        delete existing.legacy;
        Object.assign(existing,next);
        // A converted legacy strategy no longer reads its old policy copy.
        if(library.legacyPolicy && (existing.id===LEGACY_STRATEGY_ID || existing.id===LEGACY_INHERIT_ID)) library.legacyPolicy=null;
      }
      library.active={strategyId:existing.id,appliedAt:Date.now(),snapshot:applied};
      return {library};
    }, signal);
  }
  async function enableStrategy(agent, request, signal) {
    return mutate(agent, request, async ({library,signal:innerSignal})=>{
      const strategy=library.strategies.find(row=>row.id===request.id);
      if(!strategy) fail(`策略不存在：${String(request.id)}`);
      const authz=hostAuth(agent);
      const available=await availabilityOf(strategy.models,innerSignal);
      const host=hostCeilings();
      validateForUse(strategy,library.pool,library.limits,{authorized:authz.routes,available:[...available],ceiling:host.maxDepth,hostActive:host.maxActive,hostActiveKnown:host.maxActiveKnown,hostActiveReason:host.maxActiveReason});
      const catalog=await modelCatalog(agent,library,authz,innerSignal);
      const applied=buildSnapshotFor(library,strategy,catalog,Date.now());
      if(library.active && library.active.strategyId===strategy.id && sameSnapshotContent(library.active.snapshot,applied)) return false;
      if(library.legacyPolicy && (strategy.id===LEGACY_STRATEGY_ID || strategy.id===LEGACY_INHERIT_ID)) {
        const legacyStrategy=legacyLibrary(library.legacyPolicy).strategies[0];
        if(!sameStrategyContent(legacyStrategy,strategy)) library.legacyPolicy=null;
      }
      library.active={strategyId:strategy.id,appliedAt:Date.now(),snapshot:applied};
      return {library};
    }, signal);
  }
  async function deleteStrategy(agent, request, signal) {
    return mutate(agent, request, async ({library})=>{
      const id=request.id;
      if(typeof id!=='string' || !id || id.length>120) fail('策略 id 无效');
      const strategy=library.strategies.find(row=>row.id===id);
      if(!strategy) fail(`策略不存在：${id}`);
      if(library.active?.strategyId===id) fail(`「${strategy.name}」是当前启用策略，请先关闭策略再删除`);
      const def=globalState().default;
      if(def && typeof def==='object' && def.sourceId===id) fail(`「${strategy.name}」是新会话默认的来源策略，请先更改或清除新会话默认再删除`);
      library.strategies=library.strategies.filter(row=>row.id!==id);
      if(id===LEGACY_STRATEGY_ID || id===LEGACY_INHERIT_ID) library.legacyPolicy=null;
      return {library};
    }, signal);
  }
  async function closeStrategy(agent, request, signal) {
    return mutate(agent, request, async ({library})=>{
      if(!library.active) fail('当前没有启用中的策略');
      library.active=null;
      return {library};
    }, signal);
  }
  async function savePool(agent, request, signal) {
    return mutate(agent, request, async ({library,signal:innerSignal})=>{
      const next=readPoolEntries(request.pool);
      const authz=hostAuth(agent);
      const available=await availabilityOf(next,innerSignal);
      validatePoolSave(next,library.pool,library.active?library.active.snapshot:null,{authorized:authz.routes,available:[...available]});
      library.pool=next;
      // Saved descriptions reach the next model call without changing the saved
      // strategy or its version; the referenced model set is protected above.
      if(library.active) library.active={...library.active,snapshot:refreshSnapshotInfo(library.active.snapshot,next)};
      return {library};
    }, signal);
  }
  async function savePoolNote(agent, request, signal) {
    return mutate(agent, request, async ({library})=>{
      const route={provider:request.provider,model:request.model};
      readRoutes([route],'模型');
      if(typeof request.purpose!=='string' || request.purpose.length>500) fail('简短用途无效或过长');
      if(typeof request.note!=='string' || request.note.length>500) fail('通用使用说明无效或过长');
      const entry=library.pool.find(item=>sameRoute(item,route));
      if(!entry) fail('该模型不在会话池，无法保存说明');
      entry.purpose=request.purpose.trim(); entry.note=request.note.trim();
      const snapshot=library.active?.snapshot;
      if(snapshot && (snapshot.models||[]).some(item=>sameRoute(item,route))) {
        library.active={...library.active,snapshot:refreshSnapshotInfo(snapshot,library.pool)};
      }
      return {library};
    }, signal);
  }
  // Refresh candidates (F-50): revalidation only. Nothing is removed here —
  // unsupported pool entries and strategy references keep their checked state,
  // the panel sinks them to the bottom of the list, and they return to their
  // position on their own once the Host authorizes/resolves them again. The
  // returned snapshot carries the fresh authorization/availability; removal is
  // a manual uncheck + pool save, so a sync never writes and never bumps the
  // revision (returning `false` from the operation reads without writing).
  async function savePoolSync(agent, request, signal) {
    return mutate(agent, request, async () => false, signal);
  }
  async function saveLimits(agent, request, signal) {
    return mutate(agent, request, async ({library})=>{
      const limits=request.limits;
      if(!limits || typeof limits!=='object' || Array.isArray(limits) || Object.keys(limits).some(key=>!['maxDepth','maxActive'].includes(key))) fail('限制参数无效');
      // Read the live Host value on every write; no cache, no fallback to 8/32.
      const host=hostCeilings();
      if(!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth<0 || limits.maxDepth>host.maxDepth) fail(`最大递归深度必须是 0–${host.maxDepth} 的整数`);
      assertHostActive(limits.maxActive,host);
      library.limits={maxDepth:limits.maxDepth,maxActive:limits.maxActive};
      return {library};
    }, signal);
  }
  async function setDefault(agent, request, signal) {
    ensureRoot(agent);
    return enqueue(async()=>{
      if(closed) fail('插件已卸载');
      signal?.throwIfAborted();
      const global=globalState();
      if(request.expectedDefaultRevision!==global.revision) fail('默认版本冲突：新会话默认已在其他位置更新，请刷新后重试');
      const stored=policies.get(agent.id);
      if(expectedRevision(request)!==(stored?.revision ?? 0)) fail('版本冲突：策略已在其他位置更新，请刷新后重试');
      if(typeof request.id!=='string' || !request.id) fail('策略 id 无效');
      const record=recordView(agent.id,agent);
      if(record.issue) fail(record.issue);
      const library=record.explicit ? readLibrary(record.library) : record.absent ? emptyLibrary({now:Date.now()}) : materializeLegacy(record.policy);
      const strategy=library.strategies.find(row=>row.id===request.id);
      if(!strategy) fail(`策略不存在：${request.id}`);
      if(strategy.type==='inherit') fail('跟随类型不能设为新会话默认；请先保存为固定或 Agent 自选策略');
      // A new session can only be born inside the Host's live allow-list, so a
      // default that names a revoked model would be born broken. Use this
      // session's effective authorization (live for a live root; snapshot ∩ live
      // for a seeded/forked root) instead of the raw host list, so setting a
      // global default never widens a narrower session boundary. A disabled Host
      // selection has no list to check against, so it keeps the old behaviour;
      // stale pool references always reject.
      const authz=hostAuth(agent);
      const selection=currentSelection();
      validateDefaultRefs(strategy,library.pool,{authorized:selection?.enabled===true ? authz.routes : null});
      const catalog=await modelCatalog(agent,library,authz,signal);
      const pool=library.pool.map(entry=>({...entry,name:catalog.get(routeKey(entry))?.name || entry.model}));
      const value=defaultFromStrategy(strategy,pool,library.limits,{now:Date.now()});
      signal?.throwIfAborted();
      if(closed) fail('插件已卸载');
      await domain.global.set({revision:global.revision+1,default:value});
      return snapshot(agent);
    });
  }
  async function clearDefault(agent, request, signal) {
    ensureRoot(agent);
    return enqueue(async()=>{
      if(closed) fail('插件已卸载');
      signal?.throwIfAborted();
      const global=globalState();
      if(request.expectedDefaultRevision!==global.revision) fail('默认版本冲突：新会话默认已在其他位置更新，请刷新后重试');
      await domain.global.set({revision:global.revision+1,default:null});
      return snapshot(agent);
    });
  }
  async function saveLegacy(agent, request, reset=false, signal) {
    ensureRoot(agent);
    return enqueue(async()=>{
      if(closed) fail('插件已卸载');
      signal?.throwIfAborted();
      const stored=policies.get(agent.id);
      const revision=stored?.revision ?? 0;
      if(expectedRevision(request)!==revision) fail('版本冲突：策略已在其他位置更新，请刷新后重试');
      if(!stored || stored.library===undefined) {
        const next=reset ? defaults(hostDepth(),officialRoutes(agent)) : validatePolicy(request.policy,hostDepth(),officialRoutes(agent));
        // The old v1 save entry must not write a live-child limit beyond the
        // real Host capacity either; reset is an explicit close, not a limit write.
        if(!reset) assertHostActive(next.maxActive,hostCeilings());
        await preflight(next,signal);
        signal?.throwIfAborted();
        await policies.put(agent.id,{revision:revision+1,policy:next});
        return snapshot(agent);
      }
      const library=readLibrary(stored.library);
      if(reset) {
        library.active=null;
        await policies.put(agent.id,{revision:revision+1,policy:buildPolicy(library,hostDepth()),library});
        return snapshot(agent);
      }
      const policy=validatePolicy(request.policy,hostDepth(),officialRoutes(agent));
      if(policy.mode==='inherit') {
        if(policy.enabled) fail('旧版跟随模式不能直接写入多策略库；请在界面中关闭或保存为固定/自选策略');
        // Old clients save a disabled inherit draft to mean "nothing enabled".
        // The limits it stores still obey the same live Host gate.
        assertHostActive(policy.maxActive,hostCeilings());
        library.active=null;
        library.limits={maxDepth:policy.maxDepth,maxActive:policy.maxActive};
        await policies.put(agent.id,{revision:revision+1,policy:buildPolicy(library,hostDepth()),library});
        return snapshot(agent);
      }
      await preflight(policy,signal);
      // Old save is another limit/enable write; it shares the same live Host
      // capacity gate as limits.save / strategy.enable / saving the enabled strategy.
      assertHostActive(policy.maxActive,hostCeilings());
      const auth=new Set(officialRoutes(agent).map(routeKey));
      const pool=new Map(library.pool.map(entry=>[routeKey(entry),entry]));
      const additions=[];
      for(const model of policy.models) {
        const key=routeKey(model);
        if(!pool.has(key)) {
          if(pool.size>=24) fail('模型池最多 24 个模型');
          if(!auth.has(key)) fail(`模型未获当前宿主授权：${model.provider}/${model.model}`);
          const entry={provider:model.provider,model:model.model,purpose:model.scenarios||'',note:model.limitations||''};
          pool.set(key,entry);
          additions.push(entry);
        }
      }
      // A disabled legacy save also cannot bypass the model-pool gate: additions
      // that pool.save would reject for unavailability must be rejected here too.
      if(!policy.enabled && additions.length) {
        const available=await availabilityOf(additions,signal);
        validatePoolSave([...pool.values()],library.pool,null,{authorized:officialRoutes(agent),available:[...available]});
      }
      library.pool=[...pool.values()];
      library.limits={maxDepth:policy.maxDepth,maxActive:policy.maxActive};
      if(!policy.enabled) library.active=null;
      else {
        library.legacyPolicy=null;
        // An old client can still submit a v1 fixed policy with several
        // candidates. Keep that exact legacy form (and its non-first target) so
        // the written library stays readable instead of failing the next read.
        const legacyForm=policy.mode==='fixed' && policy.models.length>1;
        const activeId=library.active?.strategyId;
        let strategy=activeId ? library.strategies.find(row=>row.id===activeId) : null;
        if(!strategy) {
          if(library.strategies.length>=50) fail('策略数量已达上限');
          strategy={id:randomUUID(),name:'会话策略',type:policy.mode,models:policy.models.map(model=>({provider:model.provider,model:model.model})),fixedProvider:policy.fixedProvider,fixedModel:policy.fixedModel,strategyText:policy.strategyText,version:1};
          if(legacyForm) strategy.legacy=true;
          library.strategies.push(strategy);
        } else {
          const next={...strategy,type:policy.mode,models:policy.models.map(model=>({provider:model.provider,model:model.model})),fixedProvider:policy.fixedProvider,fixedModel:policy.fixedModel,strategyText:policy.strategyText};
          if(!sameStrategyContent(strategy,next)) Object.assign(strategy,{...next,version:strategy.version+1}); else Object.assign(strategy,next);
          if(legacyForm) strategy.legacy=true; else delete strategy.legacy;
        }
        const catalog=await modelCatalog(agent,library,hostAuth(agent),signal);
        library.active={strategyId:strategy.id,appliedAt:Date.now(),snapshot:buildSnapshotFor(library,strategy,catalog,Date.now())};
      }
      signal?.throwIfAborted();
      await policies.put(agent.id,{revision:revision+1,policy:buildPolicy(library,hostDepth()),library});
      return snapshot(agent);
    });
  }

  // A brand-new, non-seed, non-fork root imports the default ONCE, closed.
  // Resumes, forks, seeded sessions and existing live sessions never import.
  async function initializeRoot({agent,source}) {
    if(source!=='startup') return;
    if(ctx.agents.currentInitiator()!==undefined) return;
    const s=session(agent); const header=s?.header;
    if(!s || header.origin==='subagent' || header.isSeeded===true || header.parentSession) return;
    return enqueue(async()=>{
      if(closed) return;
      if(policies.get(agent.id)) return;
      const global=globalState();
      const def=readDefaultSafe(global).value;
      const now=Date.now();
      // The saved default may be older than the Host's current allow-list. Only
      // an enabled selection carries a live subset to filter against; disabled
      // selection imports the default exactly as recorded.
      const library=def
        ? importDefault(def,{now,id:randomUUID(),defaultRevision:global.revision,authorized:liveAuthorized(currentSelection())})
        : emptyLibrary({now});
      await policies.put(agent.id,{revision:0,policy:buildPolicy(library,hostDepth()),library});
    });
  }

  ctx.commands.register({name:'subagent-policy',description:'查看或由用户配置当前会话的子智能体模型策略',recordInput:true,input:{hint:'JSON action: read / save / strategy.save / pool.save / limits.save …'},
    async handler(inv){
      try {
        if(inv.rawInput.length>40000) fail('请求过长');
        const request=inv.rawInput.trim()?JSON.parse(inv.rawInput):{action:'read'};
        if(!request || typeof request!=='object' || Array.isArray(request)) fail('请求必须是 JSON 对象');
        const action=request.action ?? 'read';
        if(typeof action!=='string' || !ACTIONS.has(action)) fail('未知 action');
        let value;
        if(action==='read') {
          rejectUnknown(request,['action']);
          value=await snapshot(inv.agent);
        } else {
          // No mutation Tool is exposed. A model-initiated in-process command is denied too.
          if(ctx.agents.currentInitiator()!==undefined) fail('策略编辑为用户操作，Agent 不可自行授权');
          inv.signal.throwIfAborted();
          if(action==='save'||action==='reset') {
            rejectUnknown(request,action==='save'?['action','expectedRevision','policy']:['action','expectedRevision']);
            value=await saveLegacy(inv.agent,request,action==='reset',inv.signal);
          } else if(action==='strategy.save') {
            rejectUnknown(request,['action','expectedRevision','strategy']);
            value=await saveStrategy(inv.agent,request,{signal:inv.signal});
          } else if(action==='strategy.enable') {
            rejectUnknown(request,['action','expectedRevision','id']);
            if(typeof request.id!=='string' || !request.id || request.id.length>120) fail('策略 id 无效');
            value=await enableStrategy(inv.agent,request,inv.signal);
          } else if(action==='strategy.delete') {
            rejectUnknown(request,['action','expectedRevision','id']);
            value=await deleteStrategy(inv.agent,request,inv.signal);
          } else if(action==='strategy.close') {
            rejectUnknown(request,['action','expectedRevision']);
            value=await closeStrategy(inv.agent,request,inv.signal);
          } else if(action==='pool.save') {
            rejectUnknown(request,['action','expectedRevision','pool']);
            value=await savePool(inv.agent,request,inv.signal);
          } else if(action==='pool.note') {
            rejectUnknown(request,['action','expectedRevision','provider','model','purpose','note']);
            value=await savePoolNote(inv.agent,request,inv.signal);
          } else if(action==='pool.sync') {
            rejectUnknown(request,['action','expectedRevision']);
            value=await savePoolSync(inv.agent,request,inv.signal);
          } else if(action==='limits.save') {
            rejectUnknown(request,['action','expectedRevision','limits']);
            value=await saveLimits(inv.agent,request,inv.signal);
          } else if(action==='strategy.default') {
            rejectUnknown(request,['action','expectedRevision','expectedDefaultRevision','id']);
            if(!Number.isSafeInteger(request.expectedDefaultRevision) || request.expectedDefaultRevision<0) fail('expectedDefaultRevision 无效');
            if(typeof request.id!=='string' || !request.id || request.id.length>120) fail('策略 id 无效');
            value=await setDefault(inv.agent,request,inv.signal);
          } else if(action==='default.clear') {
            rejectUnknown(request,['action','expectedDefaultRevision']);
            if(!Number.isSafeInteger(request.expectedDefaultRevision) || request.expectedDefaultRevision<0) fail('expectedDefaultRevision 无效');
            value=await clearDefault(inv.agent,request,inv.signal);
          }
        }
        return {kind:'success',text:JSON.stringify(value)};
      } catch(error){return {kind:'error',text:error instanceof SyntaxError?'策略请求不是合法 JSON':String(error.message ?? error)};}
    }});
  ctx.tools.register({name:'subagent_policy',description:'Read the current session subagent policy, exact authorized routes, model usage notes, injection preview and execution evidence. Does not change policy.',parameters:{type:'object',properties:{},additionalProperties:false},
    output:{schema:{type:'object',additionalProperties:true},render},execute:(_args,exec)=>snapshot(exec.agent)});

  function localChild(agent) {return session(agent)?.header.origin==='subagent';}
  function creationRoute(agent) {return {provider:agent.options?.provider,model:agent.options?.model};}
  // The Host writes one durable `subagent/descriptor` into the child's own log during
  // `agents.create` setup, before `agent/created` listeners run; the last descriptor is the
  // child's own even when a fork seed replays an ancestor's. Its provider is the only public
  // fact naming the creating backend, so inheritance is read from the Host's stated capability
  // instead of matching a plugin, package, label or product name (ADR-024).
  function creatingBackendInheritsParent(agent) {
    let events;
    try { events=session(agent)?.snapshotEvents?.(); } catch { return false; }
    if(!Array.isArray(events)) return false;
    let provider;
    for(const e of events) if(e?.type==='subagent/descriptor' && typeof e.data?.provider==='string') provider=e.data.provider;
    if(!provider) return false;
    try { return ctx.subagents.getProvider(provider)?.inheritsParentContext===true; } catch { return false; }
  }
  function count(id,except) {
    const counted=new Set([...leases].filter(([child,l])=>l.rootId===id && child!==except).map(([child])=>child));
    // Count acknowledged residents, NOT all registry entries: siblings may be entered
    // but still awaiting this very admission event.
    for(const a of residents.values()) if(a.id!==except && rootId(a)===id) counted.add(a.id);
    return counted.size;
  }
  async function attach({agent,source}) {
    const s=session(agent);
    if(!s || !localChild(agent)) return;
    const parent=ctx.agents.get(s.header.parentSession);
    const previous=runs.get(agent.id);
    const root=parent ? rootId(parent) : previous?.rootId;
    const pin=pending.get(agent.id);
    const rec=pin?.record ?? (source==='resume' && previous?.policy ? {revision:previous.version,policy:previous.policy} : parent ? recordFor(parent):undefined);
    if(!rec?.policy.enabled || !root) {residents.set(agent.id,agent);return;}
    const route=creationRoute(agent), base=previous ? {provider:previous.requestedProvider,model:previous.requestedModel} : parent?baseline(parent):route;
    // A fork-style child keeps the parent's route: nothing was selected, so the auto subset
    // (which constrains selection) does not apply. Fixed/inherit modes keep their own rules.
    const inheritedParent=creatingBackendInheritsParent(agent) && sameRoute(route, base);
    // The Host samples its own pool at each materialization; when its live value
    // is readable, this plugin's admission narrows to that value. Unknown is not
    // guessed here: the Host still enforces its own capacity.
    const host=hostCeilings();
    checkAdmission(rec.policy,route,base,s.header.delegationDepth ?? 1,count(root,agent.id),host.maxDepth,host.maxActiveKnown?host.maxActive:null,{inheritsParentContext:inheritedParent});
    if(rec.policy.mode!=='inherit') {
      const auth=new Set((parent?officialRoutes(parent):[]).map(routeKey));
      if(parent && !auth.has(routeKey(route))) fail('创建模型已不在当前官方授权范围');
    }
    // Reservation is synchronous before the first await, so sibling admissions cannot race.
    leases.set(agent.id,{agent,rootId:root,policy:clone(rec.policy),version:rec.revision,baseline:base,inheritParent:inheritedParent});
    residents.set(agent.id,agent);
    try {
      if(!previous) {
        const meta=activeMeta(rec);
        await runs.put(agent.id,{id:agent.id,rootId:root,parentId:s.header.parentSession,label:'本地子智能体',requestedProvider:route.provider ?? '',requestedModel:route.model ?? '',version:rec.revision,policy:clone(rec.policy),reason:inheritedParent?'原生 fork 继承父模型（未显式选型）':'原生入口；未记录显式选择依据',...(inheritedParent?{entry:'native-inherit'}:{}),status:'admitted',createdAt:Date.now(),...meta});
      }
    } catch(e){leases.delete(agent.id);residents.delete(agent.id);throw e;}
  }
  ctx.on('agent/created',async payload=>{
    try { await initializeRoot(payload); } catch(error) { ctx.logger.warn(`subagent-policy default initialization: ${String(error)}`); }
    await attach(payload);
  });
  // Existing agents are not retroactively rejected; resume uses its saved creation snapshot.
  for(const agent of ctx.agents.list()) {
    if(localChild(agent)) residents.set(agent.id,agent);
    const old=runs.get(agent.id);
    if(old?.policy) leases.set(agent.id,{agent,rootId:old.rootId,policy:old.policy,version:old.version,baseline:creationRoute(agent)});
  }
  ctx.on('agent/disposed',({agent})=>{
    if(residents.get(agent.id)===agent) residents.delete(agent.id);
    if(leases.get(agent.id)?.agent !== agent) return;
    leases.delete(agent.id);
    const row=runs.get(agent.id); const s=session(agent);
    if(row) {
      const ev=s?ctx.sessionProjections.stateOf(s,'lezSubagentEvidence'):undefined;
      void runs.update(agent.id,current=>({...current,status:'disposed',...(ev?{evidenceSnapshot:clone(ev)}:{})})).catch(e=>ctx.logger.warn(`subagent-policy audit persistence: ${String(e)}`));
    }
  });
  ctx.on('subagent/start',info=>{
    if(!info.local) return;
    const row=runs.get(info.id);
    if(row) void runs.update(info.id,current=>({...current,backend:info.provider,status:current.status==='disposed'?'disposed':'started'})).catch(e=>ctx.logger.warn(String(e)));
  });
  // Final outbound validation, not routing: no mutation of options or silent model replacement.
  ctx.on('llm/stream',function(options,next){
    if(options.purpose || !options.sessionId) return next();
    const lease=leases.get(options.sessionId);
    if(!lease) return next();
    const p=lease.policy, route={provider:options.provider,model:options.model};
    if(p.mode!=='inherit') {
      const allowed=currentSelection();
      if(!allowed || !allowed.enabled || !Array.isArray(allowed.allowedModels) || !allowed.allowedModels.some(r=>sameRoute(r,route))) fail('该子智能体模型已被宿主撤销授权');
    }
    if(p.mode==='inherit' && !sameRoute(route,lease.baseline)) fail('子智能体请求模型偏离创建时跟随模型');
    if(p.mode==='fixed' && !sameRoute(route,{provider:p.fixedProvider,model:p.fixedModel})) fail('子智能体请求模型偏离固定策略');
    if(p.mode==='auto' && lease.inheritParent && !sameRoute(route,lease.baseline)) fail('子智能体请求模型偏离继承的父模型');
    if(p.mode==='auto' && !lease.inheritParent && !p.models.some(r=>sameRoute(r,route))) fail('子智能体请求模型超出会话授权');
    return next();
  });

  ctx.tools.register({name:'delegate_with_policy',description:'Create one local subagent using this session policy; returns its id immediately and delivers completion through the native subagent runtime. Choose an authorized exact model for auto mode and provide a short selection reason. Does not change the main model or policy.',
    parameters:{type:'object',additionalProperties:false,required:['prompt','description','reason'],properties:{prompt:{type:'string',description:'Self-contained child task; fork inherits completed conversation turns.'},description:{type:'string',description:'Short task label.'},reason:{type:'string',description:'One short selection reason, not a chain of thought.'},context:{type:'string',enum:['fresh','fork'],description:'fresh (default) or fork.'},provider:{type:'string',description:'Exact LLM provider; supply together with model. Required in auto mode.'},model:{type:'string',description:'Exact authorized model; supply with provider.'},reasoning_effort:{type:'string',description:'Optional effort supported by the selected model; omitted uses its default.'}}},
    isConcurrencySafe:()=>true,output:{schema:{type:'object',additionalProperties:true},render},
    async execute(args,exec){
      const agent=exec.agent, rec=recordFor(agent), p=rec.policy;
      if(!p.enabled) fail('当前会话尚未启用策略，请由用户在配置栏启用');
      if(typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.length>100000) fail('任务提示词无效或过长');
      if(typeof args.description!=='string'||args.description.length>200||typeof args.reason!=='string'||!args.reason.trim()||args.reason.length>500) fail('任务标签或选择依据无效');
      if(args.context!==undefined && !['fresh','fork'].includes(args.context)) fail('context 无效');
      const route=selectRoute(p,baseline(agent),args);
      if(p.mode!=='inherit' && !officialRoutes(agent).some(r=>sameRoute(r,route))) fail('宿主授权已变更或当前会话未获得此模型授权');
      const backend=args.context==='fork'?'fork':'spawn', provider=ctx.subagents.getProvider(backend);
      if(!provider?.prepareContinuable || !provider.capabilities.agentOptions || !provider.capabilities.depthLimit) fail('此本地后端缺少所需能力');
      const selected=await ctx.llm.resolveCallConfig({...route,...args.reasoning_effort===undefined?{}:{reasoningEffort:args.reasoning_effort}},exec.signal);
      exec.signal.throwIfAborted();
      if(closed) fail('插件已卸载');
      if(recordFor(agent).revision!==rec.revision) fail('模型预检期间策略已更新，请重新读取后委派');
      // Pin once creation begins; a save while materialization awaits cannot relabel it.
      const childId=randomUUID();
      pending.set(childId,{record:clone(rec)});
      let started;
      // Dual-shape activation spec: 0.2.2-rc.1 hosts read only `spec.request.*`,
      // 0.2.2-rc.2 hosts read only the flat fields, and neither rejects the other
      // shape's extra key. Passing both keeps one call valid on either host.
      const startRequest={parent:agent,prompt:[{type:'text',text:args.prompt}],agentOptions:selected,maxDepth:Math.min(p.maxDepth,hostDepth())};
      try {
        started=await ctx.subagents.startActivation({childId,provider:backend,label:args.description,delivery:'parent',signal:exec.signal,...startRequest,request:startRequest});
      } finally {pending.delete(childId);}
      const row=runs.get(started.childId);
      if(row) await runs.update(started.childId,current=>({...current,label:args.description,reason:args.reason,entry:'delegate_with_policy'})).catch(e=>ctx.logger.warn(`child started; audit label save failed: ${String(e)}`));
      return {subagentId:started.childId,provider:route.provider,model:route.model,policyVersion:rec.revision};
    }});
}
