/**
 * WebAudio ses efektleri — harici dosya yok, saf oscilatör ile sentez.
 * Ses kapalıyken sessizce geç.
 */

let ctx: AudioContext | null = null;
let enabled = true;

function getCtx(): AudioContext | null {
  if (!enabled) return null;
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => { /* ignore */ });
  }
  return ctx;
}

export function setSoundEnabled(v: boolean): void {
  enabled = v;
}
export function isSoundEnabled(): boolean {
  return enabled;
}

export function tone(freq: number, durationMs: number, type: OscillatorType = 'sine', gain = 0.12, freqEnd?: number): void {
  const ac = getCtx();
  if (!ac) return;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ac.currentTime);
  if (freqEnd != null) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), ac.currentTime + durationMs / 1000);
  }
  g.gain.setValueAtTime(0, ac.currentTime);
  g.gain.linearRampToValueAtTime(gain, ac.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + durationMs / 1000);
  osc.connect(g).connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + durationMs / 1000 + 0.02);
}

/** Küçük mikro ticaret tıkırtısı. tierIdx < 0 → sessiz */
export function playTick(side: 'BUY' | 'SELL', tierIdx = 0): void {
  if (tierIdx < 0) return;
  const base = side === 'BUY' ? 600 : 440;
  const freq = base + tierIdx * 60;
  tone(freq, 60, 'square', 0.04);
}

/** Yeni piramit katmanı eklendi */
export function playLayerAdded(level: number): void {
  // Her katmanda ton yükselir (arp eşik yukarı)
  const base = 300 + level * 80;
  tone(base, 120, 'triangle', 0.14, base * 1.5);
  setTimeout(() => tone(base * 1.25, 140, 'triangle', 0.10, base * 2), 70);
}

/** Katman silindi */
export function playLayerRemoved(level: number): void {
  const base = 400 - level * 40;
  tone(base, 140, 'sawtooth', 0.10, base * 0.7);
}

/** Piramit yıkıldı (wreck) */
export function playWreck(side: 'BUY' | 'SELL'): void {
  const start = side === 'BUY' ? 500 : 200;
  const end = side === 'BUY' ? 80 : 400;
  tone(start, 500, 'sawtooth', 0.20, end);
  setTimeout(() => tone(120, 300, 'square', 0.12, 60), 150);
}

/** Yeni güçlü sinyal */
export function playSignal(signal: 'BUY' | 'SELL' | 'WAIT'): void {
  if (signal === 'BUY') {
    tone(523, 120, 'sine', 0.15);
    setTimeout(() => tone(659, 120, 'sine', 0.15), 100);
    setTimeout(() => tone(784, 200, 'sine', 0.15), 200);
  } else if (signal === 'SELL') {
    tone(392, 120, 'sine', 0.15);
    setTimeout(() => tone(311, 120, 'sine', 0.15), 100);
    setTimeout(() => tone(262, 200, 'sine', 0.15), 200);
  }
}

/** Mega/whale alım satım uyarısı */
export function playWhaleAlert(side: 'BUY' | 'SELL'): void {
  tone(side === 'BUY' ? 880 : 220, 240, 'triangle', 0.18, side === 'BUY' ? 1320 : 110);
}
