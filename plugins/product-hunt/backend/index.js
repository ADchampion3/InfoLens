import { openStore } from "./storage.js";
import { downloadableResponse } from "@infolens/plugin-sdk";
import { readLatestDailySnapshot } from "@infolens/plugin-sdk/daily-summary-store";
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

function dailySummary(filename, input) {
  const snapshot = readLatestDailySnapshot(filename, {
    ...input,
    stateQuery: "SELECT product_url AS id, is_read AS isRead FROM product_user_state",
    identity: (value) => value.id ?? value.url,
    parse: (row) => {
      let records;
      try { records = JSON.parse(row.payload); } catch { throw new Error("Product Hunt snapshot payload is malformed"); }
      if (!Array.isArray(records)) throw new Error("Product Hunt snapshot payload is malformed");
      return records;
    },
  });
  if (snapshot.state === "no-data") return snapshot;
  return {
    state: "ready",
    collectedAt: snapshot.collectedAt,
    recordCount: snapshot.records.length,
    records: snapshot.records.map((product) => {
      if (!product || typeof product !== "object" || typeof product.url !== "string" || !product.url.trim() || typeof product.name !== "string" || !product.name.trim()) throw new Error("Product Hunt snapshot product is malformed");
      if (!Number.isInteger(product.rank) || product.rank < 0 || !Number.isInteger(product.votes) || product.votes < 0) throw new Error("Product Hunt snapshot product is malformed");
      return { title: product.name, url: productUrl(product.url, "snapshot.url"), rank: product.rank, read: product.read, fields: { votes: product.votes } };
    }),
  };
}

export async function activate(context) {
  const store = openStore(context.resolveDataPath("product-hunt.sqlite"));
  const storeFilename = context.resolveDataPath("product-hunt.sqlite");
  store.cleanupOnActivation();
  let cancelSchedule;
  const summary = () => ({ source:"Product Hunt", collection:"Today's Top Launches", products:store.list(), settings:store.settings(), ...store.metadata() });
  const updateHealth = () => { const data=summary(); context.setHealth({state:"ready",badge:data.dependencyState==="connected"?String(data.products.filter((item)=>!item.read).length):"!",lastSuccessfulRefresh:data.lastSuccessfulRefresh,dependencyState:data.dependencyState??"unknown",dependencyWarning:data.dependencyState!=="connected"}); };
  const configureSchedule = () => { cancelSchedule?.(); cancelSchedule=undefined; const settings=store.settings(); if(settings.policy==="fixed") cancelSchedule=context.schedule("refresh",{intervalMs:settings.intervalMinutes*60_000,reason:"schedule",coalesceKey:"collection"}); };
  context.task("refresh",async(_,task)=>{
    try {
      const products=validateCollection(await context.opencli.run("topLaunches",["--limit=20"],task.signal));
      store.replace(products,new Date().toISOString()); updateHealth(); return {ok:true,...summary()};
    } catch(error) {
      const code=error?.code; const dependencyState=code==="BROWSER_BRIDGE_DISCONNECTED"?"disconnected":"unknown";
      const message=error instanceof Error?error.message:String(error); store.recordFailure(message,new Date().toISOString(),dependencyState);
      await context.logger.warn("collection-failed-retained-content-preserved",{code:typeof code==="string"?code:"COLLECTION_FAILED"});
      updateHealth(); return {ok:false,...summary()};
    }
  });
  context.route("GET","/summary",summary);
  context.registerDailySummaryProvider((input) => dailySummary(storeFilename, input));
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
