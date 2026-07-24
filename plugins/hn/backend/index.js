const stories = [
  { id: 1, rank: 1, title: "边缘环境中的 SQLite：一份实战指南", domain: "fly.io", points: 428, author: "tptacek", age: "2 小时", comments: 126, read: false },
  { id: 2, rank: 2, title: "Show HN：我用纯文件做了一款本地优先笔记工具", domain: "github.com", points: 317, author: "mira", age: "3 小时", comments: 88, read: false },
  { id: 3, rank: 3, title: "维护老软件这门安静的手艺", domain: "", points: 255, author: "sarahk", age: "4 小时", comments: 42, read: true },
  { id: 4, rank: 4, title: "Postgres 索引：查询规划器真正看到了什么", domain: "pganalyze.com", points: 221, author: "nedbat", age: "5 小时", comments: 37, read: false },
  { id: 5, rank: 5, title: "现代终端渲染技术导览", domain: "mitchellh.com", points: 194, author: "tokenadult", age: "5 小时", comments: 19, read: false },
  { id: 6, rank: 6, title: "Ask HN：这个七月你在读什么？", domain: "", points: 176, author: "linh", age: "6 小时", comments: 94, read: true },
  { id: 7, rank: 7, title: "不用垃圾回收器实现内存安全", domain: "without.boats", points: 162, author: "gkaya", age: "6 小时", comments: 31, read: false },
  { id: 8, rank: 8, title: "为个人档案构建一个微型搜索引擎", domain: "jvns.ca", points: 149, author: "cantlin", age: "7 小时", comments: 18, read: false },
  { id: 9, rank: 9, title: "独立软件的经济账", domain: "lwn.net", points: 133, author: "pseudolus", age: "7 小时", comments: 24, read: false },
  { id: 10, rank: 10, title: "Show HN：从 SQLite 查询生成单文件仪表盘", domain: "github.com", points: 127, author: "simonw", age: "8 小时", comments: 16, read: true },
  { id: 11, rank: 11, title: "DNS 解析器如何选择答案", domain: "powerdns.com", points: 118, author: "teknopaul", age: "8 小时", comments: 13, read: false },
  { id: 12, rank: 12, title: "为混乱的人类日期写一个快速解析器", domain: "", points: 96, author: "karpathy", age: "9 小时", comments: 0, read: false },
  { id: 13, rank: 13, title: "命令行光标的设计史", domain: "increment.com", points: 84, author: "emmie", age: "10 小时", comments: 7, read: false },
  { id: 14, rank: 14, title: "从一张位图恢复丢失的文件系统", domain: "blog.cloudflare.com", points: 78, author: "mdp", age: "11 小时", comments: 11, read: true },
  { id: 15, rank: 15, title: "为什么小工具总能保持有用", domain: "berthub.eu", points: 66, author: "tosh", age: "12 小时", comments: 0, read: false },
];

export async function activate(context) {
  context.route("GET", "/summary", async () => ({
    source: "Hacker News",
    collection: "Top Stories",
    lastSuccessfulRefresh: "2026-07-20T05:42:00.000Z",
    stories,
  }));

  return {
    badge: "8",
    async deactivate() {},
  };
}
