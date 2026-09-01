chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  if (settings.badge !== false) {
    updateBadge();
  }
  createContextMenus();
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  if (settings.badge !== false) {
    updateBadge();
  }
  if (settings.autoRestore) {
    await autoRestoreLastSession();
  }
});

chrome.windows.onRemoved.addListener(async () => {
  const settings = await getSettings();
  if (settings.autoSave) {
    await autoSaveSession();
  }
});

chrome.tabs.onCreated.addListener(() => updateBadge());
chrome.tabs.onRemoved.addListener(() => updateBadge());

chrome.sessions.onChanged.addListener(() => {});

async function autoSaveSession() {
  try {
    const windows = await chrome.windows.getAll({ populate: true });
    if (windows.length === 0) return;

    const hasRealTabs = windows.some(w =>
      w.tabs.some(t => t.url && !t.url.startsWith('chrome://'))
    );
    if (!hasRealTabs) return;

    const session = await SessionManager.captureCurrentSession();
    const autoSessions = await getAutoSessions();

    const isDuplicate = autoSessions.some(existing => {
      const existingUrls = new Set();
      const newUrls = new Set();
      for (const win of (existing.windows || [])) {
        for (const tab of (win.tabs || [])) existingUrls.add(tab.url);
      }
      for (const win of (session.windows || [])) {
        for (const tab of (win.tabs || [])) newUrls.add(tab.url);
      }
      if (existingUrls.size !== newUrls.size) return false;
      for (const url of newUrls) {
        if (!existingUrls.has(url)) return false;
      }
      return true;
    });

    if (isDuplicate) return;

    const name = SessionManager.generateSessionName(session);
    await SessionStorage.saveSession({
      ...session,
      name: `Auto: ${name}`,
      autoSaved: true,
      tags: ['auto-saved']
    });

    await updateBadge();
  } catch (err) {
    console.error('Auto-save failed:', err);
  }
}

async function getAutoSessions() {
  const all = await SessionStorage.getAllSessions();
  return all.filter(s => s.autoSaved);
}

async function autoRestoreLastSession() {
  try {
    const sessions = await SessionStorage.getAllSessions();
    const autoSessions = sessions
      .filter(s => s.autoSaved)
      .sort((a, b) => b.createdAt - a.createdAt);

    if (autoSessions.length > 0) {
      const last = autoSessions[0];
      const windows = await chrome.windows.getAll({ populate: true });
      const currentTabCount = windows.reduce((sum, w) => sum + w.tabs.length, 0);

      if (currentTabCount <= 1) {
        await SessionManager.restoreSession(last, 'new');
      }
    }
  } catch (err) {
    console.error('Auto-restore failed:', err);
  }
}

async function updateBadge() {
  try {
    const sessions = await SessionStorage.getAllSessions();
    const count = sessions.length;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#4f8cff' });
  } catch {}
}

function createContextMenus() {
  chrome.contextMenus.create({
    id: 'session-saver-save-tab',
    title: 'Save tab to session',
    contexts: ['page', 'link']
  });

  chrome.contextMenus.create({
    id: 'session-saver-save-all',
    title: 'Save all tabs as session',
    contexts: ['action']
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'session-saver-save-tab') {
    const session = {
      name: tab.title || 'Quick Save',
      windows: [{
        tabs: [{
          url: info.linkUrl || tab.url,
          title: tab.title,
          favIconUrl: tab.favIconUrl,
          pinned: false
        }]
      }],
      tags: ['quick-save']
    };
    await SessionStorage.saveSession(session);
    await updateBadge();
    showNotification('Tab saved to session');
  }

  if (info.menuItemId === 'session-saver-save-all') {
    const captured = await SessionManager.captureCurrentSession();
    const name = SessionManager.generateSessionName(captured);
    await SessionStorage.saveSession({
      ...captured,
      name,
      tags: ['context-menu']
    });
    await updateBadge();
    showNotification('Session saved');
  }
});

function showNotification(message) {
  chrome.notifications?.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Session Saver',
    message
  }).catch(() => {});
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings'], (result) => {
      resolve(result.settings || {});
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_SETTINGS') {
    getSettings().then(s => sendResponse(s));
    return true;
  }
  if (message.type === 'SAVE_SETTINGS') {
    chrome.storage.local.set({ settings: message.settings }, () => {
      if (message.settings.badge !== false) {
        updateBadge();
      } else {
        chrome.action.setBadgeText({ text: '' });
      }
      sendResponse(true);
    });
    return true;
  }
  if (message.type === 'UPDATE_BADGE') {
    updateBadge().then(() => sendResponse(true));
    return true;
  }
});
