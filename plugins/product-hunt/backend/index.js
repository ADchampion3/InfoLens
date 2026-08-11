import { openStore } from "./storage.js";
import { downloadableResponse } from "@infolens/plugin-sdk";
import { createExport } from "./export.js";

const POLICIES = new Set(["manual", "disabled", "fixed"]);
const INTERVALS = new Set([15, 30, 60, 360, 720, 1440]);
const RETENTION_DAYS = new Set([7, 30, 90]);

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Product Hunt result has invalid ${field}`);
  return value.trim();
}
function nonNegative(value, field) {
  const normalized = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(normalized) || normalized < 0) throw new Error(`Product Hunt result has invalid ${field}`);
  return normalized;
}
function productUrl(value, field) {
  const raw = requiredString(value, field);
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(`Product Hunt result has invalid ${field}`); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "www.producthunt.com" || !/^\/products\/[a-z0-9-]+\/?$/i.test(parsed.pathname)) throw new Error(`Product Hunt result has invalid ${field}`);
  parsed.search = ""; parsed.hash = ""; return parsed.toString();
}

export function validateCollection(result) {
  if (!Array.isArray(result) || result.length === 0) throw new Error("Product Hunt OpenCLI result must contain rows");
  return result.map((row, index) => ({
    rank: nonNegative(row?.rank, `rows[${index}].rank`),
    name: requiredString(row?.name, `rows[${index}].name`),
    votes: nonNegative(row?.votes, `rows[${index}].votes`),
    url: productUrl(row?.url, `rows[${index}].url`),
  }));
}

export async function activate(context) {
  const store = openStore(context.resolveDataPath("product-hunt.sqlite"));
  store.cleanupOnActivation();
  let cancelSchedule;
  const summary = () => ({ source:"Product Hunt", collection:"Today's Top Launches", products:store.list(), settings:store.settings(), ...store.metadata() });
  const updateHealth = () => { const data=summary(); const unavailable=data.dependencyState==="disconnected"; context.setHealth({state:unavailable?"unavailable":"ready",badge:unavailable?"!":String(data.products.filter((item)=>!item.read).length),lastSuccessfulRefresh:data.lastSuccessfulRefresh}); };
  const configureSchedule = () => { cancelSchedule?.(); cancelSchedule=undefined; const settings=store.settings(); if(settings.policy==="fixed") cancelSchedule=context.schedule("refresh",{intervalMs:settings.intervalMinutes*60_000,reason:"schedule",coalesceKey:"collection"}); };
  context.task("refresh",async(_,task)=>{
    try {
      const products=validateCollection(await context.opencli.run("topLaunches",["--limit=20"],task.signal));
      store.replace(products,new Date().toISOString()); updateHealth(); return {ok:true,...summary()};
    } catch(error) {
      const code=error?.code; const dependencyState=code==="BROWSER_BRIDGE_DISCONNECTED"?"disconnected":"connected";
      const message=error instanceof Error?error.message:String(error); store.recordFailure(message,new Date().toISOString(),dependencyState);
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
  context.route("GET","/export",({url})=>{
    const format=url.searchParams.get("format")??"json";
    const exportedAt=new Date().toISOString();
    return downloadableResponse({filenameBase:`product-hunt-history-${exportedAt.slice(0,10)}`,format,body:createExport(context.resolveDataPath("product-hunt.sqlite"),{pluginId:"product-hunt",pluginVersion:"0.2.0",format,exportedAt})});
  });
  configureSchedule(); updateHealth(); return {async deactivate(){cancelSchedule?.();store.close();}};
}
