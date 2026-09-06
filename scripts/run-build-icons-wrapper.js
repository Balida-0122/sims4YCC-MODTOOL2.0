const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const scriptPath = path.join(__dirname, 'build-icons.js');
const nodeExe = 'C:\\Program Files\\nodejs\\node.exe';

const outputLines = [];

const child = spawn(nodeExe, [scriptPath], {
  cwd: path.resolve(__dirname, '..'),
  windowsHide: true,
});

child.stdout.on('data', (data) => {
  const text = data.toString('utf8');
  process.stdout.write(text);
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.length > 0) outputLines.push(line);
  }
});

child.stderr.on('data', (data) => {
  const text = data.toString('utf8');
  process.stderr.write(text);
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.length > 0) outputLines.push(line);
  }
});

child.on('close', (code) => {
  const last100 = outputLines.slice(-100);
  const outFile = path.join(__dirname, '..', 'build', 'build-icons-wrapper-output.json');
  try {
    if (!fs.existsSync(path.dirname(outFile))) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
    }
    fs.writeFileSync(outFile, JSON.stringify({
      exitCode: code,
      totalLines: outputLines.length,
      last100Lines: last100,
    }, null, 2), 'utf8');
  } catch (e) {}
  process.exit(code == null ? 1 : code);
});

child.on('error', (err) => {
  console.error('Spawn error:', err);
  process.exit(2);
});
