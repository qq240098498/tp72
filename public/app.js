// 页面交互：语言清单与文案清单都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上。
// 编辑文案前先向服务端登记占用：自己占着时别人只能看；保存时带上打开表单那一刻的快照，
// 服务端发现占用期间文案被别人改过会拒绝并返回逐项差异，页面给出放弃或强制覆盖两个选择。

const state = {
  languages: [],
  entries: [],
  modules: [],
  editingId: '',
  editingBase: null, // 打开表单那一刻的文案快照，保存时带回服务端做冲突检查
  lockHeld: false, // 当前表单是否占着这条文案
  lockTimer: null, // 占用续期定时器
  conflict: null, // 保存被拒时服务端返回的逐项差异与最新内容
};

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明、出错位置与补充信息一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    failure.details = error.details;
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

// 把出错位置标到具体输入项上：语言区与文案区共用一套标记
function markField(field) {
  if (!field) return;
  const target = document.querySelector(`[data-field="${field}"]`);
  if (!target) return;
  target.classList.add('invalid');
  const input = target.tagName === 'INPUT' || target.tagName === 'SELECT' ? target : target.querySelector('input, select');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 操作者名字记在浏览器里，刷新之后还在，保存时随请求一起带上
const OPERATOR_KEY = 'i18n-workbench-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  const saved = window.localStorage.getItem(OPERATOR_KEY) || '';
  el('operator').value = saved;
}

// 占用持有人标识：每个浏览器一份，同名操作者也能区分开谁占着锁
const CLIENT_KEY = 'i18n-workbench-client';

function clientId() {
  let id = window.localStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : `client-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    window.localStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

async function loadLanguages() {
  const payload = await request('/api/languages');
  state.languages = payload.languages || [];
  renderLanguages();
  renderTranslationInputs();
}

async function loadEntries() {
  const params = new URLSearchParams();
  const module = el('filter-module').value;
  const keyword = el('filter-keyword').value.trim();
  if (module) params.set('module', module);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/entries${query ? `?${query}` : ''}`);
  state.entries = payload.entries || [];
  state.modules = payload.modules || [];
  renderModules();
  renderEntries();
}

function renderModules() {
  const select = el('filter-module');
  const current = select.value;
  const rows = ['<option value="">全部模块</option>']
    .concat(state.modules.map((item) => `<option value="${escapeHtml(item.module)}">${escapeHtml(item.module)}（${item.count}）</option>`));
  select.innerHTML = rows.join('');
  if (state.modules.some((item) => item.module === current)) select.value = current;
}

function renderLanguages() {
  const body = el('language-body');
  const rows = state.languages.map((item) => {
    const defaultTag = item.isDefault ? '<span class="tag on">默认</span>' : '';
    const enabledTag = item.enabled ? '<span class="tag on">已启用</span>' : '<span class="tag off">已停用</span>';
    const actions = [
      `<button type="button" class="link" data-language-default="${escapeHtml(item.code)}"${item.isDefault ? ' disabled' : ''}>设为默认</button>`,
      `<button type="button" class="link" data-language-toggle="${escapeHtml(item.code)}">${item.enabled ? '停用' : '启用'}</button>`,
      `<button type="button" class="link" data-language-rename="${escapeHtml(item.code)}">改名</button>`,
      `<button type="button" class="link danger" data-language-delete="${escapeHtml(item.code)}">删除</button>`,
    ];
    return `<tr${item.enabled ? '' : ' class="muted"'}>
      <td class="mono">${escapeHtml(item.code)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td>${defaultTag}</td>
      <td>${enabledTag}</td>
      <td>${item.filled} 条</td>
      <td class="actions">${actions.join('')}</td>
    </tr>`;
  });
  body.innerHTML = rows.join('');
  el('language-empty').classList.toggle('hidden', state.languages.length > 0);
}

// 新建文案的表单按当前登记的语言逐条生成译文输入框，停用的语言照样可以查看与补填
function renderTranslationInputs(values) {
  const box = el('entry-translations');
  const current = values || collectTranslations();
  box.innerHTML = state.languages.map((item) => {
    const value = current[item.code] === undefined ? '' : current[item.code];
    const suffix = item.enabled ? '' : '<span class="tag off">已停用</span>';
    return `<label class="translation" data-field="translations.${escapeHtml(item.code)}">
      <span>${escapeHtml(item.code)} ${suffix}</span>
      <input class="translation-input" data-code="${escapeHtml(item.code)}" maxlength="200" value="${escapeHtml(value)}">
    </label>`;
  }).join('');
}

function collectTranslations() {
  const result = {};
  document.querySelectorAll('.translation-input').forEach((input) => {
    result[input.dataset.code] = input.value;
  });
  return result;
}

// 强制覆盖留痕的说明文字：最近一次是谁、什么时候压掉的，一共几次
function overrideTitle(overrides) {
  const last = overrides[overrides.length - 1];
  const times = overrides.length > 1 ? `（共 ${overrides.length} 次）` : '';
  return `最近一次由 ${last.by} 于 ${formatTime(last.at)} 强制覆盖${times}`;
}

function renderEntries() {
  const head = el('entry-head-row');
  head.innerHTML = ['模块', '文案键']
    .concat(state.languages.map((item) => item.code))
    .concat(['备注', '最近改动人', '更新时间', '操作'])
    .map((text) => `<th>${escapeHtml(text)}</th>`)
    .join('');

  const body = el('entry-body');
  body.innerHTML = state.entries.map((item) => {
    const cells = state.languages.map((language) => {
      const value = item.translations[language.code];
      if (value === undefined) return '<td class="missing">未登记</td>';
      if (!value.trim()) return '<td class="missing">待翻译</td>';
      return `<td title="${escapeHtml(value)}">${escapeHtml(value)}</td>`;
    });
    const lockTag = item.lock
      ? ` <span class="tag busy" title="从 ${escapeHtml(formatTime(item.lock.since))} 开始编辑">${escapeHtml(item.lock.operator)} 编辑中</span>`
      : '';
    const overrideTag = (item.forceOverrides && item.forceOverrides.length)
      ? ` <span class="tag override" title="${escapeHtml(overrideTitle(item.forceOverrides))}">曾被强制覆盖</span>`
      : '';
    return `<tr>
      <td class="mono">${escapeHtml(item.module)}</td>
      <td class="mono">${escapeHtml(item.key)}${lockTag}${overrideTag}</td>
      ${cells.join('')}
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td>${escapeHtml(item.updatedBy)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-entry-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-entry-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
  el('entry-empty').classList.toggle('hidden', state.entries.length > 0);
}

// 占用横幅：自己占着时提示别人只能看；别人占着时说清是谁、从什么时候开始，只能看不能存
function renderLockBanner(lockInfo) {
  const banner = el('entry-lock-banner');
  if (!lockInfo || !state.editingId) {
    banner.className = 'lock-banner hidden';
    banner.textContent = '';
    return;
  }
  if (lockInfo.acquired) {
    banner.textContent = `你从 ${formatTime(lockInfo.lock.since)} 开始占用这条文案，别人打开时只能查看`;
    banner.className = 'lock-banner info';
  } else {
    banner.textContent = `这条文案正由 ${lockInfo.lock.operator} 编辑（从 ${formatTime(lockInfo.lock.since)} 开始），你只能查看，不能保存`;
    banner.className = 'lock-banner warn';
  }
}

// 这条文案被强制覆盖过时，在表单里也留一条看得见的痕迹
function renderOverrideHint(entry) {
  const hint = el('entry-override-hint');
  if (entry && entry.forceOverrides && entry.forceOverrides.length) {
    hint.textContent = `注意：${overrideTitle(entry.forceOverrides)}，本次覆盖记录已留在文案上`;
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
    hint.textContent = '';
  }
}

// 只读模式：所有输入与保存按钮都禁用，只能看不能存
function setFormReadonly(readonly) {
  document.querySelectorAll('#entry-form input').forEach((input) => {
    input.disabled = readonly;
  });
  el('entry-save').disabled = readonly;
}

function fillEntryForm(entry) {
  el('entry-module').value = entry ? entry.module : '';
  el('entry-key').value = entry ? entry.key : '';
  el('entry-note').value = entry ? entry.note : '';
  renderTranslationInputs(entry ? entry.translations : {});
}

function hideConflict() {
  state.conflict = null;
  el('entry-conflict').classList.add('hidden');
  el('conflict-body').innerHTML = '';
}

function openEntryForm(entry, lockInfo) {
  state.editingId = entry ? entry.id : '';
  state.editingBase = entry ? JSON.parse(JSON.stringify(entry)) : null;
  state.lockHeld = !!(lockInfo && lockInfo.acquired);
  hideConflict();
  el('entry-form-title').textContent = entry ? `编辑文案：${entry.key}` : '新建文案';
  fillEntryForm(entry);
  renderLockBanner(lockInfo);
  renderOverrideHint(entry);
  setFormReadonly(!!entry && !state.lockHeld);
  el('entry-form').classList.remove('hidden');
  if (state.lockHeld) startLockHeartbeat();
  el('entry-module').focus();
}

// 释放当前表单占着的锁，释放失败不打扰页面操作
function releaseCurrentLock() {
  if (!state.editingId || !state.lockHeld) return;
  const id = state.editingId;
  state.lockHeld = false;
  stopLockHeartbeat();
  request(`/api/entries/${encodeURIComponent(id)}/lock`, {
    method: 'DELETE',
    body: JSON.stringify({ clientId: clientId() }),
  }).catch(() => {});
}

function closeEntryForm() {
  releaseCurrentLock();
  state.editingId = '';
  state.editingBase = null;
  hideConflict();
  el('entry-form').classList.add('hidden');
  clearFieldMarks();
}

// 占用期间定时续期，避免长时间编辑被当成僵尸占用；
// 续期时发现锁已经不在自己手里（比如断网太久被别人占去），表单当场转成只读
function startLockHeartbeat() {
  stopLockHeartbeat();
  state.lockTimer = window.setInterval(async () => {
    if (!state.editingId || !state.lockHeld) return;
    try {
      const payload = await request(`/api/entries/${encodeURIComponent(state.editingId)}/lock`, {
        method: 'POST',
        body: JSON.stringify({ operator: currentOperator(), clientId: clientId() }),
      });
      if (!payload.acquired) {
        state.lockHeld = false;
        stopLockHeartbeat();
        setFormReadonly(true);
        renderLockBanner(payload);
        notify(`这条文案的占用已转到 ${payload.lock.operator} 手中，当前只能查看`, 'error');
      }
    } catch (err) {
      // 网络抖动时这次续期失败就算了，下一次心跳再试
    }
  }, 2 * 60 * 1000);
}

function stopLockHeartbeat() {
  if (state.lockTimer) {
    window.clearInterval(state.lockTimer);
    state.lockTimer = null;
  }
}

// 差异面板里空值的展示：没有这一项与留空是两回事
function displayDiffValue(value) {
  if (value === null || value === undefined) return '（未登记）';
  if (value === '') return '（空）';
  return value;
}

// 保存被拒：逐项列出别人把哪一处从什么改成了什么，并给出放弃或强制覆盖两个选择
function showConflict(details) {
  state.conflict = details;
  el('conflict-body').innerHTML = (details.diff || []).map((item) => `<tr>
    <td>${escapeHtml(item.label)}</td>
    <td class="diff-from">${escapeHtml(displayDiffValue(item.from))}</td>
    <td class="diff-to">${escapeHtml(displayDiffValue(item.to))}</td>
  </tr>`).join('');
  el('entry-conflict').classList.remove('hidden');
  el('entry-conflict').scrollIntoView({ block: 'nearest' });
}

async function submitLanguage(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    code: el('language-code').value,
    name: el('language-name').value,
    enabled: el('language-enabled').checked,
    isDefault: el('language-default').checked,
  };
  try {
    await request('/api/languages', { method: 'POST', body: JSON.stringify(payload) });
    el('language-code').value = '';
    el('language-name').value = '';
    el('language-default').checked = false;
    notify('语言已新增', 'ok');
    await loadLanguages();
    await loadEntries();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function submitEntry(event) {
  event.preventDefault();
  if (state.editingId && !state.lockHeld) return; // 只读模式兜底：不允许保存
  clearNotice();
  clearFieldMarks();
  hideConflict();
  const payload = {
    module: el('entry-module').value,
    key: el('entry-key').value,
    note: el('entry-note').value,
    operator: currentOperator(),
    translations: collectTranslations(),
  };
  const editing = state.editingId;
  if (editing && state.editingBase) payload.base = state.editingBase;
  try {
    if (editing) {
      await request(`/api/entries/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('文案已保存', 'ok');
    } else {
      await request('/api/entries', { method: 'POST', body: JSON.stringify(payload) });
      notify('文案已新增', 'ok');
    }
    closeEntryForm();
    await loadEntries();
    await loadLanguages();
  } catch (err) {
    if (err.code === 'ENTRY_CONFLICT' && err.details) {
      showConflict(err.details);
    }
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 冲突面板上的两个选择之一：放弃本地这次的改动，表单换成对方保存的内容，可继续查看或再改
function discardLocalChanges() {
  if (!state.conflict || !state.conflict.current) return;
  const current = state.conflict.current;
  fillEntryForm(current);
  state.editingBase = JSON.parse(JSON.stringify(current));
  hideConflict();
  notify('已放弃本地改动，表单已换成对方保存的内容', 'ok');
}

// 冲突面板上的两个选择之二：按本地内容强制覆盖。
// 以服务端当前内容为基准重新提交，证明这次覆盖是看过差异之后的决定；
// 服务端会把这次覆盖记在文案上，事后看得出是谁压掉的
async function forceOverwrite() {
  if (!state.conflict || !state.editingId) return;
  clearNotice();
  clearFieldMarks();
  const payload = {
    module: el('entry-module').value,
    key: el('entry-key').value,
    note: el('entry-note').value,
    operator: currentOperator(),
    translations: collectTranslations(),
    base: state.conflict.current,
    force: true,
  };
  try {
    await request(`/api/entries/${encodeURIComponent(state.editingId)}`, { method: 'PATCH', body: JSON.stringify(payload) });
    closeEntryForm();
    notify('已按本地内容强制覆盖，这次覆盖已记录在文案上', 'ok');
    await loadEntries();
    await loadLanguages();
  } catch (err) {
    if (err.code === 'ENTRY_CONFLICT' && err.details) {
      showConflict(err.details);
    }
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 语言与文案列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  const code = node.dataset.languageDefault || node.dataset.languageToggle
    || node.dataset.languageRename || node.dataset.languageDelete;
  if (code) {
    clearNotice();
    try {
      if (node.dataset.languageDefault) {
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ isDefault: true }) });
        notify(`${code} 已设为默认语言`, 'ok');
      } else if (node.dataset.languageToggle) {
        const target = state.languages.find((item) => item.code === code);
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !target.enabled }) });
        notify(`${code} 已${target.enabled ? '停用' : '启用'}`, 'ok');
      } else if (node.dataset.languageRename) {
        const target = state.languages.find((item) => item.code === code);
        const next = window.prompt(`把 ${code} 的名称改成`, target ? target.name : '');
        if (next === null) return;
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ name: next }) });
        notify(`${code} 的名称已更新`, 'ok');
      } else {
        if (!window.confirm(`确定删除语言 ${code} 吗？`)) return;
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'DELETE' });
        notify(`${code} 已删除`, 'ok');
      }
      await loadLanguages();
      await loadEntries();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.entryEdit) {
    clearNotice();
    // 打开编辑表单前先登记占用：已被别人占用时拿到的是对方的信息，表单进入只读
    try {
      releaseCurrentLock();
      const payload = await request(`/api/entries/${encodeURIComponent(node.dataset.entryEdit)}/lock`, {
        method: 'POST',
        body: JSON.stringify({ operator: currentOperator(), clientId: clientId() }),
      });
      openEntryForm(payload.entry, payload);
      if (!payload.acquired) {
        notify(`这条文案正由 ${payload.lock.operator} 编辑，你只能查看，不能保存`, 'error');
      }
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.entryDelete) {
    clearNotice();
    const found = state.entries.find((item) => item.id === node.dataset.entryDelete);
    if (!window.confirm(`确定删除文案 ${found ? found.key : ''} 吗？`)) return;
    try {
      await request(`/api/entries/${encodeURIComponent(node.dataset.entryDelete)}`, { method: 'DELETE' });
      if (state.editingId === node.dataset.entryDelete) closeEntryForm();
      notify('文案已删除', 'ok');
      await loadEntries();
      await loadLanguages();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

el('language-form').addEventListener('submit', submitLanguage);
el('entry-form').addEventListener('submit', submitEntry);
el('entry-new').addEventListener('click', () => {
  clearNotice();
  releaseCurrentLock();
  openEntryForm(null);
});
el('entry-cancel').addEventListener('click', closeEntryForm);
el('conflict-discard').addEventListener('click', discardLocalChanges);
el('conflict-force').addEventListener('click', forceOverwrite);
el('filter-apply').addEventListener('click', () => {
  clearNotice();
  loadEntries().catch((err) => notify(err.message, 'error'));
});
el('filter-reset').addEventListener('click', () => {
  el('filter-module').value = '';
  el('filter-keyword').value = '';
  loadEntries().catch((err) => notify(err.message, 'error'));
});
el('entry-refresh').addEventListener('click', () => {
  clearNotice();
  loadLanguages()
    .then(loadEntries)
    .catch((err) => notify(err.message, 'error'));
});
el('filter-module').addEventListener('change', () => {
  loadEntries().catch((err) => notify(err.message, 'error'));
});
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 关掉或刷新页面时顺手释放占用，不用等锁自己过期
window.addEventListener('pagehide', () => {
  if (!state.editingId || !state.lockHeld) return;
  fetch(`/api/entries/${encodeURIComponent(state.editingId)}/lock`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: clientId() }),
    keepalive: true,
  }).catch(() => {});
});

// 页面打开时先把语言与文案拉一遍，语言决定文案表格里有哪些列
restoreOperator();
loadHealth();
loadLanguages()
  .then(loadEntries)
  .catch((err) => notify(err.message, 'error'));
