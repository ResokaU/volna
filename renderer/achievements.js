/* VOLNA · achievements.js — 🏆 Ачивки Волна ID: тикток-культура волны.
   У каждой ачивки свой SVG-значок: общие — символы спрайта, артисты — генерированные
   бейджи (градиент по имени + монограмма + мотив), треки — виниловые пластинки.
   Каталог: общие (треки/время/лайки/плейлисты/серии/фичи) + артисты чарта Я.Музыки (3 тира)
   + треки чарта. У каждой ачивки редкость (common/rare/epic/legendary) и XP;
   XP складывается в уровень волны с титулом. Прогресс считается из данных профиля;
   разблокировки хранятся в profile.data.ach (id → timestamp), счётчики событий
   и дневная серия — в profile.data.achx (ev/night/streak). */
window.Ach = (function () {
  // редкости: цвет, XP, подпись
  const RAR = {
    common:    { label: 'Обычная',     xp: 10,  cls: 'r-common' },
    rare:      { label: 'Редкая',      xp: 25,  cls: 'r-rare' },
    epic:      { label: 'Эпическая',   xp: 60,  cls: 'r-epic' },
    legendary: { label: 'Легендарная', xp: 150, cls: 'r-legend' }
  };
  // уровни волны: пороги XP (кумулятивные) и титулы
  const LVL_XP = [0, 50, 120, 250, 450, 750, 1150, 1650, 2300, 3000];
  const LVL_TITLES = ['Слышащий', 'Новичок волны', 'Гребец', 'Сёрфер', 'Капитан волны',
    'Повелитель волны', 'Мастер волны', 'Гуру волны', 'Легенда волны', 'Миф волны'];
  function levelInfo(xp) {
    let n = 0;
    LVL_XP.forEach(t => { if (xp >= t) n++; });
    const next = LVL_XP[n] || 0;
    const prev = LVL_XP[n - 1] || 0;
    return {
      n, title: LVL_TITLES[n - 1] || LVL_TITLES[LVL_TITLES.length - 1],
      xp, next: next || null,
      pct: next ? Math.min(100, Math.round((xp - prev) / (next - prev) * 100)) : 100
    };
  }

  // 🌊 артисты волны: сцена SoundCloud вокруг VILLIAN / madk1d / тёмного принца
  // (чарт Я.Музыки + станция madk1d; мейнстрим-тусовка МАКАНа и фан-аплоадеры вырезаны)
  const ACH_ARTISTS = [
    { name: 'VILLIAN', emoji: '😈' },
    { name: 'madk1d', emoji: '🌀' },
    { name: 'тёмный принц', emoji: '🖤' },
    { name: 'Kai Angel', emoji: '👼' },
    { name: '9mice', emoji: '🐍' },
    { name: 'VIPERR', emoji: '💎' },
    { name: '5opka', emoji: '💚' },
    { name: 'Dope17', emoji: '💊' },
    { name: 'Юпи', emoji: '⭐' },
    { name: 'greyrock', emoji: '🪨' },
    { name: 'tewiq', emoji: '🔮' },
    { name: 'tuborosho', emoji: '🌱' },
    { name: 'Toxi$', emoji: '☣' },
    { name: 'снялцепи', emoji: '⛓' },
    { name: 'урал гайсин', emoji: '🪓' },
    { name: 'ENZRO', emoji: '🌙' },
    { name: 'ЦУЕФА', emoji: '🔥' },
    { name: 'Полка', emoji: '📚' },
    { name: 'YASMI', emoji: '💧' },
    { name: 'HOLLYFLAME', emoji: '🔥' },
    { name: 'Imael Angel', emoji: '😇' },
    { name: 'YungMeechy', emoji: '📟' }
  ];
  const ARTIST_TIERS = [
    { need: 3, label: 'Слушатель', rarity: 'common' },
    { need: 10, label: 'Фанат', rarity: 'rare' },
    { need: 25, label: 'Одержимый', rarity: 'epic' }
  ];
  // треки волны: 3+ прослушиваний конкретного трека
  const ACH_TRACKS = [
    { title: 'ДИНАСТИЯ', emoji: '👑', name: 'Династия' },
    { title: 'летник', emoji: '🌴', name: 'Летник' },
    { title: 'Jealous', emoji: '🖤', name: 'Jealous' },
    { title: 'Ресток', emoji: '🌱', name: 'Ресток' },
    { title: 'солана флиппер', emoji: '🃏', name: 'Солана флиппер' },
    { title: 'ЗНАК', emoji: '☣', name: 'Знак качества' },
    { title: 'ты в моих мыслях навсегда', emoji: '⛓', name: 'Навсегда' },
    { title: 'Омут', emoji: '💧', name: 'Омут' },
    { title: 'Тону', emoji: '🔥', name: 'Тону' }
  ];
  // 🔥 тренды тиктока 2026: вирусные звуки, разорвавшие рек
  const ACH_TRENDS = [
    { title: 'яра яра', emoji: '🌀', name: 'Яра Яра', who: 'фонк-тренд с «тун-тун»' },
    { title: 'она безумна', emoji: '🥃', name: 'Она безумна', who: 'Wallem & Mult96' },
    { title: 'по барам', emoji: '🍸', name: 'По барам', who: 'ANNA ASTI · 2026' },
    { title: 'chiki', emoji: '🇧🇷', name: 'Phonk Chiki', who: 'бразильский фонк' },
    { title: 'will carry on', emoji: '🚬', name: 'Will Carry On', who: 'звук едитов' }
  ];
  // общие ачивки: [id, icon(svg-символ), emoji, name, desc, need, metric, rarity, secret?, hint?]
  // названия — в духе тикток-культуры волны
  const ACH_GENERAL = [
    // прослушано
    ['g_pl1', 'i-wave', '🌊', 'Попал в рек', 'Прослушай первый трек', 1, 'played', 'common'],
    ['g_pl10', 'i-zap', '⚡', 'Разогрев', '10 треков — флоу пошёл', 10, 'played', 'common'],
    ['g_pl50', 'i-headphones', '🎧', 'Залип на волне', '50 треков, остановиться уже нельзя', 50, 'played', 'rare'],
    ['g_pl100', 'i-spark', '💯', 'Сотка', '100 треков в копилке', 100, 'played', 'rare'],
    ['g_pl250', 'i-flame', '🔥', 'Форсишь', '250 треков — алгоритм влюблён', 250, 'played', 'epic'],
    ['g_pl1000', 'i-trophy', '👑', 'Легенда флоу', '1000 треков. Тикток отдыхает', 1000, 'played', 'legendary'],
    // время
    ['g_t1', 'i-clock', '⏱', 'Первый час', 'Час музыки без остановки', 1, 'hours', 'common'],
    ['g_t10', 'i-moon', '🌙', 'В теме', '10 часов в волнах', 10, 'hours', 'common'],
    ['g_t50', 'i-history', '🌆', 'Полсотни часов', '50 часов — полжизни в реке', 50, 'hours', 'rare'],
    ['g_t100', 'i-chart', '🌌', 'Сутки волн', '100 часов нон-стоп', 100, 'hours', 'epic'],
    // лайки
    ['g_l1', 'i-heart', '❤', 'Первое сердечко', 'Поставь первый лайк', 1, 'likes', 'common'],
    ['g_l10', 'i-crownheart', '💞', 'Коллекция звуков', '10 лайков — формируешь вкус', 10, 'likes', 'common'],
    ['g_l50', 'i-star', '💘', 'Лайк-машина', '50 лайков — сердечки сыплются', 50, 'likes', 'rare'],
    ['g_l100', 'i-crownheart', '💜', 'Сердце волны', '100 лайков — ты по уши влюблён', 100, 'likes', 'epic'],
    // плейлисты
    ['g_p1', 'i-folder', '📁', 'Сборщик', 'Создай первый плейлист', 1, 'playlists', 'common'],
    ['g_p5', 'i-folder', '🗂', 'Куратор', '5 плейлистов — свои подборки', 5, 'playlists', 'common'],
    ['g_p10', 'i-database', '🏛', 'Магнат подборок', '10 плейлистов — целая дискография', 10, 'playlists', 'rare'],
    // история
    ['g_h25', 'i-history', '📜', 'Летопись', '25 треков в истории', 25, 'history', 'common'],
    ['g_h100', 'i-database', '📚', 'Хроника волны', '100 треков в истории', 100, 'history', 'rare'],
    // серии — «огонёк», как в тиктоке
    ['g_s3', 'i-flame', '🔥', 'Огонёк 3', 'Не теряй огонёк: 3 дня подряд', 3, 'streak', 'rare'],
    ['g_s7', 'i-flame', '🌟', 'Огонёк недели', '7 дней подряд — огонёк горит ярче всех', 7, 'streak', 'epic'],
    // ночь
    ['g_n10', 'i-owl', '🦉', 'Ночной доскролл', '10 треков после полуночи', 10, 'night', 'rare'],
    // фичи приложения
    ['g_vibe', 'i-disco', '🎆', 'Светомузыка', 'Включи режим Вайб', 1, 'ev_vibe', 'common'],
    ['g_vibe10', 'i-disco', '🪩', 'Дискотека', 'Загляни в Вайб 10 раз', 10, 'ev_vibe', 'rare'],
    ['g_karaoke', 'i-mic', '🎤', 'Караоке-тренд', 'Открой экран с текстом трека', 1, 'ev_karaoke', 'common'],
    ['g_np', 'i-expand', '🎬', 'На весь экран', 'Открой Now Playing', 1, 'ev_np', 'common'],
    ['g_eq', 'i-sliders', '🎚', 'Твой звук', 'Подкрути эквалайзер', 1, 'ev_eq', 'common'],
    ['g_room', 'i-globe', '📡', 'Слушаем вместе', 'Создай или войди в комнату-волну', 1, 'ev_room', 'rare'],
    // секретка: набери «волна» на клавиатуре
    ['g_wave', 'i-spark', '🌊', 'Поймал волну', 'Ты поймал волну — буквально', 1, 'ev_wave', 'legendary',
      true, 'Пасхалка где-то в приложении. Попробуй поймать волну…']
  ];

  const EMPTY_ACHX = { ev: {}, streak: { last: '', n: 0 }, night: 0 };
  function getX() {
    if (!state.achx) state.achx = { ev: {}, streak: { last: '', n: 0 }, night: 0 };
    if (!state.achx.ev) state.achx.ev = {};
    if (!state.achx.streak) state.achx.streak = { last: '', n: 0 };
    return state.achx;
  }

  function metrics() {
    const st = state.stats || {};
    const x = getX();
    return {
      played: st.totalPlayed || 0,
      hours: Math.floor((st.totalTime || 0) / 3600000),
      likes: (state.favorites || []).length,
      playlists: (state.playlists || []).length,
      history: (state.history || []).length,
      streak: x.streak.n || 0,
      night: x.night || 0,
      ev_vibe: x.ev.vibe || 0,
      ev_karaoke: x.ev.karaoke || 0,
      ev_np: x.ev.np || 0,
      ev_eq: x.ev.eq || 0,
      ev_room: x.ev.room || 0,
      ev_wave: x.ev.wave || 0,
      artistCount: name => (state.history || []).filter(t =>
        String(t.user && t.user.username || '').toLowerCase() === name.toLowerCase()).length,
      trackCount: title => {
        const q = String(title || '').toLowerCase();
        return (state.history || []).filter(t => {
          const tt = String(t.title || '').toLowerCase();
          return tt === q || tt.includes(q) || q.includes(tt); // title на SC бывает с ремиксами/версиями
        }).length;
      }
    };
  }

  /* ---------- SVG-иконки ачивок ----------
     общие → символы из спрайта; артисты/треки → генерированные бейджи:
     уникальный градиент (по имени) + монограмма + мотив в углу. */
  const MOTIFS = {
    flame: 'M24 8c.6 3-1.2 4.6-2.4 6.1-1.3 1.5-2.6 3-2.6 5.4a7 7 0 1 0 14 0c0-1.9-.9-3.4-1.9-4.8-.3 1-.8 1.9-1.6 2.4.3-2.7-.4-6.4-1.6-9.1-.5 1.7-1.9 3-2.5 4.6-.4-1.5-1-3.2-1.4-4.6z',
    bolt: 'M25 6L15 18h7l-1 8 10-12h-7l1-8z',
    star: 'M24 5l3.4 7 7.6 1-5.6 5.4 1.4 7.6L24 22.2l-6.8 3.8 1.4-7.6L13 13l7.6-1L24 5z',
    crown: 'M10 32h28l-2.4-11-4.8 4.8L24 17l-6.8 8.8L12.4 21 10 32z',
    diamond: 'M24 8l9 14-9 16-9-16 9-14z',
    wave: 'M8 22c3-6 6-6 9 0s6 6 9 0 6-6 9 0M8 30c3-6 6-6 9 0s6 6 9 0 6-6 9 0',
    cross: 'M24 12v24M12 24h24',
    tri: 'M24 10l12 24H12l12-24z'
  };
  function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  function motifSVG(name, x, y) {
    const d = MOTIFS[Object.keys(MOTIFS)[hashStr(name + '#m') % Object.keys(MOTIFS).length]];
    return `<path d="${d}" transform="translate(${x} ${y}) scale(.42)" fill="rgba(255,255,255,.28)" stroke="none"/>`;
  }
  function artistSVG(name) {
    const grad = 'ag' + (hashStr(name) % 12);
    const letter = escapeHtml((name.trim()[0] || '?').toUpperCase());
    const d = MOTIFS[Object.keys(MOTIFS)[hashStr(name + '#m') % Object.keys(MOTIFS).length]];
    return `<svg class="ach-gen" viewBox="0 0 48 48" aria-hidden="true">
      <rect x="2" y="2" width="44" height="44" rx="13" fill="url(#${grad})"/>
      <path d="${d}" transform="translate(24 24) scale(1.1) translate(-24 -24)" fill="rgba(255,255,255,.2)" stroke="none"/>
      <text x="24" y="32" text-anchor="middle" font-family="inherit" font-size="23" font-weight="900" fill="#fff">${letter}</text>
    </svg>`;
  }
  function vinylSVG(name) {
    const grad = 'ag' + (hashStr(name + 'v') % 12);
    const letter = escapeHtml((name.trim()[0] || '?').toUpperCase());
    return `<svg class="ach-gen" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="21" fill="#17171f"/>
      <circle cx="24" cy="24" r="15" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="1"/>
      <circle cx="24" cy="24" r="11.5" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="1"/>
      <circle cx="24" cy="24" r="8.5" fill="url(#${grad})"/>
      <circle cx="24" cy="24" r="1.8" fill="#17171f"/>
      <text x="24" y="28" text-anchor="middle" font-size="10" font-weight="900" fill="#fff">${letter}</text>
    </svg>`;
  }
  /* винил тренда тиктока: та же пластинка + огонёк-мотив */
  function trendSVG(name) {
    const grad = 'ag' + (hashStr(name + 't') % 12);
    const letter = escapeHtml((name.trim()[0] || '?').toUpperCase());
    return `<svg class="ach-gen" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="21" fill="#17171f"/>
      <circle cx="24" cy="24" r="15" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="1"/>
      <path d="${MOTIFS.flame}" transform="translate(21 9) scale(.42)" fill="url(#${grad})" stroke="none"/>
      <circle cx="24" cy="30" r="7" fill="url(#${grad})"/>
      <circle cx="24" cy="30" r="1.6" fill="#17171f"/>
      <text x="24" y="33.5" text-anchor="middle" font-size="8.5" font-weight="900" fill="#fff">${letter}</text>
    </svg>`;
  }
  function iconSVG(a) {
    if (a.kind === 'artist') return artistSVG(a.name);
    if (a.kind === 'track') return vinylSVG(a.name);
    if (a.kind === 'trend') return trendSVG(a.name);
    return `<svg class="ach-gen" viewBox="0 0 24 24"><use href="#${a.icon || 'i-spark'}"/></svg>`;
  }

  // каталог карточек: {id, icon, emoji, name, desc, tier, value, need, unlocked, rarity, secret, hint}
  function catalog() {
    const m = metrics();
    const out = [];
    for (const [id, icon, emoji, name, desc, need, metric, rarity, secret, hint] of ACH_GENERAL) {
      const v = m[metric] || 0;
      out.push({ id, icon, emoji, name, desc, tier: -1, value: v, need, rarity, secret: !!secret, hint, unlocked: v >= need });
    }
    ACH_ARTISTS.forEach((a, ai) => {
      const cnt = m.artistCount(a.name);
      let tier = -1;
      ARTIST_TIERS.forEach((t, ti) => { if (cnt >= t.need) tier = ti; });
      const next = ARTIST_TIERS[tier + 1] || ARTIST_TIERS[0];
      out.push({
        id: 'art' + ai, kind: 'artist', emoji: a.emoji, name: a.name,
        desc: 'Треки артиста в истории: ' + ARTIST_TIERS.map(t => t.need).join(' → ') + ' прослушиваний',
        tier, value: cnt,
        need: tier >= ARTIST_TIERS.length - 1 ? ARTIST_TIERS[2].need : (tier >= 0 ? ARTIST_TIERS[tier + 1].need : ARTIST_TIERS[0].need),
        rarity: ARTIST_TIERS[Math.max(0, tier)].rarity, unlocked: tier >= 0
      });
    });
    for (const t of ACH_TRACKS) {
      const cnt = m.trackCount(t.title);
      out.push({
        id: 'trk_' + t.name.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '_'), kind: 'track', emoji: t.emoji,
        name: t.name, desc: 'Трек волны: ' + t.title + ' — 3+ прослушиваний', tier: -1, value: cnt, need: 3,
        rarity: 'rare', unlocked: cnt >= 3
      });
    }
    for (const t of ACH_TRENDS) {
      const cnt = m.trackCount(t.title);
      out.push({
        id: 'tt_' + t.name.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '_'), kind: 'trend', emoji: t.emoji,
        name: t.name, desc: 'Тренд тиктока 2026: ' + t.title + ' · ' + t.who, tier: -1, value: cnt, need: 3,
        rarity: 'epic', unlocked: cnt >= 3
      });
    }
    return out;
  }

  /* красивое празднование разблокировки */
  function unlockPop(a) {
    let box = document.getElementById('ach-pops');
    if (!box) { box = document.createElement('div'); box.id = 'ach-pops'; document.body.appendChild(box); }
    const R = RAR[a.rarity] || RAR.common;
    const el = document.createElement('div');
    el.className = 'ach-pop ' + R.cls;
    el.innerHTML = `<div class="ach-pop-emoji">${iconSVG(a)}</div>
      <div class="ach-pop-txt"><div class="ach-pop-cap">Ачивка открыта · ${R.label}</div>
      <div class="ach-pop-name">${escapeHtml(a.name)}</div>
      <div class="ach-pop-xp">+${R.xp} XP</div></div>`;
    while (box.children.length >= 4) box.firstChild.remove();
    box.appendChild(el);
    setTimeout(() => el.classList.add('out'), 4200);
    setTimeout(() => el.remove(), 4900);
  }

  /* проверка новых разблокировок; kind: 'listen' | 'like' | 'playlist' | undefined */
  function check(kind) {
    const x = getX();
    if (kind === 'listen') {
      if (new Date().getHours() < 5) x.night = (x.night || 0) + 1; // «Совиный час»
      const key = new Date().toISOString().slice(0, 10);
      if (x.streak.last !== key) { // дневная серия
        const yest = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
        x.streak.n = x.streak.last === yest ? (x.streak.n || 0) + 1 : 1;
        x.streak.last = key;
      }
    }
    const cat = catalog();
    const ach = state.ach || {};
    const fresh = cat.filter(a => a.unlocked && !ach[a.id]);
    fresh.forEach(a => { ach[a.id] = Date.now(); });
    state.ach = ach;
    fresh.forEach((a, i) => setTimeout(() => {
      unlockPop(a);
      if ((a.rarity === 'epic' || a.rarity === 'legendary') && typeof confettiBurst === 'function')
        confettiBurst(); // эпические и легендарные — с конфетти
    }, i * 600));
    if (fresh.length && typeof persistQueueSoon === 'function') persistQueueSoon(); // триггер сохранения профиля
    return fresh.length;
  }

  /* событийные счётчики: Ach.event('vibe' | 'room' | 'karaoke' | 'np' | 'eq' | 'wave') */
  function event(name) {
    const x = getX();
    x.ev[name] = (x.ev[name] || 0) + 1;
    check();
  }

  /* сводка для чипов (hero, аккаунт): уровень, титул, XP, прогресс */
  function summary() {
    const cat = catalog();
    const unlocked = cat.filter(a => a.unlocked);
    const xp = unlocked.reduce((s, a) => s + (RAR[a.rarity] || RAR.common).xp, 0);
    const lv = levelInfo(xp);
    return { lvl: lv.n, title: lv.title, xp, next: lv.next, pct: lv.pct, unlocked: unlocked.length, total: cat.length };
  }

  /* фильтры просмотра: all | done | wip; компактный режим — для профиля Волна ID */
  let _filter = localStorage.getItem('ga:achf') || 'all';
  let _lastBox = null, _lastOpts = {};
  let _expanded = localStorage.getItem('ga:achexp') === '1';
  function setFilter(f) {
    _filter = f;
    localStorage.setItem('ga:achf', f);
    renderInto(_lastBox, null, _lastOpts);
  }
  function toggleExpand() {
    _expanded = !_expanded;
    localStorage.setItem('ga:achexp', _expanded ? '1' : '0');
    renderInto(_lastBox, null, _lastOpts);
    const a = document.getElementById('vp-ach');
    if (a) a.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderInto(box, headEl, opts) {
    if (!box) return;
    _lastBox = box;
    _lastOpts = opts || {};
    const compact = !!_lastOpts.compact && !_expanded;
    const cat = catalog();
    const ach = state.ach || {};
    const unlocked = cat.filter(a => a.unlocked);
    const xp = unlocked.reduce((s, a) => s + (RAR[a.rarity] || RAR.common).xp, 0);
    const lv = levelInfo(xp);
    const head = `
      <div class="ach-head">
        <div class="ach-lvl">Ур. ${lv.n}<small>${lv.title}</small></div>
        <div class="ach-lvlinfo">
          <div class="ach-lvlname">${unlocked.length} / ${cat.length} ачивок · <b>${xp} XP</b></div>
          <div class="ach-headbar"><div style="width:${Math.round(unlocked.length / cat.length * 100)}%"></div></div>
          <div class="ach-next">${lv.next ? `До ур. ${lv.n + 1}: ещё ${lv.next - xp} XP (${lv.pct}%)` : 'Максимальный уровень — ты Миф волны 🌊'}</div>
        </div>
      </div>`;
    if (headEl) headEl.innerHTML = head;

    if (compact) {
      // компактный режим: бейдж уровня + недавние ачивки + кнопка раскрытия
      const recent = unlocked
        .map(a => ({ a, ts: ach[a.id] || 0 }))
        .sort((x, y) => y.ts - x.ts).slice(0, 6)
        .map(({ a }) => {
          const R = RAR[a.rarity] || RAR.common;
          return `<div class="ach-mini ${R.cls}" title="${R.label} · +${R.xp} XP">
            <span class="ach-mini-emoji">${iconSVG(a)}</span>
            <span class="ach-mini-name">${escapeHtml(a.name)}</span></div>`;
        }).join('');
      box.innerHTML = `${head}
        <div class="ach-minirow">${recent || '<div class="ach-next">Пока пусто — включи первый трек 🌊</div>'}</div>
        <button class="ach-expand" onclick="Ach.toggleExpand()"><svg class="ic" viewBox="0 0 24 24"><use href="#i-trophy"/></svg>Все ачивки · ${unlocked.length} / ${cat.length}</button>`;
      return;
    }

    const filters = `
      <div class="ach-filters">
        <button class="ach-fbtn${_filter === 'all' ? ' on' : ''}" onclick="Ach.setFilter('all')">Все · ${cat.length}</button>
        <button class="ach-fbtn${_filter === 'done' ? ' on' : ''}" onclick="Ach.setFilter('done')"><svg class="ic" viewBox="0 0 24 24"><use href="#i-check"/></svg>Получено · ${unlocked.length}</button>
        <button class="ach-fbtn${_filter === 'wip' ? ' on' : ''}" onclick="Ach.setFilter('wip')"><svg class="ic" viewBox="0 0 24 24"><use href="#i-clock"/></svg>В процессе · ${cat.length - unlocked.length}</button>
      </div>`;
    const applyF = arr => _filter === 'all' ? arr : _filter === 'done' ? arr.filter(a => a.unlocked) : arr.filter(a => !a.unlocked);
    const card = a => {
      const R = RAR[a.rarity] || RAR.common;
      const secret = a.secret && !a.unlocked;
      const pct = Math.min(100, Math.round(a.value / a.need * 100));
      return `
      <div class="ach-card ${a.unlocked ? 'unlocked ' + R.cls : ''}${secret ? ' secret' : ''}" title="${R.label} · +${R.xp} XP">
        <div class="ach-top"><div class="ach-emoji">${secret ? '❓' : iconSVG(a)}</div><span class="ach-rar">${R.label}</span></div>
        <div class="ach-name">${secret ? '???' : escapeHtml(a.name) + (a.tier >= 0 ? ` <span class="ach-tier">${['I', 'II', 'III'][a.tier] || ''}</span>` : '')}</div>
        <div class="ach-desc">${secret ? escapeHtml(a.hint || 'Секретная ачивка') : escapeHtml(a.desc)}</div>
        ${a.unlocked
          ? `<div class="ach-done">✓ получено${ach[a.id] ? ' · ' + new Date(ach[a.id]).toLocaleDateString() : ''}</div>`
          : secret
            ? `<div class="ach-done dim">🔒 секретная</div>`
            : `<div class="ach-progress"><div class="ach-bar"><div class="ach-bar-fill" style="width:${pct}%"></div></div><span>${a.value}/${a.need}</span></div>`}
      </div>`;
    };
    const sec = (title, pred) => {
      const all = cat.filter(pred);
      const shown = applyF(all);
      if (!shown.length) return '';
      const got = all.filter(a => a.unlocked).length;
      return `<h4 class="ach-sec">${title} <em>${got} / ${all.length}</em></h4>
        <div class="ach-grid">${shown.map(card).join('')}</div>`;
    };
    box.innerHTML = head + filters + '<div class="ach-body">'
      + sec('Общие', a => a.id.startsWith('g_'))
      + sec('<svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg>Артисты волны', a => a.id.startsWith('art'))
      + sec('<svg class="ic" viewBox="0 0 24 24"><use href="#i-note"/></svg>Треки волны', a => a.id.startsWith('trk_'))
      + sec('<svg class="ic" viewBox="0 0 24 24"><use href="#i-flame"/></svg>Тренды тиктока 2026', a => a.id.startsWith('tt_'))
      + `<button class="ach-expand" onclick="Ach.toggleExpand()" style="margin-top:14px"><svg class="ic" viewBox="0 0 24 24"><use href="#i-trophy"/></svg>Свернуть</button>`
      + '</div>';
  }

  function openVoAch() {
    switchView('vprofile'); // ачивки живут в профиле Волна ID
  }

  return { check, event, openVoAch, renderInto, catalog, summary, setFilter, levelInfo, toggleExpand };
})();
