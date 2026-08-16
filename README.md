# 🏔️ Pyramid Radar

Canlı **Binance Futures** WebSocket verisiyle otomatik doğup büyüyüp yıkılan hayali alım/satım piramitleri.

> Mock veri yok, simülasyon yok — **tamamen gerçek zamanlı piyasa verisi** ile çalışır.

## ⚠️ ÇOK ÖNEMLİ: Binance WS Adres Değişikliği (2026)

İnternetteki neredeyse tüm tutorial ve kütüphaneler şu anda **ÖLÜ** adres kullanıyor:

```
❌ ESKİ (23 Nisan 2026'da kapatıldı): wss://fstream.binance.com/ws
❌ ESKİ:                                    wss://fstream.binance.com/stream
```

Yeni routing (kategorize edilmiş) endpoint'ler:

| Kategori | URL | Akışlar |
|---|---|---|
| **Public** (yüksek frekans) | `wss://fstream.binance.com/public/ws` | `<sym>@depth<N>@100ms` gibi order book akışları |
| **Market** (normal) | `wss://fstream.binance.com/market/ws` | `<sym>@aggTrade`, `<sym>@markPrice@1s`, `<sym>@kline_*`, `!miniTicker@arr` |
| **Private** | `wss://fstream.binance.com/private/ws` | ORDER_TRADE_UPDATE, ACCOUNT_UPDATE (listenKey gerekir) |

Detay: https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Important-WebSocket-Change-Notice

Bu repo **yeni endpoint'leri kullanıyor** (`core/ws/BinanceFuturesAdapter.ts`).

## Fikir Özü

Her BÜYÜK alım veya satım akımı geldiğinde (CVD + order book imbalance), sistem o anda **hayali bir piramit** doğurur:

- 🟢 **ALIM piramidi** alıcılar baskınken büyür
- 🔴 **SATIM piramidi** satıcılar baskınken büyür
- Fiyat yönde %0.2 ilerledikçe **Fibonacci altın oranda** (×1.618) yeni katman eklenir: 100 USDT → 162 → 262 → 424 → …
- Fiyat ters yöne %0.15 dönerse en son katman **LIFO** olarak silinir
- Ters tarafta kuvvetli baskı hissederse piramit **yıkılır** (konfeti + WAH WAH sesi gelecek)
- Hiç hareket olmazsa 15dk'da zaman aşımıyla yıkılır

Para yok, emir yok — sadece **görsel ve istatistiksel** bir canlı organizma.

## Canlı

https://pyramid-radar.vercel.app

## Kurulum

```bash
npm install
npm run dev       # http://localhost:5174
npm test          # 12 birim testi (piramit motoru + format util)
npm run build
```

## Mimari

```
src/
├── app/
│   ├── App.tsx             ← Ana ekran, tick döngüsü
│   └── main.tsx
├── core/
│   ├── ws/
│   │   └── BinanceFuturesAdapter.ts   ← Yeni /public /market endpoint'leri
│   ├── buffers/
│   ├── indicators/
│   │   └── simple.ts       ← Hafif CVD+OBI composite skor
│   └── pyramid/
│       ├── types.ts        ← PiramitState, konfigürasyon
│       ├── engine.ts       ← Saf piramit mantığı (katman ekle/sil/yık)
│       └── engine.test.ts  ← 8 test
├── store/
│   └── index.ts            ← Zustand store
├── ui/
│   ├── screens/
│   └── components/
├── utils/
│   ├── format.ts           ← tickSize/stepSize'dan decimal hesabı
│   ├── exchangeInfo.ts     ← fapi/v1/exchangeInfo yükleyici+önbellek
│   └── format.test.ts      ← 4 test
└── types/
    └── index.ts
```

## Fiyat Formatlama (Çok Önemli!)

Altcoin fiyatları virgülden sonra 7 haneye kadar çıkabilir (PEPE gibi). **Asla `toFixed(2)` kullanma**.

Fiyat/miktar basamakları doğrudan Binance `exchangeInfo` endpoint'inden alınan `PRICE_FILTER.tickSize` ve `LOT_SIZE.stepSize` değerlerinden hesaplanır:

```ts
// "0.1" → 1 decimal (BTC)
// "0.01" → 2 decimal (ETH, SOL)
// "0.0001" → 4 decimal (DOGE)
// "0.0000001" → 7 decimal (PEPE)
function decimalsFromStep(step) { /* utils/format.ts */ }
```

Böylece `98,450.3` yerine `98,450.300` gereksiz sıfır basmaz, `0.00001234` gibi değerleri kırpmaz.

## Yasal Uyarı

⚠️ Tüm içerik **eğitim ve görsel şov amaçlıdır**. Yatırım tavsiyesi DEĞİLDİR. Hayali piramitler üzerinde hiçbir alım-satım emri gerçekleşmez. Gerçek para kullanmayın.
