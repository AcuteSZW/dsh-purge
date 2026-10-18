#!/usr/bin/env node
/**
 * dsh-purge 自检 / selftest
 *
 * 不碰运行中的宿主：只验纯函数、账本读写、状态渲染和换包脚本的语法/阶段。
 *   node scripts/selftest.mjs
 *   ELECTRON_RUN_AS_NODE=1 "<dsh exe>" scripts/selftest.mjs   # 只有桌面壳、没有 node 时
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const effect = await import(new URL("../lib/patch-effect.js", import.meta.url));
const desktop = await import(new URL("../lib/desktop.js", import.meta.url));

const results = [];
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    results.push(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    const message = String(error && error.message ? error.message : error).split("\n")[0];
    results.push(`  ✗ ${name}\n      ${message}`);
  }
}

await check("classifyRuntime: app.asar -> sealed", () => {
  const r = effect.classifyRuntime({
    argv: ["D:/X/DeepSeek Harness.exe", "--expose-internals",
      "D:\\X\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js"],
  });
  assert.equal(r.source, "sealed");
});

await check("classifyRuntime: resources/app -> unpacked", () => {
  const r = effect.classifyRuntime({
    argv: ["D:/X/DeepSeek Harness.exe", "--expose-internals",
      "D:\\X\\resources\\app\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js"],
  });
  assert.equal(r.source, "unpacked");
});

await check("classifyRuntime: 没线索 -> unknown", () => {
  assert.equal(effect.classifyRuntime({ argv: ["node", "lib/index.js"] }).source, "unknown");
});

await check("classifyRuntime: 进程外命令行参与判定", () => {
  const r = effect.classifyRuntime({
    argv: ["node", "x.js"],
    probe: '"D:\\X\\DeepSeek Harness.exe" --expose-internals D:\\X\\resources\\app.asar\\dsh\\a.js',
  });
  assert.equal(r.source, "sealed");
});

await check("账本：合并写 / 读 / BOM 容错 / 清理", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "purge-selftest-"));
  try {
    effect.writeSwapLedger(home, { phase: "idle-armed", mode: "idle", exe: "X.exe", asar: "X/app.asar" });
    assert.equal(effect.readSwapLedger(home).phase, "idle-armed");
    effect.writeSwapLedger(home, { phase: "failed", error: "sharing violation", attempts: 3 });
    const led = effect.readSwapLedger(home);
    assert.equal(led.phase, "failed");
    assert.equal(led.exe, "X.exe", "合并写保留旧字段");
    assert.ok(effect.describeSwapLedger(led).includes("sharing violation"));
    const fp = path.join(home, "dsh-purge", "asar-swap.json");
    fs.writeFileSync(fp, `\uFEFF${JSON.stringify({ phase: "relaunch", at: new Date().toISOString() })}`, "utf8");
    assert.equal(effect.readSwapLedger(home).phase, "relaunch", "BOM 容错");
    assert.equal(effect.clearSwapLedger(home), true);
    assert.equal(effect.readSwapLedger(home), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("解开的目录：不存在的目录必须判不合格", () => {
  const r = effect.verifyUnpackedTree(path.join(os.tmpdir(), "definitely-not-a-dsh-app"));
  assert.equal(r.ok, false);
  assert.ok(r.missing.length > 0);
});

await check("换包脚本：阶段齐全 + 先验目录再杀进程", () => {
  const src = desktop.swapScriptSources;
  for (const phase of ["tree-incomplete", "killed", "renamed", "relaunch", "failed", "aborted-reappeared"]) {
    assert.ok(src.swapPs1.includes(phase), `swap 缺阶段 ${phase}`);
  }
  for (const phase of ["idle-armed", "tree-incomplete", "renamed", "relaunch", "timeout"]) {
    assert.ok(src.idlePs1.includes(phase), `idle 缺阶段 ${phase}`);
  }
  const treeAt = src.swapPs1.indexOf("Write-State 'tree-incomplete'");
  const killAt = src.swapPs1.indexOf("Stop-HarnessInstall\r\n");
  assert.ok(treeAt > 0 && killAt > 0 && treeAt < killAt, `目录体检必须在杀进程之前 (tree=${treeAt}, kill=${killAt})`);
});

await check("换包脚本：PowerShell 语法可解析", () => {
  if (process.platform !== "win32") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purge-ps-"));
  try {
    const files = [
      ["swap.ps1", desktop.swapScriptSources.swapPs1],
      ["idle.ps1", desktop.swapScriptSources.idlePs1],
    ].map(([name, text]) => {
      const fp = path.join(dir, name);
      fs.writeFileSync(fp, text, "utf8");
      return fp;
    });
    const script = [
      "$bad = 0",
      `foreach ($f in @(${files.map((fp) => `'${fp.replace(/'/g, "''")}'`).join(",")})) {`,
      "  $errors = $null",
      "  [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$errors) | Out-Null",
      "  if ($errors -and $errors.Count -gt 0) { $bad = 1; foreach ($e in $errors) { Write-Output ('ERR ' + $e.Message) } }",
      "}",
      "exit $bad",
    ].join("\n");
    let out = "";
    try {
      out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
    } catch (error) {
      out = String(error?.stdout || "") + String(error?.message || "");
    }
    assert.ok(!/ERR /.test(out), `PowerShell 解析报错: ${out.trim()}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check("状态渲染：密封 / 已接管 两种都要出人话", async () => {
  const index = await import(new URL("../lib/index.js", import.meta.url));
  const base = {
    surface: "desktop",
    dsh_home: "/tmp/home",
    ai_base: "",
    files: {},
    shim_dir: null,
    desktop_shim: "/x/runtime/cli/bin",
    desktop_runtimes: [],
    has_backup: true,
    override_path: "/tmp/prompt-inject.md",
    override_status: "default",
    display_patches: [],
    patch_status: {},
    patches_applied: 10,
    patches_pending: 0,
    shim_cmd: "unreadable",
    shim_ps1: "missing",
    shim_bin: "missing",
  };
  const sealed = index.renderStatusText({
    ...base,
    runtime: { source: "sealed", reason: "argv 是 app.asar", asarPresent: true, appDir: "/x/app" },
    effective: { applied: 10, effective: 0, inert: 10, ineffective: true, note: "未生效" },
    swap: { phase: "failed" },
    swap_text: "failed @22:55 换包失败",
    asar_still_sealed: true,
  }, { inject: { active: true, text: "10 bytes" } });
  for (const needle of ["运行时加载", "0/10 已生效", "换包 / swap", "提示词注入", "读不到"]) {
    assert.ok(sealed.includes(needle), `密封状态缺 ${needle}`);
  }
  const unpacked = index.renderStatusText({
    ...base,
    runtime: { source: "unpacked", reason: "argv 是 resources/app", asarPresent: false, appDir: "/x/app" },
    effective: { applied: 10, effective: 10, inert: 0, ineffective: false, note: "已生效" },
    swap: null,
    swap_text: "",
    asar_still_sealed: false,
    shim_cmd: "binary",
  });
  assert.ok(unpacked.includes("10/10 已生效"), "已接管要报满");
  assert.ok(!unpacked.includes("app.asar: 还在"), "已接管不该再报归档还在");
  assert.ok(!/undefined/.test(sealed + unpacked), "状态里不能漏 undefined");
});

console.log("dsh-purge selftest");
console.log(results.join("\n"));
console.log(failed ? `\n${failed} 项失败 / failed` : "\n全部通过 / all checks passed");
process.exit(failed ? 1 : 0);
