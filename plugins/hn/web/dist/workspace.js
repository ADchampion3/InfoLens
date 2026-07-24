const parameters = new URLSearchParams(window.location.search);
const apiBaseUrl = parameters.get("apiBaseUrl");
const list = document.querySelector("#story-list");
const errorState = document.querySelector("#error-state");
const refreshTime = document.querySelector("#refresh-time");

function storyRow(story) {
  const row = document.createElement("li");
  row.className = `story-row${story.read ? " is-read" : ""}`;

  const rank = document.createElement("span");
  rank.className = "rank";
  rank.textContent = String(story.rank);

  const content = document.createElement("div");
  content.className = "story-content";
  const title = document.createElement("h2");
  title.className = "story-title";
  title.textContent = story.title;
  const domain = document.createElement("span");
  domain.className = "domain";
  domain.textContent = story.domain;
  title.append(domain);
  const metadata = document.createElement("div");
  metadata.className = "metadata";
  metadata.textContent = `${story.points} 分 · 作者 ${story.author} · ${story.age} · ${story.read ? "已读" : "未读"}`;
  content.append(title, metadata);

  const comments = document.createElement("span");
  comments.className = "comments";
  comments.textContent = `${story.comments} 条评论`;
  row.append(rank, content, comments);
  return row;
}

async function load() {
  if (!apiBaseUrl) throw new Error("Workspace API configuration is missing");
  const response = await fetch(new URL("summary", apiBaseUrl));
  if (!response.ok) throw new Error(`Plugin API returned ${response.status}`);
  const data = await response.json();
  list.replaceChildren(...data.stories.map(storyRow));
  const date = new Date(data.lastSuccessfulRefresh);
  refreshTime.textContent = `上次刷新 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date)}`;
}

load().catch((error) => {
  console.error(error);
  list.hidden = true;
  errorState.hidden = false;
  refreshTime.textContent = "保留内容不可用";
});
