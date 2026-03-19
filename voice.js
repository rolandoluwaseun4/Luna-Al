/**
 * voice.js — Luna Voice Conversation Mode
 * Simple: tap mic to start, tap again to stop.
 * No wake word. No background mic. No auto-start.
 * ElevenLabs TTS (Eryn) for Luna's responses.
 */

// ── State ─────────────────────────────────────────────────────
let voiceModeActive = false;
let isListening     = false;
let isSpeaking      = false;
let recognition     = null;
let currentAudio    = null;
let onSendMessage   = null;
let restartTimer    = null;

// ── Init ──────────────────────────────────────────────────────
function initVoiceMode({ sendMessageFn, backend }) {
  onSendMessage = sendMessageFn;
  window._voiceBackend = backend;
  // No mic until user taps
}

// ── Toggle ────────────────────────────────────────────────────
function toggleVoiceMode() {
  if (voiceModeActive) stopVoiceMode();
  else startVoiceMode();
}

function startVoiceMode() {
  if (!checkSpeechSupport()) return;
  voiceModeActive = true;
  updateVoiceBtn(true);
  showVoiceOverlay(true);
  setVoiceState('listening');
  startListening();
}

function stopVoiceMode() {
  voiceModeActive = false;
  isListening     = false;
  isSpeaking      = false;

  clearTimeout(restartTimer);

  if (recognition) {
    try { recognition.stop(); } catch(e) {}
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

// ── Speech recognition ────────────────────────────────────────
function startListening() {
  if (!voiceModeActive || isSpeaking) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;

  if (recognition) {
    try { recognition.stop(); } catch(e) {}
    recognition = null;
  }

  recognition = new SR();
  recognition.lang = 'en-US';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (e) => {
    const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
    setVoiceTranscript(transcript);

    if (e.results[e.results.length - 1].isFinal) {
      const final = transcript.trim();
      if (final.length > 0) {
        isListening = false;
        setVoiceState('thinking');
        sendToLuna(final);
      }
    }
  };

  recognition.onerror = (e) => {
    if (e.error === 'not-allowed') { stopVoiceMode(); return; }
    // no-speech and other errors — restart quietly
  };

  recognition.onend = () => {
    isListening = false;
    if (!voiceModeActive || isSpeaking) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (voiceModeActive && !isSpeaking) startListening();
    }, 800);
  };

  try {
    recognition.start();
    isListening = true;
  } catch(e) {}
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
      setVoiceState('listening');
      if (voiceModeActive) startListening();
    }
  } catch(e) {
    console.warn('[Voice] Error:', e.message);
    setVoiceState('listening');
    if (voiceModeActive) startListening();
  }
}

// ── ElevenLabs TTS ────────────────────────────────────────────
async function speakReply(text) {
  isSpeaking = true;
  setVoiceState('speaking');

  const clean = text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/#{1,6}\s/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 500);

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

    currentAudio.onended = () => {
      URL.revokeObjectURL(url);
      currentAudio = null;
      isSpeaking = false;
      setVoiceTranscript('');
      setVoiceState('listening');
      if (voiceModeActive) startListening();
    };

    currentAudio.onerror = () => {
      URL.revokeObjectURL(url);
      currentAudio = null;
      isSpeaking = false;
      setVoiceState('listening');
      if (voiceModeActive) startListening();
    };

    await currentAudio.play();

  } catch(e) {
    // Fallback to browser TTS
    const utt = new SpeechSynthesisUtterance(clean);
    const voices = window.speechSynthesis.getVoices();
    const v = voices.find(v => v.lang.startsWith('en') && v.localService) || voices[0];
    if (v) utt.voice = v;
    utt.rate = 1.05;
    utt.onend = utt.onerror = () => {
      isSpeaking = false;
      setVoiceState('listening');
      if (voiceModeActive) startListening();
    };
    isSpeaking = true;
    window.speechSynthesis.speak(utt);
  }
}

window.speakWithElevenLabs = speakReply;

// ── UI helpers ────────────────────────────────────────────────
function setVoiceState(state) {
  const overlay = document.getElementById('voice-overlay');
  const label   = document.getElementById('voice-state-label');
  const orb     = document.getElementById('voice-orb');
  if (!overlay) return;
  overlay.dataset.state = state;
  if (orb) orb.dataset.state = state;
  const labels = { listening: 'Listening...', thinking: 'Thinking...', speaking: 'Speaking...' };
  if (label) label.textContent = labels[state] || '';
}

function setVoiceTranscript(text) {
  const el = document.getElementById('voice-transcript');
  if (el) el.textContent = text;
}

function updateVoiceBtn(active) {
  const btn = document.getElementById('voice-mode-btn');
  if (!btn) return;
  btn.classList.toggle('voice-mode-active', active);
}

function showVoiceOverlay(show) {
  const overlay = document.getElementById('voice-overlay');
  if (!overlay) return;
  overlay.classList.toggle('open', show);
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
function onChatScreenActive()   { /* user taps to start */ }

window.initVoiceMode        = initVoiceMode;
window.toggleVoiceMode      = toggleVoiceMode;
window.stopVoiceMode        = stopVoiceMode;
window.onChatScreenActive   = onChatScreenActive;
window.onChatScreenInactive = onChatScreenInactive;
