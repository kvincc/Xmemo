// XStickies Extension
// lib/constants.js and lib/storage-adapter.js are loaded before this file via manifest.json
const XNOTE_DEBUG = false;
const XNOTE_REMOTE_LOG = true; // 远程日志开关

// --- X.com DOM 选择器（集中管理，便于未来热更新） ---
const X_SELECTORS = {
  HOVER_CARD: '[data-testid="hoverCardParent"]',
  TWEET: '[data-testid="tweet"]',
  USER_NAME: '[data-testid="User-Name"]',
  USER_LINK: 'a[href^="/"]',
};

function debugLog(...args) {
  if (XNOTE_DEBUG) console.log(...args);
  if (XNOTE_REMOTE_LOG) remoteLog('log', 'content', ...args);
}

function remoteLog(level, source, ...args) {
  fetch('http://localhost:9234', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, source, args }),
  }).catch(() => {}); // 服务器没开就静默忽略
}

// --- i18n helper (delegated to xnoteI18n module) ---
const t = xnoteI18n.t;

// --- Global variable to track the currently visible notes popover ---
let currentNotesPopover = null;
let hidePopoverTimeout = null; // Timeout for delayed hiding
let isNotesTextareaFocused = false; // <-- New flag to track focus state
let observer = null; // Store observer reference for cleanup
let processedHoverCards = new WeakSet(); // Track processed cards to prevent memory leaks

// --- Theme detection for X dark/dim mode ---
function detectXTheme() {
  const bgColor = getComputedStyle(document.body).backgroundColor;
  if (bgColor === 'rgb(0, 0, 0)') return 'dark';
  if (bgColor === 'rgb(21, 32, 43)') return 'dim';
  return 'light';
}

function applyThemeToPopover() {
  if (currentNotesPopover) {
    const theme = detectXTheme();
    currentNotesPopover.dataset.theme = theme;
    try { chrome.storage.local.set({ 'xNote_detectedTheme': theme }); } catch (e) { /* context may be invalidated */ }
  }
}

// --- Timeline note indicator cache ---
let notedUsersCache = new Set();

function refreshNotedUsersCache() {
  storageAdapter.get(null, (result) => {
    notedUsersCache.clear();
    // Read trash meta to exclude trashed notes
    const trashMeta = storageAdapter.isLoggedIn()
      ? (result[XNOTE_SYNC.KEY_NOTE_META] || {})
      : (result[XNOTE_SYNC.KEY_TRASH_META] || {});
    for (const key of Object.keys(result)) {
      if (key.startsWith('xNote_') && key !== 'xNote_GlobalTags' && !key.startsWith('xNoteTags_')
          && !key.startsWith('xNote_sync_') && key !== 'xNote_detectedTheme'
          && key !== 'xNote_language' && key !== 'xNote_updateAvailable' && key !== 'xNote_dismissedVersion'
          && key !== XNOTE_SYNC.KEY_TRASH_META) {
        const username = key.replace('xNote_', '');
        // Skip trashed notes
        const meta = trashMeta[username];
        if (meta && meta.trashed) continue;
        // Skip empty notes
        if (!result[key]) continue;
        notedUsersCache.add(username.toLowerCase());
      }
    }
    scanVisibleTweets();
  });
}

function scanVisibleTweets() {
  const tweets = document.querySelectorAll(X_SELECTORS.TWEET);
  tweets.forEach(tweet => processTweetForIndicator(tweet));
}

function processTweetForIndicator(tweet) {
  if (tweet.querySelector('.x-note-indicator')) return;

  const userNameContainer = tweet.querySelector(X_SELECTORS.USER_NAME);
  if (!userNameContainer) return;

  const links = userNameContainer.querySelectorAll(X_SELECTORS.USER_LINK);
  let username = null;

  for (const link of links) {
    const spans = link.querySelectorAll('span');
    for (const span of spans) {
      const text = span.textContent?.trim();
      if (text && text.startsWith('@') && text.length > 1) {
        username = text;
        break;
      }
    }
    if (username) break;
  }

  if (!username) return;

  if (notedUsersCache.has(username.toLowerCase())) {
    addNoteIndicator(userNameContainer);
  }
}

function addNoteIndicator(userNameContainer) {
  const indicator = document.createElement('span');
  indicator.className = 'x-note-indicator';
  indicator.textContent = '\uD83D\uDCDD';
  userNameContainer.appendChild(indicator);
}

// Listen for storage changes from other tabs
if (typeof chrome !== 'undefined' && chrome.storage) {
  storageAdapter.onChanged((changes, areaName) => {
    let needsRefresh = false;
    for (const key of Object.keys(changes)) {
      if (key.startsWith('xNote_') && key !== 'xNote_GlobalTags' && !key.startsWith('xNoteTags_')
          && !key.startsWith('xNote_sync_') && key !== 'xNote_detectedTheme'
          && key !== 'xNote_language' && key !== 'xNote_updateAvailable' && key !== 'xNote_dismissedVersion'
          && key !== XNOTE_SYNC.KEY_TRASH_META) {
        needsRefresh = true;
        break;
      }
    }
    if (needsRefresh) refreshNotedUsersCache();
  });

  // Re-initialize when language preference changes (e.g. from options page)
  // Debounce to prevent concurrent init() calls during rapid language switching
  let _langChangeTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.xNote_language) {
      clearTimeout(_langChangeTimer);
      _langChangeTimer = setTimeout(() => initialize(), 300);
    }
  });
}

// --- Cleanup existing observer and listeners ---
function cleanup() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  
  // Remove existing popover if any
  const existingPopover = document.getElementById("x-note-popover-container");
  if (existingPopover) {
    existingPopover.remove();
  }
  
  // Clear timeouts
  if (hidePopoverTimeout) {
    clearTimeout(hidePopoverTimeout);
    hidePopoverTimeout = null;
  }
  
  currentNotesPopover = null;
  isNotesTextareaFocused = false;
}

// --- Initialize or reinitialize the extension ---
function initialize() {
  remoteLog('info', 'content', 'XStickies content script loaded', window.location.href);
  cleanup(); // Clean up first

  // Initialize i18n first, then storage adapter
  xnoteI18n.init(() => {
    storageAdapter.init(() => {
      // Create new observer
      observer = new MutationObserver(handleMutations);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      // Load cache for timeline indicators
      refreshNotedUsersCache();

      // Write X theme to storage.local for options page to follow
      try { chrome.storage.local.set({ 'xNote_detectedTheme': detectXTheme() }); } catch (e) { /* context may be invalidated */ }

      // Check for updates (needs t() to be ready)
      checkForUpdate();
    });
  });
}

// --- Listen for extension reload ---
if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'cleanup') {
      cleanup();
    }
  });
}

// --- Sync status indicator helper ---
function updateSyncIndicator(el, status) {
  if (!el) return;
  if (!status) {
    // Read current status
    chrome.storage.local.get([XNOTE_SYNC.KEY_SYNC_STATUS], (result) => {
      const s = result[XNOTE_SYNC.KEY_SYNC_STATUS] || 'synced';
      applySyncIndicator(el, s);
    });
  } else {
    applySyncIndicator(el, status);
  }
}

function applySyncIndicator(el, status) {
  const config = {
    synced:  { text: t('sync_synced'), cls: 'synced' },
    syncing: { text: t('sync_syncing'), cls: 'syncing' },
    pending: { text: t('sync_pending'), cls: 'pending' },
    offline: { text: t('sync_offline'), cls: 'offline' },
    error:   { text: t('sync_error'), cls: 'error' },
  };
  const c = config[status] || config.synced;
  el.textContent = c.text;
  el.className = 'x-note-sync-indicator ' + c.cls;
}

// --- Version update toast ---
function showUpdateToast(version) {
  // Remove existing toast if any
  const existing = document.getElementById('x-note-update-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'x-note-update-toast';
  toast.className = 'x-note-update-toast';

  const theme = detectXTheme();
  toast.dataset.theme = theme;

  const title = document.createElement('div');
  title.className = 'x-note-toast-title';
  title.textContent = t('toast_update_title');

  const message = document.createElement('div');
  message.className = 'x-note-toast-message';
  message.textContent = t('toast_update_message', [version]);

  const actions = document.createElement('div');
  actions.className = 'x-note-toast-actions';

  const restartBtn = document.createElement('button');
  restartBtn.className = 'x-note-toast-btn x-note-toast-btn-primary';
  restartBtn.textContent = t('toast_update_action');
  restartBtn.onclick = () => {
    chrome.runtime.reload();
  };

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'x-note-toast-btn x-note-toast-btn-secondary';
  dismissBtn.textContent = t('toast_dismiss');
  dismissBtn.onclick = () => {
    chrome.storage.local.set({ xNote_dismissedVersion: version });
    toast.classList.add('x-note-toast-hide');
    setTimeout(() => toast.remove(), 300);
  };

  actions.appendChild(restartBtn);
  actions.appendChild(dismissBtn);
  toast.appendChild(title);
  toast.appendChild(message);
  toast.appendChild(actions);
  document.body.appendChild(toast);

  // Trigger entrance animation
  requestAnimationFrame(() => {
    toast.classList.add('x-note-toast-show');
  });
}

function checkForUpdate() {
  try {
    chrome.storage.local.get(['xNote_updateAvailable', 'xNote_dismissedVersion'], (r) => {
      if (chrome.runtime.lastError) return;
      if (r.xNote_updateAvailable && r.xNote_updateAvailable !== r.xNote_dismissedVersion) {
        showUpdateToast(r.xNote_updateAvailable);
      }
    });
  } catch (e) {
    // Context may be invalidated
  }
}

// --- Initialize on load ---
initialize();

/**
 * MutationObserver 的核心回调函数，用于监视整个页面的 DOM 变化。
 *
 * 此函数的主要职责是：
 * 1. 实时检测页面上何时添加了新的元素节点。
 * 2. 筛选出 Twitter/X 的用户个人资料悬浮卡（HoverCard），这些卡片通常在用户鼠标悬停在用户名上时出现。
 * 3. 一旦检测到新的、尚未处理的悬浮卡，就调用 `processHoverCardAppearance` 函数来启动笔记弹出框的创建和显示流程。
 * 4. 为悬浮卡添加鼠标进入和离开的事件监听器，以便在鼠标移开时能及时隐藏笔记弹出框，从而管理其生命周期。
 * 5. 使用 `data-xn-triggered` 属性来标记已经处理过的悬浮卡，防止重复触发，确保每个悬浮卡只处理一次。
 *
 * @param {MutationRecord[]} mutationsList - 由 MutationObserver 提供的一个包含所有 DOM 变化的 MutationRecord 对象数组。
 * @param {MutationObserver} observer - 调用此回调的 MutationObserver 实例。
 */

function handleMutations(mutationsList, observer) {
  for (const mutation of mutationsList) {
    if (mutation.type === "childList") {
      // Detect Added HoverCard
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const hoverCard = node.matches(X_SELECTORS.HOVER_CARD)
            ? node
            : node.querySelector(X_SELECTORS.HOVER_CARD);
          if (hoverCard && !processedHoverCards.has(hoverCard)) {
            processedHoverCards.add(hoverCard);
            debugLog("XStickies: HoverCard appeared.", hoverCard);
            processHoverCardAppearance(hoverCard);

            hoverCard.addEventListener("mouseleave", handleMouseLeave);
            hoverCard.addEventListener("mouseenter", handleMouseEnter);
          }

          // Detect tweets in timeline for note indicators
          const tweets = [];
          if (node.matches?.(X_SELECTORS.TWEET)) tweets.push(node);
          const childTweets = node.querySelectorAll?.(X_SELECTORS.TWEET);
          if (childTweets) tweets.push(...childTweets);
          tweets.forEach(tweet => processTweetForIndicator(tweet));
        }
      });

    }
  }
}


// --- 2. Extract username from HoverCard ---
function extractUsernameFromHoverCard(hoverCard) {
  const userLinks = hoverCard.querySelectorAll(X_SELECTORS.USER_LINK);
  for (const link of userLinks) {
    const spans = link.querySelectorAll("span");
    for (const span of spans) {
      const text = span.textContent?.trim();
      if (
        text &&
        text.startsWith("@") &&
        text.length > 1 &&
        link.getAttribute("href") === `/${text.substring(1)}`
      ) {
        return text;
      }
    }
  }
  return null;
}

// Wait for username to appear in HoverCard (DOM may load progressively)
function waitForUsername(hoverCard, maxWait = 2000) {
  return new Promise((resolve) => {
    // Try immediately first
    const immediate = extractUsernameFromHoverCard(hoverCard);
    if (immediate) return resolve(immediate);

    // Observe for changes inside the hoverCard
    const innerObserver = new MutationObserver(() => {
      const username = extractUsernameFromHoverCard(hoverCard);
      if (username) {
        innerObserver.disconnect();
        resolve(username);
      }
    });
    innerObserver.observe(hoverCard, { childList: true, subtree: true });

    // Timeout fallback
    setTimeout(() => {
      innerObserver.disconnect();
      resolve(null);
    }, maxWait);
  });
}

// --- Handle the appearance of HoverCard ---
async function processHoverCardAppearance(hoverCard) {
  // --- 2a. 识别用户 (wait for DOM to be ready) ---
  const username = await waitForUsername(hoverCard);

  if (!username) {
    remoteLog('error', 'content', 'Could not extract username from HoverCard after waiting');
    processedHoverCards.delete(hoverCard);
    return;
  }

  const userKey = `xNote_${username}`;
  debugLog(`XStickies: Processing HoverCard for user: ${username}`);

  // --- Remove any existing popover before creating a new one ---
  removeNotesPopover(true); // Pass true to clear immediately

  
  // --- 2b. create a new popover for notes ---
  const notesPopover = document.createElement("div");
  notesPopover.id = "x-note-popover-container"; // Use ID for easy selection/removal
  notesPopover.className = "x-note-popover"; // Class for styling

  // Store user key for reference, e.g., during save
  notesPopover.dataset.userKey = userKey;
  notesPopover.dataset.username = username;

  const noteTextarea = document.createElement("textarea");
  noteTextarea.placeholder = t('content_notes_placeholder', [username]);
  noteTextarea.className = "x-note-textarea";
  
  // 添加自动调整文本框高度的函数
  function adjustTextareaHeight() {
    noteTextarea.style.height = 'auto'; // 重置高度
    noteTextarea.style.height = noteTextarea.scrollHeight + 'px'; // 设置为内容高度
  }
  
  // 在文本框内容变化时调整高度
  noteTextarea.addEventListener('input', adjustTextareaHeight);

  // ***** ADD FOCUS/BLUR LISTENERS *****
  noteTextarea.addEventListener("focus", handleTextareaFocus);
  noteTextarea.addEventListener("blur", handleTextareaBlur);

  const saveButton = document.createElement("button");
  const isMac = navigator.userAgentData?.platform === 'macOS' || /Mac/.test(navigator.platform);
  saveButton.textContent = isMac ? t('content_save_mac') : t('content_save_other');
  saveButton.className = "x-note-save-button";
  saveButton.onclick = () => {
    const noteText = noteTextarea.value.trim();
    saveNote(userKey, noteText, saveButton);
  };

  // --- Tag section ---
  const tagSection = document.createElement('div');
  tagSection.className = 'x-note-tag-section';

  const tagDisplay = document.createElement('div');
  tagDisplay.className = 'x-note-tag-display';

  const tagInputRow = document.createElement('div');
  tagInputRow.className = 'x-note-tag-input-row';

  const tagInputField = document.createElement('input');
  tagInputField.type = 'text';
  tagInputField.placeholder = t('content_add_tag_placeholder');
  tagInputField.className = 'x-note-tag-input';
  tagInputField.addEventListener('focus', handleTextareaFocus);
  tagInputField.addEventListener('blur', handleTextareaBlur);

  const addTagBtn = document.createElement('button');
  addTagBtn.textContent = '+';
  addTagBtn.className = 'x-note-add-tag-btn';
  addTagBtn.onclick = () => {
    const tagName = tagInputField.value.trim();
    if (tagName) {
      addTagToDisplay(tagDisplay, tagName);
      tagInputField.value = '';
    }
  };

  tagInputField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const tagName = tagInputField.value.trim();
      if (tagName) {
        addTagToDisplay(tagDisplay, tagName);
        tagInputField.value = '';
        const suggestionsEl = tagInputRow.querySelector('.x-note-tag-suggestions');
        if (suggestionsEl) suggestionsEl.style.display = 'none';
      }
    }
  });

  tagInputRow.appendChild(tagInputField);
  tagInputRow.appendChild(addTagBtn);
  tagSection.appendChild(tagDisplay);
  tagSection.appendChild(tagInputRow);

  // Update save button to save tags too
  saveButton.onclick = () => {
    const noteText = noteTextarea.value.trim();
    const tags = collectTagsFromDisplay(tagDisplay);
    saveNoteWithTags(userKey, noteText, tags, username, saveButton);
  };

  // Keyboard shortcut: Ctrl+Enter / Cmd+Enter to save with tags
  const keyHandler = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      const noteText = noteTextarea.value.trim();
      const tags = collectTagsFromDisplay(tagDisplay);
      saveNoteWithTags(userKey, noteText, tags, username, saveButton);
    }
  };
  noteTextarea.addEventListener('keydown', keyHandler);

  const saveRow = document.createElement('div');
  saveRow.className = 'x-note-save-row';
  saveRow.appendChild(saveButton);

  notesPopover.appendChild(noteTextarea);
  notesPopover.appendChild(tagSection);
  notesPopover.appendChild(saveRow);

  // Add listeners to the popover itself to keep it open
  notesPopover.addEventListener("mouseenter", handleMouseEnter);
  notesPopover.addEventListener("mouseleave", handleMouseLeave);

  // --- 2c. 挂载 Popover (fixed 定位，挂在 body 上避免 stacking context 问题) ---
  document.body.appendChild(notesPopover);

  // --- 定义一个统一的定位函数 (基于 getBoundingClientRect + viewport 边界检查) ---
  function positionPopover() {
    const hoverCardRect = hoverCard.getBoundingClientRect();

    // 防护：hoverCard 在 (0,0) 说明 X 还没把它移到正确位置，跳过
    if (hoverCardRect.left === 0 && hoverCardRect.top === 0) {
      remoteLog('warn', 'content', 'positionPopover skipped: hoverCard at (0,0), waiting...');
      return;
    }

    const gap = 10;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const popoverWidth = notesPopover.offsetWidth || 300;
    const popoverHeight = notesPopover.offsetHeight || 100;

    // 水平定位：优先放 HoverCard 右侧
    let left = hoverCardRect.right + gap;
    if (left + popoverWidth > viewportWidth - gap) {
      left = hoverCardRect.left - popoverWidth - gap;
    }
    if (left < gap) left = gap;
    if (left + popoverWidth > viewportWidth - gap) {
      left = viewportWidth - popoverWidth - gap;
    }

    // 垂直定位：顶部对齐 HoverCard
    let top = hoverCardRect.top;
    if (top + popoverHeight > viewportHeight - gap) {
      top = viewportHeight - popoverHeight - gap;
    }
    if (top < gap) top = gap;

    notesPopover.style.left = `${left}px`;
    notesPopover.style.top = `${top}px`;
    notesPopover.style.bottom = 'auto';
    remoteLog('log', 'content', `positionPopover: left=${left.toFixed(0)} top=${top.toFixed(0)} hoverCard=(${hoverCardRect.left.toFixed(0)},${hoverCardRect.top.toFixed(0)},${hoverCardRect.width.toFixed(0)}x${hoverCardRect.height.toFixed(0)})`);
  }

  // --- 初始定位：轮询等待 hoverCard 移到正确位置 ---
  function waitAndPosition(retries = 10) {
    const rect = hoverCard.getBoundingClientRect();
    if (rect.left === 0 && rect.top === 0 && retries > 0) {
      requestAnimationFrame(() => waitAndPosition(retries - 1));
    } else {
      positionPopover();
    }
  }
  waitAndPosition();
  
  // Store reference to the current popover
  currentNotesPopover = notesPopover;
  applyThemeToPopover();

  // --- 2d. load the note and tags from chrome storage ---
  loadNote(userKey, noteTextarea, () => {
    adjustTextareaHeight();
    positionPopover();
  });

  // Load tags for this user
  const tagKey = `xNoteTags_${username}`;
  storageAdapter.get([tagKey, 'xNote_GlobalTags'], (result) => {
    const existingTags = result[tagKey] || [];
    const allGlobalTags = result['xNote_GlobalTags'] || {};
    renderPopoverTags(tagDisplay, existingTags);
    setupTagAutocomplete(tagInputField, tagDisplay, allGlobalTags, tagInputRow);
    positionPopover();
  });

  // Clear any pending hide timeout when a new card appears
  clearTimeout(hidePopoverTimeout);
}

// --- NEW: Event Handlers for Textarea Focus/Blur ---
function handleTextareaFocus() {
  debugLog("XStickies: Textarea focused.");
  isNotesTextareaFocused = true;
  // Immediately clear any pending hide timeout when user starts typing/focuses
  clearTimeout(hidePopoverTimeout);
}

function handleTextareaBlur() {
  debugLog("XStickies: Textarea blurred.");
  isNotesTextareaFocused = false;
  // Optional: We could potentially re-trigger the hide check here if the mouse
  // is already outside, but relying on the next natural mouseleave might be safer.
  // For now, just setting the flag is enough.
}

// --- 3. Hiding/Removing the Popover ---

function handleMouseEnter() {
  // When mouse enters the HoverCard or the Popover, clear the hide timeout
  clearTimeout(hidePopoverTimeout);
  debugLog("XStickies: Mouse entered target, clearing hide timeout.");
}

function handleMouseLeave() {
  clearTimeout(hidePopoverTimeout);
  hidePopoverTimeout = setTimeout(() => {
    // ***** CHECK FOCUS STATE BEFORE REMOVING *****
    if (!isNotesTextareaFocused) {
      debugLog(
        "XStickies: Mouse leave timeout triggered AND textarea not focused, removing popover."
      );
      removeNotesPopover();
    } else {
      debugLog(
        "XStickies: Mouse leave timeout triggered BUT textarea IS focused, NOT removing popover yet."
      );
      // Popover stays open because the user is likely still typing or interacting.
      // It will only close after the textarea loses focus AND the mouse leaves.
    }
    // *********************************************
  }, 500);
  debugLog(
    "XStickies: Mouse left target, starting hide timer (focus check pending)."
  );
}

function removeNotesPopover(immediate = false) {
  if (currentNotesPopover) {
    debugLog(
      `XStickies: Removing popover (immediate: ${immediate}) for ${currentNotesPopover.dataset.username}`
    );

    // ***** CLEAN UP FOCUS/BLUR LISTENERS *****
    const textarea = currentNotesPopover.querySelector(".x-note-textarea");
    if (textarea) {
      textarea.removeEventListener("focus", handleTextareaFocus);
      textarea.removeEventListener("blur", handleTextareaBlur);
    }
    // ****************************************

    // Reset focus flag just in case
    isNotesTextareaFocused = false;

    currentNotesPopover.removeEventListener("mouseenter", handleMouseEnter);
    currentNotesPopover.removeEventListener("mouseleave", handleMouseLeave);

    // Clean up listeners on the original HoverCard (if applicable/needed)
    // ... (potential code to find and remove listeners from hoverCard) ...

    currentNotesPopover.remove();
    currentNotesPopover = null;
  }
  if (immediate) {
    clearTimeout(hidePopoverTimeout);
  }
}

// --- Tag helpers for popover ---

function renderPopoverTags(container, tags) {
  container.innerHTML = '';
  tags.forEach(tag => {
    const tagEl = document.createElement('span');
    tagEl.className = 'x-note-tag-capsule';
    tagEl.textContent = tag;

    const removeBtn = document.createElement('span');
    removeBtn.className = 'x-note-tag-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.onclick = () => tagEl.remove();

    tagEl.appendChild(removeBtn);
    container.appendChild(tagEl);
  });
}

function addTagToDisplay(container, tagName) {
  const existing = container.querySelectorAll('.x-note-tag-capsule');
  for (const el of existing) {
    const text = el.childNodes[0]?.textContent?.trim();
    if (text && text.toLowerCase() === tagName.toLowerCase()) return;
  }

  const tagEl = document.createElement('span');
  tagEl.className = 'x-note-tag-capsule';
  tagEl.textContent = tagName;

  const removeBtn = document.createElement('span');
  removeBtn.className = 'x-note-tag-remove';
  removeBtn.textContent = '\u00d7';
  removeBtn.onclick = () => tagEl.remove();

  tagEl.appendChild(removeBtn);
  container.appendChild(tagEl);
}

function collectTagsFromDisplay(container) {
  const capsules = container.querySelectorAll('.x-note-tag-capsule');
  return Array.from(capsules).map(el => {
    const text = el.childNodes[0]?.textContent?.trim();
    return text || '';
  }).filter(t => t);
}

function setupTagAutocomplete(inputField, tagDisplay, globalTags, parentRow) {
  const suggestionsContainer = document.createElement('div');
  suggestionsContainer.className = 'x-note-tag-suggestions';
  parentRow.appendChild(suggestionsContainer);

  inputField.addEventListener('input', () => {
    const query = inputField.value.toLowerCase().trim();
    suggestionsContainer.innerHTML = '';

    if (!query) {
      suggestionsContainer.style.display = 'none';
      return;
    }

    const matches = Object.keys(globalTags)
      .filter(t => t.toLowerCase().includes(query))
      .sort((a, b) => globalTags[b] - globalTags[a])
      .slice(0, 5);

    if (matches.length === 0) {
      suggestionsContainer.style.display = 'none';
      return;
    }

    matches.forEach(tag => {
      const item = document.createElement('div');
      item.className = 'x-note-tag-suggestion-item';
      item.textContent = tag;
      item.onclick = () => {
        addTagToDisplay(tagDisplay, tag);
        inputField.value = '';
        suggestionsContainer.style.display = 'none';
      };
      suggestionsContainer.appendChild(item);
    });
    suggestionsContainer.style.display = 'block';
  });

  inputField.addEventListener('blur', () => {
    setTimeout(() => { suggestionsContainer.style.display = 'none'; }, 200);
  });
}

function saveNoteWithTags(noteKey, noteText, tags, username, buttonElement) {
  const tagKey = `xNoteTags_${username}`;

  try {
    storageAdapter.getBytesInUse(null, (bytesInUse) => {
      if (chrome.runtime.lastError) {
        console.error('XStickies: getBytesInUse error:', chrome.runtime.lastError);
        showPopoverMessage(buttonElement, t('content_save_error_check_storage'), 'error');
        return;
      }

      const maxBytes = storageAdapter.getQuota();
      if ((bytesInUse / maxBytes) * 100 > 95) {
        showPopoverMessage(buttonElement, t('content_storage_almost_full'), 'error');
        return;
      }

      storageAdapter.get([tagKey, 'xNote_GlobalTags'], (result) => {
        if (chrome.runtime.lastError) {
          console.error('XStickies: get error:', chrome.runtime.lastError);
          showPopoverMessage(buttonElement, t('content_save_error_read_tags'), 'error');
          return;
        }

        const oldTags = result[tagKey] || [];
        const globalTags = result['xNote_GlobalTags'] || {};

        // Update global tag counts
        oldTags.forEach(tag => {
          if (globalTags[tag]) {
            globalTags[tag]--;
            if (globalTags[tag] <= 0) delete globalTags[tag];
          }
        });
        tags.forEach(tag => {
          globalTags[tag] = (globalTags[tag] || 0) + 1;
        });

        const data = {};
        data[noteKey] = noteText;
        data[tagKey] = tags;
        data['xNote_GlobalTags'] = globalTags;

        storageAdapter.set(data, () => {
          if (chrome.runtime.lastError) {
            console.error(`XStickies: Error saving:`, chrome.runtime.lastError);
            showPopoverMessage(buttonElement, t('content_save_error_prefix', [chrome.runtime.lastError.message || '']), 'error');
          } else {
            debugLog(`XStickies: Note and tags saved for ${noteKey}`);
            // Update timeline indicator cache
            const usernameFromKey = noteKey.replace('xNote_', '').toLowerCase();
            if (noteText) {
              notedUsersCache.add(usernameFromKey);
            } else {
              notedUsersCache.delete(usernameFromKey);
            }
            scanVisibleTweets();
            if (buttonElement) {
              const originalText = buttonElement.textContent;
              buttonElement.textContent = t('content_saved');
              buttonElement.disabled = true;
              setTimeout(() => {
                if (buttonElement) {
                  buttonElement.textContent = originalText;
                  buttonElement.disabled = false;
                }
              }, 1500);
            }
          }
        });
      });
    });
  } catch (e) {
    console.error('XStickies: Save failed (context may be invalidated):', e);
    showPopoverMessage(buttonElement, t('content_save_error_refresh'), 'error');
  }
}

// --- 4. 存储/读取笔记 ---

function showPopoverMessage(buttonElement, message, type = 'info') {
  if (!currentNotesPopover) return;
  const existingMsg = currentNotesPopover.querySelector('.x-note-message');
  if (existingMsg) existingMsg.remove();

  const msgDiv = document.createElement('div');
  msgDiv.className = `x-note-message x-note-message-${type}`;
  msgDiv.textContent = message;

  if (buttonElement && buttonElement.parentNode) {
    buttonElement.parentNode.insertBefore(msgDiv, buttonElement);
  } else {
    currentNotesPopover.appendChild(msgDiv);
  }

  setTimeout(() => { if (msgDiv.parentNode) msgDiv.remove(); }, 5000);
}

function saveNote(key, note, buttonElement) {
  try {
  storageAdapter.getBytesInUse(null, (bytesInUse) => {
    const maxBytes = storageAdapter.getQuota();
    const usagePercent = (bytesInUse / maxBytes) * 100;

    if (usagePercent > 95) {
      showPopoverMessage(buttonElement, t('content_storage_almost_full'), 'error');
      return;
    }

    const itemSize = new Blob([JSON.stringify({ [key]: note })]).size;
    if (itemSize > 8192) {
      showPopoverMessage(buttonElement, t('content_note_too_long'), 'error');
      return;
    }

    const data = {};
    data[key] = note;
    storageAdapter.set(data, () => {
      if (chrome.runtime.lastError) {
        const errorMsg = chrome.runtime.lastError.message || '';
        console.error(`XStickies: Error saving note for ${key}:`, chrome.runtime.lastError);
        if (errorMsg.includes('QUOTA') || errorMsg.includes('quota') || errorMsg.includes('storage')) {
          showPopoverMessage(buttonElement, t('content_storage_full'), 'error');
        } else {
          showPopoverMessage(buttonElement, t('content_save_error_prefix', [errorMsg]), 'error');
        }
      } else {
        debugLog(`XStickies: Note saved for ${key}:`, note);
        if (buttonElement) {
          const originalText = buttonElement.textContent;
          buttonElement.textContent = t('content_saved');
          buttonElement.disabled = true;
          setTimeout(() => {
            if (buttonElement) {
              buttonElement.textContent = originalText;
              buttonElement.disabled = false;
            }
          }, 1500);
        }
      }
    });
  });
  } catch (e) {
    console.error('XStickies: Save failed (context may be invalidated):', e);
    showPopoverMessage(buttonElement, t('content_save_error_refresh'), 'error');
  }
}

function loadNote(key, textareaElement, callback) {
  storageAdapter.get([key], (result) => {
    if (chrome.runtime.lastError) {
      console.error(
        `XStickies: Error loading note for ${key}:`,
        chrome.runtime.lastError
      );
    } else if (result[key] !== undefined) {
      textareaElement.value = result[key];
      debugLog(`XStickies: Note loaded for ${key}.`);
    } else {
      debugLog(`XStickies: No note found for ${key}.`);
      textareaElement.value = "";
    }
    
    // 执行回调函数
    if (typeof callback === 'function') {
      callback();
    }
  });
}

