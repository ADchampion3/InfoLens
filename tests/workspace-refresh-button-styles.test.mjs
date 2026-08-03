import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const root=path.resolve(import.meta.dirname,"..");

test("refresh animation is scoped to the icon and keeps its hover surface stable",async()=>{
  const shared=await readFile(path.join(root,"packages/plugin-sdk/src/workspace.css"),"utf8");
  assert.doesNotMatch(shared,/\.spinning svg,\s*svg\.spinning,\s*\.spinning\s*\{/,"the shared animation rotates the whole button");
  assert.match(shared,/\.icon-button\.spinning:hover,\s*\.icon\.spinning:hover\s*\{[^}]*background:\s*var\(--color-transparent\)/s,"refresh hover changes surface while spinning");
  const product=await readFile(path.join(root,"plugins/product-hunt/web/dist/workspace.css"),"utf8");
  assert.match(product,/#refresh\.spinning\s*>\s*span\s*\{[^}]*animation:\s*spin/s,"Product Hunt does not animate its icon child");
});

test("history controls never inherit transient refresh classes",async()=>{
  const source=await readFile(path.join(root,"packages/plugin-sdk/src/workspace-history.js"),"utf8");
  assert.doesNotMatch(source,/firstElementChild\?\.className/,"history controls copy the refresh button spinning class");
  assert.match(source,/classList\.contains\("icon"\)/,"history controls do not select a stable icon-button class");
});
