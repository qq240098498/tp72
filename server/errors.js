// 带错误码与出错位置的业务异常，页面据此把问题标到具体输入项上；
// details 用来捎带结构化信息（比如占用记录、冲突差异），页面据此渲染专门的面板
class ApiError extends Error {
  constructor(status, code, message, field, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field || '';
    this.details = details || null;
  }
}

// 去掉首尾空白后的文本，非字符串一律当作空
function pickText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// 布尔取值：只有明确写成 false 才算否，其余按真处理
function pickFlag(value, fallback) {
  if (value === undefined || value === null) return !!fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return !!fallback;
}

module.exports = { ApiError, pickText, pickFlag };
