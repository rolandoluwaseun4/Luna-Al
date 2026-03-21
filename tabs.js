/**
 * tabs.js — Shared tab bar + auth check for all Luna pages
 * Include this on every page along with tabs.css
 */

(function() {
  const BACKEND  = 'https://luna-al-production.up.railway.app';
  const TOKEN_KEY = 'luna-token';
  const USER_KEY  = 'luna-user';

  // ── Auth check ──────────────────────────────────────────
  const token = localStorage.getItem(TOKEN_KEY);
  const user  = JSON.parse(localStorage.getItem(USER_KEY) || 'null');

  // Only redirect to login on new pages (index, create, explore, profile)
  // app.html handles its own auth internally
  const isAppPage = window.location.pathname.endsWith('app.html');
  if (!isAppPage && !token) {
    window.location.href = 'app.html';
    return;
  }

  // ── Inject tab bar ───────────────────────────────────────
  const page = window.location.pathname.split('/').pop() || 'index.html';

  const tabs = [
    {
      href: 'index.html',
      label: 'Home',
      match: ['index.html', ''],
      icon: `<svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`
    },
    {
      href: 'app.html',
      label: 'Chat',
      match: ['app.html'],
      icon: `<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`
    },
    {
      href: 'create.html',
      label: 'Create',
      match: ['create.html'],
      icon: `<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`
    },
    {
      href: 'explore.html',
      label: 'Explore',
      match: ['explore.html'],
      icon: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>`
    },
    {
      href: 'profile.html',
      label: 'Profile',
      match: ['profile.html'],
      icon: `<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`
    },
  ];

  const bar = document.createElement('nav');
  bar.className = 'tab-bar';
  bar.id = 'tab-bar';

  tabs.forEach(tab => {
    const a = document.createElement('a');
    a.className = 'tab-item' + (tab.match.includes(page) ? ' active' : '');
    a.href = tab.href;
    a.innerHTML = tab.icon + `<span>${tab.label}</span>`;
    bar.appendChild(a);
  });

  document.body.appendChild(bar);

  // ── Expose helpers ───────────────────────────────────────
  window.lunaToken    = token;
  window.lunaUser     = user;
  window.lunaBackend  = BACKEND;
  window.lunaHeaders  = () => {
    const h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  };

})();
