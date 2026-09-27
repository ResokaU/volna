/* v1.2 ч2: social.js — треки в чатах + следование за волной */
const fs = require('fs');
let s = fs.readFileSync('renderer/social.js', 'utf8');

// 1) приём трека
const evAnchor = "    } else if (ev.type === 'freq') { // заявка в друзья";
if (!s.includes(evAnchor)) { console.log('evAnchor MISS'); process.exit(1); }
const trackEv =
"    } else if (ev.type === 'track') { // друг скинул трек\n" +
"      const slim = ev.track;\n" +
"      if (!slim || !slim.id) return;\n" +
"      s.chats[ev.from] = s.chats[ev.from] || [];\n" +
"      s.chats[ev.from].push({ from: ev.from, kind: 'track', track: slim, ts: ev.ts || Date.now() });\n" +
"      if (s.chats[ev.from].length > 300) s.chats[ev.from] = s.chats[ev.from].slice(-300);\n" +
"      if (!(_openChat === ev.from && $('#view-people')?.classList.contains('active'))) s.unread[ev.from] = (s.unread[ev.from] || 0) + 1;\n" +
"      save(); updateBadge();\n" +
"      toast('🎵 ' + (findUser(ev.from).name || ('@' + ev.from)) + ' скинул трек: ' + String(slim.title || '').slice(0, 50), 'success');\n" +
"      renderIfOpen();\n";
s = s.replace(evAnchor, trackEv + evAnchor);

// 2) следование: при смене трека у друга — автоигр
const presOld = "          nowNp[m.h] = m.np; if (m.np.t !== prev) renderIfOpen(); }";
if (!s.includes(presOld)) { console.log('presOld MISS'); process.exit(1); }
const presNew =
"          nowNp[m.h] = m.np;\n" +
"          if (m.np.t !== prev) {\n" +
"            const sg = S();\n" +
"            if (sg.following === m.h && m.np.track && (!state.currentTrack || state.currentTrack.id !== m.np.track.id)) {\n" +
"              toast('🎙 Волна @' + m.h + ': ' + m.np.t, 'success');\n" +
"              playTrack(m.np.track, 'friend-follow');\n" +
"            }\n" +
"            renderIfOpen();\n" +
"          } }";
s = s.replace(presOld, presNew);

// 3) следование гаснет, если друг ушёл из сети
const beatOld = "    beatTimer = setInterval(() => { if (mq && mq.connected) adapter && adapter.presenceBeat(); }, PRESENCE_MS);";
if (!s.includes(beatOld)) { console.log('beatOld MISS'); process.exit(1); }
s = s.replace(beatOld,
"    beatTimer = setInterval(() => {\n" +
"      if (mq && mq.connected) adapter && adapter.presenceBeat();\n" +
"      const f = S().following;\n" +
"      if (f && !isOnline(f)) { unfollow(true); toast('👋 @' + f + ' не в сети — следование остановлено'); }\n" +
"    }, PRESENCE_MS);"
);

// 4) карточка трека в чате
const msgsAnchor = "          <div class=\"msg ${m.from === s.handle ? 'me' : 'them'}\"><div class=\"msg-txt\">${esc(m.text)}</div><div class=\"msg-ts\">${fmtChatTs(m.ts)}</div></div>`).join('')";
if (!s.includes(msgsAnchor)) { console.log('msgsAnchor MISS'); process.exit(1); }
const msgExpr =
"          <div class=\"msg ${m.from === s.handle ? 'me' : 'them'}\">" +
"${m.kind === 'track' && m.track ? (" +
"'<div class=\"msg-trk\" onclick=\"playChatTrack(' + m.ts + ')\" title=\"Слушать\">' + " +
"(() => { chatTrackReg[m.ts] = m.track; return m.track.artwork_url ? '<img src=\"' + esc(m.track.artwork_url) + '\" alt=\"\">' : ''; })() + " +
"'<div class=\"msg-trk-info\"><div class=\"msg-trk-t\">' + esc(m.track.title || '') + '</div><div class=\"msg-trk-a\">' + esc((m.track.user && m.track.user.username) || '') + '</div></div>' + " +
"'<svg class=\"ic fill\" viewBox=\"0 0 24 24\"><use href=\"#i-play\"/></svg></div>'" +
") : ('<div class=\"msg-txt\">' + esc(m.text) + '</div>')}" +
"<div class=\"msg-ts\">${fmtChatTs(m.ts)}</div></div>`).join('')";
s = s.replace(msgsAnchor, msgExpr);

// 5) follow-функции + реестр кликов + экспорты
const expAnchor = '  return {\n    init, use,';
if (!s.includes(expAnchor)) { console.log('expAnchor MISS'); process.exit(1); }
const add =
"  /* 🎵 отправить трек другу (контекстное меню) */\n" +
"  const chatTrackReg = {}; // ts → track\n" +
"  window.playChatTrack = ts => { const t = chatTrackReg[ts]; if (t && window.playTrack) playTrack(t, 'chat'); };\n" +
"  function sendTrackTo(h, track) {\n" +
"    const s = S();\n" +
"    if (!validHandle(h) || h === s.handle || !track) return;\n" +
"    if (!s.friends.includes(h)) { toast('Только друзьям — добавь @' + h + ' во вкладке «Люди»', 'error'); return; }\n" +
"    const slim = { id: track.id, title: track.title, duration: track.duration,\n" +
"      artwork_url: track.artwork_url, permalink_url: track.permalink_url,\n" +
"      user: { username: track.user && track.user.username } };\n" +
"    s.chats[h] = s.chats[h] || [];\n" +
"    s.chats[h].push({ from: s.handle, kind: 'track', track: slim, ts: Date.now() });\n" +
"    if (s.chats[h].length > 300) s.chats[h] = s.chats[h].slice(-300);\n" +
"    save(); ensureSubs();\n" +
"    adapter && adapter.deliver(h, { type: 'track', from: s.handle, ts: Date.now(), track: slim });\n" +
"    toast('🎵 Отправлено @' + h, 'success');\n" +
"    renderIfOpen();\n" +
"  }\n" +
"  /* 🎙 следовать за волной друга */\n" +
"  function followFriend(h) {\n" +
"    const s = S();\n" +
"    if (s.following === h) return unfollow();\n" +
"    if (!validHandle(h)) return;\n" +
"    s.following = h;\n" +
"    save();\n" +
"    showFollowChip();\n" +
"    toast('🎙 Слежу за волной @' + h + ' — треки переключаются сами', 'success');\n" +
"  }\n" +
"  function unfollow(silent) {\n" +
"    const s = S();\n" +
"    if (!s.following) return;\n" +
"    const who = s.following;\n" +
"    s.following = '';\n" +
"    save();\n" +
"    const chip = document.getElementById('follow-chip');\n" +
"    if (chip) chip.remove();\n" +
"    if (!silent) toast('Перестал следить за @' + who);\n" +
"  }\n" +
"  function showFollowChip() {\n" +
"    let chip = document.getElementById('follow-chip');\n" +
"    if (!chip) { chip = document.createElement('div'); chip.id = 'follow-chip'; document.body.appendChild(chip); }\n" +
"    chip.innerHTML = '<span class=\"fc-dot\"></span>🎙 Слежу за @' + escapeHtml(S().following) +\n" +
"      ' <button class=\"fc-x\" onclick=\"Social.unfollow()\" title=\"Перестать\">✕</button>';\n" +
"  }\n\n" +
"  return {\n    init, use,\n    sendTrackTo, followFriend, unfollow,";
s = s.replace(expAnchor, add);

// 6) восстановить чип после перезапуска, если следование сохранено
s = s.replace(
  "    updateBadge();\n  }\n\n  function use(a) { adapter = a; }",
  "    updateBadge();\n    if (S().following) showFollowChip();\n  }\n\n  function use(a) { adapter = a; }"
);
fs.writeFileSync('renderer/social.js', s);
console.log('social patched');
