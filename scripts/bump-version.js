const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const parts = pkg.version.split('.').map(Number);
if (parts.length < 3) {
  parts.push(0, 0, 0);
}
parts[2] += 1; // 自动递增 patch 版本号
pkg.version = parts.slice(0, 3).join('.');

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`[bump-version] 版本号已更新为 ${pkg.version}`);
