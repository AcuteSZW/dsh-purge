#!/usr/bin/env node
/**
 * 换包脚本冒烟测试（不动真安装）。
 *
 * 2 小时内踩到的坑：detached 起的 PowerShell 会在 33ms 内以 0 退出，脚本一行都没跑，
 * 所以宿主乖乖退出、App 被杀、app.asar 原地不动，账本只剩 "requested"。
 * 这个脚本在临时目录里搭一套假安装（假 app 树 + 假 asar + 假 exe），
 * 走的就是生产代码 scheduleAsarSwapRestart → launchDetached → 换包 PS1 全链路，
 * 断言脚本真的跑到 renamed / relaunch，而不是「起来了但没干活」。
 *
 * 跑法：node scripts/smoke-swap.mjs      （或 npm run smoke:swap）
 * 退出码：0 = 链路通；1 = 没跑通（附账本与日志）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const base = path.join(os.tmpdir(), `dsh-purge-smoke-${Date.now()}`);
// 用 Electron 当 node 跑时 fs 被 asar 包装过：任何 .../app.asar 路径都会被当成归档去打开。
// 沙盒里要的只是一个普通文件，先关掉这层包装。
process.noAsar = true;
// 账本挂到沙盒里，别覆盖真安装的 ~/.dsh/dsh-purge/asar-swap.json
process.env.DSH_HOME = base;

const appDir = path.join(base, "app");
const asar = path.join(base, "app.asar");
const exe = path.join(base, "DeepSeek Harness.exe");
const state = path.join(base, "swap-state.json");
const log = path.join(base, "swap.log");

function layout() {
  fs.mkdirSync(path.join(appDir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(appDir, "dsh"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "smoke", main: "lib/main.js" }));
  fs.writeFileSync(path.join(appDir, "lib", "main.js"), "// smoke\n");
  fs.writeFileSync(path.join(appDir, "dsh", "index.js"), "// smoke\n");
  fs.writeFileSync(asar, Buffer.alloc(4096, 7));
  // 假 exe：拷一个立刻退出的系统程序，脚本最后 Start-Process 它会立刻结束，不留窗口。
  fs.copyFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "hostname.exe"), exe);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(state, "utf8"));
  } catch {
    return null;
  }
}

function sh(cmd) {
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function killFixtureProcesses() {
  // 只杀临时目录里的同名进程，绝不碰真安装。
  sh(
    `Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.Path -and $_.Path.ToLower().StartsWith('${base.replace(/'/g, "''").toLowerCase()}\\') } | ` +
      `Stop-Process -Force -ErrorAction SilentlyContinue`,
  );
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* 删不掉就算了，在 %TEMP% 里 */
  }
}

async function main() {
  rmrf(base);
  layout();
  const { scheduleAsarSwapRestart } = await import(new URL("../lib/desktop.js", import.meta.url).href);
  const started = Date.now();
  // waitPid 用一个必然不存在的 pid：脚本不需要等任何人，直接进入杀进程/换包。
  const res = scheduleAsarSwapRestart({ exe, asar, waitPid: 999999999, exit: false, statePath: state, logPath: log });
  console.log("schedule:", JSON.stringify(res));

  if (!res || res.started !== true) {
    console.error("FAIL 脚本没起来（started!=true）:", JSON.stringify(res));
    console.error("launcher:", res && res.launcher);
    return 1;
  }

  // 等到 relaunch 或超时
  const deadline = Date.now() + 40000;
  let st = null;
  let seen = [];
  while (Date.now() < deadline) {
    st = readState();
    const phase = st && st.phase;
    if (phase && seen[seen.length - 1] !== phase) seen.push(phase);
    if (phase === "relaunch" || phase === "relaunch-skipped-running" || phase === "aborted-reappeared" || phase === "failed" || phase === "tree-incomplete") break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const bakExists = fs.existsSync(asar + ".bak");
  const asarGone = !fs.existsSync(asar);
  const logText = (() => {
    try {
      return fs.readFileSync(log, "utf8");
    } catch {
      return "";
    }
  })();
  const logLines = logText.split(/\r?\n/).filter(Boolean).length;

  console.log("phases:", seen.join(" → "), `(${Date.now() - started}ms)`);
  console.log("state:", JSON.stringify(st));
  console.log("asar moved:", asarGone, "| .bak exists:", bakExists, "| log lines:", logLines);
  if (logLines) console.log("log:\n" + logText.trimEnd());

  let ok = true;
  const why = [];
  const finalPhase = st && st.phase;
  // 轮询 250ms，中间态可能整段被跳过；以最终态 + 文件事实为准。
  if (finalPhase !== "relaunch" && finalPhase !== "relaunch-skipped-running") {
    ok = false;
    why.push(`最终状态不是 relaunch（是 ${finalPhase || "无"}）`);
  }
  if (!asarGone) { ok = false; why.push("app.asar 还在原地"); }
  if (!bakExists) { ok = false; why.push("没有 .bak"); }
  if (!/start/.test(logText)) { ok = false; why.push("日志里没有 start（脚本没跑到）"); }

  killFixtureProcesses();
  rmrf(base);
  if (ok) {
    console.log("PASS 换包链路跑通（launcher=" + res.launcher + "）");
    return 0;
  }
  console.error("FAIL " + why.join("；"));
  return 1;
}

process.exitCode = await main();
