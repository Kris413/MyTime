importScripts('categories.js');

let activeTab = null; // { tabId, url, domain, startTime }

function getDomain(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (!['http:', 'https:'].includes(protocol)) return null;
    return hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function getDateKey(ts = Date.now()) {
  return new Date(ts).toLocaleDateString('en-CA'); // YYYY-MM-DD
}

async function saveElapsed(domain, startTime) {
  if (!domain || !startTime) return;
  const seconds = Math.round((Date.now() - startTime) / 1000);
  if (seconds < 2) return;

  const dateKey = getDateKey(startTime);
  const category = categorize(domain);

  const stored = await chrome.storage.local.get(dateKey);
  const dayData = stored[dateKey] || {};

  if (!dayData[domain]) dayData[domain] = { category, seconds: 0 };
  dayData[domain].seconds += seconds;

  await chrome.storage.local.set({ [dateKey]: dayData });
}

async function persistState() {
  if (activeTab) {
    await chrome.storage.session.set({ activeTab });
  } else {
    await chrome.storage.session.remove('activeTab');
  }
}

async function stopTracking() {
  if (!activeTab) return;
  await saveElapsed(activeTab.domain, activeTab.startTime);
  activeTab = null;
  await persistState();
}

async function startTracking(tab) {
  if (!tab?.url) return;
  activeTab = {
    tabId: tab.id,
    url: tab.url,
    domain: getDomain(tab.url),
    startTime: Date.now(),
  };
  await persistState();
}

// Save elapsed time and reset startTime so popup data is fresh without stopping tracking
async function flushCurrentSession() {
  if (!activeTab) return;
  await saveElapsed(activeTab.domain, activeTab.startTime);
  activeTab.startTime = Date.now();
  await persistState();
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await stopTracking();
  try {
    const tab = await chrome.tabs.get(tabId);
    await startTracking(tab);
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (activeTab?.tabId === tabId && tab.url !== activeTab.url) {
    await stopTracking();
    await startTracking(tab);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (activeTab?.tabId === tabId) await stopTracking();
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await stopTracking();
  } else {
    try {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (tab) await startTracking(tab);
    } catch {}
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'flush') {
    flushCurrentSession().then(() => sendResponse({ ok: true }));
    return true; // keep channel open for async response
  }
});

// On service worker restart: recover lost session time, then re-attach to active tab
(async () => {
  try {
    const { activeTab: saved } = await chrome.storage.session.get('activeTab');
    if (saved) {
      // Service worker was killed mid-session — save the lost elapsed time
      await saveElapsed(saved.domain, saved.startTime);
    }
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) await startTracking(tab);
  } catch {}
})();
