// 编辑占用：谁在什么时候占住了哪条文案。占用记录只留在服务进程内存里，
// 带十分钟有效期，页面靠心跳续期；服务重启后占用记录自然清空，不会留下幽灵占用
const crypto = require('crypto');
const { ApiError } = require('./errors');

const LOCK_TTL_MS = 10 * 60 * 1000;
const locks = new Map();

function isActive(lock) {
  return lock && Date.parse(lock.expiresAt) > Date.now();
}

// 取出某条文案当前有效的占用，顺手清掉已经过期的记录
function getActive(entryId) {
  const lock = locks.get(entryId);
  if (!lock) return null;
  if (!isActive(lock)) {
    locks.delete(entryId);
    return null;
  }
  return lock;
}

// 占用或续期：token 对得上是心跳续期，同一个人重复打开也算续期（开始时间保留第一次的）；
// 被别人占着时不抢，把占用中的记录交回给调用方报错
function acquire(entryId, operator, token) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS).toISOString();
  const existing = getActive(entryId);
  if (existing) {
    if ((token && existing.token === token) || existing.operator === operator) {
      existing.expiresAt = expiresAt;
      return { ok: true, lock: existing };
    }
    return { ok: false, lock: existing };
  }
  const lock = {
    token: crypto.randomUUID(),
    operator,
    since: now.toISOString(),
    expiresAt,
  };
  locks.set(entryId, lock);
  return { ok: true, lock };
}

// 释放：只有拿着正确 token 的请求才释放得掉，别人的释放请求直接忽略
function release(entryId, token) {
  const lock = locks.get(entryId);
  if (!lock) return false;
  if (token && lock.token !== token) return false;
  locks.delete(entryId);
  return true;
}

// 文案被删除时连带清掉占用，不问 token
function drop(entryId) {
  locks.delete(entryId);
}

// 保存前的门槛：条目被别人占着时不允许落盘
function assertCanSave(entryId, token) {
  const lock = getActive(entryId);
  if (lock && lock.token !== token) {
    throw new ApiError(409, 'ENTRY_LOCKED', `这条文案正由 ${lock.operator} 占用（从 ${lock.since} 开始），当前不能保存`, '', { lock: expose(lock) });
  }
}

// 给页面看的占用信息：不带 token，token 只在占用成功时发给占用者本人
function expose(lock) {
  if (!lock) return null;
  return { operator: lock.operator, since: lock.since, expiresAt: lock.expiresAt };
}

module.exports = {
  acquire,
  release,
  drop,
  getActive,
  assertCanSave,
  expose,
  LOCK_TTL_MS,
};
