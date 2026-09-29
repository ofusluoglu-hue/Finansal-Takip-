# Finansal Takip Paneli

Kişisel finans ve piyasa takip paneli: canlı piyasa fiyatları, yatırım portföyü, varlıklar, krediler ve borçlar tek ekranda. Yapay zekâ destekli sohbet asistanı **Bay Piyasa** ve cihazlar arası veri senkronu içerir.

**Canlı adres:** https://ofusluoglu-hue.github.io/Finansal-Takip-/piyasa-paneli.html
(Erişim kodu gerekir.)

## Özellikler

| Sekme | İçerik |
|---|---|
| **Piyasa Özeti** | ETF/hisse, döviz, emtia (altın, Brent, uranyum) ve kripto fiyatları; ABD seans öncesi/sonrası fiyatlar; detay grafiği; Türkçeye çevrilmiş güncel haberler |
| **Finansal Durumum** | Varlıklar (konut, otomobil, arsa vb.) ve net finansal durum |
| **Yatırımlarım** | Portföy takibi, kâr/zarar |
| **Borçlarım** | Krediler (canlı erken kapama hesaplayıcı), kredi kartları, KMH, elden nakit borçlar; kredi planını **PDF'ten** (yapay zekâ) veya **Excel'den** içe aktarma |
| **Portföy İstatistikleri** | Genel puan: portföy yaşı, çeşitlendirme, borç karşılama, döviz koruması |
| **Bay Piyasa** | Panel verilerini bilen Claude tabanlı sohbet asistanı (model seçimi, maliyet takibi, isteğe bağlı web araması) |

## Mimari (özet)

```
Tarayıcı (GitHub Pages)                Cloudflare Worker                 Dış servisler
piyasa-paneli.html  ── Bearer kod ──▶  cloudflare-worker.js  ──────▶  Anthropic, Twelve Data,
  localStorage (önbellek)              D1 veritabanı (senkron)           Finnhub, Yahoo, FRED,
                                                                         Google News, MetalCharts
```

Ayrıntılar için [PROJECT.md](PROJECT.md).

## Dosyalar

| Dosya | Açıklama |
|---|---|
| [piyasa-paneli.html](piyasa-paneli.html) | Uygulamanın tamamı (HTML + CSS + JS, derleme adımı yok) |
| [cloudflare-worker.js](cloudflare-worker.js) | Arka uç: kimlik doğrulama, API geçitleri, veri senkronu |
| [wrangler.toml](wrangler.toml) | Worker deploy ayarları |
| [PROJECT.md](PROJECT.md) | Teknik dokümantasyon |
| [RULES.md](RULES.md) | Geliştirme kuralları |

## Kurulum

### Ön yüz
`main` dalına push edilen her değişiklik GitHub Pages üzerinden otomatik yayınlanır.

### Worker
İlk kurulum adımları (D1 veritabanı, secret'lar) [cloudflare-worker.js](cloudflare-worker.js) dosyasının başındaki yorumda anlatılır. Kurulumdan sonra deploy:

```bash
npx.cmd wrangler login     # yalnızca ilk seferde
npx.cmd wrangler deploy
```

> Windows PowerShell'de `npx` yerine `npx.cmd` kullanın (script çalıştırma kısıtlaması).

### Gerekli secret'lar (Cloudflare)
`ACCESS_TOKEN`, `ANTHROPIC_API_KEY`, `TWELVEDATA_API_KEY`, `FINNHUB_API_KEY`: hepsi **Secret** türünde. İsteğe bağlı: `ALLOWED_ORIGIN`.

## Güvenlik

- Worker'a yapılan her istek erişim koduyla doğrulanır; 15 dakikada 8 hatalı denemede IP 15 dakika kilitlenir.
- CORS yalnızca GitHub Pages adresine izin verir.
- API anahtarları yalnızca Cloudflare secret'larında durur; repoda hiçbir anahtar bulunmaz.
