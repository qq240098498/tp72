const crypto = require('crypto');
const { load, save, MAX_TRANSLATION_LENGTH, MAX_NOTE_LENGTH, MAX_OPERATOR_LENGTH, UNNAMED } = require('./store');
const { ApiError, pickText } = require('./errors');
const { getLock, acquireLock, releaseLock } = require('./locks');

const MODULE_PATTERN = /^[a-z][a-z0-9-]{0,29}$/;
const KEY_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$/;
const MAX_KEY_LENGTH = 120;

function validateModule(value) {
  const module = pickText(value);
  if (!module) throw new ApiError(400, 'MODULE_REQUIRED', '请填写模块名', 'module');
  if (!MODULE_PATTERN.test(module)) {
    throw new ApiError(400, 'MODULE_INVALID', '模块名要小写字母起头，后面可以跟数字与短横线，最长 30 个字符', 'module');
  }
  return module;
}

function validateKey(value) {
  const key = pickText(value);
  if (!key) throw new ApiError(400, 'KEY_REQUIRED', '请填写文案键', 'key');
  if (key.length > MAX_KEY_LENGTH) {
    throw new ApiError(400, 'KEY_TOO_LONG', `文案键不能超过 ${MAX_KEY_LENGTH} 个字符`, 'key');
  }
  if (!KEY_PATTERN.test(key)) {
    throw new ApiError(400, 'KEY_INVALID', '文案键要写成 home.banner.title 这样的形式，由小写字母、数字、下划线与短横线组成，并用点号至少分成两段', 'key');
  }
  return key;
}

// 译文逐条校验：语言必须是登记过的，取值必须是文本，长度不能超过上限
function validateTranslations(raw, languages) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(400, 'TRANSLATIONS_INVALID', '译文需要按语言逐条填写', 'translations');
  }
  const known = new Map();
  languages.forEach((item) => known.set(item.code.toLowerCase(), item.code));

  const result = {};
  Object.keys(raw).forEach((code) => {
    const value = raw[code];
    const actual = known.get(String(code).toLowerCase());
    if (!actual) {
      throw new ApiError(400, 'LANGUAGE_UNKNOWN', `语言 ${code} 没有登记过，请先在语言区登记这种语言`, `translations.${code}`);
    }
    if (typeof value !== 'string') {
      throw new ApiError(400, 'TRANSLATION_INVALID', `${actual} 的译文需要是文本`, `translations.${actual}`);
    }
    if (value.length > MAX_TRANSLATION_LENGTH) {
      throw new ApiError(400, 'TRANSLATION_TOO_LONG', `${actual} 的译文不能超过 ${MAX_TRANSLATION_LENGTH} 个字符，当前 ${value.length} 个字符`, `translations.${actual}`);
    }
    // 留空表示这条还没翻译，原样保留一个空串，方便页面上看出是空的还是根本没这一项
    result[actual] = value;
  });
  return result;
}

function validateNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new ApiError(400, 'NOTE_INVALID', '备注需要是文本', 'note');
  }
  if (value.length > MAX_NOTE_LENGTH) {
    throw new ApiError(400, 'NOTE_TOO_LONG', `备注不能超过 ${MAX_NOTE_LENGTH} 个字符`, 'note');
  }
  return value.trim();
}

// 操作者：页面顶栏填的名字，留空按未署名记录，只做长度检查
function validateOperator(value, fallback) {
  if (value === undefined || value === null) return fallback || UNNAMED;
  if (typeof value !== 'string') {
    throw new ApiError(400, 'OPERATOR_INVALID', '操作者需要是文本', 'operator');
  }
  const name = value.trim();
  if (!name) return UNNAMED;
  if (name.length > MAX_OPERATOR_LENGTH) {
    throw new ApiError(400, 'OPERATOR_TOO_LONG', `操作者名字不能超过 ${MAX_OPERATOR_LENGTH} 个字符`, 'operator');
  }
  return name;
}

// 同一个模块下不允许出现重复的键，比较时忽略大小写
function assertKeyFree(data, module, key, selfId) {
  const hit = data.entries.find((item) => item.module === module
    && item.id !== selfId
    && item.key.toLowerCase() === key.toLowerCase());
  if (hit) {
    throw new ApiError(409, 'KEY_DUPLICATED', `模块 ${module} 下已经有 ${hit.key} 这条文案了`, 'key');
  }
}

function sortEntries(list) {
  return list.slice().sort((a, b) => {
    if (a.module !== b.module) return a.module < b.module ? -1 : 1;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

// 按模块与关键词筛选：关键词同时匹配文案键与任意一种语言的译文
function listEntries(options) {
  const input = options && typeof options === 'object' ? options : {};
  const module = pickText(input.module);
  const keyword = pickText(input.keyword).toLowerCase();
  const data = load();

  let list = data.entries;
  if (module) list = list.filter((item) => item.module === module);
  if (keyword) {
    list = list.filter((item) => {
      if (item.key.toLowerCase().includes(keyword)) return true;
      return Object.keys(item.translations).some((code) => item.translations[code].toLowerCase().includes(keyword));
    });
  }

  const counts = {};
  data.entries.forEach((item) => {
    counts[item.module] = (counts[item.module] || 0) + 1;
  });
  const modules = Object.keys(counts).sort().map((name) => ({ module: name, count: counts[name] }));

  // 每条文案带上当前占用信息，列表里直接标出谁在编辑
  const entries = sortEntries(list).map((item) => ({ ...item, lock: getLock(item.id) }));
  return { entries, modules };
}

function getEntry(id) {
  const data = load();
  const found = data.entries.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'ENTRY_NOT_FOUND', '这条文案不存在或已被删除', '');
  return { ...found, lock: getLock(found.id) };
}

// 打开编辑表单时的入口：登记占用并返回文案当前内容。
// 已被别人占用时不抢锁，acquired 为 false，页面据此进入只读模式
function openEntry(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const found = data.entries.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'ENTRY_NOT_FOUND', '这条文案不存在或已被删除', '');
  const operator = validateOperator(input.operator, UNNAMED);
  // 持有人标识由页面生成并记在浏览器里，同名操作者也能区分开
  const owner = pickText(input.clientId) || operator;
  const result = acquireLock(found.id, owner, operator);
  return { acquired: result.acquired, lock: result.lock, entry: { ...found, lock: result.lock } };
}

// 关闭表单时释放占用，持有人标识对不上时不替别人释放
function releaseEntryLock(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const released = releaseLock(id, pickText(input.clientId));
  return { released };
}

// 逐项对比打开表单时的快照与当前内容，列出每一处从什么变成了什么；
// 译文按两种内容里出现过的语言逐项对比，缺失的一端用 null 表示未登记
function diffEntries(base, current) {
  const source = base && typeof base === 'object' ? base : {};
  const diff = [];
  const push = (field, label, from, to) => {
    const a = from === undefined || from === null ? null : from;
    const b = to === undefined || to === null ? null : to;
    if (a !== b) diff.push({ field, label, from: a, to: b });
  };
  push('module', '模块', pickText(source.module), current.module);
  push('key', '文案键', pickText(source.key), current.key);
  push('note', '备注', typeof source.note === 'string' ? source.note : null, current.note);
  const baseTranslations = source.translations && typeof source.translations === 'object' ? source.translations : {};
  const codes = new Set(Object.keys(baseTranslations).concat(Object.keys(current.translations)));
  Array.from(codes).sort().forEach((code) => {
    push(`translations.${code}`, `译文 ${code}`,
      typeof baseTranslations[code] === 'string' ? baseTranslations[code] : null,
      typeof current.translations[code] === 'string' ? current.translations[code] : null);
  });
  return diff;
}

function createEntry(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const module = validateModule(input.module);
  const key = validateKey(input.key);
  const translations = validateTranslations(input.translations, data.languages);
  const note = validateNote(input.note);
  const operator = validateOperator(input.operator, UNNAMED);
  assertKeyFree(data, module, key, '');

  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    module,
    key,
    translations,
    note,
    updatedBy: operator,
    createdAt: now,
    updatedAt: now,
  };
  data.entries.push(created);
  save(data);
  return created;
}

function updateEntry(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const found = data.entries.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'ENTRY_NOT_FOUND', '这条文案不存在或已被删除', '');

  // 冲突检测：页面打开表单时记下当时的文案快照，保存时随请求带回来；
  // 快照上的更新时间与当前不一致，说明占用期间这条文案被别人改过，
  // 当场拒绝并把逐项差异与当前内容一起返回，由页面给出放弃或强制覆盖的选择
  const base = input.base && typeof input.base === 'object' ? input.base : null;
  if (base && typeof base.updatedAt === 'string' && base.updatedAt && base.updatedAt !== found.updatedAt) {
    throw new ApiError(409, 'ENTRY_CONFLICT', '这条文案在你编辑期间被别人改过，保存被拒绝，请确认差异后选择放弃本地改动或强制覆盖', '', {
      diff: diffEntries(base, found),
      current: found,
    });
  }

  const module = input.module === undefined ? found.module : validateModule(input.module);
  const key = input.key === undefined ? found.key : validateKey(input.key);
  const translations = input.translations === undefined
    ? found.translations
    : validateTranslations(input.translations, data.languages);
  const note = input.note === undefined ? found.note : validateNote(input.note);
  const operator = validateOperator(input.operator, found.updatedBy);
  assertKeyFree(data, module, key, found.id);

  found.module = module;
  found.key = key;
  found.translations = translations;
  found.note = note;
  found.updatedBy = operator;
  found.updatedAt = new Date().toISOString();
  // 强制覆盖在文案上留痕：谁、在什么时间压掉了别人的改动，事后可查
  if (input.force === true) {
    const record = { by: operator, at: found.updatedAt };
    found.forceOverrides = Array.isArray(found.forceOverrides) ? found.forceOverrides.concat(record) : [record];
  }
  save(data);
  return found;
}

function deleteEntry(id) {
  const data = load();
  const index = data.entries.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'ENTRY_NOT_FOUND', '这条文案不存在或已被删除', '');
  const [removed] = data.entries.splice(index, 1);
  releaseLock(id);
  save(data);
  return { id: removed.id, key: removed.key };
}

module.exports = {
  listEntries,
  getEntry,
  openEntry,
  releaseEntryLock,
  createEntry,
  updateEntry,
  deleteEntry,
  diffEntries,
  validateModule,
  validateKey,
  validateTranslations,
  validateOperator,
};
