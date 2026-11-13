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
const validate = await import(new URL("../lib/redteam/validate.js", import.meta.url));
const pagination = await import(new URL("../lib/redteam/pagination.js", import.meta.url));
const { RedteamStore } = await import(new URL("../lib/redteam/store-core.js", import.meta.url));

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

await check("分页参数：安全整数化、零值、默认值与上限", () => {
  const cases = [
    [undefined, 50], [null, 50], ['', 50], [0, 0], ['0', 0], [3, 3], [2.8, 2],
    [-1, 0], ['bad', 50], [Infinity, 50], [-Infinity, 50], [999, 200],
  ];
  for (const [input, expected] of cases) assert.equal(pagination.normalizeLimit(input, 50, 200), expected);
  assert.equal(pagination.normalizeOffset(-3), 0);
  assert.equal(pagination.normalizeOffset(2.8), 2);
  assert.equal(pagination.normalizeOffset(Infinity), 0);
  assert.equal(pagination.normalizeOffset(7), 7);
});

await check("截图：同名上传不覆盖既有证据", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "purge-shot-selftest-"));
  const store = new RedteamStore(root);
  try {
    const engagement = store.openEngagement("screenshot-test", []);
    assert.deepEqual(store.listAssets(engagement.id, { limit: 0 }).items, []);
    assert.deepEqual(store.listWeb(engagement.id, { limit: 0 }).items, []);
    const original = Buffer.from("original evidence");
    const replacement = Buffer.from("replacement evidence");
    const shot = store.addShot(engagement.id, { file: "fixed.png", data_base64: original.toString("base64") });
    assert.throws(
      () => store.addShot(engagement.id, { file: "fixed.png", data_base64: replacement.toString("base64") }),
      /already registered/,
    );
    const read = store.readShot(engagement.id, shot.id);
    assert.deepEqual(Buffer.from(read.base64, "base64"), original);
    assert.equal(read.bytes, original.length);
    const storedSha = store.db(engagement.id).prepare("SELECT sha256 FROM shot WHERE id = ?").get(shot.id).sha256;
    fs.rmSync(path.join(store.shotsDirOf(engagement.id), "fixed.png"));
    assert.throws(
      () => store.addShot(engagement.id, { file: "fixed.png", data_base64: replacement.toString("base64") }),
      /already registered/,
    );
    assert.equal(fs.existsSync(path.join(store.shotsDirOf(engagement.id), "fixed.png")), false);
    assert.equal(store.db(engagement.id).prepare("SELECT sha256 FROM shot WHERE id = ?").get(shot.id).sha256, storedSha);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("POC 删除：路径前缀相似的兄弟目录保持不变", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "purge-poc-delete-selftest-"));
  const store = new RedteamStore(root);
  const sibling = path.join(root, "pocs-evil");
  try {
    const saved = store.savePoc({ code: "safe-poc", title: "delete boundary test", content: "fixture" });
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, "keep.txt"), "keep");
    store.kb().prepare("UPDATE poc SET code = ? WHERE id = ?").run("../pocs-evil", saved.poc.id);
    assert.equal(store.deletePoc(saved.poc.id).ok, true);
    assert.equal(fs.readFileSync(path.join(sibling, "keep.txt"), "utf8"), "keep");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("路径校验：拒绝根目录内指向外部的符号链接", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "purge-path-selftest-"));
  const allowed = path.join(root, "allowed");
  const outside = path.join(root, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  try {
    fs.symlinkSync(outside, path.join(allowed, "redirect"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => validate.assertPathWithin(path.join(allowed, "redirect", "secret.txt"), [allowed]),
      /outside allowed roots/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("路径校验：拒绝目标尚不存在的悬空符号链接", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "purge-dangling-selftest-"));
  const allowed = path.join(root, "allowed");
  const outside = path.join(root, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  const link = path.join(allowed, "redirect.txt");
  const target = path.join(outside, "future.txt");
  try {
    try {
      fs.symlinkSync(target, link, "file");
    } catch (error) {
      if (["EEXIST", "EPERM", "EACCES"].includes(error.code)) {
        console.log("  - 跳过悬空文件软链用例：当前环境无创建权限");
        return;
      }
      throw error;
    }
    assert.throws(() => validate.assertPathWithin(link, [allowed]), /symlink target missing/);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("路径校验：允许目录内新建目标并拒绝目录穿越", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "purge-path-missing-"));
  const allowed = path.join(root, "allowed");
  fs.mkdirSync(allowed);
  try {
    assert.equal(validate.assertPathWithin(path.join(allowed, "new", "file.txt"), [allowed]), path.join(allowed, "new", "file.txt"));
    assert.throws(() => validate.assertPathWithin(path.join(allowed, "..", "outside"), [allowed]), /outside allowed roots/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
