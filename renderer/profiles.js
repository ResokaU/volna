/* VOLNA · profiles.js — 👤 профили: у каждого свои лайки, история, плейлисты, статистика.
   Данные хранятся локально; активный профиль = топ-уровень стора (см. main.js). */
window.Profiles = (function () {
  let cache = { profiles: [], active: null };
  let avatarTarget = null;

  async function init() {
    await refresh();
  }

  async function refresh() {
    try { cache = await ipc.invoke('profiles:get') || cache; } catch (_) {}
    renderAccount();
    renderList();
  }

  function stash() {
    return {
      favorites: state.favorites, history: state.history, playlists: state.playlists,
      stats: state.stats, lastTrack: state.lastTrack
    };
  }

  function applyData(d) {
    state.favorites = d.favorites || [];
    state.history = d.history || [];
    state.playlists = d.playlists || [];
    state.stats = d.stats || { totalPlayed: 0, totalTime: 0, sessionStart: Date.now() };
    state.lastTrack = d.lastTrack || null;
    state.serverLikes = []; state.favSource = 'local';
    state.listenedCounted = false;
  }

  async function switchTo(id) {
    if (!id || id === cache.active) { closeModal('profiles_modal'); return; }
    await ipc.invoke('profiles:stash', stash());
    const data = await ipc.invoke('profiles:switch', id);
    cache.active = id;
    applyData(data || {});
    updateBadges();
    if (typeof renderQueue === 'function') renderQueue();
    if (typeof renderHome === 'function') renderHome();
    if ($('#view-favorites')?.classList.contains('active')) renderFavorites();
    if ($('#view-history')?.classList.contains('active')) renderHistory();
    if ($('#view-playlists')?.classList.contains('active')) renderPlaylists();
    if ($('#view-stats')?.classList.contains('active')) renderStats();
    if (typeof updateTitle === 'function') updateTitle();
    await refresh();
    const p = cache.profiles.find(x => x.id === id);
    toast('👤 Профиль: ' + (p ? p.name : id), 'success');
  }

  async function create() {
    const el = $('#profile-new-name');
    const name = (el ? el.value : '').trim();
    if (!name) { toast('Введи имя профиля', 'error'); return; }
    if (el) el.value = '';
    await ipc.invoke('profiles:stash', stash());
    await ipc.invoke('profiles:create', name);
    await refresh();
    toast('👤 Профиль «' + name + '» создан — жми «Войти»', 'success');
  }

  async function rename(id) {
    const row = document.querySelector('.profile-row[data-id="' + id + '"] .profile-name');
    if (!row) return;
    const old = row.textContent;
    row.innerHTML = '<input class="profile-rename" value="' + escapeHtml(old) + '">';
    const input = row.querySelector('input');
    input.focus(); input.select();
    let done = false;
    const save = async () => {
      if (done) return;
      done = true;
      const name = input.value.trim() || old;
      await ipc.invoke('profiles:rename', { id, name });
      await refresh();
    };
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') save();
      if (ev.key === 'Escape') { done = true; refresh(); }
    });
    input.addEventListener('blur', save);
  }

  async function remove(id) {
    const p = cache.profiles.find(x => x.id === id);
    if (!p) return;
    if (id === cache.active) { toast('Сначала переключись на другой профиль', 'error'); return; }
    await ipc.invoke('profiles:delete', id);
    await refresh();
    toast('🗑 Профиль «' + p.name + '» удалён');
  }

  function pickAvatar(id) {
    avatarTarget = id;
    const inp = $('#avatar-file');
    if (inp) { inp.value = ''; inp.click(); }
  }

  function avatarChosen(ev) {
    const f = ev.target.files && ev.target.files[0];
    if (!f || !avatarTarget) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = async () => {
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const x = c.getContext('2d');
        const s = Math.min(img.width, img.height);
        x.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128);
        await ipc.invoke('profiles:avatar', { id: avatarTarget, avatar: c.toDataURL('image/jpeg', 0.85) });
        avatarTarget = null;
        await refresh();
        toast('🖼 Аватар обновлён', 'success');
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(f);
  }

  function renderAccount() {
    const p = cache.profiles.find(x => x.id === cache.active);
    const nameEl = $('#ap-name'), avEl = $('#ap-avatar'), subEl = $('#ap-sub');
    if (!nameEl) return;
    nameEl.textContent = p ? p.name : 'Профиль';
    if (p && p.avatar) { avEl.style.backgroundImage = 'url(' + p.avatar + ')'; avEl.textContent = ''; }
    else { avEl.style.backgroundImage = ''; avEl.textContent = p && p.name ? p.name[0].toUpperCase() : 'V'; }
    if (subEl) subEl.textContent = p && p.id === cache.active ? 'Профили и данные' : 'Профили';
  }

  function renderList() {
    const box = $('#profiles-list');
    if (!box) return;
    box.innerHTML = cache.profiles.map(p => `
      <div class="profile-row${p.id === cache.active ? ' active' : ''}" data-id="${p.id}">
        ${p.avatar
          ? `<img class="profile-ava" src="${p.avatar}" alt="">`
          : `<div class="profile-ava">${(p.name || '?')[0].toUpperCase()}</div>`}
        <span class="profile-name">${escapeHtml(p.name)}</span>
        ${p.id === cache.active ? '<span class="profile-active">активный</span>' : ''}
        <span class="profile-acts">
          ${p.id !== cache.active ? `<button class="md-btn" onclick="Profiles.switchTo('${p.id}')">Войти</button>` : ''}
          <button class="md-btn" onclick="Profiles.pickAvatar('${p.id}')" title="Аватар">🖼</button>
          <button class="md-btn" onclick="Profiles.rename('${p.id}')" title="Переименовать">✏️</button>
          ${p.id !== cache.active ? `<button class="md-btn" onclick="Profiles.remove('${p.id}')" title="Удалить">🗑</button>` : ''}
        </span>
      </div>`).join('');
  }

  return {
    init, refresh, switchTo, create, rename, remove, pickAvatar, avatarChosen,
    renderAccount, renderList,
    get active() { return cache.active; },
    get profiles() { return cache.profiles; }
  };
})();

if ($('#avatar-file')) $('#avatar-file').addEventListener('change', ev => Profiles.avatarChosen(ev));
Profiles.init();

function openProfilesModal() {
  openModal('profiles_modal');
  if (window.Profiles) Profiles.refresh();
}
