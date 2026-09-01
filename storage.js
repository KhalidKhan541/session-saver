const SessionStorage = (() => {
  const DB_NAME = 'SessionSaverDB';
  const DB_VERSION = 1;
  const STORE_SESSIONS = 'sessions';
  const STORE_METADATA = 'metadata';
  const STORE_INDEX = 'searchIndex';

  let db = null;

  async function init() {
    if (db) return db;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        db = request.result;
        resolve(db);
      };
      request.onupgradeneeded = (event) => {
        const database = event.target.result;
        if (!database.objectStoreNames.contains(STORE_SESSIONS)) {
          const sessionStore = database.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
          sessionStore.createIndex('createdAt', 'createdAt', { unique: false });
          sessionStore.createIndex('name', 'name', { unique: false });
        }
        if (!database.objectStoreNames.contains(STORE_METADATA)) {
          const metaStore = database.createObjectStore(STORE_METADATA, { keyPath: 'id' });
          metaStore.createIndex('sessionId', 'sessionId', { unique: false });
        }
        if (!database.objectStoreNames.contains(STORE_INDEX)) {
          const indexStore = database.createObjectStore(STORE_INDEX, { keyPath: 'id', autoIncrement: true });
          indexStore.createIndex('sessionId', 'sessionId', { unique: false });
          indexStore.createIndex('term', 'term', { unique: false });
        }
      };
    });
  }

  function tx(storeName, mode = 'readonly') {
    const transaction = db.transaction(storeName, mode);
    return transaction.objectStore(storeName);
  }

  function promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }

  function extractDomain(url) {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return null;
    }
  }

  function tokenize(text) {
    if (!text) return [];
    return text.toLowerCase()
      .replace(/[^a-z0-9\s.-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);
  }

  async function saveSession(session) {
    await init();
    const id = session.id || generateId();
    const now = Date.now();
    const sessionData = {
      id,
      name: session.name || 'Untitled Session',
      tags: session.tags || [],
      createdAt: session.createdAt || now,
      updatedAt: now,
      windows: session.windows || [],
      tabCount: (session.windows || []).reduce((sum, w) => sum + (w.tabs || []).length, 0),
      windowCount: (session.windows || []).length,
      autoSaved: session.autoSaved || false
    };

    const store = tx(STORE_SESSIONS, 'readwrite');
    await promisify(store.put(sessionData));

    await updateSearchIndex(id, sessionData);
    await updateMetadata(id, sessionData);

    return sessionData;
  }

  async function getSession(id) {
    await init();
    const store = tx(STORE_SESSIONS);
    return promisify(store.get(id));
  }

  async function getAllSessions() {
    await init();
    const store = tx(STORE_SESSIONS);
    return promisify(store.getAll());
  }

  async function deleteSession(id) {
    await init();
    const store = tx(STORE_SESSIONS, 'readwrite');
    await promisify(store.delete(id));
    await deleteSearchEntries(id);
    await deleteMetadataEntries(id);
  }

  async function updateSearchIndex(sessionId, session) {
    await init();
    await deleteSearchEntries(sessionId);
    const store = tx(STORE_INDEX, 'readwrite');
    const terms = new Set();

    terms.add(session.name.toLowerCase());
    (session.tags || []).forEach(t => terms.add(t.toLowerCase()));

    for (const win of (session.windows || [])) {
      for (const tab of (win.tabs || [])) {
        if (tab.url) {
          terms.add(tab.url.toLowerCase());
          const domain = extractDomain(tab.url);
          if (domain) terms.add(domain);
        }
        if (tab.title) {
          tokenize(tab.title).forEach(t => terms.add(t));
        }
      }
    }

    for (const term of terms) {
      if (term.length > 1) {
        await promisify(store.add({ sessionId, term }));
      }
    }
  }

  async function deleteSearchEntries(sessionId) {
    await init();
    const store = tx(STORE_INDEX, 'readwrite');
    const index = store.index('sessionId');
    const entries = await promisify(index.getAll(sessionId));
    for (const entry of entries) {
      await promisify(store.delete(entry.id));
    }
  }

  async function updateMetadata(sessionId, session) {
    await init();
    const store = tx(STORE_METADATA, 'readwrite');
    const domains = {};
    for (const win of (session.windows || [])) {
      for (const tab of (win.tabs || [])) {
        const domain = extractDomain(tab.url);
        if (domain) {
          domains[domain] = (domains[domain] || 0) + 1;
        }
      }
    }
    await promisify(store.put({
      id: sessionId,
      sessionId,
      domains,
      tabCount: session.tabCount,
      createdAt: session.createdAt
    }));
  }

  async function deleteMetadataEntries(sessionId) {
    await init();
    const store = tx(STORE_METADATA, 'readwrite');
    await promisify(store.delete(sessionId));
  }

  async function searchSessions(query) {
    await init();
    if (!query || query.trim() === '') return getAllSessions();
    const terms = tokenize(query.toLowerCase());
    if (terms.length === 0) return getAllSessions();

    const store = tx(STORE_INDEX);
    const sessionIds = new Set();

    for (const term of terms) {
      const index = store.index('term');
      const range = IDBKeyRange.bound(term, term + '\uffff');
      const entries = await promisify(index.getAll(range));
      entries.forEach(e => sessionIds.add(e.sessionId));
    }

    if (sessionIds.size === 0) return [];

    const sessions = [];
    const sessionStore = tx(STORE_SESSIONS);
    for (const id of sessionIds) {
      const session = await promisify(sessionStore.get(id));
      if (session) sessions.push(session);
    }
    return sessions;
  }

  async function getStorageStats() {
    await init();
    const sessions = await getAllSessions();
    const totalSessions = sessions.length;
    const totalTabs = sessions.reduce((sum, s) => sum + (s.tabCount || 0), 0);

    let estimatedSize = 0;
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        estimatedSize = estimate.usage || 0;
      }
    } catch {}

    if (estimatedSize === 0) {
      estimatedSize = new Blob(JSON.stringify(sessions)).size;
    }

    const domainCounts = {};
    for (const session of sessions) {
      for (const win of (session.windows || [])) {
        for (const tab of (win.tabs || [])) {
          const domain = extractDomain(tab.url);
          if (domain) {
            domainCounts[domain] = (domainCounts[domain] || 0) + 1;
          }
        }
      }
    }

    const topSites = Object.entries(domainCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([domain, count]) => ({ domain, count }));

    const activityByDay = {};
    for (const session of sessions) {
      const day = new Date(session.createdAt).toISOString().split('T')[0];
      activityByDay[day] = (activityByDay[day] || 0) + 1;
    }

    return {
      totalSessions,
      totalTabs,
      storageUsed: estimatedSize,
      topSites,
      activityByDay,
      avgTabsPerSession: totalSessions > 0 ? Math.round(totalTabs / totalSessions) : 0
    };
  }

  async function cleanupOldSessions(retentionDays, maxSessions) {
    await init();
    if (!retentionDays && !maxSessions) return 0;

    const sessions = await getAllSessions();
    let toDelete = [];

    if (retentionDays > 0) {
      const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
      toDelete = sessions.filter(s => s.createdAt < cutoff);
    }

    if (maxSessions > 0 && sessions.length - toDelete.length > maxSessions) {
      const remaining = sessions
        .filter(s => !toDelete.find(d => d.id === s.id))
        .sort((a, b) => a.createdAt - b.createdAt);
      const excess = remaining.length - maxSessions;
      toDelete.push(...remaining.slice(0, excess));
    }

    for (const session of toDelete) {
      await deleteSession(session.id);
    }
    return toDelete.length;
  }

  async function exportSessions() {
    const sessions = await getAllSessions();
    return JSON.stringify(sessions, null, 2);
  }

  async function importSessions(jsonString) {
    const sessions = JSON.parse(jsonString);
    if (!Array.isArray(sessions)) throw new Error('Invalid format');
    let imported = 0;
    for (const session of sessions) {
      await saveSession({
        ...session,
        id: generateId(),
        createdAt: session.createdAt || Date.now()
      });
      imported++;
    }
    return imported;
  }

  async function backupToBookmarks(sessions) {
    const root = await new Promise((resolve) => {
      chrome.bookmarks.getChildren('1', (children) => {
        let folder = children.find(c => c.title === 'Session Saver Backup' && c.url === undefined);
        if (!folder) {
          chrome.bookmarks.create({ parentId: '1', title: 'Session Saver Backup' }, (f) => {
            resolve(f);
          });
        } else {
          resolve(folder);
        }
      });
    });

    for (const session of (sessions || await getAllSessions())) {
      const folder = await new Promise((resolve) => {
        chrome.bookmarks.create({
          parentId: root.id,
          title: `${session.name} (${new Date(session.createdAt).toLocaleDateString()})`
        }, resolve);
      });

      for (const win of (session.windows || [])) {
        const winFolder = await new Promise((resolve) => {
          chrome.bookmarks.create({
            parentId: folder.id,
            title: `Window (${win.tabs.length} tabs)`
          }, resolve);
        });

        for (const tab of (win.tabs || [])) {
          if (tab.url && !tab.url.startsWith('chrome://')) {
            await new Promise((resolve) => {
              chrome.bookmarks.create({
                parentId: winFolder.id,
                title: tab.title || tab.url,
                url: tab.url
              }, resolve);
            });
          }
        }
      }
    }
    return sessions ? sessions.length : (await getAllSessions()).length;
  }

  async function getAllTags() {
    const sessions = await getAllSessions();
    const tagSet = new Set();
    sessions.forEach(s => (s.tags || []).forEach(t => tagSet.add(t)));
    return [...tagSet].sort();
  }

  return {
    init,
    saveSession,
    getSession,
    getAllSessions,
    deleteSession,
    searchSessions,
    getStorageStats,
    cleanupOldSessions,
    exportSessions,
    importSessions,
    backupToBookmarks,
    getAllTags,
    generateId
  };
})();
