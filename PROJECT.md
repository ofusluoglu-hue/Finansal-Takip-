# Proje Dokümantasyonu

Finansal Takip Paneli'nin teknik yapısı. Genel tanıtım için [README.md](README.md), geliştirme kuralları için [RULES.md](RULES.md).

## 1. Genel yapı

Uygulama iki parçadan oluşur:

- **Ön yüz:** [piyasa-paneli.html](piyasa-paneli.html), tek dosya, çerçeve (framework) ve derleme adımı yok. GitHub Pages'ten sunulur. Tek dış kütüphane: SheetJS (`xlsx`, Excel içe aktarma için, cdnjs'ten).
- **Arka uç:** [cloudflare-worker.js](cloudflare-worker.js), Cloudflare Worker (`weathered-dream-54b3`). API anahtarlarını saklar, dış servislere aracılık eder, verileri D1'de tutar.

Worker adresi ön yüzde `MY_WORKER` sabitindedir.

## 2. Kimlik doğrulama

1. Açılışta erişim kodu yoksa giriş ekranı gösterilir. Kod `/auth/check` ile doğrulanır ve `localStorage`'da `ft_erisim` anahtarında saklanır.
2. `window.fetch` sarmalanmıştır: **yalnızca** `MY_WORKER` adresine giden isteklere `Authorization: Bearer <kod>` başlığı eklenir. Üçüncü taraf proxy'lere kod asla gönderilmez.
3. Worker 401 dönerse giriş ekranı yeniden açılır.
4. Worker tarafında karşılaştırma SHA-256 üzerinden sabit zamanlıdır. Hatalı denemeler D1'deki `auth_fail` tablosuna yazılır; 15 dakikada 8 hata → IP kilidi (429).
5. Çıkış yapıldığında bekleyen değişiklikler gönderilir, ardından yerel veriler silinir.

## 3. Veri saklama ve senkron

- `localStorage` hızlı önbellektir; kalıcı kaynak **Cloudflare D1** (`finansal-takip` veritabanı, `kv` tablosu).
- Senkronlanan anahtarlar hem ön yüzde (`SENKRON_ANAHTARLARI`) hem Worker'da (`IZINLI_ANAHTARLAR`) tanımlıdır. **İkisi aynı olmalıdır.**

| Anahtar | İçerik |
|---|---|
| `ft_yatirimlar_v1` | Yatırımlar (portföy) |
| `ft_varliklarim_v1` | Varlıklar |
| `ft_custom_loans_v1` | Kullanıcının eklediği krediler |
| `ft_closed_loans_v1` | Kapatılan kredilerin id listesi |
| `ft_sabit_krediler_v1` | Sabit krediler |
| `ft_kredi_kartlari_v1` | Kredi kartları |
| `ft_kmh_v1` | KMH borçları |
| `ft_elden_nakit_v1` | Elden nakit borçlar |
| `ft_bay_piyasa_v1` | Bay Piyasa sohbetleri, ayarları, harcama |
| `ft_haber_ceviri_v1` | Haber başlığı çeviri önbelleği |

Yalnızca yerelde tutulanlar: `ft_erisim` (erişim kodu), `ft_senkron_meta` (senkron durumu), `ft_fx_son_bilinen_v1` (son bilinen kurlar).

**Senkron akışı:**
- `localStorage.setItem` sarmalanmıştır; senkron anahtarlarına yazılan her değişiklik "bekleyen" olarak işaretlenir ve Worker'a `PUT /data/:anahtar` ile gönderilir.
- Çekme: `GET /data?since=<zaman>`, yalnızca son çekmeden sonra değişenler gelir. Açılışta, sekmeye dönüldüğünde ve 5 dakikada bir çalışır.
- Çakışma: istemci `expected` (son bildiği `updated_at`) gönderir; sunucudaki kayıt daha yeniyse Worker 409 ve güncel değeri döner.
- `updated_at` tüm anahtarlar genelinde kesinlikle artandır (aynı milisaniyedeki yazmalar `since` çekmesinde kaybolmasın diye).

## 4. Worker uç noktaları

`/` dışındaki her uç nokta erişim kodu ister.

| Yol | Metot | Görev |
|---|---|---|
| `/` | GET | Sağlık kontrolü (`{ok:true}`) |
| `/auth/check` | GET | Kodu doğrular, D1 bağlı mı bildirir |
| `/data` | GET | `since` sonrası değişen kayıtlar |
| `/data/:anahtar` | PUT | Kayıt yazar (`{value, expected}`), en fazla 1,5 MB |
| `/proxy?url=` | GET | CORS proxy; yalnızca Yahoo, FRED, Google News, Stooq |
| `/ai` | POST | Anthropic Messages API geçidi (model beyaz listesi, `max_tokens` 200–4000, isteğe bağlı web araması) |
| `/extract-loan` | POST | Kredi planı PDF'ini (`pdfBase64`) Claude ile JSON'a çevirir |
| `/td` | GET | Twelve Data anlık fiyat |
| `/td-series` | GET | Twelve Data geçmiş veri (grafik) |
| `/fh` | GET | Finnhub anlık fiyat |
| `/uranyum` | GET | Uranyum (U3O8) fiyatı, MetalCharts sayfasından; 20 dk önbellek |

## 5. Veri kaynakları

| Veri | Kaynak |
|---|---|
| ABD hisse ve ETF'leri (QQQM, VOO, URA, XLE, REMX, NVDA…) | Finnhub (`/fh`) |
| Dolar/TL, Euro/TL | Twelve Data (`/td`) |
| Altın, Brent, kripto ve diğerleri | Yahoo Finance / FRED (`/proxy`) |
| Uranyum | MetalCharts (`/uranyum`), hata olursa Yahoo |
| Haberler | Google News RSS (`/proxy`) |

Yenileme: fiyatlar 60 sn, haberler 10 dk, senkron 5 dk.
Proxy yedekleri (`NEWS_PROXIES` / `fetchWithFallback`): Worker proxy'si başarısız olursa Yahoo, FRED ve haber istekleri sırayla `allorigins.win`, `corsproxy.io` ve `codetabs.com` üzerinden denenir (bu isteklere erişim kodu gönderilmez).

## 6. Yapay zekâ kullanımı

| Özellik | Model |
|---|---|
| Bay Piyasa | Kullanıcı seçer: Haiku 4.5, Sonnet 5 (varsayılan), Opus 5.5, Fable 5.1 |
| Haber çevirisi | `claude-haiku-4-5-20251001` |
| Kredi PDF çıkarma | `claude-sonnet-5` |

Worker'daki `ALLOWED_MODELS` listesi ile ön yüzdeki model listesi (`BP_MODEL_IPUCU` vb.) uyumlu tutulmalıdır.

## 7. Deploy

- **Ön yüz:** `main` dalına push → GitHub Pages.
- **Worker:** `npx.cmd wrangler deploy` ([wrangler.toml](wrangler.toml)). `keep_vars = true` panelden eklenen değişkenleri korur; secret'lar deploy'dan etkilenmez.

## 8. Sürüm geçmişi

| Tarih | Değişiklik |
|---|---|
| 2026-09-29 | Worker repoya eklendi; `/td-series` parametreleri URL'ye kodlanıyor; `wrangler.toml` ile CLI deploy; API anahtarları secret'a taşındı; README/PROJECT/RULES ve .gitignore eklendi |
