// Bluesky DOM 探测脚本
// 用法：在 bsky.app 页面的 Console 中粘贴运行，然后悬停几个用户头像/用户名
// 完成后在 Console 输入 bskyProbe.report() 获取结果
// bskyProbe.stop() 停止探测
// create: 2026.03.16 author: CC




(function() {
  const findings = [];
  const seenHTML = new Set();

  // 监听所有新增的 DOM 节点
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        // 策略1：查找包含 data-testid 的元素
        const testIdEls = [node, ...node.querySelectorAll('[data-testid]')];
        testIdEls.forEach(el => {
          if (el.dataset?.testid) {
            const entry = {
              type: 'testid',
              testid: el.dataset.testid,
              tag: el.tagName,
              classes: el.className?.substring?.(0, 100) || '',
              childCount: el.children.length,
            };
            const key = `testid:${entry.testid}`;
            if (!seenHTML.has(key)) {
              seenHTML.add(key);
              findings.push(entry);
              console.log(`🔍 [data-testid="${entry.testid}"]`, el);
            }
          }
        });

        // 策略2：查找看起来像悬停卡片/弹出层的元素
        // 通常是 position:fixed/absolute 的浮动层，包含用户信息
        const style = window.getComputedStyle(node);
        if (style.position === 'fixed' || style.position === 'absolute') {
          // 检查是否包含头像、关注按钮等典型 profile 卡片内容
          const text = node.textContent?.substring(0, 500) || '';
          const hasAvatar = !!node.querySelector('img[src*="avatar"], img[src*="cdn"]');
          const hasFollowBtn = text.includes('Follow') || text.includes('关注');
          const hasHandle = /@[\w.-]+/.test(text);

          if ((hasAvatar || hasFollowBtn || hasHandle) && text.length > 20) {
            const html = node.outerHTML.substring(0, 2000);
            const htmlKey = html.substring(0, 200);
            if (!seenHTML.has(htmlKey)) {
              seenHTML.add(htmlKey);

              // 提取结构信息
              const structure = {
                type: 'popup',
                tag: node.tagName,
                position: style.position,
                role: node.getAttribute('role'),
                ariaLabel: node.getAttribute('aria-label'),
                dataAttrs: [...node.attributes]
                  .filter(a => a.name.startsWith('data-'))
                  .map(a => `${a.name}="${a.value}"`),
                classes: node.className?.substring?.(0, 200) || '',
                hasAvatar,
                hasFollowBtn,
                hasHandle,
                handleMatch: text.match(/@[\w.-]+/)?.[0] || null,
                textPreview: text.substring(0, 300),
                childStructure: [...node.children].map(c => ({
                  tag: c.tagName,
                  role: c.getAttribute('role'),
                  testid: c.dataset?.testid,
                  classes: c.className?.substring?.(0, 80) || '',
                })),
                // 尝试找到用户链接
                links: [...node.querySelectorAll('a[href*="/profile/"]')].map(a => ({
                  href: a.getAttribute('href'),
                  text: a.textContent?.substring(0, 100),
                })),
              };

              findings.push(structure);
              console.log('🎯 疑似悬停卡片:', structure, node);
            }
          }
        }

        // 策略3：查找 role="tooltip" 或 role="dialog" 等弹出层
        const popups = [node, ...node.querySelectorAll('[role="tooltip"], [role="dialog"], [role="menu"]')];
        popups.forEach(el => {
          if (!el.getAttribute('role')) return;
          const text = el.textContent?.substring(0, 200) || '';
          const key = `role:${el.getAttribute('role')}:${text.substring(0, 50)}`;
          if (!seenHTML.has(key) && text.length > 10) {
            seenHTML.add(key);
            findings.push({
              type: 'role-popup',
              role: el.getAttribute('role'),
              tag: el.tagName,
              dataAttrs: [...el.attributes]
                .filter(a => a.name.startsWith('data-'))
                .map(a => `${a.name}="${a.value}"`),
              textPreview: text.substring(0, 300),
              hasHandle: /@[\w.-]+/.test(text),
              links: [...el.querySelectorAll('a[href*="/profile/"]')].map(a => ({
                href: a.getAttribute('href'),
                text: a.textContent?.substring(0, 100),
              })),
            });
            console.log(`🏷️ [role="${el.getAttribute('role')}"]`, el);
          }
        });
      });
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // 暴露报告函数
  window.bskyProbe = {
    report() {
      console.log('\n\n========== BLUESKY DOM 探测报告 ==========\n');
      console.log(JSON.stringify(findings, null, 2));
      console.log('\n==========================================');
      console.log(`共发现 ${findings.length} 个元素`);

      // 也复制到剪贴板
      const text = JSON.stringify(findings, null, 2);
      navigator.clipboard.writeText(text).then(() => {
        console.log('✅ 报告已复制到剪贴板，直接粘贴给 Claude Code 即可');
      }).catch(() => {
        console.log('⚠️ 无法自动复制，请手动选中上面的 JSON 复制');
      });

      return `共 ${findings.length} 个发现（已复制到剪贴板）`;
    },
    stop() {
      observer.disconnect();
      console.log('⏹️ 探测已停止');
    },
    findings,
  };

  console.log('✅ Bluesky DOM 探测已启动');
  console.log('👉 现在去悬停一些用户头像/用户名');
  console.log('👉 完成后输入: bskyProbe.report()');
  console.log('👉 停止探测: bskyProbe.stop()');
})();
