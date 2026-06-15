# Linux.do Auto-Read Local Setup Guide

## What this does
Runs `bypasscf.js` on your local machine to auto-read topics and auto-like posts
on linux.do for 3 accounts, every day, for 25 minutes each session.

Uses your real Chrome browser — passes Cloudflare because it looks like a real human.

---

## Step 1: Install Node.js

Download and install from: https://nodejs.org (LTS version)

Verify it works:
```
node --version
```

---

## Step 2: Download the project

**Option A — Git (recommended):**
```
git clone https://github.com/Willywang8216/auto-read-liunxdo-my.git
cd auto-read-liunxdo-my
```

**Option B — Download ZIP:**
1. Go to: https://github.com/Willywang8216/auto-read-liunxdo-my
2. Click green "Code" button → "Download ZIP"
3. Extract the ZIP
4. Open Command Prompt / Terminal inside the extracted folder

---

## Step 3: Install dependencies

```
npm install
```

Wait for it to finish (may take 1-2 minutes).

---

## Step 4: Create the .env config file

Create a file named `.env` in the project folder. Copy-paste this template:

```
USERNAMES=goodhaohao,supercool,superwill
PASSWORDS=
COOKIES=PASTE_COOKIE_1_HERE,PASTE_COOKIE_2_HERE,PASTE_COOKIE_3_HERE
WEBSITE=https://linux.do
AUTO_LIKE=true
HIDE_ACCOUNT_INFO=true
RUN_TIME_LIMIT_MINUTES=25
MAX_CONCURRENT_ACCOUNTS=3
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

### How to get the _t cookie for each account:

1. Open Chrome/Edge/Firefox
2. Go to https://linux.do and **log in** with account #1 (goodhaohao)
3. Press **F12** to open Developer Tools
4. Click the **Application** tab (Chrome) or **Storage** tab (Firefox)
5. On the left, expand **Cookies** → click `https://linux.do`
6. Find the row named **`_t`**
7. Double-click the **Value** column to select it, then **Ctrl+C** to copy
8. Paste it into the COOKIES line in `.env`
9. **Repeat** for account #2 (supercool) and #3 (superwill)
10. Separate each cookie value with a comma (no spaces)

Example (yours will be much longer):
```
COOKIES=_t=abc123xyz...,_t=def456uvw...,_t=ghi789rst...
```

**⚠️ Cookies expire after ~2 weeks. You'll need to repeat this step periodically.**

---

## Step 5: Test it

```
node bypasscf.js
```

You should see:
- Chrome browser opens automatically
- It navigates to linux.do
- Cloudflare challenge passes
- "找到avatarImg，登录成功" = login success
- Topics start being read and posts liked
- Runs for 25 minutes then closes

**If it says "未找到avatarImg，登录失败"** → Your cookie expired. Get a fresh one.

**If it says "Cloudflare 验证超时"** → Wait a few hours and try again.

---

## Step 6: Auto-run daily

### Windows (Task Scheduler):

1. Press **Win**, type **Task Scheduler**, open it
2. Click **Create Basic Task** on the right
3. Name: `Linuxdo Auto Read`
4. Trigger: **Daily** → pick time (e.g. 18:00)
5. Action: **Start a program**
6. Program/script: `node`
7. Add arguments: `bypasscf.js`
8. Start in: `C:\Users\YOUR_NAME\auto-read-liunxdo-my` (your actual path!)
9. Click Finish
10. Right-click the task → Properties:
    - Check "Run whether user is logged on or not"
    - Check "Run with highest privileges"
    - Conditions tab → uncheck "Start only if on AC power"

### Mac/Linux (cron):

```
crontab -e
```

Add this line (runs at 6 PM daily):
```
0 18 * * * cd /home/YOUR_NAME/auto-read-liunxdo-my && node bypasscf.js >> cron.log 2>&1
```

---

## Step 7: Refresh cookies every 2 weeks

Set a phone/calendar reminder every 12 days. When it goes off:

1. Log into linux.do in your browser for each account
2. Copy fresh `_t` cookie values (same as Step 4)
3. Update the `.env` file
4. Done — next run will use the new cookies

---

## FAQ

**Q: Does this count as "visiting" for trust level?**
A: Yes. Each time the script reads a topic, Discourse counts it as a visit and reading activity.

**Q: Will I get banned?**
A: The script mimics real browsing behavior (random delays, scrolling, clicking). Use at your own risk. Don't set RUN_TIME_LIMIT_MINUTES too high.

**Q: Can I run it on multiple computers?**
A: Yes, but each instance should use different accounts to avoid conflicts.

**Q: The script opens Chrome but nothing happens**
A: Make sure Chrome is your default browser. Try running `npm install` again.

**Q: How do I stop it mid-run?**
A: Close the Chrome window it opened, or press Ctrl+C in the terminal.

---

## File structure

```
auto-read-liunxdo-my/
├── bypasscf.js          ← Main script (the one you run)
├── index.js             ← Auto-read logic injected into browser
├── index_likeUser.js    ← Like-specific-user logic
├── .env                 ← Your config (create this!)
├── package.json         ← Dependencies
└── node_modules/        ← Installed by npm install
```
