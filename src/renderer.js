// ============ Sims4YCC MOD 管理工具 - 前端逻辑 ============
// 注意：api 由 preload.js 的 contextBridge.exposeInMainWorld('api', ...) 注入
// 在 contextIsolation 模式下，'api' 已是全局标识符，不可再用 const 重复声明

// 全局状态
const appState = {
  currentStep: 'overview',
  pausedSteps: new Set(),
  skippedSteps: new Set(),
  doneSteps: new Set(),
  modsFolder: '',                    // 当前选中的 Mods 文件夹路径（跨平台，只读真实路径）
  scanResults: null,
  anchored: [],
  keepList: [],
  whitelist: [],
  classifications: {},
  tags: [],
  categories: [],
  translations: [],
  selectedTransFiles: new Set(),     // 翻译页勾选的文件路径
  selectedFiles: new Set(),          // 分类页选中的文件路径
  selectedCategoryPath: [],          // 分类页选中的分类路径
  selectedTags: new Set(),           // 分类页当前选中的标签
  classifyImages: {},                // 文件夹路径 -> 图片数据
  // 图片预览
  previewImages: [],
  previewIndex: 0,
  previewZoom: 1,
  // 冲突检测与删除
  conflictDeleteMode: 'auto',    // auto | manual（从设置读取默认值）
  conflictSelectedFiles: new Set(), // 手动模式下勾选的文件路径集合
  conflictAutoPlanCache: null,  // 自动规划结果缓存 { plan, skippedGroups }
  conflictAutoDeletePaths: [],  // 弹窗确认时要执行删除的路径列表
  conflictManualDeletePaths: [],// 手动模式下弹窗确认时要删除的路径列表
};

// ============ 工具函数 ============
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }
/**
 * 跨平台路径归一化：将 Windows 反斜杠统一为正斜杠，
 * 用于路径比较、basename/dirname 等字符串处理（写磁盘仍用 Node path.join）
 */
function normalizePath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/');
}
function isPathValid(p) {
  if (!p) return false;
  const s = String(p).trim();
  if (s.length < 2) return false;
  // 排除占位文本：C: 也合法（盘符），但不能只有提示文本
  if (s.includes('请先选择') || s.includes('未设置')) return false;
  return true;
}
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}
function fmtDate(iso) {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleString('zh-CN'); } catch (e) { return iso; }
}
function basename(p) {
  if (!p) return '';
  const parts = normalizePath(p).split('/');
  return parts[parts.length - 1];
}
function dirname(p) {
  if (!p) return '';
  const np = normalizePath(p);
  return np.split('/').slice(0, -1).join('/') || np;
}
function isAnchoredFile(filePath) {
  const fp = normalizePath(filePath);
  return appState.anchored.some(a => fp.startsWith(normalizePath(a)));
}
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  setTimeout(() => t.classList.add('hidden'), 2500);
}

// ============ 初始化 ============
async function init() {
  const state = await api.getState();
  // Mods 文件夹路径：同时写入全局状态（唯一数据源）与界面显示
  appState.modsFolder = state.modsFolder || '';
  appState.anchored = state.anchored || [];
  appState.keepList = state.keepList || [];
  appState.whitelist = state.whitelist || [];
  appState.classifications = state.classifications || {};
  appState.tags = state.tags || [];
  appState.categories = state.categories || [];
  appState.scanResults = state.scanResults;
  appState.damagedFiles = (state.scanResults && state.scanResults.damagedFiles) || [];

  if (appState.modsFolder) {
    $('#modsPathDisplay').textContent = appState.modsFolder;
  }
  // 同步严格模式开关状态
  const chkStrict = $('#chkStrictMode');
  if (chkStrict && state.strictMode) {
    chkStrict.checked = true;
    $('#strictModeLabel').style.display = '';
  }

  bindNavigation();
  bindTopbar();
  bindGlobalEvents();
  renderOverview();
}

// ============ 导航 ============
function bindNavigation() {
  $$('.task-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('task-btn')) return;
      const step = item.dataset.step;
      if (appState.skippedSteps.has(step)) {
        toast('该步骤已跳过', 'error');
        return;
      }
      switchStep(step);
    });
  });

  // 跳过按钮
  $$('.skip-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const step = btn.dataset.step;
      appState.skippedSteps.add(step);
      const item = $(`.task-item[data-step="${step}"]`);
      if (item) item.classList.add('skipped');
      toast(`已跳过：${item.querySelector('.task-name').textContent}`);
    });
  });

  // 暂停按钮
  $$('.pause-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = btn.closest('.task-item');
      const step = item.dataset.step;
      if (appState.pausedSteps.has(step)) {
        appState.pausedSteps.delete(step);
        item.classList.remove('paused');
        btn.textContent = '暂停';
        toast(`已恢复：${item.querySelector('.task-name').textContent}`);
      } else {
        appState.pausedSteps.add(step);
        item.classList.add('paused');
        btn.textContent = '继续';
        toast(`已暂停：${item.querySelector('.task-name').textContent}`);
      }
    });
  });
}

function switchStep(step) {
  appState.currentStep = step;
  $$('.task-item').forEach(i => i.classList.toggle('active', i.dataset.step === step));
  $$('.page').forEach(p => p.classList.remove('active'));
  $(`#page-${step}`).classList.add('active');

  // 按需渲染
  if (step === 'overview') renderOverview();
  if (step === 'anchor') renderAnchorPage();
  if (step === 'classify') renderClassifyPage();
  if (step === 'translation') renderTranslationPage();
  if (step === 'settings') loadSettingsPage();
}

// ============ 顶部栏 ============
function bindTopbar() {
  $('#btnSelectFolder').addEventListener('click', async () => {
    const result = await api.selectFolder();
    if (result.canceled) return;
    // 更新全局唯一数据源 + 界面显示（两者保持一致）
    appState.modsFolder = result.path || '';
    $('#modsPathDisplay').textContent = appState.modsFolder;
    toast('文件夹已选择：' + appState.modsFolder, 'success');
    renderOverview();
  });

  $('#btnReset').addEventListener('click', async () => {
    if (!confirm('确定重置所有数据？这将清除扫描结果、锚定、分类等所有记录（不会删除文件）。')) return;
    await api.resetState();
    location.reload();
  });

  $('#btnStartScan').addEventListener('click', () => switchStep('scan'));
}

function bindGlobalEvents() {
  // 弹窗关闭
  $$('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.close;
      $('#' + id).classList.add('hidden');
    });
  });
  // 点击弹窗外关闭
  $$('.modal').forEach(m => {
    m.addEventListener('click', (e) => {
      if (e.target === m) m.classList.add('hidden');
    });
  });
}

// ============ 总览 ============
function renderOverview() {
  const sr = appState.scanResults;
  if (sr && sr.stats) {
    $('#ovModsFolder').textContent = basename(sr.root) || sr.root;
    $('#ovTotalFiles').textContent = sr.stats.totalFiles;
    $('#ovPackages').textContent = sr.stats.packageFiles;
    $('#ovTs4script').textContent = sr.stats.ts4scriptFiles;
    $('#ovImages').textContent = sr.stats.imageFiles;
    $('#ovAnchored').textContent = appState.anchored.length;
  } else {
    $('#ovModsFolder').textContent = $('#modsPathDisplay').textContent;
  }
}

// ============ 深度扫描 ============
let _scanProgressOff = null;
function bindScanPage() {
  $('#btnRunScan').addEventListener('click', runDeepScan);
  const exp = $('#btnExportDamageReport');
  if (exp) exp.addEventListener('click', async () => {
    const r = await api.exportDamagedReport();
    if (r.canceled) return;
    if (r.error) toast(r.error, 'error');
    else if (r.ok) toast(`已导出 ${r.count} 条完整性检测报告`, 'success');
  });
  // 完整性检测开关 ↔ 严格模式开关联动
  const chkIntegrity = $('#chkIntegrityCheck');
  const strictLabel = $('#strictModeLabel');
  const chkStrict = $('#chkStrictMode');
  if (chkIntegrity && strictLabel) {
    chkIntegrity.addEventListener('change', () => {
      strictLabel.style.display = chkIntegrity.checked ? '' : 'none';
    });
  }
  if (chkStrict) {
    chkStrict.addEventListener('change', async () => {
      await api.setStrictMode(chkStrict.checked);
      toast(chkStrict.checked ? '已切换为严格模式' : '已切换为综合实用型检测（默认）');
    });
  }
}

async function runDeepScan() {
  // 统一从 appState.modsFolder（唯一数据源）读取，不依赖界面文本
  if (!isPathValid(appState.modsFolder)) {
    toast('请先选择 Mods 文件夹', 'error');
    return;
  }
  const btn = $('#btnRunScan');
  btn.disabled = true;
  $('#scanProgress').innerHTML = '<span class="loading"></span> 正在深度扫描...';

  // 注册进度监听（只注册一次）
  if (typeof _scanProgressOff === 'function') try { _scanProgressOff(); } catch (e) {}
  _scanProgressOff = api.onScanProgress((data) => {
    const wrap = $('#scanProgressBar');
    if (!wrap) return;
    wrap.classList.remove('hidden');
    let pct = 0;
    if (data.phase === 'integrity' && data.integrityTotal > 0) {
      pct = Math.max(50, Math.round(50 + (data.integrityCurrent / data.integrityTotal) * 50));
    } else if (data.total > 0) {
      pct = Math.round((data.current / data.total) * 50);
    }
    $('#scanProgressFill').style.width = pct + '%';
    $('#scanProgressText').textContent = data.message + (data.phase === 'integrity' && data.integrityTotal > 0 ? ` (${data.integrityCurrent}/${data.integrityTotal})` : (data.total > 0 ? ` (${data.current}/${data.total})` : ''));
  });

  const integrityCheck = $('#chkIntegrityCheck') ? $('#chkIntegrityCheck').checked : false;

  try {
    const result = await api.deepScan({ integrityCheck });
    if (result.error) {
      toast(result.error, 'error');
      $('#scanProgress').textContent = result.error;
      $('#scanProgressBar').classList.add('hidden');
      return;
    }
    appState.scanResults = result;
    appState.anchored = await api.getAnchors();
    appState.classifications = await api.getClassifications();
    appState.damagedFiles = result.damagedFiles || [];
    renderScanResult(result);
    $('#scanProgress').textContent = '扫描完成';
    $('#scanProgressFill').style.width = '100%';
    const s = result.stats;
    let dmgSummary = '';
    if (s.damagedCount > 0 || s.warningCount > 0) {
      dmgSummary = ` · 严重损坏 ${s.damagedCount} · 警告 ${s.warningCount}`;
    }
    if (s.nonstandardCount > 0) {
      dmgSummary += ` · 非标准 ${s.nonstandardCount}`;
    }
    $('#scanProgressText').textContent = `扫描完成 · ${s.totalFiles} 个文件 · 自动分类 ${result.autoClassifiedCount || 0} 个${dmgSummary}`;
    toast('深度扫描完成' + (s.damagedCount > 0 ? `，发现 ${s.damagedCount} 个严重损坏文件` : '') + (s.warningCount > 0 ? `，${s.warningCount} 个警告` : ''), 'success');
    // 显示损坏报告导出按钮（有损坏或警告时显示）
    const exp = $('#btnExportDamageReport');
    if (exp) exp.classList.toggle('hidden', !(s.damagedCount > 0 || s.warningCount > 0));
    markStepDone('scan');
    renderOverview();
  } catch (e) {
    toast('扫描失败：' + e.message, 'error');
    $('#scanProgress').textContent = '扫描失败';
  } finally {
    btn.disabled = false;
  }
}

function renderScanResult(result) {
  const area = $('#scanResultArea');
  const s = result.stats;
  const allFlagged = (result.damagedFiles && result.damagedFiles.length > 0) ? result.damagedFiles : [];
  const critical = allFlagged.filter(d => d.level === 'critical');
  const warning = allFlagged.filter(d => d.level === 'warning');
  const levelBadgeText = { critical: '严重损坏', warning: '警告', nonstandard: '非标准', normal: '正常' };

  function renderFlaggedList(items, titleColor, titleText) {
    if (items.length === 0) return '';
    return `
    <h3 style="margin:16px 0 10px;font-size:14px;color:${titleColor}">${titleText}（共 ${items.length} 个）</h3>
    <div class="folder-list">
      ${items.slice(0, 200).map(d => `
        <div class="file-item" style="border-left:3px solid ${titleColor}">
          <span class="folder-icon">⚠</span>
          <div style="flex:1;min-width:0">
            <div class="folder-name">${esc(d.name)} <span class="damage-badge ${d.level || 'critical'}">${levelBadgeText[d.level] || '可能损坏'}</span></div>
            <div class="folder-path">${esc(d.path)}</div>
            <div class="trans-meta" style="margin-top:2px"><span>原因: ${esc(d.reason || '-')}</span></div>
            <div class="trans-meta"><span style="color:var(--text-muted)">${esc(d.detail || '')}</span></div>
          </div>
          <button class="locate-btn" data-locate="${esc(d.path)}">📂</button>
        </div>`).join('')}
      ${items.length > 200 ? `<div class="empty-state" style="padding:12px">（仅显示前 200 项，详细列表请使用"导出损坏报告"）</div>` : ''}
    </div>`;
  }

  area.innerHTML = `
    <div class="move-summary">
      <div class="move-summary-row"><span>扫描时间</span><span>${fmtDate(result.scannedAt)}</span></div>
      <div class="move-summary-row"><span>Mods 根目录</span><span>${esc(result.root)}</span></div>
      <div class="move-summary-row"><span>总文件数</span><span>${s.totalFiles}</span></div>
      <div class="move-summary-row"><span>.package 文件</span><span>${s.packageFiles}</span></div>
      <div class="move-summary-row"><span>.ts4script 文件</span><span>${s.ts4scriptFiles}</span></div>
      <div class="move-summary-row"><span>图片文件</span><span>${s.imageFiles}</span></div>
      <div class="move-summary-row"><span>根目录文件夹数</span><span>${s.totalFolders}</span></div>
      <div class="move-summary-row"><span>自动分类数</span><span style="color:var(--success)">${result.autoClassifiedCount || 0}</span></div>
      <div class="move-summary-row"><span>完整性检测</span><span>${result.integrityEnabled ? (result.strictMode ? '已启用 · 严格模式' : '已启用 · 综合实用型') : '未启用'}</span></div>
      ${s.damagedCount > 0 ? `<div class="move-summary-row"><span>严重损坏文件</span><span style="color:var(--danger)">${s.damagedCount}</span></div>` : ''}
      ${s.warningCount > 0 ? `<div class="move-summary-row"><span>警告文件</span><span style="color:var(--warning)">${s.warningCount}</span></div>` : ''}
      ${s.nonstandardCount > 0 ? `<div class="move-summary-row"><span>非标准资源</span><span style="color:var(--text-muted)">${s.nonstandardCount}</span></div>` : ''}
    </div>

    ${renderFlaggedList(critical, 'var(--danger)', '严重损坏文件（建议删除）')}
    ${renderFlaggedList(warning, 'var(--warning)', '警告文件（建议检查）')}

    <h3 style="margin:16px 0 10px;font-size:14px;color:var(--text-secondary)">自动锚定的 .ts4script 模组文件夹</h3>
    <div class="folder-list">
      ${result.ts4scriptFolders.length === 0
        ? '<div class="empty-state"><div class="empty-icon">📦</div>未发现 .ts4script 模组</div>'
        : result.ts4scriptFolders.map(f => `
          <div class="folder-item">
            <span class="folder-icon">⚙</span>
            <span class="folder-name">${esc(basename(f))}</span>
            <span class="folder-path">${esc(f)}</span>
            <span class="anchor-badge">已自动锚定</span>
          </div>`).join('')
      }
    </div>
  `;
  bindLocateButtons(area);
}

function markStepDone(step) {
  appState.doneSteps.add(step);
  const item = $(`.task-item[data-step="${step}"]`);
  if (item) item.classList.add('done');
}

// ============ 锚定保护 ============
function bindAnchorPage() {
  $('#btnSelectAllSearch').addEventListener('click', selectAllSearchResults);
  $('#btnBatchAddAnchor').addEventListener('click', batchAddAnchor);
  $('#anchorSearch').addEventListener('input', renderAnchoredList);
}

async function renderAnchorPage() {
  await renderRootFolders();
  await renderAnchoredList();
}

async function renderRootFolders() {
  const result = await api.getRootFolders();
  const list = $('#rootFoldersList');
  if (result.error) {
    list.innerHTML = `<div class="empty-state">${esc(result.error)}</div>`;
    return;
  }
  const folders = result.folders.filter(f => f.isDirectory);
  if (folders.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">📁</div>未发现文件夹</div>';
    return;
  }
  list.innerHTML = folders.map(f => `
    <div class="folder-item" data-path="${esc(f.path)}">
      <input type="checkbox" class="folder-checkbox" data-path="${esc(f.path)}" ${f.anchored ? 'checked disabled' : ''}>
      <span class="folder-icon">📁</span>
      <span class="folder-name">${esc(f.name)}</span>
      ${f.anchored ? '<span class="anchor-badge">已锚定</span>' : ''}
    </div>
  `).join('');

  // 勾选即锚定整个文件夹
  list.querySelectorAll('.folder-checkbox').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      e.stopPropagation();
      const p = cb.dataset.path;
      if (cb.checked) {
        await api.addAnchor([p]);
        appState.anchored = await api.getAnchors();
        cb.disabled = true;
        cb.closest('.folder-item').insertAdjacentHTML('beforeend', '<span class="anchor-badge">已锚定</span>');
        toast(`已锚定：${basename(p)}`, 'success');
        renderAnchoredList();
        renderOverview();
      }
    });
  });
}

async function renderAnchoredList() {
  const keyword = $('#anchorSearch').value.trim().toLowerCase();
  const list = $('#anchoredList');
  let anchored = appState.anchored;
  if (keyword) {
    anchored = anchored.filter(a => a.toLowerCase().includes(keyword));
  }
  if (anchored.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">📌</div>暂无已锚定项目</div>';
    return;
  }
  list.innerHTML = anchored.map(a => {
    const rel = appState.scanResults ? normalizePath(a).replace(normalizePath(appState.scanResults.root), '').replace(/^[\/]/, '') : basename(a);
    return `
      <div class="folder-item">
        <input type="checkbox" class="folder-checkbox search-result-cb" data-path="${esc(a)}">
        <span class="folder-icon">📌</span>
        <div style="flex:1;min-width:0">
          <div class="folder-name">${esc(basename(a))}</div>
          <div class="folder-path">Mods/${esc(rel)}</div>
        </div>
        <button class="btn btn-sm" data-unanchor="${esc(a)}">解除</button>
      </div>
    `;
  }).join('');

  list.querySelectorAll('[data-unanchor]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const p = btn.dataset.unanchor;
      await api.removeAnchor(p);
      appState.anchored = await api.getAnchors();
      toast(`已解除锚定：${basename(p)}`);
      renderAnchoredList();
      renderRootFolders();
      renderOverview();
    });
  });
}

function selectAllSearchResults() {
  $$('.search-result-cb').forEach(cb => cb.checked = true);
  toast('已全选当前搜索结果');
}

async function batchAddAnchor() {
  const checked = [...$$('.search-result-cb:checked')].map(cb => cb.dataset.path);
  // 这些其实已经在锚定列表中，批量添加主要用于根目录文件夹列表
  const rootChecked = [...$$('#rootFoldersList .folder-checkbox:not(:disabled):checked')].map(cb => cb.dataset.path);
  const all = [...new Set([...checked, ...rootChecked])];
  if (all.length === 0) {
    toast('请先勾选要锚定的文件夹', 'error');
    return;
  }
  await api.addAnchor(all);
  appState.anchored = await api.getAnchors();
  toast(`已批量锚定 ${all.length} 项`, 'success');
  renderAnchorPage();
  renderOverview();
}

// ============ 重复排查 ============
function bindDuplicatePage() {
  $('#btnScanDup').addEventListener('click', scanDuplicates);
  $('#btnCleanDup').addEventListener('click', cleanDuplicates);
}

let dupGroups = [];

async function scanDuplicates() {
  const btn = $('#btnScanDup');
  btn.disabled = true;
  $('#dupSummary').innerHTML = '<span class="loading"></span> 扫描中...';
  try {
    const result = await api.scanDuplicates();
    if (result.error) { toast(result.error, 'error'); $('#dupSummary').textContent = result.error; return; }
    dupGroups = result.groups;
    appState.keepList = await api.getState().then(s => s.keepList || []);
    renderDupGroups();
    $('#dupSummary').textContent = `发现 ${result.totalDuplicates} 个重复文件，共 ${dupGroups.length} 组`;
    toast('重复扫描完成', 'success');
  } catch (e) {
    toast('扫描失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function renderDupGroups() {
  const area = $('#dupResultArea');
  if (dupGroups.length === 0) {
    area.innerHTML = '<div class="empty-state"><div class="empty-icon">✓</div>未发现重复文件</div>';
    return;
  }
  area.innerHTML = dupGroups.map((g, gi) => `
    <div class="dup-group">
      <div class="dup-group-header">
        <span>第 ${gi + 1} 组 — ${g.files.length} 个相同文件</span>
        <span class="dup-group-hash">MD5: ${g.hash.slice(0, 16)}...</span>
      </div>
      <div class="folder-list" style="background:transparent;border:none;padding:0">
        ${g.files.map((f, fi) => {
          const newest = fi === 0; // 已按日期排序，第一个最新
          return `
          <div class="file-item ${f.anchored ? 'disabled' : ''}">
            <input type="checkbox" class="file-checkbox" data-path="${esc(f.path)}" data-group="${gi}" ${f.kept ? 'checked' : ''} ${f.anchored ? 'disabled' : ''}>
            <span class="folder-icon">📦</span>
            <div style="flex:1;min-width:0">
              <div class="folder-name">${esc(f.name)}</div>
              <div class="folder-path">${esc(f.relPath)} · ${fmtSize(f.size)} · ${fmtDate(f.mtime)}</div>
            </div>
            ${f.anchored ? '<span class="anchor-badge">已锚定·最高优先</span>' : ''}
            ${f.kept ? '<span class="keep-badge">已标记保留</span>' : ''}
            ${newest ? '<span class="keep-badge">最新</span>' : ''}
            <button class="locate-btn" data-locate="${esc(f.path)}" title="定位">📂</button>
          </div>`;
        }).join('')}
      </div>
    </div>
  `).join('');

  // 绑定保留标记
  area.querySelectorAll('.file-checkbox').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      const p = cb.dataset.path;
      if (cb.checked) {
        await api.markKeep([p]);
        appState.keepList.push(p);
        cb.closest('.file-item').insertAdjacentHTML('beforeend', '<span class="keep-badge">已标记保留</span>');
      } else {
        await api.unmarkKeep([p]);
        appState.keepList = appState.keepList.filter(x => x !== p);
        const badge = cb.closest('.file-item').querySelector('.keep-badge');
        if (badge) badge.remove();
      }
    });
  });
  // 定位
  bindLocateButtons(area);
}

async function cleanDuplicates() {
  if (dupGroups.length === 0) {
    toast('请先扫描重复文件', 'error');
    return;
  }
  if (!confirm('将自动删除重复文件（保留最新版本，已标记保留和已锚定的不会被删除）。确认执行？')) return;
  const btn = $('#btnCleanDup');
  btn.disabled = true;
  $('#dupSummary').innerHTML = '<span class="loading"></span> 清理中...';
  try {
    const result = await api.cleanDuplicates();
    if (result.error) { toast(result.error, 'error'); return; }
    const area = $('#dupResultArea');
    area.innerHTML = `
      <div class="move-summary">
        <div class="move-summary-row"><span>已删除</span><span style="color:var(--danger)">${result.deletedCount} 个</span></div>
        <div class="move-summary-row"><span>已保留</span><span style="color:var(--success)">${result.kept.length} 个</span></div>
        ${result.errors.length > 0 ? `<div class="move-summary-row"><span>失败</span><span style="color:var(--danger)">${result.errors.length} 个</span></div>` : ''}
      </div>
      ${result.deleted.map(d => `<div class="move-entry"><span style="color:var(--danger)">✗</span> 已删除: ${esc(basename(d))}</div>`).join('')}
    `;
    $('#dupSummary').textContent = `清理完成：删除 ${result.deletedCount} 个，保留 ${result.kept.length} 个`;
    toast(`清理完成，删除 ${result.deletedCount} 个文件`, 'success');
    markStepDone('duplicate');
  } catch (e) {
    toast('清理失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ============ 冲突检测 ============
let _conflictProgressOff = null;
function bindConflictPage() {
  $('#btnScanConflict').addEventListener('click', scanConflicts);
  $('#btnShowWhitelist').addEventListener('click', showWhitelist);
  // 模式切换按钮（快捷切换）
  $$('#conflictModeSwitch .mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      setConflictDeleteModeUI(mode, true);
    });
  });
  // 自动删除
  $('#btnConflictAutoDelete').addEventListener('click', onAutoDeleteClick);
  // 手动删除
  $('#btnConflictManualDelete').addEventListener('click', onManualDeleteClick);
  // 撤销
  $('#btnConflictUndo').addEventListener('click', onUndoDeleteClick);
  // 弹窗：确认自动删除
  $('#btnConfirmAutoDelete').addEventListener('click', onConfirmAutoDelete);
  // 弹窗：确认手动删除
  $('#btnConfirmManualDelete').addEventListener('click', onConfirmManualDelete);
}

let conflictList = [];

async function scanConflicts() {
  const btn = $('#btnScanConflict');
  btn.disabled = true;
  $('#conflictSummary').innerHTML = '<span class="loading"></span> 扫描中（后台线程执行，不卡界面）...';
  // 显示进度条
  const progWrap = $('#conflictProgressBar');
  if (progWrap) progWrap.classList.remove('hidden');
  const fill = $('#conflictProgressFill');
  const txt = $('#conflictProgressText');
  let lastPct = 0;
  if (fill) fill.style.width = '0%';
  if (txt) txt.textContent = '准备启动冲突检测 Worker...';

  // 注册进度监听（worker 发出）
  if (typeof _conflictProgressOff === 'function') try { _conflictProgressOff(); } catch (e) {}
  _conflictProgressOff = api.onConflictProgress((data) => {
    if (!data) return;
    const cur = data.current || 0;
    const tot = data.total || 0;
    const pct = tot > 0 ? Math.min(100, Math.round((cur / tot) * 100)) : lastPct;
    lastPct = pct;
    if (fill) fill.style.width = pct + '%';
    if (txt) {
      let suffix = '';
      if (data.phase === 'integrity' && data.integrityTotal > 0) {
        suffix = ` (${data.integrityCurrent}/${data.integrityTotal})`;
      } else if (tot > 0) {
        suffix = ` (${cur}/${tot})`;
      }
      if (data.skipped > 0) suffix += ` · 跳过 ${data.skipped}`;
      txt.textContent = (data.message || '处理中...') + suffix;
    }
  });

  // 清空手动勾选、自动规划缓存
  appState.conflictSelectedFiles.clear();
  appState.conflictAutoPlanCache = null;

  try {
    const result = await api.scanConflicts();
    if (fill) fill.style.width = '100%';
    if (result.error) {
      toast(result.error, 'error');
      $('#conflictSummary').textContent = result.error;
      if (txt) txt.textContent = '失败：' + result.error;
      return;
    }
    conflictList = result.conflicts;
    // 初始加载时同步模式：先从后端拿默认模式，再更新 UI
    try {
      const r = await api.getConflictDeleteMode();
      appState.conflictDeleteMode = (r && r.mode) || 'auto';
    } catch (e) {}
    setConflictDeleteModeUI(appState.conflictDeleteMode, false);
    renderConflicts();
    updateConflictSelectedCount();
    const skipInfo = (result.skippedFiles && result.skippedFiles.length > 0)
      ? ` · 异常跳过 ${result.skippedFiles.length} 个` : '';
    $('#conflictSummary').textContent = `发现 ${result.total} 个冲突${skipInfo}`;
    if (txt) txt.textContent = `检测完成：${result.total} 组冲突${skipInfo}`;
    toast('冲突检测完成（后台线程执行，不卡界面）', 'success');
    markStepDone('conflict');
  } catch (e) {
    toast('扫描失败：' + e.message, 'error');
    if (txt) txt.textContent = '扫描失败：' + e.message;
  } finally {
    btn.disabled = false;
    // 3 秒后隐藏进度条
    setTimeout(() => {
      if (progWrap) progWrap.classList.add('hidden');
    }, 3000);
    if (typeof _conflictProgressOff === 'function') try { _conflictProgressOff(); } catch (e) {}
    _conflictProgressOff = null;
  }
}

/**
 * 设置冲突删除模式 UI
 * @param {'auto'|'manual'} mode
 * @param {boolean} saveToBackend 是否同步保存到后端（设置页也会保存）
 */
function setConflictDeleteModeUI(mode, saveToBackend) {
  const m = mode === 'manual' ? 'manual' : 'auto';
  appState.conflictDeleteMode = m;
  // 工具栏模式按钮高亮
  $$('#conflictModeSwitch .mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === m);
  });
  // 显示/隐藏对应按钮
  const autoBtn = $('#btnConflictAutoDelete');
  const manualBtn = $('#btnConflictManualDelete');
  const countEl = $('#conflictSelectCount');
  if (autoBtn) autoBtn.classList.toggle('hidden', m !== 'auto');
  if (manualBtn) manualBtn.classList.toggle('hidden', m !== 'manual');
  if (countEl) countEl.classList.toggle('hidden', m !== 'manual');
  if (saveToBackend) {
    api.setConflictDeleteMode(m).catch(() => {});
  }
  // 重新渲染冲突列表（手动模式会有复选框）
  if (conflictList && conflictList.length > 0) {
    renderConflicts();
    updateConflictSelectedCount();
  }
}

function renderConflicts() {
  const area = $('#conflictResultArea');
  if (conflictList.length === 0) {
    area.innerHTML = '<div class="empty-state"><div class="empty-icon">✓</div>未发现冲突</div>';
    return;
  }
  const mode = appState.conflictDeleteMode;
  area.innerHTML = conflictList.map((c, gi) => {
    const sevClass = c.conflictSeverity === 'high' ? 'severity-high' : c.conflictSeverity === 'medium' ? 'severity-medium' : 'severity-low';
    const sevText = c.conflictSeverity === 'high' ? '高' : c.conflictSeverity === 'medium' ? '中' : '低';
    // 手动模式：计算可勾选的非锚定文件数，是否全部已勾选
    const groupNonAnchored = (c.files || []).filter(f => !f.anchored);
    const groupSelectable = groupNonAnchored.length;
    const groupSelected = groupNonAnchored.filter(f => appState.conflictSelectedFiles.has(f.path)).length;
    const groupAllChecked = groupSelectable > 0 && groupSelected === groupSelectable;
    const groupSomeChecked = groupSelected > 0 && groupSelected < groupSelectable;

    return `
    <div class="conflict-item ${c.hasAnchored ? 'has-anchored' : ''}" data-group-idx="${gi}">
      <div class="conflict-header">
        <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">
          ${mode === 'manual' ? `
            <input type="checkbox" class="conflict-group-check" data-group-idx="${gi}" title="全选本组可删除文件"
              ${groupSelectable === 0 ? 'disabled' : ''}
              ${groupAllChecked ? 'checked' : ''}
              ${groupSomeChecked ? 'data-indeterminate="1"' : ''}>
          ` : ''}
          <span class="conflict-detail" style="min-width:0">${esc(c.detail)}</span>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <span class="${sevClass}">严重：${sevText}</span>
          <span class="author-badge">${esc(c.conflictType || '')}</span>
          ${c.sameAuthor ? '<span class="manual-badge">同作者·可能版本更迭</span>' : ''}
          ${c.hasAnchored ? '<span class="anchor-badge">含锚定·最高优先</span>' : ''}
          ${mode === 'manual' && groupSelectable > 0 ? `<span class="count-text">本组已选 ${groupSelected}/${groupSelectable}</span>` : ''}
          <button class="btn btn-sm" data-whitelist="${esc(c.key)}">加入白名单</button>
        </div>
      </div>
      <div class="conflict-meta">
        <span>⚖ 冲突双方：${esc(c.conflictPair || '')}</span>
        ${c.sameAuthor && c.commonAuthor ? `<span>👤 共同作者：<strong>${esc(c.commonAuthor)}</strong></span>` : ''}
      </div>
      ${c.impact ? `<div class="conflict-impact"><strong>可能的影响：</strong>${esc(c.impact)}</div>` : ''}
      ${c.suggestion ? `<div class="conflict-suggestion">💡 建议：${esc(c.suggestion)}</div>` : ''}
      ${c.sameAuthor ? `<div class="same-author-hint">💡 两个冲突文件作者相同，很可能是同一作者发布的不同版本更迭，建议保留日期最新的那个。</div>` : ''}
      <div class="conflict-files" style="margin-top:10px">
        ${c.files.map((f, idx) => {
          const checked = mode === 'manual' && appState.conflictSelectedFiles.has(f.path) ? 'checked' : '';
          const disabledClass = f.anchored ? 'cf-anchored' : '';
          return `
          <div class="conflict-file ${disabledClass}" data-group-idx="${gi}">
            ${mode === 'manual' ? `
              <input type="checkbox" class="conflict-file-check"
                data-group-idx="${gi}" data-path="${esc(f.path)}"
                ${f.anchored ? 'disabled title="已锚定，不可删除，请先解除锚定"' : ''}
                ${checked}>
            ` : '<span>📄</span>'}
            <div style="flex:1;min-width:0">
              <span style="font-size:13px">${esc(f.name)}</span>
              <div class="folder-path">${esc(f.path)} ${f.mtime ? ' · ' + fmtDate(f.mtime) : ''} · ${fmtSize(f.size || 0)}</div>
            </div>
            ${f.ext === '.ts4script' ? '<span class="keep-badge" title="脚本模组·自动删除模式优先保留">脚本模组</span>' : ''}
            ${f.author && f.author !== '未知' ? `<span class="author-badge" title="作者">👤 ${esc(f.author)}</span>` : ''}
            ${f.anchored ? '<span class="anchor-badge">已锚定</span>' : ''}
            <button class="locate-btn" data-locate="${esc(f.path)}" title="定位">📂</button>
            <button class="delete-conflict-btn" data-delconflict="${esc(f.path)}" ${f.anchored ? 'disabled title="已锚定不可删除"' : 'title="单个删除：该文件（若是独立文件夹一并删除）"'}>单个删除</button>
          </div>
        `}).join('')}
      </div>
    </div>
  `}).join('');

  // 手动模式：设置 indeterminate 状态（部分选中）
  if (mode === 'manual') {
    area.querySelectorAll('.conflict-group-check[data-indeterminate="1"]').forEach(cb => {
      cb.indeterminate = true;
    });
    // 绑定：冲突组级全选
    area.querySelectorAll('.conflict-group-check').forEach(cb => {
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        const gi = parseInt(cb.dataset.groupIdx, 10);
        if (isNaN(gi) || !conflictList[gi]) return;
        const files = conflictList[gi].files || [];
        if (cb.checked) {
          for (const f of files) {
            if (!f.anchored) appState.conflictSelectedFiles.add(f.path);
          }
        } else {
          for (const f of files) {
            appState.conflictSelectedFiles.delete(f.path);
          }
        }
        renderConflicts();
        updateConflictSelectedCount();
      });
    });
    // 绑定：单文件复选框
    area.querySelectorAll('.conflict-file-check').forEach(cb => {
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        const p = cb.dataset.path;
        if (!p) return;
        if (cb.checked) appState.conflictSelectedFiles.add(p);
        else appState.conflictSelectedFiles.delete(p);
        renderConflicts();
        updateConflictSelectedCount();
      });
    });
  }

  area.querySelectorAll('[data-whitelist]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.whitelist;
      await api.addWhitelist([key]);
      appState.whitelist.push(key);
      btn.closest('.conflict-item').remove();
      conflictList = conflictList.filter(c => c.key !== key);
      $('#conflictSummary').textContent = `发现 ${conflictList.length} 个冲突`;
      toast('已加入白名单');
    });
  });
  area.querySelectorAll('[data-delconflict]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const filePath = btn.dataset.delconflict;
      const confirmMsg = `是否确认删除该文件？\n\n删除前会先备份到 Mods/_deleted_backup/，可通过"撤销上次删除"恢复。\n\n${filePath}`;
      if (!confirm(confirmMsg)) return;
      btn.disabled = true;
      const r = await api.deleteConflictFile(filePath);
      if (r.error) {
        toast(r.error, 'error');
        btn.disabled = false;
        return;
      }
      toast(`删除成功（已备份到 ${r.backupKey || 'backup'}）${r.deletedFolder ? ' · 含所在独立文件夹' : ''}`, 'success');
      // 从手动勾选里去掉
      appState.conflictSelectedFiles.delete(filePath);
      // 从冲突列表中去掉该冲突条目（如果还存在其他文件则保留）
      for (let i = 0; i < conflictList.length; i++) {
        const c = conflictList[i];
        c.files = c.files.filter(f => !r.deleted.some(d => f.path === d));
        if (c.files.length <= 1) {
          conflictList.splice(i, 1);
          i--;
        }
      }
      $('#conflictSummary').textContent = `发现 ${conflictList.length} 个冲突`;
      renderConflicts();
      updateConflictSelectedCount();
    });
  });
  bindLocateButtons(area);
}

/** 手动模式：更新"已勾选 N 个文件待删除"计数 */
function updateConflictSelectedCount() {
  const el = $('#conflictSelectedNum');
  if (!el) return;
  el.textContent = String(appState.conflictSelectedFiles.size);
  const btn = $('#btnConflictManualDelete');
  if (btn) btn.disabled = appState.conflictSelectedFiles.size === 0;
}

// ============ 冲突删除：自动模式 ============
async function onAutoDeleteClick() {
  if (conflictList.length === 0) {
    toast('请先扫描并发现冲突', 'error');
    return;
  }
  // 调用后端计算自动规划
  const btn = $('#btnConflictAutoDelete');
  btn.disabled = true;
  try {
    const r = await api.conflictAutoPlan(conflictList);
    appState.conflictAutoPlanCache = r;
    const plan = Array.isArray(r.plan) ? r.plan : [];
    const skipped = Array.isArray(r.skippedGroups) ? r.skippedGroups : [];
    // 汇总：展开所有 toDelete 路径
    const allPaths = [];
    for (const p of plan) {
      if (Array.isArray(p.toDelete)) {
        for (const tp of p.toDelete) allPaths.push(tp);
      }
    }
    const uniqPaths = [...new Set(allPaths)];
    appState.conflictAutoDeletePaths = uniqPaths;
    if (uniqPaths.length === 0) {
      let reason = '无可自动删除的目标';
      if (skipped.length > 0) {
        const anchorSkip = skipped.filter(s => s.reason === 'anchored').length;
        reason += `（${skipped.length} 组被跳过${anchorSkip > 0 ? `，其中 ${anchorSkip} 组因为含锚定` : ''}）`;
      }
      toast(reason, 'warning');
      btn.disabled = false;
      return;
    }
    // 渲染摘要 & 列表并打开弹窗
    const summary = $('#autoDeleteSummary');
    summary.innerHTML = `
      <div class="auto-delete-summary-row"><span>冲突组数</span><span>${conflictList.length}</span></div>
      <div class="auto-delete-summary-row"><span>按规则可处理组</span><span style="color:var(--success)">${plan.length}</span></div>
      <div class="auto-delete-summary-row"><span>跳过组</span><span style="color:var(--warning)">${skipped.length}</span></div>
      <div class="auto-delete-summary-row"><span>将删除文件</span><span style="color:var(--danger);font-weight:600">${uniqPaths.length} 个</span></div>
      <div class="auto-delete-summary-row"><span>备份位置</span><span>Mods/_deleted_backup/[时间戳]/</span></div>
    `;
    const list = $('#autoDeleteList');
    list.innerHTML = uniqPaths.map(p => {
      const name = basename(p);
      return `<div class="auto-delete-entry"><span style="color:var(--danger)">✗</span><div style="flex:1;min-width:0"><div>${esc(name)}</div><div class="folder-path">${esc(p)}</div></div></div>`;
    }).join('');
    $('#autoDeleteModal').classList.remove('hidden');
  } catch (e) {
    toast('自动规划失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function onConfirmAutoDelete() {
  const paths = appState.conflictAutoDeletePaths || [];
  if (paths.length === 0) {
    toast('没有可删除的目标', 'error');
    return;
  }
  const btn = $('#btnConfirmAutoDelete');
  btn.disabled = true;
  try {
    const r = await api.conflictBatchDelete({ mode: 'auto', paths, detail: 'auto_plan_' + Date.now() });
    if (!r || !r.ok) {
      toast((r && r.error) || '删除失败', 'error');
      return;
    }
    // 清理 scanResults 中已删除的文件
    const okDeleted = new Set();
    for (const x of r.results || []) if (x.ok) okDeleted.add(x.path);
    conflictList = conflictList.map(c => {
      return { ...c, files: (c.files || []).filter(f => !okDeleted.has(f.path)) };
    }).filter(c => c.files && c.files.length >= 2);
    // 从手动勾选去掉已删
    for (const p of okDeleted) appState.conflictSelectedFiles.delete(p);
    // 关闭弹窗
    $('#autoDeleteModal').classList.add('hidden');
    renderConflicts();
    updateConflictSelectedCount();
    const summary = `删除完成：成功 ${r.deletedCount || 0}/${r.total || 0}`
      + (r.skippedAnchored && r.skippedAnchored.length > 0 ? ` · 锚定跳过 ${r.skippedAnchored.length}` : '')
      + ` · 备份在 ${r.backupKey || '?'}`;
    $('#conflictSummary').textContent = `发现 ${conflictList.length} 个冲突 · ${summary}`;
    toast(summary, 'success');
  } catch (e) {
    toast('删除失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ============ 冲突删除：手动模式 ============
function onManualDeleteClick() {
  const paths = [...appState.conflictSelectedFiles].filter(p => !isAnchoredFile(p));
  if (paths.length === 0) {
    toast('请先勾选要删除的文件（锚定的文件不可勾选）', 'error');
    return;
  }
  appState.conflictManualDeletePaths = paths;
  // 渲染摘要与列表并打开弹窗
  const summary = $('#manualDeleteSummary');
  summary.innerHTML = `
    <div class="auto-delete-summary-row"><span>已勾选待删除</span><span style="color:var(--danger);font-weight:600">${paths.length} 个文件</span></div>
    <div class="auto-delete-summary-row"><span>备份位置</span><span>Mods/_deleted_backup/[时间戳]/</span></div>
    <div class="auto-delete-summary-row"><span>说明</span><span>锚定文件已自动排除</span></div>
  `;
  const list = $('#manualDeleteList');
  list.innerHTML = paths.map(p => {
    const name = basename(p);
    return `<div class="auto-delete-entry"><span style="color:var(--danger)">✗</span><div style="flex:1;min-width:0"><div>${esc(name)}</div><div class="folder-path">${esc(p)}</div></div></div>`;
  }).join('');
  $('#manualDeleteModal').classList.remove('hidden');
}

async function onConfirmManualDelete() {
  const paths = appState.conflictManualDeletePaths || [];
  if (paths.length === 0) {
    toast('没有可删除的目标', 'error');
    return;
  }
  const btn = $('#btnConfirmManualDelete');
  btn.disabled = true;
  try {
    const r = await api.conflictBatchDelete({ mode: 'manual', paths, detail: 'manual_select_' + Date.now() });
    if (!r || !r.ok) {
      toast((r && r.error) || '删除失败', 'error');
      return;
    }
    const okDeleted = new Set();
    for (const x of r.results || []) if (x.ok) okDeleted.add(x.path);
    // 从手动勾选和冲突列表中移除已删除
    for (const p of okDeleted) appState.conflictSelectedFiles.delete(p);
    conflictList = conflictList.map(c => {
      return { ...c, files: (c.files || []).filter(f => !okDeleted.has(f.path)) };
    }).filter(c => c.files && c.files.length >= 2);
    $('#manualDeleteModal').classList.add('hidden');
    renderConflicts();
    updateConflictSelectedCount();
    const summary = `删除完成：成功 ${r.deletedCount || 0}/${r.total || 0}`
      + (r.skippedAnchored && r.skippedAnchored.length > 0 ? ` · 锚定跳过 ${r.skippedAnchored.length}` : '')
      + ` · 备份在 ${r.backupKey || '?'}`;
    $('#conflictSummary').textContent = `发现 ${conflictList.length} 个冲突 · ${summary}`;
    toast(summary, 'success');
  } catch (e) {
    toast('删除失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ============ 撤销删除 ============
async function onUndoDeleteClick() {
  if (!confirm('将还原最近一次删除操作（根据备份目录自动恢复所有已删除的文件/文件夹）。确认执行？')) return;
  const btn = $('#btnConflictUndo');
  btn.disabled = true;
  try {
    const r = await api.conflictUndoLastDelete();
    if (!r || !r.ok) {
      toast((r && r.error) || '撤销失败', 'error');
      return;
    }
    toast(`撤销完成：成功还原 ${r.restoredCount || 0} 项。请重新执行扫描/检测同步列表。`, 'success');
  } catch (e) {
    toast('撤销失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function showWhitelist() {
  const wl = await api.getWhitelist();
  appState.whitelist = wl;
  const body = $('#whitelistBody');
  if (wl.length === 0) {
    body.innerHTML = '<div class="empty-state">白名单为空</div>';
  } else {
    body.innerHTML = wl.map(k => `
      <div class="conflict-file" style="padding:8px;background:var(--bg-tertiary);border-radius:6px;margin-bottom:6px">
        <span style="flex:1;font-family:monospace;font-size:11px">${esc(k)}</span>
        <button class="btn btn-sm btn-danger" data-rmwl="${esc(k)}">移除</button>
      </div>
    `).join('');
    body.querySelectorAll('[data-rmwl]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await api.removeWhitelist(btn.dataset.rmwl);
        appState.whitelist = appState.whitelist.filter(x => x !== btn.dataset.rmwl);
        showWhitelist();
        toast('已从白名单移除');
      });
    });
  }
  $('#whitelistModal').classList.remove('hidden');
}

// ============ 翻译识别 ============
let _transProgressOff = null;
function bindTranslationPage() {
  $('#btnScanTrans').addEventListener('click', scanTranslation);
  $('#btnSelectAllTrans').addEventListener('click', () => {
    if (!appState.translations || appState.translations.length === 0) return;
    appState.translations.forEach(t => appState.selectedTransFiles.add(t.path));
    renderTranslations();
    updateTransSelectedCount();
  });
  $('#btnSelectNoneTrans').addEventListener('click', () => {
    appState.selectedTransFiles.clear();
    renderTranslations();
    updateTransSelectedCount();
  });
  $('#btnSelectUntranslated').addEventListener('click', () => {
    if (!appState.translations || appState.translations.length === 0) return;
    appState.selectedTransFiles.clear();
    appState.translations.forEach(t => {
      const hasZh = t.translatedName && t.translateStatus === 'ok';
      if (!hasZh) appState.selectedTransFiles.add(t.path);
    });
    renderTranslations();
    updateTransSelectedCount();
  });
}

// 进入翻译页面时调用：若 translations 为空，从 scanResults.files 构建初始列表
function renderTranslationPage() {
  if ((!appState.translations || appState.translations.length === 0) && appState.scanResults && appState.scanResults.files) {
    appState.translations = appState.scanResults.files
      .filter(f => f.ext === '.package')
      .map(f => {
        const hasZh = f.chineseName && String(f.chineseName).trim().length > 0;
        return {
          path: f.path,
          name: f.name,
          originalName: f.name,
          readableName: f.name.replace(/\.package$/i, ''),
          author: f.author || '未知',
          language: '未知',
          title: '',
          description: '',
          translatedName: hasZh ? f.chineseName : '',
          translatedTitle: '',
          translateStatus: hasZh ? 'ok' : 'skipped',
          anchored: isAnchoredFile(f.path),
        };
      });
  }
  renderTranslations();
  updateTransSelectedCount();
}

// 更新“已选 N 项”显示和按钮文字
function updateTransSelectedCount() {
  const count = appState.selectedTransFiles.size;
  const countEl = $('#transSelectedCount');
  if (countEl) countEl.textContent = `已选 ${count} 项`;
  const btn = $('#btnScanTrans');
  if (btn) {
    btn.textContent = count > 0 ? `翻译选中的 ${count} 个文件` : '翻译选中文件';
  }
}

async function scanTranslation() {
  const btn = $('#btnScanTrans');
  // 收集勾选的文件路径
  const selectedPaths = [...appState.selectedTransFiles];
  if (selectedPaths.length === 0) {
    toast('请先勾选需要翻译的文件', 'error');
    return;
  }
  const force = $('#chkForceRetranslate') ? $('#chkForceRetranslate').checked : false;
  // 未勾选“强制重新翻译”时，跳过已翻译文件
  const skipTranslated = !force;

  btn.disabled = true;
  $('#transSummary').innerHTML = '<span class="loading"></span> 翻译中...';
  const progBar = $('#transProgressBar');
  if (progBar) progBar.classList.remove('hidden');

  // 注册进度监听（进度仅针对选中文件）
  if (typeof _transProgressOff === 'function') try { _transProgressOff(); } catch (e) {}
  _transProgressOff = api.onTranslationProgress((data) => {
    const fill = $('#transProgressFill');
    const text = $('#transProgressText');
    if (!fill || !text) return;
    const pct = data.total > 0 ? Math.round((data.current / data.total) * 100) : 0;
    fill.style.width = pct + '%';
    text.textContent = data.message + ` (${data.current}/${data.total})`;
  });

  try {
    const result = await api.scanTranslation({ selectedPaths, skipTranslated, force });
    if (result.error) { toast(result.error, 'error'); $('#transSummary').textContent = result.error; return; }

    // 将本次翻译结果按路径合并回 translations 数组（仅更新选中文件，未选中的保持原样）
    const resultByPath = {};
    for (const t of result.translations) { resultByPath[t.path] = t; }
    appState.translations = appState.translations.map(t => resultByPath[t.path] ? resultByPath[t.path] : t);

    // 同步更新本地索引（chineseName 已写回 scanResults.files），保证全局数据源一致
    if (result.scanResults) {
      appState.scanResults = result.scanResults;
    }
    renderTranslations();
    updateTransSelectedCount();

    const okCount = result.translations.filter(t => t.translateStatus === 'ok').length;
    const failCount = result.translations.filter(t => t.translateStatus === 'failed').length;
    const skipped = result.skippedCount || 0;
    let summary = `本次处理 ${result.targetTotal} 个文件`;
    if (result.translateEnabled) {
      summary += ` · 翻译成功 ${okCount}` + (failCount > 0 ? ` · 失败 ${failCount}` : '') + (skipped > 0 ? ` · 跳过已翻译 ${skipped}` : '');
    } else {
      summary += ' · 翻译引擎未启用';
    }
    $('#transSummary').textContent = summary;
    $('#transProgressFill').style.width = '100%';
    $('#transProgressText').textContent = summary;
    toast('翻译完成', 'success');
    markStepDone('translation');
  } catch (e) {
    toast('翻译失败：' + e.message, 'error');
    $('#transSummary').textContent = '翻译失败';
  } finally {
    btn.disabled = false;
  }
}

function renderTranslations() {
  const area = $('#transResultArea');
  if (!appState.translations || appState.translations.length === 0) {
    area.innerHTML = '<div class="empty-state"><div class="empty-icon">🌐</div>暂无数据，请先执行深度扫描</div>';
    return;
  }
  const statusBadge = {
    ok: '<span class="trans-status-ok">已翻译</span>',
    failed: '<span class="trans-status-failed">翻译失败</span>',
    skipped: '<span class="trans-status-skipped">未翻译</span>',
    pending: '',
  };
  area.innerHTML = appState.translations.map(t => {
    const hasZh = t.translatedName && t.translateStatus === 'ok';
    const zhName = hasZh ? t.translatedName : (t.translateStatus === 'failed' ? '翻译失败' : t.readableName || t.name);
    const enName = t.title || t.readableName || t.name;
    const checked = appState.selectedTransFiles.has(t.path) ? 'checked' : '';
    return `
    <div class="trans-item ${checked ? 'selected' : ''}" data-path="${esc(t.path)}">
      <input type="checkbox" class="trans-checkbox" data-path="${esc(t.path)}" ${checked}>
      <span class="folder-icon">🌐</span>
      <div class="trans-info">
        <div class="trans-bilingual">
          <div class="trans-name-zh">${esc(zhName)} ${statusBadge[t.translateStatus] || ''}</div>
          <div class="trans-name-en">${esc(enName)}</div>
        </div>
        <div class="trans-meta">
          <span>📁 ${esc(t.name)}</span>
          <span>👤 作者: ${esc(t.author)}</span>
          ${t.description ? `<span>📝 ${esc(t.description.slice(0, 50))}${t.description.length > 50 ? '...' : ''}</span>` : ''}
        </div>
      </div>
      <span class="lang-badge">${esc(t.language)}</span>
      ${t.anchored ? '<span class="anchor-badge">已锚定</span>' : ''}
      <button class="locate-btn" data-locate="${esc(t.path)}">📂</button>
    </div>
  `}).join('');

  // 绑定复选框
  area.querySelectorAll('.trans-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const p = cb.dataset.path;
      if (cb.checked) {
        appState.selectedTransFiles.add(p);
        cb.closest('.trans-item').classList.add('selected');
      } else {
        appState.selectedTransFiles.delete(p);
        cb.closest('.trans-item').classList.remove('selected');
      }
      updateTransSelectedCount();
    });
  });
  bindLocateButtons(area);
}

// ============ 分类与打标签 ============
function bindClassifyPage() {
  $('#classifySearch').addEventListener('input', renderClassifyFileList);
  $('#tagFilter').addEventListener('change', renderClassifyFileList);
  $('#btnAddTag').addEventListener('click', addTagFromInput);
  $('#tagInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTagFromInput(); });
  $('#btnApplyClassify').addEventListener('click', applyClassification);
}

// ============ 设置页面 ============
function bindSettingsPage() {
  console.log('[bindSettingsPage] 开始绑定设置页事件');
  const btnSave = $('#btnSaveTranslateConfig');
  const btnTest = $('#btnTestTranslate');
  console.log('[bindSettingsPage] 保存按钮:', btnSave, '测试按钮:', btnTest);
  if (btnSave) btnSave.addEventListener('click', saveTranslateConfig);
  if (btnTest) {
    btnTest.addEventListener('click', () => {
      console.log('[testTranslate] 按钮点击事件已触发');
      testTranslate();
    });
  } else {
    console.error('[bindSettingsPage] #btnTestTranslate 未找到！');
  }
  $('#selTranslateService').addEventListener('change', (e) => {
    const svc = e.target.value;
    const modelRow = $('#modelRow');
    if (svc === 'libretranslate') {
      $('#txtTranslateApiUrl').value = 'https://libretranslate.com/translate';
      if (modelRow) modelRow.style.display = 'none';
    } else if (svc === 'deepseek') {
      $('#txtTranslateApiUrl').value = 'https://api.deepseek.com';
      if (modelRow) modelRow.style.display = '';
      const mdl = $('#txtTranslateModel');
      if (mdl && !mdl.value) mdl.value = 'deepseek-chat';
    } else {
      if (modelRow) modelRow.style.display = '';
    }
  });
  // 严格模式同步
  const chkStrictSettings = $('#chkStrictModeSettings');
  if (chkStrictSettings) {
    chkStrictSettings.addEventListener('change', async () => {
      await api.setStrictMode(chkStrictSettings.checked);
      const chkScan = $('#chkStrictMode');
      if (chkScan) chkScan.checked = chkStrictSettings.checked;
      toast(chkStrictSettings.checked ? '已切换为严格模式' : '已切换为综合实用型检测（默认）');
    });
  }
  // 冲突删除默认模式
  const selDelMode = $('#selConflictDeleteMode');
  if (selDelMode) {
    selDelMode.addEventListener('change', async () => {
      const v = selDelMode.value === 'manual' ? 'manual' : 'auto';
      const r = await api.setConflictDeleteMode(v);
      if (r && r.mode) appState.conflictDeleteMode = r.mode;
      toast('冲突删除默认模式已保存：' + (v === 'auto' ? '自动智能删除' : '手动勾选删除'), 'success');
    });
  }
  console.log('[bindSettingsPage] 绑定完成');
}

async function loadSettingsPage() {
  try {
    const config = await api.getTranslationConfig();
    $('#chkTranslateEnabled').checked = config.enabled !== false;
    $('#selTranslateService').value = config.service || 'libretranslate';
    $('#txtTranslateApiUrl').value = config.apiUrl || 'https://libretranslate.com/translate';
    $('#txtTranslateApiKey').value = config.apiKey || '';
    $('#txtTranslateModel').value = config.model || '';
    $('#selTranslateTargetLang').value = config.targetLang || 'zh';
    // 根据服务商显示/隐藏模型字段
    const svc = config.service || 'libretranslate';
    const modelRow = $('#modelRow');
    if (modelRow) modelRow.style.display = (svc === 'deepseek' || svc === 'custom') ? '' : 'none';
    // 同步严格模式 + 冲突删除默认模式
    const st = await api.getState();
    const chkStrictSettings = $('#chkStrictModeSettings');
    if (chkStrictSettings) chkStrictSettings.checked = !!st.strictMode;
    const selDelMode = $('#selConflictDeleteMode');
    if (selDelMode) {
      // 优先从 getConflictDeleteMode 获取（权威来源）
      let m = 'auto';
      try { const r = await api.getConflictDeleteMode(); if (r && r.mode) m = r.mode; } catch (e) {}
      selDelMode.value = (m === 'manual') ? 'manual' : 'auto';
    }
  } catch (e) {
    console.error('加载设置失败:', e);
  }
}

async function saveTranslateConfig() {
  const config = {
    enabled: $('#chkTranslateEnabled').checked,
    service: $('#selTranslateService').value,
    apiUrl: $('#txtTranslateApiUrl').value.trim(),
    apiKey: $('#txtTranslateApiKey').value.trim(),
    model: $('#txtTranslateModel').value.trim(),
    targetLang: $('#selTranslateTargetLang').value,
  };
  if (!config.apiUrl) {
    toast('请填写 API 地址', 'error');
    return;
  }
  const r = await api.setTranslationConfig(config);
  if (r.ok) toast('翻译配置已保存', 'success');
  else toast('保存失败', 'error');
}

async function testTranslate() {
  console.log('[testTranslate] 函数开始执行');
  const resultEl = $('#translateTestResult');
  if (!resultEl) { console.error('[testTranslate] #translateTestResult 未找到'); return; }
  const apiUrl = $('#txtTranslateApiUrl').value.trim();
  console.log('[testTranslate] API 地址:', apiUrl);
  if (!apiUrl) { resultEl.textContent = '请先填写 API 地址'; return; }
  resultEl.textContent = '测试中...';
  try {
    // 先保存配置
    const config = {
      enabled: true,
      service: $('#selTranslateService').value,
      apiUrl: apiUrl,
      apiKey: $('#txtTranslateApiKey').value.trim(),
      model: $('#txtTranslateModel').value.trim(),
      targetLang: $('#selTranslateTargetLang').value,
    };
    console.log('[testTranslate] 保存配置:', config);
    await api.setTranslationConfig(config);
    console.log('[testTranslate] 配置已保存，开始调用 testTranslation IPC');
    const testText = '3D Lashes CAS';
    const r = await api.testTranslation(testText);
    console.log('[testTranslate] IPC 返回结果:', r);
    if (r.error) {
      resultEl.textContent = '翻译失败：' + r.error;
      console.error('[testTranslate] 翻译失败:', r.error);
    } else if (r.ok) {
      resultEl.textContent = `测试成功："${testText}" → "${r.translated}"`;
      console.log('[testTranslate] 翻译成功:', r.translated);
    } else {
      resultEl.textContent = '翻译失败（未返回结果）';
      console.error('[testTranslate] 未返回结果:', r);
    }
  } catch (e) {
    console.error('[testTranslate] 异常:', e.message, e.stack);
    resultEl.textContent = '翻译失败：' + e.message;
  }
}

async function renderClassifyPage() {
  if (!appState.scanResults) {
    $('#classifyFileList').innerHTML = '<div class="empty-state">请先执行深度扫描</div>';
    return;
  }
  await loadTags();
  renderCategoryTree();
  renderTagSuggestions();
  renderClassifyFileList();
}

async function loadTags() {
  const state = await api.getState();
  appState.tags = state.tags || [];
  appState.classifications = state.classifications || {};
  appState.categories = state.categories || [];
  const sel = $('#tagFilter');
  const cur = sel.value;

  // 收集所有实际使用的系统分类路径（顶级分类名）
  const usedCategories = new Set();
  for (const path in appState.classifications) {
    const c = appState.classifications[path];
    if (c && c.category && c.category.length > 0) {
      usedCategories.add(c.category[0]); // 顶级分类名
    }
  }

  // 系统分类标签使用特殊前缀 __cat__ 区分用户标签
  let html = '<option value="">按标签/分类筛选</option>';
  // 系统分类标签组
  if (usedCategories.size > 0) {
    html += '<optgroup label="系统自动分类" class="tag-filter-group">';
    for (const cat of [...usedCategories].sort()) {
      html += `<option value="__cat__${esc(cat)}" class="tag-system">📂 ${esc(cat)}</option>`;
    }
    html += '</optgroup>';
  }
  // 用户标签组
  if (appState.tags.length > 0) {
    html += '<optgroup label="用户标签" class="tag-filter-group">';
    for (const t of appState.tags) {
      html += `<option value="${esc(t)}" class="tag-user">🏷 ${esc(t)}</option>`;
    }
    html += '</optgroup>';
  }
  // 未识别
  html += '<option value="__cat__未识别" class="tag-system">📂 未识别</option>';
  sel.innerHTML = html;
  sel.value = cur;
}

function renderCategoryTree() {
  const container = $('#categoryTree');
  container.innerHTML = '';
  appState.categories.forEach(node => {
    container.appendChild(buildCatNode(node, []));
  });
}

function buildCatNode(node, parentPath) {
  const currentPath = [...parentPath, node.name];
  const pathKey = currentPath.join(' > ');
  const wrap = document.createElement('div');
  wrap.className = 'cat-node';
  const row = document.createElement('div');
  row.className = 'cat-row';
  const toggle = document.createElement('span');
  toggle.className = 'cat-toggle';
  toggle.textContent = (node.children && node.children.length > 0) ? '▶' : '';
  row.appendChild(toggle);
  const label = document.createElement('span');
  label.textContent = node.name;
  label.style.flex = '1';
  row.appendChild(label);

  row.addEventListener('click', (e) => {
    if (e.target === toggle && node.children && node.children.length > 0) {
      const childWrap = wrap.querySelector('.cat-children');
      if (childWrap) {
        const hidden = childWrap.style.display === 'none';
        childWrap.style.display = hidden ? '' : 'none';
        toggle.textContent = hidden ? '▼' : '▶';
      }
      return;
    }
    // 选择分类
    $$('.cat-row').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
    appState.selectedCategoryPath = currentPath;
    $('#selectedCategoryDisplay').textContent = '当前选择：' + currentPath.join(' / ');
  });
  wrap.appendChild(row);

  if (node.children && node.children.length > 0) {
    const childWrap = document.createElement('div');
    childWrap.className = 'cat-children';
    childWrap.style.display = 'none';
    node.children.forEach(child => childWrap.appendChild(buildCatNode(child, currentPath)));
    wrap.appendChild(childWrap);
  }
  return wrap;
}

function renderTagSuggestions() {
  const container = $('#tagSuggestions');
  container.innerHTML = appState.tags.map(t => `
    <span class="tag-chip-suggest" data-tag="${esc(t)}">${esc(t)}</span>
  `).join('');
  container.querySelectorAll('.tag-chip-suggest').forEach(chip => {
    chip.addEventListener('click', () => {
      appState.selectedTags.add(chip.dataset.tag);
      renderSelectedTags();
    });
  });
}

function renderSelectedTags() {
  const container = $('#selectedTags');
  container.innerHTML = [...appState.selectedTags].map(t => `
    <span class="tag-chip">${esc(t)} <span class="remove" data-rmtag="${esc(t)}">×</span></span>
  `).join('');
  container.querySelectorAll('[data-rmtag]').forEach(el => {
    el.addEventListener('click', () => {
      appState.selectedTags.delete(el.dataset.rmtag);
      renderSelectedTags();
    });
  });
}

async function addTagFromInput() {
  const input = $('#tagInput');
  const tag = input.value.trim();
  if (!tag) return;
  await api.addTag(tag);
  if (!appState.tags.includes(tag)) appState.tags.push(tag);
  appState.selectedTags.add(tag);
  input.value = '';
  renderTagSuggestions();
  renderSelectedTags();
  loadTags();
}

function renderClassifyFileList() {
  const list = $('#classifyFileList');
  if (!appState.scanResults) {
    list.innerHTML = '<div class="empty-state">请先执行深度扫描</div>';
    return;
  }
  const keyword = $('#classifySearch').value.trim().toLowerCase();
  const tagFilter = $('#tagFilter').value;

  // 标签筛选优先于名称排序
  let files = appState.scanResults.files.filter(f => f.ext === '.package' || f.ext === '.ts4script');

  // 标签/分类筛选
  if (tagFilter) {
    if (tagFilter.startsWith('__cat__')) {
      // 系统分类筛选：按顶级分类名匹配
      const catName = tagFilter.slice(6); // 去掉 __cat__ 前缀
      files = files.filter(f => {
        const c = appState.classifications[f.path];
        return c && c.category && c.category.length > 0 && c.category[0] === catName;
      });
    } else {
      // 用户标签筛选
      files = files.filter(f => {
        const c = appState.classifications[f.path];
        return c && c.tags && c.tags.includes(tagFilter);
      });
    }
  }
  // 关键词搜索
  if (keyword) {
    files = files.filter(f => f.name.toLowerCase().includes(keyword));
  }
  // 排序：标签筛选结果优先，其次按名称
  files.sort((a, b) => a.name.localeCompare(b.name));

  $('#classifySelectedCount').textContent = `已选 ${appState.selectedFiles.size} 项 / 共 ${files.length} 项`;

  if (files.length === 0) {
    list.innerHTML = '<div class="empty-state">无匹配文件</div>';
    return;
  }

  // 构建 path → level 映射（含损坏/警告/非标准）
  const levelMap = {};
  (appState.damagedFiles || []).forEach(d => { levelMap[d.path] = d.level || 'critical'; });

  list.innerHTML = files.map(f => {
    const anchored = isAnchoredFile(f.path);
    const cls = appState.classifications[f.path];
    const selected = appState.selectedFiles.has(f.path);
    const fLevel = levelMap[f.path] || (f.nonstandard ? 'nonstandard' : (f.level || 'normal'));
    const autoAssigned = cls && cls.auto === true;
    const manualAssigned = cls && cls.auto === false && cls.category && cls.category.length > 0;
    const authorBadge = f.author && f.author !== '未知' ? `<span class="author-badge" title="作者">👤 ${esc(f.author)}</span>` : '';
    const levelBadgeText = { critical: '严重损坏', warning: '警告', nonstandard: '非标准' };
    const levelBorder = { critical: 'var(--danger)', warning: 'var(--warning)', nonstandard: 'var(--border)' };
    const showLevelBadge = fLevel === 'critical' || fLevel === 'warning' || fLevel === 'nonstandard';
    // 中文名称：从本地索引读取（容错：缺失时显示“未翻译”）
    const hasZh = f.chineseName && String(f.chineseName).trim().length > 0;
    const zhNameDisplay = hasZh ? esc(f.chineseName) : '<span class="zh-name-placeholder">未翻译</span>';
    return `
      <div class="file-item ${anchored ? 'disabled' : ''} ${selected ? 'selected' : ''}" data-path="${esc(f.path)}" style="${showLevelBadge ? 'border-left:3px solid ' + levelBorder[fLevel] : ''}">
        <input type="checkbox" class="file-checkbox" data-path="${esc(f.path)}" ${selected ? 'checked' : ''} ${anchored ? 'disabled' : ''}>
        <span class="folder-icon">${f.ext === '.ts4script' ? '⚙' : '📦'}</span>
        <div style="flex:1;min-width:0">
          <div class="folder-name">${esc(f.name)} ${showLevelBadge ? `<span class="damage-badge ${fLevel}">${levelBadgeText[fLevel]}</span>` : ''} ${autoAssigned ? '<span class="auto-badge">自动分类</span>' : ''} ${manualAssigned ? '<span class="manual-badge">手动调整</span>' : ''}</div>
          <div class="file-meta">
            <span class="zh-name-row" title="中文名称（点击✏修改，同步至‘创建并移动’页面）"><span class="zh-name-label">中文名:</span> <span class="zh-name-value" data-zh-path="${esc(f.path)}">${zhNameDisplay}</span></span>
            <span>${esc(f.relPath)}</span>
            <span>${fmtSize(f.size)}</span>
            ${cls && cls.category && cls.category.length > 0 ? `<span class="file-cat">${cls.category.join('/')}</span>` : ''}
            ${cls && cls.tags ? cls.tags.map(t => `<span class="file-tag">${esc(t)}</span>`).join('') : ''}
          </div>
        </div>
        ${authorBadge}
        ${anchored ? '<span class="anchor-badge">已锚定·不可分类</span>' : ''}
        <button class="zh-edit-btn" data-zh-edit="${esc(f.path)}" title="修改中文名称">✏</button>
        <button class="locate-btn" data-locate="${esc(f.path)}" title="定位">📂</button>
      </div>
    `;
  }).join('');

  // 绑定勾选
  list.querySelectorAll('.file-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const p = cb.dataset.path;
      if (cb.checked) {
        appState.selectedFiles.add(p);
        cb.closest('.file-item').classList.add('selected');
      } else {
        appState.selectedFiles.delete(p);
        cb.closest('.file-item').classList.remove('selected');
      }
      $('#classifySelectedCount').textContent = `已选 ${appState.selectedFiles.size} 项`;
    });
  });
  // 绑定中文名称修改
  list.querySelectorAll('.zh-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openZhNameEditor(btn.dataset.zhEdit);
    });
  });
  bindLocateButtons(list);
}

// ============ 中文名称内联编辑（全局联动） ============
function openZhNameEditor(modPath) {
  if (!modPath) return;
  const fileEntry = (appState.scanResults && appState.scanResults.files || []).find(f => f.path === modPath);
  if (!fileEntry) { toast('未找到文件', 'error'); return; }
  const current = (fileEntry.chineseName || '').trim();
  const newVal = window.prompt('修改中文名称（留空将清除，同步至“创建并移动”页面）：', current);
  if (newVal === null) return; // 用户取消
  const trimmed = newVal.trim();
  api.setChineseName(modPath, trimmed).then(r => {
    if (r && r.ok) {
      // 写回本地索引（单一数据源）
      fileEntry.chineseName = trimmed;
      // 同步 translations 数组（保持翻译页面一致）
      const tItem = (appState.translations || []).find(t => t.path === modPath);
      if (tItem) {
        tItem.translatedName = trimmed;
        tItem.translateStatus = trimmed ? 'ok' : 'skipped';
      }
      // 局部刷新当前条目显示（遍历匹配，避免路径中反斜杠导致选择器失效）
      document.querySelectorAll('.zh-name-value').forEach(el => {
        if (el.dataset.zhPath === modPath) {
          el.innerHTML = trimmed ? esc(trimmed) : '<span class="zh-name-placeholder">未翻译</span>';
        }
      });
      toast(trimmed ? '中文名称已更新并同步' : '中文名称已清除', 'success');
    } else {
      toast((r && r.error) || '保存失败', 'error');
    }
  }).catch(err => toast('保存失败：' + err.message, 'error'));
}

async function applyClassification() {
  if (appState.selectedFiles.size === 0) {
    toast('请先选择文件', 'error');
    return;
  }
  const category = appState.selectedCategoryPath.length > 0 ? appState.selectedCategoryPath : null;
  const tags = [...appState.selectedTags];
  if (!category && tags.length === 0) {
    toast('请选择分类或添加标签', 'error');
    return;
  }
  let applied = 0;
  for (const p of appState.selectedFiles) {
    if (isAnchoredFile(p)) continue;
    const payload = { category: category || [], tags, auto: false };
    await api.setClassification(p, payload);
    appState.classifications[p] = payload;
    applied++;
  }
  toast(`已应用到 ${applied} 个文件（标记为"手动调整"）`, 'success');
  appState.selectedFiles.clear();
  appState.selectedCategoryPath = [];
  appState.selectedTags.clear();
  $('#selectedCategoryDisplay').textContent = '未选择分类';
  renderSelectedTags();
  renderClassifyFileList();
  markStepDone('classify');
}

// ============ 创建并移动 ============
function bindMovePage() {
  $('#btnPreviewMove').addEventListener('click', previewMove);
  $('#btnExecuteMove').addEventListener('click', executeMove);
  $('#moveSearch').addEventListener('input', () => {
    if (appState._movePreviewData) renderMovePreview(appState._movePreviewData);
  });
}

// 构建 path → 中文名映射
// 统一数据源：从本地索引 scanResults.files[].chineseName 读取
// （翻译引擎写入、手动修改均落盘到此字段，保证全局一致）
function buildTranslationMap() {
  const map = {};
  if (appState.scanResults && appState.scanResults.files) {
    for (const f of appState.scanResults.files) {
      if (f.chineseName && String(f.chineseName).trim().length > 0) {
        map[f.path] = f.chineseName;
      }
    }
  }
  return map;
}

// 按分类分组，返回 { "分类路径": [{path, cat, name, zhName, target, anchored}, ...] }
function groupMoveEntries(entries, transMap) {
  const groups = {};
  for (const [p, c] of entries) {
    const catKey = c.category.join('/');
    if (!groups[catKey]) groups[catKey] = [];
    groups[catKey].push({
      path: p,
      cat: c.category,
      name: basename(p),
      zhName: transMap[p] || '',
      target: 'Mods/' + catKey + '/' + basename(p),
      anchored: isAnchoredFile(p),
    });
  }
  // 按分类名排序
  const sorted = {};
  for (const k of Object.keys(groups).sort()) {
    sorted[k] = groups[k];
  }
  return sorted;
}

const MOVE_PREVIEW_LIMIT = 5; // 每组默认显示前 5 个文件

function renderMoveGroup(catKey, items, opts) {
  const isResult = opts.isResult || false;
  const showAll = opts.expandedGroups && opts.expandedGroups.has(catKey);
  const visible = showAll ? items : items.slice(0, MOVE_PREVIEW_LIMIT);
  const hiddenCount = items.length - visible.length;

  let bodyHtml = visible.map(item => {
    // 中文名称（结果模式与预览模式共用，容错：缺失显示“未翻译”）
    const hasZh = item.zhName && String(item.zhName).trim().length > 0;
    const zhHtml = hasZh
      ? `<span class="move-file-zh">${esc(item.zhName)}</span>`
      : `<span class="move-file-zh placeholder">未翻译</span>`;
    if (isResult) {
      // 移动结果模式
      const movedItem = opts.movedMap && opts.movedMap[item.path];
      if (movedItem) {
        return `<div class="move-result-item"><span style="color:var(--success)">✓</span> <div class="move-file-info"><span class="move-file-name">${esc(item.name)}</span>${zhHtml}</div> <span class="arrow">→</span> <span class="move-file-target">${esc(movedItem.to)}</span></div>`;
      }
      const errItem = opts.errorMap && opts.errorMap[item.path];
      if (errItem) {
        return `<div class="move-result-item"><span style="color:var(--danger)">✗</span> <div class="move-file-info"><span class="move-file-name">${esc(item.name)}</span>${zhHtml}</div> <span style="color:var(--danger);font-size:11px">${esc(errItem.error)}</span></div>`;
      }
      return `<div class="move-result-item"><span style="color:var(--warning)">⊘</span> <div class="move-file-info"><span class="move-file-name">${esc(item.name)}</span>${zhHtml}</div> <span style="color:var(--text-muted);font-size:11px">已跳过</span></div>`;
    }
    // 预览模式：同时显示原始文件名 + 中文名称（小字显示在下方）
    return `<div class="move-file-item">
      <div class="move-file-info">
        <span class="move-file-name">${esc(item.name)}</span>
        ${zhHtml}
      </div>
      <span class="move-file-target">${esc(item.target)}</span>
    </div>`;
  }).join('');

  if (hiddenCount > 0) {
    bodyHtml += `<button class="move-expand-btn" data-expand-group="${esc(catKey)}">▼ 还有 ${hiddenCount} 个文件，点击展开全部</button>`;
  }

  const collapsed = opts.collapsedGroups && opts.collapsedGroups.has(catKey);
  return `<div class="move-group">
    <div class="move-group-header${collapsed ? ' collapsed' : ''}" data-toggle-group="${esc(catKey)}">
      <span class="move-group-toggle">${collapsed ? '▶' : '▼'}</span>
      <span class="move-group-name">${esc(catKey)}</span>
      <span class="move-group-count">${items.length} 个文件</span>
    </div>
    <div class="move-group-body${collapsed ? ' hidden' : ''}">${bodyHtml}</div>
  </div>`;
}

function bindMoveGroupToggles(area) {
  // 折叠/展开分组
  area.querySelectorAll('[data-toggle-group]').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.toggleGroup;
      const body = el.nextElementSibling;
      const toggle = el.querySelector('.move-group-toggle');
      if (body.classList.contains('hidden')) {
        body.classList.remove('hidden');
        el.classList.remove('collapsed');
        toggle.textContent = '▼';
      } else {
        body.classList.add('hidden');
        el.classList.add('collapsed');
        toggle.textContent = '▶';
      }
    });
  });
  // 展开"还有 X 个文件"
  area.querySelectorAll('[data-expand-group]').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.expandGroup;
      if (!appState._moveExpandedGroups) appState._moveExpandedGroups = new Set();
      appState._moveExpandedGroups.add(key);
      // 重新渲染当前视图
      if (appState._movePreviewData) renderMovePreview(appState._movePreviewData);
    });
  });
}

function renderMovePreview(data) {
  const area = $('#moveResultArea');
  const searchTerm = ($('#moveSearch').value || '').toLowerCase().trim();

  let entries = data.entries;
  const transMap = buildTranslationMap();
  // 搜索过滤（支持按文件名、分类、中文名称检索）
  if (searchTerm) {
    entries = entries.filter(([p, c]) => {
      const name = basename(p).toLowerCase();
      const cat = c.category.join('/').toLowerCase();
      const zh = (transMap[p] || '').toLowerCase();
      return name.includes(searchTerm) || cat.includes(searchTerm) || zh.includes(searchTerm);
    });
  }

  const groups = groupMoveEntries(entries, transMap);
  const groupKeys = Object.keys(groups);

  if (groupKeys.length === 0) {
    area.innerHTML = searchTerm
      ? '<div class="empty-state"><div class="empty-icon">🔍</div>没有匹配的文件</div>'
      : '<div class="empty-state"><div class="empty-icon">📭</div>暂无可移动的文件，请先在"分类与打标签"中设置分类</div>';
    return;
  }

  let html = `<div class="move-summary">
    <div class="move-summary-row"><span>已分类文件总数</span><span>${data.total}</span></div>
    <div class="move-summary-row"><span>可移动</span><span style="color:var(--success)">${data.movableCount}</span></div>
    <div class="move-summary-row"><span>已锚定（跳过）</span><span style="color:var(--warning)">${data.anchoredCount}</span></div>
    ${searchTerm ? `<div class="move-summary-row"><span>搜索结果</span><span>${entries.length} 个文件 / ${groupKeys.length} 个分类</span></div>` : ''}
  </div>`;

  const expandedGroups = appState._moveExpandedGroups || new Set();
  for (const key of groupKeys) {
    html += renderMoveGroup(key, groups[key], { expandedGroups });
  }

  area.innerHTML = html;
  bindMoveGroupToggles(area);
}

function previewMove() {
  const area = $('#moveResultArea');
  const allEntries = Object.entries(appState.classifications).filter(([p, c]) => c.category && c.category.length > 0);
  const anchoredSkipped = allEntries.filter(([p]) => isAnchoredFile(p)).length;
  const movable = allEntries.filter(([p]) => !isAnchoredFile(p));

  if (movable.length === 0) {
    area.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div>暂无可移动的文件，请先在"分类与打标签"中设置分类</div>';
    return;
  }

  appState._moveExpandedGroups = new Set();
  const data = {
    entries: movable,
    total: allEntries.length,
    movableCount: movable.length,
    anchoredCount: anchoredSkipped,
  };
  appState._movePreviewData = data;
  renderMovePreview(data);
}

async function executeMove() {
  if (!confirm('确认执行物理移动？此操作将剪切文件到分类文件夹。建议先预览移动计划。')) return;
  const btn = $('#btnExecuteMove');
  btn.disabled = true;
  try {
    const result = await api.executeMove();
    if (result.error) { toast(result.error, 'error'); return; }

    // 构建结果数据
    const allEntries = Object.entries(appState.classifications).filter(([p, c]) => c.category && c.category.length > 0);
    const movable = allEntries.filter(([p]) => !isAnchoredFile(p));
    const transMap = buildTranslationMap();

    const movedMap = {};
    for (const m of result.moved) { movedMap[m.from] = m; }
    const errorMap = {};
    for (const e of result.errors) { errorMap[e.path] = e; }

    const groups = groupMoveEntries(movable, transMap);

    const area = $('#moveResultArea');
    let html = `<div class="move-summary">
      <div class="move-summary-row"><span>已移动</span><span style="color:var(--success)">${result.movedCount}</span></div>
      <div class="move-summary-row"><span>已跳过</span><span style="color:var(--warning)">${result.skipped.length}</span></div>
      ${result.errors.length > 0 ? `<div class="move-summary-row"><span>失败</span><span style="color:var(--danger)">${result.errors.length}</span></div>` : ''}
    </div>`;

    for (const key of Object.keys(groups)) {
      html += renderMoveGroup(key, groups[key], { isResult: true, movedMap, errorMap });
    }

    area.innerHTML = html;
    bindMoveGroupToggles(area);

    toast(`移动完成：${result.movedCount} 个文件`, 'success');
    markStepDone('move');
    // 重新扫描以更新状态
    await runDeepScan();
  } catch (e) {
    toast('移动失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ============ 图片预览 ============
function bindImagePreview() {
  $('#imgPrev').addEventListener('click', () => navImage(-1));
  $('#imgNext').addEventListener('click', () => navImage(1));
  $('#imgZoomIn').addEventListener('click', () => zoomImage(0.2));
  $('#imgZoomOut').addEventListener('click', () => zoomImage(-0.2));
  $('#imgZoomReset').addEventListener('click', () => { appState.previewZoom = 1; applyZoom(); });
}

async function openImagePreview(folderPath, title) {
  const result = await api.getImages(folderPath);
  appState.previewImages = result.images || [];
  appState.previewIndex = 0;
  appState.previewZoom = 1;
  $('#imageModalTitle').textContent = title || '图片预览';
  if (appState.previewImages.length === 0) {
    $('#imageContainer').innerHTML = '<div class="empty-state"><div class="empty-icon">🖼</div>暂无预览图</div>';
    $('#imgIndex').textContent = '';
  } else {
    showImage();
  }
  $('#imageModal').classList.remove('hidden');
}

function showImage() {
  const img = appState.previewImages[appState.previewIndex];
  $('#imageContainer').innerHTML = `<img id="modalImage" class="modal-image" src="${img.dataUrl}" alt="${esc(img.name)}">`;
  $('#imgIndex').textContent = `${appState.previewIndex + 1} / ${appState.previewImages.length} — ${img.name}`;
  applyZoom();
}

function navImage(dir) {
  if (appState.previewImages.length === 0) return;
  appState.previewIndex = (appState.previewIndex + dir + appState.previewImages.length) % appState.previewImages.length;
  appState.previewZoom = 1;
  showImage();
}

function zoomImage(delta) {
  appState.previewZoom = Math.max(0.2, Math.min(5, appState.previewZoom + delta));
  applyZoom();
}

function applyZoom() {
  const img = $('#modalImage');
  if (img) img.style.transform = `scale(${appState.previewZoom})`;
}

// ============ 一键定位 ============
function bindLocateButtons(container) {
  container.querySelectorAll('[data-locate]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const p = btn.dataset.locate;
      const result = await api.locateFile(p);
      if (result.error) toast(result.error, 'error');
    });
  });
}

// ============ 启动 ============
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await init();
  } catch (e) {
    console.error('[renderer.js] init() 失败:', e.message, e.stack);
  }
  // 事件绑定不依赖 init 成功，确保按钮始终可用
  try {
    bindScanPage();
    bindAnchorPage();
    bindDuplicatePage();
    bindConflictPage();
    bindTranslationPage();
    bindClassifyPage();
    bindMovePage();
    bindImagePreview();
    bindSettingsPage();
  } catch (e) {
    console.error('[renderer.js] 事件绑定失败:', e.message, e.stack);
  }
});
