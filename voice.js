/**
 * voice.js — Luna Voice Conversation Mode
 *
 * Features:
 * - Tap mic button to enter voice mode
 * - "Hey Luna" wake word detection (chat screen only)
 * - ElevenLabs TTS (Eryn voice) for natural responses
 * - Auto-loop: after Luna speaks, mic opens again
 * - Hands-free conversation
 *
 * Requires: ELEVENLABS_API_KEY in Railway env
 * Voice: Eryn (DXFkLCBUTmvXpp2QwZjA)
 */

const ELEVENLABS_VOICE_ID = 'DXFkLCBUTmvXpp2QwZjA';
const ELEVENLABS_MODEL    = 'eleven_turbo_v2'; // fastest, lowest latency

// ── State ─────────────────────────────────────────────────────
let voiceModeActive   = false;
let isListening       = false;
let isSpeaking        = false;
let wakeWordActive    = false;
let currentAudio      = null;
let recognition       = null;
let wakeRecognition   = null;
let voiceBtn          = null;
let onSendMessage     = null;
let tooQuickRestarts  = 0; // tracks rapid restarts to throttle

const WAKE_WORDS = ['hey luna', 'hey, luna', 'ok luna', 'okay luna'];

// ── Init — call once after DOM ready ──────────────────────────
function initVoiceMode({ sendMessageFn, backend }) {
  onSendMessage = sendMessageFn;
  window._voiceBackend = backend;

  voiceBtn = document.getElementById('voice-mode-btn');
  if (voiceBtn) {
    voiceBtn.addEventListener('click', toggleVoiceMode);
  }

  // Start wake word detection when on chat screen
  startWakeWordDetection();
}

// ── Toggle voice mode on/off ──────────────────────────────────
function toggleVoiceMode() {
  if (voiceModeActive) {
    stopVoiceMode();
  } else {
    startVoiceMode();
  }
}

function startVoiceMode() {
  if (!checkSpeechSupport()) return;
  voiceModeActive  = true;
  tooQuickRestarts = 0;
  updateVoiceBtn(true);
  showVoiceOverlay(true);
  startListening();
}

function stopVoiceMode() {
  voiceModeActive = false;
  isListening     = false;
  isSpeaking      = false;

  if (recognition) { try { recognition.stop(); } catch(e) {} }
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }

  updateVoiceBtn(false);
  showVoiceOverlay(false);
  setVoiceState('idle');
}

// ── Speech Recognition (STT) ──────────────────────────────────
function startListening() {
  if (!voiceModeActive || isSpeaking) return;
  if (!checkSpeechSupport()) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.lang = 'en-US';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  isListening = true;
  // Only update UI state if not already showing listening — prevents flicker on restart
  const overlay = document.getElementById('voice-overlay');
  if (overlay && overlay.dataset.state !== 'listening') {
    setVoiceState('listening');
  }
  setVoiceTranscript('');

  recognition.onresult = (e) => {
    tooQuickRestarts = 0; // got speech — reset
    const transcript = Array.from(e.results)
      .map(r => r[0].transcript)
      .join('');

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
    if (e.error === 'not-allowed') {
      showVoiceOverlay(false);
      stopVoiceMode();
      return;
    }
    // Ignore no-speech — just restart quietly
    if (e.error === 'no-speech') return;
    console.warn('[Voice] STT error:', e.error);
  };

  recognition.onend = () => {
    isListening = false;
    if (!voiceModeActive || isSpeaking) return;
    tooQuickRestarts++;
    const delay = tooQuickRestarts > 3 ? 2500 : 800;
    setTimeout(() => {
      if (voiceModeActive && !isSpeaking) startListening();
    }, delay);
  };

  try {
    recognition.start();
  } catch(e) {
    console.warn('[Voice] Could not start recognition:', e.message);
  }
}

// ── Wake word detection (background, chat screen only) ────────
function startWakeWordDetection() {
  if (!checkSpeechSupport()) return;
  if (wakeRecognition) return; // already running

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  wakeRecognition = new SR();
  wakeRecognition.lang = 'en-US';
  wakeRecognition.continuous = true;
  wakeRecognition.interimResults = true;

  wakeRecognition.onresult = (e) => {
    if (voiceModeActive) return; // already in voice mode
    const transcript = Array.from(e.results)
      .map(r => r[0].transcript.toLowerCase())
      .join(' ');

    const triggered = WAKE_WORDS.some(w => transcript.includes(w));
    if (triggered) {
      wakeWordActive = true;
      startVoiceMode();
    }
  };

  wakeRecognition.onend = () => {
    // Restart wake word listener if not in voice mode
    if (!voiceModeActive) {
      setTimeout(() => {
        try { wakeRecognition.start(); } catch(e) {}
      }, 500);
    }
  };

  wakeRecognition.onerror = (e) => {
    if (e.error === 'not-allowed') {
      console.warn('[Voice] Mic permission denied — wake word disabled');
      return;
    }
    // Restart on other errors
    setTimeout(() => {
      try { wakeRecognition.start(); } catch(e) {}
    }, 2000);
  };

  try {
    wakeRecognition.start();
    console.log('[Voice] Wake word detection started');
  } catch(e) {
    console.warn('[Voice] Could not start wake word detection:', e.message);
  }
}

function stopWakeWordDetection() {
  if (wakeRecognition) {
    try { wakeRecognition.stop(); } catch(e) {}
    wakeRecognition = null;
  }
}

// ── Send message to Luna ──────────────────────────────────────
async function sendToLuna(text) {
  setVoiceTranscript(text);
  setVoiceState('thinking');

  // Use the existing send pipeline
  if (typeof onSendMessage === 'function') {
    try {
      const reply = await onSendMessage(text, { voiceMode: true });
      if (reply) await speakWithElevenLabs(reply);
    } catch(e) {
      console.error('[Voice] Send error:', e.message);
      await speakWithBrowserTTS('Sorry, I had trouble responding. Try again.');
      if (voiceModeActive) setTimeout(() => startListening(), 500);
    }
  }
}

// ── ElevenLabs TTS ────────────────────────────────────────────
async function speakWithElevenLabs(text) {
  // Strip markdown before speaking
  const clean = text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/#{1,6}\s/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .trim();

  // Limit to 500 chars to keep latency low
  const trimmed = clean.length > 500 ? clean.slice(0, 497) + '...' : clean;

  isSpeaking = true;
  setVoiceState('speaking');

  try {
    const backend = window._voiceBackend || '';
    const res = await fetch(`${backend}/voice/speak`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${window._lunaToken || ''}`
      },
      body: JSON.stringify({ text: trimmed })
    });

    if (!res.ok) throw new Error(`TTS error ${res.status}`);

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);

    currentAudio = new Audio(url);
    currentAudio.playbackRate = 1.05; // slightly faster feels more natural

    currentAudio.onended = () => {
      URL.revokeObjectURL(url);
      currentAudio = null;
      isSpeaking   = false;
      setVoiceState('listening');
      // Auto-loop back to listening
      if (voiceModeActive) setTimeout(() => startListening(), 400);
    };

    currentAudio.onerror = () => {
      isSpeaking = false;
      if (voiceModeActive) setTimeout(() => startListening(), 500);
    };

    await currentAudio.play();

  } catch(e) {
    console.warn('[Voice] ElevenLabs failed, falling back to browser TTS:', e.message);
    await speakWithBrowserTTS(trimmed);
  }
}

// ── Browser TTS fallback ──────────────────────────────────────
function speakWithBrowserTTS(text) {
  return new Promise((resolve) => {
    isSpeaking = true;
    setVoiceState('speaking');

    const utt = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v => v.lang.startsWith('en') && v.localService)
                   || voices.find(v => v.lang.startsWith('en'))
                   || voices[0];
    if (preferred) utt.voice = preferred;
    utt.rate  = 1.05;
    utt.pitch = 1.0;

    utt.onend = utt.onerror = () => {
      isSpeaking = false;
      if (voiceModeActive) setTimeout(() => startListening(), 400);
      resolve();
    };

    window.speechSynthesis.speak(utt);
  });
}

// ── UI helpers ────────────────────────────────────────────────
function setVoiceState(state) {
  const overlay = document.getElementById('voice-overlay');
  const label   = document.getElementById('voice-state-label');
  const orb     = document.getElementById('voice-orb');

  if (!overlay) return;

  overlay.dataset.state = state;
  if (orb) orb.dataset.state = state;

  const labels = {
    idle:      'Tap to speak',
    listening: 'Listening...',
    thinking:  'Luna is thinking...',
    speaking:  'Luna is speaking...',
  };
  if (label) label.textContent = labels[state] || '';
}

function setVoiceTranscript(text) {
  const el = document.getElementById('voice-transcript');
  if (el) el.textContent = text;
}

function updateVoiceBtn(active) {
  if (!voiceBtn) return;
  voiceBtn.classList.toggle('voice-mode-active', active);
  voiceBtn.title = active ? 'Exit voice mode' : 'Voice conversation';
}

function showVoiceOverlay(show) {
  const overlay = document.getElementById('voice-overlay');
  if (!overlay) return;
  overlay.classList.toggle('open', show);
  if (!show) {
    setVoiceTranscript('');
    setVoiceState('idle');
  }
}

function checkSpeechSupport() {
  if (!('SpeechRecognition' in window) && !('webkitSpeechRecognition' in window)) {
    showToast('Voice not supported in this browser');
    return false;
  }
  return true;
}

// ── Called when chat screen becomes active/inactive ───────────
function onChatScreenActive() {
  startWakeWordDetection();
}
function onChatScreenInactive() {
  stopVoiceMode();
  stopWakeWordDetection();
}

// ── Expose globals ────────────────────────────────────────────
window.initVoiceMode       = initVoiceMode;
window.toggleVoiceMode     = toggleVoiceMode;
window.stopVoiceMode       = stopVoiceMode;
window.onChatScreenActive  = onChatScreenActive;
window.onChatScreenInactive = onChatScreenInactive;
window.speakWithElevenLabs = speakWithElevenLabs; // allow app.js to call for read-aloud too
