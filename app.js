
  // ── Sources panel CSS ─────────────────────────────────────
  (function(){
    const s = document.createElement('style');
    s.textContent = `
      .sources-panel { margin-top: 12px; }
      .sources-label { font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.3); letter-spacing: 1px; text-transform: uppercase; margin-bottom: 8px; }
      .sources-row { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; }
      .sources-row::-webkit-scrollbar { display: none; }
      .source-card {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 12px; border-radius: 12px; text-decoration: none;
        background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
        flex-shrink: 0; max-width: 180px; min-width: 120px;
        transition: background .15s;
      }
      .source-card:hover { background: rgba(255,255,255,0.08); }
      .source-favicon { width: 16px; height: 16px; border-radius: 4px; flex-shrink: 0; object-fit: contain; }
      .source-info { overflow: hidden; }
      .source-domain { font-size: 10px; color: rgba(255,255,255,0.35); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .source-title { font-size: 11px; color: rgba(255,255,255,0.7); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
    `;
    document.head.appendChild(s);
  })();

  // ── Starfield ─────────────────────────────────────────────
  (function(){
    const canvas = document.getElementById('starfield');
    const ctx = canvas.getContext('2d');
    let stars = [];
    function resize(){
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    function init(){
      resize();
      stars = [];
      const count = Math.floor((canvas.width * canvas.height) / 6000);
      for(let i = 0; i < count; i++){
        stars.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          r: Math.random() * 1.2 + 0.2,
          o: Math.random() * 0.6 + 0.1,
          speed: Math.random() * 0.3 + 0.05,
          twinkleSpeed: Math.random() * 0.02 + 0.005,
          twinkleDir: Math.random() > 0.5 ? 1 : -1
        });
      }
    }
    function draw(){
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      stars.forEach(s => {
        s.o += s.twinkleSpeed * s.twinkleDir;
        if(s.o > 0.8 || s.o < 0.05) s.twinkleDir *= -1;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${s.o})`;
        ctx.fill();
      });
      requestAnimationFrame(draw);
    }
    window.addEventListener('resize', init);
    init();
    draw();
  })();

  // ── Sidebar helpers ───────────────────────────────────────
  function showImages(){showScreen('images');loadImages();}
  function showApps(){showScreen('apps');}
  function showNewProject(){showToast('Projects coming soon!');closeDrawer();}

  function loadImages(){
    const grid = document.getElementById('images-grid');
    if(!grid) return;
    const imgs = JSON.parse(localStorage.getItem('luna-generated-images')||'[]');
    if(!imgs.length){
      grid.innerHTML='<div class="images-empty"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><p>No images generated yet</p></div>';
      return;
    }
    grid.innerHTML = imgs.map((img,i)=>`
      <div class="img-thumb" onclick="openLightbox('${img.url}')">
        <img src="${img.url}" alt="generated" loading="lazy"/>
        <div class="img-thumb-time">${img.time||''}</div>
      </div>`).join('');
  }

  function openLightbox(url){
    const lb = document.getElementById('lightbox');
    document.getElementById('lightbox-img').src = url;
    lb.classList.add('open');
  }
  function closeLightbox(){ document.getElementById('lightbox').classList.remove('open'); }
  function downloadLightboxImage(){
    const src = document.getElementById('lightbox-img').src;
    const a = document.createElement('a'); a.href=src; a.download='luna-image.png'; a.click();
  }

  function launchApp(mode){
    const prompts={
      story:'Write me a creative short story about: ',
      poem:'Write me a beautiful poem about: ',
      quiz:'Create a fun quiz about: ',
      roast:'Give me a funny friendly roast about someone who: ',
      motivate:'Give me an epic motivational speech about: '
    };
    showScreen('chat');
    setTimeout(()=>{
      const input = document.getElementById('chat-input');
      if(input){ input.value = prompts[mode]||''; input.focus(); }
    },100);
  }

  function filterThreads(query){
    const items = document.querySelectorAll('.sb-thread');
    items.forEach(item=>{
      const text = item.textContent.toLowerCase();
      item.style.display = text.includes(query.toLowerCase()) ? '' : 'none';
    });
  }

  function toggleProfileDropdown(){
    const dd = document.getElementById('profile-dropdown');
    dd.classList.toggle('open');
    event.stopPropagation();
  }
  document.addEventListener('click', ()=>{
    const dd = document.getElementById('profile-dropdown');
    if(dd) dd.classList.remove('open');
  });

  async function uploadAvatar(event){
    const file = event.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = e.target.result;
      // Update avatar immediately in UI
      const avEl = document.getElementById('sb-avatar');
      if(avEl){ avEl.innerHTML = `<img src="${base64}" alt="avatar"/>`; }
      // Save to backend if logged in
      if(authToken){
        try{
          await fetch(BACKEND_URL+'/upload-avatar',{
            method:'POST',
            headers:{...getAuthHeaders(),'Content-Type':'application/json'},
            body:JSON.stringify({avatar:base64})
          });
        }catch(e){}
      }
      localStorage.setItem('luna-avatar', base64);
      showToast('Photo updated!');
    };
    reader.readAsDataURL(file);
    document.getElementById('profile-dropdown').classList.remove('open');
  }

  // Load saved avatar
  function loadAvatarFromStorage(){
    const saved = localStorage.getItem('luna-avatar');
    const avEl = document.getElementById('sb-avatar');
    if(saved && avEl){ avEl.innerHTML = `<img src="${saved}" alt="avatar"/>`; }
  }

  // Save generated images to localStorage for Images page
  function saveGeneratedImage(url){
    const imgs = JSON.parse(localStorage.getItem('luna-generated-images')||'[]');
    imgs.unshift({url, time: new Date().toLocaleDateString()});
    if(imgs.length > 50) imgs.pop();
    localStorage.setItem('luna-generated-images', JSON.stringify(imgs));
  }

  // Sidebar thread list
  function populateSidebarThreads(threads){
    const list = document.getElementById('sb-history-list');
    if(!list) return;
    // Only show threads that have a real title (not empty/New Chat)
    const validThreads = (threads||[]).filter(t => t.title && t.title !== 'New Chat' && t.title.trim() !== '');
    if(!validThreads.length){
      list.innerHTML = '<div class="sb-empty-hist" id="sb-empty">No conversations yet</div>';
      return;
    }
    list.innerHTML = validThreads.map(t=>`
      <div class="sb-thread ${t.threadId===currentThreadId?'active-thread':''}" onclick="openThread('${t.threadId}','${(t.title||'Chat').replace(/'/g,"\\'")}')">
        <span class="sb-thread-title">${t.title||'Conversation'}</span>
        <span class="sb-thread-del" onclick="deleteThread(event,'${t.threadId}')" title="Delete">×</span>
      </div>`).join('');
  }

  const BACKEND_URL='https://luna-al-production.up.railway.app';
  let isOwner=false,busy=false,selectedImageBase64=null,selectedVideoBase64=null,selectedFileData=null,lastGeneratedImageUrl=null;
  let authToken=localStorage.getItem('luna-token');
  let currentUser=JSON.parse(localStorage.getItem('luna-user')||'null');

  function getAuthHeaders(){
    const headers = {'Content-Type':'application/json'};
    if(authToken) headers['Authorization'] = 'Bearer '+authToken;
    return headers;
  }
  function getUserId(){return currentUser?.id||'guest_unknown';}


  // ── Google OAuth ──────────────────────────────────────────
  function signInWithGoogle(){
    window.location.href = BACKEND_URL + '/auth/google';
  }

  // Handle redirect back from Google OAuth
  // NOTE: runs after enterApp is defined
  function handleOAuthRedirect(){
    const hash = window.location.hash.slice(1); // remove the #
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const token = params.get('token');
    const userParam = params.get('user');
    const authError = params.get('auth_error');
    if (authError) {
      const errEl = document.getElementById('login-error');
      if (errEl) errEl.textContent = 'Google sign-in failed. Please try again.';
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }
    if (token && userParam) {
      try {
        const user = JSON.parse(decodeURIComponent(userParam));
        authToken = token;
        currentUser = user;
        isOwner = user.role === 'owner';
        localStorage.setItem('luna-token', token);
        localStorage.setItem('luna-user', JSON.stringify(user));
        window.history.replaceState({}, '', window.location.pathname);
        tryEnterApp(isOwner);
      } catch(e) {
        console.error('OAuth redirect error:', e);
      }
    }
  }

  // ── Tab switching ──────────────────────────────────────────
  function switchTab(tab){
    document.getElementById('login-form').style.display=tab==='login'?'':'none';
    document.getElementById('register-form').style.display=tab==='register'?'':'none';
    document.querySelectorAll('.auth-tab')[0].classList.toggle('active',tab==='login');
    document.querySelectorAll('.auth-tab')[1].classList.toggle('active',tab==='register');
    document.getElementById('login-error').textContent='';
    document.getElementById('reg-error').textContent='';
  }

  // ── Login ──────────────────────────────────────────────────
  async function submitLogin(){
    const email=document.getElementById('login-email').value.trim();
    const password=document.getElementById('login-password').value;
    const errEl=document.getElementById('login-error');
    const btn=document.querySelector('.auth-btn');
    if(!email||!password){errEl.textContent='Please fill in all fields.';return;}
    btn.textContent='Signing in...';btn.disabled=true;
    try{
      const res=await fetch(BACKEND_URL+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
      const data=await res.json();
      if(!res.ok){errEl.textContent=data.error||'Login failed.';btn.textContent='Sign In';btn.disabled=false;return;}
      authToken=data.token;currentUser=data.user;
      localStorage.setItem('luna-token',authToken);
      localStorage.setItem('luna-user',JSON.stringify(currentUser));
      const owner=currentUser.role==='owner';
      isOwner=owner;
      tryEnterApp(owner);
    }catch(e){errEl.textContent='Could not connect. Try again.';btn.textContent='Sign In';btn.disabled=false;}
  }

  // ── Register ───────────────────────────────────────────────
  async function submitRegister(){
    const username=document.getElementById('reg-username').value.trim();
    const email=document.getElementById('reg-email').value.trim();
    const password=document.getElementById('reg-password').value;
    const errEl=document.getElementById('reg-error');
    const btn=document.getElementById('reg-submit-btn');
    if(!username||!email||!password){errEl.textContent='Please fill in all fields.';return;}
    btn.textContent='Creating account...';btn.disabled=true;
    try{
      const res=await fetch(BACKEND_URL+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,email,password})});
      const data=await res.json();
      if(!res.ok){errEl.textContent=data.error||'Registration failed.';btn.textContent='Create Account';btn.disabled=false;return;}
      authToken=data.token;currentUser=data.user;
      localStorage.setItem('luna-token',authToken);
      localStorage.setItem('luna-user',JSON.stringify(currentUser));
      isOwner=currentUser.role==='owner';
      tryEnterApp(isOwner);
    }catch(e){errEl.textContent='Could not connect. Try again.';btn.textContent='Create Account';btn.disabled=false;}
  }

  // ── Guest ──────────────────────────────────────────────────
  async function continueAsGuest(){
    let guestId=localStorage.getItem('luna-guest-id');
    if(!guestId){guestId='guest_'+Math.random().toString(36).substring(2)+Date.now().toString(36);localStorage.setItem('luna-guest-id',guestId);}
    try{
      const res=await fetch(BACKEND_URL+'/auth/guest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guestId})});
      const data=await res.json();
      if(data.token){authToken=data.token;currentUser=data.user;localStorage.setItem('luna-token',authToken);localStorage.setItem('luna-user',JSON.stringify(currentUser));}
    }catch(e){}
    isOwner=false;tryEnterApp(false);
  }
  const homeInput=document.getElementById('home-input');
  const homeSend=document.getElementById('home-send');
  const chatInput=document.getElementById('chat-input');
  const chatSend=document.getElementById('chat-send');
  const messagesEl=document.getElementById('messages');
  const typingRow=document.getElementById('typing-row');
  function tryLogin(){
    const pwEl=document.getElementById('pw-input');
    const pw=pwEl?pwEl.value:'';
    const errEl=document.getElementById('login-error');
    submitLogin(document.getElementById('login-email')?.value, pw);
  }
  // Splash: auto-dismiss after 2 rotations (3s), then enterApp when auth also ready
  let splashDone = false, authDone = false, pendingOwner = null;
  function dismissSplash(){
    const splash = document.getElementById('splash');
    if(splash){ splash.classList.add('hide'); setTimeout(()=>splash.remove(), 650); }
  }
  function tryEnterApp(owner){
    authDone = true; pendingOwner = owner;
    if(splashDone) _doEnterApp(owner);
  }
  setTimeout(()=>{
    splashDone = true;
    if(authDone) _doEnterApp(pendingOwner);
    else dismissSplash();
  }, 1500);

  function _doEnterApp(owner){
    const splash = document.getElementById('splash');
    if(splash){ splash.classList.add('hide'); }
    // Quick dark flash between splash and Luna page
    const flash = document.createElement('div');
    flash.style.cssText = 'position:fixed;inset:0;background:#000;z-index:9998;opacity:1;pointer-events:none;transition:opacity 0.2s ease;';
    document.body.appendChild(flash);
    setTimeout(()=>{
      if(splash) splash.remove();
      enterApp(owner);
      requestAnimationFrame(()=>{ flash.style.opacity='0'; setTimeout(()=>flash.remove(), 220); });
    }, 300);
  }

  function enterApp(owner){
    // Hide auth, show app
    document.getElementById('auth-screen').style.display='none';
    document.getElementById('main-navbar').style.display='flex';
    document.getElementById('app-body').style.display='flex';
    document.getElementById('main-content').style.display='flex';
    // Owner dot
    if(owner){const dot=document.getElementById('owner-dot');if(dot)dot.style.display='block';}
    // Sidebar profile name
    const name=currentUser?.displayName||currentUser?.username||'Guest';
    const nameEl=document.getElementById('sb-profile-name');
    if(nameEl) nameEl.textContent = owner ? 'Roland' : name;
    // Home greeting: "Hello Roland, I'm Luna."
    const displayName = owner ? 'Roland' : (currentUser?.displayName||currentUser?.username||'');
    const homeUser = document.getElementById('home-username-display');
    if (homeUser) homeUser.textContent = displayName ? ' ' + displayName : '';
    // Account info in settings
    const accName=document.getElementById('account-name');
    const accDesc=document.getElementById('account-desc');
    if(accName)accName.textContent=currentUser?.displayName||currentUser?.username||'Guest';
    if(accDesc)accDesc.textContent=owner?'Signed in as owner':currentUser?.role==='guest'?'Browsing as guest':'Signed in';
    // Load avatar + threads + model selector
    loadAvatarFromStorage();
    if(authToken && currentUser && currentUser.role!=='guest') loadSidebarThreads();
    initModelSelector();
    showScreen('home');
    // Show onboarding for first-time users
    const onboardKey = 'luna-onboarded-' + (currentUser?.id || 'guest');
    if (!localStorage.getItem(onboardKey)) {
      localStorage.setItem(onboardKey, '1');
      setTimeout(() => showOnboarding(), 600);
    }
    // Check if opened via shared chat link
    setTimeout(() => checkSharedThread(), 300);
  }
  function logout(){localStorage.removeItem('luna-token');localStorage.removeItem('luna-user');authToken=null;currentUser=null;isOwner=false;location.reload();}
  function toggleEye(id){const inp=document.getElementById(id);if(inp)inp.type=inp.type==='password'?'text':'password';}
  document.getElementById('login-password')?.addEventListener('keydown',e=>{if(e.key==='Enter')submitLogin();});
  document.getElementById('reg-password')?.addEventListener('keydown',e=>{if(e.key==='Enter')submitRegister();});
  // showScreen defined below
  function timeAgo(dateStr){
    const diff=Date.now()-new Date(dateStr).getTime();
    const m=Math.floor(diff/60000),h=Math.floor(diff/3600000),d=Math.floor(diff/86400000);
    if(m<1)return'Just now';if(m<60)return m+'m ago';if(h<24)return h+'h ago';
    if(d===1)return'Yesterday';if(d<7)return d+'d ago';
    return new Date(dateStr).toLocaleDateString([],{month:'short',day:'numeric'});
  }
  function openHistoryDetail(group){
    showScreen('history-detail');
    document.getElementById('history-detail-title').textContent=group.date;
    const msgsEl=document.getElementById('history-detail-msgs');
    msgsEl.innerHTML=group.messages.map(m=>`
      <div class="history-dmsg ${m.role==='assistant'?'luna':'user'}">
        ${renderMarkdown(m.text)}
        <div class="history-dmsg-time">${new Date(m.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>
      </div>`).join('');
    msgsEl.scrollTop=msgsEl.scrollHeight;
  }
  function closeHistoryDetail(){
    showScreen('history');
  }
  function goHome(){showScreen('home');}
  function goSettings(){const tog=document.getElementById('dark-toggle');if(tog)tog.checked=document.documentElement.getAttribute('data-theme')==='dark';showScreen('settings');loadProfile();loadMemories();loadNotifState();}
  function goSaved(){showScreen('saved');}
  async function clearChat(){
    if(!confirm('Clear all messages? This cannot be undone.'))return;
    Array.from(messagesEl.children).forEach(c=>{if(c.id!=='typing-row')c.remove();});
    homeInput.value='';homeSend.disabled=true;clearImage();
    try{if(currentThreadId){await fetch(BACKEND_URL+'/threads/'+getUserId()+'/'+currentThreadId,{method:'DELETE',headers:getAuthHeaders()});currentThreadId=null;}}catch(e){}
    goHome();
  }
  let currentThreadId = null;
  let activeThreadMessages = [];

  async function goHistory(){
    showScreen('history');
    const contentEl=document.getElementById('history-content');
    contentEl.innerHTML='<div style="padding:20px;color:var(--text-dim);font-size:14px;">Loading...</div>';
    try{
      const res=await fetch(BACKEND_URL+'/threads/'+getUserId(),{headers:getAuthHeaders()});
      const data=await res.json();
      const threads=data.threads||[];
      window.allThreads=threads;
      populateSidebarThreads(threads);
      if(!threads.length){
        contentEl.innerHTML='<div class="history-empty"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><p>No conversations yet</p></div>';
        return;
      }
      contentEl.innerHTML = threads.map(t=>`
        <div class="history-thread" onclick="openThread('${t.threadId||t._id}','${(t.title||'Chat').replace(/'/g,"\'")}')">
          <div class="history-thread-icon"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
          <div class="history-thread-info">
            <div class="history-thread-title">${(t.title||'Chat').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>
            <div class="history-thread-time">${timeAgo(t.lastUpdated)}</div>
          </div>
          <button class="history-thread-del" onclick="deleteThread(event,'${t.threadId||t._id}')"><svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
        </div>`).join('');
    }catch(e){
      contentEl.innerHTML='<div class="history-empty"><p>Could not load history</p></div>';
    }
  }

  function renderThreadList(threads){
    // Delegates to new unified renderer
    const contentEl=document.getElementById('history-content');
    if(!threads||!threads.length){
      contentEl.innerHTML='<div class="history-empty"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><p>No conversations yet</p></div>';
      return;
    }
    contentEl.innerHTML = threads.map(t=>`
      <div class="history-thread" onclick="openThread('${t.threadId||t._id}','${(t.title||'Chat').replace(/'/g,"\'")}')">
        <div class="history-thread-icon"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
        <div class="history-thread-info">
          <div class="history-thread-title">${(t.title||'Chat').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>
          <div class="history-thread-time">${timeAgo(t.lastUpdated)}</div>
        </div>
        <button class="history-thread-del" onclick="deleteThread(event,'${t.threadId||t._id}')"><svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
      </div>`).join('');
    populateSidebarThreads(threads);
  }

  async function openThread(threadId, title){
    // Clear chat and go straight to chat screen
    Array.from(messagesEl.children).forEach(c=>{if(c.id!=='typing-row')c.remove();});
    currentThreadId = threadId;
    closeDrawer();
    showScreen('chat');

    // Show loading spinner in chat
    const loadingEl = document.createElement('div');
    loadingEl.id = 'thread-loading';
    loadingEl.style.cssText = 'display:flex;align-items:center;justify-content:center;padding:60px;';
    loadingEl.innerHTML = `<div class="typing-bubble" style="width:40px;height:40px;">
      <div class="typing-ring-orbit"><div class="typing-ring-el"></div></div>
      <div class="typing-ring-orbit"><div class="typing-ring-el"></div></div>
      <div class="typing-ring-orbit"><div class="typing-ring-el"></div></div>
    </div>`;
    messagesEl.appendChild(loadingEl);

    try{
      const res = await fetch(BACKEND_URL+'/threads/'+getUserId()+'/'+threadId, {headers:getAuthHeaders()});
      const data = await res.json();
      const messages = data.messages || [];

      // Remove loader
      document.getElementById('thread-loading')?.remove();

      // Render only this thread's messages
      messages.forEach(m => {
        addMsg(m.role==='assistant'?'luna':'user', m.text, null, true);
      });

      setTimeout(()=>scrollToBottom(), 100);
    }catch(e){
      document.getElementById('thread-loading')?.remove();
      addMsg('luna', 'Could not load this conversation.', null, true);
    }
  }

  function continueThread(){ /* replaced by openThread */ }

  async function deleteThread(e, threadId){
    e.stopPropagation();
    if(!confirm('Delete this conversation?'))return;
    try{
      await fetch(BACKEND_URL+'/threads/'+getUserId()+'/'+threadId,{method:'DELETE',headers:getAuthHeaders()});
      window.allThreads=window.allThreads.filter(t=>t.threadId!==threadId);
      renderThreadList(window.allThreads);
      if(!window.allThreads.length){
        document.getElementById('history-content').innerHTML='<div class="history-empty"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><p>No conversations yet.</p></div>';
      }
    }catch(e){alert('Could not delete. Try again.');}
  }
  async function newChat(){
    // Clear chat screen
    Array.from(messagesEl.children).forEach(c=>{if(c.id!=='typing-row')c.remove();});
    homeInput.value=''; homeSend.disabled=true; clearImage();
    // Reset thread — backend creates a new one on first message
    currentThreadId = null;
    lastGeneratedImageUrl = null;
    document.title = 'Luna';
    goHome();
  }
  function isDesktop(){ return window.innerWidth >= 768; }
  function toggleDrawer(){
    if(isDesktop()) return; // sidebar always visible on desktop
    document.getElementById('drawer').classList.toggle('open');
    document.getElementById('hamburger').classList.toggle('open');
  }
  function closeDrawer(){
    if(isDesktop()) return; // never close on desktop
    document.getElementById('drawer').classList.remove('open');
    document.getElementById('hamburger').classList.remove('open');
  }
  function applyTheme(dark){ /* dark mode only */ }
  document.documentElement.setAttribute('data-theme','dark');
  function previewImage(event){
    const file=event.target.files[0];if(!file)return;
    const reader=new FileReader();
    reader.onload=(e)=>{selectedImageBase64=e.target.result;document.getElementById('preview-thumb').src=selectedImageBase64;document.getElementById('img-preview-bar').style.display='flex';chatSend.disabled=false;};
    reader.readAsDataURL(file);
  }
  function clearImage(){selectedImageBase64=null;document.getElementById('img-upload').value='';document.getElementById('img-preview-bar').style.display='none';}
  homeInput.addEventListener('input',()=>{homeSend.disabled=!homeInput.value.trim();});
  // Enter creates new line — send only via button
  homeSend.addEventListener('click',()=>{if(homeInput.value.trim())startChat(homeInput.value.trim());});
  messagesEl.addEventListener('scroll',()=>{
    const btn=document.getElementById('scroll-btn');
    const nearBottom=messagesEl.scrollHeight-messagesEl.scrollTop-messagesEl.clientHeight<120;
    btn.classList.toggle('show',!nearBottom);
  });
  chatInput.addEventListener('input',()=>{
    chatInput.style.height='auto';
    chatInput.style.height=Math.min(chatInput.scrollHeight,90)+'px';
    const hasText=!!chatInput.value.trim()||!!selectedImageBase64||!!selectedVideoBase64;
    chatSend.disabled=!hasText||busy;
    // swap mic ↔ send
    const micBtn=document.getElementById('mic-btn');
    if(micBtn){ micBtn.style.display=hasText?'none':'flex'; }
    chatSend.style.display=hasText?'flex':'none';
  });
  // Enter creates new line (textarea default) — send only via button
  chatSend.addEventListener('click',send);

  /* ── Voice: Speech-to-Text (mic button) ── */
  (function initSTT(){
    const micBtn = document.getElementById('mic-btn');
    if(!micBtn) return;
    const SpeechRecog = window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!SpeechRecog){
      micBtn.title = 'Voice input not supported in this browser';
      micBtn.style.opacity = '0.35';
      return;
    }
    let recog = null;
    let listening = false;
    micBtn.addEventListener('click', ()=>{
      if(listening){
        recog && recog.stop();
        return;
      }
      recog = new SpeechRecog();
      recog.continuous = false;
      recog.interimResults = true;
      recog.lang = 'en-US';
      let finalTranscript = '';
      recog.onstart = ()=>{
        listening = true;
        micBtn.classList.add('mic-listening');
        micBtn.title = 'Listening… tap to stop';
      };
      recog.onresult = (e)=>{
        finalTranscript = '';
        let interim = '';
        for(let i = e.resultIndex; i < e.results.length; i++){
          if(e.results[i].isFinal) finalTranscript += e.results[i][0].transcript;
          else interim += e.results[i][0].transcript;
        }
        chatInput.value = finalTranscript || interim;
        chatInput.dispatchEvent(new Event('input'));
      };
      recog.onerror = ()=>{ recog.stop(); };
      recog.onend = ()=>{
        listening = false;
        micBtn.classList.remove('mic-listening');
        micBtn.title = 'Voice input';
        if(finalTranscript.trim()){
          chatInput.value = finalTranscript.trim();
          chatInput.dispatchEvent(new Event('input'));
        }
      };
      recog.start();
    });
  })();

  function startChat(text){
    if(!text||!text.trim()) return;
    // Clear previous messages and reset thread so context doesn't leak from old chats
    Array.from(messagesEl.children).forEach(c=>{if(c.id!=='typing-row')c.remove();});
    currentThreadId = null; // force new thread for this conversation
    lastGeneratedImageUrl = null; // reset image edit context too
    showScreen('chat');
    addMsg('user', text.trim());
    fetchReply(text.trim(), null);
  }
  function ts(){return new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}
  function renderMarkdown(text) {
    // Escape HTML first
    let t = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // Code blocks (before anything else)
    t = t.replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

    // Headers
    t = t.replace(/^### (.+)$/gm,'<h3>$1</h3>');
    t = t.replace(/^## (.+)$/gm,'<h2>$1</h2>');
    t = t.replace(/^# (.+)$/gm,'<h1>$1</h1>');

    // Bold and italic
    t = t.replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>');
    t = t.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
    t = t.replace(/\*(.+?)\*/g,'<em>$1</em>');

    // Inline code
    t = t.replace(/`([^`]+)`/g,'<code>$1</code>');

    // Blockquote
    t = t.replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>');

    // Numbered lists — group consecutive items
    t = t.replace(/^(\d+\. .+)(\n\d+\. .+)*/gm, (match) => {
      const items = match.split('\n').map(l => '<li>'+l.replace(/^\d+\. /,'')+'</li>').join('');
      return '<ol>'+items+'</ol>';
    });

    // Bullet lists — group consecutive items
    t = t.replace(/^([-*•] .+)(\n[-*•] .+)*/gm, (match) => {
      const items = match.split('\n').map(l => '<li>'+l.replace(/^[-*•] /,'')+'</li>').join('');
      return '<ul>'+items+'</ul>';
    });

    // Paragraphs — split by double newline
    t = t.split('\n\n').map(block => {
      block = block.trim();
      if (!block) return '';
      // Don't wrap already-block elements
      if (/^<(h[1-3]|ul|ol|pre|blockquote)/.test(block)) return block;
      return '<p>' + block.replace(/\n/g,'<br>') + '</p>';
    }).join('');

    return t;
  }

  // Render KaTeX math in an element after content is set
  function renderMath(el) {
    if (!el || typeof renderMathInElement === 'undefined') return;
    try {
      renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
        ],
        throwOnError: false,
        output: 'html',
      });
    } catch(e) {}
  }

  function addMsg(role,text,imgUrl){
    const row=document.createElement('div');row.className='mrow '+role;
    const esc=text?renderMarkdown(text):'';
    const av=role==='luna'?'<div class="msg-avatar luna-av"><img src="icon-192.png" alt="L"/></div>':'<div class="msg-avatar user-av">'+(isOwner?'R':'G')+'</div>';
    const img=imgUrl?'<a href="'+imgUrl+'" download="luna-image.png"><img class="gen-image" src="'+imgUrl+'" alt="image"/></a><div style="font-size:11px;color:var(--text-dim);margin-top:4px;">Tap to download</div>':'';
    const copyBtn=role==='luna'&&text?'<button class="copy-btn" onclick="copyMsg(this,\''+encodeURIComponent(text)+'\')"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy</button>':'';
    const lunaLabel=role==='luna'?'<span class="luna-msg-label">Luna</span>':'';
    row.innerHTML=av+'<div class="mbody">'+lunaLabel+(esc?'<div class="bubble">'+esc+'</div>':'')+img+copyBtn+'<div class="mtime">'+ts()+'</div></div>';
    messagesEl.insertBefore(row,typingRow);messagesEl.scrollTop=messagesEl.scrollHeight;
    if(imgUrl && role==='luna') saveGeneratedImage(imgUrl);
  }
  function copyMsg(btn,encoded){
    const text=decodeURIComponent(encoded);
    navigator.clipboard.writeText(text).then(()=>{
      btn.innerHTML='<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>Copied!';
      btn.classList.add('copied');
      setTimeout(()=>{btn.innerHTML='<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy';btn.classList.remove('copied');},2000);
    }).catch(()=>{});
  }
  function send(){
    const text=chatInput.value.trim();const imgToSend=selectedImageBase64;
    if((!text&&!imgToSend&&!selectedVideoBase64)||busy)return;
    chatInput.value='';chatInput.style.height='auto';chatSend.disabled=true;
    chatSend.style.display='none';
    const _m=document.getElementById('mic-btn');if(_m)_m.style.display='flex';
    clearImage();clearVideo();
    const row=document.createElement('div');row.className='mrow user';
    const av='<div class="msg-avatar user-av">'+(isOwner?'R':'G')+'</div>';
    const imgHtml=imgToSend?'<img src="'+imgToSend+'" style="max-width:200px;border-radius:10px;margin-bottom:4px;"/>'  :'';
    const textHtml=text?'<div class="bubble">'+renderMarkdown(text)+'</div>':'';
    row.innerHTML=av+'<div class="mbody">'+imgHtml+textHtml+'<div class="mtime">'+ts()+'</div></div>';
    messagesEl.insertBefore(row,typingRow);messagesEl.scrollTop=messagesEl.scrollHeight;
    fetchReply(text,imgToSend);
  }
  async function fetchReply(text,image,_x,toolSystemExtra,isSecret){
    let toolSuffix = '';
    if (activeTool === 'pdf' && pdfText && !toolSystemExtra) {
      toolSuffix = '\n\n[PDF CONTENT]:\n' + pdfText;
    }
    if (toolSuffix) text = text + toolSuffix;
    // Inject deep think / research tags so backend routes to Gemini
    const inp = document.getElementById('chat-input') || document.querySelector('textarea');
    if (inp && inp.dataset.deepThink) {
      text = '[deep think] ' + (text || '');
      delete inp.dataset.deepThink;
      inp.placeholder = 'Message Luna...';
      document.getElementById('plus-btn').style.color = '';
    }
    if (inp && inp.dataset.research) {
      text = '[luna research] ' + (text || '');
      delete inp.dataset.research;
      inp.placeholder = 'Message Luna...';
      document.getElementById('plus-btn').style.color = '';
    }
    busy=true;chatSend.disabled=true;typingRow.style.display='flex';messagesEl.scrollTop=messagesEl.scrollHeight;

    const deepTriggers = ['research','explain','compare','analyse','analyze','difference between','how does','why does','what causes','history of','deep dive','in detail','thoroughly','comprehensive','summarize','pros and cons','advantages','disadvantages','versus','vs '];
    const needsDeep = text && deepTriggers.some(t => text.toLowerCase().includes(t));
    if (needsDeep) {
      typingRow.classList.add('thinking-row');
      document.getElementById('thinking-label').style.display = 'block';
    } else {
      typingRow.classList.remove('thinking-row');
      document.getElementById('thinking-label').style.display = 'none';
    }

    // ── Tweet command (owner only) ──────────────────────────────
    if (text && text.toLowerCase().startsWith('tweet this:')) {
      const tweetText = text.slice(11).trim();
      try {
        const r = await fetch(BACKEND_URL+'/tweet', {method:'POST', headers:getAuthHeaders(), body:JSON.stringify({text:tweetText})});
        const d = await r.json();
        typingRow.style.display='none';
        if (d.success) addMsg('luna', '✅ Tweet posted successfully! 🐦\n\n"' + tweetText + '"');
        else addMsg('luna', '❌ Tweet failed: ' + (d.error || 'Unknown error'));
      } catch(e) {
        typingRow.style.display='none';
        addMsg('luna', '❌ Could not post tweet. Check your Twitter credentials on Railway.');
      }
      finally{busy=false;chatSend.disabled=!chatInput.value.trim()&&!selectedImageBase64&&!selectedVideoBase64;}
      return;
    }

    // Image generation is now fully handled by Luna's intelligence — no trigger phrases needed.
    // Luna signals image intent via the SSE done event: { generateImage: true, prompt, editLastImage }

    // ── Real-time streaming chat ───────────────────────────────
    if (manusMode && text) startManusStatusAnimation(text);
    try{
      const res=await fetch(BACKEND_URL+'/chat',{method:'POST',headers:getAuthHeaders(),body:JSON.stringify({message:text||(selectedVideoBase64?'What is in this video?':'What is in this image?'),userId:getUserId(),image:image||null,video:selectedVideoBase64||null,file:selectedFileData||null,modeExtra:toolSystemExtra||null,threadId:isSecret?null:currentThreadId,model:selectedModel,mode:manusMode?'manus':null})});
      if(!res.ok)throw new Error();

      // Hide typing indicator — first chunk arrives immediately
      typingRow.style.display='none';typingRow.classList.remove('thinking-row');document.getElementById('thinking-label').style.display='none';stopManusStatusAnimation();

      // Create message row right away
      const row=document.createElement('div');row.className='mrow luna';
      row.innerHTML='<div class="msg-avatar luna-av"><img src="icon-192.png" alt="L"/></div><div class="mbody"><span class="luna-msg-label">Luna</span><div class="bubble"><span class="typing-cursor"></span></div><div class="mtime" style="display:none">'+ts()+'</div></div>';
      messagesEl.insertBefore(row,typingRow);
      const bubbleEl=row.querySelector('.bubble');

      let fullText='';
      let thinkText='';
      let thinkEl=null;
      let streamStopped=false;

      // Turn send button into stop button
      chatSend.classList.add('stop-mode');
      chatSend.disabled=false;
      chatSend.innerHTML='<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" fill="#fff" stroke="none"/></svg>';
      chatSend.onclick=function(){ streamStopped=true; finalizeMessage(fullText, undefined, []); };

      function finalizeMessage(text, doc, sources){
        chatSend.classList.remove('stop-mode');
        chatSend.innerHTML='<svg viewBox="0 0 24 24"><path d="M22 2L11 13"/><path d="M22 2L15 22 11 13 2 9l20-7z"/></svg>';
        chatSend.onclick=null;
        chatSend.disabled=!chatInput.value.trim()&&!selectedImageBase64&&!selectedVideoBase64;
        stopManusStatusAnimation();
        lastLunaText=text;
        const artifactInfo=detectArtifact(text);
        // Rebuild bubble cleanly — think block stays collapsed at top, reply below
        bubbleEl.innerHTML='';
        if(thinkEl && thinkText){
          const wrap=document.createElement('div');
          wrap.className='luna-think-wrap';
          const toggle=document.createElement('button');
          toggle.className='luna-think-toggle';
          toggle.innerHTML='Thought for a moment <span class="luna-think-arrow">›</span>';
          const thinkContent=document.createElement('div');
          thinkContent.className='luna-think-content';
          thinkContent.textContent=thinkText;
          toggle.onclick=function(){
            toggle.classList.toggle('open');
            thinkContent.classList.toggle('open');
          };
          wrap.appendChild(toggle);
          wrap.appendChild(thinkContent);
          bubbleEl.appendChild(wrap);
        }
        const replyDiv=document.createElement('div');
        replyDiv.className='luna-reply-text';
        if(artifactInfo){
          const shortText=text.replace(/```[\s\S]*?```/g,'').trim().substring(0,200);
          replyDiv.innerHTML=(shortText?renderMarkdown(shortText)+'<br><br>':'')+buildArtifactCard(text,artifactInfo);
        } else {
          replyDiv.innerHTML=renderMarkdown(text);
          renderMath(replyDiv);
        }
        bubbleEl.appendChild(replyDiv);
        // ── Document download button (agent created a file) ───
        if(doc && doc.base64 && doc.filename){
          const dlBtn=document.createElement('a');
          dlBtn.className='agent-dl-btn';
          dlBtn.innerHTML='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download '+doc.filename;
          dlBtn.href='data:'+doc.mimeType+';base64,'+doc.base64;
          dlBtn.download=doc.filename;
          bubbleEl.appendChild(dlBtn);
        }
        const mbody=row.querySelector('.mbody');
        const enc=encodeURIComponent(text);
        const actions=document.createElement('div');
        actions.className='msg-actions';
        actions.innerHTML='<button class="mac" title="Copy" onclick="copyMac(this,\''+enc+'\')"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>'
          +'<button class="mac" title="Read aloud" onclick="readAloud(\''+enc+'\',this)"><svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg></button>'
          +'<button class="mac" title="Good response" onclick="likeMac(this,\''+enc+'\')"><svg viewBox="0 0 24 24"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg></button>'
          +'<button class="mac" title="Bad response" onclick="dislikeMac(this,\''+enc+'\')"><svg viewBox="0 0 24 24"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg></button>'
          +'<button class="mac" title="Regenerate" onclick="regenMac(this)"><svg viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.95"/></svg></button>';
        mbody.insertBefore(actions,mbody.querySelector('.mtime'));
        // ── Sources panel (Pro/RO-1 only) ────────────────────
        if(sources && sources.length){
          const panel = document.createElement('div');
          panel.className = 'sources-panel';
          panel.innerHTML = '<div class="sources-label">Sources</div><div class="sources-row">'
            + sources.map(s=>`<a class="source-card" href="${s.url}" target="_blank" rel="noopener">
                <img class="source-favicon" src="${s.favicon}" onerror="this.style.display='none'" alt=""/>
                <div class="source-info">
                  <div class="source-domain">${s.domain}</div>
                  <div class="source-title">${s.title}</div>
                </div></a>`).join('')
            + '</div>';
          mbody.insertBefore(panel, mbody.querySelector('.mtime'));
        }
        const mtimeEl=mbody.querySelector('.mtime');if(mtimeEl)mtimeEl.style.display='';
        messagesEl.scrollTop=messagesEl.scrollHeight;
      }

      // Read SSE stream chunk by chunk
      const reader=res.body.getReader();
      const decoder=new TextDecoder();
      let buffer='';
      while(true){
        const {done,value}=await reader.read();
        if(done) break;
        buffer+=decoder.decode(value,{stream:true});
        const lines=buffer.split('\n');
        buffer=lines.pop()||'';
        for(const line of lines){
          if(!line.startsWith('data:')) continue;
          try{
            const json=JSON.parse(line.slice(5).trim());
            if(json.error){ addMsg('luna',json.error||'Something went wrong.'); break; }
            // Handle think signal — build collapsible, collapsed by default
            if(json.think && !streamStopped){
              thinkText=json.think;
              bubbleEl.innerHTML='';
              const wrap=document.createElement('div');
              wrap.className='luna-think-wrap';
              const toggle=document.createElement('button');
              toggle.className='luna-think-toggle';
              toggle.innerHTML='Thought for a moment <span class="luna-think-arrow">›</span>';
              const thinkContent=document.createElement('div');
              thinkContent.className='luna-think-content';
              thinkContent.textContent=thinkText;
              toggle.onclick=function(){
                toggle.classList.toggle('open');
                thinkContent.classList.toggle('open');
              };
              wrap.appendChild(toggle);
              wrap.appendChild(thinkContent);
              bubbleEl.appendChild(wrap);
              thinkEl={wrap,toggle,thinkContent};
            }
            // Handle reply text — stream below the think block
            if(json.delta && !streamStopped){
              fullText+=json.delta;
              if(thinkEl){
                let replyDiv=bubbleEl.querySelector('.luna-reply-text');
                if(!replyDiv){
                  replyDiv=document.createElement('div');
                  replyDiv.className='luna-reply-text';
                  bubbleEl.appendChild(replyDiv);
                }
                replyDiv.innerHTML=renderMarkdown(fullText)+'<span class="typing-cursor"></span>';
                renderMath(replyDiv);
              } else {
                bubbleEl.innerHTML=renderMarkdown(fullText)+'<span class="typing-cursor"></span>';
              }
            }
            // ── Agent step indicator ─────────────────────────────
            if(json.agentStep && !streamStopped){
              const step = json.agentStep;
              const toolLabels = {
                web_search: 'Searching the web',
                read_url: 'Reading page',
                run_code: 'Running code',
                create_document: 'Creating document',
              };
              if(step.type === 'tool'){
                const label = toolLabels[step.tool] || ('Using ' + step.tool);
                setManusStatus(label);
                bubbleEl.innerHTML = '<span style="color:var(--text-dim);font-size:13px;">' + label + '...</span>';
              } else if(step.type === 'result'){
                const label = toolLabels[step.tool] || step.tool;
                setManusStatus('processing result');
                bubbleEl.innerHTML = '<span style="color:var(--text-dim);font-size:13px;">' + label + ' done, processing...</span>';
              } else if(step.type === 'thinking'){
                setManusStatus('thinking');
                bubbleEl.innerHTML = '<span style="color:var(--text-dim);font-size:13px;">Thinking...</span>';
              }
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
            if(json.done){
              if(json.threadId){ currentThreadId=json.threadId; loadSidebarThreads(); }
              // ── Luna signalled image generation ──────────────────
              if(json.generateImage && json.prompt){
                typingRow.style.display='none';
                const genRow = document.createElement('div'); genRow.className='mrow luna';
                genRow.innerHTML='<div class="msg-avatar luna-av"><img src="icon-192.png" alt="L"/></div><div class="mbody"><span class="luna-msg-label">Luna</span><div class="bubble" style="color:var(--text-dim);font-size:14px;">Generating image...</div></div>';
                messagesEl.insertBefore(genRow, typingRow);
                messagesEl.scrollTop = messagesEl.scrollHeight;
                try {
                  const baseImg = json.editLastImage ? lastGeneratedImageUrl : null;
                  const imgRes = await fetch(BACKEND_URL+'/generate-image', {
                    method:'POST', headers: getAuthHeaders(),
                    body: JSON.stringify({ prompt: json.prompt, existingImage: baseImg })
                  });
                  const imgData = await imgRes.json();
                  genRow.remove();
                  if(imgData.image){
                    lastGeneratedImageUrl = imgData.image;
                    addMsg('luna', json.editLastImage ? 'Here is the edited image:' : '', imgData.image);
                  } else {
                    addMsg('luna', imgData.error || 'Could not generate that image. Try describing it differently.');
                  }
                } catch(e) {
                  genRow.remove();
                  addMsg('luna', 'Could not generate that image. Try again.');
                } finally {
                  busy=false; chatSend.disabled=!chatInput.value.trim()&&!selectedImageBase64&&!selectedVideoBase64;
                }
                return;
              }
              // ── Agent created a downloadable document ─────────────
              if(json.document){
                pendingDocument = json.document;
              }
              // Agent mode sends reply in done payload (no delta chunks) — use it directly
              if(!fullText && json.reply) fullText = json.reply;
              if(!streamStopped) finalizeMessage(fullText, json.document, json.sources||[]);
            }
          }catch(e){}
        }
        if(streamStopped) break;
      }

    }catch(e){
      typingRow.style.display='none';typingRow.classList.remove('thinking-row');document.getElementById('thinking-label').style.display='none';stopManusStatusAnimation();
      addMsg('luna','Could not connect. Please try again.');
    }finally{
      busy=false;
      if(!chatSend.classList.contains('stop-mode')){
        chatSend.disabled=!chatInput.value.trim()&&!selectedImageBase64&&!selectedVideoBase64;
      }
    }
  }
  // ── Profile / Personalization ────────────────────────────
  let selectedPersonality = 'friendly';
  const moodEmoji = {neutral:'😐',happy:'😄',stressed:'😰',sad:'😔',frustrated:'😤'};
  const moodLabel = {neutral:'Neutral',happy:'Happy',stressed:'Stressed',sad:'Sad',frustrated:'Frustrated'};

  function selectPersonality(btn) {
    document.querySelectorAll('.personality-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedPersonality = btn.dataset.p;
  }

  async function loadProfile() {
    try {
      const res = await fetch(BACKEND_URL + '/profile/' + getUserId(), { headers: getAuthHeaders() });
      const p = await res.json();
      if (document.getElementById('profile-name')) {
        document.getElementById('profile-name').value = p.name || '';
        document.getElementById('profile-birthday').value = p.birthday || '';
        document.getElementById('profile-topics').value = (p.favoriteTopics || []).join(', ');
        document.getElementById('profile-nickname').value = p.lunaNickname || 'Luna';
        selectedPersonality = p.personality || 'friendly';
        document.querySelectorAll('.personality-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.p === selectedPersonality);
        });
        const mood = p.lastMood || 'neutral';
        const badge = document.getElementById('mood-badge');
        if (badge) badge.textContent = (moodEmoji[mood] || '😐') + ' ' + (moodLabel[mood] || 'Neutral');
      }
    } catch (e) { console.error('Profile load error:', e); }
  }

  async function saveProfile() {
    const btn = document.querySelector('.save-profile-btn');
    const topicsRaw = document.getElementById('profile-topics').value;
    const topics = topicsRaw.split(',').map(t => t.trim()).filter(Boolean);
    const payload = {
      name: document.getElementById('profile-name').value.trim(),
      birthday: document.getElementById('profile-birthday').value,
      favoriteTopics: topics,
      lunaNickname: document.getElementById('profile-nickname').value.trim() || 'Luna',
      personality: selectedPersonality,
      preferences: ''
    };
    btn.textContent = 'Saving...';btn.disabled = true;
    try {
      const res = await fetch(BACKEND_URL + '/profile/' + getUserId(), {
        method: 'POST', headers: getAuthHeaders(),
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        btn.textContent = '✓ Saved!';
        // Update home greeting with new name
        const savedName = payload.name;
        const homeUser = document.getElementById('home-username-display');
        if (homeUser && savedName) homeUser.textContent = ' ' + savedName;
        setTimeout(() => { btn.textContent = 'Save Preferences'; btn.disabled = false; }, 2000);
      }
      else { btn.textContent = 'Save Preferences'; btn.disabled = false; }
    } catch (e) { btn.textContent = 'Save Preferences'; btn.disabled = false; }
  }


  // ── Tools: Translate / PDF / YouTube ─────────────────────
  let activeTool = null;
  let pdfText = null;

  function toggleTool(tool) {
    if (activeTool === tool) {
      closeTool(); return;
    }
    activeTool = tool;
    document.querySelectorAll('.tool-pill').forEach(p => p.classList.remove('active'));
    document.getElementById('pill-' + tool).classList.add('active');
    document.getElementById('yt-bar').classList.toggle('active', tool === 'yt');
    if (tool === 'pdf') { document.getElementById('pdf-upload').click(); }
    if (tool === 'yt') {
      chatInput.placeholder = 'Or ask a question about the video after pasting the link above...';
    }
    showScreen('chat');
  }

  function closeTool() {
    activeTool = null;
    document.querySelectorAll('.tool-pill').forEach(p => p.classList.remove('active'));
    document.getElementById('yt-bar').classList.remove('active');
    chatInput.placeholder = 'Message Luna...';
  }


  async function handlePDF(event) {
    const file = event.target.files[0];
    if (!file) { closeTool(); return; }
    document.getElementById('pdf-name').textContent = file.name;
    document.getElementById('pdf-strip').classList.add('active');
    const pillPdf=document.getElementById('pill-pdf');if(pillPdf)pillPdf.classList.add('active');
    activeTool = 'pdf';
    chatInput.placeholder = 'Ask Luna anything about this PDF...';
    addMsg('luna', "📄 PDF loaded: " + file.name + " — ask me anything about it!");
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdfjsLib = window['pdfjs-dist/build/pdf'];
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      let fullText = '';
      for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        fullText += content.items.map(item => item.str).join(' ') + '\n';
      }
      pdfText = fullText.trim().substring(0, 8000);
    } catch (e) {
      addMsg('luna', 'Could not read that PDF. Try a different file.');
      clearPDF();
    }
  }

  function clearPDF() {
    pdfText = null;
    document.getElementById('pdf-upload').value = '';
    document.getElementById('pdf-strip').classList.remove('active');
    closeTool();
  }

  // ── Video upload ──────────────────────────────────────────


  async function handleVideo(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { showToast('Video too large. Max 20MB.'); document.getElementById('video-upload').value = ''; return; }
    document.getElementById('video-name').textContent = file.name;
    document.getElementById('video-strip').style.display = 'flex';
    chatSend.disabled = false;
    addMsg('luna', 'Video loaded: ' + file.name + ' — ask me anything about it.');
    const reader = new FileReader();
    reader.onload = (e) => { selectedVideoBase64 = e.target.result; };
    reader.readAsDataURL(file);
    chatInput.placeholder = 'Ask Luna about this video...';
  }

  function clearVideo() {
    selectedVideoBase64 = null;
    document.getElementById('video-upload').value = '';
    document.getElementById('video-strip').style.display = 'none';
    chatInput.placeholder = 'Message Luna...';
  }

  // ── File upload (PDF/doc/txt/csv) ─────────────────────────


  async function handleFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (selectedModel !== 'luna-pro' && selectedModel !== 'ro1') {
      showToast('Switch to Luna Pro or RO-1 for file analysis');
      document.getElementById('pdf-upload').value = '';
      return;
    }
    // PDF — use existing pdf.js extraction
    if (file.type === 'application/pdf') {
      handlePDF(event);
      return;
    }
    // Text files — read directly
    document.getElementById('pdf-name').textContent = file.name;
    document.getElementById('pdf-strip').classList.add('active');
    activeTool = 'file';
    chatInput.placeholder = 'Ask Luna about this file...';
    try {
      const text = await file.text();
      selectedFileData = { name: file.name, text: text.substring(0, 12000) };
      pdfText = selectedFileData.text; // reuse pdfText slot for context injection
      addMsg('luna', 'File loaded: ' + file.name + ' — ask me anything about it.');
    } catch(e) {
      addMsg('luna', 'Could not read that file. Try a .txt or .csv file.');
      clearPDF();
    }
  }

  async function summarizeYT() {
    const url = document.getElementById('yt-input').value.trim();
    if (!url) { chatInput.focus(); return; }
    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
      addMsg('luna', "⚠️ That does not look like a YouTube link. Paste a valid YouTube URL!"); return;
    }
    const videoId = url.match(/(?:v=|youtu\.be\/)([^&\?]+)/)?.[1];
    const thumbUrl = videoId ? 'https://img.youtube.com/vi/' + videoId + '/mqdefault.jpg' : null;
    showScreen('chat');
    addMsg('user', '🎥 Summarize: ' + url);
    document.getElementById('yt-input').value = '';
    fetchReply('Please summarize the YouTube video at this URL and tell me the key points, main ideas, and any important takeaways: ' + url, null, null, 'You are summarizing a YouTube video. Since you cannot directly watch videos, analyze the URL, describe what the video is likely about based on its title/ID, give useful context, and clearly state that for a full transcript summary the user can use tools like Glasp or Tactiq. Be helpful and honest.');
  }


  // Hide splash after animation completes
  setTimeout(function() {
    const splash = document.getElementById('splash-screen'); if(!splash) return;
    if (splash) splash.classList.add('hidden');
  }, 2800);


  // ── Plus Menu ────────────────────────────────────────────
  function togglePlusMenu(e) {
    e.stopPropagation();
    const menu = document.getElementById('plus-menu');
    const overlay = document.getElementById('plus-menu-overlay');
    const isOpen = menu.classList.contains('active');
    if (isOpen) { closePlusMenu(); } 
    else { menu.classList.add('active'); overlay.classList.add('active'); }
  }
  // ── Model Selector ───────────────────────────────────────
  let selectedModel = 'luna-flash';

  function toggleModelSelector(e) {
    e.stopPropagation();
    const sel = document.getElementById('model-selector');
    const ov = document.getElementById('model-selector-overlay');
    const isOpen = sel.classList.contains('active');
    if (isOpen) { closeModelSelector(); }
    else { sel.classList.add('active'); ov.classList.add('active'); }
  }

  function closeModelSelector() {
    document.getElementById('model-selector').classList.remove('active');
    document.getElementById('model-selector-overlay').classList.remove('active');
  }

  function selectModel(model) {
    // RO-1 is owner only
    if (model === 'ro1' && !isOwner) return;
    selectedModel = model;
    closeModelSelector();
    // Update active state
    document.querySelectorAll('.model-option').forEach(el => el.classList.remove('active-model'));
    const el = document.getElementById('model-' + (model === 'ro1' ? 'ro1' : model));
    if (el) el.classList.add('active-model');
    // Update chip label
    const labels = {'luna-flash':'Luna Flash','luna-pro':'Luna Pro','ro1':'RO-1'};
    const chipLabel = document.getElementById('chip-model-label');
    if (chipLabel) chipLabel.textContent = labels[model] || 'Luna Flash';
    haptic('light');
  }

  function initModelSelector() {
    const ro1 = document.getElementById('model-ro1');
    if (ro1) {
      if (!isOwner) {
        // Slightly dim RO-1 for non-owners — visible but locked
        ro1.style.filter = 'none';
        ro1.style.pointerEvents = 'none';
        ro1.style.opacity = '0.4';
        ro1.style.cursor = 'default';
      } else {
        ro1.style.filter = '';
        ro1.style.pointerEvents = '';
        ro1.style.opacity = '';
        ro1.style.cursor = '';
      }
    }
  }

  function closePlusMenu() {
    document.getElementById('plus-menu').classList.remove('active');
    document.getElementById('plus-menu-overlay').classList.remove('active');
  }
  function activateDeepThink() {
    const inp = document.getElementById('chat-input') || document.querySelector('textarea');
    if (inp) { inp.placeholder = 'Ask Luna to think deeply...'; inp.dataset.deepThink = 'true'; }
    document.getElementById('plus-btn').style.color = 'var(--accent)';
    haptic('medium');
  }
  function activateResearch() {
    const inp = document.getElementById('chat-input') || document.querySelector('textarea');
    if (inp) { inp.placeholder = 'What should Luna research?'; inp.dataset.research = 'true'; }
    document.getElementById('plus-btn').style.color = 'var(--accent)';
    haptic('medium');
  }
  function plusAction(type) {
    closePlusMenu();
    if (type === 'pdf') {
      document.getElementById('pdf-upload').click();
    } else if (type === 'video') {
      if (selectedModel !== 'luna-pro' && selectedModel !== 'ro1') {
        showToast('Switch to Luna Pro or RO-1 for video analysis');
        return;
      }
      document.getElementById('video-upload').click();
    } else if (type === 'yt') {
      document.getElementById('yt-bar').classList.add('active');
      document.getElementById('yt-input').focus();
    } else if (type === 'image') {
      document.getElementById('img-upload').click();
    }
  }


  // ── Haptic feedback ──────────────────────────────────────
  function haptic(style) {
    if (navigator.vibrate) {
      style === 'light' ? navigator.vibrate(8) :
      style === 'medium' ? navigator.vibrate(18) :
      navigator.vibrate([10,8,10]);
    }
  }

  // ── Secret mode ──────────────────────────────────────────
  let secretMode = false;
  function toggleSecretMode() {
    secretMode = !secretMode;
    document.getElementById('secret-bar').classList.toggle('show', secretMode);
    const btn = document.getElementById('secret-btn');
    if (btn) btn.style.color = secretMode ? 'var(--accent)' : '';
    haptic('medium');
  }


  // ── Manus Agent Mode ──────────────────────────────────────
  let manusMode = false;
  let manusStatusInterval = null;

  // Task-type to status label mapping
  const manusStatusMap = {
    // Research / info
    research: 'researching',
    search: 'searching',
    find: 'searching',
    look: 'searching',
    summarize: 'summarizing',
    summarise: 'summarizing',
    analyze: 'analyzing',
    analyse: 'analyzing',
    compare: 'comparing',
    explain: 'analyzing',
    // Building
    build: 'building',
    create: 'building',
    make: 'building',
    generate: 'building',
    design: 'designing',
    // Code
    code: 'writing code',
    fix: 'debugging',
    debug: 'debugging',
    review: 'reviewing',
    refactor: 'refactoring',
    // Writing
    write: 'writing',
    draft: 'drafting',
    edit: 'editing',
    // Planning
    plan: 'planning',
    // Commands
    run: 'running',
    execute: 'executing',
    install: 'installing',
    deploy: 'deploying',
  };

  function getManusStatusLabel(text) {
    if (!text) return 'executing task';
    const lower = text.toLowerCase();
    for (const [keyword, label] of Object.entries(manusStatusMap)) {
      if (lower.includes(keyword)) return label;
    }
    return 'executing task';
  }

  function setManusStatus(label) {
    const el = document.getElementById('manus-status-label');
    if (el) el.textContent = label + '...';
  }

  function startManusStatusAnimation(userText) {
    // Set initial status from message content
    const initial = getManusStatusLabel(userText);
    setManusStatus(initial);

    // Cycle through contextual sub-statuses
    const stages = [initial, 'processing', initial, 'finalizing'];
    let i = 0;
    manusStatusInterval = setInterval(() => {
      i = (i + 1) % stages.length;
      setManusStatus(stages[i]);
    }, 3500);
  }

  function stopManusStatusAnimation() {
    if (manusStatusInterval) {
      clearInterval(manusStatusInterval);
      manusStatusInterval = null;
    }
    setManusStatus('Agent Mode');
  }

  function toggleManusMode() {
    manusMode = !manusMode;
    document.getElementById('manus-bar').classList.toggle('show', manusMode);
    document.getElementById('manus-btn') && document.getElementById('manus-btn').classList.toggle('active', manusMode);
    // Sync agent chip
    const chipAgent = document.getElementById('chip-agent');
    if (chipAgent) chipAgent.classList.toggle('active', manusMode);
    const input = document.getElementById('chat-input');
    if (manusMode) {
      if (typeof secretMode !== 'undefined' && secretMode) toggleSecretMode();
      input.placeholder = 'What should Luna research or execute?';
      setManusStatus('Agent Mode');
    } else {
      stopManusStatusAnimation();
      input.placeholder = 'Message Luna...';
    }
    haptic('medium');
  }

  // ── Creative modes ────────────────────────────────────────
  let creativeMode = null;
  const creativeModePrompts = {
    story: 'Write a creative short story about: ',
    poem: 'Write a beautiful poem about: ',
    script: 'Write a short film/dialogue script about: ',
    quiz: 'Create a fun interactive quiz about: ',
    roast: 'Give a hilarious but friendly roast about: ',
    motivate: 'Give an epic motivational speech about: '
  };
  const creativeModePlaceholders = {
    story: 'What should the story be about?',
    poem: 'What should the poem be about?',
    script: 'What should the script be about?',
    quiz: 'What topic for the quiz?',
    roast: 'Who or what to roast?',
    motivate: 'What do you need motivation for?'
  };
  function setCreativeMode(btn) {
    const mode = btn.dataset.mode;
    if (creativeMode === mode) {
      creativeMode = null;
      document.querySelectorAll('.creative-pill').forEach(p => p.classList.remove('active'));
      chatInput.placeholder = 'Message Luna...';
    } else {
      creativeMode = mode;
      document.querySelectorAll('.creative-pill').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      chatInput.placeholder = creativeModePlaceholders[mode] || 'Message Luna...';
      chatInput.focus();
    }
    haptic('light');
  }

  // ── Reply to message ──────────────────────────────────────
  let replyingTo = null;
  function setReply(text) {
    replyingTo = text;
    const bar = document.getElementById('reply-bar');
    const barText = document.getElementById('reply-bar-text');
    barText.textContent = text.substring(0, 80) + (text.length > 80 ? '…' : '');
    bar.classList.add('show');
    chatInput.focus();
    haptic('light');
  }
  function cancelReply() {
    replyingTo = null;
    document.getElementById('reply-bar').classList.remove('show');
  }

  // ── Message reactions ─────────────────────────────────────
  let activeReactionRow = null;
  function showReactions(row) {
    if (activeReactionRow && activeReactionRow !== row) {
      activeReactionRow.querySelector('.reaction-bar')?.classList.remove('show');
    }
    const bar = row.querySelector('.reaction-bar');
    if (bar) { bar.classList.toggle('show'); activeReactionRow = bar.classList.contains('show') ? row : null; }
    haptic('light');
  }
  function addReaction(row, emoji) {
    const bar = row.querySelector('.reaction-bar');
    if (bar) bar.classList.remove('show');
    let existing = row.querySelector('.msg-reaction');
    if (existing) { existing.remove(); }
    const reactionEl = document.createElement('div');
    reactionEl.className = 'msg-reaction';
    reactionEl.textContent = emoji;
    reactionEl.onclick = () => reactionEl.remove();
    const mbody = row.querySelector('.mbody');
    if (mbody) mbody.appendChild(reactionEl);
    haptic('medium');
  }
  document.addEventListener('click', (e) => {
    if (activeReactionRow && !activeReactionRow.contains(e.target)) {
      activeReactionRow.querySelector('.reaction-bar')?.classList.remove('show');
      activeReactionRow = null;
    }
  });

  // ── Share sheet ───────────────────────────────────────────
  const LUNA_URL = 'https://rolandoluwaseun4.github.io/Luna-Al/';
  const LUNA_MSG = 'Try Luna AI — a smart personal assistant! 🌙 ';
  function openShareSheet() { document.getElementById('share-sheet').classList.add('show'); haptic('light'); }
  function closeShareSheet(e) { if (e.target === document.getElementById('share-sheet')) document.getElementById('share-sheet').classList.remove('show'); }
  function shareVia(type) {
    document.getElementById('share-sheet').classList.remove('show');
    if (type === 'copy') {
      navigator.clipboard.writeText(LUNA_URL).then(() => { showToast('Link copied! 🔗'); });
    } else if (type === 'whatsapp') {
      window.open('https://wa.me/?text=' + encodeURIComponent(LUNA_MSG + LUNA_URL));
    } else if (type === 'twitter') {
      window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(LUNA_MSG) + '&url=' + encodeURIComponent(LUNA_URL));
    } else if (type === 'native') {
      if (navigator.share) navigator.share({ title: 'Luna AI', text: LUNA_MSG, url: LUNA_URL }).catch(() => {});
      else { navigator.clipboard.writeText(LUNA_URL).then(() => showToast('Link copied!')); }
    }
    haptic('medium');
  }

  // ── Toast notification ────────────────────────────────────
  function showToast(msg) {
    let t = document.getElementById('luna-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'luna-toast';
      t.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:var(--accent);color:white;padding:10px 20px;border-radius:100px;font-size:13px;font-family:-apple-system,sans-serif;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.2);transition:opacity 0.3s;white-space:nowrap;';
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.opacity = '1';
    clearTimeout(t._to);
    t._to = setTimeout(() => { t.style.opacity = '0'; }, 2000);
  }

  // ── Scroll to bottom ──────────────────────────────────────
  function scrollToBottom() { messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' }); }


  // ── Message actions ───────────────────────────────────────
  function copyMac(btn, enc) {
    navigator.clipboard.writeText(decodeURIComponent(enc)).then(() => {
      const orig = btn.innerHTML;
      btn.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
      btn.style.color = 'var(--accent)';
      setTimeout(() => { btn.innerHTML = orig; btn.style.color = ''; }, 2000);
    }).catch(() => {});
    haptic('light');
  }

  function shareMac(enc) {
    const text = decodeURIComponent(enc);
    if (navigator.share) navigator.share({ text });
    else navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard'));
    haptic('light');
  }

  let ttsUtterance = null;
  function readAloud(enc, btn) {
    const text = decodeURIComponent(enc);
    // If already speaking, cancel
    if (ttsUtterance) {
      window.speechSynthesis.cancel();
      ttsUtterance = null;
      document.querySelectorAll('.mac-speaking').forEach(b=>b.classList.remove('mac-speaking'));
      return;
    }
    ttsUtterance = new SpeechSynthesisUtterance(text);
    // Pick a natural voice if available
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v=>v.lang.startsWith('en')&&!v.name.includes('Google')&&v.localService)
                   || voices.find(v=>v.lang.startsWith('en'))
                   || voices[0];
    if(preferred) ttsUtterance.voice = preferred;
    ttsUtterance.rate = 1.0;
    ttsUtterance.pitch = 1.05;
    if(btn){ btn.classList.add('mac-speaking'); }
    ttsUtterance.onend = () => {
      ttsUtterance = null;
      document.querySelectorAll('.mac-speaking').forEach(b=>b.classList.remove('mac-speaking'));
    };
    ttsUtterance.onerror = () => {
      ttsUtterance = null;
      document.querySelectorAll('.mac-speaking').forEach(b=>b.classList.remove('mac-speaking'));
    };
    window.speechSynthesis.speak(ttsUtterance);
    haptic('light');
  }

  function likeMac(btn, enc) {
    if (btn.classList.contains('active-like')) { btn.classList.remove('active-like'); return; }
    btn.classList.add('active-like');
    btn.closest('.msg-actions')?.querySelector('[title="Bad response"]')?.classList.remove('active-dislike');
    haptic('medium');
    // Show like modal
    document.getElementById('fb-icon').textContent = '👍';
    document.getElementById('fb-title').textContent = 'Thanks for the like!';
    document.getElementById('fb-body').textContent = "Since you liked this response, we'll use it to train Luna and make her even smarter. Your feedback really matters 💜";
    document.getElementById('fb-extra').innerHTML = '';
    document.getElementById('fb-action-btn').textContent = 'Amazing!';
    document.getElementById('fb-action-btn').onclick = closeFeedback;
    const fbm=document.getElementById('fb-modal');if(fbm){fbm.style.display='flex';}
  }

  function dislikeMac(btn, enc) {
    if (btn.classList.contains('active-dislike')) { btn.classList.remove('active-dislike'); return; }
    btn.classList.add('active-dislike');
    btn.closest('.msg-actions')?.querySelector('[title="Good response"]')?.classList.remove('active-like');
    haptic('medium');
    // Show dislike modal with feedback form
    document.getElementById('fb-icon').textContent = '👎';
    document.getElementById('fb-title').textContent = 'What went wrong?';
    document.getElementById('fb-body').textContent = 'Help Roland improve Luna by sharing what was wrong with this response.';
    document.getElementById('fb-extra').innerHTML = '<textarea class="fb-textarea" id="fb-text" placeholder="Tell us what was wrong or how Luna can do better..."></textarea>';
    document.getElementById('fb-action-btn').textContent = 'Send Feedback';
    document.getElementById('fb-action-btn').onclick = () => sendFeedback(decodeURIComponent(enc));
    const fbm=document.getElementById('fb-modal');if(fbm){fbm.style.display='flex';}
  }

  function sendFeedback(badResponse) {
    const note = document.getElementById('fb-text')?.value?.trim() || 'No comment';
    const subject = encodeURIComponent('Luna AI Feedback');
    const body = encodeURIComponent('Bad response:\n' + badResponse + '\n\nUser comment:\n' + note);
    window.open('mailto:rolandoluwaseun4@gmail.com?subject=' + subject + '&body=' + body);
    closeFeedback();
    showToast('Feedback sent! Thank you 💜');
  }

  function closeFeedback() {
    const fbm2=document.getElementById('fb-modal');if(fbm2){fbm2.style.display='none';}
  }
  const fbModalEl=document.getElementById('fb-modal');
  if(fbModalEl) fbModalEl.addEventListener('click', (e) => {
    if (e.target === fbModalEl) closeFeedback();
  });

  let lastLunaText = '';
  function regenMac(btn) {
    if (!lastLunaText || busy) return;
    haptic('medium');
    fetchReply(lastLunaText, null);
  }


  // ── Artifact System ───────────────────────────────────────────
  let currentArtifact = { text: '', type: '', filename: '' };

  const CODE_LANGS = {
    python: { ext: 'py', label: 'Python' },
    javascript: { ext: 'js', label: 'JavaScript' },
    js: { ext: 'js', label: 'JavaScript' },
    html: { ext: 'html', label: 'HTML' },
    css: { ext: 'css', label: 'CSS' },
    java: { ext: 'java', label: 'Java' },
    cpp: { ext: 'cpp', label: 'C++' },
    c: { ext: 'c', label: 'C' },
    typescript: { ext: 'ts', label: 'TypeScript' },
    ts: { ext: 'ts', label: 'TypeScript' },
    php: { ext: 'php', label: 'PHP' },
    sql: { ext: 'sql', label: 'SQL' },
    bash: { ext: 'sh', label: 'Bash' },
    sh: { ext: 'sh', label: 'Shell' },
    json: { ext: 'json', label: 'JSON' },
    xml: { ext: 'xml', label: 'XML' },
    swift: { ext: 'swift', label: 'Swift' },
    kotlin: { ext: 'kt', label: 'Kotlin' },
    rust: { ext: 'rs', label: 'Rust' },
    go: { ext: 'go', label: 'Go' },
  };

  function detectArtifact(text) {
    // Detect code blocks ```lang ... ```
    const codeMatch = text.match(/```([\w]*)\n([\s\S]*?)```/s);
    if (codeMatch) {
      const lang = (codeMatch[1] || 'code').toLowerCase();
      const code = codeMatch[2];
      const langInfo = CODE_LANGS[lang] || { ext: 'txt', label: lang || 'Code' };
      return { type: 'code', lang, code, langInfo };
    }
    // Detect long story/essay (over 300 words and no code)
    const wordCount = text.trim().split(/\s+/).length;
    if (wordCount > 300) {
      return { type: 'story', wordCount };
    }
    return null;
  }

  // Artifact store - avoids passing large text through onclick attributes
  const artifactStore = {};
  let artifactIdCounter = 0;

  function buildArtifactCard(text, artifactInfo) {
    const id = 'art_' + (artifactIdCounter++);
    if (artifactInfo.type === 'code') {
      const { langInfo, lang } = artifactInfo;
      const filename = 'luna-code.' + langInfo.ext;
      artifactStore[id] = { text, type: 'code', filename, lang };
      const codeIcon = '<svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
      return '<div class="artifact-card" onclick="openArtifactById(\''+id+'\')">'+
        '<div class="artifact-icon">'+codeIcon+'</div>'+
        '<div class="artifact-info">'+
          '<div class="artifact-name">'+filename+'</div>'+
          '<div class="artifact-meta">Code · '+langInfo.label+'</div>'+
        '</div></div>';
    } else {
      const wordCount = artifactInfo.wordCount;
      const preview = text.substring(0, 40).replace(/[#*]/g, '').trim();
      artifactStore[id] = { text, type: 'story', filename: 'luna-story.txt', lang: '' };
      const storyIcon = '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
      return '<div class="artifact-card" onclick="openArtifactById(\''+id+'\')">'+
        '<div class="artifact-icon">'+storyIcon+'</div>'+
        '<div class="artifact-info">'+
          '<div class="artifact-name">'+preview+'...</div>'+
          '<div class="artifact-meta">Story · '+wordCount+' words</div>'+
        '</div></div>';
    }
  }

  function openArtifactById(id) {
    const a = artifactStore[id];
    if (a) openArtifact(a.text, a.type, a.filename, a.lang);
  }

  function openArtifact(text, type, filename, lang) {
    currentArtifact = { text, type, filename, lang };
    document.getElementById('artifact-title').textContent = filename;
    const body = document.getElementById('artifact-body');
    if (type === 'code') {
      // Extract code from markdown block
      const codeMatch = text.match(/```[\w]*\n([\s\S]*?)```/s);
      const code = codeMatch ? codeMatch[1] : text;
      body.innerHTML = '<pre class="av-code">' + code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>';
    } else {
      const paragraphs = text.split(/\n\n+/).map(p =>
        '<p>' + p.replace(/\n/g,'<br>').replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\*(.*?)\*/g,'<em>$1</em>') + '</p>'
      ).join('');
      body.innerHTML = '<div class="av-story">' + paragraphs + '</div>';
    }
    document.getElementById('artifact-overlay').classList.add('open');
    haptic('light');
  }

  function closeArtifact() {
    document.getElementById('artifact-overlay').classList.remove('open');
    haptic('light');
  }

  function copyArtifact() {
    const text = currentArtifact.type === 'code'
      ? (currentArtifact.text.match(/```[\w]*\n([\s\S]*?)```/s)?.[1] || currentArtifact.text)
      : currentArtifact.text;
    navigator.clipboard.writeText(text).then(() => showToast('Copied! 📋'));
    haptic('light');
  }

  function downloadArtifact() {
    const text = currentArtifact.type === 'code'
      ? (currentArtifact.text.match(/```[\w]*\n([\s\S]*?)```/s)?.[1] || currentArtifact.text)
      : currentArtifact.text;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = currentArtifact.filename;
    a.click(); URL.revokeObjectURL(url);
    showToast('Downloaded! 💾');
    haptic('medium');
  }

  // ── PWA Install ──────────────────────────────────────────
  let deferredPrompt=null;
  // iOS detection
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isInStandaloneMode = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  const bannerDismissed = sessionStorage.getItem('install-banner-dismissed');

  if (isIOS && !isInStandaloneMode && !bannerDismissed) {
    // iOS Safari — show manual install instructions button in settings
    document.getElementById('install-btn-ios').style.display = 'block';
    // Show banner after 4 seconds
    setTimeout(function(){ 
      const ib = document.getElementById('install-banner');
      if(ib) ib.style.display = 'flex';
    }, 4000);
  }

  function handleInstallBanner() {
    if(isIOS) {
      showiOSInstallModal();
      dismissInstallBanner();
    } else if(deferredPrompt) {
      installApp();
    }
  }

  function dismissInstallBanner() {
    const ib = document.getElementById('install-banner');
    if(ib) ib.style.display = 'none';
    sessionStorage.setItem('install-banner-dismissed', '1');
  }

  function showiOSInstallModal() {
    const m = document.getElementById('ios-install-modal');
    m.style.display = 'flex';
    haptic('light');
  }
  function closeiOSInstallModal(e) {
    if (!e || e.target === document.getElementById('ios-install-modal')) {
      document.getElementById('ios-install-modal').style.display = 'none';
    }
  }

  window.addEventListener('beforeinstallprompt',function(e){
    e.preventDefault();deferredPrompt=e;
    document.getElementById('install-btn-native').style.display = 'block';
    if(!bannerDismissed) {
      setTimeout(function(){
        const ib=document.getElementById('install-banner');
        if(ib) ib.style.display='flex';
      }, 4000);
    }
  });
  function installApp(){
    if(!deferredPrompt)return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function(r){
      deferredPrompt=null;
      document.getElementById('install-btn-native').style.display='none';
      const ib2=document.getElementById('install-banner');if(ib2)ib2.style.display='none';
    });
  }
  window.addEventListener('appinstalled',function(){
    document.getElementById('install-btn-native').style.display='none';
    const ib2=document.getElementById('install-banner');if(ib2)ib2.style.display='none';
    deferredPrompt=null;
  });



  // ── Load sidebar threads ──────────────────────────────────
  async function loadSidebarThreads(){
    try{
      const res=await fetch(BACKEND_URL+'/threads/'+getUserId(),{headers:getAuthHeaders()});
      const data=await res.json();
      const threads=data.threads||[];
      window.allThreads=threads;
      populateSidebarThreads(threads);
    }catch(e){}
  }

  // ── Override showScreen ──────────────────────────────────
  function showScreen(name){
    const screens=['home-screen','chat-screen','settings-screen','saved-screen','history-screen','history-detail-screen','images-screen','apps-screen'];
    screens.forEach(id=>{
      const el=document.getElementById(id);
      if(!el) return;
      const matches = (id === name + '-screen') || (id === name);
      el.classList.toggle('active', matches);
    });
    // Show share button only when in chat with an active thread
    const shareBtn=document.getElementById('share-chat-btn');
    if(shareBtn) shareBtn.style.display=(name==='chat' && currentThreadId)?'flex':'none';
  }

  // goHistory defined above

  // ── After image gen, save to images store ─────────────────
  // saveGeneratedImage is called directly inside addMsg

  // ── Close dropdown on outside click ──────────────────────
  document.addEventListener('click', function(e){
    const dd=document.getElementById('profile-dropdown');
    if(dd && !dd.parentElement.contains(e.target)) dd.classList.remove('open');
  });

  // ── Auto-login ────────────────────────────────────────────
  if(authToken && currentUser){
    isOwner=currentUser.role==='owner';
    tryEnterApp(isOwner);
  } else {
    handleOAuthRedirect();
  }


  // ── Onboarding ────────────────────────────────────────────
  function showOnboarding(){
    const el=document.getElementById('onboarding-overlay');
    if(el){el.style.display='flex';}
  }
  function closeOnboarding(){
    const el=document.getElementById('onboarding-overlay');
    if(el){el.style.display='none';}
  }

  // ── Memories ──────────────────────────────────────────────
  async function loadMemories(){
    const list=document.getElementById('memories-list');
    if(!list||!authToken||!currentUser||currentUser.role==='guest') return;
    list.innerHTML='<div style="color:var(--text-dim);font-size:13px;">Loading...</div>';
    try {
      const res=await fetch(BACKEND_URL+'/memories/'+getUserId(),{headers:getAuthHeaders()});
      const data=await res.json();
      const memories=data.memories||[];
      if(memories.length===0){
        list.innerHTML='<div style="color:var(--text-dim);font-size:13px;">No memories yet — Luna will learn about you as you chat.</div>';
        return;
      }
      list.innerHTML=memories.map(m=>`
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;background:rgba(255,255,255,0.04);border-radius:10px;padding:9px 12px;">
          <span style="font-size:13px;flex:1;">🧠 ${m.fact}</span>
          <button onclick="deleteMemory('${m._id}',this)" style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:16px;padding:0 4px;flex-shrink:0;">×</button>
        </div>`).join('');
    } catch(e){
      list.innerHTML='<div style="color:var(--text-dim);font-size:13px;">Could not load memories.</div>';
    }
  }
  async function deleteMemory(id,btn){
    btn.textContent='...';
    try {
      await fetch(BACKEND_URL+'/memories/'+getUserId()+'/'+id,{method:'DELETE',headers:getAuthHeaders()});
      btn.closest('div[style]').remove();
    } catch(e){ btn.textContent='×'; }
  }

  // ── Share current chat ────────────────────────────────────
  function shareCurrentChat() {
    if (!currentThreadId) { showToast('Start a chat first'); return; }
    const shareUrl = `https://rolandoluwaseun4.github.io/Luna-Al/?thread=${currentThreadId}`;
    if (navigator.share) {
      navigator.share({ title: 'Chat with Luna AI', text: 'Check out this conversation with Luna AI', url: shareUrl }).catch(() => {});
    } else {
      navigator.clipboard.writeText(shareUrl).then(() => showToast('Chat link copied!'));
    }
    haptic('medium');
  }

  // Show/hide share chat button based on screen
  function updateShareBtn() {
    const btn = document.getElementById('share-chat-btn');
    if (btn) btn.style.display = currentThreadId ? 'flex' : 'none';
  }

  // Check URL for shared thread on load
  function checkSharedThread() {
    const params = new URLSearchParams(window.location.search);
    const threadId = params.get('thread');
    if (!threadId) return;
    loadSharedThread(threadId);
  }

  async function loadSharedThread(threadId) {
    const overlay = document.getElementById('shared-chat-overlay');
    const msgContainer = document.getElementById('shared-chat-messages');
    if (!overlay || !msgContainer) return;
    overlay.style.display = 'flex';
    msgContainer.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:40px;">Loading...</div>';
    try {
      const res = await fetch(BACKEND_URL + '/shared/' + threadId);
      const data = await res.json();
      if (!data.messages || data.messages.length === 0) {
        msgContainer.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:40px;">Chat not found.</div>';
        return;
      }
      document.getElementById('shared-chat-title').textContent = data.title || 'Shared Chat';
      document.getElementById('shared-chat-meta').textContent = data.messages.length + ' messages · Luna AI';
      msgContainer.innerHTML = data.messages.map(m => {
        const isLuna = m.role === 'assistant';
        return `<div style="display:flex;gap:10px;align-items:flex-start;${isLuna ? '' : 'flex-direction:row-reverse;'}">
          <div style="width:30px;height:30px;border-radius:50%;flex-shrink:0;background:${isLuna ? 'var(--accent)' : 'rgba(255,255,255,0.1)'};display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;">
            ${isLuna ? '<img src="icon-192.png" style="width:100%;height:100%;border-radius:50%;"/>' : 'U'}
          </div>
          <div style="max-width:78%;background:${isLuna ? 'rgba(255,255,255,0.05)' : 'var(--accent)'};padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.6;">
            ${renderMarkdown(m.text || '')}
          </div>
        </div>`;
      }).join('');
    } catch(e) {
      msgContainer.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:40px;">Could not load this chat.</div>';
    }
  }

  // ── Push Notifications ────────────────────────────────────
  const VAPID_PUBLIC_KEY = 'BOmXDkr9yB5VkFvqyQ3nZwXJlLFmG_kWaS8hN4pTvEw3dRbIuYoC6MxQeAzPj5nKtH2cVGsO8WfD1LrUiNgJ';

  async function toggleNotifications(enabled) {
    const status = document.getElementById('notif-status');
    if (!status) return;
    if (!enabled) {
      localStorage.removeItem('luna-push-sub');
      status.textContent = 'Notifications turned off.';
      status.style.display = 'block';
      return;
    }
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      status.textContent = 'Push notifications not supported on this browser.';
      status.style.display = 'block';
      document.getElementById('notif-toggle').checked = false;
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      status.textContent = 'Permission denied. Enable notifications in your browser settings.';
      status.style.display = 'block';
      document.getElementById('notif-toggle').checked = false;
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
      await fetch(BACKEND_URL + '/push/subscribe', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ subscription: sub, userId: getUserId() })
      });
      localStorage.setItem('luna-push-sub', '1');
      status.textContent = 'You will get a daily message from Luna each morning.';
      status.style.display = 'block';
    } catch(e) {
      status.textContent = 'Could not enable notifications. Try again.';
      status.style.display = 'block';
      document.getElementById('notif-toggle').checked = false;
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
  }

  // Restore notification toggle state on settings open
  function loadNotifState() {
    const tog = document.getElementById('notif-toggle');
    if (tog) tog.checked = !!localStorage.getItem('luna-push-sub');
  }

  if('serviceWorker' in navigator){navigator.serviceWorker.register('/Luna-Al/sw.js').catch(function(){});}
