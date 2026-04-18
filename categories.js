const CATEGORIES = {
  '资讯': {
    color: '#6366f1',
    domains: [
      'news.ycombinator.com', 'reddit.com', 'zhihu.com', 'weibo.com',
      'toutiao.com', 'sina.com.cn', 'sohu.com', '163.com', 'qq.com',
      'ifeng.com', 'thepaper.cn', 'guancha.cn', 'nytimes.com', 'bbc.com',
      'cnn.com', 'theguardian.com', 'bloomberg.com', 'wsj.com', 'reuters.com',
      'techcrunch.com', 'theverge.com', 'wired.com', 'arstechnica.com',
    ],
  },
  '社交': {
    color: '#8b5cf6',
    domains: [
      'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'linkedin.com',
      'weixin.qq.com', 'douban.com', 'xiaohongshu.com', 'discord.com',
      'telegram.org', 'snapchat.com', 'pinterest.com',
    ],
  },
  '娱乐': {
    color: '#ec4899',
    domains: [
      'bilibili.com', 'youtube.com', 'netflix.com', 'youku.com', 'iqiyi.com',
      'mgtv.com', 'v.qq.com', 'douyin.com', 'tiktok.com', 'twitch.tv',
      'spotify.com', 'music.163.com', 'kugou.com',
    ],
  },
  '游戏': {
    color: '#f59e0b',
    domains: [
      'steampowered.com', 'epicgames.com', 'battle.net', 'roblox.com',
      'chess.com', '4399.com', 'huya.com', 'douyu.com', 'itch.io',
    ],
  },
  '购物': {
    color: '#10b981',
    domains: [
      'amazon.com', 'taobao.com', 'jd.com', 'tmall.com', 'pinduoduo.com',
      'ebay.com', 'aliexpress.com', 'etsy.com', 'walmart.com', 'suning.com',
    ],
  },
  '学习': {
    color: '#14b8a6',
    domains: [
      'coursera.org', 'udemy.com', 'edx.org', 'khanacademy.org', 'duolingo.com',
      'wikipedia.org', 'medium.com', 'juejin.cn', 'segmentfault.com', 'csdn.net',
      'leetcode.com', 'codepen.io', 'freecodecamp.org', 'developer.mozilla.org',
      'w3schools.com', 'runoob.com', 'geeksforgeeks.org',
    ],
  },
  '工具': {
    color: '#3b82f6',
    domains: [
      'notion.so', 'figma.com', 'canva.com', 'airtable.com', 'trello.com',
      'asana.com', 'slack.com', 'zoom.us', 'calendar.google.com',
      'docs.google.com', 'sheets.google.com', 'drive.google.com',
      'office.com', 'dropbox.com', 'evernote.com',
    ],
  },
  '工作': {
    color: '#64748b',
    domains: [
      'github.com', 'gitlab.com', 'bitbucket.org', 'jira.atlassian.com',
      'confluence.atlassian.com', 'stackoverflow.com', 'npmjs.com',
      'vercel.com', 'netlify.com', 'docker.com',
    ],
  },
  '搜索': {
    color: '#94a3b8',
    domains: [
      'google.com', 'baidu.com', 'bing.com', 'duckduckgo.com',
      'sogou.com', 'yandex.com', 'yahoo.com',
    ],
  },
  'AI': {
    color: '#7c3aed',
    domains: [
      'claude.ai', 'chat.openai.com', 'gemini.google.com',
      'copilot.microsoft.com', 'perplexity.ai', 'poe.com',
      'character.ai', 'anthropic.com',
    ],
  },
  '其他': {
    color: '#9ca3af',
    domains: [], // catch-all for unmatched domains
  },
};

const OVER_LIMIT_SECONDS = 7200; // 2 hours per day

function categorize(domain) {
  if (!domain) return '其他';
  const d = domain.toLowerCase().replace(/^www\./, '');
  for (const [cat, { domains }] of Object.entries(CATEGORIES)) {
    if (cat === '其他') continue;
    if (domains.some(rule => d === rule || d.endsWith('.' + rule))) {
      return cat;
    }
  }
  return '其他';
}

function getCategoryColor(cat) {
  return CATEGORIES[cat]?.color ?? '#9ca3af';
}
