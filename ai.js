// MyTime — AI module
// Supports direct Qwen API (local key) or BrainBoom proxy (no key needed)

const AI_PROXY_URL   = 'https://www.brainboom.top/api/analyze';
const AI_PROXY_TOKEN = 'mytime-proxy-k1';
const AI_QWEN_URL    = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const AI_MODEL       = 'qwen-plus';

const AI_SYSTEM_PROMPT = `你是用户的私人时间观察员，帮他看看这段时间的上网情况。
说话风格：像朋友发消息，轻松自然，不要端着；可以带点自己的观察和小吐槽，但别说教；
偶尔用「哈」「嗯」「说实话」「不过嘛」这类口语；数据说话，不废话；
中文，总字数控制在200字以内；分点写，用①②③④标号，每点1-2句。`;

function aiFormatTime(s) {
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分钟`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return m ? `${h}小时${m}分钟` : `${h}小时`;
}

// Core call — local key → direct Qwen, no key → proxy
async function aiCall(messages, localKey) {
  if (localKey) {
    const res = await fetch(AI_QWEN_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${localKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, messages }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? `Qwen ${res.status}`);
    return data.choices[0].message.content;
  } else {
    const res = await fetch(AI_PROXY_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AI_PROXY_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error ?? `Proxy ${res.status}`);
    return data.content;
  }
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildDailyMessages(catData, topSites, prevMap, limits, date) {
  const dow = ['周日','周一','周二','周三','周四','周五','周六'][new Date(date + 'T12:00:00').getDay()];
  const total = catData.reduce((s, [, sec]) => s + sec, 0);

  const catLines = catData.map(([cat, sec]) => {
    const limit = limits[cat];
    const limitNote = limit
      ? (sec >= limit ? ` 【已超 ${aiFormatTime(limit)} 上限】` : ` (上限 ${aiFormatTime(limit)})`)
      : '';
    const prev = prevMap[cat];
    const trend = prev ? ` ${sec > prev ? '↑' : '↓'}${Math.round(Math.abs(sec - prev) / prev * 100)}%` : '';
    return `  ${cat}：${aiFormatTime(sec)}${limitNote}${trend}`;
  }).join('\n');

  const siteLines = topSites.slice(0, 5)
    .map(([d, { category, seconds }]) => `  ${d}（${category}）：${aiFormatTime(seconds)}`)
    .join('\n');

  const user = `今天（${dow} ${date}）浏览数据：
总时长 ${aiFormatTime(total)}

类别明细：
${catLines}

最常访问网站：
${siteLines}

请给出：①今日概览 ②最值得关注的发现（附数据）③明日具体建议`;

  return [{ role: 'system', content: AI_SYSTEM_PROMPT }, { role: 'user', content: user }];
}

function buildWeeklyMessages(catData, topSites, prevMap, limits, label) {
  const total = catData.reduce((s, [, sec]) => s + sec, 0);

  const catLines = catData.map(([cat, sec]) => {
    const prev = prevMap[cat];
    const trend = prev ? ` ${sec > prev ? '↑' : '↓'}${Math.round(Math.abs(sec - prev) / prev * 100)}%` : '';
    const pct = Math.round(sec / total * 100);
    return `  ${cat}：${aiFormatTime(sec)}（${pct}%）${trend}`;
  }).join('\n');

  const siteLines = topSites.slice(0, 5)
    .map(([d, { category, seconds }]) => `  ${d}（${category}）：${aiFormatTime(seconds)}`)
    .join('\n');

  const user = `本周（${label}）浏览数据：
总时长 ${aiFormatTime(total)}，日均 ${aiFormatTime(Math.round(total / 7))}

类别分布（对比上周）：
${catLines}

最常访问网站：
${siteLines}

请给出：①本周总结 ②行为规律发现 ③目标执行评估 ④下周可操作建议`;

  return [{ role: 'system', content: AI_SYSTEM_PROMPT }, { role: 'user', content: user }];
}

function buildMonthlyMessages(catData, topSites, prevMap, limits, label) {
  const total = catData.reduce((s, [, sec]) => s + sec, 0);

  const catLines = catData.map(([cat, sec]) => {
    const prev = prevMap[cat];
    const trend = prev ? ` ${sec > prev ? '↑' : '↓'}${Math.round(Math.abs(sec - prev) / prev * 100)}%` : '';
    const pct = Math.round(sec / total * 100);
    return `  ${cat}：${aiFormatTime(sec)}（${pct}%）${trend}`;
  }).join('\n');

  const siteLines = topSites.slice(0, 5)
    .map(([d, { category, seconds }]) => `  ${d}（${category}）：${aiFormatTime(seconds)}`)
    .join('\n');

  const user = `本月（${label}）浏览数据：
总时长 ${aiFormatTime(total)}，日均 ${aiFormatTime(Math.round(total / 30))}

类别分布（对比上月）：
${catLines}

最常访问网站：
${siteLines}

请给出：①月度总结 ②习惯趋势变化 ③类别结构评估 ④下月目标建议`;

  return [{ role: 'system', content: AI_SYSTEM_PROMPT }, { role: 'user', content: user }];
}
