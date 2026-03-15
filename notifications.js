'use strict';

/**
 * notifications.js — Luna Push Notification System
 *
 * Three types of notifications:
 *   1. Daily morning messages  — 30 pre-written, zero token cost, sent at 8am
 *   2. Reply notifications     — fired when Luna finishes responding to a user
 *   3. User reminders          — user sets a time + message, Luna delivers it
 *
 * Requires in .env:
 *   VAPID_PUBLIC_KEY
 *   VAPID_PRIVATE_KEY
 *   OWNER_EMAIL
 *   MONGODB_URI (already set)
 *
 * Usage in telegram.js:
 *   const { initNotifications, sendReplyNotification, scheduleReminder } = require('./notifications');
 *   initNotifications(app, mongoose);
 */

const mongoose = require('mongoose');

// ── Web push setup ────────────────────────────────────────────────────────────
const webpush = (() => {
  try { return require('web-push'); }
  catch(e) { console.warn('[Notif] web-push not installed — push disabled'); return null; }
})();

if (webpush && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.OWNER_EMAIL || 'admin@luna.ai'),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// ═════════════════════════════════════════════════════════════════════════════
//  SCHEMAS
// ═════════════════════════════════════════════════════════════════════════════

// Push subscription — one per user device
const PushSub = mongoose.models.PushSub || mongoose.model('PushSub', new mongoose.Schema({
  userId:       { type: String, required: true },
  subscription: { type: mongoose.Schema.Types.Mixed, required: true },
  createdAt:    { type: Date, default: Date.now }
}));

// Reminders — user-set, one-time or recurring
const ReminderSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  message:   { type: String, required: true },   // what to remind them
  fireAt:    { type: Date,   required: true },    // when to fire
  repeat:    { type: String, default: 'none' },   // none | daily | weekly
  active:    { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});
const Reminder = mongoose.models.Reminder || mongoose.model('Reminder', ReminderSchema);

// ═════════════════════════════════════════════════════════════════════════════
//  1. DAILY MORNING MESSAGES — 30 pre-written, zero token cost
//     Sent to all subscribers at 8am every day.
//     Written in Luna's voice — direct, warm, a little edge.
// ═════════════════════════════════════════════════════════════════════════════
const MORNING_MESSAGES = [
  "Good morning. The day is fresh and you haven't wasted it yet. Let's keep it that way 🔥",
  "Morning. Most people are still sleeping on their goals. You don't have to be one of them.",
  "New day. Same you — but you get to decide if that's a good thing or not today 💜",
  "You've got 24 hours. That's exactly how much time everyone who built something great had too.",
  "Morning check-in: what's the one thing that would make today feel worth it? Go do that.",
  "The version of you that figures it out is the same one reading this. Just start.",
  "Good morning. Comfort is nice but it doesn't build anything. What are we challenging today? 👀",
  "Wake up. The project won't finish itself and neither will the dream.",
  "Morning. You're one good decision away from a completely different day.",
  "Today is a good day to do the thing you've been putting off. Just saying 🙂",
  "Good morning. Here's a question to carry into your day: what would you build if failure wasn't an option?",
  "Morning thought: the people who change things aren't always the smartest — they're the most consistent.",
  "Morning. What's one thing you learned yesterday that you can use today?",
  "Good morning. Curiosity is free and it compounds. Feed it something today 🧠",
  "Morning. Not every day feels inspiring. Do the work anyway — that's how trust gets built.",
  "Good morning. Progress doesn't always feel like progress. Sometimes it just feels like showing up.",
  "Wake up. You're allowed to start messy. Done beats perfect every single time.",
  "Morning. If you're waiting to feel ready, you'll wait forever. Jump in.",
  "Good morning. The hard thing you're avoiding is usually the exact thing that moves you forward.",
  "Morning! ⚡ Small wins stack. What's the smallest win you can lock in today?",
  "Good morning! Today's agenda: think, build, grow, repeat. You've got this ☀️",
  "Morning. Sharp people don't wait for perfect conditions. They create them.",
  "Good morning. You're building something real. Don't let a slow day make you forget that 💜",
  "Morning check: head clear? Good. Now go do the thing.",
  "Good morning. Every expert was once a beginner who just refused to quit.",
  "Morning. The gap between where you are and where you want to be is just time and reps.",
  "Good morning. Your future self is either thanking you or wondering why you didn't start sooner.",
  "Morning. Show up today like the version of you who already figured it out.",
  "Good morning. One focused hour beats a whole distracted day. Find that hour 🎯",
  "Morning. You already survived every hard day you've had. Today is no different 💜",
];

// ─── Send one morning push to all subscribers ─────────────────────────────
async function sendDailyMorningPush() {
  if (!webpush) return;

  const subs = await PushSub.find({}).lean().catch(() => []);
  if (!subs.length) { console.log('[Notif] No push subscribers yet'); return; }

  // Pick a random message — rotate through full list before repeating
  const msg = MORNING_MESSAGES[Math.floor(Math.random() * MORNING_MESSAGES.length)];
  console.log(`[Notif] 📲 Sending morning push to ${subs.length} subscribers`);

  let sent = 0, expired = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub.subscription, JSON.stringify({
        title: '🌙 Luna',
        body: msg,
        icon: 'https://rolandoluwaseun4.github.io/Luna-Al/icon-192.png',
        badge: 'https://rolandoluwaseun4.github.io/Luna-Al/icon-192.png',
        url: 'https://rolandoluwaseun4.github.io/Luna-Al/',
        tag: 'luna-morning',        // replaces previous morning notification
        renotify: false,
      }));
      sent++;
    } catch(e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        // Subscription expired or unsubscribed — clean up
        await PushSub.findByIdAndDelete(sub._id);
        expired++;
      }
    }
  }
  console.log(`[Notif] Morning push done — sent: ${sent}, expired removed: ${expired}`);
}

// ─── Schedule daily at 8am, re-schedules itself ───────────────────────────
function scheduleDailyMorningPush() {
  const now  = new Date();
  const next = new Date();
  next.setHours(8, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  console.log(`[Notif] Next morning push in ${Math.round(delay / 60000)} min (${next.toISOString()})`);
  setTimeout(async () => {
    await sendDailyMorningPush();
    scheduleDailyMorningPush(); // re-schedule for next day
  }, delay);
}

// ═════════════════════════════════════════════════════════════════════════════
//  2. REPLY NOTIFICATIONS
//     Call this from the chat handler after Luna's reply is complete.
//     Sends a push only if the user is NOT currently on the page (handled
//     by the frontend via the Page Visibility API — it skips subscribing
//     to reply notifs while the app is open).
// ═════════════════════════════════════════════════════════════════════════════
async function sendReplyNotification(userId, replyPreview = '') {
  if (!webpush) return;

  const subs = await PushSub.find({ userId: String(userId) }).lean().catch(() => []);
  if (!subs.length) return;

  // Trim the reply to a clean preview
  const body = replyPreview
    ? replyPreview.replace(/\*\*/g, '').replace(/`/g, '').slice(0, 100) + (replyPreview.length > 100 ? '…' : '')
    : 'Luna replied to you 💜';

  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub.subscription, JSON.stringify({
        title: 'Luna replied',
        body,
        icon: 'https://rolandoluwaseun4.github.io/Luna-Al/icon-192.png',
        badge: 'https://rolandoluwaseun4.github.io/Luna-Al/icon-192.png',
        url: 'https://rolandoluwaseun4.github.io/Luna-Al/',
        tag: `luna-reply-${userId}`,  // one reply notif at a time per user
        renotify: true,
      }));
    } catch(e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        await PushSub.findByIdAndDelete(sub._id);
      }
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  3. USER REMINDERS
//     User tells Luna "remind me to do X at 3pm".
//     Backend stores it, fires when the time comes.
// ═════════════════════════════════════════════════════════════════════════════

// ─── Save a reminder for a user ───────────────────────────────────────────
async function scheduleReminder(userId, message, fireAt, repeat = 'none') {
  const reminder = await Reminder.create({
    userId: String(userId),
    message,
    fireAt: new Date(fireAt),
    repeat,
    active: true,
  });
  console.log(`[Notif] Reminder saved for ${userId} at ${fireAt}`);
  return reminder;
}

// ─── Cancel a reminder ────────────────────────────────────────────────────
async function cancelReminder(reminderId, userId) {
  await Reminder.findOneAndUpdate(
    { _id: reminderId, userId: String(userId) },
    { active: false }
  );
}

// ─── List user's active reminders ─────────────────────────────────────────
async function getUserReminders(userId) {
  return Reminder.find({ userId: String(userId), active: true, fireAt: { $gte: new Date() } })
    .sort({ fireAt: 1 })
    .lean();
}

// ─── Reminder poller — checks every minute for due reminders ──────────────
async function fireReminders() {
  const now = new Date();
  const due = await Reminder.find({
    active: true,
    fireAt: { $lte: now }
  }).lean().catch(() => []);

  for (const reminder of due) {
    const subs = await PushSub.find({ userId: reminder.userId }).lean().catch(() => []);

    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub.subscription, JSON.stringify({
          title: '⏰ Luna Reminder',
          body: reminder.message,
          icon: 'https://rolandoluwaseun4.github.io/Luna-Al/icon-192.png',
          badge: 'https://rolandoluwaseun4.github.io/Luna-Al/icon-192.png',
          url: 'https://rolandoluwaseun4.github.io/Luna-Al/',
          tag: `luna-reminder-${reminder._id}`,
          renotify: true,
        }));
      } catch(e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          await PushSub.findByIdAndDelete(sub._id);
        }
      }
    }

    // Handle repeat vs one-time
    if (reminder.repeat === 'daily') {
      const next = new Date(reminder.fireAt);
      next.setDate(next.getDate() + 1);
      await Reminder.findByIdAndUpdate(reminder._id, { fireAt: next });
    } else if (reminder.repeat === 'weekly') {
      const next = new Date(reminder.fireAt);
      next.setDate(next.getDate() + 7);
      await Reminder.findByIdAndUpdate(reminder._id, { fireAt: next });
    } else {
      // One-time — deactivate
      await Reminder.findByIdAndUpdate(reminder._id, { active: false });
    }

    console.log(`[Notif] ⏰ Reminder fired for userId: ${reminder.userId}`);
  }
}

function startReminderPoller() {
  // Check every 60 seconds
  setInterval(fireReminders, 60_000);
  console.log('[Notif] Reminder poller started (every 60s)');
}

// ═════════════════════════════════════════════════════════════════════════════
//  API ROUTES — register these on the Express app
// ═════════════════════════════════════════════════════════════════════════════
function registerRoutes(app, requireAuth) {

  // Save push subscription from browser
  app.post('/push/subscribe', requireAuth, async (req, res) => {
    try {
      const uid = String(req.user.id);
      const { subscription } = req.body;
      if (!subscription) return res.status(400).json({ error: 'No subscription' });
      await PushSub.findOneAndUpdate(
        { userId: uid },
        { userId: uid, subscription },
        { upsert: true, new: true }
      );
      res.json({ success: true });
    } catch(e) {
      res.status(500).json({ error: 'Could not save subscription' });
    }
  });

  // Unsubscribe
  app.post('/push/unsubscribe', requireAuth, async (req, res) => {
    try {
      await PushSub.deleteMany({ userId: String(req.user.id) });
      res.json({ success: true });
    } catch(e) {
      res.status(500).json({ error: 'Could not unsubscribe' });
    }
  });

  // Get user's reminders
  app.get('/reminders', requireAuth, async (req, res) => {
    try {
      const reminders = await getUserReminders(String(req.user.id));
      res.json({ reminders });
    } catch(e) {
      res.status(500).json({ error: 'Could not load reminders' });
    }
  });

  // Create a reminder
  app.post('/reminders', requireAuth, async (req, res) => {
    try {
      const { message, fireAt, repeat } = req.body;
      if (!message || !fireAt) return res.status(400).json({ error: 'message and fireAt required' });
      const reminder = await scheduleReminder(String(req.user.id), message, fireAt, repeat);
      res.json({ success: true, reminder });
    } catch(e) {
      res.status(500).json({ error: 'Could not create reminder' });
    }
  });

  // Cancel a reminder
  app.delete('/reminders/:id', requireAuth, async (req, res) => {
    try {
      await cancelReminder(req.params.id, String(req.user.id));
      res.json({ success: true });
    } catch(e) {
      res.status(500).json({ error: 'Could not cancel reminder' });
    }
  });

  console.log('[Notif] Routes registered: /push/subscribe, /push/unsubscribe, /reminders');
}

// ═════════════════════════════════════════════════════════════════════════════
//  INIT — call this once from telegram.js
//
//  Usage:
//    const { initNotifications, sendReplyNotification } = require('./notifications');
//    initNotifications(app, requireAuth);
//
//  Then in your chat handler after Luna replies:
//    await sendReplyNotification(userId, lunaReply);
// ═════════════════════════════════════════════════════════════════════════════
function initNotifications(app, requireAuth) {
  if (!webpush) {
    console.warn('[Notif] web-push not available — install it: npm install web-push');
    return;
  }
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.warn('[Notif] VAPID keys missing — push notifications disabled');
    return;
  }

  registerRoutes(app, requireAuth);
  scheduleDailyMorningPush();
  startReminderPoller();
  console.log('[Notif] ✅ Notification system ready');
}

module.exports = {
  initNotifications,
  sendReplyNotification,
  scheduleReminder,
  cancelReminder,
  getUserReminders,
  MORNING_MESSAGES,
};
