document.addEventListener('DOMContentLoaded', () => {
    // --- i18n: delegate to xnoteI18n module ---
    const t = xnoteI18n.t;

    xnoteI18n.init(() => {
    xnoteI18n.applyI18n();

    // --- Language selector setup ---
    const langSelect = document.getElementById('languageSelect');
    chrome.storage.local.get('xNote_language', (r) => {
        langSelect.value = r.xNote_language || 'auto';
    });
    langSelect.addEventListener('change', (e) => {
        xnoteI18n.setLanguage(e.target.value === 'auto' ? null : e.target.value, () => {
            location.reload();
        });
    });

    // DOM elements
    const notesTableBody = document.getElementById('notesTableBody');
    const searchInput = document.getElementById('searchInput');
    const exportBtn = document.getElementById('exportBtn');
    const importBtn = document.getElementById('importBtn');
    const importFile = document.getElementById('importFile');
    const noteCount = document.getElementById('noteCount');
    const tagCount = document.getElementById('tagCount');
    const storageUsage = document.getElementById('storageUsage');
    const emptyState = document.getElementById('emptyState');
    const statusMessage = document.getElementById('statusMessage');
    const confirmationDialog = document.getElementById('confirmationDialog');
    const confirmDelete = document.getElementById('confirmDelete');
    const cancelDelete = document.getElementById('cancelDelete');

    // Tag system elements
    const toggleTagFilter = document.getElementById('toggleTagFilter');
    const filterTitle = document.querySelector('.filter-title');
    const tagFilterPanel = document.getElementById('tagFilterPanel');
    const activeTagFilters = document.getElementById('activeTagFilters');
    const clearTagFilters = document.getElementById('clearTagFilters');
    const tagSearchInput = document.getElementById('tagSearchInput');
    const tagSuggestions = document.getElementById('tagSuggestions');
    const popularTagsList = document.getElementById('popularTagsList');
    const tagEditDialog = document.getElementById('tagEditDialog');
    const editTagUsername = document.getElementById('editTagUsername');
    const tagInput = document.getElementById('tagInput');
    const tagInputSuggestions = document.getElementById('tagInputSuggestions');
    const currentTagsDisplay = document.getElementById('currentTagsDisplay');
    const saveTagEdit = document.getElementById('saveTagEdit');
    const cancelTagEdit = document.getElementById('cancelTagEdit');

    // Selection system elements
    const selectionInfoBar = document.getElementById('selectionInfoBar');
    const selectedCount = document.getElementById('selectedCount');
    const clearSelection = document.getElementById('clearSelection');
    const catchUpBtn = document.getElementById('catchUpBtn');
    const selectAllCheckbox = document.getElementById('selectAllCheckbox');

    // Trash elements
    const trashCountEl = document.getElementById('trashCount');
    const trashBanner = document.getElementById('trashBanner');
    const backToNotesBtn = document.getElementById('backToNotesBtn');
    const emptyTrashBtn = document.getElementById('emptyTrashBtn');
    const emptyTrashDialog = document.getElementById('emptyTrashDialog');
    const confirmEmptyTrash = document.getElementById('confirmEmptyTrash');
    const cancelEmptyTrash = document.getElementById('cancelEmptyTrash');

    // State
    let allNotes = [];
    let filteredNotes = [];
    let trashedNotes = []; // Notes in trash
    let isTrashView = false; // Whether we're viewing trash
    let noteToDelete = null;
    let globalTags = {};
    let activeFilters = new Set();
    let currentEditingNote = null;
    let selectedUsers = new Set(); // Track selected users

    // Load all notes and tags from active storage backend
    function loadAllNotes() {
        storageAdapter.get(null, (result) => {
            allNotes = [];
            trashedNotes = [];
            globalTags = result['xNote_GlobalTags'] || {};

            // Read trash metadata
            storageAdapter.getTrashMeta((trashMeta) => {
                // Filter keys that start with "xNote_" but exclude metadata keys
                Object.keys(result).forEach(key => {
                    if (key.startsWith('xNote_') && key !== 'xNote_GlobalTags' && !key.startsWith('xNoteTags_')
                        && !key.startsWith('xNote_sync_') && key !== 'xNote_detectedTheme'
                        && key !== 'xNote_language' && key !== 'xNote_updateAvailable' && key !== 'xNote_dismissedVersion'
                        && key !== XNOTE_SYNC.KEY_TRASH_META) {
                        const username = key.replace('xNote_', '');
                        const note = typeof result[key] === 'string' ? result[key] : '';
                        const tagKey = `xNoteTags_${username}`;
                        const tags = result[tagKey] || [];

                        // Skip empty notes (no text and no tags)
                        if (!note && tags.length === 0) return;

                        const noteItem = {
                            key,
                            username,
                            note,
                            tags: tags,
                            tagKey: tagKey,
                            originalTags: [...tags],
                            _lc_username: username.toLowerCase(),
                            _lc_note: note.toLowerCase(),
                            _lc_tags: tags.map(t => t.toLowerCase())
                        };

                        // Check if trashed
                        const meta = trashMeta[username];
                        if (meta && meta.trashed) {
                            noteItem.trashedAt = meta.trashedAt;
                            trashedNotes.push(noteItem);
                        } else {
                            allNotes.push(noteItem);
                        }
                    }
                });

                // Sort
                allNotes.sort((a, b) => a.username.localeCompare(b.username));
                trashedNotes.sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0));

                // Update filtered notes
                filterNotes(searchInput.value);

                // Update UI
                updateTable();
                updateNoteCount();
                updateTagCount();
                updatePopularTags();
                updateTrashCount();

                // Update storage usage
                updateStorageUsage();
            });
        });
    }

    // Update storage usage display
    function updateStorageUsage() {
        storageAdapter.getBytesInUse(null, (bytesInUse) => {
            const usageInKB = (bytesInUse / 1024).toFixed(2);
            storageUsage.textContent = `${usageInKB} KB`;

            // Change color based on usage percentage
            const quota = storageAdapter.getQuota();
            const usagePercentage = (bytesInUse / quota) * 100;
            if (usagePercentage > 90) {
                storageUsage.style.color = '#f4212e'; // Red for high usage
            } else if (usagePercentage > 70) {
                storageUsage.style.color = '#ffad1f'; // Orange for medium usage
            } else {
                storageUsage.style.color = '#1d9bf0'; // Default blue for low usage
            }
        });
    }

    // Filter notes based on search term and active tag filters
    function filterNotes(searchTerm) {
        let filtered = [...allNotes];
        
        // Apply text search filter
        if (searchTerm) {
            const term = searchTerm.toLowerCase();
            
            // Check for special reserved words for untagged notes
            const untaggedKeywords = ['null', 'untagged', '无标签', '未标记'];
            const isUntaggedSearch = untaggedKeywords.includes(term);
            
            if (isUntaggedSearch) {
                // Filter for notes with no tags
                filtered = filtered.filter(item => item.tags.length === 0);
            } else {
                // Normal text search (use pre-computed lowercase fields)
                filtered = filtered.filter(item =>
                    item._lc_username.includes(term) ||
                    item._lc_note.includes(term) ||
                    item._lc_tags.some(t => t.includes(term))
                );
            }
        }
        
        // Apply tag filters
        if (activeFilters.size > 0) {
            const hasUntaggedFilter = activeFilters.has('__UNTAGGED__');
            const otherFilters = Array.from(activeFilters).filter(tag => tag !== '__UNTAGGED__');
            const otherFiltersLc = otherFilters.map(t => t.toLowerCase());

            if (hasUntaggedFilter && otherFiltersLc.length > 0) {
                filtered = filtered.filter(item =>
                    item.tags.length === 0 ||
                    otherFiltersLc.every(ft => item._lc_tags.includes(ft))
                );
            } else if (hasUntaggedFilter) {
                filtered = filtered.filter(item => item.tags.length === 0);
            } else {
                filtered = filtered.filter(item =>
                    otherFiltersLc.every(ft => item._lc_tags.includes(ft))
                );
            }
        }
        
        filteredNotes = filtered;
    }

    // Update the table with current filtered notes
    function updateTable() {
        notesTableBody.innerHTML = '';
        
        if (filteredNotes.length === 0) {
            emptyState.style.display = 'block';
            document.querySelector('.table-container').style.display = 'none';
            return;
        }

        emptyState.style.display = 'none';
        document.querySelector('.table-container').style.display = 'block';

        filteredNotes.forEach(item => {
            const tr = document.createElement('tr');
            
            // Set selected class if this user is selected
            if (selectedUsers.has(item.username)) {
                tr.classList.add('selected');
            }
            
            // Checkbox cell (hidden in trash view)
            const checkboxCell = document.createElement('td');
            checkboxCell.className = 'row-checkbox-cell';
            if (!isTrashView) {
                checkboxCell.innerHTML = `
                    <input type="checkbox" class="row-checkbox" data-username="${item.username}" ${selectedUsers.has(item.username) ? 'checked' : ''}>
                `;
            }
            
            // Username cell
            const usernameCell = document.createElement('td');
            usernameCell.innerHTML = `
                <div class="username">
                <a href="https://x.com/${item.username.startsWith('@') ? item.username.slice(1) : item.username}" target="_blank" class="username-link">${item.username}</a>
                </div>
            `;
            
            // Tags cell
            const tagsCell = document.createElement('td');
            if (isTrashView) {
                const tagsHtml = item.tags.length > 0
                    ? `<div class="note-tags">${item.tags.map(tag => `<span class="tag">${escapeHTML(tag)}</span>`).join('')}</div>`
                    : '';
                tagsCell.innerHTML = tagsHtml;
            } else {
                const tagsHtml = item.tags.length > 0
                    ? `<div class="note-tags">
                        ${item.tags.map(tag => `<span class="tag">${escapeHTML(tag)}</span>`).join('')}
                        <button class="tag-edit-btn" data-username="${item.username}">${t('common_edit')}</button>
                       </div>`
                    : `<div class="note-tags">
                        <span class="no-tags" style="color: #536471; font-style: italic; font-size: 12px;"> </span>
                        <button class="tag-edit-btn" data-username="${item.username}">${t('common_add')}</button>
                       </div>`;
                tagsCell.innerHTML = tagsHtml;
            }
            
            // Note content cell
            const noteCell = document.createElement('td');
            noteCell.innerHTML = `
                <div class="note-content">${escapeHTML(item.note)}</div>
            `;
            
            // Actions cell
            const actionsCell = document.createElement('td');
            if (isTrashView) {
                actionsCell.innerHTML = `
                    <div class="note-actions">
                        <button class="restore-btn" data-key="${item.key}">${t('options_restore_btn')}</button>
                        <button class="permanent-delete-btn" data-key="${item.key}">${t('options_permanent_delete_btn')}</button>
                    </div>
                `;
            } else {
                actionsCell.innerHTML = `
                    <div class="note-actions">
                        <button class="edit-btn" data-key="${item.key}">${t('common_edit')}</button>
                        <button class="delete-btn" data-key="${item.key}">${t('common_delete')}</button>
                    </div>
                `;
            }
            
            tr.appendChild(checkboxCell);
            tr.appendChild(usernameCell);
            tr.appendChild(tagsCell);
            tr.appendChild(noteCell);
            tr.appendChild(actionsCell);
            
            notesTableBody.appendChild(tr);
        });

        // Add event listeners to action buttons
        document.querySelectorAll('.edit-btn').forEach(btn => {
            btn.addEventListener('click', handleEdit);
        });

        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', handleDelete);
        });

        document.querySelectorAll('.restore-btn').forEach(btn => {
            btn.addEventListener('click', (e) => restoreNote(e.target.dataset.key));
        });

        document.querySelectorAll('.permanent-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => permanentDeleteNote(e.target.dataset.key));
        });
        
        // Add event listeners to tag edit buttons
        document.querySelectorAll('.tag-edit-btn').forEach(btn => {
            btn.addEventListener('click', handleTagEdit);
        });
        
        // Add event listeners to row checkboxes
        document.querySelectorAll('.row-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', handleRowCheckboxChange);
        });
        
        // Update selection UI
        updateSelectionUI();
    }

    // Update note count statistics
    function updateNoteCount() {
        const hasFilters = activeFilters.size > 0 || searchInput.value.trim();
        
        if (hasFilters) {
            // Show filtered count when there are active filters or search terms
            const filteredCount = filteredNotes.length;
            const totalCount = allNotes.length;
            
            if (filteredCount === totalCount) {
                noteCount.textContent = t('options_note_count', [String(totalCount)]);
            } else {
                noteCount.textContent = t('options_note_count_filtered', [String(filteredCount), String(totalCount)]);
            }
        } else {
            // Show total count when no filters are active
            noteCount.textContent = t('options_note_count', [String(allNotes.length)]);
        }
    }

    // Update tag count statistics
    function updateTagCount() {
        const totalTags = Object.keys(globalTags).length;
        tagCount.textContent = t('options_tag_count', [String(totalTags)]);
    }

    // Update popular tags display
    function updatePopularTags() {
        const sortedTags = Object.entries(globalTags)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);
        
        popularTagsList.innerHTML = '';
        
        // Add special "untagged" filter button
        const untaggedCount = allNotes.filter(item => item.tags.length === 0).length;
        if (untaggedCount > 0) {
            const untaggedElement = createTagElement(t('options_untagged_count', [String(untaggedCount)]), false, () => toggleUntaggedFilter());
            popularTagsList.appendChild(untaggedElement);
        }
        
        sortedTags.forEach(([tag, count]) => {
            const tagElement = createTagElement(tag, false, () => toggleTagFilterFunc(tag));
            popularTagsList.appendChild(tagElement);
        });
    }

    // Create a tag element
    function createTagElement(tag, removable = false, clickHandler = null) {
        const tagSpan = document.createElement('span');
        const isUntaggedFilter = tag === '__UNTAGGED__' || tag === t('options_untagged') || tag.includes(t('options_untagged'));
        const filterKey = isUntaggedFilter ? '__UNTAGGED__' : tag;
        
        tagSpan.className = `tag ${activeFilters.has(filterKey) ? 'active' : ''}`;
        tagSpan.textContent = tag;
        
        if (clickHandler) {
            tagSpan.addEventListener('click', clickHandler);
        }
        
        if (removable) {
            tagSpan.classList.add('removable');
            const removeBtn = document.createElement('button');
            removeBtn.className = 'tag-remove';
            removeBtn.innerHTML = '×';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                removeTagFilter(filterKey);
            });
            tagSpan.appendChild(removeBtn);
        }
        
        return tagSpan;
    }

    // Toggle tag filter
    function toggleTagFilterFunc(tag) {
        if (activeFilters.has(tag)) {
            removeTagFilter(tag);
        } else {
            addTagFilter(tag);
        }
    }
    
    // Toggle untagged filter
    function toggleUntaggedFilter() {
        const untaggedFilterKey = '__UNTAGGED__';
        if (activeFilters.has(untaggedFilterKey)) {
            removeTagFilter(untaggedFilterKey);
        } else {
            addTagFilter(untaggedFilterKey);
        }
    }

    // Add tag filter
    function addTagFilter(tag) {
        activeFilters.add(tag);
        updateActiveFiltersDisplay();
        filterNotes(searchInput.value);
        updateTable();
        updateNoteCount();
        updatePopularTags();
    }

    // Remove tag filter
    function removeTagFilter(tag) {
        activeFilters.delete(tag);
        updateActiveFiltersDisplay();
        filterNotes(searchInput.value);
        updateTable();
        updateNoteCount();
        updatePopularTags();
    }

    // Update active filters display
    function updateActiveFiltersDisplay() {
        activeTagFilters.innerHTML = '';
        
        if (activeFilters.size === 0) {
            clearTagFilters.style.display = 'none';
            return;
        }
        
        clearTagFilters.style.display = 'inline-block';
        
        Array.from(activeFilters).forEach(tag => {
            const displayTag = tag === '__UNTAGGED__' ? t('options_untagged') : tag;
            const tagElement = createTagElement(displayTag, true);
            activeTagFilters.appendChild(tagElement);
        });
    }

    // Handle tag edit dialog
    function handleTagEdit(e) {
        const username = e.target.dataset.username;
        const noteItem = allNotes.find(item => item.username === username);
        
        if (!noteItem) return;
        
        currentEditingNote = noteItem;
        editTagUsername.textContent = username;
        tagInput.value = noteItem.tags.join(', '); // Always use English comma for consistency
        updateCurrentTagsDisplay();
        
        tagEditDialog.style.display = 'flex';
        tagInput.focus();
    }

    // Split tags by both English and Chinese commas
    function splitTags(input) {
        return input.split(/[,，]/).map(t => t.trim()).filter(t => t);
    }

    // Update current tags display in edit dialog
    function updateCurrentTagsDisplay() {
        const rawTags = splitTags(tagInput.value);
        // Remove duplicates while preserving order
        const uniqueTags = [...new Set(rawTags)];
        
        currentTagsDisplay.innerHTML = '';
        
        if (uniqueTags.length === 0) {
            currentTagsDisplay.innerHTML = `<span style="color: #536471; font-style: italic;">${t('options_no_tags')}</span>`;
            return;
        }
        
        uniqueTags.forEach(tag => {
            const tagElement = createTagElement(tag);
            currentTagsDisplay.appendChild(tagElement);
        });
        
        // Show duplicate warning if needed
        if (rawTags.length !== uniqueTags.length) {
            const warningSpan = document.createElement('span');
            warningSpan.style.cssText = 'color: #ffad1f; font-size: 11px; font-style: italic; margin-left: 8px;';
            warningSpan.textContent = t('options_duplicate_tags_removed');
            currentTagsDisplay.appendChild(warningSpan);
        }
    }

    // Save tags for current note
    function saveTagsForNote(username, tags) {
        // Use splitTags function to handle both English and Chinese commas
        const allTags = Array.isArray(tags) ? tags : splitTags(tags.join(','));
        const trimmedTags = allTags.filter(tag => tag.trim()).map(tag => tag.trim());
        const validTags = [];
        const seenTags = new Set();
        
        trimmedTags.forEach(tag => {
            const lowerTag = tag.toLowerCase();
            if (!seenTags.has(lowerTag)) {
                seenTags.add(lowerTag);
                validTags.push(tag); // Keep original case
            }
        });
        
        const noteItem = allNotes.find(item => item.username === username);
        
        if (!noteItem) return;
        
        // Update local data
        noteItem.tags = validTags;
        
        // Update global tags count
        updateGlobalTags(noteItem.tags, noteItem.originalTags || []);
        
        // Save to storage
        const data = {};
        data[noteItem.tagKey] = validTags;
        data['xNote_GlobalTags'] = globalTags;
        
        storageAdapter.set(data, () => {
            if (chrome.runtime.lastError) {
                console.error('Error saving tags:', chrome.runtime.lastError);
                showStatusMessage(t('options_tag_save_failed'), 'error');
            } else {
                showStatusMessage(t('options_tag_save_success'), 'success');
                noteItem.originalTags = [...validTags];
                updateTable();
                updateTagCount();
                updatePopularTags();
            }
        });
    }

    // Update global tags count
    function updateGlobalTags(newTags, oldTags) {
        // Remove old tags
        oldTags.forEach(tag => {
            if (globalTags[tag]) {
                globalTags[tag]--;
                if (globalTags[tag] <= 0) {
                    delete globalTags[tag];
                }
            }
        });
        
        // Add new tags
        newTags.forEach(tag => {
            globalTags[tag] = (globalTags[tag] || 0) + 1;
        });
    }

    // Show tag suggestions
    function showTagSuggestions(input, container, callback) {
        const query = input.value.toLowerCase().trim();
        const suggestions = Object.keys(globalTags)
            .filter(tag => tag.toLowerCase().includes(query))
            .sort((a, b) => globalTags[b] - globalTags[a])
            .slice(0, 8);
        
        if (suggestions.length === 0 || !query) {
            container.style.display = 'none';
            return;
        }
        
        container.innerHTML = '';
        suggestions.forEach(tag => {
            const item = document.createElement('div');
            item.className = 'tag-suggestion-item';
            item.innerHTML = `
                <span>${escapeHTML(tag)}</span>
                <span class="tag-suggestion-count">${globalTags[tag]}</span>
            `;
            item.addEventListener('click', () => callback(tag));
            container.appendChild(item);
        });
        
        container.style.display = 'block';
    }

    // Handle edit button click
    function handleEdit(e) {
        const key = e.target.dataset.key;
        const noteItem = allNotes.find(item => item.key === key);
        
        if (!noteItem) return;
        
        const tr = e.target.closest('tr');
        const noteCell = tr.querySelector('.note-content');
        
        // Get original content from the noteItem data, not from DOM
        // This preserves the original newlines that were stored
        const originalContent = noteItem.note;
        
        // Create textarea element properly to avoid HTML escaping issues
        const textarea = document.createElement('textarea');
        textarea.className = 'edit-textarea';
        textarea.value = originalContent; // Set value directly, no HTML escaping needed
        
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'edit-actions';
        actionsDiv.innerHTML = `
            <button class="save-edit-btn">${t('common_save')}</button>
            <button class="cancel-edit-btn">${t('common_cancel')}</button>
        `;
        
        noteCell.innerHTML = '';
        noteCell.appendChild(textarea);
        noteCell.appendChild(actionsDiv);
        
        // Add event listeners to save and cancel buttons
        const saveBtn = tr.querySelector('.save-edit-btn');
        const cancelBtn = tr.querySelector('.cancel-edit-btn');
        
        saveBtn.addEventListener('click', () => {
            const newContent = textarea.value; // Get value from the textarea element directly
            saveEditedNote(key, newContent, noteCell);
        });
        
        cancelBtn.addEventListener('click', () => {
            // Use original content from noteItem data to preserve newlines
            noteCell.innerHTML = `<div class="note-content">${escapeHTML(originalContent)}</div>`;
        });
    }

    // Save edited note
    function saveEditedNote(key, newContent, noteCell) {
        const data = {};
        data[key] = newContent;
        
        storageAdapter.set(data, () => {
            if (chrome.runtime.lastError) {
                showStatusMessage(t('options_save_failed', [chrome.runtime.lastError.message]), 'error');
                return;
            }

            // Update UI
            noteCell.innerHTML = `<div class="note-content">${escapeHTML(newContent)}</div>`;

            // Update in-memory notes
            const noteIndex = allNotes.findIndex(item => item.key === key);
            if (noteIndex !== -1) {
                allNotes[noteIndex].note = newContent;

                // Update filtered notes if needed
                const filteredIndex = filteredNotes.findIndex(item => item.key === key);
                if (filteredIndex !== -1) {
                    filteredNotes[filteredIndex].note = newContent;
                }
            }

            showStatusMessage(t('options_note_updated'), 'success');
            
            // Update storage usage after save
            updateStorageUsage();
        });
    }

    // Handle delete button click
    function handleDelete(e) {
        const key = e.target.dataset.key;
        noteToDelete = key;
        
        // Show confirmation dialog
        confirmationDialog.style.display = 'flex';
    }

    // Move a note to trash (soft delete)
    function deleteNote(key) {
        const noteItem = allNotes.find(item => item.key === key);
        if (!noteItem) return;
        const tagsToRemove = noteItem.tags;

        storageAdapter.trashNote([key], () => {
            // Update global tags: decrement counts for trashed note
            if (tagsToRemove.length > 0) {
                tagsToRemove.forEach(tag => {
                    if (globalTags[tag]) {
                        globalTags[tag]--;
                        if (globalTags[tag] <= 0) {
                            delete globalTags[tag];
                        }
                    }
                });

                storageAdapter.set({ 'xNote_GlobalTags': globalTags }, () => {
                    if (chrome.runtime.lastError) {
                        console.error('Error updating global tags after trash:', chrome.runtime.lastError);
                    }
                });
            }

            // Move from allNotes to trashedNotes
            noteItem.trashedAt = Date.now();
            allNotes = allNotes.filter(item => item.key !== key);
            filteredNotes = filteredNotes.filter(item => item.key !== key);
            trashedNotes.unshift(noteItem);

            // Update UI
            updateTable();
            updateNoteCount();
            updateTagCount();
            updatePopularTags();
            updateTrashCount();

            showStatusMessage(t('options_note_trashed'), 'success');
            updateStorageUsage();
        });
    }

    // Restore a note from trash
    function restoreNote(key) {
        const noteItem = trashedNotes.find(item => item.key === key);
        if (!noteItem) return;

        storageAdapter.restoreNote([key], () => {
            // Re-add tags to global counts
            if (noteItem.tags.length > 0) {
                noteItem.tags.forEach(tag => {
                    globalTags[tag] = (globalTags[tag] || 0) + 1;
                });
                storageAdapter.set({ 'xNote_GlobalTags': globalTags });
            }

            // Move from trashedNotes to allNotes
            delete noteItem.trashedAt;
            trashedNotes = trashedNotes.filter(item => item.key !== key);
            allNotes.push(noteItem);
            allNotes.sort((a, b) => a.username.localeCompare(b.username));

            // Update UI
            if (isTrashView) {
                filteredNotes = [...trashedNotes];
            } else {
                filterNotes(searchInput.value);
            }
            updateTable();
            updateNoteCount();
            updateTagCount();
            updatePopularTags();
            updateTrashCount();

            showStatusMessage(t('options_note_restored'), 'success');
            updateStorageUsage();
        });
    }

    // Permanently delete a single note
    function permanentDeleteNote(key) {
        const noteItem = trashedNotes.find(item => item.key === key);
        if (!noteItem) return;

        storageAdapter.permanentDelete([key], () => {
            trashedNotes = trashedNotes.filter(item => item.key !== key);
            filteredNotes = filteredNotes.filter(item => item.key !== key);

            updateTable();
            updateTrashCount();
            showStatusMessage(t('options_note_deleted'), 'success');
            updateStorageUsage();
        });
    }

    // Empty all trash
    function emptyAllTrash() {
        if (trashedNotes.length === 0) return;
        const keys = trashedNotes.map(item => item.key);
        storageAdapter.permanentDelete(keys, () => {
            trashedNotes = [];
            if (isTrashView) {
                filteredNotes = [];
            }
            updateTable();
            updateTrashCount();
            showStatusMessage(t('options_note_deleted'), 'success');
            updateStorageUsage();
        });
    }

    // Update trash count display
    function updateTrashCount() {
        if (trashedNotes.length > 0) {
            trashCountEl.textContent = t('options_trash_count', [String(trashedNotes.length)]);
            trashCountEl.style.display = '';
        } else {
            trashCountEl.style.display = 'none';
            // If in trash view and no more items, switch back
            if (isTrashView) {
                switchToNotesView();
            }
        }
    }

    // Switch to trash view
    function switchToTrashView() {
        isTrashView = true;
        trashBanner.style.display = 'block';
        selectionInfoBar.style.display = 'none';
        document.querySelector('.search-container').style.display = 'none';
        filteredNotes = [...trashedNotes];
        updateTable();
    }

    // Switch back to notes view
    function switchToNotesView() {
        isTrashView = false;
        trashBanner.style.display = 'none';
        document.querySelector('.search-container').style.display = '';
        filterNotes(searchInput.value);
        updateTable();
        updateNoteCount();
    }

    // Export all notes to a JSON file
    function exportNotes() {
        if (allNotes.length === 0) {
            showStatusMessage(t('options_no_notes_to_export'), 'error');
            return;
        }
        
        // Get all data from storage
        storageAdapter.get(null, (result) => {
            // Prepare export data including notes, tags, and global tags
            const exportData = {};
            
            // Export notes
            allNotes.forEach(item => {
                exportData[item.key] = item.note;
                if (item.tags.length > 0) {
                    exportData[item.tagKey] = item.tags;
                }
            });
            
            // Export global tags
            if (Object.keys(globalTags).length > 0) {
                exportData['xNote_GlobalTags'] = globalTags;
            }
            
            // Create a blob and download link
            const jsonString = JSON.stringify(exportData, null, 2);
            const blob = new Blob([jsonString], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            
            // Create temporary download link
            const a = document.createElement('a');
            a.href = url;
            a.download = `XStickies-export-${new Date().toISOString().slice(0,10)}.json`;
            a.click();
            
            // Clean up
            URL.revokeObjectURL(url);
            showStatusMessage(t('options_export_success'), 'success');
        });
    }

    // Import notes from a JSON file
    function importNotes(file) {
        const reader = new FileReader();
        
        reader.onload = (e) => {
            try {
                const importData = JSON.parse(e.target.result);
                
                // Validate import data
                let validCount = 0;
                const validData = {};
                
                Object.keys(importData).forEach(key => {
                    if (key.startsWith('xNote_') && !key.startsWith('xNoteTags_') && key !== 'xNote_GlobalTags') {
                        // Note data
                        if (typeof importData[key] === 'string') {
                            validData[key] = importData[key];
                            validCount++;
                        }
                    } else if (key.startsWith('xNoteTags_')) {
                        // Tag data
                        if (Array.isArray(importData[key])) {
                            validData[key] = importData[key];
                        }
                    } else if (key === 'xNote_GlobalTags') {
                        // Global tags data
                        if (typeof importData[key] === 'object' && importData[key] !== null) {
                            validData[key] = importData[key];
                        }
                    }
                });
                
                if (validCount === 0) {
                    showStatusMessage(t('options_import_no_valid_data'), 'error');
                    return;
                }
                
                // Import into active storage backend
                if (typeof chrome !== 'undefined' && chrome.storage) {
                    storageAdapter.set(validData, () => {
                        if (chrome.runtime.lastError) {
                            showStatusMessage(t('options_import_failed', [chrome.runtime.lastError.message]), 'error');
                            return;
                        }
                        
                        showStatusMessage(t('options_import_success', [String(validCount)]), 'success');
                        loadAllNotes(); // Reload all notes
                        
                        // Update storage usage after import
                        updateStorageUsage();
                    });
                } else {
                    // Fallback for testing outside extension environment
                    showStatusMessage(t('options_import_parse_success', [String(validCount)]), 'success');
                }
                
            } catch (error) {
                console.error('Import error:', error);
                if (error instanceof SyntaxError) {
                    showStatusMessage(t('options_import_json_error'), 'error');
                } else {
                    showStatusMessage(t('options_import_failed', [error.message]), 'error');
                }
            }
        };
        
        reader.onerror = () => {
            showStatusMessage(t('options_file_read_error'), 'error');
        };
        
        reader.readAsText(file);
    }

    // Show status message
    function showStatusMessage(message, type = 'info') {
        statusMessage.textContent = message;
        statusMessage.className = 'status-message';
        statusMessage.classList.add(type);
        statusMessage.classList.add('show');
        
        setTimeout(() => {
            statusMessage.classList.remove('show');
        }, 3000);
    }

    // Helper function to escape HTML
    function escapeHTML(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;')
            .replace(/\n/g, '<br>');
    }
    
    // Selection management functions
    function handleRowCheckboxChange(e) {
        const username = e.target.dataset.username;
        const isChecked = e.target.checked;
        
        if (isChecked) {
            selectedUsers.add(username);
        } else {
            selectedUsers.delete(username);
        }
        
        updateSelectionUI();
        updateTableRowStyles();
    }
    
    function handleSelectAllChange(e) {
        const isChecked = e.target.checked;
        
        if (isChecked) {
            // Select all visible users
            filteredNotes.forEach(item => {
                selectedUsers.add(item.username);
            });
        } else {
            // Deselect all users
            selectedUsers.clear();
        }
        
        updateSelectionUI();
        updateTable(); // Rebuild table to update checkboxes
    }
    
    function updateSelectionUI() {
        const count = selectedUsers.size;
        
        if (count > 0) {
            selectionInfoBar.style.display = 'block';
            selectedCount.textContent = t('options_selected_count', [String(count)]);
            catchUpBtn.disabled = false;
        } else {
            selectionInfoBar.style.display = 'none';
            catchUpBtn.disabled = true;
        }
        
        // Update select all checkbox state
        const visibleUsernames = new Set(filteredNotes.map(item => item.username));
        const selectedVisibleUsers = Array.from(selectedUsers).filter(username => visibleUsernames.has(username));
        
        if (selectedVisibleUsers.length === 0) {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = false;
        } else if (selectedVisibleUsers.length === filteredNotes.length) {
            selectAllCheckbox.checked = true;
            selectAllCheckbox.indeterminate = false;
        } else {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = true;
        }
    }
    
    function updateTableRowStyles() {
        document.querySelectorAll('#notesTableBody tr').forEach(row => {
            const checkbox = row.querySelector('.row-checkbox');
            if (checkbox && checkbox.checked) {
                row.classList.add('selected');
            } else {
                row.classList.remove('selected');
            }
        });
    }
    
    function clearAllSelections() {
        selectedUsers.clear();
        updateSelectionUI();
        updateTable();
    }
    
    function generateXSearchURL() {
        if (selectedUsers.size === 0) return '';
        
        // Convert usernames to search format (remove @ if present)
        const searchTerms = Array.from(selectedUsers).map(username => {
            const cleanUsername = username.startsWith('@') ? username.slice(1) : username;
            return `from:${cleanUsername}`;
        });
        
        // Create search query: (from:user1 or from:user2 or from:user3)
        const searchQuery = `(${searchTerms.join(' or ')}) -filter:replies`;
        
        // URL encode the search query
        const encodedQuery = encodeURIComponent(searchQuery);
        
        // Construct final URL
        return `https://x.com/search?q=${encodedQuery}&src=typed_query&f=live`;
    }
    
    function handleCatchUpOnX() {
        if (selectedUsers.size === 0) return;
        
        const searchURL = generateXSearchURL();
        if (searchURL) {
            window.open(searchURL, '_blank');
        }
    }

    // Hamburger menu
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    const hamburgerMenu = document.getElementById('hamburgerMenu');

    hamburgerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hamburgerMenu.classList.toggle('open');
    });

    document.addEventListener('click', (e) => {
        if (!hamburgerMenu.contains(e.target) && e.target !== hamburgerBtn) {
            hamburgerMenu.classList.remove('open');
        }
    });

    // Event Listeners
    searchInput.addEventListener('input', (e) => {
        if (e.target.value.trim()) {
            if (activeFilters.size > 0) {
                activeFilters.clear();
                updateActiveFiltersDisplay();
                updatePopularTags();
            }
            if (selectedUsers.size > 0) {
                selectedUsers.clear();
                updateSelectionUI();
            }
        }
        filterNotes(e.target.value);
        updateTable();
        updateNoteCount();
    });
    
    exportBtn.addEventListener('click', () => {
        hamburgerMenu.classList.remove('open');
        exportNotes();
    });

    importBtn.addEventListener('click', () => {
        hamburgerMenu.classList.remove('open');
        importFile.click();
    });
    
    importFile.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            importNotes(e.target.files[0]);
            e.target.value = ''; // Reset file input
        }
    });
    
    confirmDelete.addEventListener('click', () => {
        if (noteToDelete) {
            deleteNote(noteToDelete);
            noteToDelete = null;
        }
        confirmationDialog.style.display = 'none';
    });
    
    cancelDelete.addEventListener('click', () => {
        noteToDelete = null;
        confirmationDialog.style.display = 'none';
    });

    // Trash event listeners
    trashCountEl.addEventListener('click', () => switchToTrashView());
    backToNotesBtn.addEventListener('click', () => switchToNotesView());
    emptyTrashBtn.addEventListener('click', () => {
        emptyTrashDialog.style.display = 'flex';
    });
    confirmEmptyTrash.addEventListener('click', () => {
        emptyAllTrash();
        emptyTrashDialog.style.display = 'none';
    });
    cancelEmptyTrash.addEventListener('click', () => {
        emptyTrashDialog.style.display = 'none';
    });

    // Tag system event listeners
    function toggleTagFilterPanel() {
        const isCollapsed = tagFilterPanel.classList.contains('collapsed');
        if (isCollapsed) {
            tagFilterPanel.classList.remove('collapsed');
            toggleTagFilter.textContent = t('options_collapse');
        } else {
            tagFilterPanel.classList.add('collapsed');
            toggleTagFilter.textContent = t('options_expand');
        }
    }
    
    toggleTagFilter.addEventListener('click', toggleTagFilterPanel);
    
    // Add click event to filter title for the same toggle functionality
    filterTitle.addEventListener('click', toggleTagFilterPanel);

    clearTagFilters.addEventListener('click', () => {
        activeFilters.clear();
        updateActiveFiltersDisplay();
        filterNotes(searchInput.value);
        updateTable();
        updateNoteCount();
        updatePopularTags();
    });

    tagSearchInput.addEventListener('input', () => {
        showTagSuggestions(tagSearchInput, tagSuggestions, (tag) => {
            addTagFilter(tag);
            tagSearchInput.value = '';
            tagSuggestions.style.display = 'none';
        });
    });

    tagSearchInput.addEventListener('blur', () => {
        setTimeout(() => {
            tagSuggestions.style.display = 'none';
        }, 200);
    });

    // Handle Enter key to add tag filter
    tagSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            
            const tagName = tagSearchInput.value.trim();
            if (tagName && !activeFilters.has(tagName)) {
                addTagFilter(tagName);
                tagSearchInput.value = '';
                tagSuggestions.style.display = 'none';
            }
        }
    });

    // Tag edit dialog event listeners
    saveTagEdit.addEventListener('click', () => {
        if (!currentEditingNote) return;
        
        const tags = splitTags(tagInput.value);
        saveTagsForNote(currentEditingNote.username, tags);
        tagEditDialog.style.display = 'none';
        currentEditingNote = null;
    });

    cancelTagEdit.addEventListener('click', () => {
        tagEditDialog.style.display = 'none';
        currentEditingNote = null;
    });

    tagInput.addEventListener('input', () => {
        updateCurrentTagsDisplay();
        showTagSuggestions(tagInput, tagInputSuggestions, (tag) => {
            const currentTags = splitTags(tagInput.value);
            // Check for duplicates (case-insensitive)
            if (!currentTags.some(existingTag => existingTag.toLowerCase() === tag.toLowerCase())) {
                currentTags.push(tag);
                tagInput.value = currentTags.join(', '); // Always use English comma for output
                updateCurrentTagsDisplay();
            }
            tagInputSuggestions.style.display = 'none';
        });
    });

    tagInput.addEventListener('blur', () => {
        setTimeout(() => {
            tagInputSuggestions.style.display = 'none';
        }, 200);
    });

    // Handle Enter key to save tags
    tagInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault(); // Prevent form submission or other default behavior
            
            // Trigger save action
            if (currentEditingNote) {
                const tags = splitTags(tagInput.value);
                saveTagsForNote(currentEditingNote.username, tags);
                tagEditDialog.style.display = 'none';
                currentEditingNote = null;
            }
        }
    });

    // Close dialogs when clicking outside
    tagEditDialog.addEventListener('click', (e) => {
        if (e.target === tagEditDialog) {
            tagEditDialog.style.display = 'none';
            currentEditingNote = null;
        }
    });
    
    // Selection system event listeners
    selectAllCheckbox.addEventListener('change', handleSelectAllChange);
    clearSelection.addEventListener('click', clearAllSelections);
    catchUpBtn.addEventListener('click', handleCatchUpOnX);

    // --- Theme management ---
    const themeToggle = document.getElementById('themeToggle');

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('xnote-theme', theme);
    }

    function initTheme() {
        const saved = localStorage.getItem('xnote-theme');
        if (saved) {
            applyTheme(saved);
        } else {
            chrome.storage.local.get('xNote_detectedTheme', (result) => {
                const xTheme = result.xNote_detectedTheme;
                if (xTheme === 'dark' || xTheme === 'dim') {
                    applyTheme('dark');
                } else {
                    applyTheme('light');
                }
            });
        }
    }

    themeToggle.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        applyTheme(current === 'dark' ? 'light' : 'dark');
    });

    initTheme();

    // ========== Cloud Sync UI ==========
    const syncLoggedOut = document.getElementById('syncLoggedOut');
    const syncLoggedIn = document.getElementById('syncLoggedIn');
    const googleLoginBtn = document.getElementById('googleLoginBtn');
    const syncUserAvatar = document.getElementById('syncUserAvatar');
    const syncUserEmail = document.getElementById('syncUserEmail');
    const syncStatusEl = document.getElementById('syncStatus');
    const syncNowBtn = document.getElementById('syncNowBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const migrationDialog = document.getElementById('migrationDialog');
    const migrationMerge = document.getElementById('migrationMerge');
    const migrationCloudOverwrite = document.getElementById('migrationCloudOverwrite');
    const migrationLocalOverwrite = document.getElementById('migrationLocalOverwrite');

    let pendingMigrationData = null; // { localData, serverData }

    function updateSyncUI(user, status) {
        if (user) {
            syncLoggedOut.style.display = 'none';
            syncLoggedIn.style.display = 'flex';
            syncUserAvatar.src = user.picture || '';
            syncUserAvatar.style.display = user.picture ? 'block' : 'none';
            syncUserEmail.textContent = user.email || '';
            updateSyncStatus(status || 'synced');
        } else {
            syncLoggedOut.style.display = 'flex';
            syncLoggedIn.style.display = 'none';
        }
    }

    function updateSyncStatus(status) {
        const labels = {
            'synced': t('options_sync_status_synced'),
            'syncing': t('options_sync_status_syncing'),
            'pending': t('options_sync_status_pending'),
            'offline': t('options_sync_status_offline'),
            'error': t('options_sync_status_error'),
        };
        syncStatusEl.textContent = labels[status] || status;
        syncStatusEl.className = 'sync-status ' + status;
    }

    // Listen for sync status changes
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes[XNOTE_SYNC.KEY_SYNC_STATUS]) {
            updateSyncStatus(changes[XNOTE_SYNC.KEY_SYNC_STATUS].newValue);
        }
    });

    // Google Login
    googleLoginBtn.addEventListener('click', async () => {
        googleLoginBtn.disabled = true;
        googleLoginBtn.textContent = t('options_logging_in');

        const result = await xnoteAuth.login();

        if (result.error) {
            showStatusMessage(result.error, 'error');
            googleLoginBtn.disabled = false;
            googleLoginBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg> <span>${t('options_google_login')}</span>`;
            return;
        }

        updateSyncUI(result.user, 'synced');
        showStatusMessage(t('options_login_success'), 'success');

        // Handle first-time migration
        await handleMigration();

        // Pull from server
        const pullResult = await syncManager.pull();
        if (!pullResult.error) {
            loadAllNotes(); // Refresh table
        }
    });

    // Sync Now
    syncNowBtn.addEventListener('click', async () => {
        syncNowBtn.disabled = true;
        updateSyncStatus('syncing');

        const result = await syncManager.fullSync();

        syncNowBtn.disabled = false;
        if (result.error) {
            showStatusMessage(t('options_sync_failed', [result.error]), 'error');
        } else {
            showStatusMessage(t('options_sync_complete'), 'success');
            loadAllNotes();
        }
    });

    // Logout
    logoutBtn.addEventListener('click', async () => {
        await xnoteAuth.logout();
        updateSyncUI(null);
        showStatusMessage(t('options_logged_out'), 'success');
        // Reload notes from sync storage
        loadAllNotes();
        // Update storage info display
        const storageInfo = document.querySelector('.storage-info');
        if (storageInfo) {
            storageInfo.innerHTML = `${t('options_storage_label')}<span id="storageUsage">0 KB</span> / 100 KB`;
        }
        updateStorageUsage();
    });

    // Migration handlers
    async function handleMigration() {
        // Check if sync storage has data and local storage needs migration
        const syncData = await new Promise(r => chrome.storage.sync.get(null, r));
        const syncNotes = Object.keys(syncData).filter(k =>
            k.startsWith('xNote_') && k !== 'xNote_GlobalTags' && !k.startsWith('xNoteTags_')
        );

        if (syncNotes.length === 0) return; // No sync data to migrate

        // Check if cloud has data
        const pullResult = await syncManager.pull();
        const cloudHasData = pullResult.ok && pullResult.version > 0;

        if (cloudHasData) {
            // Both have data - ask user
            pendingMigrationData = { syncData };
            migrationDialog.style.display = 'flex';
            return new Promise((resolve) => {
                migrationMerge.onclick = async () => {
                    migrationDialog.style.display = 'none';
                    await migrateSyncToLocal(syncData);
                    // Push merged data
                    await syncManager.push();
                    loadAllNotes();
                    resolve();
                };
                migrationCloudOverwrite.onclick = async () => {
                    migrationDialog.style.display = 'none';
                    // Just pull cloud data (already done)
                    loadAllNotes();
                    resolve();
                };
                migrationLocalOverwrite.onclick = async () => {
                    migrationDialog.style.display = 'none';
                    await migrateSyncToLocal(syncData);
                    await syncManager.push();
                    loadAllNotes();
                    resolve();
                };
            });
        } else {
            // Cloud empty, local has data - auto migrate and push
            await migrateSyncToLocal(syncData);
            await syncManager.push();
            showStatusMessage(t('options_migrated_to_cloud'), 'success');
        }
    }

    function migrateSyncToLocal(syncData) {
        return new Promise((resolve) => {
            // Copy relevant xNote keys from sync to local
            const dataToMigrate = {};
            Object.keys(syncData).forEach(key => {
                if (key.startsWith('xNote_') || key.startsWith('xNoteTags_')) {
                    dataToMigrate[key] = syncData[key];
                }
            });
            chrome.storage.local.set(dataToMigrate, () => {
                resolve();
            });
        });
    }

    // Initialize storage adapter, then load notes and check sync state
    storageAdapter.init(async (isLoggedIn) => {
        loadAllNotes();

        // Update storage quota display
        const storageInfo = document.querySelector('.storage-info');
        if (storageInfo && isLoggedIn) {
            storageInfo.innerHTML = `${t('options_storage_label')}<span id="storageUsage">0 KB</span> / 5 MB`;
        }

        // Check login state and update UI
        const user = await xnoteAuth.getUser();
        if (user) {
            const status = await syncManager.getSyncStatus();
            updateSyncUI(user, status);

            // Auto-pull on options page open
            const pullResult = await syncManager.pull();
            if (!pullResult.error && !pullResult.skipped && !pullResult.upToDate) {
                loadAllNotes();
            }

            // Check JWT refresh
            xnoteAuth.checkTokenRefresh();
        } else {
            updateSyncUI(null);
        }
    });
    }); // end xnoteI18n.init
});
