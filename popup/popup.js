function formatTime(seconds) {
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}小时${m}分` : `${h}小时`;
}

function getToday() {
  return new Date().toLocaleDateString('en-CA');
}

function aggregateByCategory(dayData) {
  const cats = {};
  for (const [, { category, seconds }] of Object.entries(dayData)) {
    cats[category] = (cats[category] || 0) + seconds;
  }
  return Object.entries(cats).sort((a, b) => b[1] - a[1]);
}

function renderCategories(catData) {
  const container = document.getElementById('categories');

  if (catData.length === 0) {
    container.innerHTML = '<div class="placeholder">今天还没有记录到数据</div>';
    return;
  }

  const maxSec = catData[0][1];
  const totalSec = catData.reduce((s, [, sec]) => s + sec, 0);
  document.getElementById('totalTime').textContent = formatTime(totalSec);

  container.innerHTML = catData.map(([cat, sec]) => {
    const color = getCategoryColor(cat);
    const pct = Math.round((sec / maxSec) * 100);
    const over = sec >= OVER_LIMIT_SECONDS;
    return `
      <div class="cat-item ${over ? 'over-limit' : ''}">
        <div class="cat-header">
          <div class="cat-name">
            <div class="cat-dot" style="background:${color}"></div>
            <span>${cat}</span>
            ${over ? '<span class="warn-badge">超时</span>' : ''}
          </div>
          <span class="cat-time">${formatTime(sec)}</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${pct}%;background:${color}"></div>
        </div>
      </div>`;
  }).join('');
}

async function init() {
  document.getElementById('date').textContent = new Date().toLocaleDateString('zh-CN', {
    month: 'long', day: 'numeric', weekday: 'short',
  });

  chrome.runtime.sendMessage({ type: 'flush' }, () => {
    const today = getToday();
    chrome.storage.local.get(today, result => {
      const dayData = result[today] || {};
      renderCategories(aggregateByCategory(dayData));
    });
  });
}

document.getElementById('openDashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
});

init();
