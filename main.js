const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const crypto = require('crypto');
const https = require('https');
const { exec } = require('child_process');

const DATA_FILE = path.join(app.getPath('userData'), 'sims4ycc-state.json');
const OPER_LOG = path.join(__dirname, 'operations.log');

// ============ 跨平台工具函数 ============
/**
 * 路径归一化：统一为正斜杠，用于字符串比较/匹配（磁盘操作仍用 path.join/path.sep）
 */
function normalizePath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/');
}
/**
 * 跨平台判断 filePath 是否锚定：同时比较 path.sep 和归一化后的正斜杠
 */
function isFileAnchored(filePath) {
  const fp = normalizePath(filePath);
  return state.anchored.some(a => {
    const na = normalizePath(a);
    return fp === na || fp.startsWith(na + '/');
  });
}

// ============ 操作日志 ============
function opLog(action, detail) {
  try {
    const line = `[${new Date().toISOString()}] [${action}] ${detail || ''}\n`;
    fs.appendFileSync(OPER_LOG, line, 'utf-8');
  } catch (e) {}
}

// ============ 状态持久化 ============
let state = {
  modsFolder: '',
  scanResults: null,        // 深度扫描结果
  anchored: [],             // 已锚定文件夹路径列表
  keepList: [],             // 重复文件手动保留列表
  whitelist: [],            // 冲突白名单
  classifications: {},      // { [modPath]: { category, tags } }
  tags: [],                 // 所有标签
  categories: defaultCategories(),
  damagedFiles: [],         // 损坏检测结果: [{path, reason, detail, level}]
  strictMode: false,        // 完整性检测严格模式（默认关闭，使用综合实用型检测）
  translationConfig: {      // 翻译服务配置
    service: 'libretranslate',        // 服务商：libretranslate | deepseek | custom
    apiUrl: 'https://libretranslate.com/translate', // API 地址
    apiKey: '',                       // API Key（部分服务商需要）
    model: '',                        // 模型名称（DeepSeek/OpenAI 需要，如 deepseek-chat）
    targetLang: 'zh',                 // 目标语言
    enabled: true,                    // 是否启用翻译
  },
};

function defaultCategories() {
  return [
    { name: 'Default Replacements', children: [
      { name: '替换类模组', children: [] },
    ]},
    { name: 'Clothing & Accessories', children: [
      { name: '服饰类模组', children: [] },
    ]},
    { name: 'Furniture', children: [
      { name: '家具类模组', children: [] },
    ]},
    { name: 'Build Mode Items', children: [
      { name: '建筑类模组', children: [] },
    ]},
    { name: 'CAS Custom Content', children: [
      { name: '人物美化类模组', children: [] },
    ]},
    { name: 'Lots & Houses', children: [
      { name: '地段与房屋类', children: [] },
    ]},
    { name: 'UI & Visual Tweaks', children: [
      { name: '界面与视觉类', children: [] },
    ]},
    { name: '未识别', children: [] },
  ];
}

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const saved = JSON.parse(raw);
      state = { ...state, ...saved };
      if (!state.categories || state.categories.length === 0) {
        state.categories = defaultCategories();
      }
    }
  } catch (e) {
    console.error('加载状态失败:', e);
  }
}

function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.error('保存状态失败:', e);
  }
}

// ============ 窗口创建 ============
let mainWindow;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Sims4YCC MOD 管理工具',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  loadState();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ============ 工具函数 ============
async function walkDir(dir, onFile, onDir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (onDir) onDir(full);
      await walkDir(full, onFile, onDir);
    } else if (entry.isFile()) {
      if (onFile) onFile(full);
    }
  }
}

function md5File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function isImageFile(name) {
  return /\.(png|jpg|jpeg)$/i.test(name);
}

function isPackageFile(name) {
  return /\.package$/i.test(name);
}

function isTs4Script(name) {
  return /\.ts4script$/i.test(name);
}

// 检查文件夹是否包含 .ts4script
async function folderContainsTs4Script(dir) {
  let found = false;
  await walkDir(dir, (file) => {
    if (isTs4Script(path.basename(file))) found = true;
  });
  return found;
}

// ============ DBPF .package 解析器 ============
// 用于提取资源 TGI 键以检测冲突
function parsePackage(buffer) {
  if (buffer.length < 100) return null;
  if (buffer.toString('ascii', 0, 4) !== 'DBPF') return null;

  const entryCount = buffer.readUInt32LE(0x34);
  const indexSize = buffer.readUInt32LE(0x3C);
  if (entryCount === 0 || indexSize === 0) return { entries: [] };

  const entrySize = Math.floor(indexSize / entryCount);
  if (entrySize < 16 || entrySize > 64) return { entries: [] };

  // 尝试多个候选索引位置
  const candidates = [96];
  for (const pos of [0x38, 0x40, 0x4C]) {
    if (pos + 4 <= buffer.length) {
      const v = buffer.readUInt32LE(pos);
      if (v >= 96 && v < buffer.length) candidates.push(v);
    }
  }

  function tryParse(idxOffset) {
    const entries = [];
    let valid = 0;
    for (let i = 0; i < entryCount; i++) {
      const base = idxOffset + i * entrySize;
      if (base + entrySize > buffer.length) break;
      let type, group, instance, dataOffset;
      if (entrySize >= 32) {
        // 64 位 instance: type(4)+group(4)+instHi(4)+instLo(4)+offset(4)+memsize(4)+compsize(4)
        type = buffer.readUInt32LE(base);
        group = buffer.readUInt32LE(base + 4);
        const instHi = buffer.readUInt32LE(base + 8);
        const instLo = buffer.readUInt32LE(base + 12);
        instance = instHi.toString(16).padStart(8, '0') + instLo.toString(16).padStart(8, '0');
        dataOffset = buffer.readUInt32LE(base + 16);
      } else if (entrySize >= 24) {
        // 32 位 instance: type(4)+group(4)+instance(4)+offset(4)+memsize(4)+compsize(4)
        type = buffer.readUInt32LE(base);
        group = buffer.readUInt32LE(base + 4);
        instance = buffer.readUInt32LE(base + 8).toString(16).padStart(8, '0');
        dataOffset = buffer.readUInt32LE(base + 12);
      } else if (entrySize >= 16) {
        type = buffer.readUInt32LE(base);
        group = buffer.readUInt32LE(base + 4);
        instance = buffer.readUInt32LE(base + 8).toString(16).padStart(8, '0');
        dataOffset = entrySize >= 20 ? buffer.readUInt32LE(base + 12) : 0;
      } else {
        break;
      }
      // 校验偏移合理性
      if (dataOffset > 0 && dataOffset < buffer.length) valid++;
      entries.push({ type: type.toString(16), group: group.toString(16), instance, offset: dataOffset });
    }
    return { entries, valid };
  }

  let best = { entries: [], valid: 0 };
  for (const c of candidates) {
    try {
      const r = tryParse(c);
      if (r.valid > best.valid) best = r;
    } catch (e) {}
  }
  return best;
}

// STBL 资源类型 0x535AC1AD - 字符串表
const STBL_TYPE = '535ac1ad';
// 读取 STBL 字符串用于翻译识别
function readSTBL(buffer, entry) {
  try {
    const start = entry.offset;
    if (start + 8 > buffer.length) return [];
    // STBL 格式: count(uint32) + [key(uint32)+len(uint16)+utf16le字符串]...
    // 尝试两种起始位置：直接在 offset，或跳过 4 字节头
    let count = buffer.readUInt32LE(start);
    let dataStart = start + 4;
    if (count > 100000 || count === 0) {
      // 尝试跳过 4 字节前缀
      count = buffer.readUInt32LE(start + 4);
      dataStart = start + 8;
    }
    if (count === 0 || count > 100000) return [];
    const strings = [];
    let p = dataStart;
    for (let i = 0; i < count && p + 6 < buffer.length; i++) {
      const strLen = buffer.readUInt16LE(p + 4);
      p += 6;
      if (strLen === 0 || p + strLen * 2 > buffer.length) { p += strLen * 2; continue; }
      let str = buffer.toString('utf16le', p, p + strLen * 2);
      str = str.replace(/\u0000+$/g, '');
      if (str.length > 0) strings.push(str);
      p += strLen * 2;
    }
    return strings.slice(0, 10); // 只取前10条避免过多
  } catch (e) {
    return [];
  }
}

// 语言检测
function detectLanguage(text) {
  if (!text) return '未知';
  if (/[\u4e00-\u9fff]/.test(text)) return '中文';
  if (/[\u3040-\u30ff]/.test(text)) return '日语';
  if (/[\uac00-\ud7af]/.test(text)) return '韩语';
  if (/[\u0400-\u04ff]/.test(text)) return '俄语';
  return '英文';
}

// ============ 作者信息提取（从文件名、文件夹名、路径中） ============
function extractAuthor(filePath) {
  const fileName = path.basename(filePath);
  const dirName = path.basename(path.dirname(filePath));
  const sources = [fileName, dirName];
  for (const src of sources) {
    // 1. 方括号作者 [作者]
    let m = src.match(/\[([^\]]{1,64})\]/);
    if (m) return m[1];
    // 2. 括号作者 (作者)
    m = src.match(/\(([^\)]{1,64})\)/);
    if (m) return m[1];
    // 3. by 作者 - by xxx / by_xxx
    m = src.match(/\s?by[\s_\-]{1,3}([A-Za-z0-9_\u4e00-\u9fff]{2,64})/);
    if (m) return m[1];
    // 4. 以 _ 分隔的典型作者名前缀(大写字母开头，后跟2-32字符)
    m = src.match(/^([A-Z][A-Za-z0-9]{1,31})[\s_-]/);
    if (m && ['The', 'Sim', 'Mod', 'Pack', 'Sims', 'CC', 'Default', 'My'].indexOf(m[1]) < 0) {
      return m[1];
    }
  }
  return '未知';
}

// ============ 自动分类（按文件名关键词，优先级从高到低） ============
const AUTO_CLASSIFY_RULES = [
  {
    keywords: ['default', 'replace', 'override', 'map', 'world', 'teeth', 'skin', 'eyes',
               'loading', 'eyebrow', 'eyelash', 'body', 'feet', 'background', 'music', 'sound', 'cas'],
    category: ['Default Replacements', '替换类模组'],
  },
  {
    keywords: ['makeup', 'hairstyle', 'eyebrow', 'facial', 'eye color', 'eye-color', 'tattoo', 'face detail', 'nail polish',
               'lipstick', 'blush', 'foundation', 'mascara', 'contour'],
    category: ['CAS Custom Content', '人物美化类模组'],
  },
  {
    keywords: ['hair', 'clothing', 'outfit', 'dress', 'top', 'bottom', 'accessories', 'hat',
               'jewelry', 'glasses', 'mask', 'shoes', 'socks', 'nails'],
    category: ['Clothing & Accessories', '服饰类模组'],
  },
  {
    keywords: ['furniture', 'living', 'bedroom', 'kitchen', 'dining', 'bathroom', 'office',
               'nursery', 'outdoor', 'lighting', 'decor', 'storage', 'electronics',
               'plumbing', 'curtains', 'sofa', 'bed', 'table', 'chair', 'shelf'],
    category: ['Furniture', '家具类模组'],
  },
  {
    keywords: ['wall', 'floor', 'roof', 'door', 'window', 'stairs', 'fence', 'column',
               'foundation', 'fountain', 'terrain', 'paint', 'siding'],
    category: ['Build Mode Items', '建筑类模组'],
  },
  {
    keywords: ['residential', 'commercial', 'lot', 'house', 'vacation', 'room', 'home',
               'apartment', 'venue', 'restaurant', 'cafe', 'bar'],
    category: ['Lots & Houses', '地段与房屋类'],
  },
  {
    keywords: ['font', 'cursor', 'ui', 'panel', 'icon', 'tooltip', 'loading screen',
               'loading_screen', 'hud', 'menu', 'interface', 'theme', 'color filter'],
    category: ['UI & Visual Tweaks', '界面与视觉类'],
  },
];

function autoClassifyFile(fileEntry) {
  const haystack = (fileEntry.name + ' ' + (fileEntry.relPath || '')).toLowerCase();
  for (const rule of AUTO_CLASSIFY_RULES) {
    for (const kw of rule.keywords) {
      if (haystack.includes(kw.toLowerCase())) {
        return rule.category;
      }
    }
  }
  return ['未识别'];
}

// ============ 完整性/损坏检测 ============
// 标准 Sims4 资源类型（综合实用型检测：只要包含至少一个即视为正常）
const VALID_RESOURCE_TYPES = new Set([
  '535ac1ad', // STBL 字符串表
  '74943a35', // TGI: Catalog Resource
  '02dc343f', // CASP CAS Part
  'eb7f990b', // CAS Part (旧)
  '03b33dd0', // DST Image (DDS)
  '3453cf99', // RLE2 Image
  '00b2d882', // _IMG 图像资源
  '6373436b', // Thumbnail
  '8c3ce7e4', // Thumbnail
  '319e4f1d', // XML
  '89f0d4d0', // Layout
  'c7c57333', // Model
  'db21f3c1', // Mesh
  '01512a98', // GEO Geometry
  '016a1aec', // RIG
  '0130e8a4', // MLOD
  '016c60af', // MODL
  '01d0e75d', // S4RIG
  '2c1f1dd7', // Object Definition
  'b98baf16', // Object Catalog
  '0d3390c0', // Object Override
  '77f4f1f1', // Sim Data
  '545ac67a', // Snippet Tuning
  'c2f2adb3', // Compositor Shader
]);

// 综合实用型检测（默认）—— 减少误报，符合实际使用场景
// 返回 { damaged: bool, level: 'critical'|'warning'|'nonstandard'|'normal', reason, detail }
function detectDamagedPackage(fileEntry, buf, strictMode) {
  try {
    if (strictMode) {
      return detectDamagedPackageStrict(fileEntry, buf);
    }
    return detectDamagedPackageRelaxed(fileEntry, buf);
  } catch (e) {
    return { damaged: true, level: 'critical', reason: '解析异常', detail: e.message.slice(0, 200) };
  }
}

// 严格模式：恢复原始检测逻辑（高级用户）
function detectDamagedPackageStrict(fileEntry, buf) {
  if (fileEntry.size < 100) {
    return { damaged: true, level: 'critical', reason: '文件过小', detail: `文件大小仅 ${fileEntry.size} 字节，疑似损坏或未下载完成` };
  }
  if (buf.toString('ascii', 0, 4) !== 'DBPF') {
    return { damaged: true, level: 'critical', reason: 'DBPF 签名缺失', detail: '文件头不是标准 Sims4 DBPF 签名，疑似损坏或非 .package 文件' };
  }
  const parsed = parsePackage(buf);
  if (!parsed) {
    return { damaged: true, level: 'critical', reason: '无法解析 DBPF 索引', detail: '索引段读取失败，内部结构异常' };
  }
  if (parsed.entries.length === 0) {
    return { damaged: true, level: 'critical', reason: '索引为空', detail: '文件内部没有任何资源条目，文件可能不完整' };
  }
  let validType = 0;
  let badOffset = 0;
  for (const e of parsed.entries) {
    if (VALID_RESOURCE_TYPES.has(e.type)) validType++;
    if (e.offset > buf.length || e.offset < 96) badOffset++;
  }
  if (parsed.valid < parsed.entries.length * 0.3 && parsed.entries.length > 5) {
    return { damaged: true, level: 'critical', reason: '索引偏移异常率高', detail: `${parsed.entries.length} 条资源中仅 ${parsed.valid} 条偏移合理` };
  }
  return { damaged: false, level: 'normal' };
}

// 综合实用型检测（默认）
function detectDamagedPackageRelaxed(fileEntry, buf) {
  // 规则2：文件大小检测
  if (fileEntry.size === 0) {
    return { damaged: true, level: 'critical', reason: '空文件', detail: '文件大小为 0 字节，建议删除' };
  }
  if (fileEntry.size < 100) {
    return { damaged: true, level: 'warning', reason: '异常小文件', detail: `文件大小仅 ${fileEntry.size} 字节，请检查是否下载完整` };
  }

  // 规则1：文件头检测（必须通过）
  const headerOK = buf.length >= 4 && buf.toString('ascii', 0, 4) === 'DBPF';
  if (!headerOK) {
    const reason = buf.length < 4 ? '文件头无法读取' : 'DBPF 签名缺失';
    return { damaged: true, level: 'critical', reason: '严重损坏 · ' + reason, detail: '文件头不包含标准 Sims4 DBPF 签名，建议立即删除' };
  }

  // 规则3 & 4：资源索引检测（放宽标准）
  const parsed = parsePackage(buf);

  if (parsed && parsed.entries && parsed.entries.length > 0) {
    let hasValidResource = false;
    let allZeroType = true;
    for (const e of parsed.entries) {
      if (VALID_RESOURCE_TYPES.has(e.type)) {
        hasValidResource = true;
      }
      // 规则4：只检测明显无效的 Type ID（0x00000000）
      if (e.type !== '00000000') {
        allZeroType = false;
      }
    }

    // 包含至少一个合法资源 → 正常文件
    if (hasValidResource) {
      return { damaged: false, level: 'normal' };
    }

    // 所有 Type ID 均为 0x00000000 → 资源完全无法解析
    if (allZeroType) {
      return { damaged: true, level: 'critical', reason: '资源完全无法解析', detail: '所有资源 Type ID 均为 0x00000000，文件内部结构严重异常' };
    }

    // 不包含标准资源类型，但文件头完整且 > 1KB → 非标准资源（不标红）
    if (fileEntry.size > 1024) {
      return { damaged: false, level: 'nonstandard', reason: '非标准资源', detail: '未发现标准 Sims4 资源类型，可能为作者自定义格式（文件头完整且大小正常）' };
    }

    // 小文件且无可识别资源 → 警告
    return { damaged: true, level: 'warning', reason: '无可识别资源', detail: `文件大小 ${fileEntry.size} 字节，未包含任何标准资源类型，建议检查` };
  }

  // parsed 为 null（无法解析索引）
  // 规则3：文件头完整且 > 1KB → 非标准资源
  if (fileEntry.size > 1024) {
    return { damaged: false, level: 'nonstandard', reason: '非标准资源', detail: '无法解析资源索引，但文件头完整且大小正常，可能为自定义格式' };
  }

  // 规则5：资源完全无法解析 + 文件较小 → 可能损坏
  return { damaged: true, level: 'critical', reason: '资源完全无法解析', detail: '无法解析 DBPF 索引，且文件较小，疑似损坏' };
}

// ============ IPC: 文件夹选择 ============
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择 Sims 4 Mods 文件夹',
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  state.modsFolder = result.filePaths[0];
  saveState();
  return { canceled: false, path: state.modsFolder };
});

ipcMain.handle('get-state', async () => {
  return { ...state };
});

ipcMain.handle('set-strict-mode', async (event, enabled) => {
  state.strictMode = !!enabled;
  saveState();
  return { ok: true, strictMode: state.strictMode };
});

// ============ IPC: 深度扫描 ============
ipcMain.handle('deep-scan', async (event, opts) => {
  if (!state.modsFolder) return { error: '未设置 Mods 文件夹' };
  const integrityCheck = !!(opts && opts.integrityCheck);
  const root = state.modsFolder;
  const allFiles = [];
  const ts4scriptFolders = new Set();
  const rootFirstLevelFolders = [];
  const folderImages = {}; // folder -> [image paths]
  state.damagedFiles = [];
  let scanProgress = { phase: 'collect', current: 0, total: 0, integrityCurrent: 0, integrityTotal: 0, message: '正在收集文件列表...' };

  function pushProgress(msg) {
    if (msg) scanProgress.message = msg;
    try {
      mainWindow && mainWindow.webContents.send('scan-progress', { ...scanProgress });
    } catch (e) {}
  }

  // 获取根目录第一层文件夹
  let rootEntries;
  try {
    rootEntries = await fsp.readdir(root, { withFileTypes: true });
  } catch (e) {
    return { error: '无法读取 Mods 文件夹: ' + e.message };
  }
  for (const e of rootEntries) {
    if (e.isDirectory()) {
      rootFirstLevelFolders.push(path.join(root, e.name));
    }
  }

  pushProgress('正在递归扫描文件...');
  // 递归扫描所有文件
  await walkDir(root, async (file) => {
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat) return;
    const ext = path.extname(file).toLowerCase();
    const entry = {
      path: file,
      relPath: path.relative(root, file),
      name: path.basename(file),
      ext,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      author: extractAuthor(file),
    };
    allFiles.push(entry);
    scanProgress.current = allFiles.length;

    if (isTs4Script(file)) {
      // 找到 .ts4script 所属的根级文件夹
      const rel = path.relative(root, file);
      const topFolder = rel.split(path.sep)[0];
      if (topFolder && !topFolder.includes('.')) {
        ts4scriptFolders.add(path.join(root, topFolder));
      }
    }

    if (isImageFile(file)) {
      const dir = path.dirname(file);
      if (!folderImages[dir]) folderImages[dir] = [];
      folderImages[dir].push(file);
    }
  });
  scanProgress.total = allFiles.length;

  // 自动锚定含 .ts4script 的文件夹（如果尚未锚定）
  for (const f of ts4scriptFolders) {
    if (!state.anchored.includes(f)) {
      state.anchored.push(f);
    }
  }

  // 自动分类（为每个 .package 文件写入 classifications，不覆盖用户已手动设置的分类）
  for (const f of allFiles) {
    if (f.ext !== '.package' && f.ext !== '.ts4script') continue;
    if (state.classifications[f.path] && state.classifications[f.path].__manual) continue; // 用户手动设置的不覆盖
    if (isFileAnchored(f.path)) continue; // 锚定的不自动分类
    const category = autoClassifyFile(f);
    const existing = state.classifications[f.path] || {};
    state.classifications[f.path] = {
      category,
      tags: existing.tags || [],
      __auto: true,
    };
  }

  // 完整性检测（可选）
  if (integrityCheck) {
    pushProgress('正在执行完整性检测...');
    const pkgFiles = allFiles.filter(f => f.ext === '.package');
    scanProgress.integrityTotal = pkgFiles.length;
    scanProgress.phase = 'integrity';
    const strictMode = !!state.strictMode;
    for (let i = 0; i < pkgFiles.length; i++) {
      const f = pkgFiles[i];
      scanProgress.integrityCurrent = i + 1;
      if (i % 25 === 0 || i === pkgFiles.length - 1) {
        pushProgress(`完整性检测 ${i + 1}/${pkgFiles.length}` + (strictMode ? '（严格模式）' : ''));
      }
      try {
        const buf = fs.readFileSync(f.path);
        const r = detectDamagedPackage(f, buf, strictMode);
        // 始终记录 level 到文件对象
        f.level = r.level || 'normal';
        if (r.damaged) {
          f.damaged = true;
          f.damageReason = r.reason;
          f.damageDetail = r.detail;
          state.damagedFiles.push({
            path: f.path,
            name: f.name,
            size: f.size,
            reason: r.reason,
            detail: r.detail,
            level: r.level || 'critical',
          });
        } else if (r.level === 'nonstandard') {
          // 非标准资源不进入损坏列表，但在文件上标记
          f.nonstandard = true;
          f.damageReason = r.reason;
          f.damageDetail = r.detail;
        }
      } catch (e) {
        f.damaged = true;
        f.level = 'critical';
        f.damageReason = '读取失败';
        f.damageDetail = e.message.slice(0, 200);
        state.damagedFiles.push({
          path: f.path,
          name: f.name,
          size: f.size,
          reason: '读取失败',
          detail: e.message.slice(0, 200),
          level: 'critical',
        });
      }
    }
  }

  pushProgress('扫描完成');

  state.scanResults = {
    root: root,
    files: allFiles,
    ts4scriptFolders: [...ts4scriptFolders],
    rootFirstLevelFolders,
    folderImages,
    scannedAt: new Date().toISOString(),
    integrityEnabled: integrityCheck,
    strictMode: !!state.strictMode,
    damagedFiles: state.damagedFiles,
    autoClassifiedCount: Object.keys(state.classifications).filter(k => state.classifications[k].__auto).length,
    stats: {
      totalFiles: allFiles.length,
      packageFiles: allFiles.filter(f => f.ext === '.package').length,
      ts4scriptFiles: allFiles.filter(f => f.ext === '.ts4script').length,
      imageFiles: allFiles.filter(f => isImageFile(f.name)).length,
      totalFolders: rootFirstLevelFolders.length,
      damagedCount: state.damagedFiles.filter(d => d.level === 'critical').length,
      warningCount: state.damagedFiles.filter(d => d.level === 'warning').length,
      nonstandardCount: allFiles.filter(f => f.nonstandard).length,
    },
  };
  opLog('DEEP_SCAN', `扫描根目录 ${root}，共 ${allFiles.length} 个文件，严重损坏 ${state.scanResults.stats.damagedCount} 个，警告 ${state.scanResults.stats.warningCount} 个，非标准 ${state.scanResults.stats.nonstandardCount} 个，自动分类 ${state.scanResults.autoClassifiedCount} 个`);
  saveState();
  return state.scanResults;
});

// ============ IPC: 锚定保护 ============
ipcMain.handle('get-anchors', async () => {
  return state.anchored;
});

ipcMain.handle('add-anchor', async (event, paths) => {
  for (const p of paths) {
    if (!state.anchored.includes(p)) state.anchored.push(p);
  }
  saveState();
  return { ok: true, anchored: state.anchored };
});

ipcMain.handle('remove-anchor', async (event, p) => {
  state.anchored = state.anchored.filter(a => a !== p);
  saveState();
  return { ok: true, anchored: state.anchored };
});

ipcMain.handle('get-root-folders', async () => {
  if (!state.modsFolder) return { error: '未设置 Mods 文件夹' };
  const result = [];
  let entries;
  try {
    entries = await fsp.readdir(state.modsFolder, { withFileTypes: true });
  } catch (e) {
    return { error: e.message };
  }
  for (const e of entries) {
    const full = path.join(state.modsFolder, e.name);
    result.push({
      name: e.name,
      path: full,
      isDirectory: e.isDirectory(),
      anchored: state.anchored.includes(full),
    });
  }
  return { folders: result };
});

// ============ IPC: 重复排查 ============
ipcMain.handle('scan-duplicates', async () => {
  if (!state.scanResults) return { error: '请先执行深度扫描' };
  const files = state.scanResults.files.filter(f => f.ext === '.package');
  const byHash = {};
  for (const f of files) {
    try {
      const hash = await md5File(f.path);
      if (!byHash[hash]) byHash[hash] = [];
      byHash[hash].push(f);
    } catch (e) {}
  }
  const groups = [];
  for (const [hash, fileList] of Object.entries(byHash)) {
    if (fileList.length > 1) {
      groups.push({
        hash,
        files: fileList.map(f => ({
          ...f,
          kept: state.keepList.includes(f.path),
          anchored: isFileAnchored(f.path),
        })),
      });
    }
  }
  return { groups, totalDuplicates: groups.reduce((s, g) => s + g.files.length - 1, 0) };
});

// 旧版本 isFileAnchored（硬编码 path.sep，macOS 下 Windows 保存的锚定会失效）
// 已在顶部用 normalizePath 版本替换，保留此处占位避免重复声明（删除即可）


ipcMain.handle('mark-keep', async (event, paths) => {
  for (const p of paths) {
    if (!state.keepList.includes(p)) state.keepList.push(p);
  }
  saveState();
  return { ok: true, keepList: state.keepList };
});

ipcMain.handle('unmark-keep', async (event, paths) => {
  state.keepList = state.keepList.filter(p => !paths.includes(p));
  saveState();
  return { ok: true, keepList: state.keepList };
});

// 功能A：一键清理（保留最新下载日期，删除较旧版本）
ipcMain.handle('clean-duplicates', async () => {
  if (!state.scanResults) return { error: '请先执行深度扫描' };
  const files = state.scanResults.files.filter(f => f.ext === '.package');
  const byHash = {};
  for (const f of files) {
    try {
      const hash = await md5File(f.path);
      if (!byHash[hash]) byHash[hash] = [];
      byHash[hash].push(f);
    } catch (e) {}
  }

  const deleted = [];
  const kept = [];
  const errors = [];

  for (const [hash, fileList] of Object.entries(byHash)) {
    if (fileList.length <= 1) continue;
    // 排序：锚定优先 > 保留标记 > 最新下载日期
    fileList.sort((a, b) => {
      const aAnchored = isFileAnchored(a.path);
      const bAnchored = isFileAnchored(b.path);
      if (aAnchored && !bAnchored) return -1;
      if (!aAnchored && bAnchored) return 1;
      const aKeep = state.keepList.includes(a.path);
      const bKeep = state.keepList.includes(b.path);
      if (aKeep && !bKeep) return -1;
      if (!aKeep && bKeep) return 1;
      return new Date(b.mtime) - new Date(a.mtime);
    });
    // 保留第一个，删除其余
    kept.push(fileList[0]);
    for (let i = 1; i < fileList.length; i++) {
      try {
        await fsp.unlink(fileList[i].path);
        deleted.push(fileList[i].path);
      } catch (e) {
        errors.push({ path: fileList[i].path, error: e.message });
      }
    }
  }
  saveState();
  return { deleted, kept, errors, deletedCount: deleted.length };
});

// 冲突类型 → 影响分析
function getConflictImpact(conflictType, resourceType) {
  if (conflictType === 'name') {
    return {
      typeName: '同名文件冲突',
      impact: '可能导致加载顺序不确定，实际生效的版本不确定',
      severity: 'low',
      suggestion: '保留最新或作者明确的版本',
    };
  }
  if (resourceType === STBL_TYPE) {
    return {
      typeName: '字符串表资源覆盖',
      impact: '翻译文本/UI 描述异常，提示语被覆盖可能导致显示乱码或空白',
      severity: 'low',
      suggestion: '优先保留你使用的语言版本',
    };
  }
  const rt = (resourceType || '').toLowerCase();
  if (rt === 'eb7f990b') {
    return {
      typeName: 'CAS Part 覆盖',
      impact: '人物自定义项显示异常，服装/发型不显示或被替换为其他',
      severity: 'medium',
      suggestion: '保留同一部位的单一版本，或用工具合并',
    };
  }
  if (rt === '03b33dd0' || rt === '3453cf99') {
    return {
      typeName: '图片/纹理资源覆盖',
      impact: '贴图颜色失真或空白，预览图异常',
      severity: 'low',
      suggestion: '保留分辨率或作者更高的版本',
    };
  }
  if (rt === '2c1f1dd7' || rt === 'b98baf16') {
    return {
      typeName: '物品定义/目录覆盖',
      impact: '家具/建筑物品在建造模式中不可见或属性被改',
      severity: 'medium',
      suggestion: '保留最新或功能性更强的版本',
    };
  }
  if (rt === 'c7c57333' || rt === 'db21f3c1') {
    return {
      typeName: '模型/网格覆盖',
      impact: '3D 模型错乱、贴图对位偏移、视觉异常',
      severity: 'medium',
      suggestion: '保留同作者版本或合并',
    };
  }
  if (rt === '74943a35') {
    return {
      typeName: '目录/目录资源覆盖',
      impact: '预览缩略图异常或信息丢失',
      severity: 'low',
      suggestion: '保留数据更完整的版本',
    };
  }
  return {
    typeName: '资源覆盖 (TGI)',
    impact: '同一资源被多次定义，游戏只加载其一，会导致另一部分内容缺失',
    severity: 'medium',
    suggestion: '保留功能更重要、更可信作者的版本',
  };
}

// ============ IPC: 冲突检测 ============
ipcMain.handle('scan-conflicts', async () => {
  if (!state.scanResults) return { error: '请先执行深度扫描' };
  const files = state.scanResults.files.filter(f => f.ext === '.package');

  // 作者提取缓存
  const authorCache = {};
  function getAuthor(filePath) {
    if (!authorCache[filePath]) {
      // 优先复用扫描结果中的 author
      const fileEntry = state.scanResults.files.find(f => f.path === filePath);
      authorCache[filePath] = fileEntry && fileEntry.author ? fileEntry.author : extractAuthor(filePath);
    }
    return authorCache[filePath];
  }

  // 提取每个 package 的 TGI 键
  const fileTGI = {}; // file -> Set of "type:group:instance"
  const ts4scriptPaths = new Set();
  // 识别含 .ts4script 的文件夹（用于脚本重写检测）
  for (const p of (state.scanResults.ts4scriptFolders || [])) {
    ts4scriptPaths.add(p.toLowerCase().replace(/\\/g, '/'));
  }

  for (const f of files) {
    try {
      const buf = fs.readFileSync(f.path);
      const parsed = parsePackage(buf);
      if (parsed && parsed.entries.length > 0) {
        const keys = new Set();
        for (const e of parsed.entries) {
          keys.add(`${e.type}:${e.group}:${e.instance}`);
        }
        fileTGI[f.path] = keys;
      }
    } catch (e) {}
  }

  // 按资源键分组，找出冲突
  const keyToFiles = {};
  const keyToResourceType = {};
  for (const [filePath, keys] of Object.entries(fileTGI)) {
    for (const k of keys) {
      if (!keyToFiles[k]) keyToFiles[k] = [];
      keyToFiles[k].push(filePath);
      keyToResourceType[k] = k.split(':')[0];
    }
  }

  // 同名文件冲突（不同位置的相同文件名）
  const byName = {};
  for (const f of files) {
    const name = f.name.toLowerCase();
    if (!byName[name]) byName[name] = [];
    byName[name].push(f.path);
  }

  const conflicts = [];
  let conflictId = 0;

  // TGI 资源冲突
  for (const [key, fileList] of Object.entries(keyToFiles)) {
    if (fileList.length > 1) {
      const conflictKey = `tgi:${key}`;
      if (state.whitelist.includes(conflictKey)) continue;
      const [type, group, instance] = key.split(':');
      const anchoredCount = fileList.filter(isFileAnchored).length;

      const authors = fileList.map(getAuthor).filter(a => a !== '未知');
      const uniqueAuthors = [...new Set(authors)];
      const sameAuthor = uniqueAuthors.length === 1 && authors.length === fileList.length;

      // 含 .ts4script 文件夹内的参与方
      const ts4scriptConflicting = fileList.some(p => {
        const pn = p.replace(/\\/g, '/').toLowerCase();
        for (const tp of ts4scriptPaths) { if (pn.startsWith(tp + '/')) return true; }
        return false;
      });
      const impactInfo = getConflictImpact('tgi', type);
      let conflictType = impactInfo.typeName;
      if (ts4scriptConflicting) conflictType = '脚本模组资源覆盖 / 功能冲突';

      const mtimes = fileList.map(p => {
        const fe = state.scanResults.files.find(f => f.path === p);
        return fe ? fe.mtime : '';
      });
      let suggestion = impactInfo.suggestion;
      if (sameAuthor) {
        suggestion = '作者相同，可能为版本更迭，建议保留最新版本';
      }

      const conflictPairDescription = fileList.slice(0, 2).map(p => `${path.basename(p)}（作者：${getAuthor(p)}）`).join(' 与 ');

      conflicts.push({
        id: conflictId++,
        key: conflictKey,
        type: 'tgi',
        resourceType: type,
        resourceGroup: group,
        instance,
        conflictType,
        conflictSeverity: impactInfo.severity,
        impact: impactInfo.impact,
        suggestion,
        sameAuthor,
        commonAuthor: sameAuthor ? uniqueAuthors[0] : null,
        conflictPair: conflictPairDescription,
        files: fileList.map(p => ({
          path: p,
          name: path.basename(p),
          author: getAuthor(p),
          mtime: mtimes[fileList.indexOf(p)],
          anchored: isFileAnchored(p),
        })),
        detail: `${conflictPairDescription} 产生资源类型 ${type.toUpperCase()} 的 ${conflictType}`,
        hasAnchored: anchoredCount > 0,
      });
    }
  }

  // 同名文件冲突
  for (const [name, fileList] of Object.entries(byName)) {
    if (fileList.length > 1) {
      const conflictKey = `name:${name}`;
      if (state.whitelist.includes(conflictKey)) continue;
      const authors = fileList.map(getAuthor).filter(a => a !== '未知');
      const uniqueAuthors = [...new Set(authors)];
      const sameAuthor = uniqueAuthors.length === 1 && authors.length === fileList.length;

      const ts4scriptConflicting = fileList.some(p => {
        const pn = p.replace(/\\/g, '/').toLowerCase();
        for (const tp of ts4scriptPaths) { if (pn.startsWith(tp + '/')) return true; }
        return false;
      });

      let conflictType = ts4scriptConflicting ? '脚本模组同名覆盖' : '同名文件冲突';
      const impactInfo = getConflictImpact('name', null);
      let suggestion = impactInfo.suggestion;
      if (sameAuthor) suggestion = '作者相同，可能为版本更迭，建议保留最新版本';

      const conflictPairDescription = fileList.slice(0, 2).map(p => `${path.basename(p)}（作者：${getAuthor(p)}）`).join(' 与 ');

      conflicts.push({
        id: conflictId++,
        key: conflictKey,
        type: 'name',
        conflictType,
        conflictSeverity: 'low',
        impact: impactInfo.impact,
        suggestion,
        sameAuthor,
        commonAuthor: sameAuthor ? uniqueAuthors[0] : null,
        conflictPair: conflictPairDescription,
        files: fileList.map(p => ({
          path: p,
          name: path.basename(p),
          author: getAuthor(p),
          anchored: isFileAnchored(p),
        })),
        detail: `${conflictPairDescription} 在不同位置存在同名文件 "${name}"`,
        hasAnchored: fileList.some(isFileAnchored),
      });
    }
  }

  return { conflicts, total: conflicts.length };
});

// ============ IPC: 删除冲突文件（及其所在独立文件夹） ============
ipcMain.handle('delete-conflict-file', async (event, filePath) => {
  if (!filePath) return { error: '路径为空' };
  if (isFileAnchored(filePath)) return { error: '已锚定的文件不可删除，请先解除锚定' };
  try {
    const info = await fsp.stat(filePath).catch(() => null);
    if (!info) return { error: '文件不存在或已被删除' };
    if (!info.isFile()) return { error: '目标不是文件' };

    // 检查是否在独立文件夹（除了该文件或其他关联文件外，是否没有其他 package/ts4script）
    const parentDir = path.dirname(filePath);
    const modRoot = state.scanResults && state.scanResults.root ? state.scanResults.root : null;
    const isIndependentFolder = () => {
      if (modRoot && parentDir === modRoot) return false; // 如果就是根目录下，不删文件夹
      try {
        const sibs = fs.readdirSync(parentDir);
        if (sibs.length === 0) return true;
        // 如果全是同一 mod 相关（同包前缀的辅助文件），判定可删文件夹
        const basePrefix = path.basename(filePath, path.extname(filePath)).toLowerCase().replace(/[_-]?[v\d.]+$/, '');
        let allRelated = true;
        let hasOtherPackage = false;
        for (const s of sibs) {
          const ext = path.extname(s).toLowerCase();
          if (ext === '.package' || ext === '.ts4script') {
            const name = s.toLowerCase().replace(ext, '');
            if (!name.startsWith(basePrefix.slice(0, Math.max(4, basePrefix.length * 0.5)))) {
              hasOtherPackage = true;
            }
          }
        }
        return hasOtherPackage ? false : sibs.length <= 10;
      } catch (e) {
        return false;
      }
    };
    const deleteFolder = isIndependentFolder();
    let deleted = [filePath];
    let deletedFolder = null;
    if (deleteFolder) {
      // 递归删除整个文件夹
      await fsp.rm(parentDir, { recursive: true, force: true });
      deletedFolder = parentDir;
    } else {
      await fsp.unlink(filePath);
    }
    opLog('DELETE_CONFLICT_FILE', `删除冲突文件: ${filePath}${deletedFolder ? ` 及其所在文件夹: ${deletedFolder}` : ''}`);
    // 清理分类/重复标记等本地缓存引用
    delete state.classifications[filePath];
    state.keepList = state.keepList.filter(p => p !== filePath);
    if (state.scanResults) {
      state.scanResults.files = state.scanResults.files.filter(f => f.path !== filePath);
    }
    saveState();
    return { ok: true, deletedFolder, deleted };
  } catch (e) {
    opLog('DELETE_CONFLICT_FILE_ERROR', `失败: ${filePath} - ${e.message}`);
    return { error: e.message };
  }
});

// ============ IPC: 导出损坏检测报告 ============
ipcMain.handle('export-damaged-report', async () => {
  if (!state.scanResults || state.damagedFiles.length === 0) {
    return { error: '没有损坏文件可导出' };
  }
  const savePath = await dialog.showSaveDialog(mainWindow, {
    title: '导出损坏检测报告',
    defaultPath: '完整性检测报告_' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '.txt',
    filters: [{ name: '文本', extensions: ['txt'] }],
  });
  if (savePath.canceled || !savePath.filePath) return { canceled: true };
  const levelText = { critical: '严重损坏（建议删除）', warning: '警告（建议检查）', nonstandard: '非标准资源' };
  let content = 'Sims4YCC 模组完整性检测报告\n';
  content += '生成时间：' + new Date().toLocaleString('zh-CN') + '\n';
  content += 'Mods 目录：' + (state.modsFolder || '') + '\n';
  content += '检测模式：' + (state.strictMode ? '严格模式' : '综合实用型（默认）') + '\n';
  const critCnt = state.damagedFiles.filter(d => d.level === 'critical').length;
  const warnCnt = state.damagedFiles.filter(d => d.level === 'warning').length;
  content += `严重损坏：${critCnt} 个 | 警告：${warnCnt} 个 | 合计：${state.damagedFiles.length} 个\n`;
  content += '='.repeat(60) + '\n\n';
  for (const d of state.damagedFiles) {
    content += '- ' + d.name + '\n';
    content += '  级别: ' + (levelText[d.level] || d.level || '-') + '\n';
    content += '  路径: ' + d.path + '\n';
    content += '  大小: ' + (d.size != null ? fmtSize(d.size) : '-') + '\n';
    content += '  原因: ' + (d.reason || '-') + '\n';
    content += '  详情: ' + (d.detail || '-') + '\n\n';
  }
  try {
    await fsp.writeFile(savePath.filePath, content, 'utf-8');
    opLog('EXPORT_DAMAGE_REPORT', `导出到 ${savePath.filePath}, 共 ${state.damagedFiles.length} 条`);
    return { ok: true, filePath: savePath.filePath, count: state.damagedFiles.length };
  } catch (e) {
    return { error: e.message };
  }
});

// 格式化大小（导出报告时使用）
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

ipcMain.handle('add-whitelist', async (event, keys) => {
  for (const k of keys) {
    if (!state.whitelist.includes(k)) state.whitelist.push(k);
  }
  saveState();
  return { ok: true, whitelist: state.whitelist };
});

ipcMain.handle('remove-whitelist', async (event, key) => {
  state.whitelist = state.whitelist.filter(k => k !== key);
  saveState();
  return { ok: true, whitelist: state.whitelist };
});

ipcMain.handle('get-whitelist', async () => {
  return state.whitelist;
});

// ============ 翻译引擎调用 ============
// 判断是否为 OpenAI 兼容格式（DeepSeek / OpenAI 等）
function isOpenAICompatible(apiUrl) {
  if (!apiUrl) return false;
  const u = apiUrl.toLowerCase();
  return u.includes('deepseek.com') ||
         u.includes('openai.com') ||
         u.includes('/chat/completions');
}

// 根据服务商构造请求体
function buildTranslationRequest(text, config) {
  const apiUrl = config.apiUrl.toLowerCase();
  if (isOpenAICompatible(apiUrl)) {
    // DeepSeek / OpenAI 兼容格式
    const targetLangName = {
      zh: '中文', en: 'English', ja: '日本語', ko: '한국어',
    };
    const langName = targetLangName[config.targetLang] || '中文';
    return JSON.stringify({
      model: config.model || 'deepseek-chat',
      messages: [
        { role: 'system', content: `You are a translator. Translate the user's text to ${langName}. Only output the translation, nothing else.` },
        { role: 'user', content: text },
      ],
      temperature: 0.1,
      max_tokens: 500,
    });
  }
  // LibreTranslate 格式
  return JSON.stringify({
    q: text,
    source: 'auto',
    target: config.targetLang || 'zh',
    format: 'text',
    ...(config.apiKey ? { api_key: config.apiKey } : {}),
  });
}

// 根据服务商构造请求头
function buildTranslationHeaders(config, postData) {
  const apiUrl = config.apiUrl.toLowerCase();
  if (isOpenAICompatible(apiUrl)) {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Length': Buffer.byteLength(postData),
    };
  }
  // LibreTranslate 格式
  return {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData),
  };
}

// 根据服务商解析响应体，提取翻译结果
function parseTranslationResponse(data, config) {
  const apiUrl = config.apiUrl.toLowerCase();
  const json = JSON.parse(data);
  if (isOpenAICompatible(apiUrl)) {
    // DeepSeek / OpenAI: choices[0].message.content
    if (json.choices && json.choices.length > 0 && json.choices[0].message) {
      return json.choices[0].message.content.trim();
    }
    // DeepSeek 错误格式: { error: { message: "..." } }
    if (json.error) {
      const errMsg = typeof json.error === 'string' ? json.error : (json.error.message || JSON.stringify(json.error));
      throw new Error(errMsg);
    }
    return null;
  }
  // LibreTranslate: translatedText
  if (json.translatedText) {
    return json.translatedText;
  }
  if (json.error) {
    const errMsg = typeof json.error === 'string' ? json.error : (json.error.message || JSON.stringify(json.error));
    throw new Error(errMsg);
  }
  return null;
}

function callTranslationAPI(text, config) {
  return new Promise((resolve, reject) => {
    console.log('[callTranslationAPI] 开始, text:', text, 'config.enabled:', config && config.enabled, 'config.apiUrl:', config && config.apiUrl);
    if (!config || !config.apiUrl || !config.enabled) {
      console.log('[callTranslationAPI] 配置不满足条件，返回 null');
      resolve(null);
      return;
    }
    const openAI = isOpenAICompatible(config.apiUrl);
    console.log('[callTranslationAPI] 服务商:', openAI ? 'OpenAI兼容(DeepSeek等)' : 'LibreTranslate');

    // 确保 DeepSeek API 地址以 /chat/completions 结尾
    let finalUrl = config.apiUrl;
    if (openAI && !finalUrl.toLowerCase().endsWith('/chat/completions')) {
      finalUrl = finalUrl.replace(/\/+$/, '') + '/chat/completions';
      console.log('[callTranslationAPI] 自动补全 API 地址为:', finalUrl);
    }

    const postData = buildTranslationRequest(text, config);
    const url = new URL(finalUrl);
    const headers = buildTranslationHeaders(config, postData);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: headers,
      timeout: 15000,
    };
    console.log('[callTranslationAPI] 发送 HTTPS 请求到:', options.hostname, options.path);
    const req = https.request(options, (res) => {
      let data = '';
      console.log('[callTranslationAPI] 响应状态码:', res.statusCode);
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        console.log('[callTranslationAPI] 响应体:', data.slice(0, 500));
        try {
          const translated = parseTranslationResponse(data, config);
          if (translated) {
            console.log('[callTranslationAPI] 翻译结果:', translated);
            resolve(translated);
          } else {
            console.error('[callTranslationAPI] 无法从响应中提取翻译结果');
            resolve(null);
          }
        } catch (e) {
          console.error('[callTranslationAPI] 解析失败:', e.message, '原始响应:', data.slice(0, 500));
          reject(new Error(e.message));
        }
      });
    });
    req.on('error', (e) => {
      console.error('[callTranslationAPI] 请求错误:', e.message);
      reject(e);
    });
    req.on('timeout', () => {
      console.error('[callTranslationAPI] 请求超时');
      req.destroy();
      reject(new Error('翻译请求超时'));
    });
    req.write(postData);
    req.end();
  });
}

// 提取文件名中的可读名称（去掉扩展名和常见前缀/后缀）
function extractReadableName(fileName) {
  let name = fileName.replace(/\.package$/i, '');
  // 去掉 [作者] 前缀
  name = name.replace(/^\[[^\]]*\]\s*/, '');
  // 下划线/连字符替换为空格
  name = name.replace(/[_-]+/g, ' ').trim();
  return name;
}

// ============ IPC: 翻译配置 ============
ipcMain.handle('get-translation-config', async () => {
  return { ...state.translationConfig };
});

ipcMain.handle('set-translation-config', async (event, config) => {
  state.translationConfig = { ...state.translationConfig, ...config };
  saveState();
  return { ok: true, config: state.translationConfig };
});

ipcMain.handle('test-translation', async (event, testText) => {
  console.log('[test-translation] 收到测试请求, testText:', testText);
  const config = state.translationConfig;
  console.log('[test-translation] 当前配置:', JSON.stringify(config));
  if (!config || !config.enabled || !config.apiUrl) {
    console.log('[test-translation] 配置不满足: enabled=', config && config.enabled, 'apiUrl=', config && config.apiUrl);
    return { error: '翻译引擎未启用或 API 地址为空' };
  }
  try {
    const translated = await callTranslationAPI(testText || 'Hello World', config);
    if (translated) {
      console.log('[test-translation] 翻译成功:', translated);
      return { ok: true, translated };
    }
    console.log('[test-translation] 翻译返回空');
    return { error: '未返回翻译结果' };
  } catch (e) {
    console.error('[test-translation] 翻译异常:', e.message);
    return { error: e.message };
  }
});

// ============ IPC: 翻译识别 ============
// opts:
//   selectedPaths: string[] | null  仅翻译指定路径的文件；为 null/空数组时翻译全部
//   skipTranslated: boolean         为 true 时跳过已有 chineseName 的文件（除非 force=true）
//   force: boolean                  为 true 时强制重新翻译（即使已翻译）
ipcMain.handle('scan-translation', async (event, opts) => {
  if (!state.scanResults) return { error: '请先执行深度扫描' };
  opts = opts || {};
  const selectedSet = Array.isArray(opts.selectedPaths) && opts.selectedPaths.length > 0
    ? new Set(opts.selectedPaths)
    : null;
  const skipTranslated = !!opts.skipTranslated;
  const force = !!opts.force;

  const allFiles = state.scanResults.files.filter(f => f.ext === '.package');
  const targetFiles = selectedSet
    ? allFiles.filter(f => selectedSet.has(f.path))
    : allFiles;

  const translations = [];
  const config = state.translationConfig;
  const enableTranslate = config && config.enabled;
  const total = targetFiles.length;
  let skippedCount = 0;
  let processedCount = 0;

  for (let i = 0; i < targetFiles.length; i++) {
    const f = targetFiles[i];
    processedCount = i + 1;

    // 跳过已翻译文件（非强制模式）
    const alreadyTranslated = !!f.chineseName && String(f.chineseName).trim().length > 0;
    if (alreadyTranslated && !force && skipTranslated) {
      skippedCount++;
      // 发送进度（仍计入当前序号）
      try {
        mainWindow && mainWindow.webContents.send('translation-progress', {
          current: processedCount, total,
          message: `跳过已翻译 ${processedCount}/${total}`
        });
      } catch (e) {}
      // 保留已有结果
      translations.push({
        path: f.path,
        name: f.name,
        originalName: f.name,
        readableName: extractReadableName(f.name),
        author: '未知',
        language: '未知',
        title: '',
        description: '',
        translatedName: f.chineseName,
        translatedTitle: '',
        translateStatus: 'ok',
        anchored: isFileAnchored(f.path),
        skippedExisting: true,
      });
      continue;
    }

    // 发送进度
    try {
      mainWindow && mainWindow.webContents.send('translation-progress', {
        current: processedCount, total,
        message: `正在翻译第 ${processedCount}/${total} 个文件`
      });
    } catch (e) {}

    const readableName = extractReadableName(f.name);
    const info = {
      path: f.path,
      name: f.name,
      originalName: f.name,
      readableName: readableName,
      author: '未知',
      language: '未知',
      title: '',
      description: '',
      translatedName: '',      // 中文名称（翻译结果）
      translatedTitle: '',     // STBL 标题翻译
      translateStatus: 'pending', // pending | ok | failed | skipped
      anchored: isFileAnchored(f.path),
    };
    try {
      const buf = fs.readFileSync(f.path);
      const parsed = parsePackage(buf);
      if (parsed && parsed.entries.length > 0) {
        const stblEntries = parsed.entries.filter(e => e.type === STBL_TYPE);
        if (stblEntries.length > 0) {
          const strings = readSTBL(buf, stblEntries[0]);
          if (strings.length > 0) info.title = strings[0];
          if (strings.length > 1) info.description = strings[1];
          if (info.title) {
            info.language = detectLanguage(info.title);
          }
        }
        const nameMatch = f.name.match(/\[([^\]]+)\]/);
        if (nameMatch) info.author = nameMatch[1];
      }
    } catch (e) {}

    // 翻译引擎：翻译文件名
    if (enableTranslate) {
      // 优先翻译 STBL 标题，其次翻译可读文件名
      const textToTranslate = info.title || readableName;
      if (textToTranslate) {
        try {
          const translated = await callTranslationAPI(textToTranslate, config);
          if (translated) {
            info.translatedName = translated;
            if (info.title) info.translatedTitle = translated;
            info.translateStatus = 'ok';
          } else {
            info.translateStatus = 'failed';
          }
        } catch (e) {
          info.translateStatus = 'failed';
        }
      } else {
        info.translateStatus = 'skipped';
      }
    } else {
      info.translateStatus = 'skipped';
    }

    translations.push(info);

    // 将中文名称以文件绝对路径为唯一键写回 scanResults 索引，供全局联动读取
    if (state.scanResults && state.scanResults.files) {
      const fileEntry = state.scanResults.files.find(fe => fe.path === info.path);
      if (fileEntry) {
        if (info.translateStatus === 'ok' && info.translatedName) {
          fileEntry.chineseName = info.translatedName;
        } else if (!fileEntry.chineseName) {
          // 翻译失败/跳过时不覆盖已有手动修改的值，仅确保字段存在
          fileEntry.chineseName = '';
        }
      }
    }
  }
  // 持久化索引，确保后续页面读取一致
  saveState();
  return {
    translations,
    total: translations.length,
    targetTotal: total,
    skippedCount,
    translateEnabled: enableTranslate,
    scanResults: state.scanResults
  };
});

// ============ IPC: 手动修改中文名称（全局联动） ============
// 以文件绝对路径为唯一键，写入 scanResults 索引并持久化
ipcMain.handle('set-chinese-name', async (event, modPath, chineseName) => {
  if (!modPath) return { ok: false, error: '缺少文件路径' };
  if (!state.scanResults || !state.scanResults.files) {
    return { ok: false, error: '请先执行深度扫描' };
  }
  const fileEntry = state.scanResults.files.find(f => f.path === modPath);
  if (!fileEntry) {
    return { ok: false, error: '未找到对应文件' };
  }
  fileEntry.chineseName = (chineseName == null) ? '' : String(chineseName);
  // 同步更新 translations 数组中对应条目（保持翻译页面一致）
  opLog('SET_CHINESE_NAME', `${modPath} -> ${fileEntry.chineseName}`);
  saveState();
  return { ok: true, chineseName: fileEntry.chineseName };
});

// ============ IPC: 分类与打标签 ============
ipcMain.handle('set-classification', async (event, modPath, classification) => {
  // 用户手动设置，标记 __manual，避免被后续自动分类覆盖
  const saved = {
    ...classification,
    __auto: false,
    __manual: true,
  };
  state.classifications[modPath] = saved;
  // 同步标签
  if (classification.tags) {
    for (const t of classification.tags) {
      if (!state.tags.includes(t)) state.tags.push(t);
    }
  }
  opLog('SET_CLASSIFICATION', `${modPath} -> ${JSON.stringify(classification.category || [])} / tags: ${JSON.stringify(classification.tags || [])}`);
  saveState();
  return { ok: true };
});

ipcMain.handle('get-classifications', async () => {
  return state.classifications;
});

ipcMain.handle('get-categories', async () => {
  return state.categories;
});

ipcMain.handle('add-category', async (event, parentPath, name) => {
  // 按路径在树中找到目标节点并添加子分类
  function findAndAdd(nodes, pathParts, newName) {
    if (pathParts.length === 0) {
      // 在当前层级添加
      if (!nodes.find(n => n.name === newName)) {
        nodes.push({ name: newName, children: [] });
      }
      return true;
    }
    const target = nodes.find(n => n.name === pathParts[0]);
    if (target) {
      return findAndAdd(target.children, pathParts.slice(1), newName);
    }
    return false;
  }
  if (parentPath && parentPath.length > 0) {
    findAndAdd(state.categories, parentPath, name);
  } else {
    if (!state.categories.find(n => n.name === name)) {
      state.categories.push({ name, children: [] });
    }
  }
  saveState();
  return { ok: true, categories: state.categories };
});

ipcMain.handle('add-tag', async (event, tag) => {
  if (tag && !state.tags.includes(tag)) {
    state.tags.push(tag);
    saveState();
  }
  return { ok: true, tags: state.tags };
});

ipcMain.handle('get-tags', async () => {
  return state.tags;
});

ipcMain.handle('remove-tag', async (event, tag) => {
  state.tags = state.tags.filter(t => t !== tag);
  for (const k of Object.keys(state.classifications)) {
    if (state.classifications[k].tags) {
      state.classifications[k].tags = state.classifications[k].tags.filter(t => t !== tag);
    }
  }
  saveState();
  return { ok: true, tags: state.tags };
});

// ============ IPC: 创建并移动 ============
ipcMain.handle('execute-move', async () => {
  if (!state.modsFolder) return { error: '未设置 Mods 文件夹' };
  const moved = [];
  const errors = [];
  const skipped = [];

  for (const [modPath, classification] of Object.entries(state.classifications)) {
    if (!classification.category || classification.category.length === 0) {
      skipped.push({ path: modPath, reason: '未设置分类' });
      continue;
    }
    // 已锚定的不移动
    if (isFileAnchored(modPath)) {
      skipped.push({ path: modPath, reason: '已锚定，跳过移动' });
      continue;
    }
    // 构建目标路径
    const categoryPath = classification.category.join(path.sep);
    const targetDir = path.join(state.modsFolder, categoryPath);
    const targetPath = path.join(targetDir, path.basename(modPath));
    try {
      // 创建多级文件夹
      await fsp.mkdir(targetDir, { recursive: true });
      // 避免覆盖
      let finalTarget = targetPath;
      if (modPath !== targetPath) {
        if (fs.existsSync(targetPath)) {
          const ext = path.extname(targetPath);
          const base = path.basename(targetPath, ext);
          finalTarget = path.join(targetDir, `${base}_dup${ext}`);
        }
        await fsp.rename(modPath, finalTarget);
        moved.push({ from: modPath, to: finalTarget });
      }
    } catch (e) {
      errors.push({ path: modPath, error: e.message });
    }
  }
  saveState();
  return { moved, errors, skipped, movedCount: moved.length };
});

// ============ IPC: 图片预览 ============
ipcMain.handle('get-images', async (event, folderPath) => {
  const images = [];
  if (!folderPath) return { images: [] };
  // 优先使用扫描结果
  if (state.scanResults && state.scanResults.folderImages[folderPath]) {
    for (const imgPath of state.scanResults.folderImages[folderPath]) {
      try {
        const data = await fsp.readFile(imgPath);
        const ext = path.extname(imgPath).slice(1).toLowerCase();
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        images.push({
          path: imgPath,
          name: path.basename(imgPath),
          dataUrl: `data:image/${mime};base64,${data.toString('base64')}`,
        });
      } catch (e) {}
    }
    return { images };
  }
  // 实时读取
  let entries;
  try {
    entries = await fsp.readdir(folderPath, { withFileTypes: true });
  } catch (e) {
    return { images: [] };
  }
  for (const e of entries) {
    if (e.isFile() && isImageFile(e.name)) {
      const imgPath = path.join(folderPath, e.name);
      try {
        const data = await fsp.readFile(imgPath);
        const ext = path.extname(imgPath).slice(1).toLowerCase();
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        images.push({
          path: imgPath,
          name: e.name,
          dataUrl: `data:image/${mime};base64,${data.toString('base64')}`,
        });
      } catch (err) {}
    }
  }
  return { images };
});

// ============ IPC: 一键定位 ============
ipcMain.handle('locate-file', async (event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) {
    // 尝试定位父目录
    const dir = path.dirname(filePath);
    if (fs.existsSync(dir)) {
      shell.openPath(dir);
      return { ok: true };
    }
    return { error: '文件或目录不存在' };
  }
  shell.showItemInFolder(filePath);
  return { ok: true };
});

// ============ IPC: 重置 ============
ipcMain.handle('reset-state', async () => {
  state = {
    modsFolder: '',
    scanResults: null,
    anchored: [],
    keepList: [],
    whitelist: [],
    classifications: {},
    tags: [],
    categories: defaultCategories(),
  };
  saveState();
  return { ok: true };
});
