import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * 补丁到底有没有生效 / patch effectiveness.
 *
 * 背景：官方桌面把 harness 打进 resources/app.asar，Electron 优先加载归档；
 * 插件把补丁写进解开的 resources/app/<...>。只要归档还在，写下去的文件一个都读不到，
 * 但 patch_status 仍然是 applied —— 于是“洗完了”和“生效了”是两件事。
 *
 * 这个模块只做三件事，不碰补丁本体：
 *   1) 认出当前进程到底从哪一份代码加载（sealed / unpacked / web / unknown）；
 *   2) 记一份换包账本（谁、什么时候、动到哪一步、失败原因），PS 与 node 都往里写；
 *   3) 判断解开的目录能不能直接用来启动（少文件就不许换包）。
 *
 * 只依赖 node 内置模块：core.js 会 import 它，不能再反向依赖 core。
 */

const WIN = process.platform === "win32";
const SEP = path.sep;

function norm(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return path.normalize(raw);
  } catch {
    return raw;
  }
}

function slashLower(value) {
  return norm(value).replace(/\\/g, "/").toLowerCase();
}

/* ───────────────────────────── 运行时加载源 ───────────────────────────── */

const ASAR_SEG = /[\\/]app\.asar[\\/]/i;
const ASAR_FILE = /[\\/]app\.asar$/i;
const APP_SEG = /[\\/]resources[\\/]app[\\/]/i;
const APP_SEG_ALT = /[\\/]app[\\/](?:dsh|lib|node_modules)[\\/]/i;

function collectLines(parts) {
  const out = [];
  for (const part of parts) {
    if (!part) continue;
    if (Array.isArray(part)) {
      for (const item of part) if (item) out.push(String(item));
    } else {
      out.push(String(part));
    }
  }
  return out;
}

/**
 * 纯函数：从一堆命令行片段判断加载源。
 * 只看“路径里出现了 app.asar 还是 resources/app”，不做文件系统探测。
 */
export function classifyRuntime(input = {}) {
  const lines = collectLines([
    input.argv,
    input.execArgv,
    input.probe,
    input.resourcesPath,
  ]);
  const hayStack = lines.map((line) => line.replace(/\\/g, "/").toLowerCase());

  let sealedHit = "";
  let unpackedHit = "";
  for (let i = 0; i < hayStack.length; i += 1) {
    const hay = hayStack[i];
    if (!sealedHit && (ASAR_SEG.test(hay) || ASAR_FILE.test(hay))) sealedHit = lines[i];
    if (!unpackedHit && (APP_SEG.test(hay) || APP_SEG_ALT.test(hay))) unpackedHit = lines[i];
  }

  const asarPath = norm(input.asarPath);
  const appDir = norm(input.appDir);
  if (!sealedHit && asarPath) {
    const needle = slashLower(asarPath);
    for (let i = 0; i < hayStack.length; i += 1) {
      if (hayStack[i].includes(needle)) {
        sealedHit = lines[i];
        break;
      }
    }
  }
  if (!unpackedHit && appDir) {
    const needle = `${slashLower(appDir)}/`;
    for (let i = 0; i < hayStack.length; i += 1) {
      if (hayStack[i].includes(needle)) {
        unpackedHit = lines[i];
        break;
      }
    }
  }

  if (sealedHit && !unpackedHit) {
    return {
      source: "sealed",
      evidence: sealedHit,
      reason: "命令行里是 app.asar（Electron 优先读归档）",
      asarPath,
      appDir,
    };
  }
  if (unpackedHit && !sealedHit) {
    return {
      source: "unpacked",
      evidence: unpackedHit,
      reason: "命令行里是 resources/app（已接管）",
      asarPath,
      appDir,
    };
  }
  if (sealedHit && unpackedHit) {
    // 两者都在（例如 CLI 的三级回退里同时出现），按实际入口靠前的那个判。
    const firstSealed = lines.findIndex((line) => line === sealedHit);
    const firstUnpacked = lines.findIndex((line) => line === unpackedHit);
    const sealedFirst = firstSealed >= 0 && (firstUnpacked < 0 || firstSealed <= firstUnpacked);
    return {
      source: sealedFirst ? "sealed" : "unpacked",
      evidence: sealedFirst ? sealedHit : unpackedHit,
      reason: sealedFirst ? "入口指向 app.asar" : "入口指向 resources/app",
      asarPath,
      appDir,
    };
  }
  return { source: "unknown", evidence: "", reason: "命令行里没有可判定的入口", asarPath, appDir };
}

let probeCache = { at: 0, text: "" };
const PROBE_TTL_MS = 10000;

export function resetRuntimeProbeCache() {
  probeCache = { at: 0, text: "" };
}

function safeExec(cmd, args, timeout = 4000) {
  try {
    return String(execFileSync(cmd, args, {
      timeout,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }) || "");
  } catch {
    return "";
  }
}

/**
 * 进程外探测：别的进程（CLI / 测试）想知道正在跑的桌面壳从哪加载。
 * 只读命令行，不碰进程、不发信号。失败一律返回空串，不影响主流程。
 */
export function probeHarnessCommandLines({ force = false } = {}) {
  const now = Date.now();
  if (!force && probeCache.text && now - probeCache.at < PROBE_TTL_MS) return probeCache.text;
  if (String(process.env.DSH_PURGE_NO_PS_PROBE || "") === "1") return "";
  let text = "";
  if (WIN) {
    text = safeExec("powershell.exe", [
      "-NoProfile",
      "-NoLogo",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | "
        + "Where-Object { $_.Name -match 'Harness|dsh' -and $_.CommandLine } | "
        + "ForEach-Object { $_.CommandLine }",
    ]);
  } else {
    text = safeExec("/bin/sh", ["-c", "ps -Ao command= 2>/dev/null | grep -F 'dsh' | grep -v grep"]);
  }
  probeCache = { at: now, text: String(text || "") };
  return probeCache.text;
}

/** 当前进程的加载源；进程内命令行判不出来时才去做进程外探测。 */
export function runtimeSource(input = {}) {
  const base = {
    argv: input.argv || process.argv,
    execArgv: input.execArgv || process.execArgv,
    resourcesPath: input.resourcesPath !== undefined ? input.resourcesPath : process.resourcesPath,
    asarPath: input.asarPath,
    appDir: input.appDir,
  };
  const local = classifyRuntime(base);
  if (local.source !== "unknown") return { ...local, probed: false };
  if (input.probeExternally === false) return { ...local, probed: false };
  const probe = probeHarnessCommandLines({ force: input.forceProbe === true });
  if (!probe.trim()) return { ...local, probed: true, probeFailed: true };
  const remote = classifyRuntime({ ...base, argv: [], execArgv: [], probe });
  if (remote.source === "unknown") return { ...local, probed: true, probeFailed: false };
  return { ...remote, probed: true, evidence: remote.evidence.split(/\r?\n/)[0] || remote.evidence };
}

/* ───────────────────────────── 换包账本 ───────────────────────────── */

export const SWAP_PHASES = {
  "idle-armed": "空闲接管已排队",
  requested: "已请求立即换包",
  start: "换包脚本启动",
  killed: "已结束桌面进程",
  renamed: "已挪走 app.asar",
  relaunch: "已重新打开桌面",
  done: "换包完成",
  failed: "换包失败",
  timeout: "等待超时",
  "aborted-reappeared": "换包中止（app.asar 又出现）",
  "relaunch-skipped-running": "跳过重开（桌面已在运行）",
  "tree-incomplete": "解开的目录不完整，未换包",
};

export function swapStatePath(home) {
  const base = home || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(base, "dsh-purge", "asar-swap.json");
}

export function swapLogPath(tag = "swap") {
  const stamp = `${Date.now()}-${process.pid}`;
  return path.join(os.tmpdir(), `dsh-purge-asar-${tag}-${stamp}.log`);
}

function stripBom(text) {
  return String(text || "").replace(/^\uFEFF/, "");
}

export function readSwapLedger(home) {
  const fp = swapStatePath(home);
  let raw;
  try {
    raw = fs.readFileSync(fp, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const atMs = Date.parse(String(parsed.at || ""));
  return {
    phase: String(parsed.phase || "unknown"),
    mode: String(parsed.mode || ""),
    at: String(parsed.at || ""),
    atMs: Number.isFinite(atMs) ? atMs : 0,
    error: parsed.error ? String(parsed.error) : "",
    attempts: Number(parsed.attempts || 0) || 0,
    exe: parsed.exe ? String(parsed.exe) : "",
    asar: parsed.asar ? String(parsed.asar) : "",
    reason: parsed.reason ? String(parsed.reason) : "",
    log: parsed.log ? String(parsed.log) : "",
    pid: Number(parsed.pid || 0) || 0,
  };
}

function atomicWriteJson(fp, obj) {
  const dir = path.dirname(fp);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${fp}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(tmp, fp);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 半成品留给下次覆盖 */ }
    throw error;
  }
}

/** 合并写：只覆盖传进来的字段，别的保留。node 侧写账本走这里，PS 侧自己整份写。 */
export function writeSwapLedger(home, patch = {}) {
  const prev = readSwapLedger(home) || {};
  const next = {
    ...prev,
    ...patch,
    at: patch.at || new Date().toISOString(),
  };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  try {
    atomicWriteJson(swapStatePath(home), next);
  } catch {
    return next;
  }
  return next;
}

export function clearSwapLedger(home) {
  try {
    fs.rmSync(swapStatePath(home), { force: true });
    return true;
  } catch {
    return false;
  }
}

function clockOf(iso, atMs) {
  const ms = atMs || Date.parse(String(iso || ""));
  if (!Number.isFinite(ms) || !ms) return "";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 给人看的一行：什么阶段、几点、上次为什么失败。 */
export function describeSwapLedger(entry) {
  if (!entry) return "";
  const phase = SWAP_PHASES[entry.phase] || entry.phase;
  const clock = clockOf(entry.at, entry.atMs);
  const bits = [entry.phase, clock ? `@${clock}` : "", phase].filter(Boolean);
  let text = bits.join(" ");
  if (entry.error) text += ` — ${entry.error}`;
  if (entry.log) text += ` · log=${entry.log}`;
  return text;
}

/* ───────────────────────────── 解开目录体检 ───────────────────────────── */

/**
 * 换包前必须确认 resources/app 真的能启动：
 * package.json + main 入口 + dsh/ 目录。少一个就别挪 asar，否则桌面直接打不开。
 */
export function verifyUnpackedTree(appDir) {
  const dir = norm(appDir);
  const missing = [];
  if (!dir) {
    return { ok: false, main: "", missing: ["appDir"], reason: "没有解开的目录" };
  }
  const pkgPath = path.join(dir, "package.json");
  let pkg = null;
  try {
    pkg = JSON.parse(stripBom(fs.readFileSync(pkgPath, "utf8")));
  } catch {
    missing.push("package.json");
  }
  let main = "";
  if (pkg && typeof pkg.main === "string" && pkg.main.trim()) {
    main = path.join(dir, pkg.main.trim());
    if (!fs.existsSync(main)) missing.push(`main:${pkg.main.trim()}`);
  } else if (pkg) {
    missing.push("main");
  }
  for (const rel of ["dsh", "lib"]) {
    if (!fs.existsSync(path.join(dir, rel))) missing.push(rel);
  }
  return {
    ok: missing.length === 0,
    main,
    missing,
    reason: missing.length ? `缺少 ${missing.join(", ")}` : "",
  };
}

/** 解开的目录里是不是真的有一份 @deepseek-ai（补丁写的就是这里）。 */
export function findNestedAiBase(appDir) {
  const dir = norm(appDir);
  if (!dir) return "";
  const nested = path.join(dir, "dsh", "node_modules", "@deepseek-ai");
  const flat = path.join(dir, "node_modules", "@deepseek-ai");
  for (const candidate of [nested, flat]) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch { /* 换下一个 */ }
  }
  return "";
}

/** 两段路径是否同一份安装（大小写、分隔符归一后比较）。 */
export function samePath(left, right) {
  const a = slashLower(left);
  const b = slashLower(right);
  return Boolean(a && b && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

export const runtimeInternals = {
  norm,
  sep: SEP,
  win: WIN,
};
