/**
 * 本地日志收集服务器
 * 用法: node devtools/log-server.js
 * 扩展中的 remoteLog() 会把日志发到这里，写入 debug.log
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9234;
const LOG_FILE = path.join(__dirname, '..', 'debug.log');

// 启动时清空日志
fs.writeFileSync(LOG_FILE, `--- 日志服务器启动: ${new Date().toISOString()} ---\n`);

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const time = new Date().toISOString().slice(11, 23);
        const level = (data.level || 'log').toUpperCase().padEnd(5);
        const source = data.source || '?';
        const line = `[${time}] [${level}] [${source}] ${data.args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`;

        fs.appendFileSync(LOG_FILE, line + '\n');
        process.stdout.write(line + '\n');
      } catch (e) {
        const line = `[${new Date().toISOString().slice(11, 23)}] [RAW] ${body}`;
        fs.appendFileSync(LOG_FILE, line + '\n');
        process.stdout.write(line + '\n');
      }
      res.writeHead(200);
      res.end('ok');
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`\n📡 日志服务器运行中: http://localhost:${PORT}`);
  console.log(`📝 日志文件: ${LOG_FILE}`);
  console.log(`   Ctrl+C 停止\n`);
});
