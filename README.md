# 🔺 PYRAMID RADAR — Para Nerede Birikiyor Haritası

> "Fiyat bir sonuç; sebep taker emirlerinin **büyüklük dağılımı**.  
> 10.000 tane 50$'lık alım (retail FOMO = tepe) ile 12 tane 400K$'lık alım (balina birikimi = dip) fiyatı aynı şekilde yükseltir — ama anlamları **taban tabana zıttır**.  
> RSI/MACD/hacim bunu ayırt edemez, benim piramit eder."

Canlı **BTC/USDT Perpetual** Binance Futures WebSocket verisiyle beslenen, perakende ile balina akışını **ayrı ayrı** sayan ve açık açık **AL / SAT / BEKLE** diyen gerçek zamanlı bir cockpit.

Mock veri yok, simülasyon yok, hayali Fibonacci çarpanı yok — **sadece gerçek filler.**

---

## 🔴 ÇOK ÖNEMLİ GÜVENLİK

Kanka eğer daha önce paylaşılmış/chat geçmişinde görünür token'ların varsa bunları **hemen revoke et** (PAT/Vercel token'lar için ilgili servislerin Settings sayfaları).

---

## Fikir Özü (v5)

Bu bir "pahalı mı ucuz mu" göstergesi değil. Bu bir **para akış sınıflandırıcısı**:

1. Gelen her taker trade'i, **notional büyüklüğüne göre** 5 kademeye ayırıyor: MICRO / SMALL / MEDIUM / LARGE / WHALE / MEGA.
2. Eşikler sabit değil — **adaptif**. Son 3000 trade'in persentillerine göre kendini ayarlıyor ama çöküşte/anormal harekette kendini köreltmemesi için **taban + tavan + EMA yumuşatma + monotonluk garantisi** var. (Yani "herkes büyük trade yapıyor, whale eşiği 1M$ olsun, o zaman gerçek whale'i göremeyeyim" yok.)
3. **İki pencere karşılaştırması ASIL sinyal:**
   - **Kısa pencere:** 1 / 5 / 15 / 60 dk (seçebilirsin)
   - **Uzun pencere:** 1 saat (sabit)
   - **Session:** sekme açıldığından beri, hiç sıfırlanmaz
4. **Divergence matrisi** (ana ürün):
   - Kısa ↓ / Uzun ↑ → **SMART_DUMPING** 🔴 — balina retail'e mal dağıtıyor, **TEPE**
   - Kısa ↑ / Uzun ↓ → **ACCUMULATING** 🟢 — balina dipten topluyor, **DİP**
   - Aynı yön → **CONFIRMING** (trend sağlam)
   - Kısa satıcılı / uzun alıcılı değil ama karmaşa → **RETAIL_CHOP** (elini sokma)
5. **Gerçek dolgu piramitleri:** Büyük bir akım gördüğünde sistem piramit doğuruyor ama **tohum katmanı gerçek notional ile açılıyor** (0$'lık hayalet katman yok). Fiyat VWAP'ı kırdığında katmanlar LIFO siliniyor, tamamen kırılırsa **WRECKED** (konfeti + wah wah sesi).
6. Skor: `smartImb*50 + longSmartImb*30 + recentImb*20` → ±50 **GÜÇLÜ**, ±20 normal, geri kalan BEKLE. Rejim çarpanları var (ACC +25, DISTR −25, CHOP ×0.4).

Yani: fiyat yükseliyor ama taban katman (whale) alıyor, tepe katman (retail) satıyor — **bu yükseliş değil dağıtım, seni uyarıyor.**

---

## ⚠️ Binance WS Adres Değişikliği (Nisan 2026)

İnternetteki bütün kütüphaneler şu anda **ölü endpoint** kullanıyor:

```
❌ KAPALI: wss://fstream.binance.com/ws
❌ KAPALI: wss://fstream.binance.com/stream
```

Yeni routing (v5'te bunlar kullanılıyor, doğrudan kernel içinde):

| Tip | URL | Akışlar |
|---|---|---|
| Public (yüksek frekans) | `wss://fstream.binance.com/public/ws` | `@depth@100ms` order book |
| Market | `wss://fstream.binance.com/market/ws` | `@aggTrade`, `@markPrice@1s` |
| Private | `wss://fstream.binance.com/private/ws` | USER_DATA (listenKey) |

Hem combined (`{stream,data}`) hem tek-stream payload destekli (Binance iki formatı birbirine karıştırıyor, kod onu da handle ediyor).

---

## Mimari (Motor React'i tanımaz 🛠️)

Saniyede **~5000 event** geliyor. Her tick'te `setState` çağırırsan tarayıcıyı öldürürsün. O yüzden:

```
┌─────────────────────────────────────────────────┐
│  EngineKernel (saf TypeScript, React tanımaz)   │
│  ├─ WS bağlantı + üstel geri çekme (1s → 30s)   │
│  ├─ 1 saniyelik ring bucket'lar (MAX=3600 =1sa)  │
│  ├─ İki pencere aggregate (kısa/uzun)            │
│  ├─ Divergence matrisi                           │
│  ├─ Adaptif tier hesaplayıcı (2s'de bir)         │
│  ├─ Gerçek-dolgu piramit motoru                  │
│  └─ 16ms throttle ile snapshot cache             │
└───────────────────┬─────────────────────────────┘
                    │  rAF (60 fps) snapshot kopyası
                    ▼
             ┌──────────────┐
             │   React UI   │  ← sadece yeni referans varsa re-render
             │   Cockpit    │
             └──────────────┘
```

Hot path'te **O(1)** update, ring buffer, hiç allocation yok. React sadece 60 fps'de hazır snapshot'ı okuyor.

### Visibility change (ekran kilidi / sekme değişimi)

Telefon ekranı kilitlenip açıldığında **veri sıfırlanmaz**. WS kapanır (pause), geri gelince yeniden bağlanır (resume) — bucket'lar, session, aktif piramitler, VWAP'lar **aynen korunur**. Eskiden bu vardı bi hata (her reconnect sıfırlıyordu), v5'te düzeltildi.

### Dosya ağacı (v5, temizlenmiş)

```
src/
├── app/App.tsx                   ← rAF loop, ses, konfeti, visibility, iOS ses unlock
├── core/
│   ├── kernel.ts                 ← BÜTÜN motor (WS, aggregation, divergence, piramitler)
│   ├── buckets.ts                ← SecondBucket ring store, aggregate()
│   ├── adaptive-tiers.ts         ← Persentil + floor/ceiling/EMA + monotonluk
│   ├── tiers.ts                  ← TierId sabitleri
│   └── pyramid/
│       ├── types.ts              ← DEFAULT_PYRAMID_CONFIG, Layer, State
│       └── real-flow-engine.ts   ← spawn/update/remove, VWAP, seed notional
├── ui/Cockpit.tsx                ← React.memo sunum katmanı (sinyal, divergence, tier barlar, ob, canvas)
├── utils/
│   ├── format.ts                 ← tickSize'tan decimal hesabı (string-split, log10 yok)
│   ├── sound.ts                  ← tone/katman/yıkım/sinyal/whale sesleri (iOS uyumlu)
│   ├── confetti.ts               ← canvas konfeti (auto-temizle)
│   └── exchangeInfo.ts           ← fapi/v1/exchangeInfo + 6sa localStorage önbellek
├── types/index.ts                ← Side/Trade/Depth/MarkPrice/WsStatus/SymbolMeta
└── styles/global.css             ← Neon dark cockpit + responsive
```

Toplam ~1981 satır ölü kod temizlendi (eski engine, flow-engine v1/v2, BinanceFuturesAdapter, Zustand store, indicators/simple, eski DOM PyramidVisual — hepsi gitti).

---

## Kurulum & Çalıştırma

```bash
npm install
npm run dev        # http://localhost:5174
npm test           # 18/18 test (format + buckets + adaptive-tiers + real-flow-engine)
npm run build      # ~229 KB JS (73 KB gz), ~12.7 KB CSS (3.1 KB gz)
```

### Fiyat formatlama

**Asla `toFixed(2)` kullanmıyorum.** BTC `0.1` tick, altcoinler 7 haneye kadar çıkabiliyor. Decimal sayısı doğrudan Binance `exchangeInfo`'daki `PRICE_FILTER.tickSize` / `LOT_SIZE.stepSize`'dan **string split ile** hesaplanıyor (log10 float hatası yok, sondaki sıfırlar korunuyor).

```ts
// "0.0100" → 4 decimal (sondaki iki sıfır korunur)
// "0.0000001" → 7 decimal (PEPE)
function decimalsFromStep(step: string): number
```

---

## Piramit Yaşam Döngüsü

1. **DOĞUM (SPAWN):** Yön başına skor ≥ 0.7 olduğunda, **gerçek seed notional ile** (en az 5K$ veya önceki katmanın %10'u) — 0$'lık hayalet katman yok.
2. **BÜYÜME:** Fiyat katman yönünde %0.2 ilerledikçe ×1.618 yeni katman (ama o da gerçek notional ile doldurulur).
3. **KATMAN DOLAR:** Ses (arp yukarı), konfeti.
4. **KATMAN SİLİNİR:** Fiyat VWAP'ın tersine %0.15 dönerse LIFO olarak katman gider, ses (aşağı saw). Piramit COLLAPSING'e düşer.
5. **PEAKED:** 5 saniye büyüme yoksa.
6. **WRECKED:** VWAP tamamen kırılırsa → "yıkım" sesi (descend + thud) + konfeti, 2sn ekranda kaldıktan sonra temizlenir.
7. **TIMEOUT:** 15 dakika hiç hareket yoksa sessizce kapanır.

VWAP hesaplaması **gerçek dolu ağırlıklı ortalama:** `Σ(P·Q) / Σ(Q)` — hayali ×1.618 çarpanı yok.

---

## Sinyal Skoru Nasıl Okunur?

Cockpit'te her şey **düz Türkçe "NEDEN?" satırıyla** geliyor. Örnek:

| Durum | Skor | NEDEN? |
|---|---|---|
| 🟢 AL GÜÇLÜ | +65 | Kısa vadede balina alımı +30, uzun vade ACCUMULATING rejimi +25, son 5s whale dalışı +10 |
| 🔴 SAT GÜÇLÜ | −70 | Kısa ↓ uzun ↑ SMART_DUMPING (balina dağıtıyor) −25, whale satışı −40, retail alıcı tuzağı |
| ⏸️ BEKLE | +5 | RETAIL_CHOP, küçük trade'ler kavgası, whale yok kenara çekil |

Matematik:

```
score = smartImb*50 + longSmartImb*30 + recentImb(5s)*20
      × regimeModifier (ACC +25, DISTR -25, CONFIRM ±15, CHOP ×0.4, lowVol ×0.5)
```

---

## Canlı

- **Production:** https://pyramid-radar.vercel.app
- **Development:** `npm run dev` → http://localhost:5174

PWA olarak da çalışıyor (manifest + service worker var, telefonuna ekleyebilirsin).

---

## Testler

```
✓ src/utils/format.test.ts         (4 test) — decimalsFromStep, formatPrice, trailing zeros
✓ src/core/buckets.test.ts         (5 test) — SecondBucket aggregate, VWAP, window walks
✓ src/core/adaptive-tiers.test.ts  (4 test) — percentile, floor/ceiling, monotonicity, EMA
✓ src/core/pyramid/real-flow-engine.test.ts (5 test) — spawn/seed, layer add/remove, VWAP breach, wreck
                                                  Toplam: 18/18 ✅
```

Çalıştırmak için:

```bash
npm test
```

---

## Bilinen / Gelecekte Yapılacaklar

- [ ] Multi-coin selector (şu an tek: BTCUSDT; altyapı coin-ready ama WS tek sembol)
- [ ] Kernel seviyesi entegrasyon testi (WS mock ile divergence + spawn)
- [ ] Ses throttling (ani katman yağmurunda ses üst üste binebiliyor)
- [ ] `framer-motion` paket olarak duruyor ama hiç import etmiyorum, temizlenecek
- [ ] `navigator.onLine` online/offline handler (şu an sadece visibilitychange'e bağlı)

---

## Yasal Uyarı

⚠️ Bu uygulama **eğitim, görselleştirme ve akış analizi** amaçlıdır. **Yatırım tavsiyesi DEĞİLDİR.** Piramitler, skorlar ve sinyaller matematiksel bir modelin çıktısıdır; hiçbir alım-satım emri bu uygulama tarafından gönderilmez, gerçek para kullanılmaz. Kendi kararlarınla işlem yap, sorumluluk senin.
