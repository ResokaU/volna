function openRooms() {
  openModal('rooms_modal');
  if (window.Rooms) Rooms.renderRooms();
}

/* VOLNA · rooms.js — 🌊 Комнаты-волна: слушать трек синхронно с друзьями через интернет.
   Без своего сервера: публичный MQTT-брокер (EMQX, фолбэк HiveMQ), топик volna/КОД.
   Хост публикует состояние плеера (трек + позиция, heartbeat 5с), гости грузят трек
   с SoundCloud сами и синкиваются от метки. Голосование гостей за следующий трек. */
window.Rooms = (function () {
  const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
  let client = null, code = '', role = '', clientId = '';
  let isUp = false, warnedDown = false;
  let guests = 0;
  const seenGuests = new Map(); // guestId -> lastSeen ts (только на хосте)
  const votes = new Map();      // guestId -> ts голоса (только на хосте)
  let hbTimer = 0, guestPingTimer = 0, joinTimer = 0, lastVote = 0;

  function genCodeSuffix() {
    const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без похожих (0/O, 1/I/L)
    let s = '';
    for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  }
  // первый символ кода — индекс брокера хоста (комната живёт на одном брокере!)
  function brokerOf(c) {
    const i = parseInt(c[0], 10) - 1;
    return (i >= 0 && i < BROKERS.length) ? BROKERS[i] : null;
  }

  function topic() { return 'volna/' + code; }
  function send(obj) {
    try { if (client && client.connected) client.publish(topic(), JSON.stringify(obj)); } catch (_) {}
  }

  function openSocket(url) {
    return new Promise((res, rej) => {
      let c;
      try {
        // reconnectPeriod: рвётся связь — mqtt.js сам переподключается и восстанавливает подписки
        c = mqtt.connect(url, { clientId: 'volna_' + clientId, keepalive: 30, connectTimeout: 12000, reconnectPeriod: 4000 });
      } catch (e) { rej(e); return; }
      let settled = false;
      const t = setTimeout(() => { try { c.end(true); } catch (_) {} if (!settled) { settled = true; rej(new Error('таймаут брокера')); } }, 15000);
      c.on('connect', () => {
        isUp = true; warnedDown = false;
        renderRooms();
        if (!settled) { settled = true; clearTimeout(t); client = c; wire(); res(); }
      });
      c.on('error', e => { if (!settled) { settled = true; clearTimeout(t); rej(e); } });
      c.on('message', onMessage);
      c.on('close', () => {
        isUp = false;
        if (code) {
          renderRooms();
          if (!warnedDown) { warnedDown = true; toast('🌊 Связь потеряна — переподключаюсь…', 'error'); }
        }
      });
    });
  }

  async function connectAny() {
    let lastErr = null;
    for (let i = 0; i < BROKERS.length; i++) {
      try { await openSocket(BROKERS[i]); return i; } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('брокеры недоступны');
  }

  function onMessage(_, payload) {
    let m; try { m = JSON.parse(payload.toString()); } catch (_) { return; }
    if (!m || m.from === clientId) return;
    switch (m.type) {
      case 'state':
        if (role === 'guest') onHostState(m);
        break;
      case 'hello':
        if (role === 'host') {
          seenGuests.set(m.from, Date.now());
          pushPresence();
          publishState(); // гость получает трек сразу, а не через heartbeat
          console.info('[ROOMS] гость подключился: ' + m.from);
          renderRooms();
        }
        break;
      case 'bye':
        if (role === 'host') { seenGuests.delete(m.from); votes.delete(m.from); pushPresence(); renderRooms(); }
        break;
      case 'presence':
        if (role === 'guest') { guests = m.guests || 1; renderRooms(); }
        break;
      case 'vote':
        if (role === 'host') {
          votes.set(m.from, Date.now());
          toast('🌊 Голос за следующий: ' + votes.size);
          maybeSkip();
        }
        break;
      case 'end':
        if (role === 'guest') { toast('Хост закрыл комнату'); leave(false); }
        break;
    }
  }

  /* ---------- хост ---------- */
  function notify() { if (role === 'host') publishState(); }

  function publishState() {
    const t = state.currentTrack;
    if (!t) return;
    send({
      type: 'state', from: clientId, ts: Date.now(),
      playing: !!state.isPlaying, pos: Math.round(state._lastPosMs || 0),
      track: {
        id: t.id, title: t.title, duration: t.duration, permalink_url: t.permalink_url,
        artwork_url: t.artwork_url, user: { username: t.user && t.user.username }
      }
    });
  }

  function pushPresence() {
    const now = Date.now();
    for (const [id, ts] of seenGuests) if (now - ts > 25000) { seenGuests.delete(id); votes.delete(id); }
    send({ type: 'presence', from: clientId, guests: seenGuests.size + 1 });
  }

  function maybeSkip() {
    const now = Date.now();
    for (const [id, ts] of votes) if (now - ts > 25000) votes.delete(id);
    const need = Math.max(1, Math.ceil(seenGuests.size / 2)); // большинство гостей
    if (seenGuests.size && votes.size >= need) {
      votes.clear();
      toast('🌊 Комната голосует — следующий трек');
      playNext();
      publishState();
    }
  }

  function hostLoop() {
    hbTimer = setInterval(() => { publishState(); pushPresence(); }, 5000);
  }

  /* ---------- гость ---------- */
  function onHostState(m) {
    const t = m.track;
    if (!t || !t.permalink_url) return;
    const drift = m.playing ? Date.now() - m.ts : 0;
    const wantPos = Math.max(0, (m.pos || 0) + drift);
    const cur = state.currentTrack;
    if (!cur || cur.id !== t.id) {
      // новый трек у хоста — грузим сами; если у хоста пауза — загрузим и встанем на паузу
      state._roomJoinPos = m.playing ? wantPos : 0;
      state._roomJoinPaused = !m.playing;
      state._roomJoinAt = Date.now();
      console.info('[ROOMS] гость: новый трек от хоста — ' + (t.title || ''));
      playTrack(t, null);
      renderRooms();
      return;
    }
    // синк позиции: разошлись больше чем на 3с — прыжок
    const ourPos = state._lastPosMs || 0;
    if (m.playing && Math.abs(ourPos - wantPos) > 3000) seekTo(wantPos);
    // пауза/плей хоста
    if (m.playing && !state.isPlaying) togglePlay();
    if (!m.playing && state.isPlaying) togglePlay();
  }

  function seekTo(ms) {
    if (state.engine === 'audio' && state.audio) {
      try { state.audio.currentTime = ms / 1000; } catch (_) {}
    } else if (state.widget) {
      try { state.widget.seekTo(ms / 1000); } catch (_) {}
    }
  }

  function guestLoop() {
    guestPingTimer = setInterval(() => send({ type: 'hello', from: clientId }), 8000);
    // дождаться старта трека у гостя и прыгнуть на позицию хоста
    joinTimer = setInterval(() => {
      if (state._roomJoinPos == null) return;
      if (state.isPlaying && state._lastDurMs) {
        seekTo(state._roomJoinPos + (Date.now() - state._roomJoinAt));
        if (state._roomJoinPaused && state.isPlaying) togglePlay(); // у хоста пауза — гость молчит
        state._roomJoinPos = null;
      }
    }, 700);
  }

  /* ---------- публичное API ---------- */
  async function create() {
    if (code) { toast('Уже в комнате — сначала выйди', 'error'); return; }
    clientId = 'h' + Math.random().toString(36).slice(2, 9);
    toast('🌊 Соединяюсь с брокером…');
    let idx;
    try { idx = await connectAny(); } catch (e) { toast('Брокеры недоступны: ' + e.message, 'error'); return; }
    code = String(idx + 1) + genCodeSuffix();
    client.subscribe(topic());
    role = 'host';
    seenGuests.clear(); votes.clear();
    hostLoop();
    publishState();
    renderRooms();
    toast('🌊 Комната создана: ' + code, 'success');
  }

  async function join(raw) {
    if (code) { toast('Уже в комнате — сначала выйди', 'error'); return; }
    const c = (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length < 5 || !brokerOf(c)) { toast('Код — 6 символов, первый — цифра', 'error'); return; }
    clientId = 'g' + Math.random().toString(36).slice(2, 9);
    code = c; // брокер хоста зашит в код — подключаемся только к нему
    toast('🌊 Соединяюсь с брокером…');
    try { await openSocket(brokerOf(c)); } catch (e) { code = ''; toast('Брокер хоста недоступен: ' + e.message, 'error'); return; }
    client.subscribe(topic());
    role = 'guest';
    send({ type: 'hello', from: clientId });
    guestLoop();
    renderRooms();
    toast('🌊 В комнате ' + code + ' — синкаюсь с хостом', 'success');
  }

  function wire2() { /* v6.7.0: обработчики живут в openSocket (переподключение) */ }

  function vote() {
    if (role !== 'guest') return;
    const now = Date.now();
    if (now - lastVote < 10000) { toast('Только что голосовал — подожди немного', 'error'); return; }
    lastVote = now;
    send({ type: 'vote', from: clientId });
    toast('🌊 Голос учтён');
  }

  function leave(announce = true) {
    if (announce && code) {
      send(role === 'host' ? { type: 'end', from: clientId } : { type: 'bye', from: clientId });
    }
    try { client && client.end(true); } catch (_) {}
    clearInterval(hbTimer); clearInterval(guestPingTimer); clearInterval(joinTimer);
    hbTimer = guestPingTimer = joinTimer = 0;
    client = null; code = ''; role = ''; guests = 0; isUp = false; warnedDown = false;
    seenGuests.clear(); votes.clear();
    state._roomJoinPos = null; state._roomJoinPaused = false;
    renderRooms();
  }

  function renderRooms() {
    const idle = $('#rooms-idle'), act = $('#rooms-active');
    if (!idle || !act) return;
    idle.style.display = code ? 'none' : '';
    act.style.display = code ? '' : 'none';
    if (!code) return;
    // код плитками: первая цифра (брокер) подсвечена
    const row = $('#rooms-code-row');
    if (row) {
      row.innerHTML = code.split('').map(ch =>
        '<span class="rc-tile' + (/\d/.test(ch) ? ' rc-digit' : '') + '">' + ch + '</span>').join('');
      row.onclick = () => copyCode();
    }
    const st = $('#rooms-status');
    if (st) st.textContent = role === 'host'
      ? (isUp ? 'Ты хост' : 'Переподключение…') + ' · гостей: ' + (seenGuests ? seenGuests.size : 0)
      : (isUp ? 'Гость' : 'Переподключение…') + ' · участников: ' + (guests || '…');
    const vb = $('#rooms-vote'), gh = $('#rooms-guest-hint');
    if (vb) vb.style.display = role === 'guest' ? '' : 'none';
    if (gh) gh.style.display = role === 'guest' ? '' : 'none';
  }

  async function copyCode() {
    if (!code) return;
    let ok = false;
    // 1) через main-процесс — работает всегда (без фокуса и разрешений)
    if (typeof ipc !== 'undefined' && ipc) {
      try { ok = await ipc.invoke('clipboard:text', code) === true; } catch (_) {}
    }
    // 2) фолбэк: Clipboard API
    if (!ok) {
      try { await navigator.clipboard.writeText(code); ok = true; } catch (_) {}
    }
    // 3) фолбэк: execCommand
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch (_) {}
    }
    toast(ok ? '📋 Код ' + code + ' скопирован' : 'Не вышло скопировать — код: ' + code, ok ? 'success' : 'error');
  }

  function joinFromInput() {
    const el = $('#rooms-code');
    join(el ? el.value : '').then(() => { if (el) el.value = ''; });
  }

  return {
    create, join, joinFromInput, leave, vote, notify, renderRooms, copyCode,
    isHost: () => role === 'host',
    inRoom: () => !!code,
    code: () => code
  };
})();
