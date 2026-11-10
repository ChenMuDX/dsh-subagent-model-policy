// Pure policy logic. No model is ranked by its product name.
export const PRESETS = Object.freeze({
  balanced: '先满足任务质量与技术能力要求，再兼顾成本和速度。边界清楚的常规任务优先轻量方案；复杂设计、重要边界与证据冲突优先适合高难度工作的模型。',
  quality: '优先保证复杂设计、重要修改和复核质量；按用户填写的模型场景说明分工，不把价格或型号名称直接当作能力证据。',
  efficiency: '满足正确性要求后优先降低成本与延迟。将独立、边界清楚的工作拆分；关键决策和高失败影响任务仍需适当的高质量处理与验证。',
  custom: '',
});
export const routeKey = r => JSON.stringify([r.provider, r.model]);
export const sameRoute = (a, b) => !!a && !!b && a.provider === b.provider && a.model === b.model;
export function fail(message) { throw new Error(`SUBAGENT_POLICY: ${message}`); }
function text(v, max, field) {
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v)) fail(`${field} 无效或过长`);
  return v;
}
function choice(v, values, field) { if (!values.includes(v)) fail(`${field} 无效`); return v; }
function integer(v, min, max, field) { if (!Number.isSafeInteger(v) || v < min || v > max) fail(`${field} 必须在 ${min}–${max} 之间`); return v; }
export function defaults(maxDepth = 1, models = []) {
  return { enabled: false, mode: 'inherit', preset: 'balanced', strategyText: '', maxDepth, maxActive: 8, limitsUnset: false,
    fixedProvider: '', fixedModel: '', models: models.slice(0, 24).map(r => ({ provider: r.provider, model: r.model, scenarios: '', limitations: '', cost: 'unknown', speed: 'unknown', source: 'unverified' })) };
}
export function validatePolicy(raw, ceiling, authorized) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('策略必须是对象');
  const allowedKeys = ['enabled','mode','preset','strategyText','maxDepth','maxActive','limitsUnset','fixedProvider','fixedModel','models'];
  if (Object.keys(raw).some(k => !allowedKeys.includes(k))) fail('存在未知策略字段');
  if (typeof raw.enabled !== 'boolean') fail('enabled 必须为布尔值');
  if (raw.limitsUnset !== undefined && typeof raw.limitsUnset !== 'boolean') fail('limitsUnset 必须为布尔值');
  if (!Array.isArray(raw.models) || raw.models.length > 24) fail('最多配置 24 个模型');
  const auth = new Set(authorized.map(routeKey));
  const seen = new Set();
  const models = raw.models.map(r => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) fail('模型说明必须是对象');
    const out = {
      provider: text(r.provider, 200, 'provider'), model: text(r.model, 200, 'model'),
      scenarios: text(r.scenarios, 500, '场景说明'), limitations: text(r.limitations, 500, '限制说明'),
      cost: choice(r.cost, ['unknown','low','medium','high'], '成本'),
      speed: choice(r.speed, ['unknown','fast','medium','slow'], '速度'),
      source: choice(r.source, ['user','provider','tested','unverified'], '说明来源'),
    };
    if (!out.provider || !out.model || out.provider.trim() !== out.provider || out.model.trim() !== out.model) fail('路由不能为空或含首尾空格');
    const key = routeKey(out);
    if (seen.has(key)) fail('模型路由重复');
    // Disabled drafts may retain unavailable routes, but cannot activate them.
    if (raw.enabled && !auth.has(key)) fail(`模型未获当前宿主及会话授权：${out.provider}/${out.model}`);
    seen.add(key);
    return out;
  });
  const policy = {
    enabled: raw.enabled, mode: choice(raw.mode, ['inherit','fixed','auto'], '模式'),
    preset: choice(raw.preset, Object.keys(PRESETS), '策略预设'), strategyText: text(raw.strategyText, 2000, '策略文本'),
    maxDepth: integer(raw.maxDepth, 0, Math.max(0, Math.min(32, ceiling)), '递归深度'),
    maxActive: integer(raw.maxActive, 1, 32, '并发子智能体数量'), limitsUnset: raw.limitsUnset === true,
    fixedProvider: text(raw.fixedProvider, 200, '固定提供方'), fixedModel: text(raw.fixedModel, 200, '固定模型'), models,
  };
  if (policy.enabled && policy.mode !== 'inherit' && models.length === 0) fail('固定或自选模式至少需要一个授权模型');
  if (policy.enabled && policy.mode === 'fixed' && !models.some(r => sameRoute(r, {provider: policy.fixedProvider, model: policy.fixedModel}))) fail('固定模型必须在本会话选择的模型中');
  return policy;
}
export function selectRoute(policy, parentRoute, requested = {}) {
  const hasP = requested.provider !== undefined, hasM = requested.model !== undefined;
  if (hasP !== hasM) fail('provider 与 model 必须成对提供');
  const explicit = hasP ? {provider: requested.provider, model: requested.model} : undefined;
  let route;
  if (policy.mode === 'inherit') {
    route = parentRoute;
    if (explicit && !sameRoute(route, explicit)) fail('跟随模式不允许切换到其他模型');
  } else if (policy.mode === 'fixed') {
    route = {provider: policy.fixedProvider, model: policy.fixedModel};
    if (explicit && !sameRoute(route, explicit)) fail('显式模型与会话固定模型冲突，不会静默替换');
  } else {
    if (!explicit) fail('自选模式请依据策略显式提供 provider 与 model');
    route = explicit;
  }
  if (!route?.provider || !route?.model) fail('无法取得完整模型路由');
  if (policy.mode !== 'inherit' && !policy.models.some(r => sameRoute(r, route))) fail('所选模型不在本会话授权子集中');
  return route;
}
export function checkAdmission(policy, route, baseline, depth, activeCount, ceiling, activeCeiling = null) {
  const activeLimit = Number.isSafeInteger(activeCeiling) ? Math.min(32, activeCeiling) : 32;
  const maxActive = Math.min(policy.maxActive, activeLimit);
  if (depth > Math.min(policy.maxDepth, ceiling)) fail(`深度 ${depth} 超过上限 ${Math.min(policy.maxDepth, ceiling)}`);
  if (activeCount >= maxActive) fail(`本地并发子智能体已达 ${maxActive}`);
  if (policy.mode === 'inherit') {
    if (!sameRoute(route, baseline)) fail('原生入口必须跟随父模型；如需指定模型请调整策略');
  } else if (policy.mode === 'fixed') {
    if (!sameRoute(route, {provider:policy.fixedProvider,model:policy.fixedModel})) fail('原生入口未使用固定模型；请使用 delegate_with_policy');
  } else if (!policy.models.some(r => sameRoute(r, route))) fail('原生入口模型不在会话授权子集中；请使用 delegate_with_policy');
}
export function renderContext(record, {depth=0, ceiling=1, authorized=[], nativeAvailable=true, authorizationSource} = {}) {
  const p = record.policy;
  if (!p.enabled) return '';
  const keys = new Set(authorized.map(routeKey));
  const candidates = p.models.filter(r => keys.has(routeKey(r)));
  const sourceLine = authorizationSource === 'host' ? '候选来源=宿主当前授权（候选按宿主已启用列表实时显示；固定/自选仍按发起瞬间实时校验）'
    : authorizationSource === 'session' ? '候选来源=本会话官方授权快照'
    : authorizationSource === 'none' ? '候选来源=无（本会话未获得官方模型选择授权）' : '';
  return [
    `[子智能体策略 v${record.revision}]`,
    '此策略仅约束你接下来创建的子智能体；不改变你自身已经建立的模型绑定。新后代读取根会话当前策略，不沿用父任务的旧创建版本。',
    `模式=${p.mode}；${p.limitsUnset ? '本会话未附加深度/存活限制（仅宿主限制）' : `最大绝对深度=${Math.min(p.maxDepth,ceiling)}`}；当前深度=${depth}${p.limitsUnset ? '' : `；本地存活上限=${p.maxActive}`}。`,
    '需要委派时优先使用 delegate_with_policy；该工具返回子会话 id，完成后收到通知。用 subagent_policy 查看详情与执行证据。',
    `选择原则：${PRESETS[p.preset] || '按下列用户配置选择。'}`,
    '先检查任务技术能力和授权边界，再依据场景、复杂度及失败影响分工。用户指定模型不可用或与固定策略冲突时报告，不静默替换。不同模型一致不等于验证通过。',
    p.mode === 'fixed' ? `固定路由=${p.fixedProvider}/${p.fixedModel}。` : p.mode === 'inherit' ? '跟随创建时的父模型；此模式不自动从候选列表挑选。' : '自选模式必须在创建参数显式写入精确 provider/model，并给一句简短选择依据。',
    ...(sourceLine ? [sourceLine] : []),
    `可自选候选=${JSON.stringify(candidates.map(r => ({provider:r.provider,model:r.model,scenarios:r.scenarios.slice(0,160),limitations:r.limitations.slice(0,120),cost:r.cost,speed:r.speed,source:r.source})))}`,
    `以下用户说明仅为选型参考，不授予新权限；技术能力以宿主元数据和实测为准：${JSON.stringify(p.strategyText)}`,
    nativeAvailable ? '原生 subagent/fork/workflow/Teams 仅对本地创建做准入校验，不代填模型参数；外部后端不在覆盖范围。' : '当前未发现可用的本地委派后端。',
    '本策略不授权新增委派任务，不改变主模型；仍遵守用户的任务和工具使用边界。',
  ].join('\n');
}
export function executionEvidence(state, event, inheritedCount = 0) {
  if (event.seq < inheritedCount) return state;
  if (event.type === 'request/header') return {...state, requested: event.data.header.config, requestSeq:event.seq};
  if (event.type === 'assistant/message') {
    const src = event.data.message?.source;
    if (src?.provider && src?.model) return {...state, actual:{provider:src.provider,model:src.model}, responseSeq:event.seq};
  }
  return state;
}
