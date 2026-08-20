import fs from "fs";
import path from "path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import TelegramBot from "node-telegram-bot-api";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import { parseRss } from "./src/parse_rss.js";
import { processAndSaveTopicData } from "./src/topic_data.js";
import {
  getProxyConfig,
  getPuppeteerProxyArgs,
  testProxyConnection,
  getCurrentIP,
} from "./src/proxy_config.js";

dotenv.config();

// ===== 日誌系統：所有 stdout/stderr 同時寫到 console + log file =====
const LOG_DIR = path.join(dirname(fileURLToPath(import.meta.url)), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_KEEP_DAYS = parseInt(process.env.LOG_KEEP_DAYS || "5", 10); // 預設保留 5 天

// 每次啟動一個 log file（timestamped）
const LOG_FILE = path.join(LOG_DIR, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

// 包裝 console.log / console.error / console.warn → 同步寫到 log file
function writeLog(level, args) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ` + args.map(a => {
    if (typeof a === "string") return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(" ") + "\n";
  logStream.write(line);
}
const _origLog = console.log;
const _origErr = console.error;
const _origWarn = console.warn;
console.log = (...args) => { _origLog(...args); writeLog("INFO", args); };
console.error = (...args) => { _origErr(...args); writeLog("ERROR", args); };
console.warn = (...args) => { _origWarn(...args); writeLog("WARN", args); };
console.info = (...args) => { _origLog(...args); writeLog("INFO", args); };

process.on("uncaughtException", (err) => {
  console.error(`[uncaughtException] ${err && err.message ? err.message : err}`);
  if (err && err.stack) console.error(err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[unhandledRejection] ${reason && reason.message ? reason.message : reason}`);
});

// 啟動時 log 環境資訊
console.log(`========== Auto-read 啟動 ==========`);
console.log(`Log file: ${LOG_FILE}`);
console.log(`Node: ${process.version} | Platform: ${process.platform} | PID: ${process.pid}`);
console.log(`Env: HEADLESS_MODE=${process.env.HEADLESS_MODE || "(default)"} PASSWORD_RETRY=${process.env.PASSWORD_RETRY || "(default)"} LOG_KEEP_DAYS=${LOG_KEEP_DAYS}`);

// ===== Log rotation：清理 LOG_KEEP_DAYS 天前的 logs =====
function rotateOldLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR);
    const now = Date.now();
    let removed = 0;
    for (const f of files) {
      if (!f.endsWith(".log")) continue;
      const fullPath = path.join(LOG_DIR, f);
      try {
        const stat = fs.statSync(fullPath);
        const ageDays = (now - stat.mtimeMs) / (1000 * 60 * 60 * 24);
        if (ageDays > LOG_KEEP_DAYS) {
          fs.unlinkSync(fullPath);
          removed++;
        }
      } catch {}
    }
    if (removed > 0) console.log(`🧹 已清理 ${removed} 個超過 ${LOG_KEEP_DAYS} 天的 log`);
  } catch (e) {
    console.warn("rotateOldLogs failed:", e.message);
  }
}
rotateOldLogs();

// 捕获未处理的异常/Promise拒绝，避免因 Target closed 之类错误导致进程退出
process.on("unhandledRejection", (reason) => {
  try {
    const msg = (reason && reason.message) ? reason.message : String(reason);
    console.warn("[unhandledRejection]", msg);
  } catch {
    console.warn("[unhandledRejection] (non-string reason)");
  }
});
process.on("uncaughtException", (err) => {
  try {
    const msg = (err && err.message) ? err.message : String(err);
    console.warn("[uncaughtException]", msg);
  } catch {
    console.warn("[uncaughtException] (non-string error)");
  }
});

// 截图保存的文件夹
// const screenshotDir = "screenshots";
// if (!fs.existsSync(screenshotDir)) {
//   fs.mkdirSync(screenshotDir);
// }
puppeteer.use(StealthPlugin());

// Load the default .env file
if (fs.existsSync(".env.local")) {
  console.log("Using .env.local file to supply config environment variables");
  const envConfig = dotenv.parse(fs.readFileSync(".env.local"));
  for (const k in envConfig) {
    process.env[k] = envConfig[k];
  }
} else {
  console.log(
    "Using .env file to supply config environment variables, you can create a .env.local file to overwrite defaults, it doesn't upload to git"
  );
}

// 读取以分钟为单位的运行时间限制
const runTimeLimitMinutes = process.env.RUN_TIME_LIMIT_MINUTES || 20;

// 将分钟转换为毫秒
const runTimeLimitMillis = runTimeLimitMinutes * 60 * 1000;

console.log(
  `运行时间限制为：${runTimeLimitMinutes} 分钟 (${runTimeLimitMillis} 毫秒)`
);

// 活动会话注册表：username -> { page, domain }。用于退出前保存最新的 _t（Discourse 会在会话期间轮换 _t）
const activeSessions = new Map();
// 从浏览器读取最新 _t 并写回 .env（浏览器始终持有轮换后的最新 token）
async function saveFreshestCookie(username, page, domain) {
  try {
    if (!page || (page.isClosed && page.isClosed())) return;
    const client = await page.createCDPSession().catch(() => null);
    let cookies = [];
    if (client) {
      const res = await client.send('Network.getAllCookies').catch(() => ({ cookies: [] }));
      cookies = (res.cookies || []).filter(c => c.domain.includes(domain));
    } else {
      cookies = await page.cookies(loginUrl).catch(() => []);
    }
    const tCookie = cookies.find(c => c.name === '_t');
    if (tCookie) {
      await updateCookieInEnv(username, [`_t=${tCookie.value}`]);
      console.log(`💾 已保存最新 _t: ${maskUsername(username)}`);
    }
  } catch (e) {
    console.warn("saveFreshestCookie failed:", e && e.message ? e.message : e);
  }
}

// 设置一个定时器，在运行时间到达时终止进程
const shutdownTimer = setTimeout(async () => {
  console.log("时间到,Reached time limit, 退出前保存所有账号最新 _t cookie...");
  // 退出前保存每个活动会话的最新 _t（关键：跨运行复用需要最新 token）
  try {
    await Promise.all(
      [...activeSessions.entries()].map(([username, sess]) =>
        saveFreshestCookie(username, sess.page, sess.domain)
      )
    );
  } catch (e) {
    console.warn("退出前保存 cookie 失败:", e && e.message ? e.message : e);
  }
  // 關閉所有開過的 browser（含 chromium 子進程）
  try {
    const { execSync } = await import("child_process");
    console.log("清理殘留 Chrome 進程...");
    execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' });
  } catch (e) {
    console.warn("清理 chrome 失敗:", e && e.message ? e.message : e);
  }
  console.log("Reached time limit, shutting down the process...");
  process.exit(0); // 退出进程
}, runTimeLimitMillis);

// 全域 signal handler：Ctrl+C / kill 時也清 chrome
async function cleanupAndExit(code) {
  try {
    const { execSync } = await import("child_process");
    execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' });
  } catch {}
  process.exit(code);
}
process.on('SIGINT', () => cleanupAndExit(130));
process.on('SIGTERM', () => cleanupAndExit(143));
// finally 區塊也會清，這裡保險用

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const groupId = process.env.TELEGRAM_GROUP_ID;
const specificUser = process.env.SPECIFIC_USER || "14790897";
const maxConcurrentAccounts = parseInt(process.env.MAX_CONCURRENT_ACCOUNTS) || 3; // 每批最多同时运行的账号数
const usernames = process.env.USERNAMES.split(",");
const passwords = process.env.PASSWORDS ? process.env.PASSWORDS.split(",") : [];
// 读取每个账号对应的Cookie（逗号分隔，与USERNAMES一一对应），有Cookie则跳过表单登录
const cookiesEnv = process.env.COOKIES ? process.env.COOKIES.split(",") : [];
const loginUrl = process.env.WEBSITE || "https://linux.do"; //在GitHub action环境里它不能读取默认环境变量,只能在这里设置默认值
const delayBetweenInstances = 20000; // 20秒间隔避免限流
const totalAccounts = usernames.length; // 总的账号数
const delayBetweenBatches =
  runTimeLimitMillis / Math.ceil(totalAccounts / maxConcurrentAccounts);
const isLikeSpecificUser = process.env.LIKE_SPECIFIC_USER === "true"; // 只有明确设置为"true"才开启
const isAutoLike = process.env.AUTO_LIKE !== "false"; // 默认开启，只有明确设置为"false"才关闭
const hideAccountInfo = process.env.HIDE_ACCOUNT_INFO !== "false"; // 默认隐藏账号信息，只有明确设置为"false"才显示
const enableRssFetch = process.env.ENABLE_RSS_FETCH === "true"; // 是否开启抓取RSS，只有明确设置为"true"才开启，默认为false
const enableTopicDataFetch = process.env.ENABLE_TOPIC_DATA_FETCH === "true"; // 是否开启抓取话题数据，只有明确设置为"true"才开启，默认为false

// 账号名脱敏函数，默认仅显示首字母加***
function maskUsername(username) {
  if (!hideAccountInfo) return username;
  if (!username || username.length === 0) return "***";
  return username[0] + "***";
}

console.log(
  `RSS抓取功能状态: ${enableRssFetch ? "开启" : "关闭"} (环境变量值: "${process.env.ENABLE_RSS_FETCH || ''}")，勿设置`
);
console.log(
  `话题数据抓取功能状态: ${
    enableTopicDataFetch ? "开启" : "关闭"
  } (环境变量值: "${process.env.ENABLE_TOPIC_DATA_FETCH || ''}")，勿设置`
);

// 代理配置
const proxyConfig = getProxyConfig();
if (proxyConfig) {
  console.log(
    `代理配置: ${proxyConfig.type}://${proxyConfig.host}:${proxyConfig.port}`
  );

  // 测试代理连接
  console.log("正在测试代理连接...");
  const proxyWorking = await testProxyConnection(proxyConfig);
  if (proxyWorking) {
    console.log("✅ 代理连接测试成功");
  } else {
    console.log("❌ 代理连接测试失败，将使用直连");
  }
} else {
  console.log("未配置代理，使用直连");
  const currentIP = await getCurrentIP();
  if (currentIP) {
    console.log(`当前IP地址: ${currentIP}`);
  }
}

let bot;
if (token && (chatId || groupId)) {
  bot = new TelegramBot(token);
}
// 简单的 Telegram 发送重试
async function tgSendWithRetry(id, message, maxRetries = 3) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await bot.sendMessage(id, message);
      return true;
    } catch (e) {
      lastErr = e;
      const delay = 1500 * (i + 1);
      console.error(
        `Telegram send failed (attempt ${i + 1}/${maxRetries}): ${
          e && e.message ? e.message : e
        }`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
async function sendToTelegram(message) {
  if (!bot || !chatId) return;
  try {
    await tgSendWithRetry(chatId, message, 3);
    console.log("Telegram message sent successfully");
  } catch (error) {
    console.error(
      "Error sending Telegram message:",
      error && error.code ? error.code : "",
      error && error.message
        ? error.message.slice(0, 100)
        : String(error).slice(0, 100)
    );
  }
}
async function sendToTelegramGroup(message) {
  if (!bot || !groupId) {
    console.error("sendToTelegramGroup: bot 或 groupId 不存在");
    return;
  }
  // 过滤空内容，避免 Telegram 400 错误
  if (!message || !String(message).trim()) {
    console.warn("Telegram 群组推送内容为空，跳过发送");
    return;
  }
  // 分割长消息，Telegram单条最大4096字符
  const MAX_LEN = 4000;
  if (typeof message === "string" && message.length > MAX_LEN) {
    let start = 0;
    let part = 1;
    while (start < message.length) {
      const chunk = message.slice(start, start + MAX_LEN);
      try {
        await tgSendWithRetry(groupId, chunk, 3);
        console.log(`Telegram group message part ${part} sent successfully`);
      } catch (error) {
        console.error(
          `Error sending Telegram group message part ${part}:`,
          error
        );
      }
      start += MAX_LEN;
      part++;
    }
  } else {
    try {
      await tgSendWithRetry(groupId, message, 3);
      console.log("Telegram group message sent successfully");
    } catch (error) {
      console.error("Error sending Telegram group message:", error);
    }
  }
}

// 發送 Cloudflare challenge 截圖到 Telegram（給使用者手動解）
async function sendCfScreenshotToTelegram(page, username) {
  if (!bot || !chatId) {
    console.warn("sendCfScreenshotToTelegram: bot/chatId 不存在，跳過");
    return;
  }
  try {
    // 先存成 temp file → 用 file path 送（Telegram node-api 對 buffer 有時 parse 失敗）
    const os = await import("os");
    const fsMod = await import("fs");
    const tmpDir = os.tmpdir();
    const fileName = `cf-${username.replace(/[^a-zA-Z0-9]/g, "_")}-${Date.now()}.png`;
    const filePath = `${tmpDir}\\${fileName}`.replace(/\\/g, "/");
    await page.screenshot({ path: filePath, type: "png", fullPage: false });
    const masked = maskUsername(username);
    const caption =
      `🛡️ Cloudflare challenge 等待中\n` +
      `帳號: ${masked}\n` +
      `請打開你的瀏覽器 → http://localhost:9222\n` +
      `（或直接到 linux.do 通過 challenge）\n` +
      `通過後腳本會自動繼續。`;
    // 用 sendPhoto（傳 file path） + contentType
    await bot.sendPhoto(chatId, filePath, {
      caption: caption.slice(0, 1024),
      contentType: "image/png",
    });
    console.log(`📸 CF 截圖已送出 (${masked}) → ${filePath}`);
    // 清理 tmp file
    try { fsMod.unlinkSync(filePath); } catch {}
  } catch (e) {
    console.warn(`sendCfScreenshotToTelegram 失敗: ${e.message}`);
  }
}

// 發送 Cloudflare 提示 + 截圖到 Telegram（每 30 秒最多一次，避免刷屏）
const _cfNotifyState = new Map(); // username -> lastNotifyTs
async function notifyCfChallenge(page, username, reason) {
  const now = Date.now();
  const last = _cfNotifyState.get(username) || 0;
  if (now - last < 30000) return; // 30 秒節流
  _cfNotifyState.set(username, now);
  const masked = maskUsername(username);
  const msg =
    `🛡️ Cloudflare challenge 等待手動通過\n` +
    `帳號: ${masked}\n` +
    `原因: ${reason || 'CF page detected'}\n` +
    `請到瀏覽器視窗手動通過 challenge\n` +
    `腳本會等你最多 5 分鐘`;
  console.log(msg);
  await sendToTelegram(msg);
  await sendToTelegramGroup(msg);
  // 同時送截圖
  await sendCfScreenshotToTelegram(page, username);
}

//随机等待时间
function delayClick(time) {
  return new Promise(function (resolve) {
    setTimeout(resolve, time);
  });
}

(async () => {
  // 追蹤成功登入的帳號數，啟動時通知（避免偽綠燈：腳本跑 25 分鐘但一個 cookie 沒過期）
  let successCount = 0;
  let fatalError = null; // 收集致命錯誤，最後統一處理
  try {
    // 啟動時通知（DEBUG 用：確認排程/手動觸發有真的進到腳本）
    if (token && chatId) {
      sendToTelegram(`🚀 Auto-read 啟動：${usernames.length} 帳號 / 限制 ${process.env.RUN_TIME_LIMIT_MINUTES || 25} 分鐘`);
    }
    // 檢查 cookie / password 配置
    const nonEmptyCookies = cookiesEnv.filter((c) => c && c.trim());
    const hasAnyCookie = nonEmptyCookies.length > 0;
    const hasAnyPassword = passwords.length > 0 && passwords.some((p) => p && p.trim());
    // 有Cookie则跳过密码数量校验
    if (!hasAnyCookie && passwords.length !== usernames.length) {
      console.log(
        `usernames: ${usernames.length}, passwords: ${passwords.length}`,
      );
      throw new Error("用户名和密码的数量不匹配！");
    }
    // 有 cookie 但完全沒有 password，且數量不匹配 → 不要 throw（之前 8/15 卡這裡 25 分鐘）
    // 改為：log warning 並繼續，由各帳號自己決定 fallback（會 throw 提早失敗）
    if (hasAnyCookie && passwords.length !== usernames.length && passwords.length !== 0) {
      console.warn(
        `⚠️ usernames=${usernames.length} 但 passwords=${passwords.length}（有 cookie 仍會繼續運行）`,
      );
    }

    // 并发启动浏览器实例进行登录
    const loginTasks = usernames.map((username, index) => {
      const password = passwords[index] || "";
      const cookie = cookiesEnv[index] ? cookiesEnv[index].trim() : null;
      const delay = (index % maxConcurrentAccounts) * delayBetweenInstances; // 使得每一组内的浏览器可以分开启动
      return () => {
        return new Promise((resolve) => {
          setTimeout(() => {
            launchBrowserForUser(username, password, cookie)
              .then((r) => {
                if (r && r.loggedIn) successCount++;
                else if (r && r.error) {
                  // 個別帳號的錯誤（不會 throw 整個 script 崩潰）
                  console.warn(`⚠️ ${maskUsername(username)} 登入失敗：${r.error}`);
                }
                resolve(r);
              })
              .catch((e) => {
                // 個別帳號拋錯：記錄但不 throw（讓其他帳號繼續）
                console.error(`❌ ${maskUsername(username)} 拋錯：${e.message}`);
                sendToTelegram(`❌ ${maskUsername(username)} 拋錯：${e.message}`);
                resolve({ browser: null, loggedIn: false, error: e.message });
              });
          }, delay);
        });
      };
    });
    // 依次执行每个批次的任务
    for (let i = 0; i < totalAccounts; i += maxConcurrentAccounts) {
      console.log(`当前批次：${i + 1} - ${i + maxConcurrentAccounts}`);
      // 执行每批次最多 4 个账号
      const batch = loginTasks
        .slice(i, i + maxConcurrentAccounts)
        .map(async (task) => {
          const { browser } = await task(); // 运行任务并获取浏览器实例
          return browser;
        }); // 等待当前批次的任务完成
      const browsers = await Promise.all(batch); // Task里面的任务本身是没有进行await的, 所以会继续执行下面的代码

      // 如果还有下一个批次，等待指定的时间,同时，如果总共只有一个账号，也需要继续运行
      if (i + maxConcurrentAccounts < totalAccounts || i === 0) {
        console.log(`等待 ${delayBetweenBatches / 1000} 秒`);
        await new Promise((resolve) =>
          setTimeout(resolve, delayBetweenBatches),
        );
      } else {
        console.log("没有下一个批次，即将结束");
      }
      console.log(
        `批次 ${
          Math.floor(i / maxConcurrentAccounts) + 1
        } 完成，关闭浏览器...,浏览器对象：${browsers}`,
      );
      // 关闭浏览器前，先保存每个活动会话的最新 _t cookie
      try {
        await Promise.all(
          [...activeSessions.entries()].map(([uname, sess]) =>
            saveFreshestCookie(uname, sess.page, sess.domain)
          )
        );
      } catch (e) {
        console.warn("关闭前保存 cookie 失败:", e && e.message ? e.message : e);
      }
      // 关闭所有浏览器实例
      for (const browser of browsers) {
        await browser.close();
      }
    }

    console.log("所有账号登录操作已完成");
    // 等所有登录完成後再統一通知（避免偽綠燈：之前有跑 25 分鐘一個 cookie 都沒過期的情況）
    console.log(`成功登入: ${successCount}/${totalAccounts}`);
    if (token && chatId) {
      if (successCount === 0) {
        sendToTelegram(`❌ Auto-read 全部登入失敗 (0/${totalAccounts})\n請檢查 COOKIES、PASSWORDS、linux.do 狀態`);
      } else if (successCount < totalAccounts) {
        sendToTelegram(`⚠️ Auto-read 部分登入成功 (${successCount}/${totalAccounts})`);
      } else {
        sendToTelegram(`✅ Auto-read 全部登入成功 (${successCount}/${totalAccounts})`);
      }
    }
    // FAIL_ON_NO_LOGIN 真的 exit 1（避免偽綠燈）
    if (successCount === 0) {
      console.error("FATAL: 全部帳號登入失敗");
      if (token && chatId) {
        sendToTelegram(`❌ Auto-read 全部帳號登入失敗，請檢查 COOKIES / PASSWORDS / linux.do 限流 / CF challenge`);
      }
      fatalError = new Error("All accounts login failed");
    }
    // 等待所有登录操作完成
    // await Promise.all(loginTasks);
  } catch (error) {
    // 错误处理逻辑
    console.error("发生错误：", error);
    if (token && chatId) {
      sendToTelegram(`💥 Auto-read 拋錯：${error.message}`);
    }
    fatalError = error;
  } finally {
    // 統一退出碼：fatal → 1，否則 → 0
    // 同步等待 cookie queue 完成（避免最後一筆 cookie 沒寫入 .env）
    try {
      await _cookieWriteQueue;
    } catch {}
    // 清掉所有殘留 chrome.exe（之前會留下 40 個子進程）
    try {
      const { execSync } = await import("child_process");
      execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' });
      console.log("🧹 已清理殘留 chrome 進程");
    } catch (e) {
      // ignore
    }
    if (fatalError) {
      console.error(`退出碼 1（${fatalError.message}）`);
      process.exit(1);
    } else {
      process.exit(0);
    }
  }
})();
// 根据用户名更新 .env 中对应的 cookie
// 登录成功后保存 _t cookie（串行化写入防止并发覆盖）
let _cookieWriteQueue = Promise.resolve();
function updateCookieInEnv(username, cookieList) {
  _cookieWriteQueue = _cookieWriteQueue.then(() => _doCookieUpdate(username, cookieList));
  return _cookieWriteQueue;
}
function _doCookieUpdate(username, cookieList) {
  try {
    const envPath = path.join(dirname(fileURLToPath(import.meta.url)), ".env");
    if (!fs.existsSync(envPath)) return;
    let envContent = fs.readFileSync(envPath, "utf8");
    const usernames = process.env.USERNAMES.split(",");
    const userIndex = usernames.indexOf(username);
    if (userIndex < 0) return;
    const cookiesMatch = envContent.match(/^COOKIES=(.*)$/m);
    if (!cookiesMatch) return;
    const cookiesStr = cookiesMatch[1].replace(/^["']|["']$/g, "");
    const cookies = cookiesStr.split(",");
    cookies[userIndex] = cookieList.join(";");
    const newCookiesStr = `COOKIES=${cookies.join(",")}`;
    envContent = envContent.replace(/^COOKIES=.*$/m, newCookiesStr);
    fs.writeFileSync(envPath, envContent, "utf8");
    console.log(`.env cookie updated for ${username} (${cookieList.length} cookies)`);
  } catch (e) {
    console.warn("updateCookieInEnv failed:", e.message);
  }
}
// 将浏览器Cookie字符串（如 "name=value; name2=value2"）解析为 puppeteer setCookie 所需的对象数组
function parseCookieString(cookieStr, domain) {
  return cookieStr
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.includes("="))
    .map((part) => {
      // 只在第一個 '=' 切割（cookie value 可能含 '='）
      const eqIndex = part.indexOf("=");
      const name = part.substring(0, eqIndex).trim();
      const value = part.substring(eqIndex + 1).trim();
      return { name, value, domain, path: "/" };
    })
    // 過濾掉 name 為空或 value 為空（避免 setCookie 報錯）
    .filter((c) => c.name && c.value);
}

async function launchBrowserForUser(username, password, cookie = null) {
  let browser = null; // 在 try 之外声明 browser 变量
  try {
    console.log("当前用户:", maskUsername(username));
    // HEADLESS 設定：
    //   - 預設 "auto" (puppeteer-real-browser 自動判斷；Windows GUI 上會開視窗)
    //   - 設為 "false" 強制 headless（雲端 / 無桌面環境）
    //   - 設為 "new" 強制新 headless 模式但保留視窗（Linux Xvfb）
    // 為了讓 user 手動解 CF / 手動登入，建議 "auto" 或 "new"
    const headlessMode = process.env.HEADLESS_MODE || "auto";
    const browserOptions = {
      headless: headlessMode,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--password-store=basic", "--disable-features=PasswordLeakDetection,AutofillServerCommunication,PasswordManager,WebAuthentication", "--disable-save-password-bubble", "--disable-autofill-keyboard-accessory-view", "--start-maximized", "--window-size=1280,800"],
      customConfig: {
        chromePath: "C:\\Users\\willy\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe",
      },
      connectOption: {
        // Increase from 120s → 180s: chromium's internal Network.enable call sometimes
        // takes >120s on cloud IPs / under heavy CF challenge, causing unhandledRejection
        // that the outer try/catch can't catch (Promise not awaited).
        protocolTimeout: parseInt(process.env.PROTOCOL_TIMEOUT_MS || "180000", 10),
      },
    };

    // 添加代理配置到浏览器选项
    const proxyConfig = getProxyConfig();
    if (proxyConfig) {
      const proxyArgs = getPuppeteerProxyArgs(proxyConfig);
      browserOptions.args.push(...proxyArgs);
      console.log(
        `为用户 ${maskUsername(username)} 启用代理: ${proxyConfig.type}://${proxyConfig.host}:${proxyConfig.port}`
      );

      // 如果有用户名密码，puppeteer-real-browser会自动处理
      if (proxyConfig.username && proxyConfig.password) {
        browserOptions.proxy = {
          host: proxyConfig.host,
          port: proxyConfig.port,
          username: proxyConfig.username,
          password: proxyConfig.password,
        };
      }
    }

    var { connect } = await import("puppeteer-real-browser");
    const connectResult = await connect({
      ...browserOptions,
      prefs: {
        "credentials_enable_service": false,
        "profile.password_manager_enabled": false,
      },
    });
    const page = connectResult && connectResult.page;
    const newBrowser = connectResult && connectResult.browser;
    if (!page || !newBrowser) {
      throw new Error(
        `puppeteer-real-browser connect() 沒有回傳 page/browser（連線失敗，可能是 Chrome 未啟動）`,
      );
    }
    browser = newBrowser; // 将 browser 初始化
    // 拦截并封锁 passkey/WebAuthn 请求，防止 Windows Hello 弹窗
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('/session/passkey') || url.includes('webauthn') || url.includes('/challenge.json')) {
        console.log(`[BLOCKED] ${url.substring(0, 80)}`);
        request.abort();
      } else {
        request.continue();
      }
    });
    // 禁用 Chromium 密码管理器（防止 "保存密码" 和 "Windows Hello" 弹窗）
    const cdpSession = await page.createCDPSession();
    await cdpSession.send('Page.setWebLifecycleStatus', { status: 'active' }).catch(() => {});
    await cdpSession.send('Network.setExtraHTTPHeaders', { headers: {} }).catch(() => {});
    // 通过 CDP 设置 Chromium 偏好，禁用密码保存提示
    try {
      await cdpSession.send('Page.navigate', { url: 'about:blank' });
      await page.evaluate(() => {
        // 覆盖 PasswordCredential API
        if (window.PasswordCredential) {
          window.PasswordCredential = undefined;
        }
        // 禁用 WebAuthn（多层防护）
        if (window.PublicKeyCredential) {
          window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
          window.PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
        }
        // 拦截 navigator.credentials API
        if (navigator.credentials) {
          const blockedFn = function() {
            return Promise.reject(new DOMException('WebAuthn blocked', 'NotAllowedError'));
          };
          navigator.credentials.get = blockedFn;
          navigator.credentials.create = blockedFn;
        }
      });
    } catch {}
    // 覆盖 WebAuthn API 使其不可用（多层防护）
    await page.evaluateOnNewDocument(() => {
      // 层1: 禁用 PublicKeyCredential 特性检测
      if (window.PublicKeyCredential) {
        window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
        window.PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
      }
      // 层2: 拦截 navigator.credentials.get/create（防止 Windows Hello 弹窗）
      if (navigator.credentials) {
        const blockedFn = function() {
          return Promise.reject(new DOMException('WebAuthn blocked by automation', 'NotAllowedError'));
        };
        try {
          Object.defineProperty(navigator.credentials, 'get', { value: blockedFn, writable: false, configurable: true });
          Object.defineProperty(navigator.credentials, 'create', { value: blockedFn, writable: false, configurable: true });
        } catch (e) {
          // fallback if defineProperty fails
          navigator.credentials.get = blockedFn;
          navigator.credentials.create = blockedFn;
        }
      }
      // 层3: 标记无 passkeys
      localStorage.setItem('hasPasskeys', 'false');
    });
    // 启动截图功能
    // takeScreenshots(page);
    //登录操作
    await navigatePage(loginUrl, page, browser);
    await delayClick(8000);
    // 设置额外的 headers
    await page.setExtraHTTPHeaders({
      "accept-language": "en-US,en;q=0.9",
    });
    // 验证 `navigator.webdriver` 属性是否为 undefined
    // const isWebDriverUndefined = await page.evaluate(() => {
    //   return `${navigator.webdriver}`;
    // });

    // console.log("navigator.webdriver is :", isWebDriverUndefined); // 输出应为 false
    if (page) {
      page.on("pageerror", (error) => {
        console.error(`Page error: ${error.message}`);
      });
      page.on("error", async (error) => {
        // console.error(`Error: ${error.message}`);
        // 检查是否是 localStorage 的访问权限错误
        if (
          error.message.includes(
            "Failed to read the 'localStorage' property from 'Window'"
          )
        ) {
          console.log("Trying to refresh the page to resolve the issue...");
          await page.reload(); // 刷新页面
          // 重新尝试你的操作...
        }
      });
      page.on("console", async (msg) => {
      // console.log("PAGE LOG:", msg.text());
      // 使用一个标志变量来检测是否已经刷新过页面
      if (
        !page._isReloaded &&
        msg.text().includes("the server responded with a status of 429")
      ) {
        // 设置标志变量为 true，表示即将刷新页面
        page._isReloaded = true;
        //由于油候脚本它这个时候可能会导航到新的网页,会导致直接执行代码报错,所以使用这个来在每个新网页加载之前来执行
        try {
          await page.evaluateOnNewDocument(() => {
            localStorage.setItem("autoLikeEnabled", "false");
          });
        } catch (e) {
          // Fallback to immediate evaluate when target already navigated/closed
          try {
            if (!page.isClosed || !page.isClosed()) {
              await page.evaluate(() => {
                localStorage.setItem("autoLikeEnabled", "false");
              });
            }
          } catch (e2) {
            console.warn(
              `Skip disabling autoLike due to closed target: ${
                (e2 && e2.message) ? e2.message : e2
              }`
            );
          }
        }
        // 等待一段时间，比如 3 秒
        await new Promise((resolve) => setTimeout(resolve, 3000));
        console.log("Retrying now...");
        // 尝试刷新页面
        // await page.reload();
      }
    });
    }
    // 登录操作：优先使用Cookie，否则使用表单登录
    let cookieLoginAttempted = false;
    let cookieLoginFailed = false;
    let savedCookieValue = null;
    const domain = new URL(loginUrl).hostname;
    const cookieObjects = cookie ? parseCookieString(cookie, domain) : [];
    const hasT = cookieObjects.some(c => c.name === '_t');
    // 當 cookie 過期或登入失敗，記錄實際原因（給 DEBUG 用）
    let cookieExpiredReason = null;
    // 只要有 _t 就尝试 cookie 登入（_forum_session 跨实例不可用，不依赖它）
    if (cookie && hasT) {
      console.log("检测到 _t cookie，尝试Cookie登录");
      cookieLoginAttempted = true;
      // 保存 _t cookie 值用于 CF 后重新设置
      const tObj = cookieObjects.find(c => c.name === '_t');
      if (tObj) savedCookieValue = tObj.value;
      // 导航到域名，先通过 CF challenge
      // Default 60s (not 120s) — when linux.do is slow we want to fail fast and
      // fall through to password login retry, not wait 2min per attempt × 3 attempts.
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: parseInt(process.env.NAV_TIMEOUT_MS || process.env.NAV_TIMEOUT || "60000", 10) }).catch(() => {});
      await waitForCf(page, browser);

      // CF 通过后，用 CDP 设置 _t cookie，带重试（CF 可能清除 cookie）
      const client = await page.createCDPSession();
      for (let attempt = 0; attempt < 3; attempt++) {
        // 设置 _t cookie
        await client.send('Network.setCookie', {
          name: '_t',
          value: savedCookieValue,
          domain: '.' + domain,
          path: '/',
          secure: true,
          httpOnly: true,
        });
        console.log(`已设置 _t cookie (CDP, attempt ${attempt + 1})`);

        // 验证 cookie 设置成功
        const { cookies: verifyCookies } = await client.send('Network.getAllCookies');
        const tCookieVerify = verifyCookies.find(c => c.name === '_t' && c.domain.includes(domain));
        console.log(`CDP cookie 验证: _t=${tCookieVerify ? '存在' : '缺失！'}`);

        // 带 cookie 刷新页面让 Discourse 读取 session
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitForCf(page, browser);

        // CF 后检查 _t 是否还在
        const { cookies: postCfCookies } = await client.send('Network.getAllCookies');
        const tAfterCf = postCfCookies.find(c => c.name === '_t' && c.domain.includes(domain));
        if (tAfterCf) {
          console.log(`_t cookie 在 CF 后仍然存在 (attempt ${attempt + 1})`);
          break;
        }
        console.log(`CF challenge 清除了 _t cookie，重试 ${attempt + 1}/3...`);
        await delayClick(2000);
      }
      await delayClick(2000);
    } else if (cookie) {
      // cookie 存在但沒有 _t → 視為失敗，不要走 login() 浪費時間（沒有密碼）
      cookieExpiredReason = "cookie 缺少 _t，視為無效";
      console.log(`⚠️ ${cookieExpiredReason}，跳過 login()（password 為空）`);
    } else {
      // Cookie 完全沒有，直接走 login()
      console.log("Cookie 不完整或没有，尝试密码登录...");
      await login(page, username, password);
    }
    // 查找具有类名 "avatar" 的 img 元素验证登录是否成功
    // 页面是 Ember SPA，DOM 标记可能比 session cookie 晚出现；优先询问 Discourse session API。
    const getSessionUser = async () => page.evaluate(async () => {
      try {
        const response = await fetch('/session/current.json', {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return null;
        const data = await response.json();
        return data?.current_user || null;
      } catch {
        return null;
      }
    }).catch(() => null);
    const waitForLoggedInUser = async (timeoutMs = 15000) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const currentUser = await getSessionUser();
        if (currentUser) return currentUser;
        await delayClick(1000);
      }
      return null;
    };

    let currentUser = await waitForLoggedInUser(5000);
    let avatarImg = await page.$("img.avatar").catch(() => null);
    let authButtons = await page.$("span.auth-buttons").catch(() => null);
    console.log(`登录状态检查: session=${currentUser ? maskUsername(currentUser.username) : '无'}, avatar=${avatarImg ? '有' : '无'}, auth-buttons=${authButtons ? '有' : '无'}`);

    // Cookie 登录失败且有密码时，先清除过期 _t cookie，再退回密码登录
    // 关键：以 session API (currentUser) 为准，DOM avatar 可能因 Ember 未渲染而误判
    if (!currentUser && cookieLoginAttempted && !password) {
      // 只有 cookie、沒有密碼 → 不要再走「手动登入 10 分钟」流程（會卡住整個 workflow 25 分鐘）
      cookieExpiredReason = cookieExpiredReason || "session API 無 current_user 且 password 為空";
      console.error(`❌ ${maskUsername(username)} cookie 過期且無 password fallback：${cookieExpiredReason}`);
      if (token && chatId) {
        sendToTelegram(`❌ ${maskUsername(username)} cookie 過期且無 password fallback，請更新 COOKIES secret\n原因：${cookieExpiredReason}`);
      }
      throw new Error(`cookie 過期且無 password：${cookieExpiredReason}`);
    }
    if (!currentUser && cookieLoginAttempted && password) {
      console.log("Cookie 已过期（session API 无 current_user），清除过期 _t cookie...");
      cookieLoginFailed = true;
      // 关键：删除过期的 _t cookie，否则 "You were logged out" 弹窗会无限循环
      try {
        const clearClient = await page.createCDPSession();
        await clearClient.send('Network.deleteCookies', { name: '_t', domain: '.' + domain });
        await clearClient.send('Network.deleteCookies', { name: '_t', domain: domain });
        console.log("已清除过期 _t cookie");
      } catch {}
      // 导航到干净的页面（没有过期 cookie，不会弹窗）
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await waitForCf(page, browser);
      await delayClick(2000);
      // 密码登入重试 3 次（每次等待 CF + 表单提交 + 验证 session）
      const passwordAttempts = parseInt(process.env.PASSWORD_RETRY || "3", 10);
      for (let pAttempt = 1; pAttempt <= passwordAttempts; pAttempt++) {
        console.log(`🔐 密碼登入嘗試 ${pAttempt}/${passwordAttempts}`);
        try {
          await login(page, username, password);
          currentUser = await waitForLoggedInUser(15000);
          avatarImg = await page.$("img.avatar").catch(() => null);
          authButtons = await page.$("span.auth-buttons").catch(() => null);
          console.log(`密码登录后状态 (attempt ${pAttempt}): session=${currentUser ? maskUsername(currentUser.username) : '无'}, avatar=${avatarImg ? '有' : '无'}, auth-buttons=${authButtons ? '有' : '无'}`);
          if (currentUser) {
            console.log(`✅ 密碼登入成功（attempt ${pAttempt}）`);
            break;
          }
          // 失敗：嘗試清除 cookie + 重新導航再試
          if (pAttempt < passwordAttempts) {
            console.log(`❌ 密碼登入失敗，重新嘗試...`);
            try {
              const c = await page.createCDPSession();
              await c.send('Network.deleteCookies', { name: '_t', domain: '.' + domain });
              await c.send('Network.deleteCookies', { name: '_t', domain: domain });
            } catch {}
            await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
            await waitForCf(page, browser);
            await delayClick(3000);
          }
        } catch (loginErr) {
          console.warn(`⚠️ 密碼登入 attempt ${pAttempt} 拋出錯誤：${loginErr.message}`);
        }
      }
    }

    // 如果登录还是失败，等待用户手动登入
    if (!currentUser && password) {
      // 改成：sendToTelegram 一定要送（即使 manual TG 失敗也要 log）
      const manualMsg = `⚠️ ${maskUsername(username)} 自動登入失敗！請到瀏覽器手動登入，腳本會等待 10 分鐘。\n` +
        `可能原因：CF challenge、linux.do 改登入流程、密碼過期\n` +
        `請檢查後手動登入，或更新 COOKIES 後重跑`;
      console.log(manualMsg);
      sendToTelegram(manualMsg);
      sendToTelegramGroup(manualMsg);
      // 清除过期 cookie 防止弹窗循环
      try {
        const clearClient = await page.createCDPSession();
        await clearClient.send('Network.deleteCookies', { name: '_t', domain: '.' + domain });
        await clearClient.send('Network.deleteCookies', { name: '_t', domain: domain });
      } catch {}
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await waitForCf(page, browser);
      await delayClick(2000);
      // 等待用户手动登入（10 分钟）—— 但有最壞情況：context 被 CF 銷毀，這時要 catch 不要讓整個 launchBrowserForUser 崩潰
      const waitStart = Date.now();
      while (Date.now() - waitStart < 600000) {
        try {
          await delayClick(5000);
          // 关闭弹窗
          await page.evaluate(() => {
            document.querySelectorAll('.dialog-footer .btn-primary').forEach(b => b.click());
          }).catch(() => {});
          avatarImg = await page.$("img.avatar").catch(() => null);
          authButtons = await page.$("span.auth-buttons").catch(() => null);
          currentUser = await getSessionUser().catch(() => null);
          if (currentUser && !authButtons) {
            avatarImg = avatarImg || true;
            console.log(`检测到手动登入成功: ${maskUsername(currentUser.username)}`);
            sendToTelegram(`✅ ${maskUsername(username)} 手动登入成功`);
            // 手動登入成功 → 立即寫 cookie（避免 superwill 那種「成功但 env 沒更新」）
            try {
              const saveClient = await page.createCDPSession().catch(() => null);
              if (saveClient) {
                const { cookies: loginCookies } = await saveClient.send('Network.getAllCookies');
                const tAfterLogin = loginCookies.find(c => c.name === '_t' && c.domain.includes(domain));
                if (tAfterLogin) {
                  updateCookieInEnv(username, [`_t=${tAfterLogin.value}`]);
                  console.log(`✅ 手動登入後立即保存 cookie: ${maskUsername(username)} (_t)`);
                } else {
                  console.log(`⚠️ 手動登入成功但未找到 _t cookie`);
                }
              }
            } catch (saveErr) {
              console.warn(`手動登入後保存 cookie 失敗: ${saveErr.message}`);
            }
            break;
          }
          if (avatarImg && !authButtons) {
            console.log("检测到手动登入成功！");
            sendToTelegram(`✅ ${maskUsername(username)} 手动登入成功`);
            // 同樣：手動登入成功時存 cookie
            try {
              const saveClient = await page.createCDPSession().catch(() => null);
              if (saveClient) {
                const { cookies: loginCookies } = await saveClient.send('Network.getAllCookies');
                const tAfterLogin = loginCookies.find(c => c.name === '_t' && c.domain.includes(domain));
                if (tAfterLogin) {
                  updateCookieInEnv(username, [`_t=${tAfterLogin.value}`]);
                  console.log(`✅ 手動登入後立即保存 cookie: ${maskUsername(username)} (_t)`);
                }
              }
            } catch (saveErr) {
              console.warn(`手動登入後保存 cookie 失敗: ${saveErr.message}`);
            }
            break;
          }
        } catch (waitErr) {
          // 捕獲「context destroyed」等錯誤，不要退出 loop，繼續等
          console.warn(`手動登入等待中發生錯誤（忽略繼續）: ${waitErr.message}`);
        }
      }
    }

    if (!currentUser && authButtons) {
      console.log("找到 auth-buttons，用户未登录，登录失败");
      throw new Error("登录失败：页面显示未登录状态（auth-buttons）");
    } else if (currentUser || avatarImg) {
      console.log(`登录成功${currentUser ? `: ${maskUsername(currentUser.username)}` : "（avatar）"}`);
      // 立即保存 _t cookie（不等到最后，防止后续代码出错导致 cookie 丢失）
      try {
        const saveClient = await page.createCDPSession().catch(() => null);
        if (saveClient) {
          const { cookies: loginCookies } = await saveClient.send('Network.getAllCookies');
          const tAfterLogin = loginCookies.find(c => c.name === '_t' && c.domain.includes(domain));
          if (tAfterLogin) {
            updateCookieInEnv(username, [`_t=${tAfterLogin.value}`]);
            console.log(`✅ Cookie 已立即保存: ${maskUsername(username)} (_t)`);
          } else {
            console.log(`⚠️ 登录成功但未找到 _t cookie`);
          }
        }
      } catch (e) {
        console.warn("立即保存 cookie 失败:", e.message);
      }
    } else {
      console.log("未找到avatarImg，登录失败");
      throw new Error("登录失败");
    }

    // 注册活动会话，退出时保存最新轮换后的 _t cookie
    activeSessions.set(username, { page, domain });

    //真正执行阅读脚本

    // 循环关闭 "You were logged out" 弹窗（可能反复出现）
    for (let i = 0; i < 3; i++) {
      const hasDialog = await page.$('.dialog-body').catch(() => null);
      if (!hasDialog) break;
      console.log(`检测到弹窗，清除 cookie 并导航到首页...`);
      // 清除过期 cookie 打破循环
      try {
        const c = await page.createCDPSession();
        await c.send('Network.deleteCookies', { name: '_t', domain: '.' + domain });
        await c.send('Network.deleteCookies', { name: '_t', domain: domain });
      } catch {}
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await waitForCf(page, browser);
      await delayClick(3000);
    }
    await delayClick(2000);

    let externalScriptPath;
    if (isLikeSpecificUser === "true") {
      const randomChoice = Math.random() < 0.5; // 生成一个随机数，50% 概率为 true
      if (randomChoice) {
        externalScriptPath = path.join(
          dirname(fileURLToPath(import.meta.url)),
          "index_likeUser_activity.js"
        );
        console.log("使用index_likeUser_activity");
      } else {
        externalScriptPath = path.join(
          dirname(fileURLToPath(import.meta.url)),
          "index_likeUser.js"
        );
        console.log("使用index_likeUser");
      }
    } else {
      externalScriptPath = path.join(
        dirname(fileURLToPath(import.meta.url)),
        "index.js"
      );
    }
    const externalScript = fs.readFileSync(externalScriptPath, "utf8");

    // 在每个新的文档加载时执行外部脚本
    await page.evaluateOnNewDocument(
      (...args) => {
        const [specificUser, scriptToEval, isAutoLike] = args;
        localStorage.setItem("read", true);
        localStorage.setItem("specificUser", specificUser);
        // 不要设 isFirstRun=false，让脚本自己判断是否需要获取话题列表
        localStorage.setItem("autoLikeEnabled", isAutoLike);
        console.log("当前点赞用户：", specificUser);
        eval(scriptToEval);
      },
      specificUser,
      externalScript,
      isAutoLike
    ); //变量必须从外部显示的传入, 因为在浏览器上下文它是读取不了的
    // 添加一个监听器来监听每次页面加载完成的事件
    page.on("load", async () => {
      // await page.evaluate(externalScript); //因为这个是在页面加载好之后执行的,而脚本是在页面加载好时刻来判断是否要执行，由于已经加载好了，脚本就不会起作用
    });
    // 如果是Linuxdo，延迟导航到 /latest（在登入验证和弹窗处理之后）
    // evaluateOnNewDocument 已注册，导航时会自动执行脚本
    if (token && chatId) {
      sendToTelegram(`${username} 登录成功`);
    } // 监听页面跳转到新话题，自动推送RSS example：https://linux.do/t/topic/525305.rss
    // 记录已推送过的 topicId，防止重复推送
    if (enableRssFetch || enableTopicDataFetch) {
      const pushedTopicIds = new Set();
      const processedTopicIds = new Set(); // 用于话题数据处理的记录
      page.on("framenavigated", async (frame) => {
        if (frame.parentFrame() !== null) return;
        const url = frame.url();
        const match = url.match(/https:\/\/linux\.do\/t\/topic\/(\d+)/);
        if (match) {
          const topicId = match[1];

          // RSS抓取处理
          if (enableRssFetch && !pushedTopicIds.has(topicId)) {
            pushedTopicIds.add(topicId);
            const rssUrl = `https://linux.do/t/topic/${topicId}.rss`;
            console.log("检测到话题跳转，抓取RSS：", rssUrl);
            try {
              // 停顿1.5秒再抓取
              await new Promise((r) => setTimeout(r, 1500));
              const rssPage = await browser.newPage();
              await rssPage.goto(rssUrl, {
                waitUntil: "domcontentloaded",
                timeout: 20000,
              });
              // 停顿0.5秒再获取内容，确保页面渲染完成
              await new Promise((r) => setTimeout(r, 1000));
              const xml = await rssPage.evaluate(() => document.body.innerText);
              await rssPage.close();
              const parsedData = await parseRss(xml);
              sendToTelegramGroup(parsedData);
            } catch (e) {
              console.error("抓取或发送RSS失败：", e, "可能是非公开话题");
            }
          }

          // 话题数据抓取处理
          if (enableTopicDataFetch && !processedTopicIds.has(topicId)) {
            processedTopicIds.add(topicId);
            console.log("检测到话题跳转，抓取话题数据：", url);
            try {
              // 停顿1秒再处理话题数据
              await new Promise((r) => setTimeout(r, 1000));
              await processAndSaveTopicData(page, url);
            } catch (e) {
              console.error("抓取或保存话题数据失败：", e);
            }
          }
        }
        // 停顿0.5秒后允许下次抓取
        await new Promise((r) => setTimeout(r, 500));
      });
    }

    // 验证阅读脚本是否真正在运行（不 reload，避免破坏 session）
    await delayClick(10000); // 等 10 秒让脚本初始化
    try {
      let topicCount = await page.evaluate(() => {
        return JSON.parse(localStorage.getItem("topicList") || "[]").length;
      }).catch(() => 0);
      console.log(`阅读状态: 待阅读=${topicCount}篇`);

      if (topicCount === 0) {
        // 话题列表为空，重置 isFirstRun 让脚本重新获取（不 reload）
        console.warn("话题列表为空，重置 isFirstRun...");
        await page.evaluate(() => {
          localStorage.removeItem("isFirstRun");
          localStorage.removeItem("topicList");
          localStorage.setItem("read", true);
        }).catch(() => {});
        // 等待脚本自动获取话题（同步 AJAX 应该很快）
        await delayClick(10000);
        topicCount = await page.evaluate(() => {
          return JSON.parse(localStorage.getItem("topicList") || "[]").length;
        }).catch(() => 0);
        console.log(`重置后话题数: ${topicCount}篇`);

        if (topicCount === 0) {
          // 还是 0，手动触发话题获取
          console.warn("仍然为空，手动触发话题获取...");
          await page.evaluate(async () => {
            try {
              const resp = await fetch('/latest.json?no_definitions=true&page=0');
              const data = await resp.json();
              if (data && data.topic_list && data.topic_list.topics) {
                const topics = data.topic_list.topics.filter(t => !t.pinned);
                localStorage.setItem("topicList", JSON.stringify(topics));
                localStorage.setItem("isFirstRun", "false");
              }
            } catch (e) { console.error("手动获取话题失败:", e); }
          }).catch(() => {});
          await delayClick(3000);
          topicCount = await page.evaluate(() => {
            return JSON.parse(localStorage.getItem("topicList") || "[]").length;
          }).catch(() => 0);
          console.log(`手动获取后话题数: ${topicCount}篇`);
        }
      }
    } catch (e) {
      console.warn("阅读状态检查失败:", e.message ? e.message.substring(0, 80) : e);
    }

    // 登录成功后自动更新 _t cookie（唯一能跨浏览器实例复用的 cookie）
    try {
      const cdpClient = await page.createCDPSession().catch(() => null);
      let browserCookies = [];
      if (cdpClient) {
        const { cookies } = await cdpClient.send('Network.getAllCookies');
        browserCookies = cookies.filter(c => c.domain.includes('linux.do'));
      } else {
        browserCookies = await page.cookies(loginUrl);
      }
      const tCookie = browserCookies.find(c => c.name === '_t');
      if (tCookie) {
        updateCookieInEnv(username, [`_t=${tCookie.value}`]);
        console.log(`Cookie 已自动更新: ${username} (_t)`);
      } else {
        console.log(`警告: 登录成功但未找到 _t cookie`);
      }
    } catch (e) {
      console.warn("Cookie 自动更新失败:", e.message);
    }

    // 所有验证完成后，导航到 /latest 开始阅读
    console.log("导航到 /latest 开始阅读...");
    await page.goto(loginUrl + "/latest", {
      waitUntil: "domcontentloaded",
      timeout: parseInt(process.env.NAV_TIMEOUT_MS || process.env.NAV_TIMEOUT || "60000", 10),
    }).catch(() => {});
    await waitForCf(page, browser);
    await delayClick(10000); // 等 10 秒让 evaluateOnNewDocument 脚本获取话题

    // 验证话题列表
    let topicCount = await page.evaluate(() => {
      return JSON.parse(localStorage.getItem("topicList") || "[]").length;
    }).catch(() => 0);
    console.log(`话题列表: ${topicCount}篇`);

    if (topicCount === 0) {
      console.warn("话题为空，手动获取...");
      await page.evaluate(async () => {
        try {
          const resp = await fetch('/latest.json?no_definitions=true&page=0');
          const data = await resp.json();
          if (data && data.topic_list && data.topic_list.topics) {
            const topics = data.topic_list.topics.filter(t => !t.pinned);
            localStorage.setItem("topicList", JSON.stringify(topics));
            localStorage.setItem("isFirstRun", "false");
            localStorage.setItem("read", true);
          }
        } catch (e) {}
      }).catch(() => {});
      await delayClick(3000);
      topicCount = await page.evaluate(() => {
        return JSON.parse(localStorage.getItem("topicList") || "[]").length;
      }).catch(() => 0);
      console.log(`手动获取后: ${topicCount}篇`);
    }

    return { browser, loggedIn: activeSessions.has(username), error: null };
  } catch (err) {
    // throw new Error(err);
    console.log("Error in launchBrowserForUser:", err);
    if (token && chatId) {
      sendToTelegram(`${err && err.message ? err.message : String(err)}`);
    }
    // 即使出錯也要 try close 瀏覽器，避免殘留 process
    if (browser) {
      try { await browser.close(); } catch {}
    }
    return { browser: null, loggedIn: false, error: err && err.message ? err.message : String(err) };
  }
}
async function login(page, username, password, retryCount = 3) {
  await waitForCf(page, null);
  await delayClick(1000);

  // 关闭弹窗
  await page.evaluate(() => {
    document.querySelectorAll('.dialog-footer .btn-primary').forEach(b => b.click());
  }).catch(() => {});
  await delayClick(2000);

  // 先导航到 /login 页面（确保 hidden-login-form 存在）
  const currentUrl = page.url();
  if (!currentUrl.includes('/login')) {
    console.log("导航到 /login 页面...");
    // 禁用 passkey 防止 Windows Hello 弹窗
    await page.evaluate(() => {
      if (window.PublicKeyCredential) {
        window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
        window.PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
      }
      if (navigator.credentials) {
        const blockedFn = function() {
          return Promise.reject(new DOMException('WebAuthn blocked', 'NotAllowedError'));
        };
        navigator.credentials.get = blockedFn;
        navigator.credentials.create = blockedFn;
      }
    }).catch(() => {});
    await page.goto(loginUrl + "/login", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await waitForCf(page, null);
    await delayClick(2000);
  }

  // 使用隐藏的 #hidden-login-form（标准 HTML 表单，不依赖 Ember）
  console.log("使用 hidden-login-form 登入...");
  // 再次禁用 WebAuthn（防止页面 JS 在表单提交前触发 passkey）
  await page.evaluate(() => {
    if (navigator.credentials) {
      const blockedFn = function() {
        return Promise.reject(new DOMException('WebAuthn blocked', 'NotAllowedError'));
      };
      navigator.credentials.get = blockedFn;
      navigator.credentials.create = blockedFn;
    }
  }).catch(() => {});
  const loginResult = await page.evaluate((user, pass) => {
    const form = document.querySelector('#hidden-login-form');
    if (!form) return { error: 'hidden-login-form not found' };
    const usernameInput = form.querySelector('#signin_username');
    const passwordInput = form.querySelector('#signin_password');
    if (usernameInput) usernameInput.value = user;
    if (passwordInput) passwordInput.value = pass;
    form.submit();
    return { submitted: true, action: form.action };
  }, username, password);
  console.log("登入结果:", JSON.stringify(loginResult));

  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch {}
  await delayClick(2000);
}

async function navigatePage(url, page, browser) {
  try {
    page.setDefaultNavigationTimeout(
      parseInt(process.env.NAV_TIMEOUT_MS || process.env.NAV_TIMEOUT || "60000", 10)
    );
  } catch {}
  await page.goto(url, { waitUntil: "domcontentloaded" }); //如果使用默认的load,linux下页面会一直加载导致无法继续执行

  const startTime = Date.now(); // 记录开始时间
  let pageTitle = await safeTitle(page); // 获取当前页面标题
  let cfNotified = false;

  while (pageTitle.includes("Just a moment") || pageTitle.includes("请稍候")) {
    console.log("The page is under Cloudflare protection. Waiting...");

    // CF 保护超过 5 秒 → 可能需要人工验证，发送 Telegram 通知（含截圖）
    if (!cfNotified && Date.now() - startTime > 5000) {
      console.log("CF 保護超過 5 秒，送 Telegram 截圖通知...");
      await notifyCfChallenge(page, `navigate-${Date.now()}`, '首次進入 linux.do');
      cfNotified = true;
    }

    await delayClick(2000); // 每次检查间隔2秒

    // 重新获取页面标题（可能因 CF redirect 导致 context 销毁）
    pageTitle = await safeTitle(page);

    // 有人工验证时等 120 秒，否则 35 秒
    const timeout = cfNotified ? 120000 : 35000;
    if (Date.now() - startTime > timeout) {
      console.log("Timeout exceeded, aborting actions.");
      const timeoutMsg = `超时了,无法通过Cloudflare验证`;
      sendToTelegram(timeoutMsg);
      sendToTelegramGroup(timeoutMsg);
      // 不在這裡關閉瀏覽器，由調用方統一處理
      return; // 超时则退出函数
    }
  }
  console.log("页面标题：", pageTitle);
}

// 安全获取页面标题，防止 execution context destroyed 崩溃
async function safeTitle(page) {
  try {
    return await page.title();
  } catch {
    return ""; // context 销毁时返回空，让 while 条件为 false 退出循环
  }
}

// 等待 Cloudflare challenge 通过（不导航，只等待当前页面的 CF 完成）
async function waitForCf(page, browser) {
  const start = Date.now();
  let title = await safeTitle(page);
  let cfNotified = false;
  while (title.includes("Just a moment") || title.includes("请稍候")) {
    if (!cfNotified && Date.now() - start > 5000) {
      await notifyCfChallenge(page, `waitcf-${Date.now()}`, '等 CF 完成');
      cfNotified = true;
    }
    await delayClick(2000);
    title = await safeTitle(page);
    if (Date.now() - start > (cfNotified ? 300000 : 35000)) {
      console.log("CF wait timeout");
      return;
    }
  }
}

// 每秒截图功能
async function takeScreenshots(page) {
  let screenshotIndex = 0;
  setInterval(async () => {
    screenshotIndex++;
    const screenshotPath = path.join(
      screenshotDir,
      `screenshot-${screenshotIndex}.png`
    );
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`Screenshot saved: ${screenshotPath}`);
    } catch (error) {
      console.error("Error taking screenshot:", error);
    }
  }, 1000);
  // 注册退出时删除文件夹的回调函数
  process.on("exit", () => {
    try {
      fs.rmdirSync(screenshotDir, { recursive: true });
      console.log(`Deleted folder: ${screenshotDir}`);
    } catch (error) {
      console.error(`Error deleting folder ${screenshotDir}:`, error);
    }
  });
}
import express from "express";

const healthApp = express();
const HEALTH_PORT = process.env.HEALTH_PORT || 7860;

// 健康探针路由
healthApp.get("/health", (req, res) => {
  const memoryUsage = process.memoryUsage();

  // 将字节转换为MB
  const memoryUsageMB = {
    rss: `${(memoryUsage.rss / (1024 * 1024)).toFixed(2)} MB`, // 转换为MB并保留两位小数
    heapTotal: `${(memoryUsage.heapTotal / (1024 * 1024)).toFixed(2)} MB`,
    heapUsed: `${(memoryUsage.heapUsed / (1024 * 1024)).toFixed(2)} MB`,
    external: `${(memoryUsage.external / (1024 * 1024)).toFixed(2)} MB`,
    arrayBuffers: `${(memoryUsage.arrayBuffers / (1024 * 1024)).toFixed(2)} MB`,
  };

  const healthData = {
    status: "OK",
    timestamp: new Date().toISOString(),
    memoryUsage: memoryUsageMB,
    uptime: process.uptime().toFixed(2), // 保留两位小数
  };

  res.status(200).json(healthData);
});
healthApp.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Auto Read</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            background-color: #f4f4f4;
            color: #333;
            margin: 0;
            padding: 20px;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
          }
          .container {
            background-color: #fff;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 0 15px rgba(0, 0, 0, 0.1);
            max-width: 600px;
            text-align: center;
          }
          h1 {
            color: #007bff;
          }
          p {
            font-size: 18px;
            margin: 15px 0;
          }
          a {
            color: #007bff;
            text-decoration: none;
            font-weight: bold;
          }
          a:hover {
            text-decoration: underline;
          }
          footer {
            margin-top: 20px;
            font-size: 14px;
            color: #555;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Welcome to the Auto Read App</h1>
          <p>You can check the server's health at <a href="/health">/health</a>.</p>
          <p>GitHub: <a href="https://github.com/14790897/auto-read-liunxdo" target="_blank">https://github.com/14790897/auto-read-liunxdo</a></p>
          <footer>&copy; 2024 Auto Read App</footer>
        </div>
      </body>
    </html>
  `);
});
healthApp.listen(HEALTH_PORT, () => {
  console.log(
    `Health check endpoint is running at http://localhost:${HEALTH_PORT}/health`
  );
});
