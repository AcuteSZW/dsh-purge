#!/usr/bin/env node
/**
 * 空闲接管冒烟测试（不动真安装）。
 *
 * 两件事必须成立，否则「已排队」就是空话：
 *   1) 排上队之后，真的有一个 powershell watcher 活着、心跳在刷新，用户关掉 App 时能换包；
 *   2) 锁还在、watcher 早就死了 → 不能被当成「已排队」，必须重排（本机 22:56 就卡在这）。
 *
 * 跑法：node scripts/smoke-idle.mjs（或 npm run smoke:idle）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.noAsar = true; // Electron-as-node 下 fs 被 asar 包装，沙盒里的 app.asar 只是普通文件
const base = path.join(os.tmpdir(), `dsh-purge-smoke-idle-${Date.now()}`);
process.env.DSH_HOME = base;

const appDir = path.join(base, "app");
const asar = path.join(base, "app.asar");
const exe = path.join(base, "DeepSeek Harness.exe");
const state = path.join(base, "swap-state.json");
const log = path.join(base, "idle.log");
const lock = `${asar}.rename-pending`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(state, "utf8"));
  } catch {
    return null;
  }
};

function layout() {
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(path.join(appDir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(appDir, "dsh"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "smoke", main: "lib/main.js" }));
  fs.writeFileSync(path.join(appDir, "lib", "main.js"), "// smoke\n");
  fs.writeFileSync(path.join(appDir, "dsh", "index.js"), "// smoke\n");
  fs.writeFileSync(asar, Buffer.alloc(4096, 7));
  fs.copyFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "hostname.exe"), exe);
}

function killFixtures() {
  try {
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLower().StartsWith('${base.replace(/'/g, "''").toLowerCase()}\\') } | Stop-Process -Force -ErrorAction SilentlyContinue`,
    ], { encoding: "utf8" });
  } catch {
    /* 没有就算了 */
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

const failures = [];
function check(ok, label, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(label + (detail ? " — " + detail : ""));
}

async function main() {
  layout();
  const desktop = await import(new URL("../lib/desktop.js", import.meta.url).href);

  console.log("1) 真排一次队");
  const armed = desktop.scheduleAsarRenameWhenIdle({ exe, asar, statePath: state, logPath: log, reason: "smoke" });
  console.log("   →", JSON.stringify(armed));
  check(armed.pending === true, "排上了");
  // 沙盒里没有真的 App 在跑，watcher 会在一秒内直接把活干完 —— 所以这里允许两种收尾：
  // 「watcher 活着并在等」（lock+pid 在）或「已经干完」（asar 没了 + .bak 在）。
  const watch = desktop.idleWatcherState(lock);
  const alreadyDone = !fs.existsSync(asar) && fs.existsSync(asar + ".bak");
  check(
    (watch.alive && watch.locked) || alreadyDone,
    "watcher 要么在等、要么已经干完",
    JSON.stringify({ watch, alreadyDone }),
  );

  // 「已经排过就别重复起脚本」：用一个活着的 pid（本进程）伪造排队现场。
  fs.writeFileSync(asar, Buffer.alloc(1024, 3));
  fs.writeFileSync(lock, `${Date.now()}\n`, "utf8");
  fs.writeFileSync(`${lock}.pid`, String(process.pid), "utf8");
  const again = desktop.scheduleAsarRenameWhenIdle({ exe, asar, statePath: state, logPath: log, reason: "smoke-again" });
  check(again.already === true, "活着的 watcher 在 → already（不重复起脚本）", JSON.stringify(again));
  check(!again.launcher, "already 时不再写新启动器");
  fs.rmSync(lock, { force: true });
  fs.rmSync(`${lock}.pid`, { force: true });
  fs.rmSync(asar, { force: true });

  console.log("2) 关掉 App 的效果：watcher 自己换包并重开");
  const deadline = Date.now() + 40000;
  let st = null;
  while (Date.now() < deadline) {
    st = readState();
    if (st && ["relaunch", "done", "failed", "tree-incomplete", "timeout"].includes(st.phase)) break;
    await sleep(250);
  }
  console.log("   state:", JSON.stringify(st));
  check(Boolean(st) && st.phase === "relaunch", "watcher 走到 relaunch", st && st.phase);
  check(!fs.existsSync(asar), "app.asar 被挪走");
  check(fs.existsSync(asar + ".bak"), "留下了 .bak");
  check(!fs.existsSync(lock), "换完把锁清了");

  console.log("3) 死锁不能再骗人");
  // 造一个「锁在、watcher 早没了」的局面（本机 22:56 现场）
  fs.writeFileSync(asar, Buffer.alloc(2048, 9));
  fs.writeFileSync(lock, `${Date.now()}\n`, "utf8");
  fs.writeFileSync(`${lock}.pid`, "999999999", "utf8"); // 必然不存在的 pid
  const stale = desktop.idleWatcherState(lock);
  check(!(stale.alive && stale.locked), "死锁被识别", JSON.stringify(stale));
  const rearmed = desktop.scheduleAsarRenameWhenIdle({ exe, asar, statePath: state, logPath: log, reason: "smoke-rearm" });
  console.log("   →", JSON.stringify(rearmed));
  check(rearmed.pending === true && rearmed.already !== true, "死锁被清掉并重新排队");
  check(rearmed.launcher && /asar-idle/.test(rearmed.launcher), "重新排时写了新的启动器", String(rearmed.launcher || ""));

  killFixtures();
  await sleep(300);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 留在 temp 也无害 */ }
  if (failures.length) {
    console.error("\nFAIL\n - " + failures.join("\n - "));
    return 1;
  }
  console.log("\nPASS 空闲接管：排得上、活得着、死锁会自己露馅");
  return 0;
}

process.exitCode = await main();
