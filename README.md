# XStickies 浏览器扩展

XStickies 是一个 Chrome 浏览器扩展，允许用户在 X (Twitter) 平台上为任意用户添加和管理个人笔记。当鼠标悬停在用户头像或用户名上时，会显示一个笔记编辑框，让用户可以快速记录和查看关于该用户的笔记。此外，XStickies还提供了集中管理页面，可以导入导出所有笔记数据，便于备份和在不同设备间迁移。

## 功能概述

- 🔍 自动检测用户悬停卡片(HoverCard)的出现
- 📝 弹出笔记编辑界面
- 💾 自动保存笔记内容
- 🔄 实时加载已保存的笔记
- 👀 智能的显示/隐藏逻辑
- 📊 集中管理所有笔记
- 📤 导出笔记数据为JSON文件
- 📥 从JSON文件导入笔记数据
- 🔍 搜索用户名或笔记内容

## 技术架构


### 1. 核心文件结构

```
XStickies/
├── manifest.json       # 扩展配置文件
├── content.js          # 内容脚本，处理Twitter页面上的笔记功能
├── styles.css          # 内容脚本的样式文件
├── background.js       # 后台脚本，处理扩展图标点击事件
├── options.html        # 选项页面，用于管理所有笔记
├── options.css         # 选项页面的样式文件
├── options.js          # 选项页面的脚本文件
└── README.md           # 项目文档
```

### 2. manifest.json 配置说明

```json
{
  "manifest_version": 3,
  "permissions": ["storage"],
  "action": {
    "default_title": "XStickies"
  },
  "background": {
    "service_worker": "background.js"
  },
  "options_ui": {
    "page": "options.html",
    "open_in_tab": true
  },
  "content_scripts": [{
    "matches": ["https://*.x.com/*", "https://x.com/*"],
    "js": ["content.js"],
    "css": ["styles.css"]
  }]
}
```

- 使用 Manifest V3 规范
- 需要 storage 权限用于存储笔记
- 内容脚本在 X 域名下自动注入
- 定义了扩展图标和选项页面

### 3. 核心技术实现

#### 3.1 HoverCard 检测机制

使用 MutationObserver 监听 DOM 变化，实时检测 HoverCard 的出现：

```javascript
const observer = new MutationObserver(handleMutations);
observer.observe(document.body, {
  childList: true,
  subtree: true
});
```

#### 3.2 笔记弹窗管理

- 使用绝对定位创建独立的笔记弹窗
- 智能计算弹窗位置，避免超出视窗
- 处理多种边界情况（如视窗边缘）

#### 3.3 状态管理

主要状态变量：
- `currentNotesPopover`: 当前显示的笔记弹窗
- `hidePopoverTimeout`: 控制弹窗隐藏的定时器
- `isNotesTextareaFocused`: 文本框焦点状态

#### 3.4 数据存储与同步

使用 Chrome Storage API 进行笔记数据的存取：
- 键名格式：`xNote_@username`
- 异步存取操作
- 错误处理机制
- 数据跨设备同步

#### 3.5 选项页面与数据管理

- 使用Chrome的options_ui实现管理页面
- 支持搜索、编辑、删除笔记
- 提供数据导入导出功能

## 使用指南

### 1. 基本使用

1. 在X (Twitter)上浏览时，将鼠标悬停在用户头像上
2. 笔记弹窗会自动出现在悬停卡片旁边
3. 输入笔记内容并点击"保存"按钮
4. 下次悬停在同一用户上时，会自动显示保存的笔记

### 2. 笔记管理

1. 点击Chrome工具栏中的XStickies图标
2. 打开笔记管理页面，查看所有保存的笔记
3. 使用搜索框查找特定用户或笔记内容
4. 点击"编辑"按钮修改笔记内容
5. 点击"删除"按钮删除不需要的笔记

### 3. 数据备份与恢复

1. 在笔记管理页面，点击"导出所有笔记"按钮
2. 选择保存位置，将笔记数据导出为JSON文件
3. 需要恢复数据时，点击"导入笔记"按钮
4. 选择之前导出的JSON文件
5. 确认导入完成后，所有笔记将被恢复

## 样式设计

### 1. 悬停卡片笔记弹窗样式

```css
.x-note-popover {
  position: absolute;
  z-index: 10000;
  background-color: white;
  border: 1px solid rgb(207, 217, 222);
  border-radius: 8px;
  /* ... */
}
```

- 遵循 X 的设计语言
- 响应式布局
- 优雅的过渡动画

### 2. 笔记管理页面样式

- 清晰的表格布局展示所有笔记
- 搜索栏和操作按钮位于顶部
- 编辑和删除操作集成在每条笔记旁
- 导入导出按钮醒目可见
- 操作状态反馈（成功/失败提示）

## 开发注意事项

### 1. 性能考虑
- 使用防抖处理 DOM 观察
- 及时清理不需要的事件监听器
- 优化 Storage API 的使用频率
- 分页处理大量笔记数据

### 2. 边界情况
- 处理 HoverCard 快速出现/消失
- 文本框焦点状态管理
- 视窗边缘的弹窗定位
- 导入无效JSON文件的错误处理

### 3. 已知限制
- 仅支持 Chrome 和 Chromium 内核浏览器
- 依赖 X 的 DOM 结构
- Storage API 的存储限制（约100KB）
- 不支持富文本笔记格式

## 未来迭代方向

### 1. 功能增强
- [ ] 支持富文本编辑
- [ ] 添加笔记分类功能
- [ ] 添加标签系统
- [ ] 添加笔记历史记录
- [ ] 添加自动备份功能

### 2. 性能优化
- [ ] 引入虚拟滚动
- [ ] 优化大量笔记的存储方式
- [ ] 添加缓存机制
- [ ] 优化导入过程中的内存使用

### 3. 用户体验
- [ ] 自定义主题支持
- [ ] 快捷键支持
- [ ] 更多的交互动画
- [ ] 国际化支持
- [ ] 暗色模式适配

## 联系方式

[待补充]
