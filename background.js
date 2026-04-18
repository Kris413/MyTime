importScripts('categories.js', 'ai.js');

// ── Tracking state ────────────────────────────────────────────────────────────

let activeTab = null;

function getDomain(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (!['http:', 'https:'].includes(protocol)) return null;
    return hostname.replace(/^www\./, '');
  } catch { return null; }
}

function getDateKey(ts = Date.now()) {
  return new Date(ts).toLocaleDateString('en-CA');
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
  activeTab
    ? await chrome.storage.session.set({ activeTab })
    : await chrome.storage.session.remove('activeTab');
}

async function stopTracking() {
  if (!activeTab) return;
  await saveElapsed(activeTab.domain, activeTab.startTime);
  activeTab = null;
  await persistState();
}

async function startTracking(tab) {
  if (!tab?.url) return;
  activeTab = { tabId: tab.id, url: tab.url, domain: getDomain(tab.url), startTime: Date.now() };
  await persistState();
}

async function flushCurrentSession() {
  if (!activeTab) return;
  await saveElapsed(activeTab.domain, activeTab.startTime);
  activeTab.startTime = Date.now();
  await persistState();
}

// ── Tab / window listeners ────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await stopTracking();
  try { await startTracking(await chrome.tabs.get(tabId)); } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (activeTab?.tabId === tabId && tab.url !== activeTab.url) {
    await stopTracking(); await startTracking(tab);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (activeTab?.tabId === tabId) await stopTracking();
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await stopTracking();
  } else {
    try { const [tab] = await chrome.tabs.query({ active: true, windowId }); if (tab) await startTracking(tab); } catch {}
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'flush') {
    flushCurrentSession().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'clearBadge') {
    chrome.action.setBadgeText({ text: '' });
    sendResponse({ ok: true });
  }
});

// ── Daily report ──────────────────────────────────────────────────────────────

async function getSettings() {
  const r = await chrome.storage.local.get('settings');
  return r.settings || { limits: {}, apiKey: '' };
}

function aggregateDomains(dayData) {
  const cats = {}, sites = {};
  for (const [domain, { category, seconds }] of Object.entries(dayData)) {
    cats[category] = (cats[category] || 0) + seconds;
    sites[domain] = { category, seconds };
  }
  return { cats, sites };
}

async function getPrevWeekCatMap() {
  const now = new Date();
  const keys = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now); d.setDate(d.getDate() - i - 1);
    return d.toLocaleDateString('en-CA');
  });
  const stored = await chrome.storage.local.get(keys);
  const map = {};
  const dayCount = Math.max(Object.keys(stored).length, 1);
  for (const dayData of Object.values(stored)) {
    for (const { category, seconds } of Object.values(dayData)) {
      map[category] = (map[category] || 0) + seconds;
    }
  }
  for (const cat of Object.keys(map)) map[cat] = Math.round(map[cat] / dayCount);
  return map;
}

async function generateDailyReport() {
  const today = getDateKey();
  const reportKey = `report-${today}`;

  // Skip if already generated today
  const existing = await chrome.storage.local.get(reportKey);
  if (existing[reportKey]) return;

  const stored = await chrome.storage.local.get(today);
  const dayData = stored[today];
  if (!dayData || !Object.keys(dayData).length) return;

  const { cats, sites } = aggregateDomains(dayData);
  const catData = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const topSites = Object.entries(sites).sort((a, b) => b[1].seconds - a[1].seconds);
  const prevMap = await getPrevWeekCatMap();
  const settings = await getSettings();

  const messages = buildDailyMessages(catData, topSites, prevMap, settings.limits, today);

  let content;
  try {
    content = await aiCall(messages, settings.apiKey || null);
  } catch (err) {
    console.error('[MyTime] AI call failed:', err);
    return;
  }

  const summary = content.replace(/\n/g, ' ').slice(0, 100);
  const report = { date: today, generatedAt: Date.now(), content, summary };
  await chrome.storage.local.set({ [reportKey]: report });

  // Badge
  chrome.action.setBadgeText({ text: '日报' });
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });

  // Notification
  chrome.notifications.create('mytime-daily', {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'MyTime · 今日日报',
    message: summary,
  });
}

// ── Alarms ───────────────────────────────────────────────────────────────────

function scheduleDailyAlarm() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(23, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  chrome.alarms.create('dailyReport', {
    when: target.getTime(),
    periodInMinutes: 24 * 60,
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'dailyReport') await generateDailyReport();
});

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const { activeTab: saved } = await chrome.storage.session.get('activeTab');
    if (saved) await saveElapsed(saved.domain, saved.startTime);
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) await startTracking(tab);
  } catch {}
  scheduleDailyAlarm();
})();
