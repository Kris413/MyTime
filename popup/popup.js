function formatTime(seconds) {
  if (seconds < 60) return '< 1分钟';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}小时${m}分钟` : `${h}小时`;
}

function getToday()     { return new Date().toLocaleDateString('en-CA'); }
function getYesterday() { const d = new Date(); d.setDate(d.getDate() - 1); return d.toLocaleDateString('en-CA'); }

// ── Today's data ──────────────────────────────────────────────────────────────

function aggregateByCategory(dayData) {
  const cats = {};
  for (const [domain, data] of Object.entries(dayData)) {
    if (domain === '_hourly') continue; // skip hourly bucket — it's not a site entry
    const { category, seconds } = data;
    if (!category || seconds == null) continue; // guard against malformed entries
    cats[category] = (cats[category] || 0) + seconds;
  }
  return Object.entries(cats).sort((a, b) => b[1] - a[1]);
}

function renderCategories(catData, limits = {}) {
  const el = document.getElementById('categories');
  if (!catData.length) { el.innerHTML = '<div class="placeholder">今天还没有记录到数据</div>'; return; }

  const maxSec   = catData[0][1];
  const totalSec = catData.reduce((s, [, sec]) => s + sec, 0);
  document.getElementById('totalTime').textContent = formatTime(totalSec);

  el.innerHTML = catData.map(([cat, sec]) => {
    const color = getCategoryColor(cat);
    const pct   = Math.round((sec / maxSec) * 100);
    // 超时仅在用户手动设置了上限且超出时触发
    const limit = limits[cat] || 0;
    const over  = limit > 0 && sec >= limit;
    const near  = limit > 0 && !over && sec >= limit * 0.8;
    return `
      <div class="cat-item ${over ? 'over-limit' : near ? 'near-limit' : ''}">
        <div class="cat-header">
          <div class="cat-name">
            <div class="cat-dot" style="background:${color}"></div>
            <span>${cat}</span>
            ${over ? '<span class="warn-badge">超时</span>' : near ? '<span class="warn-badge near">接近</span>' : ''}
          </div>
          <span class="cat-time">${formatTime(sec)}</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${pct}%;background:${color}"></div>
        </div>
      </div>`;
  }).join('');
}

async function loadTodayData() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'flush' }, () => {
      chrome.storage.local.get(getToday(), r => resolve(r[getToday()] || {}));
    });
  });
}

// ── Daily report ──────────────────────────────────────────────────────────────

let reportDateShowing = getToday(); // 'today' or 'yesterday'

function renderReport(report, date) {
  const labelEl = document.getElementById('reportDateLabel');
  const bodyEl  = document.getElementById('reportBody');
  if (report) {
    const d = new Date(date + 'T12:00:00');
    const label = date === getToday() ? '今日日报' : '昨日日报';
    const time  = new Date(report.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    labelEl.textContent = `${label} · ${time} 生成`;
    bodyEl.textContent = report.content;
  } else {
    const isToday = date === getToday();
    labelEl.textContent = isToday ? '今日日报' : '昨日日报';
    bodyEl.innerHTML = `<div class="placeholder">${isToday ? '日报将于 23:00 自动生成' : '昨日暂无日报'}</div>`;
  }
}

async function loadAndShowReport(date) {
  reportDateShowing = date;
  const key = `report-${date}`;
  const r = await new Promise(res => chrome.storage.local.get(key, d => res(d[key] || null)));
  renderReport(r, date);

  // Show/hide prev button
  document.getElementById('btnPrevReport').style.display =
    date === getYesterday() ? 'none' : '';
}

async function checkReportBadge() {
  const todayReport = await new Promise(res =>
    chrome.storage.local.get(`report-${getToday()}`, d => res(d[`report-${getToday()}`] || null))
  );
  document.getElementById('tabDot').style.display = todayReport ? '' : 'none';
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelector('.tab.active').classList.remove('active');
    btn.classList.add('active');

    const tab = btn.dataset.tab;
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.getElementById(`view-${tab}`).classList.remove('hidden');

    if (tab === 'report') {
      await loadAndShowReport(getToday());
      // Clear badge when user reads report
      document.getElementById('tabDot').style.display = 'none';
      chrome.runtime.sendMessage({ type: 'clearBadge' });
    }
  });
});

document.getElementById('btnPrevReport').addEventListener('click', () => {
  loadAndShowReport(getYesterday());
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  document.getElementById('date').textContent = new Date().toLocaleDateString('zh-CN', {
    month: 'long', day: 'numeric', weekday: 'short',
  });
  const [dayData, settingsRes] = await Promise.all([
    loadTodayData(),
    new Promise(res => chrome.storage.local.get('settings', d => res(d))),
  ]);
  const limits = settingsRes.settings?.limits || {};
  renderCategories(aggregateByCategory(dayData), limits);
  await checkReportBadge();
}

document.getElementById('openDashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
});

init();
