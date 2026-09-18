const path = require('path');
const express = require('express');
const api = require('./api');

const app = express();
const PORT = process.env.PORT || 5072;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// 健康检查：页面右上角据此显示服务连接状态
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, port: PORT });
});

app.get('/api/languages', (_req, res) => {
  res.json({ languages: api.listLanguages() });
});

app.post('/api/languages', (req, res) => {
  try {
    res.status(201).json(api.createLanguage(req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.patch('/api/languages/:code', (req, res) => {
  try {
    res.json(api.updateLanguage(req.params.code, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/languages/:code', (req, res) => {
  try {
    res.json(api.deleteLanguage(req.params.code));
  } catch (err) {
    sendError(res, err);
  }
});

// 文案列表：按模块与关键词筛选，返回值里带上各模块的条数，页面据此刷新筛选下拉
app.get('/api/entries', (req, res) => {
  const result = api.listEntries({
    module: api.readQuery(req.query, 'module'),
    keyword: api.readQuery(req.query, 'keyword'),
  });
  res.json(result);
});

app.post('/api/entries', (req, res) => {
  try {
    res.status(201).json(api.createEntry(req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/entries/:id', (req, res) => {
  try {
    res.json(api.getEntry(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

app.patch('/api/entries/:id', (req, res) => {
  try {
    res.json(api.updateEntry(req.params.id, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

// 编辑占用：打开表单时占位（也用于心跳续期），关闭表单时释放
app.post('/api/entries/:id/lock', (req, res) => {
  try {
    res.json(api.lockEntry(req.params.id, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/entries/:id/lock', (req, res) => {
  try {
    res.json(api.unlockEntry(req.params.id, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/entries/:id', (req, res) => {
  try {
    res.json(api.deleteEntry(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

// 未匹配到的接口路径统一返回说明，避免前端拿到一串页面内容
app.use('/api', (_req, res) => {
  res.status(404).json({ error: { code: 'API_NOT_FOUND', message: '接口不存在', field: '' } });
});

// 统一错误出口：业务异常按状态码与错误码返回，details 里的结构化信息原样带给页面，其余按服务异常处理
function sendError(res, err) {
  if (err instanceof api.ApiError) {
    const error = { code: err.code, message: err.message, field: err.field };
    if (err.details) error.details = err.details;
    return res.status(err.status).json({ error });
  }
  console.error('[tp72] 处理请求时出现未预期的问题：', err);
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: '服务内部异常，请稍后重试', field: '' },
  });
}

// 请求体解析失败时给出明确说明
app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'BODY_INVALID_JSON', message: '提交的内容不是合法的 JSON', field: '' },
    });
  }
  if (err) return sendError(res, err);
  return next();
});

app.listen(PORT, () => {
  console.log(`多语言文案管理平台已启动：http://localhost:${PORT}`);
});
