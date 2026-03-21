/**
 * voice.js — Luna Voice Mode (Walkie-Talkie Model)
 *
 * Flow:
 *   1. Tap mic button → overlay opens
 *   2. Tap the big orb → mic opens ONCE, user speaks
 *   3. User stops talking → mic closes automatically
 *   4. Luna thinks → Eryn speaks the reply
 *   5. "Tap to speak" button appears for next turn
 *
 * One beep per tap. Works on Android + iPhone.
 * No loops. No continuous listening. No surprises.
 */

// ── State ─────────────────────────────────────────────────────
let voiceModeActive = false;
let isListening     = false;
let isSpeaking      = false;
let recognition     = null;
let currentAudio    = null;
let onSendMessage   = null;

// ── Init ──────────────────────────────────────────────────────
function initVoiceMode({ sendMessageFn, backend }) {
  onSendMessage = sendMessageFn;
  window._voiceBackend = backend;
}

// ── Open / close voice overlay ────────────────────────────────
function toggleVoiceMode() {
  if (voiceModeActive) stopVoiceMode();
  else openVoiceMode();
}

function openVoiceMode() {
  if (!checkSpeechSupport()) return;
  voiceModeActive = true;
  updateVoiceBtn(true);
  showVoiceOverlay(true);
  setVoiceState('idle'); // waiting for user to tap orb
}

function stopVoiceMode() {
  voiceModeActive = false;
  isListening     = false;
  isSpeaking      = false;

  if (recognition) {
    try { recognition.abort(); } catch(e) {}
    recognition = null;
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();

  updateVoiceBtn(false);
  showVoiceOverlay(false);
}

// ── User taps the orb to speak ────────────────────────────────
function orbTapped() {
  if (!voiceModeActive) return;
  if (isSpeaking) {
    // Stop Luna speaking
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    isSpeaking = false;
    setVoiceState('idle');
    return;
  }
  if (isListening) return; // already listening
  startOneTurn();
}

// ── One listening turn ────────────────────────────────────────
function startOneTurn() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;

  if (recognition) {
    try { recognition.abort(); } catch(e) {}
    recognition = null;
  }

  recognition = new SR();
  recognition.lang = 'en-US';
  recognition.continuous = false;      // one utterance only
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let finalText = '';
  let interimText = '';
  let sentAlready = false;

  recognition.onstart = () => {
    isListening = true;
    finalText = '';
    interimText = '';
    sentAlready = false;
    setVoiceState('listening');
    setVoiceTranscript('');
  };

  recognition.onresult = (e) => {
    finalText = '';
    interimText = '';
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      else interimText += e.results[i][0].transcript;
    }
    setVoiceTranscript(finalText || interimText);

    // If we got a final result, send immediately
    if (finalText.trim() && !sentAlready) {
      sentAlready = true;
      isListening = false;
      try { recognition.stop(); } catch(e) {}
      setVoiceState('thinking');
      sendToLuna(finalText.trim());
    }
  };

  recognition.onerror = (e) => {
    isListening = false;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      stopVoiceMode();
      if (typeof showToast === 'function') showToast('Microphone permission denied');
      return;
    }
    if (e.error === 'no-speech') {
      setVoiceState('idle');
      setVoiceTranscript('');
      return;
    }
    setVoiceState('idle');
  };

  recognition.onend = () => {
    isListening = false;
    recognition = null;
    if (sentAlready) return; // already handled in onresult

    // Use whatever we captured — final or interim
    const text = (finalText || interimText).trim();
    if (text && voiceModeActive) {
      sentAlready = true;
      setVoiceState('thinking');
      sendToLuna(text);
    } else {
      setVoiceState('idle');
      setVoiceTranscript('');
    }
  };

  try {
    recognition.start();
  } catch(e) {
    isListening = false;
    setVoiceState('idle');
    console.warn('[Voice] Could not start:', e.message);
  }
}

// ── Send to Luna ──────────────────────────────────────────────
async function sendToLuna(text) {
  setVoiceTranscript(text);
  setVoiceState('thinking');

  try {
    const reply = await onSendMessage(text);
    if (reply && reply.trim()) {
      await speakReply(reply);
    } else {
      setVoiceState('idle');
    }
  } catch(e) {
    console.warn('[Voice] Send error:', e.message);
    setVoiceState('idle');
    setVoiceTranscript('Error. Tap to try again.');
  }
}

// ── ElevenLabs TTS ────────────────────────────────────────────
async function speakReply(text) {
  isSpeaking = true;
  setVoiceState('speaking');

  const clean = stripMarkdown(text).slice(0, 500);

  try {
    const res = await fetch(`${window._voiceBackend}/voice/speak`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${window._lunaToken || ''}`
      },
      body: JSON.stringify({ text: clean })
    });

    if (!res.ok) throw new Error(`${res.status}`);

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    currentAudio = new Audio(url);

    await new Promise((resolve) => {
      currentAudio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      currentAudio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
      currentAudio.play().catch(resolve);
    });

  } catch(e) {
    // Browser TTS fallback
    await browserSpeak(clean);
  }

  currentAudio = null;
  isSpeaking   = false;
  setVoiceTranscript('');
  // After speaking, go back to idle — user taps to speak again
  if (voiceModeActive) setVoiceState('idle');
}

function browserSpeak(text) {
  return new Promise((resolve) => {
    const utt = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const v = voices.find(v => v.lang.startsWith('en') && v.localService) || voices[0];
    if (v) utt.voice = v;
    utt.rate = 1.05;
    utt.onend = utt.onerror = resolve;
    window.speechSynthesis.speak(utt);
  });
}

// ── Read-aloud for message buttons (ElevenLabs) ───────────────
let readAudio = null;
async function readAloudElevenLabs(text, btn) {
  // Stop if already playing
  if (readAudio) {
    readAudio.pause(); readAudio = null;
    document.querySelectorAll('.mac-speaking').forEach(b => b.classList.remove('mac-speaking'));
    return;
  }

  if (btn) btn.classList.add('mac-speaking');
  const clean = stripMarkdown(text).slice(0, 1000);

  try {
    const res = await fetch(`${window._voiceBackend}/voice/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${window._lunaToken || ''}` },
      body: JSON.stringify({ text: clean })
    });
    if (!res.ok) throw new Error('failed');
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    readAudio = new Audio(url);
    readAudio.onended = readAudio.onerror = () => {
      URL.revokeObjectURL(url); readAudio = null;
      document.querySelectorAll('.mac-speaking').forEach(b => b.classList.remove('mac-speaking'));
    };
    readAudio.play();
  } catch(e) {
    // Browser TTS fallback
    const utt = new SpeechSynthesisUtterance(clean);
    const voices = window.speechSynthesis.getVoices();
    const v = voices.find(v => v.lang.startsWith('en')) || voices[0];
    if (v) utt.voice = v;
    utt.onend = utt.onerror = () => {
      document.querySelectorAll('.mac-speaking').forEach(b => b.classList.remove('mac-speaking'));
    };
    window.speechSynthesis.speak(utt);
  }
}
window.readAloudElevenLabs = readAloudElevenLabs;

// ── Helpers ───────────────────────────────────────────────────
function stripMarkdown(t) {
  return t
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/#{1,6}\s/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n+/g, ' ')
    .trim();
}

function setVoiceState(state) {
  const overlay = document.getElementById('voice-overlay');
  const label   = document.getElementById('voice-state-label');
  const orb     = document.getElementById('voice-orb');
  const hint    = document.getElementById('voice-hint');
  if (!overlay) return;
  overlay.dataset.state = state;
  if (orb) orb.dataset.state = state;
  const labels = {
    idle:      'Tap to speak',
    listening: 'Listening...',
    thinking:  'Thinking...',
    speaking:  'Speaking...',
  };
  if (label) label.textContent = labels[state] || '';
  if (hint) hint.style.display = state === 'idle' ? 'block' : 'none';
}

function setVoiceTranscript(text) {
  const el = document.getElementById('voice-transcript');
  if (el) el.textContent = text;
}

function updateVoiceBtn(active) {
  const btn = document.getElementById('voice-mode-btn');
  if (btn) btn.classList.toggle('voice-mode-active', active);
}

function showVoiceOverlay(show) {
  const overlay = document.getElementById('voice-overlay');
  if (!overlay) return;
  overlay.style.display = show ? 'flex' : 'none';
  if (!show) setVoiceTranscript('');
}

function checkSpeechSupport() {
  if (!('SpeechRecognition' in window) && !('webkitSpeechRecognition' in window)) {
    if (typeof showToast === 'function') showToast('Voice not supported in this browser');
    return false;
  }
  return true;
}

function onChatScreenInactive() { stopVoiceMode(); }
function onChatScreenActive()   {}

// ── Globals ───────────────────────────────────────────────────
window.initVoiceMode        = initVoiceMode;
window.toggleVoiceMode      = toggleVoiceMode;
window.stopVoiceMode        = stopVoiceMode;
window.orbTapped            = orbTapped;
window.onChatScreenActive   = onChatScreenActive;
window.onChatScreenInactive = onChatScreenInactive;

// Self-init using config already set by app.js
if (window._voiceConfig) {
  initVoiceMode(window._voiceConfig);
}
