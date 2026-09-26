/* VOLNA · social.js — 🪪 VOLNA ID: свой профиль, друзья, подписки, личные чаты.
   Постепенный выход из «плеера SC» в собственную соцсеть VOLNA.

   АРХИТЕКТУРА (адаптер хранилища — хост подключается без переписывания UI):
   ─ SocialStore — интерфейс из 6 методов:
     available / publishProfile / fetchDirectory / deliver / sendRealtime / presenceBeat
   ─ MeshAdapter (v1, работает сегодня): директория и офлайн-инбоксы в Gist-облаке
     (токен уже есть в настройках аккаунта), рельс-тайм и присутствие — MQTT
     (те же публичные брокеры, что у комнат). Никакого сервера не нужно.
   ─ RemoteAdapter (заготовка под свой хост: Supabase/Firebase/VPS) — контракт
     в docs/volna-id.md. Подключение = Social.use(adapter) — UI не меняется.

   Данные: state.social {handle,name,bio,status,friends,follows,requestsIn/Out,
   chats,unread} — едут в профиле (profiles.js stash) + localStorage. */
window.Social = (function () {
  const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
  const REG_DESC = 'VOLNA ID registry v1';
  const REG_FILE = 'volna-id-registry.json';
  const PRESENCE_MS = 25000, ONLINE_MS = 70000;
  const esc = escapeHtml;

  let adapter = null;   // активный SocialStore
  let mq = null;        // mqtt-соединение (client)
  let mqttLib = null;   // глобальная библиотека из vendor/mqtt.min.js
  let beatTimer = 0;
  let meOnline = false;
  const lastSeen = {};  // handle → ts последнего heartbeat
  let directory = {};   // handle → карточка из реестра
  let _tab = 'friends', _openChat = null, _booted = false, _saving = 0, _regSyncT = 0;

  /* ---------- модель ---------- */
  function def() {
    return { handle: '', name: '', bio: '', status: '', friends: [], follows: [],
      requestsIn: [], requestsOut: [], chats: {}, unread: {} };
  }
  function S() {
    if (!state.social) {
      try { state.social = Object.assign(def(), lsGet('ga:social', {}) || {}); } catch (_) { state.social = def(); }
    }
    const s = state.social;
    for (const k of ['friends', 'follows', 'requestsIn', 'requestsOut']) if (!Array.isArray(s[k])) s[k] = [];
    if (!s.chats) s.chats = {};
    if (!s.unread) s.unread = {};
    return s;
  }
  function save() {
    clearTimeout(_saving);
    _saving = setTimeout(() => {
      lsSet('ga:social', S());
      if (window.Profiles && Profiles.persist) Profiles.persist(); // в профиль → облако
    }, 800);
  }
  function myName() {
    if (S().name) return S().name;
    const p = window.Profiles && Profiles.profiles ? (Profiles.profiles.find(x => x.id === Profiles.active) || {}) : {};
    return p.name || 'Волна';
  }
  function myAvatar() {
    const p = window.Profiles && Profiles.profiles ? (Profiles.profiles.find(x => x.id === Profiles.active) || {}) : {};
    return p.avatar || '';
  }

  /* ---------- хэндл ---------- */
  const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  function suggestHandle() {
    let s = myName().toLowerCase().split('').map(c => TR[c] !== undefined ? TR[c] : c).join('').replace(/[^a-z0-9_]+/g, '').slice(0, 12);
    if (s.length < 3) s = 'volna';
    return s + Math.floor(10 + Math.random() * 90);
  }
  const validHandle = h => /^[a-z0-9_]{3,16}$/.test(h || '');

  /* ================================================================
     SocialStore — контракт адаптера хранилища
     ================================================================ */
  const MeshAdapter = {
    id: 'mesh',
    available: () => !!((state.settings && state.settings.ghToken) || '').trim() && !!mqttLib,
    ghToken() { return (state.settings.ghToken || '').trim(); },

    async ensureGist() {
      if (state.settings.volnaIdGist) return state.settings.volnaIdGist;
      const lst = await ipc.invoke('gh:list', { token: this.ghToken() });
      if (lst.ok) {
        const found = (lst.gists || []).find(g => (g.description || '').startsWith('VOLNA ID registry'));
        if (found) {
          state.settings.volnaIdGist = found.id;
          if (typeof saveSetting === 'function') saveSetting('volnaIdGist', found.id);
          return found.id;
        }
      }
      const seed = JSON.stringify({ v: 1, updated: Date.now(), users: {} });
      const r = await ipc.invoke('gh:filePut', { token: this.ghToken(), file: REG_FILE, content: seed, description: REG_DESC });
      if (!r.ok) throw new Error(r.error);
      state.settings.volnaIdGist = r.gistId;
      if (typeof saveSetting === 'function') saveSetting('volnaIdGist', r.gistId);
      return r.gistId;
    },

    async fetchDirectory() {
      const gid = await this.ensureGist();
      const r = await ipc.invoke('gh:fileGet', { token: this.ghToken(), gistId: gid, file: REG_FILE });
      if (!r.ok) return {};
      try { const j = JSON.parse(r.content); return j.users || {}; } catch (_) { return {}; }
    },

    async publishProfile() {
      const s = S();
      if (!validHandle(s.handle) || !this.available()) return;
      clearTimeout(_regSyncT);
      _regSyncT = setTimeout(async () => {
        try {
          const gid = await this.ensureGist();
          const users = await this.fetchDirectory();
          users[s.handle] = {
            name: myName(), bio: s.bio || '', status: s.status || '',
            avatar: (myAvatar() || '').slice(0, 40000),
            friends: s.friends.slice(0, 100), follows: s.follows.slice(0, 100),
            updated: Date.now()
          };
          await ipc.invoke('gh:filePut', { token: this.ghToken(), gistId: gid, file: REG_FILE, content: JSON.stringify({ v: 1, updated: Date.now(), users }) });
          renderIfOpen();
        } catch (_) {}
      }, 1500);
    },

    /* доставить событие пользователю: рельс-тайм + офлайн-инбокс в gist */
    async deliver(handle, ev) {
      this.sendRealtime('volna-id/inbox/' + handle, ev);
      if (!isOnline(handle)) {
        try {
          const gid = await this.ensureGist();
          const f = 'inbox-' + handle + '.json';
          const r = await ipc.invoke('gh:fileGet', { token: this.ghToken(), gistId: gid, file: f });
          let box = [];
          if (r.ok) { try { box = JSON.parse(r.content) || []; } catch (_) { box = []; } }
          box.push(ev);
          await ipc.invoke('gh:filePut', { token: this.ghToken(), gistId: gid, file: f, content: JSON.stringify(box.slice(-200)) });
        } catch (_) {}
      }
    },

    /* свои офлайн-события: забрать и удалить инбокс-файл */
    async flushMyInbox() {
      const h = S().handle;
      if (!validHandle(h)) return;
      try {
        const gid = await this.ensureGist();
        const f = 'inbox-' + h + '.json';
        const r = await ipc.invoke('gh:fileGet', { token: this.ghToken(), gistId: gid, file: f });
        if (!r.ok) return;
        let box = []; try { box = JSON.parse(r.content) || []; } catch (_) {}
        if (box.length) {
          box.forEach(onEvent);
          await ipc.invoke('gh:filePut', { token: this.ghToken(), gistId: gid, file: f, content: null }); // удалить файл
        }
      } catch (_) {}
    },

    sendRealtime(topic, obj) { try { if (mq && mq.connected) mq.publish(topic, JSON.stringify(obj)); } catch (_) {} },
    presenceBeat() { this.sendRealtime('volna-id/pres/' + S().handle, { h: S().handle, ts: Date.now() }); }
  };

  /* ---- RemoteAdapter — заготовка под свой хост (контракт в docs/volna-id.md) ----
  const RemoteAdapter = {
    id: 'remote',
    available: () => !!REMOTE_URL,
    async publishProfile(p) { await api('PUT /profile', p); },
    async fetchDirectory() { return (await api('GET /directory')).users; },
    async deliver(handle, ev) { await api('POST /deliver/' + handle, ev); },  // офлайн-очередь на сервере
    sendRealtime(topic, obj) { ws.send(JSON.stringify({ topic, obj })); },    // WebSocket
    presenceBeat() { ws.send(JSON.stringify({ type: 'beat' })); }
  };
  Social.use = adapter => { adapter = adapter; }; // ← так хост подключается одной строкой */

  /* ---------- MQTT: присутствие + мгновенные события ---------- */
  function pairTopic(a, b) { return 'volna-id/dm/' + [a, b].sort().join('__'); }
  function contactTopics() {
    const s = S();
    const list = new Set();
    [...s.friends, ...s.requestsIn, ...s.requestsOut].forEach(h => validHandle(h) && list.add(pairTopic(s.handle, h)));
    Object.keys(s.chats).forEach(h => validHandle(h) && list.add(pairTopic(s.handle, h)));
    return [...list];
  }
  function connectRealtime() {
    if (!mqttLib) return;
    try { if (mq) mq.end(true); } catch (_) {}
    if (beatTimer) { clearInterval(beatTimer); beatTimer = 0; }
    const url = BROKERS[Math.floor(Math.random() * BROKERS.length)];
    try {
      mq = mqttLib.connect(url, { clientId: 'volna_id_' + Math.random().toString(36).slice(2, 9), keepalive: 30, connectTimeout: 12000, reconnectPeriod: 5000 });
    } catch (_) { return; }
    mq.on('connect', () => {
      meOnline = true;
      const topics = ['volna-id/pres/+'].concat(contactTopics());
      if (validHandle(S().handle)) topics.push('volna-id/inbox/' + S().handle);
      try { mq.subscribe(topics); } catch (_) {}
      adapter && adapter.presenceBeat();
      renderIfOpen();
    });
    mq.on('message', (topic, payload) => {
      let m; try { m = JSON.parse(payload.toString()); } catch (_) { return; }
      if (topic.startsWith('volna-id/pres/')) { if (m.h && m.ts) lastSeen[m.h] = m.ts; return; }
      onEvent(m);
    });
    mq.on('close', () => { meOnline = false; renderIfOpen(); });
    beatTimer = setInterval(() => { if (mq && mq.connected) adapter && adapter.presenceBeat(); }, PRESENCE_MS);
  }
  function ensureSubs() {
    try { if (mq && mq.connected) mq.subscribe(contactTopics()); } catch (_) {}
  }

  /* ---------- входящие события ---------- */
  function onEvent(ev) {
    if (!ev || !ev.type || !validHandle(ev.from) || ev.from === S().handle) return;
    const s = S();
    if (ev.type === 'dm') {
      const text = String(ev.text || '').slice(0, 2000);
      if (!text) return;
      s.chats[ev.from] = s.chats[ev.from] || [];
      const arr = s.chats[ev.from];
      if (arr.length && arr[arr.length - 1].ts === ev.ts && arr[arr.length - 1].text === text) return; // дубликат (рельс+инбокс)
      arr.push({ from: ev.from, text, ts: ev.ts || Date.now() });
      if (arr.length > 300) s.chats[ev.from] = arr.slice(-300);
      if (_openChat === ev.from && $('#view-people')?.classList.contains('active')) s.unread[ev.from] = 0;
      else s.unread[ev.from] = (s.unread[ev.from] || 0) + 1;
      lastSeen[ev.from] = Date.now();
      save(); updateBadge();
      toast('💬 ' + (findUser(ev.from).name || ('@' + ev.from)) + ': ' + text.slice(0, 60), 'success');
      renderIfOpen();
    } else if (ev.type === 'freq') { // заявка в друзья
      if (!s.requestsIn.includes(ev.from) && !s.friends.includes(ev.from)) {
        s.requestsIn.push(ev.from);
        save(); updateBadge();
        toast('👋 Заявка в друзья от ' + (findUser(ev.from).name || ('@' + ev.from)) + ' — вкладка «Люди»', 'success');
        renderIfOpen();
      }
    } else if (ev.type === 'facc') { // мою заявку приняли
      s.requestsOut = s.requestsOut.filter(x => x !== ev.from);
      if (!s.friends.includes(ev.from)) s.friends.push(ev.from);
      save(); updateBadge(); ensureSubs();
      toast('🤝 ' + (findUser(ev.from).name || ('@' + ev.from)) + ' принял заявку — вы друзья!', 'success');
      adapter && adapter.publishProfile();
      renderIfOpen();
    } else if (ev.type === 'funfriend') {
      s.friends = s.friends.filter(x => x !== ev.from);
      save();
      toast('😔 @' + ev.from + ' удалил вас из друзей');
      renderIfOpen();
    }
  }

  /* ---------- справочник ---------- */
  function findUser(h) { return directory[h] || {}; }
  async function refreshDirectory() {
    if (!adapter || !adapter.available()) return;
    try {
      directory = await adapter.fetchDirectory();
      delete directory[S().handle]; // свою карточку рисуем из локальных данных
      renderIfOpen();
    } catch (_) {}
  }
  const isOnline = h => h === S().handle ? meOnline : (lastSeen[h] || 0) > Date.now() - ONLINE_MS;

  /* ---------- действия ---------- */
  async function claimHandle(h) {
    h = (h || '').trim().toLowerCase();
    if (!validHandle(h)) { toast('🪪 Хэндл: 3–16 символов, a-z 0-9 _', 'error'); return; }
    if (!MeshAdapter.available()) { toast('Подключи GitHub-облако во вкладке «Ваш аккаунт»', 'error'); return; }
    try {
      const users = await MeshAdapter.fetchDirectory();
      if (users[h]) { toast('@' + h + ' уже занят — попробуй другой', 'error'); return; }
      S().handle = h;
      save();
      if (!adapter) adapter = MeshAdapter;
      connectRealtime();
      await MeshAdapter.flushMyInbox();
      adapter.publishProfile();
      refreshDirectory();
      toast('🪪 VOLNA ID создан: @' + h, 'success');
      renderIfOpen();
    } catch (e) { toast('🪪 ' + e.message, 'error'); }
  }
  function saveProfileCard(fields) {
    const s = S();
    if (fields.name !== undefined) s.name = String(fields.name).slice(0, 32);
    if (fields.bio !== undefined) s.bio = String(fields.bio).slice(0, 160);
    if (fields.status !== undefined) s.status = String(fields.status).slice(0, 40);
    save();
    adapter && adapter.publishProfile();
    renderIfOpen();
  }
  async function addFriend(h) {
    const s = S();
    if (!validHandle(h) || h === s.handle) return;
    if (s.friends.includes(h)) { toast('Вы уже друзья', 'success'); return; }
    if (s.requestsIn.includes(h)) return acceptFriend(h);
    if (!s.requestsOut.includes(h)) {
      s.requestsOut.push(h);
      save(); updateBadge(); ensureSubs();
      adapter && adapter.deliver(h, { type: 'freq', from: s.handle, ts: Date.now() });
      toast('👋 Заявка отправлена: @' + h, 'success');
      renderIfOpen();
    }
  }
  async function acceptFriend(h) {
    const s = S();
    s.requestsIn = s.requestsIn.filter(x => x !== h);
    if (!s.friends.includes(h)) s.friends.push(h);
    save(); updateBadge(); ensureSubs();
    adapter && adapter.deliver(h, { type: 'facc', from: s.handle, ts: Date.now() });
    adapter && adapter.publishProfile();
    toast('🤝 Теперь вы друзья с @' + h, 'success');
    renderIfOpen();
  }
  function rejectFriend(h) {
    const s = S();
    s.requestsIn = s.requestsIn.filter(x => x !== h);
    s.requestsOut = s.requestsOut.filter(x => x !== h);
    save(); updateBadge(); renderIfOpen();
  }
  function unfriend(h) {
    const s = S();
    s.friends = s.friends.filter(x => x !== h);
    save(); updateBadge();
    adapter && adapter.deliver(h, { type: 'funfriend', from: s.handle, ts: Date.now() });
    adapter && adapter.publishProfile();
    toast('Дружба с @' + h + ' расторгнута');
    renderIfOpen();
  }
  function toggleFollow(h) {
    const s = S();
    if (s.follows.includes(h)) { s.follows = s.follows.filter(x => x !== h); toast('Подписка на @' + h + ' отключена'); }
    else { if (!validHandle(h) || h === s.handle) return; s.follows.push(h); toast('⭐ Подписался на @' + h, 'success'); }
    save(); adapter && adapter.publishProfile(); renderIfOpen();
  }
  function sendMsg(h, text) {
    text = String(text || '').trim().slice(0, 2000);
    if (!text || !validHandle(h)) return;
    const s = S();
    s.chats[h] = s.chats[h] || [];
    s.chats[h].push({ from: s.handle, text, ts: Date.now() });
    if (s.chats[h].length > 300) s.chats[h] = s.chats[h].slice(-300);
    save(); ensureSubs();
    adapter && adapter.deliver(h, { type: 'dm', from: s.handle, text, ts: Date.now() });
    renderIfOpen();
  }
  function openChat(h) { _openChat = h; _tab = 'chats'; S().unread[h] = 0; save(); updateBadge(); renderIfOpen(); }
  function setTab(t) { _tab = t; _openChat = null; renderIfOpen(); }
  function shareProfile() {
    const h = S().handle;
    if (!validHandle(h)) return;
    try { navigator.clipboard.writeText('Мой VOLNA ID: @' + h + ' — волна ' + myName()); toast('📋 Профиль скопирован: @' + h, 'success'); } catch (_) { toast('@' + h, 'success'); }
  }

  /* ---------- бейдж «Люди» ---------- */
  function updateBadge() {
    const b = $('#social-badge');
    if (!b) return;
    const n = Object.values(S().unread).reduce((a, x) => a + (x || 0), 0) + S().requestsIn.length;
    b.textContent = n || '';
    b.style.display = n ? '' : 'none';
  }

  /* ================================================================
     UI — Мой профиль
     ================================================================ */
  function avaHTML(h, size, card) {
    const c = card || findUser(h);
    const av = h === S().handle ? myAvatar() : (c.avatar || '');
    const letter = (c.name || h || '?')[0].toUpperCase();
    return '<div class="soc-ava' + (size ? ' ' + size : '') + (isOnline(h) ? ' online' : '') + '">' +
      (av ? '<img src="' + esc(av) + '" alt="">' : esc(letter)) + '</div>';
  }
  function userCard(h, actions) {
    const c = findUser(h);
    const name = h === S().handle ? myName() : (c.name || '@' + h);
    const bio = h === S().handle ? (S().bio || '') : (c.bio || '');
    return `<div class="soc-user">
      ${avaHTML(h, 'md', c)}
      <div class="soc-uinfo" onclick="Social.openChat('${esc(h)}')">
        <div class="soc-uname">${esc(name)} <span class="soc-dot${isOnline(h) ? ' on' : ''}"></span></div>
        <div class="soc-uh">@${esc(h)}</div>
        ${bio ? `<div class="soc-ubio">${esc(bio)}</div>` : ''}
      </div>
      <div class="soc-uacts">${actions || ''}</div>
    </div>`;
  }
  function followersOf(h) {
    const out = [];
    Object.entries(directory).forEach(([uh, c]) => { if ((c.follows || []).includes(h)) out.push(uh); });
    return out;
  }

  function renderProfile(box) {
    if (!box) return;
    const s = S();
    if (!validHandle(s.handle)) {
      const sug = suggestHandle();
      box.innerHTML = `
        <div class="vp-claim">
          <div class="vp-claim-ic"><svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg></div>
          <h2>Заведи свой VOLNA ID</h2>
          <p>Профиль внутри VOLNA: своё имя, био и статус, друзья, подписки и личные чаты.<br>
          По @хэндлу тебя найдут другие пользователи волны.</p>
          <div class="vp-claim-row">
            <input type="text" id="vp-handle" maxlength="16" placeholder="хэндл" value="${esc(sug)}">
            <button class="md-btn accent" onclick="Social.claimHandle($('#vp-handle').value)">🪪 Забрать ID</button>
          </div>
          <p class="vp-claim-hint">Справочник живёт в GitHub-облаке (токен во вкладке «Ваш аккаунт»).
          Хочешь свой сервер? Модуль принимает любой адаптер хранилища — см. docs/volna-id.md.</p>
        </div>`;
      return;
    }
    const lv = window.Ach ? Ach.summary() : null;
    const fw = followersOf(s.handle);
    const friendsHTML = s.friends.length
      ? s.friends.map(h => {
          const c = findUser(h);
          return `<div class="soc-friend" onclick="Social.openChat('${esc(h)}')">
            ${avaHTML(h, 'sm', c)}
            <div class="soc-fname">${esc(c.name || h)}</div>
            <span class="soc-dot${isOnline(h) ? ' on' : ''}"></span>
          </div>`;
        }).join('')
      : '<div class="vp-empty">Пока пусто — найди людей во вкладке «Люди»</div>';
    const hist = (state.history || []).slice(0, 8);
    if (hist.length) state.homeContinue = hist; // карточки «home» играют по этому списку
    box.innerHTML = `
      <div class="vp-card">
        <div class="vp-banner"></div>
        <div class="vp-head">
          <div class="vp-ava">${myAvatar() ? `<img src="${esc(myAvatar())}" alt="">` : esc(myName()[0].toUpperCase())}<span class="vp-on"></span></div>
          <div class="vp-id">
            <h2 class="vp-name">${esc(myName())}</h2>
            <div class="vp-handle">@${esc(s.handle)} <span class="soc-dot${meOnline ? ' on' : ''}"></span> <span class="vp-online-lbl">${meOnline ? 'в сети' : 'офлайн'}</span></div>
            ${s.bio ? `<div class="vp-bio">${esc(s.bio)}</div>` : ''}
            ${s.status ? `<div class="vp-status">🌊 ${esc(s.status)}</div>` : ''}
          </div>
          <div class="vp-actions">
            <button class="md-btn" onclick="Social.editToggle()">✏️ Редактировать</button>
            <button class="md-btn" onclick="Social.shareProfile()">📋 Поделиться</button>
          </div>
        </div>
        <div class="vp-edit" id="vp-edit" style="display:none">
          <input type="text" id="vp-name" maxlength="32" placeholder="Имя" value="${esc(s.name || myName())}">
          <input type="text" id="vp-status" maxlength="40" placeholder="Статус — что сейчас?" value="${esc(s.status)}">
          <textarea id="vp-bio" maxlength="160" rows="2" placeholder="О себе (до 160 символов)">${esc(s.bio)}</textarea>
          <button class="md-btn accent" onclick="Social.saveEdit()">Сохранить</button>
        </div>
        <div class="vp-stats">
          <span class="hero-chip" onclick="Social.setTab('friends');switchView('people')">🤝 ${s.friends.length} ${plural(s.friends.length, 'друг', 'друга', 'друзей')}</span>
          <span class="hero-chip" onclick="Social.setTab('follow');switchView('people')">👥 ${fw.length} ${plural(fw.length, 'подписчик', 'подписчика', 'подписчиков')}</span>
          <span class="hero-chip" onclick="Social.setTab('follow');switchView('people')">⭐ ${s.follows.length} ${plural(s.follows.length, 'подписка', 'подписки', 'подписок')}</span>
          ${lv ? `<span class="hero-chip" onclick="switchView('account')">🏆 Ур. ${lv.lvl} · ${lv.title}</span>` : ''}
        </div>
        <h4 class="ach-sec">🤝 Друзья</h4>
        <div class="vp-friends">${friendsHTML}</div>
        <h4 class="ach-sec">🎧 Недавно слушал</h4>
        <div class="shelf">${hist.length ? hist.map((t, i) => trackCardHTML(t, i, 'home')).join('') : '<div class="vp-empty">Включи первый трек</div>'}</div>
      </div>`;
    highlightPlaying();
  }
  function editToggle() {
    const e = $('#vp-edit');
    if (e) e.style.display = e.style.display === 'none' ? 'flex' : 'none';
  }
  function saveEdit() {
    saveProfileCard({ name: $('#vp-name')?.value, status: $('#vp-status')?.value, bio: $('#vp-bio')?.value });
    toast('🪪 Профиль сохранён', 'success');
  }

  /* ================================================================
     UI — Люди (друзья / чаты / подписки / найти)
     ================================================================ */
  function renderPeople() {
    const body = $('#people-body');
    if (!body) return;
    $$('#people-tabs .ptab').forEach(b => b.classList.toggle('on', b.dataset.p === _tab));
    const s = S();
    if (_tab === 'friends') {
      const reqIn = s.requestsIn.map(h => userCard(h,
        `<button class="md-btn accent" onclick="Social.acceptFriend('${esc(h)}')">✓ Принять</button>
         <button class="md-btn" onclick="Social.rejectFriend('${esc(h)}')">✕</button>`)).join('');
      const reqOut = s.requestsOut.map(h => userCard(h,
        `<span class="soc-pending">⏳ ждём</span><button class="md-btn" onclick="Social.rejectFriend('${esc(h)}')">✕</button>`)).join('');
      const fr = s.friends.map(h => userCard(h,
        `<button class="md-btn accent" onclick="Social.openChat('${esc(h)}')">💬</button>
         <button class="md-btn" onclick="Social.unfriend('${esc(h)}')" title="Удалить из друзей">✕</button>`)).join('');
      body.innerHTML = `
        ${s.requestsIn.length ? `<h4 class="ach-sec">📥 Заявки <em>${s.requestsIn.length}</em></h4>${reqIn}` : ''}
        ${s.requestsOut.length ? `<h4 class="ach-sec">⏳ Отправленные</h4>${reqOut}` : ''}
        <h4 class="ach-sec">🤝 Друзья <em>${s.friends.length}</em></h4>
        ${fr || '<div class="vp-empty">Друзей пока нет. Вкладка «Найти» → заявка по @хэндлу</div>'}`;
    } else if (_tab === 'chats') {
      if (_openChat) return renderChat(body, _openChat);
      const handles = Object.keys(s.chats).filter(h => (s.chats[h] || []).length);
      if (!handles.length) {
        body.innerHTML = '<div class="vp-empty">Чатов нет. Открой друга во вкладке «Друзья» → 💬</div>';
        return;
      }
      handles.sort((a, b) => lastTs(b) - lastTs(a));
      body.innerHTML = handles.map(h => {
        const arr = s.chats[h] || [];
        const last = arr[arr.length - 1] || {};
        const c = findUser(h);
        return `<div class="soc-conv" onclick="Social.openChat('${esc(h)}')">
          ${avaHTML(h, 'md', c)}
          <div class="soc-uinfo">
            <div class="soc-uname">${esc(c.name || h)} <span class="soc-dot${isOnline(h) ? ' on' : ''}"></span>
              <span class="soc-conv-ts">${fmtChatTs(last.ts)}</span></div>
            <div class="soc-ubio">${esc((last.from === s.handle ? 'Ты: ' : '') + (last.text || ''))}</div>
          </div>
          ${s.unread[h] ? `<span class="soc-unread">${s.unread[h]}</span>` : ''}
        </div>`;
      }).join('');
    } else if (_tab === 'follow') {
      const fl = s.follows.map(h => userCard(h,
        `<button class="md-btn" onclick="Social.toggleFollow('${esc(h)}')">✕ Отписаться</button>`)).join('');
      const fwers = followersOf(s.handle).map(h => userCard(h,
        s.friends.includes(h) ? '' : `<button class="md-btn accent" onclick="Social.addFriend('${esc(h)}')">＋ В друзья</button>`)).join('');
      body.innerHTML = `
        <h4 class="ach-sec">⭐ Мои подписки <em>${s.follows.length}</em></h4>
        ${fl || '<div class="vp-empty">Подписок нет — найди кого-нибудь во вкладке «Найти»</div>'}
        <h4 class="ach-sec">👥 Подписчики <em>${followersOf(s.handle).length}</em></h4>
        ${fwers || '<div class="vp-empty">Пока никто не подписался</div>'}`;
    } else if (_tab === 'find') {
      body.innerHTML = `
        <div class="vp-find">
          <input type="text" id="find-handle" placeholder="@хэндл пользователя…" onkeydown="if(event.key==='Enter')Social.find()">
          <button class="md-btn accent" onclick="Social.find()">🔍 Найти</button>
        </div>
        <div id="find-results"><div class="vp-empty">В справочнике волны: ${Object.keys(directory).length} ${plural(Object.keys(directory).length, 'пользователь', 'пользователя', 'пользователей')}</div></div>`;
    }
  }
  function lastTs(h) { const a = S().chats[h] || []; return a.length ? a[a.length - 1].ts : 0; }
  function fmtChatTs(ts) {
    if (!ts) return '';
    const d = new Date(ts), now = new Date();
    return d.toDateString() === now.toDateString() ? d.toTimeString().slice(0, 5) : d.toLocaleDateString();
  }

  function renderChat(body, h) {
    const s = S();
    const c = findUser(h);
    const msgs = (s.chats[h] || []).slice(-100);
    body.innerHTML = `
      <div class="chat-head">
        <button class="md-btn" onclick="Social.backToChats()">←</button>
        ${avaHTML(h, 'sm', c)}
        <div><div class="soc-uname">${esc(c.name || h)}</div><div class="soc-uh">@${esc(h)} · ${isOnline(h) ? 'в сети' : 'офлайн'}</div></div>
      </div>
      <div class="chat-msgs" id="chat-msgs">
        ${msgs.length ? msgs.map(m => `
          <div class="msg ${m.from === s.handle ? 'me' : 'them'}"><div class="msg-txt">${esc(m.text)}</div><div class="msg-ts">${fmtChatTs(m.ts)}</div></div>`).join('')
        : '<div class="vp-empty">Начни разговор 🌊</div>'}
      </div>
      <div class="chat-input">
        <input type="text" id="chat-inp" placeholder="Сообщение…" onkeydown="if(event.key==='Enter')Social.sendFromInput('${esc(h)}')">
        <button class="md-btn accent" onclick="Social.sendFromInput('${esc(h)}')"><svg class="ic" viewBox="0 0 24 24"><use href="#i-send"/></svg></button>
      </div>`;
    ensureSubs();
    const box = $('#chat-msgs');
    if (box) box.scrollTop = box.scrollHeight;
    const inp = $('#chat-inp');
    if (inp) inp.focus();
  }
  function sendFromInput(h) {
    const inp = $('#chat-inp');
    if (!inp) return;
    const t = inp.value;
    if (!t.trim()) return;
    inp.value = '';
    sendMsg(h, t);
  }
  function backToChats() { _openChat = null; renderIfOpen(); }

  async function find() {
    const q = ($('#find-handle')?.value || '').trim().toLowerCase().replace(/^@/, '');
    const res = $('#find-results');
    if (!res) return;
    if (!q) { res.innerHTML = '<div class="vp-empty">Введи @хэндл</div>'; return; }
    if (!MeshAdapter.available()) { res.innerHTML = '<div class="vp-empty">Нет облака — подключи GitHub во вкладке «Ваш аккаунт»</div>'; return; }
    res.innerHTML = '<div class="vp-empty">Ищу в волне…</div>';
    await refreshDirectory();
    const keys = Object.keys(directory).filter(h => h.includes(q));
    if (!keys.length) { res.innerHTML = `<div class="vp-empty">Никого с «${esc(q)}» нет в справочнике</div>`; return; }
    const s = S();
    res.innerHTML = keys.map(h => userCard(h,
      (s.friends.includes(h) ? '' : `<button class="md-btn accent" onclick="Social.addFriend('${esc(h)}')">＋ В друзья</button>`) +
      (s.follows.includes(h) ? '' : `<button class="md-btn" onclick="Social.toggleFollow('${esc(h)}')">⭐ Подписаться</button>`) +
      `<button class="md-btn" onclick="Social.openChat('${esc(h)}')">💬</button>`)).join('');
  }

  function renderIfOpen() {
    if ($('#view-people')?.classList.contains('active')) renderPeople();
    if ($('#view-vprofile')?.classList.contains('active')) renderProfile($('#vprofile-wrap'));
    updateBadge();
  }

  /* ---------- boot ---------- */
  async function init() {
    if (_booted) return;
    _booted = true;
    if (typeof window.mqtt !== 'undefined') mqttLib = window.mqtt;
    const s = S();
    if (validHandle(s.handle) && MeshAdapter.available()) {
      adapter = MeshAdapter;
      connectRealtime();
      try { await MeshAdapter.ensureGist(); await MeshAdapter.flushMyInbox(); } catch (_) {}
      adapter.publishProfile();
      refreshDirectory();
    }
    updateBadge();
  }

  function use(a) { adapter = a; } // подключение своего хранилища одной строкой

  return {
    init, use, claimHandle, saveProfileCard, addFriend, acceptFriend, rejectFriend, unfriend,
    toggleFollow, sendMsg, openChat, sendFromInput, backToChats, setTab, find,
    renderProfile, renderPeople, updateBadge, editToggle, saveEdit, shareProfile,
    summary: () => ({ handle: S().handle, friends: S().friends.length, online: meOnline })
  };
})();
