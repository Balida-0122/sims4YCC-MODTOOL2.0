/**
 * 图标生成脚本（重写版）
 * 输入：YCC.png（项目根目录 或 桌面）
 * 输出：build/icon.ico (Windows)、build/icon.icns (macOS)、build/icon.iconset/
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(PROJECT_ROOT, 'build');
const ICONSET_DIR = path.join(BUILD_DIR, 'icon.iconset');
const LOG_PATH = path.join(BUILD_DIR, 'build-icons.log');

// ============ 日志 ============
const logLines = [];
function log(msg, level = 'INFO') {
  const line = `[${level}] ${msg}`;
  console.log(line);
  logLines.push(line);
}
function flushLog() {
  try {
    if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });
    fs.writeFileSync(LOG_PATH, logLines.join('\n') + '\n', 'utf8');
  } catch {}
}

// ============ 工具函数 ============
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return -1; }
}

/**
 * 查找图标原图：优先项目根目录，其次桌面
 */
function findIconFile() {
  // 1. 项目根目录
  const rootFiles = fs.existsSync(PROJECT_ROOT)
    ? fs.readdirSync(PROJECT_ROOT)
    : [];
  const rootMatch = rootFiles.find(f => f.toLowerCase() === 'ycc.png');
  if (rootMatch) return path.join(PROJECT_ROOT, rootMatch);

  // 2. 桌面
  const desktop = path.join(require('os').homedir(), 'Desktop');
  if (fs.existsSync(desktop)) {
    const deskFiles = fs.readdirSync(desktop);
    const deskMatch = deskFiles.find(f => f.toLowerCase() === 'ycc.png');
    if (deskMatch) return path.join(desktop, deskMatch);
  }

  // 3. 命令行参数
  if (process.argv[2] && fs.existsSync(process.argv[2])) return process.argv[2];

  return null;
}

// ============ 尺寸定义 ============
// Windows ICO：标准尺寸
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// 全部需要生成的 PNG 尺寸
const ALL_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
// macOS iconset：10 个标准文件
const ICONSET_MAP = [
  { size: 16,  name: 'icon_16x16' },
  { size: 32,  name: 'icon_16x16@2x' },
  { size: 32,  name: 'icon_32x32' },
  { size: 64,  name: 'icon_32x32@2x' },
  { size: 128, name: 'icon_128x128' },
  { size: 256, name: 'icon_128x128@2x' },
  { size: 256, name: 'icon_256x256' },
  { size: 512, name: 'icon_256x256@2x' },
  { size: 512, name: 'icon_512x512' },
  { size: 1024,name: 'icon_512x512@2x' },
];
// macOS ICNS OSType 映射（去重，每个 OSType 只用一次）
const ICNS_MAP = [
  { size: 16,  osType: 'icp4' },
  { size: 32,  osType: 'ic11' },
  { size: 32,  osType: 'icp5' },
  { size: 64,  osType: 'ic12' },
  { size: 128, osType: 'ic07' },
  { size: 256, osType: 'ic13' },
  { size: 256, osType: 'ic08' },
  { size: 512, osType: 'ic14' },
  { size: 512, osType: 'ic09' },
  { size: 1024,osType: 'ic10' },
];

// ============ 主流程 ============
async function main() {
  try {
    ensureDir(BUILD_DIR);
    ensureDir(ICONSET_DIR);

    // 1. 查找图标
    const iconPath = findIconFile();
    if (!iconPath) {
      throw new Error('找不到 YCC.png，请放到项目根目录或桌面');
    }
    log(`找到图标: ${iconPath}`);

    // 2. 读取原始尺寸
    const metadata = await sharp(iconPath).metadata();
    const origW = metadata.width || 0;
    const origH = metadata.height || 0;
    log(`原始尺寸: ${origW}x${origH}  格式: ${metadata.format || 'unknown'}`);
    if (origW !== origH) {
      log(`警告: 原图非正方形 (${origW}x${origH})，将居中裁切为正方形`, 'WARN');
    }

    // 3. 预处理：如果非正方形，先裁切为正方形（居中）
    let baseImage = sharp(iconPath);
    if (origW !== origH && origW > 0 && origH > 0) {
      const minSide = Math.min(origW, origH);
      const left = Math.floor((origW - minSide) / 2);
      const top = Math.floor((origH - minSide) / 2);
      baseImage = sharp(iconPath).extract({
        left, top, width: minSide, height: minSide,
      });
      log(`已裁切为正方形: ${minSide}x${minSide}`);
    }

    // 4. 生成所有尺寸的 PNG（存入 Map）
    //    sharp.toFile() 返回 OutputInfo 对象（直接就是 info，不需要解构）
    const generatedPaths = new Map(); // size -> file path
    log('开始生成各尺寸 PNG...');
    for (const size of ALL_SIZES) {
      const outPath = path.join(BUILD_DIR, `icon-${size}x${size}.png`);
      if (origW < size || origH < size) {
        log(`原图小于 ${size}x${size}，将放大`, 'WARN');
      }
      // 用 ensureFlatImage 保证透明背景
      await baseImage
        .clone()
        .resize(size, size, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toFile(outPath);
      generatedPaths.set(size, outPath);
      log(`  生成 icon-${size}x${size}.png`);
    }
    log(`共生成 ${generatedPaths.size} 个 PNG 文件`);

    // 5. 生成 Windows ICO
    log('开始生成 icon.ico ...');
    let icoSuccess = false;
    try {
      const pngToIco = (await import('png-to-ico')).default;
      // 读取 ICO 所需尺寸的 PNG 为 Buffer 数组
      const icoBuffers = [];
      for (const size of ICO_SIZES) {
        const p = generatedPaths.get(size);
        if (p && fs.existsSync(p)) {
          icoBuffers.push(fs.readFileSync(p));
        }
      }
      if (icoBuffers.length === 0) {
        throw new Error('没有可用的 PNG 来生成 ICO');
      }
      log(`  使用 ${icoBuffers.length} 个 PNG 合成 ICO`);
      const icoBuffer = await pngToIco(icoBuffers);
      const icoPath = path.join(BUILD_DIR, 'icon.ico');
      fs.writeFileSync(icoPath, icoBuffer);
      icoSuccess = true;
      log(`  icon.ico 生成成功 (${fileSize(icoPath)} bytes)`);
    } catch (e) {
      log(`icon.ico 生成失败: ${e.message}`, 'ERROR');
      if (e.stack) log(e.stack, 'ERROR');
    }

    // 6. 生成 macOS ICNS
    log('开始生成 icon.icns ...');
    let icnsSuccess = false;
    try {
      const { Icns, IcnsImage } = require('@fiahfy/icns');
      const icns = new Icns();
      const usedOSTypes = new Set();
      let addedCount = 0;
      for (const entry of ICNS_MAP) {
        if (usedOSTypes.has(entry.osType)) continue;
        const p = generatedPaths.get(entry.size);
        if (!p || !fs.existsSync(p)) continue;
        try {
          const buf = fs.readFileSync(p);
          const img = IcnsImage.fromPNG(buf, entry.osType);
          icns.append(img);
          usedOSTypes.add(entry.osType);
          addedCount++;
        } catch (e) {
          log(`  跳过 ${entry.osType} (${entry.size}px): ${e.message}`, 'WARN');
        }
      }
      if (addedCount === 0) {
        throw new Error('没有成功添加任何 ICNS 条目');
      }
      const icnsPath = path.join(BUILD_DIR, 'icon.icns');
      fs.writeFileSync(icnsPath, icns.data);
      icnsSuccess = true;
      log(`  icon.icns 生成成功 (${fileSize(icnsPath)} bytes, ${addedCount} 条目)`);
    } catch (e) {
      log(`icon.icns 生成失败: ${e.message}`, 'WARN');
      if (e.stack) log(e.stack, 'WARN');
    }

    // 7. 生成 icon.iconset/（macOS 标准目录，10 个文件）
    log('开始生成 icon.iconset/ ...');
    let iconsetCount = 0;
    for (const entry of ICONSET_MAP) {
      const srcPath = generatedPaths.get(entry.size);
      if (!srcPath || !fs.existsSync(srcPath)) continue;
      const destPath = path.join(ICONSET_DIR, `${entry.name}.png`);
      try {
        fs.copyFileSync(srcPath, destPath);
        iconsetCount++;
      } catch (e) {
        log(`  复制 ${entry.name}.png 失败: ${e.message}`, 'WARN');
      }
    }
    log(`  icon.iconset/ 生成 ${iconsetCount}/10 个文件`);

    if (!icnsSuccess && iconsetCount === 10) {
      log('提示: icon.icns 未生成，但 icon.iconset/ 完整。', 'INFO');
      log('  在 macOS 上执行: iconutil -c icns build/icon.iconset -o build/icon.icns', 'INFO');
    }

    // 8. 汇总
    const icoPath = path.join(BUILD_DIR, 'icon.ico');
    const icnsPath = path.join(BUILD_DIR, 'icon.icns');
    log('');
    log('============== RESULT ==============');
    log(`icon.ico  : exists=${fs.existsSync(icoPath)}  size=${fileSize(icoPath)} bytes`);
    log(`icon.icns : exists=${fs.existsSync(icnsPath)}  size=${fileSize(icnsPath)} bytes`);
    log(`icon.iconset : ${iconsetCount}/10 files in ${ICONSET_DIR}`);
    log(`Win 打包就绪 : ${icoSuccess ? 'YES' : 'NO'}`);
    log('====================================');
    flushLog();

    if (!icoSuccess) {
      process.exitCode = 1;
    }
  } catch (e) {
    log(`致命错误: ${e.message}`, 'ERROR');
    if (e.stack) log(e.stack, 'ERROR');
    flushLog();
    process.exit(1);
  }
}

main();
