let currentPeriod = 'today';
let customDate = null;
let settings = { limits: {} };

const PERIOD_LABELS = {
  today: '今日总计', week: '本周总计',
  month: '本月总计', year:  '今年总计', custom: '指定日期',
};

const LIMIT_OPTIONS = [
  { label: '不限制', value: 0 },
  { label: '30 分钟', value: 1800 },
  { label: '1 小时',  value: 3600 },
  { label: '1.5 小时', value: 5400 },
  { label: '2 小时',  value: 7200 },
  { label: '3 小时',  value: 10800 },
  { label: '4 小时',  value: 14400 },
];

// ── Helpers ──────────────────────────────────────────────

function formatTime(seconds) {
  if (seconds < 60) return '< 1分钟';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}小时${m}分钟` : `${h}小时`;
}

function padRank(n) { return String(n).padStart(2, '0'); }

function getEffectiveLimit(cat) {
  const custom = settings.limits[cat];
  return custom || null; // null = use OVER_LIMIT_SECONDS default for coloring only
}

function catStatus(cat, sec) {
  const limit = getEffectiveLimit(cat);
  const threshold = limit || OVER_LIMIT_SECONDS;
  if (sec >= threshold) return 'over';
  if (limit && sec >= limit * 0.8) return 'near';
  return 'ok';
}

// ── Date keys ────────────────────────────────────────────

function getDateKeys(period, offset = 0) {
  const now = new Date();
  const keys = [];

  if (period === 'today') {
    const d = new Date(now);
    d.setDate(d.getDate() - offset);
    keys.push(d.toLocaleDateString('en-CA'));
  } else if (period === 'week') {
    const base = offset * 7;
    for (let i = base + 6; i >= base; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      keys.push(d.toLocaleDateString('en-CA'));
    }
  } else if (period === 'month') {
    const y = now.getFullYear();
    const mo = now.getMonth() - offset;
    const monthDate = new Date(y, mo, 1);
    const endDay = offset === 0 ? now.getDate() : new Date(y, mo + 1, 0).getDate();
    for (let d = 1; d <= endDay; d++)
      keys.push(`${monthDate.getFullYear()}-${String(monthDate.getMonth()+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
  } else if (period === 'year') {
    const y = now.getFullYear();
    for (let mo = 0; mo <= now.getMonth(); mo++) {
      const last = mo === now.getMonth() ? now.getDate() : new Date(y, mo+1, 0).getDate();
      for (let d = 1; d <= last; d++)
        keys.push(`${y}-${String(mo+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
    }
  } else if (period === 'custom' && customDate) {
    keys.push(customDate);
  }
  return keys;
}

// ── Data loading ──────────────────────────────────────────

async function loadDomains(period, offset = 0) {
  const keys = getDateKeys(period, offset);
  if (!keys.length) return {};
  const stored = await chrome.storage.local.get(keys);
  const domains = {};
  for (const dayData of Object.values(stored)) {
    for (const [domain, { category, seconds }] of Object.entries(dayData)) {
      if (!domains[domain]) domains[domain] = { category, seconds: 0 };
      domains[domain].seconds += seconds;
    }
  }
  // For 'today' trend: normalize previous 7-day total to a daily average
  if (period === 'today' && offset > 0) {
    const dayCount = Math.max(Object.keys(stored).length, 1);
    for (const d of Object.values(domains)) d.seconds = Math.round(d.seconds / dayCount);
  }
  return domains;
}

function aggregateByCategoryMap(domains) {
  const map = {};
  for (const { category, seconds } of Object.values(domains))
    map[category] = (map[category] || 0) + seconds;
  return map;
}

function aggregateByCategory(domains) {
  return Object.entries(aggregateByCategoryMap(domains)).sort((a, b) => b[1] - a[1]);
}

// ── Settings ──────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  settings = stored.settings || { limits: {} };
}

async function saveSettings() {
  await chrome.storage.local.set({ settings });
}

function buildLimitsList() {
  const list = document.getElementById('limitsList');
  const cats = [...Object.keys(CATEGORIES)];
  list.innerHTML = cats.map(cat => {
    const color = getCategoryColor(cat);
    const current = settings.limits[cat] || 0;
    const opts = LIMIT_OPTIONS.map(o =>
      `<option value="${o.value}" ${o.value === current ? 'selected' : ''}>${o.label}</option>`
    ).join('');
    return `
      <div class="limit-row">
        <div class="limit-cat">
          <div class="limit-dot" style="background:${color}"></div>
          ${cat}
        </div>
        <select class="limit-select" data-cat="${cat}">${opts}</select>
      </div>`;
  }).join('');
}

document.getElementById('openSettings').addEventListener('click', () => {
  buildLimitsList();
  document.getElementById('settingsModal').classList.add('open');
});

document.getElementById('closeSettings').addEventListener('click', () => {
  document.getElementById('settingsModal').classList.remove('open');
});

document.getElementById('settingsModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
});

document.getElementById('saveLimits').addEventListener('click', async () => {
  document.querySelectorAll('.limit-select').forEach(sel => {
    const cat = sel.dataset.cat;
    const val = parseInt(sel.value);
    if (val > 0) settings.limits[cat] = val;
    else delete settings.limits[cat];
  });
  await saveSettings();
  document.getElementById('settingsModal').classList.remove('open');
  refresh();
});

// ── Insight generation ────────────────────────────────────

function generateInsight(catData, prevMap) {
  const parts = [];

  // Over limit
  const overCats = catData.filter(([cat, sec]) => {
    const limit = getEffectiveLimit(cat);
    return limit && sec >= limit;
  });
  if (overCats.length)
    parts.push(`${overCats.map(([c]) => c).join('、')} 已超出你设定的每日上限`);

  // Near limit (80–99%)
  const nearCats = catData.filter(([cat, sec]) => catStatus(cat, sec) === 'near');
  if (nearCats.length)
    parts.push(`${nearCats.map(([c]) => c).join('、')} 正在接近上限`);

  // Trend: big moves vs previous period
  if (Object.keys(prevMap).length) {
    const increases = [], decreases = [];
    for (const [cat, sec] of catData) {
      const prev = prevMap[cat];
      if (!prev || prev < 60) continue;
      const delta = (sec - prev) / prev;
      if (delta >= 0.3) increases.push(`${cat} ↑${Math.round(delta * 100)}%`);
      else if (delta <= -0.3) decreases.push(`${cat} ↓${Math.round(Math.abs(delta) * 100)}%`);
    }
    if (increases.length) parts.push(`与上期相比 ${increases.slice(0, 2).join('、')}`);
    if (decreases.length) parts.push(`${decreases.slice(0, 2).join('、')}`);
  }

  return parts.length ? parts.join('；') + '。' : null;
}

// ── Render ────────────────────────────────────────────────

function renderHero(domains, catData) {
  const total = Object.values(domains).reduce((s, { seconds }) => s + seconds, 0);
  const overCats = catData.filter(([cat, sec]) => catStatus(cat, sec) === 'over');
  document.getElementById('heroPeriod').textContent = PERIOD_LABELS[currentPeriod] || '总计';
  document.getElementById('totalTime').textContent = total ? formatTime(total) : '—';
  document.getElementById('totalCats').textContent = catData.length || '—';
  document.getElementById('totalSites').textContent = Object.keys(domains).length || '—';
  const overItem = document.getElementById('overItem');
  const overSep  = document.getElementById('overSep');
  if (overCats.length) {
    overItem.style.display = '';
    overSep.style.display = '';
    document.getElementById('overCount').textContent = overCats.length;
  } else {
    overItem.style.display = 'none';
    overSep.style.display = 'none';
  }
}

function renderInsight(catData, prevMap) {
  const card = document.getElementById('insightCard');
  const text = document.getElementById('insightText');
  const msg = generateInsight(catData, prevMap);
  if (msg) { card.style.display = 'flex'; text.textContent = msg; }
  else card.style.display = 'none';
}

function renderChart(catData, prevMap) {
  const el = document.getElementById('chart');
  if (!catData.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }

  const maxSec = catData[0][1];

  el.innerHTML = `<div class="chart-rows">${
    catData.map(([cat, sec], i) => {
      const color  = getCategoryColor(cat);
      const pct    = Math.round((sec / maxSec) * 100);
      const limit  = getEffectiveLimit(cat);
      const status = catStatus(cat, sec);

      // Limit marker position on bar (relative to max)
      const limitPct = limit ? Math.min(Math.round((limit / maxSec) * 100), 100) : null;

      // Trend vs previous period
      const prev = prevMap[cat];
      let trendHtml = '';
      if (prev && prev >= 60) {
        const delta = (sec - prev) / prev;
        if (Math.abs(delta) >= 0.05) {
          const sign = delta > 0 ? '↑' : '↓';
          trendHtml = `<span class="trend">${sign}${Math.round(Math.abs(delta)*100)}%</span>`;
        }
      }

      // Badge
      const badge = status === 'over'
        ? '<span class="over-badge">超时</span>'
        : status === 'near'
          ? '<span class="near-badge">接近上限</span>'
          : '';

      // Time display
      const limitLabel = limit ? `<span class="limit-text"> / ${formatTime(limit)}</span>` : '';

      return `
        <div class="chart-row ${status !== 'ok' ? status : ''}">
          <div class="chart-rank">${padRank(i + 1)}</div>
          <div class="chart-label">${cat}</div>
          <div class="chart-track">
            <div class="chart-fill" style="width:${pct}%;background:${color}"></div>
            ${limitPct !== null ? `<div class="limit-marker" style="left:${limitPct}%"></div>` : ''}
          </div>
          <div class="chart-meta">
            <div class="chart-time">${formatTime(sec)}${limitLabel}</div>
            <div class="chart-bottom">${trendHtml}${badge}</div>
          </div>
        </div>`;
    }).join('')
  }</div>`;
}

function renderSites(domains) {
  const el = document.getElementById('sites');
  const sorted = Object.entries(domains)
    .sort((a, b) => b[1].seconds - a[1].seconds).slice(0, 20);
  if (!sorted.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const maxSec = sorted[0][1].seconds;
  el.innerHTML = `<div class="site-rows">${
    sorted.map(([domain, { category, seconds }], i) => {
      const color = getCategoryColor(category);
      const pct   = Math.round((seconds / maxSec) * 100);
      return `
        <div class="site-row">
          <div class="site-rank">${padRank(i + 1)}</div>
          <div class="site-info">
            <div class="site-domain">${domain}</div>
            <div class="site-cat">${category}</div>
          </div>
          <div class="site-bar-track">
            <div class="site-bar-fill" style="width:${pct}%;background:${color}"></div>
          </div>
          <div class="site-time">${formatTime(seconds)}</div>
        </div>`;
    }).join('')
  }</div>`;
}

// ── Main refresh ──────────────────────────────────────────

async function refresh() {
  // Load current period data + previous period for trend
  const prevOffset = ['today','week','month'].includes(currentPeriod) ? 1 : 0;
  const [domains, prevDomains] = await Promise.all([
    loadDomains(currentPeriod, 0),
    prevOffset ? loadDomains(currentPeriod, prevOffset) : Promise.resolve({}),
  ]);

  // For 'today' trend, load 7-day average: pass offset=7 meaning last 7 days
  let prevMap = aggregateByCategoryMap(prevDomains);
  if (currentPeriod === 'today') {
    const prev7 = await loadDomains('week', 1); // previous week as proxy for 7-day avg
    prevMap = aggregateByCategoryMap(prev7);
    // normalize to daily average (already done in loadDomains for offset>0 + today)
  }

  const catData = aggregateByCategory(domains);
  renderHero(domains, catData);
  renderInsight(catData, prevMap);
  renderChart(catData, prevMap);
  renderSites(domains);
}

// ── Period tabs ───────────────────────────────────────────

document.querySelectorAll('.period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelector('.period-btn.active').classList.remove('active');
    btn.classList.add('active');
    currentPeriod = btn.dataset.period;
    const picker = document.getElementById('datePicker');
    if (currentPeriod === 'custom') {
      picker.classList.add('visible');
      if (!picker.value) picker.value = new Date().toLocaleDateString('en-CA');
      customDate = picker.value;
    } else {
      picker.classList.remove('visible');
    }
    refresh();
  });
});

document.getElementById('datePicker').addEventListener('change', e => {
  customDate = e.target.value;
  refresh();
});

// ── Init ──────────────────────────────────────────────────

async function init() {
  await loadSettings();
  chrome.runtime.sendMessage({ type: 'flush' }, () => {
    if (chrome.runtime.lastError) console.warn('flush:', chrome.runtime.lastError.message);
    refresh();
  });
}

init();
