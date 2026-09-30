# Finansal Takip Paneli

Kişisel finans ve piyasa takip paneli: canlı piyasa fiyatları, yatırım portföyü, varlıklar, krediler ve borçlar tek ekranda. Yapay zekâ destekli sohbet asistanı **Bay Piyasa** ve cihazlar arası veri senkronu içerir.

**Canlı adres:** https://ofusluoglu-hue.github.io/Finansal-Takip-/piyasa-paneli.html
(E-posta ve şifre ile giriş yapılır.)

## Özellikler

| Sekme | İçerik |
|---|---|
| **Piyasa Özeti** | ETF/hisse, döviz, emtia (altın, Brent, uranyum) ve kripto (Binance) fiyatları; ABD seans öncesi / kapanış / sonrası fiyatları kartta ayrı ayrı; detay grafiği; köklü kurumlardan güncel haberler (Türkçe kaynaklar öncelikli; İngilizceler Türkçe çeviriyle açılır) |
| **Finansal Durumum** | Varlıklar (konut, otomobil, arsa vb.) ve net finansal durum |
| **Yatırımlarım** | Portföy takibi: ABD ETF/hisse, kripto, BİST (kod + adet, fiyat arka planda) ve emtia (altın, gümüş — gram); günlük / haftalık / aylık performans |
| **Borçlarım** | Krediler (canlı erken kapama hesaplayıcı), kredi kartları, KMH (aylık faizle günlük canlı işleyen borç: faiz + KKDF + BSMV), elden nakit borçlar; kredi planını **PDF'ten** (yapay zekâ) veya **Excel'den** içe aktarma |
| **Harcama İstatistikleri** | Tek tek harcama kaydı ya da aylık kategori toplamı; 9 kategori (market, akaryakıt, kişisel, fatura ve aidat, ev giderleri, yeme-içme ve eğlence, sağlık, eğitim, diğer); aylık grafik, kategori dağılımı, aylık tablo, yıllık ve aylık ortalamalar |
| **Bütçe** | Kategori başına aylık sınır; son 6 ayın medyanından tek tıkla önerilen bütçe; ayın harcaması, kalan/aşım, bütçeyi aşan kategoriler; son 12 ayın bütçeye uyum ısı tablosu |
| **Nakit Akışı** | Düzenli (maaş, kira) ve tek seferlik gelirler; gelir − harcama − kredi taksidi = ay sonu kalan ve tasarruf oranı; son 6 ay ve önümüzdeki 11 ayın tahmini grafiği; kredilerin bittiği ay ve sonrasında açılan pay |
| **Ödeme Takvimi** | Kredi taksitleri (ödeme planından), kart son ödeme günleri, fatura/kira/sigorta ve abonelikler tek takvimde; 45 günlük yaklaşan ödemeler, aylık takvim, abonelik maliyetleri; 3 gün içinde ödeme varsa Piyasa Özeti'nde uyarı şeridi |
| **Borç Kapatma Planı** | Ayda ek ödeme ve bugün tek seferlik ödemeyle borçların hangi sırayla ve ne zaman biteceği; Çığ (önce en yüksek faiz) ile Kartopu (önce en küçük borç) karşılaştırması, ödenecek faiz, borç azalış grafiği; faiz işleyen kartlar isteğe bağlı plana dahil |
| **Portföy İstatistikleri** | Genel puan: portföy yaşı, çeşitlendirme, borç karşılama, döviz koruması |
| **Bay Piyasa** | Panel verilerini bilen Claude tabanlı sohbet asistanı (model seçimi, maliyet takibi, isteğe bağlı web araması) |

Telefonda da kullanılabilir: menü alta sabit sekme çubuğuna dönüşür; çubukta yer almayan sayfalar **Diğer** menüsündedir.

## Mimari (özet)

```
Tarayıcı (GitHub Pages)                Cloudflare Worker                 Dış servisler
piyasa-paneli.html  ── Bearer kod ──▶  cloudflare-worker.js  ──────▶  Anthropic, Twelve Data,
  localStorage (önbellek)              D1 veritabanı (senkron)           Finnhub, Yahoo, FRED,
                                                                         haber RSS'leri, MetalCharts
```

Ayrıntılar için [PROJECT.md](PROJECT.md).

## Dosyalar

| Dosya | Açıklama |
|---|---|
| [piyasa-paneli.html](piyasa-paneli.html) | Uygulamanın tamamı (HTML + CSS + JS, derleme adımı yok) |
| [cloudflare-worker.js](cloudflare-worker.js) | Arka uç: kimlik doğrulama, API geçitleri, veri senkronu |
| [wrangler.toml](wrangler.toml) | Worker deploy ayarları |
| [kredi-odeme-plani-sablon.xlsx](kredi-odeme-plani-sablon.xlsx) | Excel'den kredi eklemek için ödeme planı şablonu |
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
`ACCESS_TOKEN` (giriş şifresi), `LOGIN_USER` (giriş e-postası; virgülle birden fazla), `ANTHROPIC_API_KEY`, `TWELVEDATA_API_KEY`, `FINNHUB_API_KEY`: hepsi **Secret** türünde. İsteğe bağlı: `ALLOWED_ORIGIN`.

## Güvenlik

- Giriş e-posta + şifre ile yapılır; Worker'a yapılan her istek şifreyle doğrulanır. Hatalı girişte hangi bilginin yanlış olduğu söylenmez; 15 dakikada 8 hatalı denemede (yanlış e-posta dahil) IP 15 dakika kilitlenir.
- CORS yalnızca GitHub Pages adresine izin verir.
- API anahtarları yalnızca Cloudflare secret'larında durur; repoda hiçbir anahtar bulunmaz.
