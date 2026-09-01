const SessionManager = (() => {
  async function captureCurrentSession() {
    const windows = await chrome.windows.getAll({ populate: true });
    return {
      windows: windows.map(win => ({
        id: win.id,
        state: win.state,
        focused: win.focused,
        left: win.left,
        top: win.top,
        width: win.width,
        height: win.height,
        tabs: (win.tabs || []).map(tab => ({
          id: tab.id,
          url: tab.url,
          title: tab.title,
          favIconUrl: tab.favIconUrl,
          pinned: tab.pinned,
          active: tab.active,
          index: tab.index
        }))
      }))
    };
  }

  async function restoreSession(session, mode = 'new') {
    if (mode === 'merge') {
      return mergeSession(session);
    }
    return restoreToNewWindow(session);
  }

  async function restoreToNewWindow(session) {
    const createdTabs = [];
    const windows = session.windows || [];

    for (let i = 0; i < windows.length; i++) {
      const win = windows[i];
      const urls = (win.tabs || [])
        .filter(t => t.url && !isProtectedUrl(t.url))
        .map(t => t.url);

      if (urls.length === 0) continue;

      const createData = {
        url: urls,
        focused: i === 0
      };

      if (win.width && win.height) {
        createData.width = Math.max(win.width, 400);
        createData.height = Math.max(win.height, 300);
      }
      if (win.left !== undefined && win.top !== undefined) {
        createData.left = win.left;
        createData.top = win.top;
      }

      const newWindow = await chrome.windows.create(createData);
      const newTabs = await chrome.tabs.query({ windowId: newWindow.id });

      for (let j = 0; j < newTabs.length; j++) {
        const originalTab = (win.tabs || []).filter(t => !isProtectedUrl(t.url))[j];
        if (originalTab && originalTab.pinned && newTabs[j]) {
          await chrome.tabs.update(newTabs[j].id, { pinned: true });
        }
        createdTabs.push(newTabs[j]);
      }

      const firstActive = (win.tabs || []).find(t => t.active && t.url && !isProtectedUrl(t.url));
      if (firstActive) {
        const matchingNew = newTabs.find(t => t.url === firstActive.url);
        if (matchingNew) {
          await chrome.tabs.update(matchingNew.id, { active: true });
        }
      }
    }

    return createdTabs;
  }

  async function mergeSession(session) {
    const currentWindow = await chrome.windows.getCurrent();
    const createdTabs = [];

    for (const win of (session.windows || [])) {
      for (const tab of (win.tabs || [])) {
        if (tab.url && !isProtectedUrl(tab.url)) {
          const newTab = await chrome.tabs.create({
            windowId: currentWindow.id,
            url: tab.url,
            pinned: tab.pinned || false,
            active: false
          });
          createdTabs.push(newTab);
        }
      }
    }

    return createdTabs;
  }

  async function closeSessionWindows(session) {
    const windows = await chrome.windows.getAll();
    const sessionUrls = new Set();
    for (const win of (session.windows || [])) {
      for (const tab of (win.tabs || [])) {
        if (tab.url) sessionUrls.add(tab.url);
      }
    }

    for (const win of windows) {
      const tabs = await chrome.tabs.query({ windowId: win.id });
      const allMatch = tabs.every(t => sessionUrls.has(t.url));
      if (allMatch && tabs.length > 0) {
        try {
          await chrome.windows.remove(win.id);
        } catch {}
      }
    }
  }

  function isProtectedUrl(url) {
    return url.startsWith('chrome://') ||
           url.startsWith('chrome-extension://') ||
           url.startsWith('about:') ||
           url.startsWith('edge://') ||
           url.startsWith('brave://');
  }

  function findDuplicateTabs(session) {
    const seen = new Set();
    const duplicates = [];
    for (const win of (session.windows || [])) {
      for (const tab of (win.tabs || [])) {
        if (seen.has(tab.url)) {
          duplicates.push(tab);
        } else {
          seen.add(tab.url);
        }
      }
    }
    return duplicates;
  }

  async function deduplicateSession(session) {
    const seen = new Set();
    const deduped = {
      ...session,
      windows: []
    };

    for (const win of (session.windows || [])) {
      const tabs = [];
      for (const tab of (win.tabs || [])) {
        if (!seen.has(tab.url)) {
          seen.add(tab.url);
          tabs.push(tab);
        }
      }
      if (tabs.length > 0) {
        deduped.windows.push({ ...win, tabs });
      }
    }

    return deduped;
  }

  function generateSessionName(session) {
    const titles = [];
    for (const win of (session.windows || [])) {
      for (const tab of (win.tabs || [])) {
        if (tab.title && !tab.title.startsWith('New Tab')) {
          titles.push(tab.title);
        }
      }
    }

    if (titles.length === 0) return 'Untitled Session';
    if (titles.length === 1) return truncate(titles[0], 50);

    const domains = new Set();
    for (const win of (session.windows || [])) {
      for (const tab of (win.tabs || [])) {
        try {
          const domain = new URL(tab.url).hostname.replace('www.', '');
          domains.add(domain);
        } catch {}
      }
    }

    if (domains.size === 1) {
      return `${[...domains][0]} (${titles.length} tabs)`;
    }

    const topTitle = titles.sort((a, b) => b.length - a.length)[0];
    return truncate(topTitle, 40) + ` +${titles.length - 1}`;
  }

  function generateSuggestions(session) {
    const suggestions = [];
    const names = new Set();
    const domains = new Map();

    for (const win of (session.windows || [])) {
      for (const tab of (win.tabs || [])) {
        if (tab.title && !tab.title.startsWith('New Tab') && tab.title.length > 3) {
          const clean = tab.title.replace(/[-–—|].*$/, '').trim();
          if (clean.length > 3 && clean.length < 60) {
            names.add(clean);
          }
        }
        try {
          const domain = new URL(tab.url).hostname.replace('www.', '');
          domains.set(domain, (domains.get(domain) || 0) + 1);
        } catch {}
      }
    }

    const topDomains = [...domains.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([d]) => d);

    if (topDomains.length === 1) {
      suggestions.push(topDomains[0]);
    } else if (topDomains.length > 1) {
      suggestions.push(topDomains.join(' & '));
    }

    const sortedTitles = [...names].sort((a, b) => b.length - a.length);
    for (const title of sortedTitles.slice(0, 3)) {
      if (!suggestions.includes(title) && suggestions.length < 5) {
        suggestions.push(title);
      }
    }

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    suggestions.push(`Session ${now.toLocaleDateString()} ${timeStr}`);

    return [...new Set(suggestions)].slice(0, 5);
  }

  function compareSessions(sessionA, sessionB) {
    const urlsA = new Set();
    const urlsB = new Set();

    for (const win of (sessionA.windows || [])) {
      for (const tab of (win.tabs || [])) {
        if (tab.url) urlsA.add(tab.url);
      }
    }
    for (const win of (sessionB.windows || [])) {
      for (const tab of (win.tabs || [])) {
        if (tab.url) urlsB.add(tab.url);
      }
    }

    const added = [...urlsB].filter(u => !urlsA.has(u));
    const removed = [...urlsA].filter(u => !urlsB.has(u));
    const unchanged = [...urlsA].filter(u => urlsB.has(u));

    return { added, removed, unchanged };
  }

  function truncate(str, len) {
    if (str.length <= len) return str;
    return str.substring(0, len - 3) + '...';
  }

  return {
    captureCurrentSession,
    restoreSession,
    restoreToNewWindow,
    mergeSession,
    closeSessionWindows,
    isProtectedUrl,
    findDuplicateTabs,
    deduplicateSession,
    generateSessionName,
    generateSuggestions,
    compareSessions
  };
})();
