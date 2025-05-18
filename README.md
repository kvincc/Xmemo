# X-note 浏览器扩展

X-note 是一个 Chrome 浏览器扩展，允许用户在 X (Twitter) 平台上为任意用户添加和管理个人笔记。当鼠标悬停在用户头像或用户名上时，会显示一个笔记编辑框，让用户可以快速记录和查看关于该用户的笔记。

## 功能概述

- 🔍 自动检测用户悬停卡片(HoverCard)的出现
- 📝 弹出笔记编辑界面
- 💾 自动保存笔记内容
- 🔄 实时加载已保存的笔记
- 👀 智能的显示/隐藏逻辑

## 技术架构

### 1. 核心文件结构

├── manifest.json # 扩展配置文件
├── content.js # 主要业务逻辑
├── styles.css # 样式文件
└── README.md # 项目文档


### 2. manifest.json 配置说明

```json
{
  "manifest_version": 3,
  "permissions": ["storage"],
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

#### 3.4 数据存储

使用 Chrome Storage API 进行笔记数据的存取：
- 键名格式：`xNote_@username`
- 异步存取操作
- 错误处理机制

## 样式设计

### 1. 弹窗样式

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

### 2. 交互元素

- 文本框：多行输入，可调整大小
- 保存按钮：Twitter 蓝色主题
- 状态反馈：保存成功的视觉反馈

## 开发注意事项

### 1. 性能考虑
- 使用防抖处理 DOM 观察
- 及时清理不需要的事件监听器
- 优化 Storage API 的使用频率

### 2. 边界情况
- 处理 HoverCard 快速出现/消失
- 文本框焦点状态管理
- 视窗边缘的弹窗定位

### 3. 已知限制
- 仅支持 Chrome 浏览器
- 依赖 X 的 DOM 结构
- Storage API 的存储限制

## 未来迭代方向

### 1. 功能增强
- [ ] 支持富文本编辑
- [ ] 添加笔记分类功能
- [ ] 笔记导入/导出功能
- [ ] 云端同步支持

### 2. 性能优化
- [ ] 引入虚拟滚动
- [ ] 优化大量笔记的存储方式
- [ ] 添加缓存机制

### 3. 用户体验
- [ ] 自定义主题支持
- [ ] 快捷键支持
- [ ] 更多的交互动画
- [ ] 国际化支持

## 贡献指南

1. Fork 项目
2. 创建特性分支
3. 提交变更
4. 发起 Pull Request

## 许可证

[待补充]

## 联系方式

[待补充]