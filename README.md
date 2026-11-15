# Sequence with Friends

A multiplayer Sequence-style game you can host for free on Render. Friends open a link, join with a 4-letter room code and play from any phone or browser.

**Files:** `server.js` (game server), `index.html` (the game page), `package.json`, `render.yaml`.

## Deploy to Render (works from your phone)

### 1. Put the files on GitHub
1. Sign in at **github.com** (create a free account if needed). In Chrome on your phone, tap ⋮ → **Desktop site**, which makes the steps below easier.
2. Tap **+** → **New repository**. Name it `sequence`, leave it **Public** (or Private), and tap **Create repository**.
3. Tap **uploading an existing file**, choose all 5 files from the zip (`server.js`, `index.html`, `package.json`, `render.yaml`, `README.md`) and tap **Commit changes**.

### 2. Deploy on Render
1. Go to **render.com** and tap **Get Started**. Sign up **with GitHub**, which links your repos automatically.
2. Tap **New +** → **Web Service** and pick your `sequence` repo.
3. Settings (most are filled in for you):
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** **Free**
4. Tap **Deploy web service**. After 2–3 minutes you'll get a link like `https://sequence-xxxx.onrender.com`.

### 3. Play
- Open your link, enter your name and tap **Create a game**.
- Tap **Share invite link** and send it to your friends. They enter their name and join.
- Pick teams (2 or 3, equal sizes), then the host taps **Start game**.

## Good to know
- **Wake it up first.** The free plan sleeps after 15 minutes with no activity. Open your link about a minute before game night; the first load takes ~1 minute, then it's fast.
- **Dropped connection?** Just reopen the link. You'll rejoin with the same hand.
- Render can occasionally restart free servers, which ends any game in progress. That's rare.
- To change something later, edit the file on GitHub. Render redeploys automatically.

## Rules in brief
- Play a card, then place a chip on one of the two matching spaces.
- 5 in a row (across, down or diagonal) is a **sequence**. ★ corners count for everyone.
- **2 teams** need 2 sequences to win; **3 teams** need 1. Two sequences may share one chip.
- **Two-eyed Jacks (♦ ♣)** are wild. **One-eyed Jacks (♠ ♥)** remove an opponent's chip (not one in a finished sequence).
- **Dead card** (both spaces covered): swap it for a new one, once per turn.

Players and cards dealt: 2 → 7 each, 3–4 → 6, 6 → 5, 8–9 → 4, 10–12 → 3.
