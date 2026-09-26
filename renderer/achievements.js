/* VOLNA · achievements.js — 🏆 VoКаунты: система ачивок.
   Каталог: общие (треки/время/лайки/плейлисты) + артисты чарта Я.Музыки (3 тира)
   + треки чарта. Прогресс считается из данных профиля; разблокировки хранятся
   в profile.data.ach (id → timestamp). */
window.Ach = (function () {
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
    { need: 3, label: 'Слушатель' },
    { need: 10, label: 'Фанат' },
    { need: 25, label: 'Одержимый' }
  ];
  // треки чарта: 3+ прослушиваний конкретного трека
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
  ]
  // общие ачивки: [id, emoji, name, desc, need, metric]
  const ACH_GENERAL = [
    ['g_pl1', '🌊', 'Первая волна', 'Прослушай первый трек', 1, 'played'],
    ['g_pl10', '⚡', 'Разогрев', 'Прослушай 10 треков', 10, 'played'],
    ['g_pl50', '🎧', 'В потоке', 'Прослушай 50 треков', 50, 'played'],
    ['g_pl100', '💯', 'Сотка', 'Прослушай 100 треков', 100, 'played'],
    ['g_pl250', '🌋', 'Маньяк волны', 'Прослушай 250 треков', 250, 'played'],
    ['g_pl1000', '👑', 'Легенда волны', 'Прослушай 1000 треков', 1000, 'played'],
    ['g_t1', '⏱', 'Первый час', 'Прослушай 1 час музыки', 1, 'hours'],
    ['g_t10', '🌙', 'Десять часов в волнах', 'Прослушай 10 часов', 10, 'hours'],
    ['g_t50', '🌆', 'Полсотни часов', 'Прослушай 50 часов', 50, 'hours'],
    ['g_t100', '🌌', 'Сутки волн', 'Прослушай 100 часов', 100, 'hours'],
    ['g_l1', '❤', 'Первое сердечко', 'Поставь первый лайк', 1, 'likes'],
    ['g_l10', '💞', 'Коллекционер чувств', 'Набери 10 лайков', 10, 'likes'],
    ['g_l50', '💘', 'Сердцеед', 'Набери 50 лайков', 50, 'likes'],
    ['g_l100', '💜', 'Сердце VOLNA', 'Набери 100 лайков', 100, 'likes'],
    ['g_p1', '📁', 'Сборщик', 'Создай первый плейлист', 1, 'playlists'],
    ['g_p5', '🗂', 'Архитектор', 'Создай 5 плейлистов', 5, 'playlists'],
    ['g_p10', '🏛', 'Магнат плейлистов', 'Создай 10 плейлистов', 10, 'playlists'],
    ['g_h25', '📜', 'Летопись', '25 треков в истории', 25, 'history'],
    ['g_h100', '📚', 'Хроника волны', '100 треков в истории', 100, 'history']
  ];

  function metrics() {
    const st = state.stats || {};
    return {
      played: st.totalPlayed || 0,
      hours: Math.floor((st.totalTime || 0) / 3600000),
      likes: (state.favorites || []).length,
      playlists: (state.playlists || []).length,
      history: (state.history || []).length,
      artistCount: name => (state.history || []).filter(t =>
        String(t.user && t.user.username || '').toLowerCase() === name.toLowerCase()).length,
      trackCount: title => (state.history || []).filter(t =>
        String(t.title || '').toLowerCase() === title.toLowerCase()).length
    };
  }

  // каталог карточек: {id, emoji, name, desc, tier, value, need, unlocked}
  function catalog() {
    const m = metrics();
    const out = [];
    for (const [id, emoji, name, desc, need, metric] of ACH_GENERAL) {
      const v = m[metric] || 0;
      out.push({ id, emoji, name, desc, tier: -1, value: v, need, unlocked: v >= need });
    }
    ACH_ARTISTS.forEach((a, ai) => {
      const cnt = m.artistCount(a.name);
      let tier = -1;
      ARTIST_TIERS.forEach((t, ti) => { if (cnt >= t.need) tier = ti; });
      const next = ARTIST_TIERS[tier + 1] || ARTIST_TIERS[0];
      out.push({
        id: `art${ai}_${tier >= 0 ? tier : 'x'}`, emoji: a.emoji, name: a.name,
        desc: 'Артист из чарта Я.Музыки', tier, value: cnt,
        need: tier >= ARTIST_TIERS.length - 1 ? ARTIST_TIERS[2].need : (tier >= 0 ? ARTIST_TIERS[tier + 1].need : ARTIST_TIERS[0].need),
        unlocked: tier >= 0
      });
    });
    for (const t of ACH_TRACKS) {
      const cnt = m.trackCount(t.title);
      out.push({
        id: 'trk_' + t.name.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '_'), emoji: t.emoji,
        name: t.name, desc: 'Трек из чарта: ' + t.title, tier: -1, value: cnt, need: 3,
        unlocked: cnt >= 3
      });
    }
    return out;
  }

  /* проверка новых разблокировок; тосты пачкой */
  function check() {
    const cat = catalog();
    const ach = state.ach || {};
    const fresh = cat.filter(a => a.unlocked && !ach[a.id]);
    fresh.forEach(a => { ach[a.id] = Date.now(); });
    state.ach = ach;
    if (fresh.length === 1) toast('🏆 Ачивка: ' + fresh[0].name, 'success');
    else if (fresh.length > 1) toast(`🏆 Разблокировано ачивок: ${fresh.length}!`, 'success');
    if (fresh.length && typeof persistQueueSoon === 'function') persistQueueSoon(); // триггер сохранения профиля
    return fresh.length;
  }

  function renderInto(box) {
    if (!box) return;
    const cat = catalog();
    const ach = state.ach || {};
    const unlocked = cat.filter(a => a.unlocked).length;
    const card = a => `
      <div class="ach-card${a.unlocked ? ' unlocked' : ''}">
        <div class="ach-emoji">${a.emoji}</div>
        <div class="ach-name">${escapeHtml(a.name)}${a.tier >= 0 ? ` <span class="ach-tier">${['I', 'II', 'III'][a.tier] || ''}</span>` : ''}</div>
        <div class="ach-desc">${escapeHtml(a.desc)}</div>
        ${a.unlocked
          ? `<div class="ach-done">✓ получено${ach[a.id] ? ' · ' + new Date(ach[a.id]).toLocaleDateString() : ''}</div>`
          : `<div class="ach-progress"><div class="ach-bar"><div class="ach-bar-fill" style="width:${Math.min(100, Math.round(a.value / a.need * 100))}%"></div></div><span>${a.value}/${a.need}</span></div>`}
      </div>`;
    box.innerHTML = `
      <div class="ach-head"><span class="ach-count">${unlocked} / ${cat.length}</span>
      <div class="ach-headbar"><div style="width:${Math.round(unlocked / cat.length * 100)}%"></div></div></div>
      <h4 class="ach-sec">Общие</h4>
      <div class="ach-grid">${cat.filter(a => a.id.startsWith('g_')).map(card).join('')}</div>
      <h4 class="ach-sec">🎤 Артисты чарта Я.Музыки</h4>
      <div class="ach-grid">${cat.filter(a => a.id.startsWith('art')).map(card).join('')}</div>
      <h4 class="ach-sec">🎵 Треки чарта</h4>
      <div class="ach-grid">${cat.filter(a => a.id.startsWith('trk_')).map(card).join('')}</div>`;
  }

  function openVoAch() {
    openModal('ach_modal');
    renderInto($('#ach-body'));
  }

  return { check, openVoAch, renderInto, catalog };
})();
