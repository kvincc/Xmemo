console.log("X-note Extension Loaded!");

// --- Global variable to track the currently visible notes popover ---
let currentNotesPopover = null;
let hidePopoverTimeout = null; // Timeout for delayed hiding
let isNotesTextareaFocused = false; // <-- New flag to track focus state

// --- 1. monitor DOM changes ---
const observer = new MutationObserver(handleMutations);
observer.observe(document.body, {
  childList: true,
  subtree: true,
});

function handleMutations(mutationsList, observer) {
  for (const mutation of mutationsList) {
    if (mutation.type === "childList") {
      // Detect Added HoverCard
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const hoverCard = node.matches('[data-testid="HoverCard"]')
            ? node
            : node.querySelector('[data-testid="HoverCard"]');
          if (hoverCard && !hoverCard.dataset.xnTriggered) {
            // Check if we already triggered for this card
            hoverCard.dataset.xnTriggered = "true"; // Mark that we are processing this card
            console.log("X-note: HoverCard appeared.", hoverCard);
            processHoverCardAppearance(hoverCard);

            // Add mouseleave listener to HoverCard for hiding the popover
            hoverCard.addEventListener("mouseleave", handleMouseLeave);
            hoverCard.addEventListener("mouseenter", handleMouseEnter); // Clear timeout if mouse re-enters
          }
        }
      });

      // OPTIONAL but Recommended: Detect Removed HoverCard (might be less reliable than mouseleave)
      /*
            mutation.removedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    const hoverCard = node.matches('[data-testid="HoverCard"]') ? node : node.querySelector('[data-testid="HoverCard"]');
                    if (hoverCard && hoverCard === currentHoverCardTarget) { // Check if the removed card is the one we are tracking
                       console.log("X-note: Tracked HoverCard removed.");
                       removeNotesPopover();
                    }
                }
            });
            */
    }
  }
}


// --- 2. Handle the appearance of HoverCard ---
function processHoverCardAppearance(hoverCard) {
  // --- 2a. 识别用户 (using the robust strategy from previous version) ---
  let username = null;
  const userLinks = hoverCard.querySelectorAll('a[href^="/"]');
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
        username = text;
        break;
      }
    }
    if (username) break;
  }

  if (!username) {
    console.error(
      "X-note: Could not extract username from HoverCard.",
      hoverCard
    );
    // Clean up the trigger flag if we failed early
    delete hoverCard.dataset.xnTriggered;
    return;
  }

  const userKey = `xNote_${username}`;
  console.log(`X-note: Processing HoverCard for user: ${username}`);

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
  noteTextarea.placeholder = `Notes about ${username}...`;
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
  saveButton.textContent = "Save Note";
  saveButton.className = "x-note-save-button"; // Reuse style if applicable
  saveButton.onclick = () => {
    const noteText = noteTextarea.value.trim();
    saveNote(userKey, noteText, saveButton); // Pass button for feedback
  };

  notesPopover.appendChild(noteTextarea);
  notesPopover.appendChild(saveButton);

  // Add listeners to the popover itself to keep it open
  notesPopover.addEventListener("mouseenter", handleMouseEnter);
  notesPopover.addEventListener("mouseleave", handleMouseLeave);

  // --- 2c. 定位 Popover ---
  document.body.appendChild(notesPopover);
  const hoverCardRect = hoverCard.getBoundingClientRect();
  const popoverRect = notesPopover.getBoundingClientRect();

  // ***** DEFINE THE DESIRED GAP *****
  const gap = 10; // Set the desired gap in pixels
  // **********************************

  // --- Calculate Position ---

  // 1. Initial Top Alignment: Match HoverCard's top edge
  let top = hoverCardRect.top + window.scrollY;

  // 2. Initial Left Position: Place to the right of HoverCard with gap
  let left = hoverCardRect.right + window.scrollX + gap;

  // 3. Horizontal Overflow Check: If not enough space on the right, place it on the left
  if (left + popoverRect.width > window.innerWidth - gap) {
    // Check against viewport width minus gap
    left = hoverCardRect.left + window.scrollX - popoverRect.width - gap;
    // Double check if placing on the left also goes off-screen (rare, but possible)
    if (left < window.scrollX + gap) {
      // If both sides are tight, maybe center it above/below, or just stick to the less problematic side.
      // For simplicity, let's just stick it slightly offset from the left edge.
      left = window.scrollX + gap;
      console.warn("X-note: Popover might be cramped horizontally.");
    }
  }

  // 4. Vertical Overflow Check: Adjust top position if needed to keep popover fully visible
  if (top + popoverRect.height > window.innerHeight + window.scrollY - gap) {
    // Check against viewport height minus gap
    // Too low, align bottom edge of popover with bottom edge of viewport (minus gap)
    top = window.innerHeight + window.scrollY - popoverRect.height - gap;
  }
  if (top < window.scrollY + gap) {
    // Check against top edge of viewport plus gap
    // Too high, align top edge of popover with top edge of viewport (plus gap)
    top = window.scrollY + gap;
  }

  // --- Apply Styles ---
  notesPopover.style.position = "absolute";
  notesPopover.style.top = `${top}px`;
  notesPopover.style.left = `${left}px`;
  notesPopover.style.zIndex = "10000";
  // Store reference to the current popover
  currentNotesPopover = notesPopover;

  // --- 2d. load the note from chrome storage ---
  loadNote(userKey, noteTextarea, () => {
    adjustTextareaHeight();
    
    // 重新计算并调整弹窗位置
    const hoverCardRect = hoverCard.getBoundingClientRect();
    const popoverRect = notesPopover.getBoundingClientRect();
    
    // 重新计算位置逻辑...
    let top = hoverCardRect.top + window.scrollY;
    let left = hoverCardRect.right + window.scrollX + gap;
    
    // 检查并调整位置，确保弹窗完全可见
    if (top + popoverRect.height > window.innerHeight + window.scrollY - gap) {
      top = window.innerHeight + window.scrollY - popoverRect.height - gap;
    }
    
    if (left + popoverRect.width > window.innerWidth - gap) {
      left = hoverCardRect.left + window.scrollX - popoverRect.width - gap;
    }
    
    // 应用新位置
    notesPopover.style.top = `${top}px`;
    notesPopover.style.left = `${left}px`;
  });

  // Clear any pending hide timeout when a new card appears
  clearTimeout(hidePopoverTimeout);
}

// --- NEW: Event Handlers for Textarea Focus/Blur ---
function handleTextareaFocus() {
  console.log("X-note: Textarea focused.");
  isNotesTextareaFocused = true;
  // Immediately clear any pending hide timeout when user starts typing/focuses
  clearTimeout(hidePopoverTimeout);
}

function handleTextareaBlur() {
  console.log("X-note: Textarea blurred.");
  isNotesTextareaFocused = false;
  // Optional: We could potentially re-trigger the hide check here if the mouse
  // is already outside, but relying on the next natural mouseleave might be safer.
  // For now, just setting the flag is enough.
}

// --- 3. Hiding/Removing the Popover ---

function handleMouseEnter() {
  // When mouse enters the HoverCard or the Popover, clear the hide timeout
  clearTimeout(hidePopoverTimeout);
  console.log("X-note: Mouse entered target, clearing hide timeout.");
}

function handleMouseLeave() {
  clearTimeout(hidePopoverTimeout);
  hidePopoverTimeout = setTimeout(() => {
    // ***** CHECK FOCUS STATE BEFORE REMOVING *****
    if (!isNotesTextareaFocused) {
      console.log(
        "X-note: Mouse leave timeout triggered AND textarea not focused, removing popover."
      );
      removeNotesPopover();
    } else {
      console.log(
        "X-note: Mouse leave timeout triggered BUT textarea IS focused, NOT removing popover yet."
      );
      // Popover stays open because the user is likely still typing or interacting.
      // It will only close after the textarea loses focus AND the mouse leaves.
    }
    // *********************************************
  }, 500); // Keep a slightly longer delay (e.g., 500ms) might feel better
  console.log(
    "X-note: Mouse left target, starting hide timer (focus check pending)."
  );
}

function removeNotesPopover(immediate = false) {
  if (currentNotesPopover) {
    console.log(
      `X-note: Removing popover (immediate: ${immediate}) for ${currentNotesPopover.dataset.username}`
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

// --- 4. 存储/读取笔记 (No changes needed here, reuse from previous version) ---
function saveNote(key, note, buttonElement) {
  const data = {};
  data[key] = note;
  chrome.storage.sync.set(data, () => {
    if (chrome.runtime.lastError) {
      console.error(
        `X-note: Error saving note for ${key}:`,
        chrome.runtime.lastError
      );
      alert("Error saving note. See console for details.");
    } else {
      console.log(`X-note: Note saved for ${key}:`, note);
      if (buttonElement) {
        const originalText = buttonElement.textContent;
        buttonElement.textContent = "Saved!";
        buttonElement.disabled = true;
        setTimeout(() => {
          if (buttonElement) {
            // Check if button still exists
            buttonElement.textContent = originalText;
            buttonElement.disabled = false;
          }
        }, 1500);
      }
    }
  });
}

function loadNote(key, textareaElement, callback) {
  chrome.storage.sync.get([key], (result) => {
    if (chrome.runtime.lastError) {
      console.error(
        `X-note: Error loading note for ${key}:`,
        chrome.runtime.lastError
      );
    } else if (result[key] !== undefined) {
      textareaElement.value = result[key];
      console.log(`X-note: Note loaded for ${key}.`);
    } else {
      console.log(`X-note: No note found for ${key}.`);
      textareaElement.value = "";
    }
    
    // 执行回调函数
    if (typeof callback === 'function') {
      callback();
    }
  });
}

// --- Initial clean-up on script load (optional) ---
// This helps if the page reloads while a popover was visible
const existingPopover = document.getElementById("x-note-popover-container");
if (existingPopover) {
  existingPopover.remove();
}
