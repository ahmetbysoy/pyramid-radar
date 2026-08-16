import type { Depth, MarkPrice, Trade, WsStatus } from '../../types';

/**
 * Binance USDⓈ-M Futures WebSocket adapter'ı.
 *
 * Yeni routing (2026):
 *   - Public (yüksek frekans depth): wss://fstream.binance.com/public/ws
 *   - Market  (aggTrade, markPrice): wss://fstream.binance.com/market/ws
 */

const PUBLIC_URL = 'wss://fstream.binance.com/public/ws';
const MARKET_URL = 'wss://fstream.binance.com/market/ws';

interface Handlers {
  onTrade(t: Trade): void;
  onDepth(d: Depth): void;
  onMark(m: MarkPrice): void;
  onStatus(s: WsStatus): void;
}

export class BinanceFuturesAdapter {
  private symbols: string[];
  private publicWs: WebSocket | null = null;
  private marketWs: WebSocket | null = null;
  private handlers: Handlers;
  private publicReady = false;
  private marketReady = false;
  private destroyed = false;
  private publicRetry: ReturnType<typeof setTimeout> | null = null;
  private marketRetry: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;

  constructor(symbols: string[], handlers: Handlers) {
    this.symbols = symbols.map((s) => s.toLowerCase());
    this.handlers = handlers;
  }

  connect(): void {
    this.destroyed = false;
    this._connectPublic();
    this._connectMarket();
  }

  disconnect(): void {
    this.destroyed = true;
    this._clearTimeouts();
    this._close(this.publicWs);
    this._close(this.marketWs);
    this.publicWs = null;
    this.marketWs = null;
  }

  updateSymbols(symbols: string[]): void {
    this.symbols = symbols.map((s) => s.toLowerCase());
    // Yeniden bağlan
    this.disconnect();
    this.backoffMs = 1000;
    this.connect();
  }

  private _close(ws: WebSocket | null): void {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try { ws.close(); } catch { /* ignore */ }
  }

  private _clearTimeouts(): void {
    if (this.publicRetry) { clearTimeout(this.publicRetry); this.publicRetry = null; }
    if (this.marketRetry) { clearTimeout(this.marketRetry); this.marketRetry = null; }
  }

  private _connectPublic(): void {
    if (this.destroyed) return;
    if (this.symbols.length === 0) return;

    // Stream adı: <sym>@depth20@100ms
    const streams = this.symbols.map((s) => `${s}@depth20@100ms`).join('/');
    const url = `${PUBLIC_URL}/${streams}`;
    try {
      const ws = new WebSocket(url);
      this.publicWs = ws;
      this.handlers.onStatus('connecting');

      ws.onopen = () => {
        if (this.destroyed) { ws.close(); return; }
        this.publicReady = true;
        this._maybeLive();
      };

      ws.onmessage = (ev) => this._handlePublicMessage(ev.data);

      ws.onerror = () => this._scheduleReconnect('public');
      ws.onclose = () => {
        if (!this.destroyed) this._scheduleReconnect('public');
      };
    } catch {
      this._scheduleReconnect('public');
    }
  }

  private _connectMarket(): void {
    if (this.destroyed) return;
    if (this.symbols.length === 0) return;

    const streams = this.symbols
      .map((s) => `${s}@aggTrade/${s}@markPrice@1s`)
      .join('/');
    const url = `${MARKET_URL}/${streams}`;
    try {
      const ws = new WebSocket(url);
      this.marketWs = ws;

      ws.onopen = () => {
        if (this.destroyed) { ws.close(); return; }
        this.marketReady = true;
        this._maybeLive();
      };

      ws.onmessage = (ev) => this._handleMarketMessage(ev.data);

      ws.onerror = () => this._scheduleReconnect('market');
      ws.onclose = () => {
        if (!this.destroyed) this._scheduleReconnect('market');
      };
    } catch {
      this._scheduleReconnect('market');
    }
  }

  private _maybeLive(): void {
    if (this.publicReady && this.marketReady) {
      this.handlers.onStatus('live');
      this.backoffMs = 1000;
    }
  }

  private _scheduleReconnect(which: 'public' | 'market'): void {
    if (this.destroyed) return;
    this.handlers.onStatus('reconnecting');
    const delay = Math.min(this.backoffMs, 30_000);
    this.backoffMs *= 2;
    const t = setTimeout(() => {
      if (this.destroyed) return;
      if (which === 'public') {
        this._close(this.publicWs);
        this._connectPublic();
      } else {
        this._close(this.marketWs);
        this._connectMarket();
      }
    }, delay);
    if (which === 'public') this.publicRetry = t;
    else this.marketRetry = t;
  }

  private _handlePublicMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as { stream?: string; data?: unknown };
      if (msg.stream && msg.data) {
        // Combined stream: { stream, data }
        const stream = msg.stream;
        const data = msg.data as {
          e?: string;
          s?: string;
          E?: number;
          T?: number;
          b?: string[][];
          a?: string[][];
        };
        const sym = (data.s ?? stream.split('@')[0]).toUpperCase();
        const ts = (data.E ?? Date.now());

        if (data.b && data.a && stream.includes('depth')) {
          const depth: Depth = {
            ts,
            symbol: sym,
            bids: (data.b).map(([p, q]) => [parseFloat(p), parseFloat(q)] as [number, number]),
            asks: (data.a).map(([p, q]) => [parseFloat(p), parseFloat(q)] as [number, number]),
          };
          this.handlers.onDepth(depth);
        }
      }
    } catch {
      // JSON hatası
    }
  }

  private _handleMarketMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as { stream?: string; data?: unknown };
      if (!msg.stream || !msg.data) return;
      const stream = msg.stream;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = msg.data as any;
      const sym = (data.s ?? stream.split('@')[0]).toUpperCase();
      const ts = (data.T ?? data.E ?? Date.now()) as number;

      if (stream.includes('aggTrade')) {
        // m: true → buyer is market maker → aggressive side = SELL
        const t: Trade = {
          ts,
          symbol: sym,
          price: parseFloat(data.p),
          qty: parseFloat(data.q),
          side: data.m ? 'SELL' : 'BUY',
        };
        this.handlers.onTrade(t);
      } else if (stream.includes('markPrice')) {
        const m: MarkPrice = {
          ts,
          symbol: sym,
          price: parseFloat(data.p),
        };
        this.handlers.onMark(m);
      }
    } catch {
      // JSON hatası
    }
  }
}
