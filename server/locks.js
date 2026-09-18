// 文案编辑占用：谁正在改哪一条、从什么时候开始。
// 占用记录放在服务进程内存里，不落数据文件，服务重启即清空；
// 持有人打开表单期间会隔一段时间续期一次，超过期限没续期的占用自动失效，
// 避免关掉页面或断网之后这条文案一直被占着。

const LOCK_TTL = 10 * 60 * 1000;

// entryId -> { entryId, owner, operator, since, touched }
const locks = new Map();

function prune() {
  const now = Date.now();
  locks.forEach((lock, id) => {
    if (now - lock.touched > LOCK_TTL) locks.delete(id);
  });
}

// 给页面看的占用信息：只暴露操作者与开始时间，持有人标识不外传
function publicLock(lock) {
  return { operator: lock.operator, since: lock.since };
}

function getLock(entryId) {
  prune();
  const lock = locks.get(entryId);
  return lock ? publicLock(lock) : null;
}

// 占用或续期：同一个人重复占用算续期并刷新操作者名字；
// 已被别人占着时不抢，返回当前占用信息让页面进入只读
function acquireLock(entryId, owner, operator) {
  prune();
  const existing = locks.get(entryId);
  if (existing && existing.owner !== owner) {
    return { acquired: false, lock: publicLock(existing) };
  }
  if (existing) {
    existing.touched = Date.now();
    existing.operator = operator;
    return { acquired: true, lock: publicLock(existing) };
  }
  const lock = { entryId, owner, operator, since: new Date().toISOString(), touched: Date.now() };
  locks.set(entryId, lock);
  return { acquired: true, lock: publicLock(lock) };
}

// 释放占用：默认要持有人本人来释放；owner 传空时是内部清理（比如文案被删除），直接清掉
function releaseLock(entryId, owner) {
  const existing = locks.get(entryId);
  if (!existing) return false;
  if (owner && existing.owner !== owner) return false;
  locks.delete(entryId);
  return true;
}

module.exports = { getLock, acquireLock, releaseLock };
