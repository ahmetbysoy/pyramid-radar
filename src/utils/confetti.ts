/**
 * Hafif canvas konfeti — dış bağımlılık yok.
 */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number;
  color: string;
  size: number;
  life: number;
  rot: number;
  vr: number;
  shape: 'rect' | 'circle';
}

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let particles: Particle[] = [];
let raf = 0;
let running = false;

const PALETTE_BUY = ['#34D399', '#10B981', '#22D3EE', '#A7F3D0', '#6EE7B7'];
const PALETTE_SELL = ['#F87171', '#EF4444', '#FB923C', '#FCA5A5', '#FBBF24'];

function ensureCanvas(): void {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99999;';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  ctx = canvas.getContext('2d');
  document.body.appendChild(canvas);
  const resize = () => {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  window.addEventListener('resize', resize);
}

function loop(): void {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  let alive = 0;
  for (const p of particles) {
    p.life -= 1;
    if (p.life <= 0) continue;
    alive++;
    p.vy += p.g;
    p.vx *= 0.995;
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vr;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.globalAlpha = Math.min(1, p.life / 40);
    ctx.fillStyle = p.color;
    if (p.shape === 'rect') {
      ctx.fillRect(-p.size, -p.size / 2, p.size * 2, p.size);
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  if (alive === 0) {
    running = false;
    if (canvas && canvas.parentNode) {
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      // Canvas'ı DOM'dan kaldır (boşuna yer tutmasın)
      canvas.remove();
      canvas = null;
      ctx = null;
      particles = [];
    }
    cancelAnimationFrame(raf);
    return;
  }
  raf = requestAnimationFrame(loop);
}

export function fireConfetti(side: 'BUY' | 'SELL' = 'BUY', originX = 0.5, originY = 0.4, count = 120): void {
  if (typeof window === 'undefined') return;
  ensureCanvas();
  if (!canvas || !ctx) return;
  const palette = side === 'BUY' ? PALETTE_BUY : PALETTE_SELL;
  for (let i = 0; i < count; i++) {
    const angle = (Math.random() - 0.5) * Math.PI * 1.2 - Math.PI / 2;
    const speed = 6 + Math.random() * 9;
    particles.push({
      x: canvas.width * originX,
      y: canvas.height * originY,
      vx: Math.cos(angle) * speed * (Math.random() > 0.5 ? 1 : -1) + (Math.random() - 0.5) * 2,
      vy: Math.sin(angle) * speed - 2,
      g: 0.18 + Math.random() * 0.08,
      color: palette[Math.floor(Math.random() * palette.length)],
      size: 3 + Math.random() * 5,
      life: 80 + Math.random() * 80,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      shape: Math.random() > 0.4 ? 'rect' : 'circle',
    });
  }
  if (!running) {
    running = true;
    raf = requestAnimationFrame(loop);
  }
}
