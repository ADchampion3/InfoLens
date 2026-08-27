import { openStore } from "./history-storage.js";
import { downloadableResponse } from "@infolens/plugin-sdk";
import { readLatestDailySnapshot } from "@infolens/plugin-sdk/daily-summary-store";
import { createExport } from "./export.js";

const POLICIES = new Set(["manual", "disabled", "fixed"]);
const INTERVALS = new Set([15, 30, 60, 360, 720, 1440]);
const RETENTION_DAYS = new Set([7, 30, 90]);

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Zhihu Hot result has invalid ${field}`);
  return value.trim();
}

function nonNegative(value, field) {
  const normalized = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(normalized) || normalized < 0) throw new Error(`Zhihu Hot result has invalid ${field}`);
  return normalized;
}

function questionUrl(value, field) {
  const raw = requiredString(value, field);
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(`Zhihu Hot result has invalid ${field}`); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "www.zhihu.com" || !/^\/question\/\d+\/?$/.test(parsed.pathname)) {
    throw new Error(`Zhihu Hot result has invalid ${field}`);
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function validateCollection(result) {
  if (!Array.isArray(result) || result.length === 0) throw new Error("Zhihu Hot OpenCLI result must contain rows");
  return result.map((row, index) => ({
    rank: nonNegative(row?.rank, `rows[${index}].rank`),
    title: requiredString(row?.title, `rows[${index}].title`),
    excerpt: typeof row.excerpt === "string" && row.excerpt.trim() ? row.excerpt.trim() : null,
    heat: requiredString(row?.heat, `rows[${index}].heat`),
    answers: row?.answers === undefined ? 0 : nonNegative(row.answers, `rows[${index}].answers`),
    url: questionUrl(row?.url, `rows[${index}].url`),
    thumbnailUrl: typeof row.thumbnailUrl === "string" && row.thumbnailUrl ? row.thumbnailUrl : null,
  }));
}

export function validateAuthStatus(result) {
  const status = Array.isArray(result) ? result[0] : result;
  if (!status || typeof status !== "object" || status.logged_in !== true) {
    const error = new Error("The Zhihu login is required");
    error.code = "SITE_LOGIN_REQUIRED";
    throw error;
  }
  return true;
}

function dailySummary(filename, input) {
  const snapshot = readLatestDailySnapshot(filename, {
    ...input,
    stateQuery: "SELECT question_url AS id, is_read AS isRead FROM question_user_state",
    identity: (value) => value.id ?? value.url,
    parse: (row) => {
      let records;
      try { records = JSON.parse(row.payload); } catch { throw new Error("Zhihu Hot snapshot payload is malformed"); }
      if (!Array.isArray(records)) throw new Error("Zhihu Hot snapshot payload is malformed");
      return records;
    },
  });
  if (snapshot.state === "no-data") return snapshot;
  return {
    state: "ready",
    collectedAt: snapshot.collectedAt,
    recordCount: snapshot.records.length,
    records: snapshot.records.map((question) => {
      if (!question || typeof question !== "object" || typeof question.url !== "string" || !question.url.trim() || typeof question.title !== "string" || !question.title.trim()) throw new Error("Zhihu Hot snapshot question is malformed");
      if (!Number.isInteger(question.rank) || question.rank < 0 || !Number.isInteger(question.answers) || question.answers < 0 || typeof question.heat !== "string") throw new Error("Zhihu Hot snapshot question is malformed");
      const url = questionUrl(question.url, "snapshot.url");
      const fields = { heat: question.heat, answers: question.answers, ...(question.excerpt ? { excerpt: question.excerpt } : {}), ...(question.thumbnailUrl ? { thumbnailUrl: question.thumbnailUrl } : {}) };
      return { title: question.title, url, rank: question.rank, read: question.read, fields };
    }),
  };
}

export async function activate(context) {
  const store = openStore(context.resolveDataPath("zhihu-hot.sqlite"));
  const storeFilename = context.resolveDataPath("zhihu-hot.sqlite");
  store.cleanupOnActivation();
  const summary = () => ({ source:"知乎热榜", questions:store.list(), settings:store.settings(), ...store.metadata() });
  const updateHealth = () => {
    const data=summary();
    context.setHealth({state:"ready",badge:data.dependencyState==="connected"?String(data.questions.filter((item)=>!item.read).length):"!",lastSuccessfulRefresh:data.lastSuccessfulRefresh,dependencyState:data.dependencyState??"unknown",dependencyWarning:data.dependencyState!=="connected"});
  };
  context.task("refresh",async(_,task)=>{
    try {
      validateAuthStatus(await context.opencli.run("authStatus",[],task.signal));
      const questions=validateCollection(await context.opencli.run("hotQuestions",["--limit=30"],task.signal));
      store.replace(questions,new Date().toISOString()); updateHealth();
      return {ok:true,...summary()};
    } catch(error) {
      const code=error?.code;
      const dependencyState=code==="BROWSER_BRIDGE_DISCONNECTED"?"disconnected":code==="SITE_LOGIN_REQUIRED"?"login-required":"unknown";
      const message=error instanceof Error?error.message:String(error);
      store.recordFailure(message,new Date().toISOString(),dependencyState);
      await context.logger.warn("collection-failed-retained-content-preserved",{code:typeof code==="string"?code:"COLLECTION_FAILED"});
      updateHealth(); return {ok:false,...summary()};
    }
  });
  context.route("GET","/summary",summary);
  context.registerDailySummaryProvider((input) => dailySummary(storeFilename, input));
  context.route("POST","/refresh",()=>store.settings().policy==="disabled"?{ok:false,disabled:true,...summary()}:context.enqueue("refresh",undefined,{reason:"manual",coalesceKey:"collection"}));
  context.route("POST","/read",({url})=>{store.markRead(url.searchParams.get("url"),url.searchParams.get("read")!=="false");updateHealth();return summary();});
  context.route("GET","/settings",()=>store.settings());
  context.route("POST","/settings",({url})=>{const policy=url.searchParams.get("policy");const intervalMinutes=Number(url.searchParams.get("intervalMinutes")??60);const retentionDays=Number(url.searchParams.get("retentionDays")??store.settings().retentionDays);if(!POLICIES.has(policy)||!INTERVALS.has(intervalMinutes)||!RETENTION_DAYS.has(retentionDays))throw new Error("Unsupported refresh setting");store.saveSettings({policy,intervalMinutes,retentionDays},{acknowledgeRetentionCleanup:url.searchParams.get("acknowledgeRetentionCleanup")==="true"});return store.settings();});
  context.route("GET","/history",({url})=>store.snapshots({limit:url.searchParams.get("limit"),offset:url.searchParams.get("offset")}));
  context.route("GET","/history/snapshot",({url})=>store.snapshot(url.searchParams.get("id"))??{error:"Snapshot not found"});
  context.route("GET","/export",({url})=>{
    const format=url.searchParams.get("format")??"json";
    const exportedAt=new Date().toISOString();
    return downloadableResponse({filenameBase:`zhihu-hot-history-${exportedAt.slice(0,10)}`,format,body:createExport(context.resolveDataPath("zhihu-hot.sqlite"),{pluginId:"zhihu-hot",pluginVersion:"0.2.0",format,exportedAt})});
  });
  updateHealth();
  return {async deactivate(){store.close();}};
}
