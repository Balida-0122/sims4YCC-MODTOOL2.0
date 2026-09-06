const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(PROJECT_ROOT, 'build');
const ICONSET_DIR = path.join(BUILD_DIR, 'icon.iconset');
const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe';

const result = {
  task1: { exitCode: null, last100Lines: [], totalLines: 0 },
  task2: { files: [], icoExists: false, icoSize: -1, icnsExists: false, icnsSize: -1, iconsetComplete10: false },
  task3: { executed: false, success: false, finalIcnsSize: -1, error: null, rebuildAttempted: false },
  canContinueWinBuild: false,
};

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return -1; }
}

function listFilesRecursive(dir, baseDir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(baseDir, full);
    if (ent.isDirectory()) {
      out.push({ path: rel + '/', size: 0, isDir: true });
      out.push(...listFilesRecursive(full, baseDir));
    } else {
      out.push({ path: rel, size: fileSize(full), isDir: false });
    }
  }
  return out;
}

// ========== npm install if missing ==========
(function ensureDependencies() {
  const nmPath = path.join(PROJECT_ROOT, 'node_modules');
  if (!fs.existsSync(nmPath) || !fs.existsSync(path.join(nmPath, 'sharp'))) {
    console.log('[PREP] node_modules/sharp missing, running npm install...');
    const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--no-audit', '--no-fund', '--loglevel=warn'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: 'inherit',
      shell: true,
      windowsHide: true,
    });
    if (r.status !== 0) {
      console.log(`[PREP] WARN: npm install exit code ${r.status}`);
    }
  }
})();

// ========== TASK 1: Run build-icons.js ==========
(function runTask1() {
  console.log('\n========== TASK 1: Running build-icons.js ==========');
  const scriptPath = path.join(__dirname, 'build-icons.js');
  const start = Date.now();
  const t1 = spawnSync(NODE_EXE, [scriptPath], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
  });
  const elapsed = Date.now() - start;
  const combinedOutput = ((t1.stdout || '') + '\n' + (t1.stderr || '')).split(/\r?\n/).filter(l => l.length > 0);
  result.task1.exitCode = t1.status == null ? (t1.error ? 2 : -1) : t1.status;
  result.task1.totalLines = combinedOutput.length;
  result.task1.last100Lines = combinedOutput.slice(-100);
  console.log(`[TASK1] build-icons.js exit code ${result.task1.exitCode}, ${elapsed}ms, ${combinedOutput.length} output lines`);
  if (t1.error) {
    console.log('[TASK1] ERROR:', t1.error.message);
  }
})();

// ========== TASK 2: List build/ directory ==========
(function runTask2() {
  console.log('\n========== TASK 2: Listing build/ directory ==========');
  const allBuildFiles = listFilesRecursive(BUILD_DIR, BUILD_DIR);
  result.task2.files = allBuildFiles;

  const icoPath = path.join(BUILD_DIR, 'icon.ico');
  const icnsPath = path.join(BUILD_DIR, 'icon.icns');
  result.task2.icoExists = fs.existsSync(icoPath);
  result.task2.icoSize = result.task2.icoExists ? fileSize(icoPath) : -1;
  result.task2.icnsExists = fs.existsSync(icnsPath);
  result.task2.icnsSize = result.task2.icnsExists ? fileSize(icnsPath) : -1;

  const expectedIconsetFiles = [
    'icon_16x16.png',
    'icon_16x16@2x.png',
    'icon_32x32.png',
    'icon_32x32@2x.png',
    'icon_128x128.png',
    'icon_128x128@2x.png',
    'icon_256x256.png',
    'icon_256x256@2x.png',
    'icon_512x512.png',
    'icon_512x512@2x.png',
  ];
  let iconsetCount = 0;
  for (const f of expectedIconsetFiles) {
    const p = path.join(ICONSET_DIR, f);
    if (fs.existsSync(p) && fileSize(p) > 0) iconsetCount++;
  }
  result.task2.iconsetComplete10 = (iconsetCount === 10);

  console.log(`[TASK2] icon.ico  exists: ${result.task2.icoExists}, size: ${result.task2.icoSize} bytes`);
  console.log(`[TASK2] icon.icns exists: ${result.task2.icnsExists}, size: ${result.task2.icnsSize} bytes`);
  console.log(`[TASK2] icon.iconset has ${iconsetCount}/10 valid PNGs (complete: ${result.task2.iconsetComplete10})`);
  console.log('[TASK2] build/ contents:');
  for (const f of allBuildFiles) {
    const sizeStr = f.isDir ? '<DIR>'.padStart(10) : f.size.toString().padStart(10) + ' B';
    console.log(`  ${sizeStr}  ${f.path}`);
  }
})();

// ========== TASK 3: Try to build icon.icns if missing ==========
(function runTask3() {
  const icnsPath = path.join(BUILD_DIR, 'icon.icns');
  const needsIcnsBuild = (!result.task2.icnsExists || result.task2.icnsSize <= 0) && result.task2.iconsetComplete10;

  if (needsIcnsBuild) {
    result.task3.executed = true;
    result.task3.rebuildAttempted = true;
    console.log('\n========== TASK 3: Rebuilding icon.icns via @fiahfy/icns ==========');
    try {
      let Icns, IcnsImage;
      try {
        const icnsModPath = path.join(PROJECT_ROOT, 'node_modules', '@fiahfy', 'icns');
        const icnsMod = require(icnsModPath);
        Icns = icnsMod.Icns;
        IcnsImage = icnsMod.IcnsImage;
      } catch (e) {
        try {
          const icnsMod = require('@fiahfy/icns');
          Icns = icnsMod.Icns;
          IcnsImage = icnsMod.IcnsImage;
        } catch (e2) {
          throw new Error('@fiahfy/icns not loadable: ' + e.message + ' | ' + e2.message);
        }
      }
      if (!Icns || !IcnsImage) throw new Error('@fiahfy/icns exports missing');

      const icnsEntries = [
        { name: 'icon_16x16.png',        size: 16,    osType: 'icp4' },
        { name: 'icon_16x16@2x.png',     size: 32,    osType: 'ic11' },
        { name: 'icon_32x32.png',        size: 32,    osType: 'icp5' },
        { name: 'icon_32x32@2x.png',     size: 64,    osType: 'ic12' },
        { name: 'icon_128x128.png',      size: 128,   osType: 'ic07' },
        { name: 'icon_128x128@2x.png',   size: 256,   osType: 'ic13' },
        { name: 'icon_256x256.png',      size: 256,   osType: 'ic08' },
        { name: 'icon_256x256@2x.png',   size: 512,   osType: 'ic14' },
        { name: 'icon_512x512.png',      size: 512,   osType: 'ic09' },
        { name: 'icon_512x512@2x.png',   size: 1024,  osType: 'ic10' },
      ];

      const icns = new Icns();
      const usedTypes = new Set();
      for (const entry of icnsEntries) {
        if (usedTypes.has(entry.osType)) {
          console.log(`[TASK3] SKIP duplicate osType=${entry.osType} (${entry.name})`);
          continue;
        }
        const src = path.join(ICONSET_DIR, entry.name);
        if (!fs.existsSync(src)) {
          console.log(`[TASK3] SKIP missing ${entry.osType} (${entry.name})`);
          continue;
        }
        try {
          const buf = fs.readFileSync(src);
          const img = IcnsImage.fromPNG(buf, entry.osType);
          icns.append(img);
          usedTypes.add(entry.osType);
          console.log(`[TASK3] Added ${entry.osType} ${entry.size}px from ${entry.name} (${buf.length} bytes PNG)`);
        } catch (e) {
          console.log(`[TASK3] WARN ${entry.osType} failed: ${e.message}`);
        }
      }

      if (usedTypes.size === 0) {
        throw new Error('No icns entries were successfully added');
      }

      fs.writeFileSync(icnsPath, icns.data);
      const sz = fileSize(icnsPath);
      result.task3.success = true;
      result.task3.finalIcnsSize = sz;
      result.task2.icnsExists = true;
      result.task2.icnsSize = sz;
      console.log(`[TASK3] SUCCESS: icon.icns written, size=${sz} bytes (${usedTypes.size} OSTypes)`);
    } catch (e) {
      result.task3.success = false;
      result.task3.error = { message: e.message, stack: e.stack || '' };
      console.log(`[TASK3] FAILED: ${e.message}`);
      if (e.stack) console.log('[STACK] ' + e.stack);
      console.log('[TASK3] icon.iconset 完整已生成，mac icns 需在 mac 上使用 iconutil 生成');
    }
  } else {
    result.task3.executed = false;
    console.log('\n========== TASK 3: Skipped ==========');
    if (result.task2.icnsExists && result.task2.icnsSize > 0) {
      console.log('[TASK3] icon.icns already exists with size ' + result.task2.icnsSize + ' bytes');
    } else if (!result.task2.iconsetComplete10) {
      console.log('[TASK3] icon.iconset is incomplete (need 10 PNGs), skipping icns rebuild');
    }
  }
})();

// ========== FINAL ==========
result.canContinueWinBuild = result.task2.icoExists && result.task2.icoSize > 0;

console.log('\n========== FINAL SUMMARY ==========');
console.log(`TASK 1 exit code: ${result.task1.exitCode}`);
console.log(`TASK 2: icon.ico exists: ${result.task2.icoExists} (${result.task2.icoSize} B), icon.icns exists: ${result.task2.icnsExists} (${result.task2.icnsSize} B), iconset 10/10: ${result.task2.iconsetComplete10}`);
console.log(`TASK 3: executed=${result.task3.executed}, success=${result.task3.success}, final icns size=${result.task3.finalIcnsSize} B`);
console.log(`Can continue electron-builder win packaging (icon.ico valid): ${result.canContinueWinBuild}`);

if (!result.canContinueWinBuild) {
  console.log('\n[WARN] icon.ico is missing or empty! Win build cannot proceed until icon.ico is generated.');
}

// Write result JSON
const outJson = path.join(BUILD_DIR, 'all-tasks-result.json');
try {
  if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n[DONE] Result JSON saved to ${outJson}`);
} catch (e) {
  console.log(`[WARN] Failed to write result JSON: ${e.message}`);
  const base64 = Buffer.from(JSON.stringify(result), 'utf8').toString('base64');
  console.log('\nRESULT_JSON_B64_BEGIN');
  console.log(base64);
  console.log('RESULT_JSON_B64_END');
}
