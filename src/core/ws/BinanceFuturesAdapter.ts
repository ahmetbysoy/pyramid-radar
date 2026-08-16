import type { Depth, MarkPrice, Trade, WsStatus } from '../../types';

/**
 * Binance USDⓈ-M Futures WebSocket adapter'ı.
 *
 * ⚠️ KRİTİK DEĞİŞİKLİK (2026):
 * Eski `wss://fstream.binance.com/ws` ve `/stream` adresleri
 * 23 Nisan 2026'da KAPANDI. İnternetteki tutorial'ların %99'u
 * hala eski adresleri kullanıyor, çalışmazlar!
 *
 * Yeni routing (kategorize edilmiş) endpoint'ler:
 *   - Public (yüksek frekans depth):  wss://fstream.binance.com/public/ws
 *   - Market  (aggTrade, markPrice):  wss://fstream.binance.com/market/ws
 *   - Private (user data):             wss://fstream.binance.com/private/ws
 *
 * 📌 Tek stream raw payload, çoklu stream wrapped {stream, data} formatı döner.
 *    İki formatı da handle ediyoruz.
 *
 * Kaynak: https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Important-WebSocket-Change-Notice
 */

const PUBLIC_URL = 'wss://fstream.binance.com/public/ws';
const MARKET_URL = 'wss://fstream.binance.com/market/ws';

interface Handlers {
  onTrade(t: Trade): void;
  onDepth(d: Depth): void;
  onMark(m: MarkPrice): void;
  onStatus(s: WsStatus): void;
}

interface ParsedEnvelope {
  stream: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  sym: string;
  ts: number;
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
  /** visibility değişince durdur/devam et */
  private visibilityHandler: (() => void) | null = null;
  private onlineHandler: (() => void) | null = null;
  private offlineHandler: (() => void) | null = null;

  constructor(symbols: string[], handlers: Handlers) {
    this.symbols = symbols.map((s) => s.toLowerCase());
    this.handlers = handlers;
  }

  connect(): void {
    this.destroyed = false;
    this._connectPublic();
    this._connectMarket();

    // Sekme arka plana düşünce WS'yi kapat, geri dönünce yeniden aç (pil/trafik tasarrufu)
    if (typeof document !== 'undefined' && !this.visibilityHandler) {
      this.visibilityHandler = () => {
        if (document.hidden) {
          this._clearTimeouts();
          this._close(this.publicWs);
          this._close(this.marketWs);
          this.publicWs = null;
          this.marketWs = null;
          this.publicReady = false;
          this.marketReady = false;
          this.handlers.onStatus('connecting');
        } else {
          this.backoffMs = 1000;
          this._connectPublic();
          this._connectMarket();
        }
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }

    // Online/offline takibi
    if (typeof window !== 'undefined' && !this.onlineHandler) {
      this.offlineHandler = () => this.handlers.onStatus('offline');
      this.onlineHandler = () => {
        this.handlers.onStatus('reconnecting');
        this.backoffMs = 1000;
        this._clearTimeouts();
        this._close(this.publicWs);
        this._close(this.marketWs);
        this.publicWs = null;
        this.marketWs = null;
        this._connectPublic();
        this._connectMarket();
      };
      window.addEventListener('offline', this.offlineHandler);
      window.addEventListener('online', this.onlineHandler);
    }
  }

  disconnect(): void {
    this.destroyed = true;
    this._clearTimeouts();
    this._close(this.publicWs);
    this._close(this.marketWs);
    this.publicWs = null;
    this.marketWs = null;
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.onlineHandler && typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineHandler);
      window.removeEventListener('offline', this.offlineHandler!);
      this.onlineHandler = null;
      this.offlineHandler = null;
    }
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
    if (typeof document !== 'undefined' && document.hidden) return;
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
    if (typeof document !== 'undefined' && document.hidden) return;
    if (this.symbols.length === 0) return;

    const streams = this.symbols
      .flatMap((s) => [`${s}@aggTrade`, `${s}@markPrice@1s`])
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
    if (typeof document !== 'undefined' && document.hidden) return;
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

  /**
   * Gelen mesajı parçala: hem tek stream raw formatı hem de combined wrapped formatı destekler.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _unwrapMessage(raw: any, defaultStreamHint?: string): ParsedEnvelope | null {
    // Binary ise parse etme
    if (typeof raw !== 'string') return null;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }

    // Wrapped combined format: { stream, data }
    if (msg && typeof msg === 'object' && 'stream' in msg && 'data' in msg && typeof msg.stream === 'string') {
      const data = msg.data;
      const stream = msg.stream as string;
      const sym = (data?.s ?? stream.split('@')[0]).toUpperCase();
      const ts = Number(data?.T ?? data?.E ?? Date.now());
      return { stream, data, sym, ts };
    }

    // Tek stream raw payload: e field'ı event tipi, s sembol
    if (msg && typeof msg === 'object' && 'e' in msg && 's' in msg) {
      const data = msg;
      const event = String(data.e ?? '');
      let streamType: string;
      switch (event) {
        case 'depthUpdate': streamType = 'depth'; break;
        case 'aggTrade': streamType = 'aggTrade'; break;
        case 'markPriceUpdate': streamType = 'markPrice'; break;
        default: streamType = defaultStreamHint ?? event;
      }
      // stream ismini combined formatta gelecekmiş gibi kur (alt kod aynı kalsın)
      const symRaw = String(data.s ?? '').toLowerCase();
      const stream = `${symRaw}@${streamType}`;
      const ts = Number(data.T ?? data.E ?? Date.now());
      return { stream, data, sym: String(data.s).toUpperCase(), ts };
    }

    return null;
  }

  private _handlePublicMessage(raw: string): void {
    const env = this._unwrapMessage(raw, 'depth');
    if (!env) return;

    const { stream, data, sym, ts } = env;
    if (data.b && data.a && stream.includes('depth')) {
      const depth: Depth = {
        ts,
        symbol: sym,
        bids: (data.b as string[][]).map(([p, q]) => [parseFloat(p), parseFloat(q)] as [number, number]),
        asks: (data.a as string[][]).map(([p, q]) => [parseFloat(p), parseFloat(q)] as [number, number]),
      };
      this.handlers.onDepth(depth);
    }
  }

  private _handleMarketMessage(raw: string): void {
    const env = this._unwrapMessage(raw);
    if (!env) return;

    const { stream, data, sym, ts } = env;

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
  }
}
