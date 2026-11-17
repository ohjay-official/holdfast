export function mountDots(canvas: HTMLCanvasElement, reduced: boolean) {
  const ctx = canvas.getContext('2d')!;
  let W = 0, H = 0, dpr = 1, step = 18, raf = 0, visible = true;
  const mouse = { x: -1e4, y: -1e4, tx: -1e4, ty: -1e4 };
  const fract = (x: number) => x - Math.floor(x);
  const hash = (i: number, j: number, o: number) => fract(Math.sin(i * 127.1 + j * 311.7 + o) * 43758.5453);
  // colour ramp: deep green -> lit green -> pale mint
  const C0 = [10, 122, 90], C1 = [63, 164, 131], C2 = [201, 240, 220];
  const mix = (a: number[], b: number[], t: number) => a.map((v, k) => Math.round(v + (b[k] - v) * t));
  function resize() {
    const r = canvas.getBoundingClientRect(); dpr = Math.min(devicePixelRatio, 2);
    W = r.width; H = r.height; canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    step = Math.max(14, Math.min(W / 1600, H / 940) * 20.5);
  }
  function frame(t: number) {
    raf = 0; t /= 1000;
    mouse.x += (mouse.tx - mouse.x) * 0.12; mouse.y += (mouse.ty - mouse.y) * 0.12;
    ctx.clearRect(0, 0, W, H);
    const top = H * 0.18, full = H * 0.62;
    const cols = Math.ceil(W / step) + 1, rows = Math.ceil(H / step) + 1;
    for (let j = 0; j < rows; j++) {
      const y = j * step; if (y < top - 2 * step) continue;
      const v = Math.min(1, Math.max(0, (y - top) / (full - top)));
      const col = v < 0.55 ? mix(C0, C1, v / 0.55) : mix(C1, C2, Math.min(1, (v - 0.55) / 0.45) * (y > H * 0.9 ? 1 : 0.6));
      ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
      for (let i = 0; i < cols; i++) {
        const a = hash(i, j, 0), b = hash(i, j, 1.7), c = hash(i, j, 3.1);
        const keep = Math.min(1, v * 1.6 + 0.12) - a * 0.6;
        if (keep <= 0 && c > 0.08) continue;
        const wave = reduced ? 0.7 : 0.5 + 0.5 * Math.sin(t * (1.6 + b * 2.6) + a * Math.PI * 2 + Math.sin(t * 0.7 + i * 0.21 + j * 0.13) * 1.4);
        const x = i * step;
        const d2 = (x - mouse.x) ** 2 + (y - mouse.y) ** 2;
        const boost = 0.7 * Math.exp(-d2 / (step * step * 22));
        let s = (0.42 + 0.58 * Math.pow(wave, 1.3)) * Math.min(1, 0.5 + v * 0.6) * (keep > 0 ? 1 : 0.8);
        s = Math.min(1.05, s + boost);
        ctx.globalAlpha = 0.18 + 0.5 * v; // keep it a texture, never louder than the text
        ctx.beginPath(); ctx.arc(x, y, 0.37 * step * s * 0.55, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    if (!reduced && visible) raf = requestAnimationFrame(frame);
  }
  resize(); addEventListener('resize', () => { resize(); if (reduced) frame(0); });
  canvas.parentElement!.addEventListener('pointermove', e => { const r = canvas.getBoundingClientRect(); mouse.tx = e.clientX - r.left; mouse.ty = e.clientY - r.top; });
  canvas.parentElement!.addEventListener('pointerleave', () => { mouse.tx = mouse.ty = -1e4; });
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible && !raf) raf = requestAnimationFrame(frame); }).observe(canvas);
  frame(0);
}
