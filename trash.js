/*
 * 回收站管理页：
 * - GET /api/trash 读取列表；
 * - POST /api/trash/restore 恢复单项；
 * - DELETE /api/trash/item 彻底删除单项；
 * - DELETE /api/trash 清空全部。
 * 页面只用 createElement/textContent 渲染回收站条目，避免 manifest 中的路径或标题进入 HTML sink。
 */

const dom = {
  reload: document.getElementById('reloadTrashButton'),
  search: document.getElementById('trashSearch'),
  filters: document.getElementById('trashFilters'),
  empty: document.getElementById('emptyTrashButton'),
  state: document.getElementById('trashState'),
  list: document.getElementById('trashList'),
  totalItems: document.getElementById('trashTotalItems'),
  totalBytes: document.getElementById('trashTotalBytes'),
  detail: document.getElementById('trashDetail'),
  detailTitle: document.getElementById('trashDetailTitle'),
  detailMeta: document.getElementById('trashDetailMeta'),
  detailBody: document.getElementById('trashDetailBody'),
  confirmPanel: document.getElementById('trashConfirmPanel'),
  confirmTitle: document.getElementById('trashConfirmTitle'),
  confirmMessage: document.getElementById('trashConfirmMessage'),
  confirmCancel: document.getElementById('trashConfirmCancelButton'),
  confirmAction: document.getElementById('trashConfirmActionButton'),
  footerLeft: document.getElementById('trashFooterLeft'),
  footerRight: document.getElementById('trashFooterRight')
};

const FILTERS = [
  ['all', '全部'],
  ['project', '项目'],
  ['episode', '分集'],
  ['resource', '资源'],
  ['items', '其他']
];

const KIND_LABELS = {
  project: '项目',
  episode: '分集',
  resource: '资源',
  items: '其他'
};

const TRASH_ACTIONS = {
  restore: {
    title: '恢复到原位置',
    actionText: '确认恢复',
    tone: 'normal'
  },
  delete: {
    title: '彻底删除',
    actionText: '确认删除',
    tone: 'danger'
  },
  empty: {
    title: '清空回收站',
    actionText: '确认清空',
    tone: 'danger'
  }
};

const state = {
  trash: { totalItems: 0, totalBytes: 0, items: [] },
  query: '',
  filter: 'all',
  busyItemId: null,
  selectedItemId: null,
  pendingAction: null
};

dom.reload.addEventListener('click', () => loadTrash());
dom.empty.addEventListener('click', emptyTrash);
dom.confirmCancel.addEventListener('click', cancelTrashAction);
dom.confirmAction.addEventListener('click', confirmTrashAction);
dom.search.addEventListener('input', () => {
  state.query = dom.search.value.trim().toLowerCase();
  render();
});

await loadTrash();

async function loadTrash() {
  setFooter('正在读取回收站…');
  try {
    const res = await fetch('/api/trash');
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    state.trash = json.trash || { totalItems: 0, totalBytes: 0, items: [] };
    ensureSelectedItem();
    setFooter(`已加载 ${state.trash.totalItems || 0} 项`);
  } catch (error) {
    state.trash = { totalItems: 0, totalBytes: 0, items: [] };
    state.selectedItemId = null;
    showState(`读取回收站失败：${error.message}`);
    setFooter('读取失败');
    renderTrashDetail();
    return;
  }
  render();
}

function render() {
  const items = Array.isArray(state.trash.items) ? state.trash.items : [];
  const visibleItems = filterItems(items);
  dom.totalItems.textContent = `${state.trash.totalItems || 0} 项`;
  dom.totalBytes.textContent = formatBytes(state.trash.totalBytes || 0);
  dom.empty.disabled = (state.trash.totalItems || 0) === 0 || !!state.busyItemId;
  renderFilters(items);
  dom.list.replaceChildren();

  if (!items.length) {
    showState('当前没有回收站内容。');
    renderTrashDetail();
    return;
  }
  if (!visibleItems.length) {
    showState('没有匹配当前搜索或筛选条件的内容。');
    renderTrashDetail();
    return;
  }

  dom.state.hidden = true;
  for (const item of visibleItems) {
    dom.list.appendChild(renderItem(item));
  }
  renderTrashDetail();
}

function renderFilters(items) {
  const counts = countByKind(items);
  dom.filters.replaceChildren();
  for (const [key, label] of FILTERS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'trash-filter';
    button.role = 'tab';
    button.setAttribute('aria-selected', String(state.filter === key));
    button.textContent = key === 'all' ? `${label} ${items.length}` : `${label} ${counts.get(key) || 0}`;
    button.addEventListener('click', () => {
      state.filter = key;
      render();
    });
    dom.filters.appendChild(button);
  }
}

function renderItem(item) {
  const li = document.createElement('li');
  const article = document.createElement('article');
  article.className = item.id === state.selectedItemId ? 'trash-item trash-item--selected' : 'trash-item';
  article.role = 'button';
  article.tabIndex = 0;
  article.setAttribute('aria-pressed', String(item.id === state.selectedItemId));
  article.addEventListener('click', () => selectTrashItem(item.id));
  article.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectTrashItem(item.id);
  });

  const main = document.createElement('div');
  main.className = 'trash-item__main';

  const header = document.createElement('div');
  header.className = 'trash-item__header';
  const kind = document.createElement('span');
  kind.className = 'trash-item__kind';
  kind.textContent = kindLabel(item);
  const title = document.createElement('strong');
  title.className = 'trash-item__title';
  title.textContent = itemTitle(item);
  header.append(kind, title);

  const meta = document.createElement('div');
  meta.className = 'trash-item__meta';
  meta.textContent = `${formatTime(item.movedAt)} · ${formatBytes(item.bytes || 0)} · ${item.isDirectory ? '目录' : '文件'}`;

  const location = document.createElement('div');
  location.className = 'trash-item__path';
  location.textContent = `原位置：${shortOriginalLocation(item)}`;

  main.append(header, meta, location);
  article.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'trash-item__actions';
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'ghost-button';
  restore.textContent = state.busyItemId === item.id ? '处理中…' : '恢复';
  restore.disabled = !item.canRestore || !!state.busyItemId;
  restore.addEventListener('click', (event) => {
    event.stopPropagation();
    restoreItem(item);
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger-button';
  remove.textContent = state.busyItemId === item.id ? '处理中…' : '彻底删除';
  remove.disabled = !!state.busyItemId;
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    deleteItem(item);
  });
  actions.append(restore, remove);
  article.appendChild(actions);
  li.appendChild(article);
  return li;
}

function renderTrashDetail() {
  const item = selectedItem();
  dom.detailBody.replaceChildren();
  if (!item) {
    dom.detailTitle.textContent = '选择回收站内容';
    dom.detailMeta.textContent = '点击左侧项目、分集或资源后，可查看来源和可执行操作。';
    cancelTrashAction();
    return;
  }

  dom.detailTitle.textContent = itemTitle(item);
  dom.detailMeta.textContent = `${kindLabel(item)} · ${formatBytes(item.bytes || 0)} · ${restoreImpact(item)}`;
  appendDetailRow('类型', kindLabel(item));
  appendDetailRow('删除时间', formatTime(item.movedAt));
  appendDetailRow('大小', formatBytes(item.bytes || 0));
  appendDetailRow('形态', item.isDirectory ? '目录' : '文件');
  appendDetailRow('恢复位置', item.originalPath || '原位置未知', true);
  appendDetailRow('删除原因', item.reason || '用户删除');
  appendDetailRow('回收站 ID', item.id || '未知', true);
}

function appendDetailRow(label, value, mono = false) {
  const row = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  if (mono) {
    const code = document.createElement('code');
    code.textContent = String(value);
    dd.appendChild(code);
  } else {
    dd.textContent = String(value);
  }
  row.append(dt, dd);
  dom.detailBody.appendChild(row);
}

function selectTrashItem(itemId) {
  state.selectedItemId = itemId;
  cancelTrashAction({ keepFooter: true });
  render();
}

function ensureSelectedItem() {
  const items = Array.isArray(state.trash.items) ? state.trash.items : [];
  if (!items.length) {
    state.selectedItemId = null;
    return;
  }
  if (!items.some((item) => item.id === state.selectedItemId)) {
    state.selectedItemId = items[0].id;
  }
}

function selectedItem() {
  return (state.trash.items || []).find((item) => item.id === state.selectedItemId) || null;
}

function restoreItem(item) {
  requestTrashAction('restore', item);
}

function deleteItem(item) {
  requestTrashAction('delete', item);
}

function emptyTrash() {
  const count = state.trash.totalItems || 0;
  if (!count) return;
  requestTrashAction('empty', null);
}

function requestTrashAction(type, item) {
  const config = TRASH_ACTIONS[type];
  if (!config) return;
  state.pendingAction = { type, itemId: item?.id || null };
  if (item?.id) state.selectedItemId = item.id;
  renderTrashDetail();
  dom.confirmPanel.hidden = false;
  dom.confirmTitle.textContent = config.title;
  dom.confirmMessage.textContent = confirmationMessage(type, item);
  dom.confirmAction.textContent = config.actionText;
  dom.confirmAction.className = config.tone === 'danger' ? 'danger-button' : 'primary-button';
  dom.confirmAction.disabled = !!state.busyItemId;
}

function confirmationMessage(type, item) {
  if (type === 'empty') {
    return `将永久删除回收站中的 ${state.trash.totalItems || 0} 项，预计释放 ${formatBytes(state.trash.totalBytes || 0)}。这个操作无法在应用内恢复。`;
  }
  const title = itemTitle(item);
  if (type === 'restore') {
    return `将「${title}」放回原位置。如果原位置已有同名内容，应用会停止恢复并提示，不会覆盖现有内容。`;
  }
  return `将永久删除「${title}」并释放空间。删除后无法在应用内恢复。`;
}

function cancelTrashAction(options = {}) {
  state.pendingAction = null;
  dom.confirmPanel.hidden = true;
  dom.confirmAction.disabled = false;
  if (!options.keepFooter && dom.footerLeft.textContent.startsWith('操作失败')) {
    setFooter('就绪');
  }
}

async function confirmTrashAction() {
  const pending = state.pendingAction;
  if (!pending) return;
  const item = pending.itemId ? (state.trash.items || []).find((entry) => entry.id === pending.itemId) : null;
  const busyId = pending.itemId || '__all__';
  const title = itemTitle(item);
  state.busyItemId = busyId;
  dom.confirmAction.disabled = true;
  render();
  try {
    if (pending.type === 'restore') {
      await restoreTrashItem(item);
      setFooter(`已恢复 ${title}`);
    } else if (pending.type === 'delete') {
      await deleteTrashItem(item);
      setFooter(`已彻底删除 ${title}`);
    } else if (pending.type === 'empty') {
      await emptyTrashItems();
      setFooter('回收站已清空');
    }
    state.pendingAction = null;
    state.busyItemId = null;
    await loadTrash();
  } catch (error) {
    state.busyItemId = null;
    setFooter(`操作失败：${friendlyTrashError(error)}`);
    render();
    dom.confirmPanel.hidden = false;
    dom.confirmMessage.textContent = friendlyTrashError(error);
    dom.confirmAction.disabled = false;
  }
}

async function restoreTrashItem(item) {
  if (!item?.id) return;
  const res = await fetch('/api/trash/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId: item.id })
  });
  const json = await safeJson(res);
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
}

async function deleteTrashItem(item) {
  if (!item?.id) return;
  const res = await fetch('/api/trash/item', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId: item.id })
  });
  const json = await safeJson(res);
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
}

async function emptyTrashItems() {
  const res = await fetch('/api/trash', { method: 'DELETE' });
  const json = await safeJson(res);
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
}

function filterItems(items) {
  const query = state.query;
  return items.filter((item) => {
    const kind = item.kind || item.bucket || 'items';
    if (state.filter !== 'all' && kind !== state.filter) return false;
    if (!query) return true;
    const haystack = [
      item.title,
      item.name,
      item.kind,
      item.reason,
      item.originalPath
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(query);
  });
}

function countByKind(items) {
  const counts = new Map();
  for (const item of items) {
    const kind = item.kind || item.bucket || 'items';
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return counts;
}

function showState(message) {
  dom.state.hidden = false;
  dom.state.textContent = message;
}

function setFooter(message) {
  dom.footerLeft.textContent = message;
  dom.footerRight.textContent = new Date().toLocaleString();
}

function itemTitle(item) {
  return item?.title || item?.name || item?.id || '未命名内容';
}

function kindLabel(item) {
  return KIND_LABELS[item?.kind] || KIND_LABELS[item?.bucket] || '其他';
}

function shortOriginalLocation(item) {
  const value = item?.originalPath || '';
  if (!value) return '原位置未知';
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.slice(-3).join(' / ') || value;
}

function restoreImpact(item) {
  const kind = item?.kind || item?.bucket;
  if (kind === 'project') return '恢复后会重新出现在项目库';
  if (kind === 'episode') return '恢复后会回到原项目的分集列表';
  if (kind === 'resource') return '恢复后会回到原分镜资源';
  return '恢复后会放回原位置';
}

function friendlyTrashError(error) {
  const message = error?.message || String(error || '');
  if (/Original path already exists/i.test(message)) {
    return '原位置已经有同名内容。请先移动当前内容，再恢复回收站内容。';
  }
  if (/Original episode no longer exists/i.test(message)) {
    return '原分集已经不存在。请先恢复对应分集或项目，再恢复该资源。';
  }
  if (/Original project no longer exists/i.test(message)) {
    return '原项目已经不存在。请先恢复项目，再恢复该分集或资源。';
  }
  return message || '操作失败';
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  for (const unit of units) {
    if (size < 1024 || unit === 'GB') return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
    size /= 1024;
  }
  return `${value} B`;
}

function formatTime(value) {
  if (!value) return '时间未知';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
