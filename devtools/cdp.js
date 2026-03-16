/**
 * CDP 调试工具 — 连接已运行的 Chrome (port 9222)
 *
 * 用法:
 *   node devtools/cdp.js reload        — 重新加载扩展
 *   node devtools/cdp.js logs [sec]    — 监听 console 日志 (默认 30 秒)
 *   node devtools/cdp.js errors        — 获取扩展错误列表
 *   node devtools/cdp.js screenshot [url]  — 对指定页面截图
 *   node devtools/cdp.js targets       — 列出所有调试目标
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CDP_URL = 'http://localhost:9222';
const EXT_NAME = 'XStickies'; // manifest.json 中 name 字段（或 __MSG_ext_name__ 解析后）
const PROJECT_DIR = path.resolve(__dirname, '..');
const LOG_FILE = path.join(PROJECT_DIR, 'debug.log');

async function connect() {
  try {
    const browser = await puppeteer.connect({ browserURL: CDP_URL });
    return browser;
  } catch (e) {
    console.error('❌ 无法连接 Chrome。请确保 Chrome 以 --remote-debugging-port=9222 启动');
    console.error('   启动命令:');
    console.error('   /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222');
    process.exit(1);
  }
}

// 列出所有目标
async function targets() {
  const resp = await fetch(`${CDP_URL}/json`);
  const list = await resp.json();
  console.log('\n📋 调试目标:\n');
  for (const t of list) {
    const icon = t.type === 'page' ? '📄' :
                 t.type === 'service_worker' ? '⚙️' :
                 t.type === 'background_page' ? '🔧' : '  ';
    console.log(`  ${icon} [${t.type}] ${t.title || t.url}`);
    console.log(`     ${t.url}`);
  }
  console.log(`\n共 ${list.length} 个目标`);
}

// 查找扩展 ID
async function findExtensionId() {
  const resp = await fetch(`${CDP_URL}/json`);
  const list = await resp.json();

  // 查找 service_worker 类型中包含 chrome-extension:// 的目标
  for (const t of list) {
    if (t.url && t.url.startsWith('chrome-extension://')) {
      const match = t.url.match(/chrome-extension:\/\/([^/]+)/);
      if (match) {
        // 检查是否是我们的扩展 (通过 title 或 url 中的关键字)
        if (t.title?.includes('XStickies') || t.title?.includes('xNote') ||
            t.url.includes('background') || t.url.includes('service_worker')) {
          return { id: match[1], target: t };
        }
      }
    }
  }

  // fallback: 返回第一个扩展
  for (const t of list) {
    if (t.url && t.url.startsWith('chrome-extension://')) {
      const match = t.url.match(/chrome-extension:\/\/([^/]+)/);
      if (match) return { id: match[1], target: t };
    }
  }

  return null;
}

// 重新加载扩展
async function reloadExtension() {
  const ext = await findExtensionId();
  if (!ext) {
    console.error('❌ 未找到扩展。请确保扩展已加载。');
    process.exit(1);
  }

  console.log(`🔍 找到扩展: ${ext.id}`);
  console.log(`   ${ext.target.title || ext.target.url}`);

  const browser = await connect();

  // 打开 chrome://extensions 页面执行 reload
  const page = await browser.newPage();
  await page.goto(`chrome://extensions`);

  // 通过 chrome.management API 重新加载扩展
  const result = await page.evaluate(async (extId) => {
    return new Promise((resolve) => {
      // 使用 chrome.developerPrivate API (在 extensions 页面可用)
      if (chrome.developerPrivate) {
        chrome.developerPrivate.reload(extId, { failQuietly: true }, () => {
          resolve('ok');
        });
      } else {
        resolve('no-api');
      }
    });
  }, ext.id);

  if (result === 'ok') {
    console.log('✅ 扩展已重新加载!');
  } else {
    console.log('⚠️  developerPrivate API 不可用，尝试备用方案...');
    // 备用方案: 通过 CDP 直接发命令
    const targets = await browser.targets();
    const swTarget = targets.find(t =>
      t.url().startsWith(`chrome-extension://${ext.id}`) &&
      (t.type() === 'service_worker' || t.type() === 'background_page')
    );
    if (swTarget) {
      const worker = await swTarget.worker();
      if (worker) {
        await worker.evaluate(() => chrome.runtime.reload());
        console.log('✅ 扩展已通过 service worker 重新加载!');
      }
    }
  }

  await page.close();
  browser.disconnect();
}

// 监听 console 日志
async function listenLogs(durationSec = 30) {
  const browser = await connect();
  const pages = await browser.pages();

  // 找到 x.com 的页面
  const xPages = pages.filter(p => p.url().includes('x.com') || p.url().includes('twitter.com'));

  if (xPages.length === 0) {
    console.log('⚠️  未找到 x.com 页面，监听所有页面...');
  }

  const targetPages = xPages.length > 0 ? xPages : pages.slice(0, 3);

  const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  const separator = `\n${'='.repeat(60)}\n📡 日志监听开始: ${new Date().toISOString()}\n${'='.repeat(60)}\n`;
  logStream.write(separator);
  console.log(separator);
  console.log(`📝 日志同时写入: ${LOG_FILE}`);
  console.log(`⏱  监听 ${durationSec} 秒...\n`);

  for (const page of targetPages) {
    const url = page.url();
    console.log(`  👁  监听: ${url.substring(0, 80)}`);

    page.on('console', msg => {
      const line = `[${new Date().toISOString()}] [${msg.type()}] ${msg.text()}`;
      console.log(line);
      logStream.write(line + '\n');
    });

    page.on('pageerror', err => {
      const line = `[${new Date().toISOString()}] [ERROR] ${err.message}`;
      console.error(line);
      logStream.write(line + '\n');
    });
  }

  // 也监听 service worker
  const targets = await browser.targets();
  for (const target of targets) {
    if (target.type() === 'service_worker' && target.url().startsWith('chrome-extension://')) {
      try {
        const worker = await target.worker();
        if (worker) {
          worker.on('console', msg => {
            const line = `[${new Date().toISOString()}] [SW] [${msg.type()}] ${msg.text()}`;
            console.log(line);
            logStream.write(line + '\n');
          });
          console.log(`  👁  监听 SW: ${target.url().substring(0, 80)}`);
        }
      } catch (e) { /* skip */ }
    }
  }

  await new Promise(resolve => setTimeout(resolve, durationSec * 1000));

  logStream.write(`\n--- 日志监听结束: ${new Date().toISOString()} ---\n`);
  logStream.end();
  console.log('\n⏹  监听结束');
  browser.disconnect();
}

// 获取扩展错误
async function getErrors() {
  const browser = await connect();
  const page = await browser.newPage();
  await page.goto('chrome://extensions');

  const errors = await page.evaluate(() => {
    // 尝试获取扩展错误
    return new Promise((resolve) => {
      if (chrome.developerPrivate) {
        chrome.developerPrivate.getExtensionsInfo({ includeDisabled: false }, (infos) => {
          const results = infos.map(ext => ({
            name: ext.name,
            id: ext.id,
            errors: (ext.runtimeErrors || []).map(e => ({
              message: e.message,
              source: e.source,
              line: e.lineNumber,
              timestamp: e.timestamp
            })).slice(0, 20),
            warnings: (ext.manifestErrors || []).slice(0, 10)
          })).filter(ext => ext.errors.length > 0 || ext.warnings.length > 0);
          resolve(results);
        });
      } else {
        resolve([]);
      }
    });
  });

  if (errors.length === 0) {
    console.log('✅ 没有扩展错误');
  } else {
    for (const ext of errors) {
      console.log(`\n🔴 ${ext.name} (${ext.id}):`);
      for (const err of ext.errors) {
        console.log(`   ❌ ${err.message}`);
        console.log(`      at ${err.source}:${err.line}`);
      }
      for (const warn of ext.warnings) {
        console.log(`   ⚠️  ${warn}`);
      }
    }
  }

  // 也写到 debug.log
  fs.appendFileSync(LOG_FILE, `\n--- Errors at ${new Date().toISOString()} ---\n${JSON.stringify(errors, null, 2)}\n`);

  await page.close();
  browser.disconnect();
}

// 截图
async function screenshot(targetUrl) {
  const browser = await connect();
  const pages = await browser.pages();

  let page;
  if (targetUrl) {
    page = pages.find(p => p.url().includes(targetUrl));
  } else {
    // 默认找 x.com 页面
    page = pages.find(p => p.url().includes('x.com'));
  }

  if (!page) {
    page = pages[0];
  }

  const filename = `screenshot_${Date.now()}.png`;
  const filepath = path.join(PROJECT_DIR, 'devtools', filename);
  await page.screenshot({ path: filepath, fullPage: false });
  console.log(`📸 截图已保存: devtools/${filename}`);
  console.log(`   页面: ${page.url()}`);

  browser.disconnect();
  return filepath;
}

// 主入口
async function main() {
  const cmd = process.argv[2];

  switch (cmd) {
    case 'reload':
      await reloadExtension();
      break;
    case 'logs':
      await listenLogs(parseInt(process.argv[3]) || 30);
      break;
    case 'errors':
      await getErrors();
      break;
    case 'screenshot':
      await screenshot(process.argv[3]);
      break;
    case 'targets':
      await targets();
      break;
    default:
      console.log(`
CDP 调试工具 — 连接已运行的 Chrome

用法:
  node devtools/cdp.js reload          重新加载扩展
  node devtools/cdp.js logs [秒数]     监听 console 日志 (默认 30 秒)
  node devtools/cdp.js errors          获取扩展错误列表
  node devtools/cdp.js screenshot      对 x.com 页面截图
  node devtools/cdp.js targets         列出所有调试目标

前置条件:
  Chrome 需以调试端口启动:
  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222
`);
  }
}

main().catch(console.error);
