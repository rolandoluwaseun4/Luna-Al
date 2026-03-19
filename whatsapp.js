'use strict';
/**
 * whatsapp.js — Luna WhatsApp Content Manager
 *
 * What it does:
 * - Connects to your WhatsApp via QR code (like WhatsApp Web)
 * - Posts to your status at scheduled times
 * - Posts to selected groups at scheduled times
 * - Owner can trigger posts manually from Luna chat
 * - Human-like delays between messages
 *
 * Setup:
 * 1. npm install whatsapp-web.js qrcode
 * 2. Add to telegram.js: require('./whatsapp')(app, OWNER_EMAIL)
 * 3. Visit /whatsapp/qr to scan QR code with your phone
 * 4. Visit /whatsapp/groups to see and select your groups
 */

const fs   = require('fs');
const path = require('path');

// ── Lazy load whatsapp-web.js ─────────────────────────────────
let Client, LocalAuth, MessageMedia;
try {
  ({ Client, LocalAuth, MessageMedia } = require('whatsapp-web.js'));
} catch(e) {
  console.warn('[WhatsApp] whatsapp-web.js not installed. Run: npm install whatsapp-web.js qrcode');
}

let QRCode;
try { QRCode = require('qrcode'); } catch(e) {}

// ── State ─────────────────────────────────────────────────────
let waClient       = null;
let waReady        = false;
let waQR           = null;           // current QR string
let selectedGroups = [];             // group IDs to post to
let postSchedule   = { hours: [8, 19] }; // post at 8am and 7pm
let scheduleTimers = [];

// ── Content themes ────────────────────────────────────────────
const STATUS_TEMPLATES = [
  "Building something that actually thinks. Luna AI — try it free 👉 https://rolandoluwaseun4.github.io/Luna-Al/",
  "Most AI apps feel like talking to a manual. Luna feels like talking to someone. Try her → https://rolandoluwaseun4.github.io/Luna-Al/",
  "I built an AI assistant from scratch on my phone. No laptop. No funding. Just code and stubbornness. Luna → https://rolandoluwaseun4.github.io/Luna-Al/",
  "Luna can chat, generate images, search the web, and remember you. All free. https://rolandoluwaseun4.github.io/Luna-Al/",
  "If you've been using ChatGPT, try Luna. Built by a Nigerian developer, feels more personal. https://rolandoluwaseun4.github.io/Luna-Al/",
  "Free AI. No subscription. No paywall after 2 messages. Just Luna. https://rolandoluwaseun4.github.io/Luna-Al/",
  "Luna doesn't just answer — she thinks. Try asking her something deep. https://rolandoluwaseun4.github.io/Luna-Al/",
  "Built Luna AI in months, from my phone. If you have an idea, you have everything you need. Start.",
  "Your AI assistant should feel like a friend, not a search engine. That's why I built Luna. https://rolandoluwaseun4.github.io/Luna-Al/",
  "Luna update: voice mode is live. Talk to her, she talks back. https://rolandoluwaseun4.github.io/Luna-Al/",
];

const GROUP_TEMPLATES = [
  "Have you tried Luna AI? It's a free personal AI assistant — chats, generates images, searches the web. Built by Roland 🇳🇬 → https://rolandoluwaseun4.github.io/Luna-Al/",
  "Free AI tool for anyone in this group 👇 Luna AI — no signup needed to try it. https://rolandoluwaseun4.github.io/Luna-Al/",
  "Luna AI now has voice mode — you can literally talk to it and it talks back with a real human voice. Try it free → https://rolandoluwaseun4.github.io/Luna-Al/",
  "Quick flex: built a full AI app from my phone. Luna AI is live and free. Check it out → https://rolandoluwaseun4.github.io/Luna-Al/",
];

// ── Init ──────────────────────────────────────────────────────
function initWhatsApp(app, requireAuth) {
  if (!Client) {
    console.warn('[WhatsApp] Module not available');
    registerRoutes(app, requireAuth);
    return;
  }

  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: '/tmp/wa-session' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    }
  });

  waClient.on('qr', (qr) => {
    waQR = qr;
    waReady = false;
    console.log('[WhatsApp] QR code ready — visit /whatsapp/qr to scan');
  });

  waClient.on('ready', async () => {
    waReady = true;
    waQR    = null;
    console.log('[WhatsApp] Connected and ready');
    schedulePostings();
    await loadSavedGroups();
  });

  waClient.on('disconnected', (reason) => {
    waReady = false;
    console.log('[WhatsApp] Disconnected:', reason);
    clearSchedule();
  });

  waClient.on('auth_failure', () => {
    waReady = false;
    console.log('[WhatsApp] Auth failed — rescan QR');
  });

  waClient.initialize().catch(e => {
    console.error('[WhatsApp] Init error:', e.message);
  });

  registerRoutes(app, requireAuth);
}

// ── Load saved group selection ────────────────────────────────
async function loadSavedGroups() {
  try {
    const file = '/tmp/wa-groups.json';
    if (fs.existsSync(file)) {
      selectedGroups = JSON.parse(fs.readFileSync(file, 'utf8'));
      console.log(`[WhatsApp] Loaded ${selectedGroups.length} saved groups`);
    }
  } catch(e) {}
}

function saveGroups() {
  try { fs.writeFileSync('/tmp/wa-groups.json', JSON.stringify(selectedGroups)); } catch(e) {}
}

// ── Posting ───────────────────────────────────────────────────
function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function humanDelay(min = 2000, max = 5000) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

async function postToStatus(text) {
  if (!waReady || !waClient) return false;
  try {
    await waClient.setStatus(text);
    console.log('[WhatsApp] Status updated');
    return true;
  } catch(e) {
    console.error('[WhatsApp] Status error:', e.message);
    return false;
  }
}

async function postToGroup(groupId, text) {
  if (!waReady || !waClient) return false;
  try {
    await humanDelay(2000, 4000); // natural delay before sending
    const chat = await waClient.getChatById(groupId);
    await chat.sendMessage(text);
    console.log('[WhatsApp] Posted to group:', groupId);
    return true;
  } catch(e) {
    console.error('[WhatsApp] Group post error:', e.message);
    return false;
  }
}

async function runScheduledPost() {
  if (!waReady) return;
  console.log('[WhatsApp] Running scheduled post');

  // Post to status
  const statusText = randomItem(STATUS_TEMPLATES);
  await postToStatus(statusText);

  // Post to selected groups with delays between each
  if (selectedGroups.length > 0) {
    const groupText = randomItem(GROUP_TEMPLATES);
    for (const groupId of selectedGroups) {
      await postToGroup(groupId, groupText);
      await humanDelay(3000, 8000); // wait between groups
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

    for (const hour of postSchedule.hours.sort((a,b) => a-b)) {
      next.setHours(hour, 0, 0, 0);
      if (next > now) { found = true; break; }
    }
    if (!found) {
      next.setDate(next.getDate() + 1);
      next.setHours(postSchedule.hours[0], 0, 0, 0);
    }

    const delay = next - now;
    console.log(`[WhatsApp] Next post in ${Math.round(delay / 60000)} minutes`);

    const timer = setTimeout(async () => {
      await runScheduledPost();
      scheduleNext(); // schedule next one
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

  // QR code page — owner only
  app.get('/whatsapp/qr', requireAuth, async (req, res) => {
    if (req.user.role !== 'owner') return res.status(403).send('Owner only');

    if (waReady) {
      return res.send(`
        <div style="font-family:sans-serif;text-align:center;padding:60px;background:#000;color:#fff;min-height:100vh;">
          <h2 style="color:#22c55e;">WhatsApp Connected</h2>
          <p style="color:rgba(255,255,255,0.5);">Luna is connected to your WhatsApp. You can now manage groups and posts.</p>
          <a href="/whatsapp/groups" style="display:inline-block;margin-top:20px;padding:12px 28px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:100px;">Manage Groups</a>
        </div>`);
    }

    if (!waQR) {
      return res.send(`
        <div style="font-family:sans-serif;text-align:center;padding:60px;background:#000;color:#fff;min-height:100vh;">
          <h2>Waiting for QR code...</h2>
          <p style="color:rgba(255,255,255,0.5);">Refresh in a few seconds.</p>
          <script>setTimeout(()=>location.reload(), 3000);</script>
        </div>`);
    }

    try {
      const qrImage = await QRCode.toDataURL(waQR);
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1"/>
          <title>Luna WhatsApp — Scan QR</title>
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
          <img src="${qrImage}" alt="QR Code"/>
          <div class="steps">
            <div class="step"><div class="num">1</div><span>Open WhatsApp on your phone</span></div>
            <div class="step"><div class="num">2</div><span>Tap the three dots → Linked Devices</span></div>
            <div class="step"><div class="num">3</div><span>Tap "Link a Device" and scan this QR</span></div>
          </div>
          <script>setTimeout(()=>location.reload(), 25000);</script>
        </body>
        </html>`);
    } catch(e) {
      res.status(500).send('QR generation failed');
    }
  });

  // List groups + select which to post to
  app.get('/whatsapp/groups', requireAuth, async (req, res) => {
    if (req.user.role !== 'owner') return res.status(403).send('Owner only');
    if (!waReady) return res.redirect('/whatsapp/qr');

    try {
      const chats  = await waClient.getChats();
      const groups = chats.filter(c => c.isGroup);

      const rows = groups.map(g => {
        const selected = selectedGroups.includes(g.id._serialized);
        return `<tr>
          <td style="padding:12px 16px;">${g.name}</td>
          <td style="padding:12px 16px;color:rgba(255,255,255,0.4);">${g.participants?.length || '?'} members</td>
          <td style="padding:12px 16px;text-align:center;">
            <input type="checkbox" name="groups" value="${g.id._serialized}" ${selected ? 'checked' : ''}
              style="width:18px;height:18px;accent-color:#7c3aed;cursor:pointer;"/>
          </td>
        </tr>`;
      }).join('');

      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1"/>
          <title>Luna WhatsApp — Groups</title>
          <style>
            *{box-sizing:border-box;} body{margin:0;background:#000;color:#fff;font-family:sans-serif;padding:24px;}
            h2{font-size:22px;margin-bottom:4px;} p{color:rgba(255,255,255,0.5);font-size:14px;margin-bottom:24px;}
            table{width:100%;border-collapse:collapse;} tr{border-bottom:1px solid rgba(255,255,255,0.08);}
            th{text-align:left;padding:10px 16px;font-size:12px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:.06em;}
            .btn{display:block;width:100%;margin-top:24px;padding:14px;background:#7c3aed;color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;}
            .status{margin-top:16px;text-align:center;font-size:14px;color:#22c55e;display:none;}
          </style>
        </head>
        <body>
          <h2>Select Groups</h2>
          <p>Luna will post to these groups on schedule.</p>
          <form id="form">
            <table>
              <thead><tr><th>Group</th><th>Members</th><th>Post here</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
            <button class="btn" type="submit">Save Selection</button>
          </form>
          <div class="status" id="status">Saved!</div>
          <script>
            document.getElementById('form').onsubmit = async (e) => {
              e.preventDefault();
              const checked = [...document.querySelectorAll('input[name=groups]:checked')].map(i=>i.value);
              const res = await fetch('/whatsapp/groups', {method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+localStorage.getItem('luna-token')},body:JSON.stringify({groups:checked})});
              if(res.ok){document.getElementById('status').style.display='block';}
            };
          </script>
        </body>
        </html>`);
    } catch(e) {
      res.status(500).send('Could not load groups: ' + e.message);
    }
  });

  // Save group selection
  app.post('/whatsapp/groups', requireAuth, async (req, res) => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
    const { groups } = req.body;
    if (!Array.isArray(groups)) return res.status(400).json({ error: 'Invalid groups' });
    selectedGroups = groups;
    saveGroups();
    console.log('[WhatsApp] Groups updated:', groups.length);
    res.json({ success: true, count: groups.length });
  });

  // Manual post trigger from Luna chat
  app.post('/whatsapp/post', requireAuth, async (req, res) => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
    if (!waReady) return res.status(503).json({ error: 'WhatsApp not connected' });

    const { text, target } = req.body; // target: 'status' | 'groups' | 'all'
    if (!text) return res.status(400).json({ error: 'Text required' });

    let results = { status: false, groups: [] };

    if (target === 'status' || target === 'all') {
      results.status = await postToStatus(text);
    }

    if ((target === 'groups' || target === 'all') && selectedGroups.length > 0) {
      for (const groupId of selectedGroups) {
        const ok = await postToGroup(groupId, text);
        results.groups.push({ groupId, ok });
        await humanDelay(2000, 5000);
      }
    }

    res.json({ success: true, results });
  });

  // Status check
  app.get('/whatsapp/status', requireAuth, (req, res) => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
    res.json({
      connected: waReady,
      groups: selectedGroups.length,
      schedule: postSchedule.hours,
      hasQR: !!waQR,
    });
  });

  // Update schedule
  app.post('/whatsapp/schedule', requireAuth, (req, res) => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
    const { hours } = req.body;
    if (!Array.isArray(hours) || hours.some(h => h < 0 || h > 23)) {
      return res.status(400).json({ error: 'Invalid hours array (0-23)' });
    }
    postSchedule.hours = hours;
    if (waReady) schedulePostings();
    res.json({ success: true, hours });
  });

  console.log('[WhatsApp] Routes registered');
}

module.exports = { initWhatsApp };
