# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在处理本仓库代码时提供指导。

## 项目概述

X-note 是一个 Chrome 浏览器扩展，允许用户为 Twitter/X 的用户悬停卡片添加个人备注。当鼠标悬停在用户头像或用户名上时，备注编辑弹窗会出现在悬停卡片旁边，方便对任意 X 用户进行快速备注和查看。

## 架构

这是一个 Manifest V3 Chrome 扩展，包含以下核心组件：

### 文件结构
- `manifest.json` - 扩展配置和权限声明
- `content.js` - 注入到 X 页面的主内容脚本，负责悬停卡片检测和备注弹窗
- `styles.css` - X 页面上备注弹窗的样式
- `background.js` - Service Worker：打开选项页 + 同步消息路由 + API 代理 + alarms
- `options.html/css/js` - 管理界面，用于查看、编辑、导入/导出所有备注 + 登录/同步 UI
- `lib/constants.js` - 同步配置常量（API URL、Google Client ID 等）
- `lib/storage-adapter.js` - 存储抽象层（未登录→sync，已登录→local）
- `lib/auth.js` - Google OAuth + JWT 管理
- `lib/sync-manager.js` - Pull/Push/冲突合并引擎
- `worker/` - Cloudflare Worker 后端（**不打包进扩展**，独立部署到 CF）

### 关键技术组件

1. **DOM 观察系统** (`content.js`)：
   - 使用 `MutationObserver` 检测 Twitter 悬停卡片的出现
   - 搜索包含 `[data-testid="hoverCardParent"]` 的元素
   - 通过 `data-xn-triggered` 标记已处理的卡片，防止重复处理

2. **备注弹窗管理**：
   - 在悬停卡片旁边创建定位弹窗
   - 处理焦点状态和自动隐藏逻辑
   - 使用全局变量：`currentNotesPopover`、`hidePopoverTimeout`、`isNotesTextareaFocused`

3. **数据存储**：
   - 通过 `storageAdapter`（`lib/storage-adapter.js`）读写，**不要直接调用 `chrome.storage.sync`**
   - 未登录 → chrome.storage.sync；已登录 → chrome.storage.local
   - 备注键格式：`xNote_@username`，标签：`xNoteTags_@username`，全局标签：`xNote_GlobalTags`
   - `storageAdapter.set()` 会自动标记 dirty 并通知 background 调度推送

4. **选项页** (`options.js`)：
   - 在可搜索的表格中展示所有备注
   - 提供 JSON 备份的导入/导出功能
   - 包含存储用量监控

## 开发命令

本项目是纯浏览器扩展，无构建系统。开发工作流如下：

1. **加载扩展进行测试**：
   - 打开 Chrome 并访问 `chrome://extensions/`
   - 启用"开发者模式"
   - 点击"加载已解压的扩展程序"并选择项目目录

2. **测试更改**：
   - 直接修改源文件
   - 在 `chrome://extensions/` 页面点击扩展卡片上的刷新按钮
   - 重新加载 X 页面以测试内容脚本的更改

3. **调试**：
   - 内容脚本调试：在 X 页面使用浏览器开发者工具
   - 后台脚本调试：在扩展详情中点击 "service worker" 链接
   - 选项页调试：右键点击扩展图标 → 检查弹出窗口，或直接打开选项页

## 关键实现细节

### 悬停卡片检测
扩展通过以下方式监听 Twitter 的悬停卡片元素：
```javascript
const observer = new MutationObserver(handleMutations);
observer.observe(document.body, { childList: true, subtree: true });
```

### 备注弹窗定位
弹窗相对于悬停卡片定位，并通过边界检测确保不超出视口范围。定位逻辑会考虑屏幕边缘并计算最优放置位置。

### 状态管理
- `currentNotesPopover`：跟踪当前可见的备注弹窗
- `hidePopoverTimeout`：管理鼠标离开时的延迟隐藏
- `isNotesTextareaFocused`：在用户输入时阻止自动隐藏

### 存储结构
备注以 `xNote_@username` 为键存储备注文本。选项页通过 `xNote_` 前缀过滤存储键来识别备注数据。`xNote_sync_*` 前缀保留给同步元数据，收集笔记时需排除。

## 云同步架构

### 扩展端
- 所有网络请求通过 `background.js` 消息代理（避免 CORS），content/options 页发 `chrome.runtime.sendMessage`
- `background.js` 内联了 `SYNC_CONFIG` 常量（因为 service worker 不能用 content_scripts 加载 lib）
- 修改 `SYNC_CONFIG` 时需同步修改 `lib/constants.js` 中对应的值
- 保存笔记 → storageAdapter 标记 dirty → background 设 30s alarm → alarm 触发收集数据并 PUT /api/sync

### Worker 端 (`worker/`)
- Cloudflare Worker + D1，独立部署，`cd worker && wrangler deploy`
- D1 每用户存一个 gzip(JSON blob)，乐观锁（version 字段）
- 冲突时返回 409 + 服务端数据，客户端按 `updatedAt` 逐笔记 last-write-wins 合并后重推
- Rate limiting 是内存级 best-effort（Worker 重启即重置）
- 部署前需设置 secrets：`wrangler secret put JWT_SECRET` 和 `GOOGLE_CLIENT_ID`

## 内容脚本注入
扩展仅在 X 域名（`https://*.x.com/*`、`https://x.com/*`）上运行，页面加载时自动注入 `lib/constants.js` → `lib/storage-adapter.js` → `content.js`（顺序重要）。

## 常见注意事项
- Twitter 的 DOM 结构变更可能导致悬停卡片检测失效
- 弹窗定位需要针对不同屏幕尺寸进行边界检查
- 焦点管理对于正确的显示/隐藏行为至关重要
- **不要直接使用 `chrome.storage.sync`**，统一用 `storageAdapter`
- `background.js` 的 `SYNC_CONFIG` 和 `lib/constants.js` 的 `XNOTE_SYNC` 有重复的 API_URL 等值，修改时两处都要改
