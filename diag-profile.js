/* диагностика renderProfile с данными пользователя */
const src = require('fs').readFileSync('renderer/social.js', 'utf8');
const achSrc = require('fs').readFileSync('renderer/achievements.js', 'utf8');
global.window = {};
global.state = {
  settings: { ghToken: 'x' },
  social: {
    handle: 'owner', name: '', bio: 'окек', status: 'вкуснюта', following: '',
    friends: [], follows: [], requestsIn: [], requestsOut: [], chats: {}, unread: {},
    np: { t: 'GOOSE COAT', a: 'Surt7', art: '' },
    banner: 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
  },
  stats: { totalPlayed: 193, totalTime: 58111640 },
  favorites: [], playlists: [], history: [
    { id: 1, title: 'madk1d - Давно', duration: 98000, artwork_url: 'https://i1.sndcdn.com/a.jpg', permalink_url: 'https://sc.test/1', user: { username: 'staffkarp' } }
  ],
  ach: { g_pl1: 1, g_pl10: 2, g_l1: 3 },
  achx: { ev: { vibe: 2, eq: 1 }, streak: { last: '2026-09-27', n: 3 }, night: 4 },
  currentTrack: { id: 9, title: 'GOOSE COAT', duration: 170000, artwork_url: 'https://i1.sndcdn.com/b.jpg', permalink_url: 'https://sc.test/9', user: { username: 'Surt7' } },
  lastTrack: null, trackIndex: new Map(), listenedCounted: false, serverLikes: [], favSource: 'local'
};
global.localStorage = { getItem: () => null, setItem: () => { } };
global.escapeHtml = s => String(s);
global.toast = () => { }; global.persistQueueSoon = () => { }; global.switchView = v => { global._sw = v; };
global.plural = (n, a) => a; global.artwork = t => (t && t.artwork_url) || ''; global.playTrack = () => { };
global.highlightPlaying = () => { }; global.trackCardHTML = () => '<div class="track-card"></div>'; global.emptyHTML = () => '<div></div>';
global.$ = sel => ({ classList: { contains: () => true }, innerHTML: '', style: {}, addEventListener: () => { }, textContent: '' });
global.$$ = () => [];
global.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, appendChild: () => { }, classList: { add: () => { } }, remove: () => { }, innerHTML: '', getContext: () => ({ drawImage: () => { }, getImageData: () => ({ data: new Uint8Array(2304) }) }), toDataURL: () => 'data:image/jpeg;base64,x', width: 0, height: 0 }),
  body: { style: { setProperty: () => { }, removeProperty: () => { } }, appendChild: () => { } },
  activeElement: null, addEventListener: () => { }
};
global.ipc = { invoke: async () => ({ ok: true, gists: [], content: JSON.stringify({ v: 1, users: {} }) }) };
global.lsGet = () => ({}); global.lsSet = () => { };
global.window.mqtt = { connect: () => { throw new Error('no net'); } };
global.Profiles = { profiles: [{ id: 'p1', name: 'макс админка 2011', avatar: '' }], active: 'p1', persist: () => {} };


eval(achSrc); global.Ach = window.Ach;
eval(src);
const S = window.Social;

let captured = ''; const box = { set innerHTML(v) { captured = v; }, get innerHTML() { return captured; } };
try {
  S.renderProfile(box);
  console.log('NO THROW — render OK, length:', captured.length);
  console.log('has name:', captured.includes('макс админка 2011') || captured.includes('Тест'));
  console.log('has listening:', captured.includes('Слушает:'));
  console.log('has banner img:', captured.includes('vp-banner-img'));
  console.log('has ach block:', captured.includes('ach-minirow') || captured.includes('ach-head'));
  console.log('has friends empty:', captured.includes('Пока пусто'));
  console.log('has recent shelf:', captured.includes('vp-recent'));
} catch (e) {
  console.log('THROW:', e.message);
  console.log(e.stack.split('\n').slice(0, 4).join('\n'));
}
