import { openStore } from "./storage.js";
import { downloadableResponse } from "../../../packages/plugin-sdk/src/index.js";

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
    answers: nonNegative(row?.answers, `rows[${index}].answers`),
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

export async function activate(context) {
  const store = openStore(context.resolveDataPath("zhihu-hot.sqlite"));
  store.cleanupOnActivation();
  let cancelSchedule;
  const summary = () => ({ source:"知乎热榜", questions:store.list(), settings:store.settings(), ...store.metadata() });
  const updateHealth = () => {
    const data=summary();
    const unavailable=["disconnected","login-required"].includes(data.dependencyState);
    context.setHealth({state:unavailable?"unavailable":"ready",badge:unavailable?"!":String(data.questions.filter((item)=>!item.read).length),lastSuccessfulRefresh:data.lastSuccessfulRefresh});
  };
  const configureSchedule = () => {
    cancelSchedule?.(); cancelSchedule=undefined;
    const settings=store.settings();
    if(settings.policy==="fixed") cancelSchedule=context.schedule("refresh",{intervalMs:settings.intervalMinutes*60_000,reason:"schedule"});
  };
  context.task("refresh",async(_,task)=>{
    try {
      validateAuthStatus(await context.opencli.run("authStatus",[],task.signal));
      const questions=validateCollection(await context.opencli.run("hotQuestions",["--limit=30"],task.signal));
      store.replace(questions,new Date().toISOString()); updateHealth();
      return {ok:true,...summary()};
    } catch(error) {
      const code=error?.code;
      const dependencyState=code==="BROWSER_BRIDGE_DISCONNECTED"?"disconnected":code==="SITE_LOGIN_REQUIRED"?"login-required":"connected";
      const message=error instanceof Error?error.message:String(error);
      store.recordFailure(message,new Date().toISOString(),dependencyState);
      await context.logger.warn("collection-failed-retained-content-preserved",{code:typeof code==="string"?code:"COLLECTION_FAILED"});
      updateHealth(); return {ok:false,...summary()};
    }
  });
  context.route("GET","/summary",summary);
  context.route("POST","/refresh",()=>store.settings().policy==="disabled"?{ok:false,disabled:true,...summary()}:context.enqueue("refresh",undefined,{reason:"manual",coalesceKey:"collection"}));
  context.route("POST","/read",({url})=>{store.markRead(url.searchParams.get("url"),url.searchParams.get("read")!=="false");updateHealth();return summary();});
  context.route("GET","/settings",()=>store.settings());
  context.route("POST","/settings",({url})=>{const policy=url.searchParams.get("policy");const intervalMinutes=Number(url.searchParams.get("intervalMinutes")??60);const retentionDays=Number(url.searchParams.get("retentionDays")??store.settings().retentionDays);if(!POLICIES.has(policy)||!INTERVALS.has(intervalMinutes)||!RETENTION_DAYS.has(retentionDays))throw new Error("Unsupported refresh setting");store.saveSettings({policy,intervalMinutes,retentionDays},{acknowledgeRetentionCleanup:url.searchParams.get("acknowledgeRetentionCleanup")==="true"});configureSchedule();return store.settings();});
  context.route("GET","/history",({url})=>store.snapshots({limit:url.searchParams.get("limit"),offset:url.searchParams.get("offset")}));
  context.route("GET","/history/snapshot",({url})=>store.snapshot(url.searchParams.get("id"))??{error:"Snapshot not found"});
  context.route("GET","/export",()=>downloadableResponse(`zhihu-hot-history-${new Date().toISOString().slice(0,10)}.json`,store.createExport("0.2.0")));
  configureSchedule(); updateHealth();
  return {async deactivate(){cancelSchedule?.();store.close();}};
}
