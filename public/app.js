// 页面交互：语言清单与文案清单都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  languages: [],
  entries: [],
  modules: [],
  editingId: '',
  editingLock: null, // 自己占到的锁：{ token, operator, since, expiresAt }
  baseEntry: null, // 打开表单那一刻的快照，保存时随请求带上，服务端据此判断有没有被别人改过
  readOnly: false, // 别人占着时打开的是只读表单
  lockTimer: null, // 心跳定时器：占用期间每分钟续期一次
};

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明、出错位置与结构化详情一起抛出去
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
    failure.details = error.details || null;
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

function renderEntries() {
  const head = el('entry-head-row');
  head.innerHTML = ['模块', '文案键']
    .concat(state.languages.map((item) => item.code))
    .concat(['备注', '最近改动人', '更新时间', '编辑占用', '覆盖记录', '操作'])
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
    // 占用记录：谁占着、从什么时候开始，别人一眼能看到这条正在被人编辑
    const lockCell = item.lock
      ? `<td><span class="tag busy">${escapeHtml(item.lock.operator)} 编辑中</span><div class="cell-sub">自 ${escapeHtml(formatTime(item.lock.since))} 起</div></td>`
      : '<td class="missing">—</td>';
    // 覆盖记录：这条文案被谁强制覆盖过，留在列表里事后可查
    const overrideCell = item.lastForceOverride
      ? `<td><span class="tag overridden">被强制覆盖过</span><div class="cell-sub">${escapeHtml(item.lastForceOverride.by)} · ${escapeHtml(formatTime(item.lastForceOverride.at))}</div></td>`
      : '<td class="missing">—</td>';
    return `<tr>
      <td class="mono">${escapeHtml(item.module)}</td>
      <td class="mono">${escapeHtml(item.key)}</td>
      ${cells.join('')}
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td>${escapeHtml(item.updatedBy)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      ${lockCell}
      ${overrideCell}
      <td class="actions">
        <button type="button" class="link" data-entry-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-entry-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
  el('entry-empty').classList.toggle('hidden', state.entries.length > 0);
}

// 点编辑时先尝试占住这条文案：占住了按可编辑打开并记下快照与占用凭证；
// 被别人占着时照样打开，但只能看不能存，页面上说清当前是谁占着
async function beginEdit(id) {
  clearNotice();
  try {
    const res = await request(`/api/entries/${encodeURIComponent(id)}/lock`, {
      method: 'POST',
      body: JSON.stringify({ operator: currentOperator() }),
    });
    openEntryForm(res.entry, { lock: res.lock, readOnly: false });
  } catch (err) {
    if (err.code === 'ENTRY_LOCKED' && err.details && err.details.entry) {
      openEntryForm(err.details.entry, { lock: err.details.lock, readOnly: true });
      return;
    }
    notify(err.message, 'error');
  }
}

function openEntryForm(entry, options) {
  const opts = options || {};
  state.editingId = entry ? entry.id : '';
  state.baseEntry = entry ? JSON.parse(JSON.stringify(entry)) : null;
  state.editingLock = !opts.readOnly && opts.lock && opts.lock.token ? opts.lock : null;
  state.readOnly = !!opts.readOnly;
  el('entry-form-title').textContent = entry ? `编辑文案：${entry.key}` : '新建文案';
  el('entry-module').value = entry ? entry.module : '';
  el('entry-key').value = entry ? entry.key : '';
  el('entry-note').value = entry ? entry.note : '';
  el('entry-translations').innerHTML = '';
  renderTranslationInputs(entry ? entry.translations : {});
  hideConflict();
  renderLockBanner(opts.lock || null);
  applyReadOnly();
  el('entry-form').classList.remove('hidden');
  startLockHeartbeat();
  if (!state.readOnly) el('entry-module').focus();
}

// 占用横幅：自己占着时留下占用记录（谁、从什么时候开始）；别人占着时说清只能看不能存
function renderLockBanner(lock) {
  const banner = el('lock-banner');
  if (!state.editingId) {
    banner.className = 'lock-banner hidden';
    banner.textContent = '';
    return;
  }
  if (state.readOnly) {
    banner.className = 'lock-banner warn';
    banner.textContent = lock
      ? `这条文案正由 ${lock.operator} 占用（从 ${formatTime(lock.since)} 开始），你只能查看，不能保存`
      : '这条文案正被别人占用，你只能查看，不能保存';
    return;
  }
  if (state.editingLock) {
    banner.className = 'lock-banner info';
    banner.textContent = `占用记录：${state.editingLock.operator} 从 ${formatTime(state.editingLock.since)} 开始编辑这条文案，保存或取消后释放`;
    return;
  }
  banner.className = 'lock-banner hidden';
  banner.textContent = '';
}

function applyReadOnly() {
  const form = el('entry-form');
  form.classList.toggle('readonly', state.readOnly);
  form.querySelectorAll('input').forEach((input) => {
    input.disabled = state.readOnly;
  });
  el('entry-save').disabled = state.readOnly;
}

// 占用期间每分钟向服务端续期一次；续不上（锁过期被别人拿走）时当场转成只读
function startLockHeartbeat() {
  stopLockHeartbeat();
  if (!state.editingId || !state.editingLock) return;
  state.lockTimer = window.setInterval(async () => {
    if (!state.editingId || !state.editingLock) return;
    try {
      const res = await request(`/api/entries/${encodeURIComponent(state.editingId)}/lock`, {
        method: 'POST',
        body: JSON.stringify({ operator: currentOperator(), lockToken: state.editingLock.token }),
      });
      state.editingLock = res.lock;
    } catch (err) {
      stopLockHeartbeat();
      state.editingLock = null;
      state.readOnly = true;
      applyReadOnly();
      renderLockBanner(err.details && err.details.lock ? err.details.lock : null);
      notify(err.message || '占用已失效，当前只能查看', 'error');
    }
  }, 60000);
}

function stopLockHeartbeat() {
  if (state.lockTimer) {
    window.clearInterval(state.lockTimer);
    state.lockTimer = null;
  }
}

// 关闭表单时把自己占的锁放掉；服务端可能已经放过了，再发一次也无妨
function releaseCurrentLock() {
  const id = state.editingId;
  const lock = state.editingLock;
  state.editingLock = null;
  if (!id || !lock) return;
  request(`/api/entries/${encodeURIComponent(id)}/lock`, {
    method: 'DELETE',
    body: JSON.stringify({ lockToken: lock.token }),
  }).catch(() => {});
}

function closeEntryForm() {
  releaseCurrentLock();
  stopLockHeartbeat();
  state.editingId = '';
  state.baseEntry = null;
  state.readOnly = false;
  el('entry-form').classList.add('hidden');
  hideConflict();
  clearFieldMarks();
}

// 保存被拒时的冲突面板：逐项列出别人把它从什么改成了什么，并给出两个明确的选择
function showConflict(details) {
  const changes = (details && details.changes) || [];
  const list = el('conflict-list');
  list.innerHTML = changes.length
    ? changes.map((change) => `<li><span class="conflict-field">${escapeHtml(change.label)}</span>：<span class="conflict-from">${escapeHtml(displayValue(change.from))}</span><span class="conflict-arrow">→</span><span class="conflict-to">${escapeHtml(displayValue(change.to))}</span></li>`).join('')
    : '<li>对方改动了这条文案，但具体差异没能列出来</li>';
  el('entry-conflict').classList.remove('hidden');
  el('entry-conflict').scrollIntoView({ block: 'nearest' });
}

function hideConflict() {
  el('entry-conflict').classList.add('hidden');
  el('conflict-list').innerHTML = '';
}

function displayValue(value) {
  return value === undefined || value === null || value === '' ? '（空）' : value;
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

// 编辑保存时带上打开表单那一刻的快照与占用凭证：
// 服务端据此判断占用期间有没有被别人改过，被改过就拒绝并把差异带回来
async function submitEntry(event) {
  event.preventDefault();
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
  if (editing) {
    payload.baseUpdatedAt = state.baseEntry ? state.baseEntry.updatedAt : '';
    payload.baseEntry = state.baseEntry || undefined;
    payload.lockToken = state.editingLock ? state.editingLock.token : '';
  }
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
    if (editing && err.code === 'ENTRY_CONFLICT' && err.details) {
      notify(err.message, 'error');
      showConflict(err.details);
      return;
    }
    if (editing && err.code === 'ENTRY_LOCKED') {
      // 占用已经落到别人手里：当场转成只读，避免误以为还能存
      stopLockHeartbeat();
      state.editingLock = null;
      state.readOnly = true;
      applyReadOnly();
      renderLockBanner(err.details && err.details.lock ? err.details.lock : null);
    }
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 冲突面板的两个选择之一：按本地填写的内容强制覆盖，服务端会在文案上留下覆盖记录
async function forceOverwrite() {
  clearNotice();
  const editing = state.editingId;
  if (!editing) return;
  const payload = {
    module: el('entry-module').value,
    key: el('entry-key').value,
    note: el('entry-note').value,
    operator: currentOperator(),
    translations: collectTranslations(),
    baseUpdatedAt: state.baseEntry ? state.baseEntry.updatedAt : '',
    baseEntry: state.baseEntry || undefined,
    lockToken: state.editingLock ? state.editingLock.token : '',
    force: true,
  };
  try {
    await request(`/api/entries/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
    notify('已按你的内容强制覆盖，这条文案的覆盖记录会留在列表里', 'ok');
    closeEntryForm();
    await loadEntries();
    await loadLanguages();
  } catch (err) {
    if (err.code === 'ENTRY_LOCKED') {
      stopLockHeartbeat();
      state.editingLock = null;
      state.readOnly = true;
      applyReadOnly();
      renderLockBanner(err.details && err.details.lock ? err.details.lock : null);
      hideConflict();
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
    beginEdit(node.dataset.entryEdit);
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
  openEntryForm(null);
});
el('entry-cancel').addEventListener('click', closeEntryForm);
// 冲突面板的另一个选择：放弃本地这次的改动，服务端上的内容保持不动
el('conflict-abandon').addEventListener('click', () => {
  closeEntryForm();
  notify('已放弃本次修改，这条文案保持别人改后的内容', 'ok');
  loadEntries().catch((err) => notify(err.message, 'error'));
});
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

// 页面关闭或刷新时尽力把占用放掉，免得别人干等占用过期
window.addEventListener('beforeunload', () => {
  if (!state.editingId || !state.editingLock) return;
  fetch(`/api/entries/${encodeURIComponent(state.editingId)}/lock`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lockToken: state.editingLock.token }),
    keepalive: true,
  });
});

// 页面打开时先把语言与文案拉一遍，语言决定文案表格里有哪些列
restoreOperator();
loadHealth();
loadLanguages()
  .then(loadEntries)
  .catch((err) => notify(err.message, 'error'));
