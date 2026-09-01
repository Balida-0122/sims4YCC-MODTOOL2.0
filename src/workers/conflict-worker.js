/**
 * 冲突检测 Worker
 * 在独立线程执行，避免 9000+ 文件阻塞主进程
 * 父进程 postMessage 格式：
 *   { cmd: 'start', payload: { files, ts4scriptFolders, whitelist, anchoredPaths, strictMode } }
 *   files: Array<{ path, name, ext, size, mtime, author }>
 * 向父进程 postMessage 格式：
 *   { type: 'progress', current, total, skipped, message }
 *   { type: 'done', conflicts: Array, total, skippedFiles: Array }
 *   { type: 'error', message }
 */
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');

// ============ DBPF 解析（主进程同一份拷贝） ============
const DBPF_MAGIC = 'DBPF';
const STBL_TYPE = 0x220557DA;

function parsePackage(buffer) {
  try {
    if (!buffer || buffer.length < 100) return null;
    if (buffer.toString('ascii', 0, 4) !== DBPF_MAGIC) return null;
    const major = buffer.readUInt32LE(4);
    const indexPos = major >= 2
      ? Number(buffer.readUInt32LE(24) || buffer.readUInt32LE(64))
      : Number(buffer.readUInt32LE(24));
    const indexCount = major >= 2
      ? buffer.readUInt32LE(28) >>> 0
      : buffer.readUInt32LE(28) >>> 0;
    if (indexPos <= 0 || indexCount === 0 || indexPos >= buffer.length - 20) {
      return null;
    }
    const entries = [];
    let pos = indexPos;
    for (let i = 0; i < indexCount; i++) {
      if (pos + 20 > buffer.length) break;
      const type = buffer.readUInt32LE(pos);
      const group = buffer.readUInt32LE(pos + 4);
      const instance = buffer.readUInt32LE(pos + 8) >>> 0;
      let offset, size;
      if (major >= 2 && buffer.length > pos + 28) {
        offset = Number(buffer.readUInt32LE(pos + 20) >>> 0);
        size = Number(buffer.readUInt32LE(pos + 16) >>> 0);
        pos += 24;
      } else {
        size = Number(buffer.readUInt32LE(pos + 12) >>> 0);
        offset = Number(buffer.readUInt32LE(pos + 16) >>> 0);
        pos += 20;
      }
      entries.push({ type, group, instance, offset, size });
    }
    return { entries, indexCount };
  } catch {
    return null;
  }
}

// ============ 跨平台工具函数 ============
function normalizePath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/');
}

// ============ 主流程 ============
parentPort.on('message', async (msg) => {
  if (!msg || msg.cmd !== 'start') return;
  try {
    const p = msg.payload || {};
    const files = Array.isArray(p.files) ? p.files.filter(f => f && f.path) : [];
    const whitelist = Array.isArray(p.whitelist) ? new Set(p.whitelist) : new Set();
    const anchoredPaths = Array.isArray(p.anchoredPaths) ? new Set(p.anchoredPaths.map(normalizePath)) : new Set();
    const ts4scriptFolders = new Set((p.ts4scriptFolders || []).map(normalizePath));
    const total = files.length;
    const timeoutPerFileMs = 5000;

    function isAnchored(fp) { return anchoredPaths.has(normalizePath(fp)); }
    function isInTs4ScriptFolder(fp) {
      const np = normalizePath(fp).toLowerCase();
      for (const tp of ts4scriptFolders) {
        if (np.startsWith(tp + '/')) return true;
      }
      return false;
    }
    function extractAuthor(name) {
      if (!name) return '未知';
      const m = String(name).match(/\[([^\]]+)\]/);
      return m ? m[1] : '未知';
    }

    // 作者缓存 + 路径元数据缓存
    const fileMeta = new Map(); // path -> { ext, mtime, name, size, author }
    for (const f of files) {
      fileMeta.set(f.path, {
        name: f.name || path.basename(f.path),
        ext: f.ext || path.extname(f.path).toLowerCase(),
        size: f.size || 0,
        mtime: f.mtime || '',
        author: f.author || extractAuthor(f.name),
      });
    }

    // 提取每个 .package 的 TGI 键（分批，每批 100 个 + 5s 超时保护 + 进度）
    const fileTGI = new Map();
    let skippedFiles = [];
    const BATCH_SIZE = 100;

    parentPort.postMessage({
      type: 'progress', phase: 'parse',
      current: 0, total, skipped: 0,
      message: `准备解析 ${total} 个 package 文件...`,
    });

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const end = Math.min(i + BATCH_SIZE, total);
      for (let j = i; j < end; j++) {
        const f = files[j];
        const meta = fileMeta.get(f.path) || {};
        if (meta.ext !== '.package') continue;
        try {
          // 单文件同步解析 + 耗时测量（避免单个异常文件卡死）
          const start = Date.now();
          let buf;
          try {
            buf = fs.readFileSync(f.path);
          } catch {
            throw new Error('read_fail');
          }
          if (Date.now() - start > timeoutPerFileMs) {
            skippedFiles.push({ path: f.path, reason: 'read_timeout' });
            continue;
          }
          if (!buf || buf.length < 100) continue;
          const t0 = Date.now();
          const parsed = parsePackage(buf);
          if (Date.now() - t0 > timeoutPerFileMs) {
            skippedFiles.push({ path: f.path, reason: 'parse_timeout' });
            continue;
          }
          if (parsed && parsed.entries && parsed.entries.length > 0) {
            const keys = new Set();
            for (const e of parsed.entries) {
              keys.add(`${e.type}:${e.group}:${e.instance}`);
            }
            if (keys.size > 0) fileTGI.set(f.path, keys);
          }
        } catch (e) {
          skippedFiles.push({
            path: f.path,
            reason: (e && e.message) ? e.message.slice(0, 200) : 'error'
          });
        }
      }
      // 每批结束发送进度
      parentPort.postMessage({
        type: 'progress', phase: 'parse',
        current: end, total, skipped: skippedFiles.length,
        message: `解析资源键 ${end}/${total}（跳过：${skippedFiles.length}）`
      });
    }

    // 按 TGI 键分组 → 冲突
    parentPort.postMessage({
      type: 'progress', phase: 'tgi',
      current: 0, total: fileTGI.size, skipped: skippedFiles.length,
      message: `分析资源冲突（TGI）...`
    });
    const keyToFiles = new Map();
    const keyToResourceType = new Map();
    let idx = 0;
    for (const [filePath, keys] of fileTGI.entries()) {
      for (const k of keys) {
        if (!keyToFiles.has(k)) keyToFiles.set(k, []);
        keyToFiles.get(k).push(filePath);
        keyToResourceType.set(k, k.split(':')[0]);
      }
      idx++;
      if (idx % 2000 === 0 || idx === fileTGI.size) {
        parentPort.postMessage({
          type: 'progress', phase: 'tgi',
          current: idx, total: fileTGI.size, skipped: skippedFiles.length,
          message: `分析资源冲突（TGI） ${idx}/${fileTGI.size}`
        });
      }
    }

    // 同名冲突分组（非常快，1 次 for 即可）
    const byName = new Map();
    for (const f of files) {
      const name = f.name.toLowerCase();
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(f.path);
    }

    // 组装冲突结果
    parentPort.postMessage({
      type: 'progress', phase: 'assemble',
      current: 0, total: keyToFiles.size + byName.size, skipped: skippedFiles.length,
      message: `组装冲突结果...`
    });

    function mkImpactInfo(kind, resType) {
      if (kind === 'name') {
        return {
          typeName: '同名文件冲突',
          impact: '可能导致加载顺序不确定，实际生效的版本不确定',
          severity: 'low',
          suggestion: '保留最新或作者明确的版本',
        };
      }
      const t = (resType || '').toString().toLowerCase();
      const s = t === '0x54524553' || /stbl|string|220557da/.test(t) ? 'low' : 'medium';
      if (s === 'low') {
        return {
          typeName: '字符串表覆盖',
          impact: '可能导致显示的文字/翻译版本不确定',
          severity: 'low',
          suggestion: '保留翻译正确的版本',
        };
      }
      return {
        typeName: '资源覆盖 (TGI)',
        impact: '同一资源被多次定义，游戏只加载其一，会导致另一部分内容缺失',
        severity: 'medium',
        suggestion: '保留功能更重要、更可信作者的版本',
      };
    }

    const conflicts = [];
    let conflictId = 0;
    let step = 0;

    function assembleGroup(groupKind, conflictKeyPrefix, fileList, extraInfo) {
      if (fileList.length < 2) return;
      const key = conflictKeyPrefix;
      if (whitelist.has(key)) return;
      const anchoredCount = fileList.filter(isAnchored).length;
      const authors = fileList.map(p => (fileMeta.get(p) || {}).author).filter(a => a && a !== '未知');
      const uniqueAuthors = [...new Set(authors)];
      const sameAuthor = uniqueAuthors.length === 1 && authors.length === fileList.length;
      const hasTs4Conflict = fileList.some(isInTs4ScriptFolder);
      const type = (extraInfo && extraInfo.resourceType) || null;
      const impactInfo = mkImpactInfo(groupKind, type);
      let conflictType = impactInfo.typeName;
      if (hasTs4Conflict && groupKind === 'tgi') conflictType = '脚本模组资源覆盖 / 功能冲突';
      if (hasTs4Conflict && groupKind === 'name') conflictType = '脚本模组同名覆盖';
      const sorted = fileList.slice().sort((a, b) => {
        const ma = (fileMeta.get(a) || {}).mtime || '';
        const mb = (fileMeta.get(b) || {}).mtime || '';
        if (ma !== mb) return ma < mb ? 1 : -1;
        const sa = (fileMeta.get(a) || {}).size || 0;
        const sb = (fileMeta.get(b) || {}).size || 0;
        return sb - sa;
      });
      const mtimes = fileList.map(p => (fileMeta.get(p) || {}).mtime || '');
      let suggestion = impactInfo.suggestion;
      if (sameAuthor) suggestion = '作者相同，可能为版本更迭，建议保留最新版本';
      const pairDesc = fileList.slice(0, 2).map(p => {
        const name = path.basename(p);
        const au = (fileMeta.get(p) || {}).author || '未知';
        return `${name}（作者：${au}）`;
      }).join(' 与 ');
      const detail = groupKind === 'tgi'
        ? `${pairDesc} 产生资源类型 ${(type || '?').toUpperCase()} 的 ${conflictType}`
        : `${pairDesc} 在不同位置存在同名文件 "${extraInfo && extraInfo.name || ''}"`;
      const fileInfo = fileList.map(p => {
        const m = fileMeta.get(p) || {};
        return {
          path: p,
          name: m.name || path.basename(p),
          author: m.author || '未知',
          size: m.size || 0,
          mtime: m.mtime || '',
          ext: m.ext || '',
          anchored: isAnchored(p),
        };
      });
      conflicts.push({
        id: conflictId++,
        key,
        type: groupKind,
        resourceType: type || null,
        resourceGroup: (extraInfo && extraInfo.group) || null,
        instance: (extraInfo && extraInfo.instance) != null ? extraInfo.instance : null,
        conflictType,
        conflictSeverity: impactInfo.severity,
        impact: impactInfo.impact,
        suggestion,
        sameAuthor,
        commonAuthor: sameAuthor ? uniqueAuthors[0] : null,
        conflictPair: pairDesc,
        files: fileInfo,
        sortedNewestFirst: sorted,
        detail,
        hasAnchored: anchoredCount > 0,
      });
    }

    // TGI 冲突
    for (const [k, list] of keyToFiles) {
      if (list.length > 1) {
        const [type, group, instance] = k.split(':');
        assembleGroup('tgi', `tgi:${k}`, list, { resourceType: type, group, instance });
      }
      step++;
      if (step % 5000 === 0) {
        parentPort.postMessage({
          type: 'progress', phase: 'assemble',
          current: step,
          total: keyToFiles.size + byName.size, skipped: skippedFiles.length,
          message: `组装冲突结果 ${step}/${keyToFiles.size + byName.size}`
        });
      }
    }
    // 同名冲突
    for (const [name, list] of byName) {
      assembleGroup('name', `name:${name}`, list, { name });
      step++;
    }

    parentPort.postMessage({
      type: 'progress', phase: 'done',
      current: step, total: step, skipped: skippedFiles.length,
      message: `冲突检测完成：发现 ${conflicts.length} 组冲突`
    });

    parentPort.postMessage({
      type: 'done',
      conflicts,
      total: conflicts.length,
      skippedFiles,
    });
  } catch (e) {
    parentPort.postMessage({
      type: 'error',
      message: (e && e.message) ? e.message : 'unknown error',
      stack: (e && e.stack) ? String(e.stack).slice(0, 5000) : '',
    });
  }
});
