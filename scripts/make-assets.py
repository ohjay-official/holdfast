# Renders the favicon set and the Open Graph image from HTML/SVG with headless Chrome.
# Run: python3 scripts/make-assets.py   (needs playwright + Chrome)
import pathlib
from playwright.sync_api import sync_playwright
root = pathlib.Path(__file__).resolve().parent.parent
pub = root / 'public'
font = root / 'node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2'
serif = root / 'node_modules/@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2'
mark = '''<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><path d="M16 4l10 4.4v6.4c0 6.6-4.4 11-10 13.2C10.4 25.8 6 21.4 6 14.8V8.4z" fill="none" stroke="#0a7a5a" stroke-width="2.4" stroke-linejoin="round"/><circle cx="16" cy="14.2" r="2.7" fill="#0a7a5a"/><path d="M16 16.4v5" stroke="#0a7a5a" stroke-width="2.4" stroke-linecap="round"/></svg>'''
mark72 = mark.replace('<svg ', '<svg style="width:72%;height:72%" ')
mark44 = mark.replace('<svg ', '<svg style="width:44px;height:44px" ')
icon = lambda bg: '<html><body style="margin:0;background:' + bg + ';display:grid;place-items:center;width:100vw;height:100vh">' + mark72 + '</body></html>'
og = f'''<html><head><style>
@font-face{{font-family:B;src:url('file://{font}') format('woff2');font-weight:200 800}}
@font-face{{font-family:S;src:url('file://{serif}') format('woff2');font-weight:200 900}}
body{{margin:0;width:1200px;height:630px;background:#f2f3ef;font-family:B;color:#18201c;position:relative;overflow:hidden}}
.l{{position:absolute;left:72px;top:64px;display:flex;align-items:center;gap:14px;font-weight:700;font-size:34px;letter-spacing:-.02em}}
h1{{position:absolute;left:72px;top:150px;margin:0;font-size:88px;line-height:.98;letter-spacing:-.035em;font-weight:700;width:760px}}
p{{position:absolute;left:72px;top:372px;margin:0;font-family:S;font-size:28px;line-height:1.4;color:#2e3833;width:820px}}
.bar{{position:absolute;left:72px;right:72px;bottom:64px;height:30px;border-radius:5px;overflow:hidden;display:flex}}
.k{{position:absolute;right:72px;top:72px;font-size:22px;color:#56625c}}
</style></head><body>
<div class="l">{mark44}Holdfast</div>
<div class="k">Bitcoin Cash</div>
<h1>A vault a robber can't empty.</h1>
<p>Whoever holds your phone gets a small allowance. Everything else waits, and you can stop it from home.</p>
<div class="bar"><span style="width:5%;background:#a8432f"></span><span style="width:95%;background:repeating-linear-gradient(-45deg,#b9791a 0 14px,#cf9136 14px 28px)"></span></div>
</body></html>'''
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome')
    for size, name, bg in [(32, 'favicon-32.png', 'transparent'), (16, 'favicon-16.png', 'transparent'), (180, 'apple-touch-icon.png', '#f2f3ef'), (192, 'icon-192.png', '#f2f3ef'), (512, 'icon-512.png', '#f2f3ef')]:
        pg = b.new_page(viewport={'width': size, 'height': size})
        pg.set_content(icon(bg))
        pg.screenshot(path=str(pub / name), omit_background=(bg == 'transparent'))
    pg = b.new_page(viewport={'width': 1200, 'height': 630})
    tmp = root / 'scripts' / '_og.html'
    tmp.write_text(og)
    pg.goto(tmp.as_uri()); pg.wait_for_timeout(800)
    tmp.unlink()
    pg.screenshot(path=str(pub / 'og.png'))
    b.close()
print('ok')
