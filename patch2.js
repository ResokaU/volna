/* v1.2: треки в чатах + следование — упрощённые патчи (без вложенных шаблонов) */
const fs = require('fs');

/* ---------- social.js ---------- */
let s = fs.readFileSync('renderer/social.js', 'utf8');

// 1) приём трека в onEvent
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

// 2) автопереключение при следовании (в приёме пульса)
const presAnchor = "        const prev = nowNp[m.h] && nowNp[m.h].t;";
if (!s.includes(presAnchor)) { console.log('presAnchor MISS'); process.exit(1); }
s = s.replace(presAnchor,
"        const prev = nowNp[m.h] && nowNp[m.h].t;\n" +
"        const _fsw = S().following;\n" +
"        const _fgo = _fsw === m.h && m.np && m.np.track && (!state.currentTrack || state.currentTrack.id !== m.np.track.id);");
s = s.replace(
  "          nowNp[m.h] = m.np; if (m.np.t !== prev) renderIfOpen(); }",
  "          nowNp[m.h] = m.np;\n" +
  "          if (m.np.t !== prev) {\n" +
  "            if (_fgo) { toast('🎙 Волна @' + m.h + ': ' + m.np.t, 'success'); playTrack(m.np.track, 'friend-follow'); }\n" +
  "            renderIfOpen();\n" +
  "          } }"
);

// 3) поддержание следования в пульсе
s = s.replace(
  "    beatTimer = setInterval(() => { if (mq && mq.connected) adapter && adapter.presenceBeat(); }, PRESENCE_MS);",
  "    beatTimer = setInterval(() => {\n" +
  "      if (mq && mq.connected) adapter && adapter.presenceBeat();\n" +
  "      if (S().following && !isOnline(S().following)) { unfollow(); toast('@' + S().following ? '' : ''); }\n" +
  "    }, PRESENCE_MS);"
);
// тост в 3-м пункте кривой — упростим: тихий unfollow
s = s.replace(
  "      if (S().following && !isOnline(S().following)) { unfollow(); toast('@' + S().following ? '' : ''); }",
  "      if (S().following && !isOnline(S().following)) unfollow(true);"
);

// 4) чат: карточка трека
const msgsAnchor = '          <div class="msg ${m.from === s.handle ? \'me\' : \'them\'}"><div class="msg-txt">${esc(m.text)}</div><div class="msg-ts">${fmtChatTs(m.ts)}</div></div>`).join(\'\')';
if (!s.includes(msgsAnchor)) { console.log('msgsAnchor MISS'); process.exit(1); }
const msgsNew =
"          <div class=\"msg ${m.from === s.handle ? 'me' : 'them'}\">" +
"#{MSG}" +
"<div class=\"msg-ts\">${fmtChatTs(m.ts)}</div></div>`).join('')";
const msgTpl =
"${m.kind === 'track' && m.track ? (" +
"'<div class=\"msg-trk\" onclick=\"playChatTrack(' + m.ts + ')\" title=\"Слушать\">' + " +
"(() => { chatTrackReg[m.ts] = m.track; return m.track.artwork_url ? '<img src=\"' + esc(m.track.artwork_url) + '\" alt=\"\">' : ''; })() + " +
"'<div class=\"msg-trk-info\"><div class=\"msg-trk-t\">' + esc(m.track.title || '') + '</div><div class=\"msg-trk-a\">' + esc((m.track.user && m.track.user.username) || '') + '</div></div>' + " +
"'<svg class=\"ic fill\" viewBox=\"0 0 24 24\"><use href=\"#i-play\"/></svg></div>'" +
") : ('<div class=\"msg-txt\">' + esc(m.text) + '</div>')}";
s = s.replace(msgsAnchor, msgsNew.replace('#{MSG}', msgTpl));

// 5) реестр треков + follow-функции перед экспортами
const expAnchor = '  return {\n    init, use,';
if (!s.includes(expAnchor)) { console.log('expAnchor MISS'); process.exit(1); }
const add =
"  window.playChatTrack = ts => { const t = chatTrackReg[ts]; if (t && window.playTrack) playTrack(t, 'chat'); };\n\n" +
"  return {\n    init, use,\n    sendTrackTo, followFriend, unfollow,";
s = s.replace(expAnchor, add);
fs.writeFileSync('renderer/social.js', s);
console.log('social patched');
