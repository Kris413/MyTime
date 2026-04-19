let currentPeriod  = 'today';
let customDate     = null;
let settings       = { limits: {}, apiKey: '' };
let aiSiteInfo     = {};   // { rootDomain: { name, category } } — persisted in 'ai-site-info'
let aiSitePending  = false; // guard: no concurrent batch calls

const SHOW_LIMIT = 5;

const PERIOD_LABELS = {
  today: '今日总计', week: '本周总计',
  month: '本月总计', year: '今年总计', custom: '指定日期',
};

const LIMIT_OPTIONS = [
  { label: '不限制',   value: 0 },
  { label: '30 分钟',  value: 1800 },
  { label: '1 小时',   value: 3600 },
  { label: '1.5 小时', value: 5400 },
  { label: '2 小时',   value: 7200 },
  { label: '3 小时',   value: 10800 },
  { label: '4 小时',   value: 14400 },
];

// ── Format ────────────────────────────────────────────────────────────────────

function formatTime(s) {
  if (s < 60) return '< 1分钟';
  if (s < 3600) return `${Math.floor(s / 60)}分钟`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return m ? `${h}小时${m}分钟` : `${h}小时`;
}
function padRank(n) { return String(n).padStart(2, '0'); }

// Extract root/registrable domain: i.taobao.com → taobao.com, bbc.co.uk → bbc.co.uk
function getRootDomain(domain) {
  const parts = domain.split('.');
  if (parts.length <= 2) return domain;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  // Country-code + generic second-level: co.uk, com.cn, org.uk, etc.
  if (tld.length === 2 && ['com','co','org','net','gov','edu'].includes(sld)) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

// ── Limit helpers ─────────────────────────────────────────────────────────────

function getLimit(cat)       { return settings.limits[cat] || null; }
function catStatus(cat, sec) {
  const limit = getLimit(cat);
  if (!limit) return 'ok';          // 未设置上限 → 永不超时
  if (sec >= limit) return 'over';
  if (sec >= limit * 0.8) return 'near';
  return 'ok';
}

// ── Date keys ─────────────────────────────────────────────────────────────────

function getDateKeys(period, offset = 0) {
  const now  = new Date();
  const keys = [];

  if (period === 'today') {
    const d = new Date(now); d.setDate(d.getDate() - offset);
    keys.push(d.toLocaleDateString('en-CA'));
  } else if (period === 'week') {
    const base = offset * 7;
    for (let i = base + 6; i >= base; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      keys.push(d.toLocaleDateString('en-CA'));
    }
  } else if (period === 'month') {
    const target = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const endDay = offset === 0 ? now.getDate() : new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= endDay; d++)
      keys.push(`${target.getFullYear()}-${String(target.getMonth()+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
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

async function loadDomains(period, offset = 0) {
  const keys = getDateKeys(period, offset);
  if (!keys.length) return {};
  const stored = await chrome.storage.local.get(keys);
  const domains = {};
  for (const dayData of Object.values(stored)) {
    for (const [domain, data] of Object.entries(dayData)) {
      if (domain === '_hourly') continue;
      const { seconds } = data;
      // Aggregate by root domain (i.taobao.com + taobao.com → taobao.com)
      const root = getRootDomain(domain);
      // Prefer AI-identified category; fall back to stored category
      const siteAI  = aiSiteInfo[root];
      const rawCat  = data.category;
      const category = (siteAI?.category && siteAI.category !== '其他')
        ? siteAI.category
        : (rawCat !== '其他' ? rawCat : (siteAI?.category || '其他'));
      if (!domains[root]) domains[root] = { category, seconds: 0 };
      else if (domains[root].category === '其他' && category !== '其他') {
        domains[root].category = category; // upgrade if we learn a better cat later
      }
      domains[root].seconds += seconds;
    }
  }
  if (period === 'today' && offset > 0) {
    const dc = Math.max(Object.keys(stored).length, 1);
    for (const d of Object.values(domains)) d.seconds = Math.round(d.seconds / dc);
  }
  return domains;
}

function aggregateByCategoryMap(domains) {
  const m = {};
  for (const { category, seconds } of Object.values(domains))
    m[category] = (m[category] || 0) + seconds;
  return m;
}

function aggregateByCategory(domains) {
  return Object.entries(aggregateByCategoryMap(domains)).sort((a, b) => b[1] - a[1]);
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettings() {
  const r = await chrome.storage.local.get('settings');
  settings = r.settings || { limits: {}, apiKey: '' };
}

async function loadAISiteInfo() {
  const [r1, r2] = await Promise.all([
    chrome.storage.local.get('ai-site-info'),
    chrome.storage.local.get('ai-categories'),  // legacy format migration
  ]);
  aiSiteInfo = r1['ai-site-info'] || {};
  // Migrate old { domain: categoryString } → new { domain: { name, category } }
  const legacy = r2['ai-categories'] || {};
  let migrated = false;
  for (const [domain, cat] of Object.entries(legacy)) {
    if (typeof cat === 'string' && !aiSiteInfo[domain]) {
      aiSiteInfo[domain] = { name: domain, category: cat };
      migrated = true;
    }
  }
  if (migrated) {
    await chrome.storage.local.set({ 'ai-site-info': aiSiteInfo });
    await chrome.storage.local.remove('ai-categories');
  }
}

// Batch-identify unknown root domains, cache name+category, then re-render
async function runAISiteIdentification(unknownDomains) {
  if (!unknownDomains.length || aiSitePending) return;
  aiSitePending = true;

  const siteLabel = document.querySelector('#sites')?.closest('.card')?.querySelector('.card-label');
  if (siteLabel) siteLabel.dataset.hint = `AI 识别 ${unknownDomains.length} 个网站…`;

  try {
    const BATCH = 20;
    for (let i = 0; i < unknownDomains.length; i += BATCH) {
      const batch = unknownDomains.slice(i, i + BATCH);
      const result = await batchIdentifySites(batch, settings.apiKey || null);
      Object.assign(aiSiteInfo, result);
    }
    await chrome.storage.local.set({ 'ai-site-info': aiSiteInfo });
    if (siteLabel) delete siteLabel.dataset.hint;
    await refresh();
  } catch (e) {
    console.warn('[MyTime] AI site identify failed:', e);
    if (siteLabel) delete siteLabel.dataset.hint;
  } finally {
    aiSitePending = false;
  }
}

async function saveSettings() {
  await chrome.storage.local.set({ settings });
}

function buildLimitsList() {
  document.getElementById('apiKeyInput').value = settings.apiKey || '';
  const list = document.getElementById('limitsList');
  list.innerHTML = Object.keys(CATEGORIES).map(cat => {
    const color   = getCategoryColor(cat);
    const current = settings.limits[cat] || 0;
    const opts    = LIMIT_OPTIONS.map(o =>
      `<option value="${o.value}" ${o.value === current ? 'selected' : ''}>${o.label}</option>`
    ).join('');
    return `
      <div class="limit-row">
        <div class="limit-cat">
          <div class="limit-dot" style="background:${color}"></div>${cat}
        </div>
        <select class="limit-select" data-cat="${cat}">${opts}</select>
      </div>`;
  }).join('');
}

document.getElementById('openSettings').addEventListener('click', () => {
  buildLimitsList();
  document.getElementById('settingsModal').classList.add('open');
});
document.getElementById('closeSettings').addEventListener('click', () =>
  document.getElementById('settingsModal').classList.remove('open')
);
document.getElementById('settingsModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
});

document.getElementById('saveLimits').addEventListener('click', async () => {
  settings.apiKey = document.getElementById('apiKeyInput').value.trim();
  document.querySelectorAll('.limit-select').forEach(sel => {
    const val = parseInt(sel.value);
    if (val > 0) settings.limits[sel.dataset.cat] = val;
    else delete settings.limits[sel.dataset.cat];
  });
  await saveSettings();
  document.getElementById('settingsModal').classList.remove('open');
  refresh();
});

// ── Insight ───────────────────────────────────────────────────────────────────

function generateInsight(catData, prevMap) {
  const parts = [];
  const overCats = catData.filter(([cat, sec]) => { const l = getLimit(cat); return l && sec >= l; });
  if (overCats.length) parts.push(`${overCats.map(([c]) => c).join('、')} 已超出每日上限`);
  const nearCats = catData.filter(([cat, sec]) => catStatus(cat, sec) === 'near');
  if (nearCats.length) parts.push(`${nearCats.map(([c]) => c).join('、')} 接近上限`);
  if (Object.keys(prevMap).length) {
    const inc = [], dec = [];
    for (const [cat, sec] of catData) {
      const prev = prevMap[cat]; if (!prev || prev < 60) continue;
      const d = (sec - prev) / prev;
      if (d >= 0.3) inc.push(`${cat} ↑${Math.round(d*100)}%`);
      else if (d <= -0.3) dec.push(`${cat} ↓${Math.round(Math.abs(d)*100)}%`);
    }
    if (inc.length) parts.push(`与上期相比 ${inc.slice(0,2).join('、')}`);
    if (dec.length) parts.push(dec.slice(0,2).join('、'));
  }
  return parts.length ? parts.join('；') + '。' : null;
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderHero(domains, catData) {
  const total    = Object.values(domains).reduce((s, { seconds }) => s + seconds, 0);
  const overCats = catData.filter(([cat, sec]) => catStatus(cat, sec) === 'over');
  document.getElementById('heroPeriod').textContent = PERIOD_LABELS[currentPeriod] || '总计';
  document.getElementById('totalTime').textContent  = total ? formatTime(total) : '—';
  document.getElementById('totalCats').textContent  = catData.length || '—';
  document.getElementById('totalSites').textContent = Object.keys(domains).length || '—';
  const overItem = document.getElementById('overItem'), overSep = document.getElementById('overSep');
  if (overCats.length) {
    overItem.style.display = overSep.style.display = '';
    document.getElementById('overCount').textContent = overCats.length;
  } else { overItem.style.display = overSep.style.display = 'none'; }
}

function renderInsight(catData, prevMap) {
  const card = document.getElementById('insightCard');
  const msg  = generateInsight(catData, prevMap);
  if (msg) { card.style.display = 'flex'; document.getElementById('insightText').textContent = msg; }
  else card.style.display = 'none';
}

// ── Hourly data ───────────────────────────────────────────────────────────────

async function loadHourlyData(period) {
  const keys = getDateKeys(period, 0);
  if (!keys.length) return {};
  const stored = await chrome.storage.local.get(keys);
  const hourly = {};
  for (const dayData of Object.values(stored)) {
    for (const [h, sec] of Object.entries(dayData._hourly || {})) {
      hourly[h] = (hourly[h] || 0) + sec;
    }
  }
  return hourly;
}

function renderHeatmap(hourlyData) {
  const el = document.getElementById('heatmap');
  const values = Array.from({length: 24}, (_, i) => hourlyData[String(i).padStart(2, '0')] || 0);
  const hasData = values.some(v => v > 0);

  if (!hasData) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }

  const maxVal = Math.max(...values, 1);
  const peakIdx = values.indexOf(Math.max(...values));

  const cells = values.map((val, i) => {
    const opacity = val > 0 ? (0.1 + (val / maxVal) * 0.9).toFixed(2) : '0.05';
    const hStr  = String(i).padStart(2, '0');
    const hNext = String(i + 1).padStart(2, '0');
    const tip   = val > 0 ? `${hStr}:00–${hNext}:00  ${formatTime(val)}` : `${hStr}:00–${hNext}:00  无记录`;
    return `<div class="heatmap-cell" style="opacity:${opacity};--cell-delay:${i * 18}ms" title="${tip}"></div>`;
  }).join('');

  const peakH    = String(peakIdx).padStart(2, '0');
  const peakInt  = peakIdx;
  const peakPd   = peakInt < 6 ? '深夜' : peakInt < 12 ? '上午' : peakInt < 18 ? '下午' : '晚上';

  el.innerHTML = `
    <div class="heatmap-grid">${cells}</div>
    <div class="heatmap-sections">
      <span>深夜 0–6</span><span>上午 6–12</span><span>下午 12–18</span><span>晚上 18–24</span>
    </div>
    <div class="heatmap-peak">峰值 ${peakPd} ${peakH}:00 · ${formatTime(values[peakIdx])}</div>`;
}

// Animate chart bars (only visible rows get staggered; extra rows get width set instantly)
function animateChartFills() {
  requestAnimationFrame(() => {
    let idx = 0;
    document.querySelectorAll('.chart-fill[data-w]').forEach(el => {
      const isExtra = !!el.closest('.chart-row.extra');
      const delay   = isExtra ? 0 : idx++ * 90;
      setTimeout(() => { el.style.width = el.dataset.w; }, delay);
    });
  });
}

// Animate site bars (independent stagger from chart)
function animateSiteFills() {
  requestAnimationFrame(() => {
    let idx = 0;
    document.querySelectorAll('.site-bar-fill[data-w]').forEach(el => {
      const isExtra = !!el.closest('.site-row.extra');
      const delay   = isExtra ? 0 : idx++ * 90;
      setTimeout(() => { el.style.width = el.dataset.w; }, delay);
    });
  });
}

function renderChart(catData, prevMap) {
  const el = document.getElementById('chart');
  if (!catData.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }

  const maxSec  = catData[0][1];
  const hasMore = catData.length > SHOW_LIMIT;

  const rows = catData.map(([cat, sec], i) => {
    const color     = getCategoryColor(cat);
    const pct       = Math.round((sec / maxSec) * 100);
    const limit     = getLimit(cat);
    const status    = catStatus(cat, sec);
    const limitPct  = limit ? Math.min(Math.round((limit / maxSec) * 100), 100) : null;
    const prev      = prevMap[cat];
    const trendHtml = (prev && prev >= 60 && Math.abs((sec-prev)/prev) >= 0.05)
      ? `<span class="trend">${sec>prev?'↑':'↓'}${Math.round(Math.abs(sec-prev)/prev*100)}%</span>` : '';
    const badge     = status==='over' ? '<span class="over-badge">超时</span>'
      : status==='near' ? '<span class="near-badge">接近</span>' : '';
    const limitLabel = limit ? `<span class="limit-text"> / ${formatTime(limit)}</span>` : '';
    const extraClass = i >= SHOW_LIMIT ? ' extra' : '';
    const rowDelay   = i < SHOW_LIMIT ? `${i * 55}ms` : '0ms';

    return `
      <div class="chart-row ${status !== 'ok' ? status : ''}${extraClass}" style="--row-delay:${rowDelay}">
        <div class="chart-rank">${padRank(i+1)}</div>
        <div class="chart-label">${cat}</div>
        <div class="chart-track">
          <div class="chart-fill" style="width:0;background:${color}" data-w="${pct}%"></div>
          ${limitPct !== null ? `<div class="limit-marker" style="left:${limitPct}%"></div>` : ''}
        </div>
        <div class="chart-meta">
          <div class="chart-time">${formatTime(sec)}${limitLabel}</div>
          <div class="chart-bottom">${trendHtml}${badge}</div>
        </div>
      </div>`;
  }).join('');

  const moreBtn = hasMore
    ? `<button class="show-more-btn">展开全部 ${catData.length} 个类别</button>`
    : '';

  el.innerHTML = `<div class="chart-rows">${rows}</div>${moreBtn}`;

  if (hasMore) {
    const btn  = el.querySelector('.show-more-btn');
    const rowsEl = el.querySelector('.chart-rows');
    btn.addEventListener('click', () => {
      const expanded = rowsEl.classList.toggle('expanded');
      btn.textContent = expanded ? '收起' : `展开全部 ${catData.length} 个类别`;
    });
  }

  animateChartFills();
}

function renderSites(domains) {
  const el     = document.getElementById('sites');
  const sorted = Object.entries(domains).sort((a,b) => b[1].seconds - a[1].seconds);
  if (!sorted.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }

  const maxSec  = sorted[0][1].seconds;
  const hasMore = sorted.length > SHOW_LIMIT;

  const rows = sorted.map(([rootDomain, { category, seconds }], i) => {
    const color       = getCategoryColor(category);
    const pct         = Math.round((seconds / maxSec) * 100);
    const extraClass  = i >= SHOW_LIMIT ? ' extra' : '';
    const rowDelay    = i < SHOW_LIMIT ? `${i * 55}ms` : '0ms';
    // Use AI-identified name; fall back to root domain
    const siteAI      = aiSiteInfo[rootDomain];
    const displayName = (siteAI?.name && siteAI.name !== rootDomain) ? siteAI.name : rootDomain;
    const showRoot    = displayName !== rootDomain; // show domain on 2nd line only when name differs
    return `
      <div class="site-row${extraClass}" style="--row-delay:${rowDelay}">
        <div class="site-rank">${padRank(i+1)}</div>
        <div class="site-info">
          <div class="site-domain-row">
            <img class="site-favicon" src="https://www.google.com/s2/favicons?domain=${rootDomain}&sz=32" loading="lazy" onerror="this.style.display='none'">
            <span class="site-name">${displayName}</span>
          </div>
          <div class="site-sub">
            <span class="site-cat-tag">${category}</span>
            ${showRoot ? `<span class="site-root">${rootDomain}</span>` : ''}
          </div>
        </div>
        <div class="site-bar-track">
          <div class="site-bar-fill" style="width:0;background:${color}" data-w="${pct}%"></div>
        </div>
        <div class="site-time">${formatTime(seconds)}</div>
      </div>`;
  }).join('');

  const moreBtn = hasMore
    ? `<button class="show-more-btn">展开全部 ${sorted.length} 个网站</button>`
    : '';

  el.innerHTML = `<div class="site-rows">${rows}</div>${moreBtn}`;

  if (hasMore) {
    const btn    = el.querySelector('.show-more-btn');
    const rowsEl = el.querySelector('.site-rows');
    btn.addEventListener('click', () => {
      const expanded = rowsEl.classList.toggle('expanded');
      btn.textContent = expanded ? '收起' : `展开全部 ${sorted.length} 个网站`;
    });
  }

  animateSiteFills();
}

// ── AI Analysis ───────────────────────────────────────────────────────────────

// Map circled numbers to plain digits for the badge
const CIRC_TO_DIGIT = { '①':'1','②':'2','③':'3','④':'4','⑤':'5',
                         '⑥':'6','⑦':'7','⑧':'8','⑨':'9','⑩':'10' };

function renderAIContent(text) {
  if (!text) return '';
  const lines = text.trim().split('\n').filter(l => l.trim());
  const parts = [];
  const introLines = [];

  for (const line of lines) {
    const t = line.trim();
    // Circled numbers ①②③… → convert to plain digit for badge
    if (/^[①②③④⑤⑥⑦⑧⑨⑩]/.test(t)) {
      if (introLines.length) {
        parts.push(`<p class="ai-intro">${introLines.join('<br>')}</p>`);
        introLines.length = 0;
      }
      const digit = CIRC_TO_DIGIT[t[0]] || t[0];
      const body  = t.slice(1).trim();
      parts.push(`<div class="ai-point"><span class="ai-num">${digit}</span><span class="ai-body">${body}</span></div>`);
    // Digit-prefix: 1. 2、 3：
    } else if (/^\d+[.、：]/.test(t)) {
      if (introLines.length) {
        parts.push(`<p class="ai-intro">${introLines.join('<br>')}</p>`);
        introLines.length = 0;
      }
      const m     = t.match(/^(\d+)[.、：]\s*/);
      const digit = m ? m[1] : '';
      const body  = m ? t.slice(m[0].length).trim() : t;
      parts.push(`<div class="ai-point"><span class="ai-num">${digit}</span><span class="ai-body">${body}</span></div>`);
    } else {
      introLines.push(t);
    }
  }
  if (introLines.length) {
    parts.push(`<p class="ai-intro">${introLines.join('<br>')}</p>`);
  }
  return `<div class="ai-content">${parts.join('')}</div>`;
}

async function runAIAnalysis(type) {
  const resultEl = document.getElementById('aiResult');
  document.querySelectorAll('.ai-btn').forEach(b => b.disabled = true);
  resultEl.innerHTML = '<div class="ai-empty">生成中，稍等…</div>';

  const period = type === 'week' ? 'week' : 'month';
  const [domains, prevDomains] = await Promise.all([
    loadDomains(period, 0),
    loadDomains(period, 1),
  ]);

  const catData = aggregateByCategory(domains);
  const prevMap = aggregateByCategoryMap(prevDomains);
  const topSites = Object.entries(
    Object.fromEntries(Object.entries(
      await (async () => {
        const d = {};
        for (const k of getDateKeys(period, 0)) {
          const r = await chrome.storage.local.get(k);
          Object.assign(d, r[k] || {});
        }
        return d;
      })()
    ).sort((a,b) => b[1].seconds - a[1].seconds).slice(0, 5)
  ));

  const now   = new Date();
  const label = type === 'week'
    ? `${new Date(now.getFullYear(),now.getMonth(),now.getDate()-6).toLocaleDateString('zh-CN',{month:'long',day:'numeric'})}—${now.toLocaleDateString('zh-CN',{month:'long',day:'numeric'})}`
    : now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' });

  const messages = type === 'week'
    ? buildWeeklyMessages(catData, topSites, prevMap, settings.limits, label)
    : buildMonthlyMessages(catData, topSites, prevMap, settings.limits, label);

  let content;
  try {
    content = await aiCall(messages, settings.apiKey || null);
  } catch (err) {
    resultEl.innerHTML = `<div class="ai-empty" style="color:var(--over)">生成失败：${err.message}</div>`;
    document.querySelectorAll('.ai-btn').forEach(b => b.disabled = false);
    return;
  }

  const typeLabel = type === 'week' ? '周报' : '月报';
  const time      = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  resultEl.innerHTML = `
    <div class="ai-meta">
      <span class="ai-type-badge">${typeLabel}</span>
      <span class="ai-date">${label} · ${time} 生成</span>
    </div>
    ${renderAIContent(content)}`;

  document.querySelectorAll('.ai-btn').forEach(b => b.disabled = false);
}

document.querySelectorAll('.ai-btn').forEach(btn => {
  btn.addEventListener('click', () => runAIAnalysis(btn.dataset.type));
});

// ── Main refresh ──────────────────────────────────────────────────────────────

async function refresh() {
  const heroTimeEl = document.getElementById('totalTime');
  const metaEls    = document.querySelectorAll('.hero-meta-value');

  // ── Flip hero time out ────────────────────────────────────────────────────
  heroTimeEl.classList.remove('flip-in');
  void heroTimeEl.offsetWidth;               // force reflow to restart animation
  heroTimeEl.classList.add('flip-out');
  metaEls.forEach(el => el.classList.add('fading'));

  // Load data in parallel; also wait ≥190ms so flip-out animation finishes
  const [dataResults] = await Promise.all([
    Promise.all([
      loadDomains(currentPeriod, 0),
      ['today','week','month'].includes(currentPeriod) ? loadDomains(currentPeriod, 1) : Promise.resolve({}),
      loadHourlyData(currentPeriod),
    ]),
    new Promise(r => setTimeout(r, 190)),
  ]);
  const [domains, prevDomains, hourlyData] = dataResults;

  const catData = aggregateByCategory(domains);
  const prevMap = aggregateByCategoryMap(prevDomains);

  // ── Update content, then flip hero time in ────────────────────────────────
  renderHero(domains, catData);              // updates textContent first
  heroTimeEl.classList.remove('flip-out');
  void heroTimeEl.offsetWidth;
  heroTimeEl.classList.add('flip-in');
  setTimeout(() => heroTimeEl.classList.remove('flip-in'), 350);
  metaEls.forEach(el => el.classList.remove('fading'));

  renderInsight(catData, prevMap);
  renderHeatmap(hourlyData);
  renderChart(catData, prevMap);
  renderSites(domains);

  // Trigger AI identification for root domains not yet in aiSiteInfo
  const unknownDomains = Object.keys(domains).filter(d => !(d in aiSiteInfo));
  if (unknownDomains.length) runAISiteIdentification(unknownDomains);
}

// ── Custom calendar ───────────────────────────────────────────────────────────

let calViewYear  = new Date().getFullYear();
let calViewMonth = new Date().getMonth(); // 0-based

// Update "日历" button label: show selected date when a non-today date is picked
function updateCalBtnLabel() {
  const label    = document.getElementById('calBtnLabel');
  const todayStr = new Date().toLocaleDateString('en-CA');
  if (currentPeriod === 'custom' && customDate && customDate !== todayStr) {
    const d = new Date(customDate + 'T12:00:00');
    label.textContent = `${d.getMonth() + 1}月${d.getDate()}日`;
  } else {
    label.textContent = '日历';
  }
}

function renderCalendar() {
  const titleEl  = document.getElementById('calTitle');
  const gridEl   = document.getElementById('calGrid');
  const y = calViewYear, m = calViewMonth;

  titleEl.textContent = `${y}年${m + 1}月`;

  const todayStr = new Date().toLocaleDateString('en-CA');
  const firstDow = new Date(y, m, 1).getDay();        // 0=Sun
  const lastDate = new Date(y, m + 1, 0).getDate();
  const prevLast = new Date(y, m, 0).getDate();

  const prevY = m === 0 ? y - 1 : y, prevM = m === 0 ? 11 : m - 1;
  const nextY = m === 11 ? y + 1 : y, nextM = m === 11 ? 0 : m + 1;

  const totalCells = Math.ceil((firstDow + lastDate) / 7) * 7;
  const cells = [];

  for (let i = 0; i < totalCells; i++) {
    let d, ds, other = false;
    if (i < firstDow) {
      d = prevLast - firstDow + 1 + i;
      ds = `${prevY}-${String(prevM + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      other = true;
    } else if (i < firstDow + lastDate) {
      d = i - firstDow + 1;
      ds = `${y}-${String(m + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    } else {
      d = i - firstDow - lastDate + 1;
      ds = `${nextY}-${String(nextM + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      other = true;
    }
    const cls = [
      other ? 'other-month' : '',
      ds === todayStr  ? 'today'    : '',
      ds === customDate ? 'selected' : '',
    ].filter(Boolean).join(' ');
    cells.push(`<button class="cal-day${cls ? ' ' + cls : ''}" data-date="${ds}">${d}</button>`);
  }

  gridEl.innerHTML = cells.join('');
  gridEl.querySelectorAll('.cal-day').forEach(btn => {
    btn.addEventListener('click', () => {
      customDate = btn.dataset.date;
      // Close panel after picking a date, update button label
      document.getElementById('calWrap').classList.remove('visible');
      updateCalBtnLabel();
      renderCalendar();
      refresh();
    });
  });
}

document.getElementById('calPrev').addEventListener('click', () => {
  if (--calViewMonth < 0) { calViewMonth = 11; calViewYear--; }
  renderCalendar();
});
document.getElementById('calNext').addEventListener('click', () => {
  if (++calViewMonth > 11) { calViewMonth = 0; calViewYear++; }
  renderCalendar();
});
document.getElementById('calClear').addEventListener('click', () => {
  customDate = null;
  updateCalBtnLabel();
  renderCalendar();
  refresh();
});
document.getElementById('calTodayBtn').addEventListener('click', () => {
  const t = new Date();
  calViewYear = t.getFullYear(); calViewMonth = t.getMonth();
  customDate  = t.toLocaleDateString('en-CA');
  document.getElementById('calWrap').classList.remove('visible');
  updateCalBtnLabel();
  renderCalendar();
  refresh();
});

// ── Period tabs ───────────────────────────────────────────────────────────────

document.querySelectorAll('.period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelector('.period-btn.active').classList.remove('active');
    btn.classList.add('active');
    currentPeriod = btn.dataset.period;
    const calWrap = document.getElementById('calWrap');
    if (currentPeriod === 'custom') {
      // Re-open panel; default to today if no date picked yet
      if (!customDate) {
        const t = new Date();
        calViewYear = t.getFullYear(); calViewMonth = t.getMonth();
        customDate  = t.toLocaleDateString('en-CA');
      }
      calWrap.classList.add('visible');
      renderCalendar();
    } else {
      calWrap.classList.remove('visible');
    }
    updateCalBtnLabel(); // show date in button or revert to "日历"
    refresh();
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await Promise.all([loadSettings(), loadAISiteInfo()]);
  chrome.runtime.sendMessage({ type: 'flush' }, () => {
    if (chrome.runtime.lastError) console.warn('flush:', chrome.runtime.lastError.message);
    refresh();
  });
}

init();
