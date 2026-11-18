import { defineConfig, type Plugin } from 'vite';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';

const root = import.meta.dirname;

// Every page is an index.html in its own folder (plus 404.html at the root).
function findPages(dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', 'src', 'public', 'test', 'contracts', 'partials', '.git'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) findPages(p, out);
    else if (name === 'index.html' || (dir === root && name === '404.html')) {
      const key = relative(root, p).replace(/\.html$/, '').replace(/[\\/]/g, '-') || 'index';
      out[key] = p;
    }
  }
  return out;
}

// Judge-bar copy on the apps, which do not load the marketing runtime.
const appCopy = `<script>
document.addEventListener('DOMContentLoaded',function(){
  var btn=document.querySelector('.judge-bar button[data-copy]');
  if(!btn)return;
  var label=btn.textContent||'Copy';
  btn.addEventListener('click',async function(){
    var src=document.querySelector(btn.getAttribute('data-copy'));
    var text=(src&&src.textContent||'').trim();
    try{await navigator.clipboard.writeText(text);btn.textContent='Copied';}
    catch{if(src){var r=document.createRange();r.selectNodeContents(src);var s=getSelection();if(s){s.removeAllRanges();s.addRange(r);}}btn.textContent='Selected, copy it';}
    setTimeout(function(){btn.textContent=label;},2200);
  });
});
</script>`;

// Shared partials, inlined at build time. Marks the current nav link.
function partials(): Plugin {
  const read = (n: string) => readFileSync(resolve(root, 'partials', n), 'utf8');
  return {
    name: 'holdfast-partials',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        let out = html.replace(/<!--\s*@include\s+([\w./-]+)\s*-->/g, (_, file) => read(file));
        out = out
          .replace('<!-- @banner -->', read('judge-bar.html') + appCopy)
          .replace('<!-- @header -->', read('header.html'))
          .replace('<!-- @footer -->', read('footer.html'));
        const file = ctx.filename ?? '';
        const rel = relative(root, dirname(file)).replace(/\\/g, '/');
        const route = '/' + (rel && rel !== '.' ? rel + '/' : '');
        if (route !== '/') {
          out = out.replace(
            new RegExp(`(<a[^>]*href="${route}"[^>]*data-nav)`, 'g'),
            '$1 aria-current="page"',
          );
        }
        if (!out.includes('og:image')) {
          const head = `
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png" />
    <link rel="icon" href="/favicon-16.png" sizes="16x16" type="image/png" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/site.webmanifest" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Holdfast" />
    <meta property="og:image" content="https://holdfast-bch.vercel.app/og.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="Holdfast: a vault a robber can't empty." />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content="https://holdfast-bch.vercel.app/og.png" />
    <script defer src="/_vercel/insights/script.js"></script>
  </head>`;
          out = out.replace(/\s*<link rel="icon" href="\/favicon.svg" type="image\/svg\+xml" \/>/, '');
          out = out.replace('</head>', head);
        }
        return out;
      },
    },
  };
}

export default defineConfig({
  plugins: [partials()],
  build: {
    target: 'es2022',
    modulePreload: {
      resolveDependencies(_filename, deps) {
        return deps.filter((dep) => !dep.includes('vault3d') && !dep.includes('three'));
      },
    },
    rollupOptions: {
      input: findPages(root),
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
        },
      },
    },
  },
});
