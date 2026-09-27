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
  const nowNp = {};     // handle → {t,a,art,track} — что друг слушает сейчас
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

  /* SHA-256 (FIPS 180-4, компактно) — хэш пароля; работает в любом контексте */
  function sha256(str) {
    let ascii = unescape(encodeURIComponent(str));
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    const maxWord = Math.pow(2, 32);
    let result = '';
    const words = [], bitLen = ascii.length * 8;
    const hash = [], k = [];
    let pc = 0;
    const isComposite = {};
    for (let cand = 2; pc < 64; cand++) {
      if (!isComposite[cand]) {
        for (let i = 0; i < 313; i += cand) isComposite[i] = cand;
        hash[pc] = (Math.pow(cand, .5) * maxWord) | 0;
        k[pc++] = (Math.pow(cand, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += '\x80';
    while (ascii.length % 64 - 56) ascii += '\x00';
    for (let i = 0; i < ascii.length; i++) words[i >> 2] |= ascii.charCodeAt(i) << ((3 - i) % 4) * 8;
    words[words.length] = (bitLen / maxWord) | 0;
    words[words.length] = bitLen;
    for (let j = 0; j < words.length;) {
      const w = words.slice(j, j += 16);
      const oldHash = hash.slice(0, 8);
      for (let i = 0; i < 64; i++) {
        const w15 = w[i - 15], w2 = w[i - 2];
        const a = hash[0], e = hash[4];
        const t1 = hash[7] + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & hash[5]) ^ (~e & hash[6])) + k[i]
          + (w[i] = i < 16 ? w[i] : (w[i - 16] + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3)) + w[i - 7]
            + (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) | 0);
        const t2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash.unshift((t1 + t2) | 0);
        hash.pop();
        hash[4] = (hash[4] + t1) | 0;
      }
      for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (let i = 0; i < 8; i++)
      for (let j = 3; j + 1; j--) {
        const b = (hash[i] >> (j * 8)) & 255;
        result += (b < 16 ? '0' : '') + b.toString(16);
      }
    return result;
  }
  const passHash = (h, p) => sha256('volna-id·' + h + '·' + p);

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
        try { await writeCard(); renderIfOpen(); } catch (_) {}
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
          if (r.ok) { try { box = JSON.parse(r.content); if (!Array.isArray(box)) box = []; } catch (_) { box = []; } }
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
        let box = []; try { box = JSON.parse(r.content); if (!Array.isArray(box)) box = []; } catch (_) { box = []; }
        if (box.length) {
          box.forEach(onEvent);
          await ipc.invoke('gh:filePut', { token: this.ghToken(), gistId: gid, file: f, content: null }); // удалить файл
        }
      } catch (_) {}
    },

    sendRealtime(topic, obj) { try { if (mq && mq.connected) mq.publish(topic, JSON.stringify(obj)); } catch (_) {} },
    presenceBeat() { this.sendRealtime('volna-id/pres/' + S().handle, { h: S().handle, ts: Date.now(), np: state.social && state.social.np || null }); }
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

  /* записать свою карточку в реестр (сохраняя пароль и чужие записи) */
  async function writeCard(extra) {
    const s = S();
    if (!validHandle(s.handle)) return;
    const users = await MeshAdapter.fetchDirectory();
    const prev = users[s.handle] || {};
    users[s.handle] = {
      name: myName(), bio: s.bio || '', status: s.status || '',
      avatar: (myAvatar() || '').slice(0, 40000),
      friends: s.friends.slice(0, 100), follows: s.follows.slice(0, 100),
      pass: extra && extra.pass !== undefined ? extra.pass : (prev.pass || ''),
      updated: Date.now()
    };
    const gid = await MeshAdapter.ensureGist();
    await ipc.invoke('gh:filePut', { token: MeshAdapter.ghToken(), gistId: gid, file: REG_FILE, content: JSON.stringify({ v: 1, updated: Date.now(), users }) });
  }

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
      if (topic.startsWith('volna-id/pres/')) {
        if (m.h && m.ts) lastSeen[m.h] = m.ts;
        const prev = nowNp[m.h] && nowNp[m.h].t;
        if (m.np && m.np.t) {
          nowNp[m.h] = m.np;
          if (m.np.t !== prev) {
            const sg = S();
            if (sg.following === m.h && m.np.track && (!state.currentTrack || state.currentTrack.id !== m.np.track.id)) {
              toast('🎙 Волна @' + m.h + ': ' + m.np.t, 'success');
              playTrack(m.np.track, 'friend-follow');
            }
            renderIfOpen();
          } }
        else if (nowNp[m.h]) { delete nowNp[m.h]; renderIfOpen(); }
        return;
      }
      onEvent(m);
    });
    mq.on('close', () => { meOnline = false; renderIfOpen(); });
    beatTimer = setInterval(() => {
      if (mq && mq.connected) adapter && adapter.presenceBeat();
      const f = S().following;
      if (f && !isOnline(f)) { unfollow(true); toast('👋 @' + f + ' не в сети — следование остановлено'); }
    }, PRESENCE_MS);
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
    } else if (ev.type === 'track') { // друг скинул трек
      const slim = ev.track;
      if (!slim || !slim.id) return;
      s.chats[ev.from] = s.chats[ev.from] || [];
      s.chats[ev.from].push({ from: ev.from, kind: 'track', track: slim, ts: ev.ts || Date.now() });
      if (s.chats[ev.from].length > 300) s.chats[ev.from] = s.chats[ev.from].slice(-300);
      if (!(_openChat === ev.from && $('#view-people')?.classList.contains('active'))) s.unread[ev.from] = (s.unread[ev.from] || 0) + 1;
      save(); updateBadge();
      toast('🎵 ' + (findUser(ev.from).name || ('@' + ev.from)) + ' скинул трек: ' + String(slim.title || '').slice(0, 50), 'success');
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

  /* 🌊 волны друзей: вещаем свой трек (hook из playTrack) */
  function nowPlaying(track) {
    if (!track || !track.title) return;
    const np = {
      t: String(track.title || '').slice(0, 90),
      a: String(track.user && track.user.username || '').slice(0, 40),
      art: artwork(track) || '',
      track: { id: track.id, title: track.title, duration: track.duration,
        artwork_url: track.artwork_url, permalink_url: track.permalink_url,
        user: { username: track.user && track.user.username } }
    };
    S().np = { t: np.t, a: np.a, art: np.art }; // свой трек — для карточки профиля
    save();
    adapter && adapter.presenceBeat(); // мгновенный пульс с треком
  }

  /* слушать то, что играет у друга — в один клик */
  function playFriend(h) {
    const np = nowNp[h];
    if (!np || !np.track) { toast('У ' + h + ' сейчас не играет'); return; }
    playTrack(np.track, 'friend');
    toast('🌊 Слушаем вместе с @' + h + ': ' + np.t, 'success');
  }

  /* ---------- справочник ---------- */
  function findUser(h) { return directory[h] || {}; }
  async function refreshDirectory() {
    if (!adapter || !adapter.available()) return;
    try {
      directory = await adapter.fetchDirectory();
      delete directory[S().handle]; // свою карточку рисуем из локальных данных
    } catch (_) {}
  }
  const isOnline = h => h === S().handle ? meOnline : (lastSeen[h] || 0) > Date.now() - ONLINE_MS;

  /* ---------- регистрация и вход (пароль → SHA-256 хэш в реестре) ---------- */
  let _regMode = 'reg';
  function regTab(m) { _regMode = m; renderIfOpen(); }
  const _err = m => toast(m, 'error');

  async function register() {
    const h = ($('#vp-reg-handle')?.value || '').trim().toLowerCase();
    const name = ($('#vp-reg-name')?.value || '').trim().slice(0, 32);
    const bio = ($('#vp-reg-bio')?.value || '').trim().slice(0, 160);
    const p1 = $('#vp-reg-pass')?.value || '', p2 = $('#vp-reg-pass2')?.value || '';
    if (!validHandle(h)) return _err('Хэндл: 3–16 символов, a-z 0-9 _');
    if (!name) return _err('Введи имя профиля');
    if (p1.length < 4) return _err('Пароль: минимум 4 символа');
    if (p1 !== p2) return _err('Пароли не совпадают');
    if (!MeshAdapter.available()) return _err('Подключи GitHub-облако в Настройках');
    try {
      const users = await MeshAdapter.fetchDirectory();
      if (users[h]) return _err('@' + h + ' уже занят — вкладка «Вход»');
      S().handle = h; S().name = name; S().bio = bio;
      save();
      if (!adapter) adapter = MeshAdapter;
      await writeCard({ pass: passHash(h, p1) });
      connectRealtime();
      await MeshAdapter.flushMyInbox();
      refreshDirectory();
      toast('🪪 Аккаунт создан: @' + h, 'success');
      renderIfOpen();
    } catch (e) { _err('🪪 ' + e.message); }
  }

  async function login() {
    const h = ($('#vp-login-handle')?.value || '').trim().toLowerCase();
    const p = $('#vp-login-pass')?.value || '';
    if (!validHandle(h)) return _err('Неверный хэндл');
    if (!MeshAdapter.available()) return _err('Подключи GitHub-облако в Настройках');
    try {
      const users = await MeshAdapter.fetchDirectory();
      const card = users[h];
      if (!card) return _err('Аккаунт @' + h + ' не найден в справочнике');
      if (!card.pass) return _err('У @' + h + ' старый аккаунт без пароля — зарегистрируй другой хэндл');
      if (card.pass !== passHash(h, p)) return _err('Неверный пароль');
      S().handle = h;
      if (card.name && !S().name) S().name = card.name;
      if (card.bio && !S().bio) S().bio = card.bio;
      save();
      if (!adapter) adapter = MeshAdapter;
      connectRealtime();
      await MeshAdapter.flushMyInbox();
      adapter.publishProfile();
      refreshDirectory();
      toast('🪪 Вошёл как @' + h, 'success');
      renderIfOpen();
    } catch (e) { _err('🪪 ' + e.message); }
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
        ${(() => { const np = nowNp[h]; return np ? '<div class="soc-np" onclick="event.stopPropagation();Social.playFriend(' + esc(h) + ')" title="Слушать то же">' + '<svg class=\'ic\' viewBox=\'0 0 24 24\'><use href=\'#i-headphones\'/></svg>' + esc(np.t) + (np.a ? ' — ' + esc(np.a) : '') + '</div>' : ''; })()}
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
      const reg = _regMode !== 'login';
      box.innerHTML = `
        <div class="vp-claim">
          <div class="vp-claim-ic"><svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg></div>
          <h2>VOLNA ID</h2>
          <p>Аккаунт волны: профиль, друзья, подписки и чаты.<br>Хэндл и пароль — твой ключ, пароль хранится только хэшем.</p>
          <div class="vp-regtabs">
            <button class="ptab${reg ? ' on' : ''}" onclick="Social.regTab('reg')"><svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg>Регистрация</button>
            <button class="ptab${reg ? '' : ' on'}" onclick="Social.regTab('login')"><svg class="ic" viewBox="0 0 24 24"><use href="#i-keyboard"/></svg>Вход</button>
          </div>
          ${reg ? `
          <div class="vp-regform">
            <div class="vp-regrow">
              <div class="vp-regfield"><label>Хэндл</label><input type="text" id="vp-reg-handle" maxlength="16" placeholder="ник волны" value="${esc(sug)}"></div>
              <div class="vp-regfield"><label>Имя</label><input type="text" id="vp-reg-name" maxlength="32" placeholder="Как показывать" value="${esc(myName())}"></div>
            </div>
            <div class="vp-regrow">
              <div class="vp-regfield"><label>Пароль (от 4 символов)</label><input type="password" id="vp-reg-pass" maxlength="64" placeholder="••••••"></div>
              <div class="vp-regfield"><label>Повтори пароль</label><input type="password" id="vp-reg-pass2" maxlength="64" placeholder="••••••"></div>
            </div>
            <div class="vp-regfield"><label>О себе (необязательно)</label><input type="text" id="vp-reg-bio" maxlength="160" placeholder="пара слов о себе"></div>
            <button class="md-btn accent vp-regbtn" onclick="Social.register()"><svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg>Создать аккаунт</button>
          </div>` : `
          <div class="vp-regform">
            <div class="vp-regrow">
              <div class="vp-regfield"><label>Хэндл</label><input type="text" id="vp-login-handle" maxlength="16" placeholder="твой хэндл"></div>
              <div class="vp-regfield"><label>Пароль</label><input type="password" id="vp-login-pass" maxlength="64" placeholder="••••••"></div>
            </div>
            <button class="md-btn accent vp-regbtn" onclick="Social.login()"><svg class="ic" viewBox="0 0 24 24"><use href="#i-keyboard"/></svg>Войти</button>
          </div>`}
          <p class="vp-claim-hint">Аккаунты живут в GitHub-облаке (токен в Настройках внизу). Вход с любого ПК:
          хэндл + пароль. Пароль хранится только как SHA-256 хэш — никто не увидит исходный.</p>
        </div>`;
      return;
    }
    const lv = window.Ach ? Ach.summary() : null;
    const fw = followersOf(s.handle);
    // баннер: своя картинка → размытая обложка последнего трека → градиент
    const bsrc = state.currentTrack || (state.lastTrack && state.lastTrack.track) || null;
    const bart = bsrc ? artwork(bsrc) : '';
    const bimg = s.banner || bart;
    const t = state.currentTrack;
    const friendsHTML = s.friends.length
      ? s.friends.map(h => {
          const c = findUser(h);
          return `<div class="soc-friend" onclick="Social.openProfile('${esc(h)}')">
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
        <div class="vp-banner">${bimg ? `<img class="vp-banner-img${s.banner ? ' crisp' : ''}" src="${esc(bimg)}" alt="">` : ''}
          <button class="vp-banner-edit" onclick="Social.pickBanner()" title="Своя картинка баннера"><svg class="ic" viewBox="0 0 24 24"><use href="#i-image"/></svg></button>
          ${s.banner ? `<button class="vp-banner-edit" style="right:56px" onclick="Social.removeBanner()" title="Убрать баннер">✕</button>` : ''}
        </div>
        <div class="vp-head">
          <div class="vp-ava">${myAvatar() ? `<img src="${esc(myAvatar())}" alt="">` : esc(myName()[0].toUpperCase())}<span class="vp-on"></span></div>
          <div class="vp-id">
            <h2 class="vp-name">${esc(myName())}</h2>
            <div class="vp-handle">@${esc(s.handle)} <span class="soc-dot${meOnline ? ' on' : ''}"></span> <span class="vp-online-lbl">${meOnline ? 'в сети' : 'офлайн'}</span></div>
            ${t ? `<div class="vp-listening"><svg class="ic" viewBox="0 0 24 24"><use href="#i-headphones"/></svg>Слушает: ${esc(t.title)}</div>` : ''}
            ${s.bio ? `<div class="vp-bio">${esc(s.bio)}</div>` : ''}
            ${s.status ? `<div class="vp-status"><svg class="ic" viewBox="0 0 24 24"><use href="#i-spark"/></svg>${esc(s.status)}</div>` : ''}
          </div>
          <div class="vp-actions">
            <button class="md-btn" onclick="Social.editToggle()"><svg class="ic" viewBox="0 0 24 24"><use href="#i-edit"/></svg>Редактировать</button>
            <button class="md-btn" onclick="Social.shareProfile()"><svg class="ic" viewBox="0 0 24 24"><use href="#i-copy"/></svg>Поделиться</button>
          </div>
        </div>
        <div class="vp-edit" id="vp-edit" style="display:none">
          <input type="text" id="vp-name" maxlength="32" placeholder="Имя" value="${esc(s.name || myName())}">
          <input type="text" id="vp-status" maxlength="40" placeholder="Статус — что сейчас?" value="${esc(s.status)}">
          <textarea id="vp-bio" maxlength="160" rows="2" placeholder="О себе (до 160 символов)">${esc(s.bio)}</textarea>
          <input type="password" id="vp-pass" maxlength="64" placeholder="Новый пароль (необязательно, от 4 символов)">
          <button class="md-btn accent" onclick="Social.saveEdit()"><svg class="ic" viewBox="0 0 24 24"><use href="#i-check"/></svg>Сохранить</button>
        </div>
        <div class="vp-stats">
          <span class="hero-chip" onclick="Social.setTab('friends');switchView('people')"><svg class="ic" viewBox="0 0 24 24"><use href="#i-users"/></svg>${s.friends.length} ${plural(s.friends.length, 'друг', 'друга', 'друзей')}</span>
          <span class="hero-chip" onclick="Social.setTab('follow');switchView('people')"><svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg>${fw.length} ${plural(fw.length, 'подписчик', 'подписчика', 'подписчиков')}</span>
          <span class="hero-chip" onclick="Social.setTab('follow');switchView('people')"><svg class="ic" viewBox="0 0 24 24"><use href="#i-star"/></svg>${s.follows.length} ${plural(s.follows.length, 'подписка', 'подписки', 'подписок')}</span>
          ${lv ? `<span class="hero-chip" onclick="var a=$('#vp-ach'); if(a) a.scrollIntoView({behavior:'smooth',block:'center'})"><svg class="ic" viewBox="0 0 24 24"><use href="#i-trophy"/></svg>Ур. ${lv.lvl} · ${lv.title}</span>` : ''}
        </div>
        <h4 class="ach-sec"><svg class="ic" viewBox="0 0 24 24"><use href="#i-users"/></svg>Друзья</h4>
        <div class="vp-friends">${friendsHTML}</div>
        <div id="vp-ach"></div>
        <h4 class="ach-sec"><svg class="ic" viewBox="0 0 24 24"><use href="#i-headphones"/></svg>Недавно слушал</h4>
        <div class="tracks shelf vp-recent">${hist.length ? hist.map((t2, i) => trackCardHTML(t2, i, 'home')).join('') : '<div class="vp-empty">Включи первый трек</div>'}</div>
      </div>`;
    if (window.Ach) Ach.renderInto($('#vp-ach'), null, { compact: true });
    highlightPlaying();
  }
  function editToggle() {
    const e = $('#vp-edit');
    if (e) e.style.display = e.style.display === 'none' ? 'flex' : 'none';
  }
  function saveEdit() {
    saveProfileCard({ name: $('#vp-name')?.value, status: $('#vp-status')?.value, bio: $('#vp-bio')?.value });
    const np = $('#vp-pass')?.value || '';
    if (np) {
      if (np.length < 4) { toast('Пароль: минимум 4 символа', 'error'); return; }
      writeCard({ pass: passHash(S().handle, np) })
        .then(() => toast('🔒 Пароль установлен', 'success'))
        .catch(() => toast('Не удалось записать пароль в облако', 'error'));
      const f = $('#vp-pass'); if (f) f.value = '';
      return;
    }
    toast('🪪 Профиль сохранён', 'success');
  }

  /* баннер профиля: своя картинка (кроп 1200×340, сжатие) или фолбэк — обложка трека */
  function pickBanner() {
    const el = $('#banner-file');
    if (!el) return;
    el.onchange = bannerChosen;
    el.value = '';
    el.click();
  }
  async function bannerChosen(ev) {
    const f = ev.target && ev.target.files && ev.target.files[0];
    if (!f) return;
    try {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result); r.onerror = rej;
        r.readAsDataURL(f);
      });
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
      let q = 0.85, out;
      const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 340;
      const x = cv.getContext('2d');
      const sc = Math.max(1200 / img.width, 340 / img.height);
      x.drawImage(img, (img.width - 1200 / sc) / 2, (img.height - 340 / sc) / 2, 1200 / sc, 340 / sc, 0, 0, 1200, 340);
      out = cv.toDataURL('image/jpeg', q);
      while (out.length > 220000 && q > 0.45) { q -= 0.15; out = cv.toDataURL('image/jpeg', q); }
      S().banner = out;
      save();
      adapter && adapter.publishProfile();
      toast('🖼 Баннер обновлён', 'success');
      renderIfOpen();
    } catch (_) { toast('Не удалось загрузить картинку', 'error'); }
  }
  function removeBanner() {
    S().banner = '';
    save();
    adapter && adapter.publishProfile();
    toast('Баннер сброшен — снова обложка трека');
    renderIfOpen();
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
        `<span class="soc-pending"><svg class="ic" viewBox="0 0 24 24"><use href="#i-clock"/></svg>ждём</span><button class="md-btn" onclick="Social.rejectFriend('${esc(h)}')">✕</button>`)).join('');
      const fr = s.friends.map(h => userCard(h,
        `<button class="md-btn accent" onclick="Social.openChat('${esc(h)}')">💬<svg class="ic" viewBox="0 0 24 24"><use href="#i-chat"/></svg></button>
         <button class="md-btn" onclick="Social.unfriend('${esc(h)}')" title="Удалить из друзей">✕</button>`)).join('');
      body.innerHTML = `
        ${s.requestsIn.length ? `<h4 class="ach-sec"><svg class="ic" viewBox="0 0 24 24"><use href="#i-inbox"/></svg>Заявки <em>${s.requestsIn.length}</em></h4>${reqIn}` : ''}
        ${s.requestsOut.length ? `<h4 class="ach-sec"><svg class="ic" viewBox="0 0 24 24"><use href="#i-clock"/></svg>Отправленные</h4>${reqOut}` : ''}
        <h4 class="ach-sec"><svg class="ic" viewBox="0 0 24 24"><use href="#i-users"/></svg>Друзья <em>${s.friends.length}</em></h4>
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
        <h4 class="ach-sec"><svg class="ic" viewBox="0 0 24 24"><use href="#i-star"/></svg>Мои подписки <em>${s.follows.length}</em></h4>
        ${fl || '<div class="vp-empty">Подписок нет — найди кого-нибудь во вкладке «Найти»</div>'}
        <h4 class="ach-sec"><svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg>Подписчики <em>${followersOf(s.handle).length}</em></h4>
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
          <div class="msg ${m.from === s.handle ? 'me' : 'them'}">${m.kind === 'track' && m.track ? ('<div class="msg-trk" onclick="playChatTrack(' + m.ts + ')" title="Слушать">' + (() => { chatTrackReg[m.ts] = m.track; return m.track.artwork_url ? '<img src="' + esc(m.track.artwork_url) + '" alt="">' : ''; })() + '<div class="msg-trk-info"><div class="msg-trk-t">' + esc(m.track.title || '') + '</div><div class="msg-trk-a">' + esc((m.track.user && m.track.user.username) || '') + '</div></div>' + '<svg class="ic fill" viewBox="0 0 24 24"><use href="#i-play"/></svg></div>') : ('<div class="msg-txt">' + esc(m.text) + '</div>')}<div class="msg-ts">${fmtChatTs(m.ts)}</div></div>`).join('')
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
    const inp = $('#find-handle');
    const q = (inp?.value || '').trim().toLowerCase().replace(/^@/, '');
    let res = $('#find-results');
    if (!res) return;
    if (!q) { res.innerHTML = '<div class="vp-empty">Введи @хэндл</div>'; return; }
    if (!MeshAdapter.available()) { res.innerHTML = '<div class="vp-empty">Нет облака — подключи GitHub в Настройках (внизу)</div>'; return; }
    res.innerHTML = '<div class="vp-empty">Ищу в волне…</div>';
    await refreshDirectory();
    res = $('#find-results'); // вкладка могла перерисоваться — ловим контейнер заново
    if (!res) return;
    if (inp) inp.value = q; // вернуть запрос, если поле пересоздалось
    const keys = Object.keys(directory).filter(h => h.includes(q));
    if (!keys.length) { res.innerHTML = `<div class="vp-empty">Никого с «${esc(q)}» нет в справочнике</div>`; return; }
    const s = S();
    res.innerHTML = keys.map(h => userCard(h,
      (s.friends.includes(h) ? '' : `<button class="md-btn accent" onclick="Social.addFriend('${esc(h)}')">＋ В друзья</button>`) +
      (s.follows.includes(h) ? '' : `<button class="md-btn" onclick="Social.toggleFollow('${esc(h)}')"><svg class="ic" viewBox="0 0 24 24"><use href="#i-star"/></svg>Подписаться</button>`) +
      `<button class="md-btn" onclick="Social.openChat('${esc(h)}')">💬<svg class="ic" viewBox="0 0 24 24"><use href="#i-chat"/></svg></button>`)).join('');
  }

  function renderIfOpen() {
    const ae = document.activeElement;
    // не перерисовываем вьюху, пока пользователь печатает в поле поиска или в редакторе профиля
    const typingFind = ae && ae.id === 'find-handle';
    const typingEdit = ae && ae.closest && ae.closest('#vp-edit');
    if ($('#view-people')?.classList.contains('active') && !typingFind) renderPeople();
    if ($('#view-vprofile')?.classList.contains('active') && !typingEdit) renderProfile($('#vprofile-wrap'));
    if ($('#view-uprofile')?.classList.contains('active')) renderUProfile($('#uprofile-wrap'));
    updateBadge();
  }

  /* ---------- boot ---------- */
  async function init() {
    if (_booted) return;
    _booted = true;
    if (typeof window.mqtt !== 'undefined') mqttLib = window.mqtt;
    const s = S();
    if (MeshAdapter.available()) {
      adapter = MeshAdapter; // справочник и поиск доступны даже без своего хэндла
      if (validHandle(s.handle)) {
        connectRealtime();
        try { await MeshAdapter.ensureGist(); await MeshAdapter.flushMyInbox(); } catch (_) {}
        adapter.publishProfile();
      }
      refreshDirectory();
    }
    updateBadge();
    if (S().following) showFollowChip();
  }

  function use(a) { adapter = a; } // подключение своего хранилища одной строкой

  /* 🎵 отправить трек другу (контекстное меню) */
  const chatTrackReg = {}; // ts → track
  /* 👤 чужой профиль: страница по @хэндлу из реестра */
  let _upHandle = null;
  function openProfile(h) {
    if (!validHandle(h)) return;
    if (h === S().handle) { switchView('vprofile'); return; } // свой профиль — своя вкладка
    _upHandle = h;
    if (!directory[h]) refreshDirectory().then(() => renderIfOpen());
    switchView('uprofile');
  }
  function renderUProfile(box) {
    if (!box) return;
    const h = _upHandle;
    if (!validHandle(h)) { box.innerHTML = '<div class="vp-empty">Профиль не выбран</div>'; return; }
    const c = directory[h];
    if (!c) { box.innerHTML = '<div class="vp-empty">Загружаю профиль из облака…</div>'; refreshDirectory(); return; }
    const s = S();
    const isFriend = s.friends.includes(h);
    const isFollow = s.follows.includes(h);
    const np = nowNp[h];
    const ava = c.avatar || '';
    const fw = followersOf(h);
    const theirFriends = (c.friends || []).map(fh => ({ h: fh, c: directory[fh] || null }));
    box.innerHTML = `
      <div class="vp-card">
        <div class="vp-banner">${ava ? `<img class="vp-banner-img" src="${esc(ava)}" alt="">` : ''}</div>
        <div class="vp-head">
          <div class="vp-ava">${ava ? `<img src="${esc(ava)}" alt="">` : esc((c.name || h)[0].toUpperCase())}<span class="vp-on" style="background:${isOnline(h) ? '#3ddc84' : '#55555f'};box-shadow:${isOnline(h) ? '0 0 10px #3ddc84' : 'none'}"></span></div>
          <div class="vp-id">
            <h2 class="vp-name">${esc(c.name || h)}</h2>
            <div class="vp-handle">@${esc(h)} <span class="soc-dot${isOnline(h) ? ' on' : ''}"></span> <span class="vp-online-lbl">${isOnline(h) ? 'в сети' : 'офлайн'}</span></div>
            ${np ? `<div class="vp-listening" onclick="Social.playFriend('${esc(h)}')" title="Слушать то же"><svg class="ic" viewBox="0 0 24 24"><use href="#i-headphones"/></svg>Слушает: ${esc(np.t)}${np.a ? ' — ' + esc(np.a) : ''} · нажми, чтобы слушать вместе</div>` : ''}
            ${c.bio ? `<div class="vp-bio">${esc(c.bio)}</div>` : ''}
            ${c.status ? `<div class="vp-status"><svg class="ic" viewBox="0 0 24 24"><use href="#i-spark"/></svg>${esc(c.status)}</div>` : ''}
          </div>
          <div class="vp-actions">
            <button class="md-btn" onclick="switchView('people')"><svg class="ic" viewBox="0 0 24 24"><use href="#i-back"/></svg>Назад</button>
            ${isFriend ? `<button class="md-btn accent" onclick="Social.openChat('${esc(h)}')"><svg class="ic" viewBox="0 0 24 24"><use href="#i-chat"/></svg>Написать</button>` : `<button class="md-btn accent" onclick="Social.addFriend('${esc(h)}')"><svg class="ic" viewBox="0 0 24 24"><use href="#i-users"/></svg>＋ В друзья</button>`}
          </div>
        </div>
        <div class="vp-stats">
          <span class="hero-chip"><svg class="ic" viewBox="0 0 24 24"><use href="#i-users"/></svg>${(c.friends || []).length} ${plural((c.friends || []).length, 'друг', 'друга', 'друзей')}</span>
          <span class="hero-chip"><svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg>${fw.length} ${plural(fw.length, 'подписчик', 'подписчика', 'подписчиков')}</span>
          <span class="hero-chip"><svg class="ic" viewBox="0 0 24 24"><use href="#i-star"/></svg>${(c.follows || []).length} ${plural((c.follows || []).length, 'подписка', 'подписки', 'подписок')}</span>
        </div>
        <div class="vp-edit" style="display:flex;flex-direction:row;flex-wrap:wrap;align-items:center">
          ${!isFriend ? `<button class="md-btn" onclick="Social.toggleFollow('${esc(h)}')">${isFollow ? '✕ Отписаться' : '⭐ Подписаться'}</button>` : ''}
          ${isFriend ? `<button class="md-btn" onclick="Social.unfriend('${esc(h)}')">Удалить из друзей</button>` : ''}
          ${np ? `<button class="md-btn accent" onclick="Social.playFriend('${esc(h)}')">▶ Слушать вместе</button>` : ''}
        </div>
        <h4 class="ach-sec"><svg class="ic" viewBox="0 0 24 24"><use href="#i-users"/></svg>Друзья ${esc(c.name || h)}</h4>
        <div class="vp-friends">${theirFriends.length ? theirFriends.map(f => `
          <div class="soc-friend" onclick="Social.openProfile('${esc(f.h)}')" title="@${esc(f.h)}">
            <div class="soc-ava sm${isOnline(f.h) ? ' online' : ''}">${f.c && f.c.avatar ? `<img src="${esc(f.c.avatar)}" alt="">` : esc((f.c && f.c.name || f.h)[0].toUpperCase())}</div>
            <div class="soc-fname">${esc(f.c && f.c.name || f.h)}</div>
          </div>`).join('') : '<div class="vp-empty">Список друзей скрыт или пуст</div>'}</div>
      </div>`;
  }

  /* 🌊 волны друзей для главной */
  function friendsWaves() {
    return s.friends
      .filter(h => nowNp[h] && isOnline(h))
      .map(h => ({ h, name: findUser(h).name || h, art: nowNp[h].art || '', np: nowNp[h] }));
  }

  window.playChatTrack = ts => { const t = chatTrackReg[ts]; if (t && window.playTrack) playTrack(t, 'chat'); };
  function sendTrackTo(h, track) {
    const s = S();
    if (!validHandle(h) || h === s.handle || !track) return;
    if (!s.friends.includes(h)) { toast('Только друзьям — добавь @' + h + ' во вкладке «Люди»', 'error'); return; }
    const slim = { id: track.id, title: track.title, duration: track.duration,
      artwork_url: track.artwork_url, permalink_url: track.permalink_url,
      user: { username: track.user && track.user.username } };
    s.chats[h] = s.chats[h] || [];
    s.chats[h].push({ from: s.handle, kind: 'track', track: slim, ts: Date.now() });
    if (s.chats[h].length > 300) s.chats[h] = s.chats[h].slice(-300);
    save(); ensureSubs();
    adapter && adapter.deliver(h, { type: 'track', from: s.handle, ts: Date.now(), track: slim });
    toast('🎵 Отправлено @' + h, 'success');
    renderIfOpen();
  }
  /* 🎙 следовать за волной друга */
  function followFriend(h) {
    const s = S();
    if (s.following === h) return unfollow();
    if (!validHandle(h)) return;
    s.following = h;
    save();
    showFollowChip();
    toast('🎙 Слежу за волной @' + h + ' — треки переключаются сами', 'success');
  }
  function unfollow(silent) {
    const s = S();
    if (!s.following) return;
    const who = s.following;
    s.following = '';
    save();
    const chip = document.getElementById('follow-chip');
    if (chip) chip.remove();
    if (!silent) toast('Перестал следить за @' + who);
  }
  function showFollowChip() {
    let chip = document.getElementById('follow-chip');
    if (!chip) { chip = document.createElement('div'); chip.id = 'follow-chip'; document.body.appendChild(chip); }
    chip.innerHTML = '<span class="fc-dot"></span>🎙 Слежу за @' + escapeHtml(S().following) +
      ' <button class="fc-x" onclick="Social.unfollow()" title="Перестать">✕</button>';
  }

  return {
    init, use,
    sendTrackTo, followFriend, unfollow, openProfile, renderUProfile, friendsWaves, saveProfileCard, addFriend, acceptFriend, rejectFriend, unfriend,
    toggleFollow, sendMsg, openChat, sendFromInput, backToChats, setTab, find,
    renderProfile, renderPeople, updateBadge, editToggle, saveEdit, shareProfile,
    pickBanner, bannerChosen, removeBanner,
    register, login, regTab, nowPlaying, playFriend,
    summary: () => ({ handle: S().handle, friends: S().friends.length, online: meOnline })
  };
})();
