document.addEventListener('DOMContentLoaded', async () => {
  await SessionStorage.init();
  setupTabs();
  setupCurrentSession();
  setupSavedSessions();
  setupSettings();
  setupImportExport();
  setupCompare();
  await loadSavedSessions();
  await loadStats();
  generateSuggestions();
});

function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
      if (tab.dataset.tab === 'stats') loadStats();
      if (tab.dataset.tab === 'saved') loadSavedSessions();
    });
  });
}

async function setupCurrentSession() {
  await refreshCurrentSession();
  document.getElementById('btn-save').addEventListener('click', saveCurrentSession);
  document.getElementById('session-name').addEventListener('input', () => {
    const name = document.getElementById('session-name').value;
    if (name.length > 2) {
      showFilteredSuggestions(name);
    } else {
      generateSuggestions();
    }
  });
}

async function refreshCurrentSession() {
  try {
    const windows = await chrome.windows.getAll({ populate: true });
    const container = document.getElementById('current-windows');
    let totalTabs = 0;

    container.innerHTML = '';
    windows.forEach((win, i) => {
      const tabs = win.tabs || [];
      totalTabs += tabs.length;
      const group = document.createElement('div');
      group.className = 'window-group';
      group.innerHTML = `
        <div class="window-header">
          <svg viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="2" width="12" height="12" rx="1" stroke="currentColor" fill="none" stroke-width="1.5"/></svg>
          Window ${i + 1} (${tabs.length} tabs)
        </div>
      `;
      tabs.forEach(tab => {
        const item = document.createElement('div');
        item.className = 'tab-item';
        item.innerHTML = `
          ${tab.favIconUrl ? `<img class="tab-favicon" src="${escapeHtml(tab.favIconUrl)}" onerror="this.style.display='none'">` : '<span class="tab-favicon"></span>'}
          <span class="tab-title" title="${escapeHtml(tab.url)}">${escapeHtml(tab.title || 'New Tab')}</span>
          ${tab.pinned ? '<span class="tab-pinned">📌</span>' : ''}
        `;
        group.appendChild(item);
      });
      container.appendChild(group);
    });

    document.getElementById('current-window-count').textContent = `${windows.length} window${windows.length !== 1 ? 's' : ''}`;
    document.getElementById('current-tab-count').textContent = `${totalTabs} tab${totalTabs !== 1 ? 's' : ''}`;
  } catch (err) {
    console.error('Failed to load current session:', err);
  }
}

async function generateSuggestions() {
  try {
    const session = await SessionManager.captureCurrentSession();
    const suggestions = SessionManager.generateSuggestions(session);
    const container = document.getElementById('name-suggestions');
    const row = document.getElementById('suggestion-row');

    if (suggestions.length === 0) {
      row.style.display = 'none';
      return;
    }

    row.style.display = 'flex';
    container.innerHTML = suggestions.map(s =>
      `<button class="suggestion-chip" data-name="${escapeHtml(s)}">${escapeHtml(s)}</button>`
    ).join('');

    container.querySelectorAll('.suggestion-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.getElementById('session-name').value = chip.dataset.name;
      });
    });
  } catch {}
}

function showFilteredSuggestions(query) {
  const chips = document.querySelectorAll('.suggestion-chip');
  chips.forEach(chip => {
    const match = chip.dataset.name.toLowerCase().includes(query.toLowerCase());
    chip.style.display = match ? '' : 'none';
  });
}

async function saveCurrentSession() {
  const btn = document.getElementById('btn-save');
  const nameInput = document.getElementById('session-name');
  const tagsInput = document.getElementById('session-tags');

  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const session = await SessionManager.captureCurrentSession();
    const tags = tagsInput.value.split(',').map(t => t.trim()).filter(Boolean);
    const name = nameInput.value.trim() || SessionManager.generateSessionName(session);

    await SessionStorage.saveSession({
      ...session,
      name,
      tags
    });

    nameInput.value = '';
    tagsInput.value = '';
    showToast('Session saved!', 'success');
    await updateBadge();
    await loadSavedSessions();
  } catch (err) {
    showToast('Failed to save session', 'error');
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M13 1H3a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V4l-2-3zm-1 11H4V2h7l2 2v8z"/><path d="M4 13V8h8v5H4zm4-6a2 2 0 100 4 2 2 0 000-4z"/></svg>
      Save Current Session
    `;
    generateSuggestions();
  }
}

let allSessions = [];
let activeTagFilter = null;

async function loadSavedSessions() {
  const query = document.getElementById('search-sessions').value;
  const sortBy = document.getElementById('sort-sessions').value;

  if (query.trim()) {
    allSessions = await SessionStorage.searchSessions(query);
  } else {
    allSessions = await SessionStorage.getAllSessions();
  }

  allSessions = sortSessions(allSessions, sortBy);
  await renderSessionFilters();
  renderSessions();
}

function sortSessions(sessions, sortBy) {
  const sorted = [...sessions];
  switch (sortBy) {
    case 'date-desc': return sorted.sort((a, b) => b.createdAt - a.createdAt);
    case 'date-asc': return sorted.sort((a, b) => a.createdAt - b.createdAt);
    case 'name-asc': return sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    case 'name-desc': return sorted.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
    case 'tabs-desc': return sorted.sort((a, b) => (b.tabCount || 0) - (a.tabCount || 0));
    case 'tabs-asc': return sorted.sort((a, b) => (a.tabCount || 0) - (b.tabCount || 0));
    default: return sorted;
  }
}

async function renderSessionFilters() {
  const tags = await SessionStorage.getAllTags();
  const container = document.getElementById('tag-filters');
  container.innerHTML = tags.map(tag =>
    `<button class="tag-filter ${activeTagFilter === tag ? 'active' : ''}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`
  ).join('');

  container.querySelectorAll('.tag-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTagFilter = activeTagFilter === btn.dataset.tag ? null : btn.dataset.tag;
      renderSessionFilters();
      renderSessions();
    });
  });
}

function renderSessions() {
  const container = document.getElementById('sessions-list');
  const emptyState = document.getElementById('empty-state');
  let filtered = allSessions;

  if (activeTagFilter) {
    filtered = filtered.filter(s => (s.tags || []).includes(activeTagFilter));
  }

  if (filtered.length === 0) {
    container.innerHTML = '';
    container.appendChild(emptyState);
    emptyState.style.display = 'flex';
    return;
  }

  emptyState.style.display = 'none';
  container.innerHTML = filtered.map(session => createSessionCard(session)).join('');

  container.querySelectorAll('.session-card').forEach(card => {
    const id = card.dataset.id;

    card.querySelector('.session-expand-btn')?.addEventListener('click', () => {
      card.classList.toggle('expanded');
    });

    card.querySelector('.restore')?.addEventListener('click', () => restoreSession(id));
    card.querySelector('.merge')?.addEventListener('click', () => mergeSession(id));
    card.querySelector('.delete')?.addEventListener('click', () => deleteSession(id));
    card.querySelector('.compare')?.addEventListener('click', () => openCompare(id));
  });
}

function createSessionCard(session) {
  const date = new Date(session.createdAt);
  const age = formatRelativeTime(date);
  const tags = (session.tags || []).map(t =>
    `<span class="session-tag">${escapeHtml(t)}</span>`
  ).join('');

  const previewWindows = (session.windows || []).map((win, i) => {
    const tabs = (win.tabs || []).slice(0, 5).map(tab =>
      `<div class="preview-tab">
        ${tab.favIconUrl ? `<img class="preview-tab-favicon" src="${escapeHtml(tab.favIconUrl)}" onerror="this.style.display='none'">` : ''}
        <span class="preview-tab-title">${escapeHtml(tab.title || 'New Tab')}</span>
      </div>`
    ).join('');
    const more = win.tabs.length > 5 ? `<div class="preview-tab" style="color:var(--text-muted)">+${win.tabs.length - 5} more</div>` : '';
    return `<div class="preview-window">
      <div class="preview-window-title">Window ${i + 1} (${win.tabs.length} tabs)</div>
      ${tabs}${more}
    </div>`;
  }).join('');

  return `
    <div class="session-card" data-id="${session.id}">
      <div class="session-card-header">
        <div class="session-card-info">
          <div class="session-card-name" title="${escapeHtml(session.name)}">${escapeHtml(session.name)}</div>
          <div class="session-card-meta">
            <span>${age}</span>
            <span class="separator">·</span>
            <span>${session.windowCount || 0} window${(session.windowCount || 0) !== 1 ? 's' : ''}</span>
            <span class="separator">·</span>
            <span>${session.tabCount || 0} tab${(session.tabCount || 0) !== 1 ? 's' : ''}</span>
            ${session.autoSaved ? '<span class="session-tag" style="background:var(--accent-glow);color:var(--accent)">auto</span>' : ''}
          </div>
          <div class="session-card-tags">${tags}</div>
        </div>
        <div class="session-card-actions">
          <button class="session-action-btn restore" title="Restore to new window">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2L3 7h3v5h4V7h3L8 2z"/></svg>
          </button>
          <button class="session-action-btn merge" title="Merge into current window">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2v8m-4-4h8M3 14h10"/></svg>
          </button>
          <button class="session-action-btn compare" title="Compare sessions">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h5v10H2V3zm7 0h5v10H9V3z"/></svg>
          </button>
          <button class="session-action-btn delete" title="Delete session">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5 2V1h6v1h3v2H2V2h3zm1 0v1h4V2H6zM3 5h10l-1 11H4L3 5z"/></svg>
          </button>
        </div>
      </div>
      <button class="session-expand-btn">
        <span>Preview</span>
        <svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 6l4 4 4-4"/></svg>
      </button>
      <div class="session-preview">${previewWindows}</div>
    </div>
  `;
}

async function restoreSession(id) {
  const session = await SessionStorage.getSession(id);
  if (!session) return;
  try {
    await SessionManager.restoreSession(session, 'new');
    showToast('Session restored!', 'success');
  } catch (err) {
    showToast('Failed to restore session', 'error');
    console.error(err);
  }
}

async function mergeSession(id) {
  const session = await SessionStorage.getSession(id);
  if (!session) return;
  try {
    await SessionManager.restoreSession(session, 'merge');
    showToast('Session merged!', 'success');
  } catch (err) {
    showToast('Failed to merge session', 'error');
    console.error(err);
  }
}

async function deleteSession(id) {
  const session = await SessionStorage.getSession(id);
  if (!session) return;

  await SessionStorage.deleteSession(id);
  await updateBadge();
  showToast('Session deleted', 'success', async () => {
    await SessionStorage.saveSession({ ...session, id });
    await updateBadge();
    await loadSavedSessions();
  });
  await loadSavedSessions();
}

async function openCompare(preselectedId) {
  const modal = document.getElementById('compare-modal');
  modal.style.display = 'flex';

  const selectA = document.getElementById('compare-a');
  const selectB = document.getElementById('compare-b');

  const options = allSessions.map(s =>
    `<option value="${s.id}" ${s.id === preselectedId ? 'selected' : ''}>${escapeHtml(s.name)} (${s.tabCount} tabs)</option>`
  ).join('');

  selectA.innerHTML = options;
  selectB.innerHTML = options;

  if (allSessions.length > 1) {
    const otherId = allSessions.find(s => s.id !== preselectedId)?.id || allSessions[0].id;
    selectB.value = otherId;
  }

  document.getElementById('btn-do-compare').onclick = async () => {
    const sessionA = await SessionStorage.getSession(selectA.value);
    const sessionB = await SessionStorage.getSession(selectB.value);
    if (!sessionA || !sessionB) return;

    const diff = SessionManager.compareSessions(sessionA, sessionB);
    const results = document.getElementById('compare-results');

    results.innerHTML = `
      <div class="compare-section">
        <h4>Added (${diff.added.length})</h4>
        ${diff.added.map(url => `<div class="compare-item added">+ ${escapeHtml(truncateUrl(url))}</div>`).join('') || '<div class="compare-item unchanged">None</div>'}
      </div>
      <div class="compare-section">
        <h4>Removed (${diff.removed.length})</h4>
        ${diff.removed.map(url => `<div class="compare-item removed">- ${escapeHtml(truncateUrl(url))}</div>`).join('') || '<div class="compare-item unchanged">None</div>'}
      </div>
      <div class="compare-section">
        <h4>Unchanged (${diff.unchanged.length})</h4>
        ${diff.unchanged.length > 0 ? `<div class="compare-item unchanged">${diff.unchanged.length} tabs in common</div>` : '<div class="compare-item unchanged">None</div>'}
      </div>
    `;
  };
}

function setupCompare() {
  document.getElementById('btn-close-compare').addEventListener('click', () => {
    document.getElementById('compare-modal').style.display = 'none';
  });
  document.getElementById('compare-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
}

async function loadStats() {
  try {
    const stats = await SessionStorage.getStorageStats();
    document.getElementById('stat-total-sessions').textContent = stats.totalSessions;
    document.getElementById('stat-total-tabs').textContent = stats.totalTabs;
    document.getElementById('stat-avg-tabs').textContent = stats.avgTabsPerSession;
    document.getElementById('stat-storage-used').textContent = formatBytes(stats.storageUsed);

    const topSitesContainer = document.getElementById('top-sites');
    if (stats.topSites.length === 0) {
      topSitesContainer.innerHTML = '<div class="empty-state"><p>No data yet</p></div>';
    } else {
      topSitesContainer.innerHTML = stats.topSites.map((site, i) =>
        `<div class="top-site">
          <span class="top-site-rank">${i + 1}</span>
          <span class="top-site-domain">${escapeHtml(site.domain)}</span>
          <span class="top-site-count">${site.count}x</span>
        </div>`
      ).join('');
    }

    const chart = document.getElementById('activity-chart');
    const days = Object.entries(stats.activityByDay).sort((a, b) => a[0].localeCompare(b[0])).slice(-14);
    if (days.length === 0) {
      chart.innerHTML = '<div class="empty-state" style="height:60px"><p>No activity</p></div>';
    } else {
      const max = Math.max(...days.map(d => d[1]), 1);
      chart.innerHTML = days.map(([, count]) => {
        const height = Math.max((count / max) * 100, 4);
        return `<div class="activity-bar" style="height:${height}%" title="${count} sessions"></div>`;
      }).join('');
    }
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

function setupSettings() {
  const btnSettings = document.getElementById('btn-settings');
  const modal = document.getElementById('settings-modal');
  const btnClose = document.getElementById('btn-close-settings');

  btnSettings.addEventListener('click', async () => {
    modal.style.display = 'flex';
    const settings = await getSettings();
    document.getElementById('setting-autosave').checked = settings.autoSave || false;
    document.getElementById('setting-autorestore').checked = settings.autoRestore || false;
    document.getElementById('setting-badge').checked = settings.badge !== false;
    document.getElementById('setting-retention').value = settings.retention || '30';
    document.getElementById('setting-max-sessions').value = settings.maxSessions || 100;
  });

  btnClose.addEventListener('click', () => modal.style.display = 'none');
  modal.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) modal.style.display = 'none';
  });

  ['setting-autosave', 'setting-autorestore', 'setting-badge'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveSettingsFromUI);
  });

  ['setting-retention', 'setting-max-sessions'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveSettingsFromUI);
  });

  document.getElementById('btn-clear-all').addEventListener('click', async () => {
    if (confirm('Are you sure you want to delete ALL saved sessions? This cannot be undone.')) {
      const sessions = await SessionStorage.getAllSessions();
      for (const s of sessions) {
        await SessionStorage.deleteSession(s.id);
      }
      await updateBadge();
      modal.style.display = 'none';
      await loadSavedSessions();
      await loadStats();
      showToast('All sessions cleared', 'success');
    }
  });

  document.getElementById('btn-backup-bookmarks').addEventListener('click', async () => {
    try {
      await SessionStorage.backupToBookmarks();
      showToast('Backup created in bookmarks', 'success');
    } catch (err) {
      showToast('Backup failed', 'error');
      console.error(err);
    }
  });
}

async function saveSettingsFromUI() {
  const settings = {
    autoSave: document.getElementById('setting-autosave').checked,
    autoRestore: document.getElementById('setting-autorestore').checked,
    badge: document.getElementById('setting-badge').checked,
    retention: document.getElementById('setting-retention').value,
    maxSessions: parseInt(document.getElementById('setting-max-sessions').value) || 100
  };

  chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });

  if (settings.retention !== '0' || settings.maxSessions < 100) {
    const cleaned = await SessionStorage.cleanupOldSessions(
      settings.retention === '0' ? 0 : parseInt(settings.retention),
      settings.maxSessions
    );
    if (cleaned > 0) {
      showToast(`Cleaned up ${cleaned} old session${cleaned > 1 ? 's' : ''}`, 'success');
      await loadSavedSessions();
    }
  }
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings'], (result) => {
      resolve(result.settings || {});
    });
  });
}

function setupImportExport() {
  document.getElementById('btn-export').addEventListener('click', async () => {
    try {
      const data = await SessionStorage.exportSessions();
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-saver-backup-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Sessions exported', 'success');
    } catch (err) {
      showToast('Export failed', 'error');
    }
  });

  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });

  document.getElementById('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const count = await SessionStorage.importSessions(text);
      await updateBadge();
      await loadSavedSessions();
      showToast(`Imported ${count} session${count > 1 ? 's' : ''}`, 'success');
    } catch (err) {
      showToast('Import failed: invalid file', 'error');
    }
    e.target.value = '';
  });
}

async function updateBadge() {
  chrome.runtime.sendMessage({ type: 'UPDATE_BADGE' });
}

function showToast(message, type = 'success', onUndo = null) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span>${escapeHtml(message)}</span>
    ${onUndo ? '<button class="toast-undo">Undo</button>' : ''}
  `;

  if (onUndo) {
    toast.querySelector('.toast-undo').addEventListener('click', () => {
      onUndo();
      toast.remove();
    });
  }

  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function formatRelativeTime(date) {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  if (weeks < 4) return `${weeks}w ago`;
  return `${months}mo ago`;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function truncateUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 30 ? u.pathname.substring(0, 30) + '...' : u.pathname;
    return u.hostname + path;
  } catch {
    return url.substring(0, 50);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
