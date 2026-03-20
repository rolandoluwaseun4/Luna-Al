'use strict';
/**
 * whatsapp.js — Luna WhatsApp Content Manager (Baileys)
 *
 * Uses @whiskeysockets/baileys — pure WebSocket, no browser needed.
 * Works on Railway out of the box.
 *
 * Setup:
 * 1. Deploy — Railway installs baileys automatically from package.json
 * 2. Visit /whatsapp/qr (logged in as owner) to get QR code
 * 3. Scan with WhatsApp → Linked Devices → Link a Device
 * 4. Visit /whatsapp/groups to select which groups Luna posts to
 */

const fs   = require('fs');
const path = require('path');

const SESSION_FILE  = '/tmp/wa-auth.json';
const GROUPS_FILE   = '/tmp/wa-groups.json';

// ── State ─────────────────────────────────────────────────────
let sock           = null;
let waReady        = false;
let currentQR      = null;
let selectedGroups = [];
let scheduleTimers = [];
let postSchedule   = { hours: [8, 19] }; // 8am and 7pm

// ── Content ───────────────────────────────────────────────────
const STATUS_POSTS = [
  "Building something that actually thinks. Luna AI — try it free 👉 https://rolandoluwaseun4.github.io/Luna-Al/",
  "Most AI apps feel like talking to a manual. Luna feels like talking to someone. Try her → https://rolandoluwaseun4.github.io/Luna-Al/",
  "I built an AI assistant from scratch on my phone. No laptop. No funding. Just code and stubbornness. Luna → https://rolandoluwaseun4.github.io/Luna-Al/",
  "Luna can chat, generate images, search the web, and remember you. All free. https://rolandoluwaseun4.github.io/Luna-Al/",
  "If you've been using ChatGPT, try Luna. Built by a Nigerian developer, feels more personal. https://rolandoluwaseun4.github.io/Luna-Al/",
  "Free AI. No subscription. No paywall after 2 messages. Just Luna. https://rolandoluwaseun4.github.io/Luna-Al/",
  "Luna doesn't just answer — she thinks. Try asking her something deep. https://rolandoluwaseun4.github.io/Luna-Al/",
  "Built Luna AI in months, from my phone. If you have an idea, you have everything you need.",
  "Your AI assistant should feel like a friend, not a search engine. That's why I built Luna. https://rolandoluwaseun4.github.io/Luna-Al/",
  "Luna update: voice mode is live. Talk to her, she talks back. https://rolandoluwaseun4.github.io/Luna-Al/",
];

const GROUP_POSTS = [
  "Have you tried Luna AI? Free personal AI assistant — chats, generates images, searches the web. Built by Roland 🇳🇬 → https://rolandoluwaseun4.github.io/Luna-Al/",
  "Free AI tool 👇 Luna AI — no signup needed to try. https://rolandoluwaseun4.github.io/Luna-Al/",
  "Luna AI now has voice mode — you can literally talk to it and it talks back with a real human voice. Try it free → https://rolandoluwaseun4.github.io/Luna-Al/",
  "Built a full AI app from my phone. Luna AI is live and free. Check it out → https://rolandoluwaseun4.github.io/Luna-Al/",
];

// ── Init ──────────────────────────────────────────────────────
async function initWhatsApp(app, requireAuth) {
  registerRoutes(app, requireAuth);
  await connectBaileys();
}

async function connectBaileys() {
  let makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers;
  try {
    ({ default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } =
      await import('@whiskeysockets/baileys'));
  } catch(e) {
    console.warn('[WhatsApp] Baileys not installed:', e.message);
    return;
  }

  let QRCode;
  try { QRCode = require('qrcode'); } catch(e) {}

  const { state, saveCreds } = await useMultiFileAuthState('/tmp/wa-session');

  sock = makeWASocket({
    auth:    state,
    browser: Browsers.macOS('Chrome'),
    printQRInTerminal: false,
    logger: (await import('pino')).default({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      waReady   = false;
      console.log('[WhatsApp] QR ready — visit /whatsapp/qr to scan');
    }

    if (connection === 'open') {
      waReady   = true;
      currentQR = null;
      console.log('[WhatsApp] Connected');
      loadGroups();
      schedulePostings();
    }

    if (connection === 'close') {
      waReady = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason?.loggedOut;
      console.log('[WhatsApp] Disconnected, code:', code);
      clearSchedule();
      if (shouldReconnect) {
        console.log('[WhatsApp] Reconnecting...');
        setTimeout(connectBaileys, 5000);
      } else {
        // Logged out — clear session
        try { fs.rmSync('/tmp/wa-session', { recursive: true }); } catch(e) {}
        console.log('[WhatsApp] Logged out — rescan QR');
        setTimeout(connectBaileys, 2000);
      }
    }
  });
}

// ── Groups persistence ────────────────────────────────────────
function loadGroups() {
  try {
    if (fs.existsSync(GROUPS_FILE)) {
      selectedGroups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
      console.log(`[WhatsApp] Loaded ${selectedGroups.length} groups`);
    }
  } catch(e) {}
}

function saveGroups() {
  try { fs.writeFileSync(GROUPS_FILE, JSON.stringify(selectedGroups)); } catch(e) {}
}

// ── Helpers ───────────────────────────────────────────────────
function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function humanDelay(min = 3000, max = 7000) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

// ── Posting ───────────────────────────────────────────────────
async function postToStatus(text) {
  if (!waReady || !sock) return false;
  try {
    await sock.sendMessage('status@broadcast', { text });
    console.log('[WhatsApp] Status posted');
    return true;
  } catch(e) {
    console.error('[WhatsApp] Status error:', e.message);
    return false;
  }
}

async function postToGroup(groupId, text) {
  if (!waReady || !sock) return false;
  try {
    await sock.sendMessage(groupId, { text });
    console.log('[WhatsApp] Posted to group:', groupId);
    return true;
  } catch(e) {
    console.error('[WhatsApp] Group error:', e.message);
    return false;
  }
}

async function runScheduledPost() {
  if (!waReady) return;
  console.log('[WhatsApp] Running scheduled post');

  // Post to status
  await postToStatus(randomItem(STATUS_POSTS));

  // Post to groups one by one with human-like delays
  if (selectedGroups.length > 0) {
    const text = randomItem(GROUP_POSTS);
    for (const groupId of selectedGroups) {
      await humanDelay(4000, 9000); // wait between groups
      await postToGroup(groupId, text);
    }
  }
}

// ── Scheduler ─────────────────────────────────────────────────
function schedulePostings() {
  clearSchedule();

  function scheduleNext() {
    const now  = new Date();
    const next = new Date();
    let found  = false;

    for (const hour of [...postSchedule.hours].sort((a,b) => a-b)) {
      next.setHours(hour, 0, 0, 0);
      if (next > now) { found = true; break; }
    }
    if (!found) {
      next.setDate(next.getDate() + 1);
      next.setHours(postSchedule.hours[0], 0, 0, 0);
    }

    const delay = next - now;
    console.log(`[WhatsApp] Next post in ${Math.round(delay / 60000)} min`);

    const timer = setTimeout(async () => {
      await runScheduledPost();
      scheduleNext();
    }, delay);

    scheduleTimers.push(timer);
  }

  scheduleNext();
}

function clearSchedule() {
  scheduleTimers.forEach(t => clearTimeout(t));
  scheduleTimers = [];
}

// ── Routes ────────────────────────────────────────────────────
function registerRoutes(app, requireAuth) {

  // Simple key auth for browser-accessible routes
  function ownerKeyAuth(req, res, next) {
    const key = req.query.key || req.headers['x-admin-key'];
    if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
      return res.status(401).send(`
        <div style="font-family:sans-serif;text-align:center;padding:60px;background:#000;color:#fff;min-height:100vh;">
          <h2>Access denied</h2>
          <p style="color:rgba(255,255,255,0.5);">Add ?key=YOUR_ADMIN_KEY to the URL</p>
        </div>`);
    }
    next();
  }

  // Clear session and restart (forces fresh QR)
  app.get('/whatsapp/reset', ownerKeyAuth, async (req, res) => {
    if (sock) { try { await sock.end(); } catch(e) {} sock = null; }
    waReady = false; currentQR = null;
    try { fs.rmSync('/tmp/wa-session', { recursive: true, force: true }); } catch(e) {}
    console.log('[WhatsApp] Session cleared — reconnecting');
    setTimeout(connectBaileys, 1000);
    res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:60px;background:#000;color:#fff;min-height:100vh;">
        <h2>Session cleared</h2>
        <p style="color:rgba(255,255,255,0.5);">Generating fresh QR code...</p>
        <script>setTimeout(()=>location.href='/whatsapp/qr?key=${req.query.key||''}', 4000);</script>
      </div>`);
  });

  // QR code page
  app.get('/whatsapp/qr', ownerKeyAuth, async (req, res) => {

    if (waReady) {
      return res.send(`
        <div style="font-family:sans-serif;text-align:center;padding:60px;background:#000;color:#fff;min-height:100vh;">
          <h2 style="color:#22c55e;">WhatsApp Connected</h2>
          <p style="color:rgba(255,255,255,0.5);">Luna is connected to your WhatsApp.</p>
          <a href="/whatsapp/groups" style="display:inline-block;margin-top:20px;padding:12px 28px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:100px;">Manage Groups</a>
        </div>`);
    }

    if (!currentQR) {
      return res.send(`
        <div style="font-family:sans-serif;text-align:center;padding:60px;background:#000;color:#fff;min-height:100vh;">
          <h2>Waiting for QR...</h2>
          <p style="color:rgba(255,255,255,0.5);">Refresh in a few seconds.</p>
          <script>setTimeout(()=>location.reload(), 3000);</script>
        </div>`);
    }

    try {
      let QRCode;
      try { QRCode = require('qrcode'); } catch(e) {}
      if (!QRCode) return res.send(`<pre style="background:#000;color:#fff;padding:20px;">${currentQR}</pre>`);

      const qrImage = await QRCode.toDataURL(currentQR);
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1"/>
          <title>Luna WhatsApp</title>
          <style>
            body{margin:0;background:#000;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:24px;box-sizing:border-box;}
            h2{font-size:22px;margin-bottom:8px;}
            p{color:rgba(255,255,255,0.5);font-size:14px;margin-bottom:28px;text-align:center;}
            img{width:260px;height:260px;border-radius:16px;background:#fff;padding:12px;}
            .steps{margin-top:28px;text-align:left;max-width:280px;}
            .step{display:flex;gap:12px;margin-bottom:12px;font-size:14px;color:rgba(255,255,255,0.65);}
            .num{width:22px;height:22px;border-radius:50%;background:#7c3aed;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;}
          </style>
        </head>
        <body>
          <h2>Connect Luna to WhatsApp</h2>
          <p>Scan this QR code with your WhatsApp</p>
          <img src="${qrImage}" alt="QR"/>
          <div class="steps">
            <div class="step"><div class="num">1</div><span>Open WhatsApp on your phone</span></div>
            <div class="step"><div class="num">2</div><span>Tap the three dots → Linked Devices</span></div>
            <div class="step"><div class="num">3</div><span>Tap "Link a Device" and scan</span></div>
          </div>
          <script>setTimeout(()=>location.reload(), 20000);</script>
        </body>
        </html>`);
    } catch(e) {
      res.status(500).send('QR error: ' + e.message);
    }
  });

  // List and select groups
  app.get('/whatsapp/groups', ownerKeyAuth, async (req, res) => {
    if (!waReady) return res.redirect(`/whatsapp/qr?key=${req.query.key || ''}`);

    try {
      const groups = await sock.groupFetchAllParticipating();
      const rows = Object.entries(groups).map(([id, g]) => {
        const selected = selectedGroups.includes(id);
        return `<tr>
          <td style="padding:12px 16px;">${g.subject}</td>
          <td style="padding:12px 16px;color:rgba(255,255,255,0.4);">${g.participants?.length || '?'} members</td>
          <td style="padding:12px 16px;text-align:center;">
            <input type="checkbox" name="groups" value="${id}" ${selected ? 'checked' : ''}
              style="width:18px;height:18px;accent-color:#7c3aed;cursor:pointer;"/>
          </td>
        </tr>`;
      }).join('');

      res.send(`
        <!DOCTYPE html><html>
        <head><meta name="viewport" content="width=device-width,initial-scale=1"/>
        <title>Luna WhatsApp Groups</title>
        <style>
          *{box-sizing:border-box;} body{margin:0;background:#000;color:#fff;font-family:sans-serif;padding:24px;}
          h2{font-size:22px;margin-bottom:4px;} p{color:rgba(255,255,255,0.5);font-size:14px;margin-bottom:24px;}
          table{width:100%;border-collapse:collapse;} tr{border-bottom:1px solid rgba(255,255,255,0.08);}
          th{text-align:left;padding:10px 16px;font-size:12px;color:rgba(255,255,255,0.35);text-transform:uppercase;}
          .btn{display:block;width:100%;margin-top:24px;padding:14px;background:#7c3aed;color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;}
          .ok{margin-top:16px;text-align:center;font-size:14px;color:#22c55e;display:none;}
        </style></head>
        <body>
          <h2>Select Groups</h2>
          <p>Luna will post to these groups on schedule, one at a time.</p>
          <form id="f">
            <table><thead><tr><th>Group</th><th>Members</th><th>Post here</th></tr></thead>
            <tbody>${rows}</tbody></table>
            <button class="btn" type="submit">Save</button>
          </form>
          <div class="ok" id="ok">Saved!</div>
          <script>
            const KEY = new URLSearchParams(location.search).get('key') || '';
            document.getElementById('f').onsubmit = async(e) => {
              e.preventDefault();
              const checked = [...document.querySelectorAll('input[name=groups]:checked')].map(i=>i.value);
              const r = await fetch('/whatsapp/groups?key='+KEY,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groups:checked})});
              if(r.ok) document.getElementById('ok').style.display='block';
            };
          </script>
        </body></html>`);
    } catch(e) {
      res.status(500).send('Could not load groups: ' + e.message);
    }
  });

  // Save group selection
  app.post('/whatsapp/groups', ownerKeyAuth, (req, res) => {
    const { groups } = req.body;
    if (!Array.isArray(groups)) return res.status(400).json({ error: 'Invalid' });
    selectedGroups = groups;
    saveGroups();
    console.log('[WhatsApp] Groups saved:', groups.length);
    res.json({ success: true, count: groups.length });
  });

  // Manual post from Luna chat
  app.post('/whatsapp/post', requireAuth, async (req, res) => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
    if (!waReady) return res.status(503).json({ error: 'WhatsApp not connected' });

    const { text, target = 'all' } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });

    const results = { status: false, groups: [] };

    if (target === 'status' || target === 'all') {
      results.status = await postToStatus(text);
    }

    if ((target === 'groups' || target === 'all') && selectedGroups.length > 0) {
      for (const groupId of selectedGroups) {
        await humanDelay(3000, 7000);
        const ok = await postToGroup(groupId, text);
        results.groups.push({ groupId, ok });
      }
    }

    res.json({ success: true, results });
  });

  // Status check
  app.get('/whatsapp/status', requireAuth, (req, res) => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
    res.json({ connected: waReady, groups: selectedGroups.length, schedule: postSchedule.hours, hasQR: !!currentQR });
  });

  // Update schedule
  app.post('/whatsapp/schedule', requireAuth, (req, res) => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
    const { hours } = req.body;
    if (!Array.isArray(hours) || hours.some(h => h < 0 || h > 23))
      return res.status(400).json({ error: 'Invalid hours (0-23)' });
    postSchedule.hours = hours;
    if (waReady) schedulePostings();
    res.json({ success: true, hours });
  });

  // Disconnect
  app.post('/whatsapp/disconnect', requireAuth, async (req, res) => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
    if (sock) { try { await sock.logout(); } catch(e) {} }
    waReady = false;
    res.json({ success: true });
  });

  console.log('[WhatsApp] Routes registered');
}

module.exports = { initWhatsApp };
