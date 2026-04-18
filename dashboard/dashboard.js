let currentPeriod = 'today';
let customDate = null; // YYYY-MM-DD string when period === 'custom'

function formatTime(seconds) {
  if (seconds < 60) return '< 1分钟';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}小时${m}分钟` : `${h}小时`;
}

function getDateKeys(period) {
  const now = new Date();
  const keys = [];

  if (period === 'today') {
    keys.push(now.toLocaleDateString('en-CA'));
  } else if (period === 'week') {
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      keys.push(d.toLocaleDateString('en-CA'));
    }
  } else if (period === 'month') {
    const y = now.getFullYear(), mo = now.getMonth();
    for (let d = 1; d <= now.getDate(); d++) {
      keys.push(`${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  } else if (period === 'year') {
    const y = now.getFullYear();
    for (let mo = 0; mo <= now.getMonth(); mo++) {
      const lastDay = mo === now.getMonth() ? now.getDate() : new Date(y, mo + 1, 0).getDate();
      for (let d = 1; d <= lastDay; d++) {
        keys.push(`${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
      }
    }
  } else if (period === 'custom' && customDate) {
    keys.push(customDate);
  }

  return keys;
}

async function loadDomains(period) {
  const keys = getDateKeys(period);
  if (!keys.length) return {};
  const stored = await chrome.storage.local.get(keys);
  const domains = {};
  for (const dayData of Object.values(stored)) {
    for (const [domain, { category, seconds }] of Object.entries(dayData)) {
      if (!domains[domain]) domains[domain] = { category, seconds: 0 };
      domains[domain].seconds += seconds;
    }
  }
  return domains;
}

function aggregateByCategory(domains) {
  const cats = {};
  for (const { category, seconds } of Object.values(domains)) {
    cats[category] = (cats[category] || 0) + seconds;
  }
  return Object.entries(cats).sort((a, b) => b[1] - a[1]);
}

function renderSummary(domains, catData) {
  const total = Object.values(domains).reduce((s, { seconds }) => s + seconds, 0);
  const overCats = catData.filter(([, sec]) => sec >= OVER_LIMIT_SECONDS);

  document.getElementById('totalTime').textContent = total ? formatTime(total) : '—';
  document.getElementById('totalCats').textContent = catData.length || '—';
  document.getElementById('totalSites').textContent = Object.keys(domains).length || '—';

  const overCard = document.getElementById('overCard');
  if (overCats.length > 0) {
    overCard.style.display = '';
    document.getElementById('overCount').textContent = overCats.length;
  } else {
    overCard.style.display = 'none';
  }
}

function renderChart(catData) {
  const el = document.getElementById('chart');
  if (!catData.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }

  const maxSec = catData[0][1];
  el.innerHTML = `<div class="chart-rows">${
    catData.map(([cat, sec]) => {
      const color = getCategoryColor(cat);
      const pct = Math.round((sec / maxSec) * 100);
      const over = sec >= OVER_LIMIT_SECONDS;
      return `
        <div class="chart-row ${over ? 'over' : ''}">
          <div class="chart-label" title="${cat}">${cat}</div>
          <div class="chart-track">
            <div class="chart-fill" style="width:${pct}%;background:${color}"></div>
          </div>
          <div class="chart-meta">
            ${formatTime(sec)}
            ${over ? '<span class="over-badge">超时</span>' : ''}
          </div>
        </div>`;
    }).join('')
  }</div>`;
}

function renderSites(domains) {
  const el = document.getElementById('sites');
  const sorted = Object.entries(domains)
    .sort((a, b) => b[1].seconds - a[1].seconds)
    .slice(0, 20);

  if (!sorted.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }

  const maxSec = sorted[0][1].seconds;
  el.innerHTML = `<div class="site-rows">${
    sorted.map(([domain, { category, seconds }]) => {
      const color = getCategoryColor(category);
      const pct = Math.round((seconds / maxSec) * 100);
      return `
        <div class="site-row">
          <div>
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

async function refresh() {
  const domains = await loadDomains(currentPeriod);
  const catData = aggregateByCategory(domains);
  renderSummary(domains, catData);
  renderChart(catData);
  renderSites(domains);
}

// ── Period tabs ──
document.querySelectorAll('.period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelector('.period-btn.active').classList.remove('active');
    btn.classList.add('active');
    currentPeriod = btn.dataset.period;

    const picker = document.getElementById('datePicker');
    if (currentPeriod === 'custom') {
      picker.classList.add('visible');
      // default to today if no date chosen yet
      if (!picker.value) picker.value = new Date().toLocaleDateString('en-CA');
      customDate = picker.value;
    } else {
      picker.classList.remove('visible');
    }

    refresh();
  });
});

// ── Date picker ──
document.getElementById('datePicker').addEventListener('change', e => {
  customDate = e.target.value;
  refresh();
});

// Flush current session then render
chrome.runtime.sendMessage({ type: 'flush' }, () => {
  if (chrome.runtime.lastError) console.warn('flush:', chrome.runtime.lastError.message);
  refresh();
});
