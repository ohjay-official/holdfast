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

// Shared header, footer and judge banner, filled in at build time.
function partials(): Plugin {
  const read = (n: string) => readFileSync(resolve(root, 'partials', n), 'utf8');
  return {
    name: 'holdfast-partials',
    transformIndexHtml: { order: 'pre', handler(html, ctx) {
      const file = ctx.filename ?? '';
      const rel = relative(root, dirname(file)).replace(/\\/g, '/');
      const route = '/' + (rel ? rel + '/' : '');
      let header = read('header.html');
      header = header.replace(/href="([^"]+)"( data-nav)/g, (m, href, rest) =>
        href === route ? `href="${href}" aria-current="page"${rest}` : m,
      );
      return html
        .replace('<!-- @banner -->', read('banner.html'))
        .replace('<!-- @header -->', header)
        .replace('<!-- @footer -->', read('footer.html'));
    } },
  };
}

export default defineConfig({
  build: {
    target: 'es2022',
    rollupOptions: { input: findPages(root) },
  },
  plugins: [partials()],
});
