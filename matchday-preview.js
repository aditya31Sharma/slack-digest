// Staging preview for the Matchday Deal. Renders the WC banner exactly as it would
// sit on the storefront; tapping it opens a desktop modal / mobile bottom-sheet showing
// yesterday's match results, total goals, today's discount, and the copy-able code.
// This is a self-contained page served by the bot - it touches no Shopify theme + no checkout.

function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

function matchdayPreviewHtml(deal, desktopB64, mobileB64) {
  const d = deal;
  const validIST = new Date(new Date(d.validUntilUtc).getTime() + 5.5 * 3600 * 1000)
    .toISOString().slice(0, 16).replace('T', ' ');
  const rows = d.matches.map(m => {
    const [a, sc, b] = m.teams.match(/^(.*?)\s(\d+-\d+)\s(.*)$/)?.slice(1) || [m.teams, '', ''];
    return `<div class=match><span class=t>${esc(a)}</span><span class=sc>${esc(sc)}</span><span class="t r">${esc(b)}</span></div>`;
  }).join('');

  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Matchday Deal · staging preview</title>
<link rel=preconnect href="https://fonts.googleapis.com"><link rel=preconnect href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Manrope:wght@500;700;800&display=swap" rel=stylesheet>
<style>
:root{--bg:#070a08;--fg:#f3f6f3;--mut:#9aa79d;--pitch:#16db65;--ball:#e9ee2a;--line:#222b25}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg);color:var(--fg);font:16px/1.55 Manrope,-apple-system,Segoe UI,Roboto,sans-serif}
.staging{position:fixed;top:0;left:0;right:0;z-index:50;background:#111;color:#9aa79d;font:600 12px/1 Manrope;letter-spacing:.04em;text-align:center;padding:7px;border-bottom:1px solid var(--line)}
.nav{display:flex;align-items:center;justify-content:center;height:58px;border-bottom:1px solid var(--line);margin-top:29px;position:relative}
.nav .logo{font:400 22px/1 Anton;letter-spacing:.12em}
.wrap{max-width:1200px;margin:0 auto}
/* banner */
.banner{display:block;width:100%;border:0;padding:0;cursor:pointer;background:#000;position:relative;overflow:hidden}
.banner img{display:block;width:100%;height:auto}
.banner .taphint{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);background:rgba(0,0,0,.6);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,.25);border-radius:999px;color:#fff;font:700 12px/1 Manrope;letter-spacing:.04em;padding:9px 16px;animation:pulse 1.8s infinite}
@keyframes pulse{0%,100%{opacity:.85}50%{opacity:.4}}
.pic-d{display:none}.pic-m{display:block}
@media(min-width:760px){.pic-d{display:block}.pic-m{display:none}}
.note{color:var(--mut);font-size:13px;text-align:center;padding:18px 16px 60px}
/* dialog */
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(3px);z-index:100;opacity:0;pointer-events:none;transition:.25s}
.scrim.on{opacity:1;pointer-events:auto}
.sheet{position:fixed;z-index:101;background:linear-gradient(180deg,#0f1511,#0b0f0c);border:1px solid var(--line);color:var(--fg);
  /* desktop modal */ left:50%;top:50%;transform:translate(-50%,-46%) scale(.96);width:min(520px,92vw);max-height:88vh;overflow:auto;border-radius:22px;opacity:0;pointer-events:none;transition:.28s cubic-bezier(.2,.8,.2,1)}
.sheet.on{opacity:1;pointer-events:auto;transform:translate(-50%,-50%) scale(1)}
@media(max-width:640px){
  .sheet{left:0;right:0;bottom:0;top:auto;width:100%;max-height:90vh;transform:translateY(100%);border-radius:22px 22px 0 0;border-bottom:0}
  .sheet.on{transform:translateY(0)}
  .grip{width:42px;height:5px;background:#39433b;border-radius:3px;margin:10px auto 2px}
}
@media(min-width:641px){.grip{display:none}}
.body{padding:8px 22px 26px}
.kick{font:700 11px/1 Manrope;letter-spacing:.22em;text-transform:uppercase;color:var(--pitch);text-align:center;margin:12px 0 2px}
.h{font:400 26px/1 Anton;text-transform:uppercase;text-align:center;margin:0 0 2px}
.win{color:var(--mut);font-size:12px;text-align:center;margin-bottom:16px}
.matches{border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-bottom:18px}
.match{display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center;padding:11px 14px;border-bottom:1px solid var(--line);font-size:14px}
.match:last-child{border-bottom:0}.match .t{font-weight:700}.match .t.r{text-align:right}
.match .sc{font:700 14px/1 'JetBrains Mono',monospace;background:#05210f;color:var(--pitch);border-radius:7px;padding:5px 9px}
.tot{display:flex;align-items:baseline;justify-content:center;gap:10px;margin:6px 0 14px}
.tot .n{font:400 54px/1 Anton;color:#fff}.tot .l{color:var(--mut);text-transform:uppercase;font:700 12px/1 Manrope;letter-spacing:.12em}
.deal{background:radial-gradient(400px 160px at 50% 0,rgba(22,219,101,.22),transparent),#0c130e;border:1px solid rgba(22,219,101,.4);border-radius:16px;padding:18px;text-align:center;margin-bottom:16px}
.deal .off{font:400 56px/.95 Anton;color:var(--pitch)}
.deal .sub{color:var(--mut);font-size:12px;margin-top:2px}
.code{display:flex;gap:10px;align-items:stretch;margin-bottom:10px}
.code .c{flex:1;border:1.5px dashed var(--ball);border-radius:12px;display:flex;align-items:center;justify-content:center;font:700 24px/1 'JetBrains Mono',monospace;letter-spacing:.1em;color:var(--ball);background:#13140a}
.code button{border:0;border-radius:12px;background:var(--ball);color:#1a1a00;font:800 14px/1 Manrope;padding:0 18px;cursor:pointer}
.code button:active{transform:scale(.97)}
.applynote{color:var(--mut);font-size:12.5px;text-align:center;line-height:1.5}
.applynote b{color:var(--fg)}
.x{position:absolute;top:10px;right:14px;background:none;border:0;color:var(--mut);font-size:26px;cursor:pointer;line-height:1}
.claimed{display:none;color:var(--pitch);font-weight:700;text-align:center;margin-top:8px}
</style></head><body>
<div class=staging>STAGING PREVIEW · not live · no checkout touched</div>
<div class=nav><div class=logo>MYUGEN</div></div>

<div class=wrap>
  <button class=banner id=banner aria-label="Open matchday deal">
    <img class=pic-d src="data:image/webp;base64,${desktopB64}" alt="World Cup Matchday Deal">
    <img class=pic-m src="data:image/webp;base64,${mobileB64}" alt="World Cup Matchday Deal">
    <span class=taphint>⚽ Tap for today's goal discount →</span>
  </button>
  <div class=note>This is the live banner. Tap it to see today's deal (desktop = modal, mobile = bottom-sheet).</div>
</div>

<div class=scrim id=scrim></div>
<div class=sheet id=sheet role=dialog aria-modal=true>
  <div class=grip></div>
  <button class=x id=close aria-label=Close>&times;</button>
  <div class=body>
    <div class=kick>Yesterday's Matchday</div>
    <div class=h>The goals are in ⚽</div>
    <div class=win>${esc(d.windowStartIST)} → ${esc(d.windowEndIST)} IST</div>
    <div class=matches>${rows}</div>
    <div class=tot><span class=n>${d.goals}</span><span class=l>total goals scored</span></div>
    <div class=deal>
      <div class=off>${d.percent}% OFF</div>
      <div class=sub>today only · ${d.goals} goals × 5%</div>
    </div>
    <div class=code><div class=c id=codeval>${esc(d.code)}</div><button id=copy>COPY</button></div>
    <div class=claimed id=claimed>✓ Code copied - paste it at cart</div>
    <div class=applynote>Apply <b>${esc(d.code)}</b> at the cart and your total drops <b>before</b> payment.<br>Valid until <b>${validIST} IST</b> · one use per device.</div>
  </div>
</div>

<script>
var scrim=document.getElementById('scrim'),sheet=document.getElementById('sheet');
function open(){scrim.classList.add('on');sheet.classList.add('on');document.body.style.overflow='hidden';}
function close(){scrim.classList.remove('on');sheet.classList.remove('on');document.body.style.overflow='';}
document.getElementById('banner').addEventListener('click',open);
document.getElementById('close').addEventListener('click',close);
scrim.addEventListener('click',close);
document.getElementById('copy').addEventListener('click',function(){
  var code=${JSON.stringify(d.code)};
  (navigator.clipboard&&navigator.clipboard.writeText(code))||(function(){var t=document.createElement('textarea');t.value=code;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();})();
  document.getElementById('claimed').style.display='block';
  try{localStorage.setItem('matchday_claim_'+code,'1');}catch(e){}
});
// once-per-device demo: if already claimed today, hint it
try{ if(localStorage.getItem('matchday_claim_'+${JSON.stringify(d.code)})){ /* could disable re-copy */ } }catch(e){}
</script>
</body></html>`;
}

module.exports = { matchdayPreviewHtml };
