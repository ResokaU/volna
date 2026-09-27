/* фикс: renderIfOpen знает про uprofile */
const fs = require('fs');
let s = fs.readFileSync('renderer/social.js', 'utf8');
const from = "  if ($('#view-vprofile')?.classList.contains('active')) renderProfile($('#vprofile-wrap'));";
if (!s.includes(from)) { console.log('MISS'); process.exit(1); }
s = s.replace(from, from + "\n  if ($('#view-uprofile')?.classList.contains('active')) renderUProfile($('#uprofile-wrap'));");
fs.writeFileSync('renderer/social.js', s);
console.log('renderIfOpen fixed');
