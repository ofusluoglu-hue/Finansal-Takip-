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
| `ft_harcamalar_v1` | Harcamalar: tek harcama kayıtları ve elle yazılan aylık kategori toplamları |

Yalnızca yerelde tutulanlar: `ft_erisim` (erişim kodu), `ft_senkron_meta` (senkron durumu), `ft_fx_son_bilinen_v1` (son bilinen kurlar), `ft_aylik_kur_v1` (her ayın ortalama USD/TRY kuru ve gram altın fiyatı; harcamaların dolar/altın karşılığı için), `ft_yatirim_son_fiyat_v1` (yatırımların son bilinen fiyat/tutarı; fiyat her yenilendiğinde senkron listesi yeniden yazılmasın diye ayrı tutulur).

**Senkron akışı:**
- `localStorage.setItem` sarmalanmıştır; senkron anahtarlarına yazılan her **değişiklik** "bekleyen" olarak işaretlenir (değer aynıysa gönderilmez) ve Worker'a `PUT /data/:anahtar` ile gönderilir.
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
| `/extract-loan` | POST | Kredi planı PDF'ini (`pdfBase64`) Claude ile JSON'a çevirir (banka, faiz, anapara, kullandırım tarihi, ödeme planı) |
| `/td` | GET | Twelve Data anlık fiyat |
| `/td-series` | GET | Twelve Data geçmiş veri (grafik) |
| `/fh` | GET | Finnhub anlık fiyat |
| `/uranyum` | GET | Uranyum (U3O8) fiyatı, MetalCharts sayfasından; 20 dk önbellek |

## 5. Veri kaynakları

| Veri | Kaynak |
|---|---|
| ABD hisse ve ETF'leri (QQQM, VOO, URA, XLE, REMX, NVDA…) | Resmi kapanış ve normal seans: Finnhub (`/fh`). Seans öncesi / sonrası: Yahoo 5 dk'lık grafik (`includePrePost`, son 5 gün) |
| Dolar/TL, Euro/TL | Yahoo Finance (`/proxy`); yedek Twelve Data |
| Kripto (BTC, ETH, SOL, AAVE, HYPE) | Binance 24 saatlik ticker (doğrudan, anahtarsız); yedek CoinGecko. Grafikler Binance |
| Altın (spot ons) | Twelve Data (`/td`) |
| Brent ve diğerleri | Yahoo Finance / FRED (`/proxy`) |
| Gümüş (yalnızca Yatırımlarım'da gümüş varsa) | Yahoo COMEX gümüş SI=F (`gumusFiyatYenile`); gram = ons ÷ 31,1035 |
| Uranyum | MetalCharts (`/uranyum`), hata olursa Yahoo |
| Haberler | Kurumların kendi RSS yayınları (`/proxy`): Investing.com Türkiye (kripto 301, emtia 11, borsa 25, piyasa 285, ekonomi 14), Bloomberg HT, Anadolu Ajansı ekonomi, BBC Business, CNBC Markets, MarketWatch. Reuters ve Bloomberg: Google News RSS (`site:` filtresiyle) |

Yenileme: fiyatlar 60 sn, haberler 10 dk, senkron 5 dk.

**Yenileme sırası:** Her turda önce Dolar/TL ve Euro/TL paralel çekilir, ardından kripto; hemen sonra `tlKarsiliklariniYenile()` tüm TL karşılıklarını (elden nakit USD/EUR borçlar, yatırımlar, altın, net değer, borç toplamı, portföy puanları) yeniden hesaplar. Tur sonunda (altın ve ETF'ler geldikten sonra) bir kez daha çalışır.

**ABD seansları (ETF/hisse kartları):** Kartın ana değeri o an açık seansın fiyatıdır (değişim bir önceki resmi kapanışa göre). Altındaki satırlar diğer seansları gösterir:

| An (ABD saati) | Ana değer | Alt satırlar |
|---|---|---|
| Seans öncesi 04:00–09:30 | Öncesi | Kapanış (önceki gün), Sonrası (önceki gün) |
| Normal seans 09:30–16:00 | Canlı fiyat | Öncesi |
| Seans sonrası 16:00–20:00 | Sonrası | Öncesi, Kapanış, Sonrası |
| Gece / hafta sonu | Kapanış | Öncesi, Sonrası |

Öncesi yüzdesi önceki kapanışa, Sonrası yüzdesi o günün kapanışına göredir. Sonrası dilimi 16:05'ten başlar (16:00 çubuğu kapanış müzayedesini içerir). **Gece seansı (20:00–04:00 ET) verisi ücretsiz kaynaklarda (Yahoo, Nasdaq, Finnhub) bulunmadığı için gösterilmez.** Seans verisi seans öncesi/sonrası penceresinde her turda, diğer zamanlarda 5 dakikada bir tazelenir.
**Haber kuralları:** Yalnızca köklü haber kurumları; basın bültenleri (`NEWS_BULTEN_RE`: Chainwire, GlobeNewswire, EQS-News…), fiyat/fon tanıtım sayfaları ve 4 kelimeden kısa başlıklar elenir; son 3 gün. Türkçe haberler doğrudan, BBC/CNBC haberleri Google Çeviri (`*.translate.goog`) ile Türkçe açılır. Google Çeviri'yi engelleyen MarketWatch ve Google News'ten gelen Reuters/Bloomberg "İngilizce" etiketlidir ve sütun başına en fazla 1 tanedir (okunabilir haber azsa boşluğu doldurur). İngilizce başlıklar Claude Haiku ile Türkçeye çevrilir.

Proxy yedekleri (`NEWS_PROXIES` / `fetchWithFallback`): Worker proxy'si başarısız olursa Yahoo, FRED ve haber istekleri sırayla `allorigins.win`, `corsproxy.io` ve `codetabs.com` üzerinden denenir (bu isteklere erişim kodu gönderilmez).

## 6. Yapay zekâ kullanımı

| Özellik | Model |
|---|---|
| Bay Piyasa | Kullanıcı seçer: Haiku 4.5, Sonnet 5 (varsayılan), Opus 5.5, Fable 5.1 |
| Haber çevirisi | `claude-haiku-4-5-20251001` |
| Kredi PDF çıkarma | `claude-sonnet-5` |

Worker'daki `ALLOWED_MODELS` listesi ile ön yüzdeki model listesi (`BP_MODEL_IPUCU` vb.) uyumlu tutulmalıdır.

## 7. Krediler

- Ödeme planı bilinen krediler (`mode: 'schedule'`): güncel borç = son geçen taksitteki kalan anapara + o tarihten bugüne işleyen faiz + KKDF + BSMV.
- **İlk taksit henüz gelmediyse** borç, kullandırılan anaparadır (`orijinalAnapara`; yoksa ilk iki satırın farkından tahmin edilir). Faiz `kullandirimTarihi` biliniyorsa oradan işler. Kartta "İlk taksit GG.AA.YYYY" yazar.
- İçe aktarma: PDF (Claude, `/extract-loan`) veya Excel ([kredi-odeme-plani-sablon.xlsx](kredi-odeme-plani-sablon.xlsx) şablonu). Excel tarihleri saat dilimi kaymasını önlemek için ham gün numarasından okunur; "Kalan Ana Para" sütunu ödenen anapara sanılmaz.

## 8. Harcama İstatistikleri

- Veri `ft_harcamalar_v1` dizisinde (senkronda id'ye göre birleşir):
  - `{ id:'h-…', tur:'kayit', tarih:'YYYY-MM-DD', kat, tutar, not }` — tek harcama
  - `{ id:'ay-YYYY-MM-kat', tur:'aylik', ay:'YYYY-MM', kat, tutar }` — o ayın kategori toplamı; varsa o ay ve kategori için **kayıtların toplamı yerine** geçer (tabloda ✎ ile işaretli)
- Kategoriler (`HARCAMA_KATEGORILER`): market, akaryakıt, kişisel, fatura ve aidat, ev giderleri, yeme-içme ve eğlence, sağlık, eğitim, diğer; ayrıca formda seçilmeyen **Kategorisiz** (`genel`) — kategori ayrımı olmayan eski aylık toplamlar (2025 Mart–Aralık) için.
- **Dolar ve gram altın karşılığı:** her ayın harcaması o ayın ortalama kuruyla çevrilir (`aylikKurlariGuncelle`: Yahoo günlük USDTRY=X ve GC=F kapanışlarının ay ortalaması; gram = ons × kur ÷ 31,1035). Tablo altında $ ve gr satırları, kartlarda ve grafik ipucunda gösterilir; yıl toplamı $/gr her ayın kendi kuruyla toplanır.
- **Tüm dönem ortalaması** (`harcamaTumDonem`): bütün yılların tamamlanmış aylarının TL/$/gr ortalaması.
- Aylık ortalama = seçili yılda harcama girilmiş **tamamlanmış** ayların ortalaması (süren ay yarım olduğu için katılmaz; kategori ortalamaları da aynı); yıl sonu tahmini = ortalama × 12. Süren ay kartında önceki ayla kıyas yerine "ortalamanın %X kadarı · ayın G/N günü" gösterilir.
- 2025 Mart–Aralık aylık toplamları (HrcmAylık sayfası, toplam ₺675.029) `genel` kategorisinde aylık toplam olarak eklendi.
- 2026 Ocak–Eylül verisi eski bütçe Excel'inden (Bütçe Hedef Gider 2026.xlsx) bir kereliğine aktarıldı: Ocak–Ağustos aylık kategori toplamı (`kaynak:'excel'`), Eylül tek tek kayıt (`xl-2026-09-*`). Excel artık kullanılmıyor; harcamalar panelden girilir.
- Grafik (`harcamaGrafikCiz`, yükseklik `HARCAMA_GRAFIK_H` = 165 px; grafik + Kategoriler satırı ≈223 px): tek renk sütunlar (≤24 px, 4 px yuvarlak üst), ortalama çizgisi, bant genişliğinde isabet alanıyla fare/klavye ipucu; aylık tablo grafiğin tablo karşılığıdır. Kategori dağılımı tek renk yatay çubuk (kimliği etiket taşır; 9 kategori renkle ayırt edilmez); çubuklar en büyük kategoriye göre ölçeklenir, değer sütunu sabit (yıl toplamı + silik aylık ortalama).
- Bay Piyasa: portföy paylaşımı açıkken harcama özeti bağlama eklenir; "💸 Harcama analizi" hazır raporu vardır.

## 9. Arayüz

- Menü hep açık grup başlıklarıyla: Piyasa Özeti · **Varlık ve borç** (Finansal Durumum, Yatırımlarım, Borçlarım) · **İstatistikler** (Harcama İstatistikleri, Portföy İstatistikleri) · **Asistan** (Bay Piyasa). Açılır/kapanır alt menü bilinçli olarak kullanılmadı: harcama girişi sık yapılan bir iş, fazladan tık istemez; telefondaki alt çubukta da çalışmaz.
- Masaüstünde solda sabit menü; 900 px altında menü **alta sabit sekme çubuğu** olur (grup başlıkları gizlenir, sıra aynı kalır; etiketler kısalır: Piyasa · Durum · Yatırım · Borç · Harcama · Portföy · Asistan — `data-kisa`), senkron durumu ve çıkış üstte ince bir satırda kalır.
- Tüm sekmeler 390 px telefon genişliğinde yatay taşma olmadan test edilir.
- ETF dışı kartların alt satırları (`kartEkSatirlari`): **Dün** — önceki kapanış ve düne göre fark (Dolar/Euro/Brent: Yahoo; altın: Twelve Data `previous_close`), **Aralık** — günün en düşük–en yüksek değeri; kriptoda **24s önce** ve **24s aralık** (Binance ticker `openPrice`, `lowPrice`, `highPrice`); uranyumda **Önceki** (yüzdeden geri hesaplanır). ETF'de hiç seans satırı yoksa **Önceki** kapanış gösterilir. 1000 üstü değerlerde alt satırlarda küsurat gösterilmez.
- **Ortak tasarım dili** (Finansal Durumum, Yatırımlarım, Borçlarım, Harcama İstatistikleri, Portföy İstatistikleri — Piyasa Özeti kartlarıyla aynı). Her sayfa üstte özet kartları, altında başlığında toplamı/puanı olan bölümler ve sonda tek Not ile kurulur; tablolar `.ist-tablo`, dağılım çubukları `istHbar`, başlıktaki seçiciler `.bolum-secim`:
  - Özet kartı `.ozet-kart` (renkli sol kenar: yeşil varlık, kırmızı borç, sarı oran; `.ozet-etiket`, `.ozet-deger`, `.ozet-alt`, çizgili detay satırları `.card-seanslar`), ızgara `.ozet-grid`.
  - Bölüm `.bolum`: başlık + bölüm toplamı + **+ Ekle** (`bolumFormAc`) ile açılan `.bolum-form`.
  - Liste satırı `satirHtml()`: LED, ad (`dil` ile büyük harf kuralı: ETF/kripto adları `en` → BITCOIN; Türkçe adlar sayfa dili `tr` → ALTIN, GÜMÜŞ), alt bilgi, tutar, ✎ (satır içi düzenleme) ve ✕ sil / ✓ kapattım. Düzenleme durumu `_duzen` ile saklanır; dakikalık yeniden çizimde açık kutu ve yazılan değer korunur.
  - Açıklamalar her sayfanın altında tek bir **Not** satırındadır.
- **Portföy yaşı** bölümü ince bir listedir (grafik + tablo birleşik): kod + tam ad + kategori (geniş sütun; telefonda ad kodun altında) · daha kısa yaş çubuğu (kategori rengi; sarı dikey çizgi = ortalama) · yaş · pay, yaşa göre sıralı. Yaşa tıklanınca satır içinde düzenlenir (`istYasDuzenle`; Enter kaydeder, Esc vazgeçer, odaktan çıkınca kaydeder). Yeniden çizimde açık kutu ve değer korunur; çizim sırasında kaldırılan kutunun `blur`'u kaydetme sayılmaz (`_yasCiziliyor`).
- **Yatırım performansı** (Yatırımlarım › Toplam Yatırım kartı): Günlük / Haftalık / Aylık ▲▼ yüzde ve ₺ farkı. Bugünkü adetler 1, 7 ve 30 gün önceki kapanış fiyatları ve o günkü USD/TRY ile değerlenir (`yatirimPerformans`); yalnızca piyasa hareketini gösterir, BİST sabit. Seriler: Yahoo günlük (ETF, GC=F, SI=F, USDTRY=X) ve Binance günlük (kripto), 30 dk bellekte önbellek (`perfSerileriGetir`). Referans **takvim gününe** göre seçilir (`seriDeger`): Yahoo çubukları açılış saatiyle işaretli olduğundan saate göre kesmek "dün"ü bir önceki işlem gününe kaydırıyordu. Telefonda ₺ farkı kısa biçimde ("+₺12 bin").
- Finansal Durumum › Varlık Dağılımı: SVG halka grafik (`halkaGrafikSvg`) — dilimler arası 2 px eşit aralık (kart zemini), açı = taban + (360 − n × taban) × pay (taban ≤ 12°): küçük paylar görünür (%0,5 ≈ 13°), dönüşüm doğrusal ve artan olduğu için büyük pay her zaman daha büyük çizilir (sıra bozulmaz); gerçek yüzdeler açıklamada ve dilim ipucunda. Ortası boş.
- Çeşitlendirme / Borç karşılama / Döviz koruması çubukları: açıklama sütunu 250 px (Çeşitlendirme'de kod + tam ad), değer sütunu sabit 150 px (çubuklar aynı yerde biter), çubuk ≈%18 kısa; telefonda üst satır açıklama + değer, altında tam genişlik çubuk.
- **Öne çıkan kart** `.ozet-kart.vurgu`: sayfanın tek ana göstergesi için (ör. Portföy İstatistikleri'nde genel puan) — 2 sütun, 34 px değer, derece rozeti `.puan-rozet`, kalın çubuk, puan renginde hafif zemin; telefonda tam genişlik. Sayfa başına en fazla bir tane. `.orta` varyantı 26 px değer kullanır (Borçlarım › Toplam Borç; nabız efektiyle). Yatırımlarım › Toplam Yatırım yeşil 23 px ve nabızlı; kartında `.ton` varyantı var (öne çıkan kartın renkli çerçevesi ve zemin yansıması, genişlik değişmeden; sol kenar tam renk). `.ton` ayrıca: Finansal Durumum › Net Varlık (çerçeve ve rakam yeşil; eksi ise kırmızı), Yatırımlarım › Yatırım / Borç Oranı (%50 altı kırmızı, %50–99 sarı, %100+ yeşil — kenar, çerçeve ve zemin birlikte).
- Piyasa Özeti kartları kompakttır: yüzde değişim ve seans notu aynı satırda, ETF seans satırları ince bir çizgiyle ayrılır. Hedef: 1440×900 ekranda kartlar ve grafik kaydırmadan görünsün.

## 10. Deploy

- **Ön yüz:** `main` dalına push → GitHub Pages.
- **Worker:** `npx.cmd wrangler deploy` ([wrangler.toml](wrangler.toml)). `keep_vars = true` panelden eklenen değişkenleri korur, `preview_urls = false` sürüme özel önizleme adreslerini kapatır; secret'lar deploy'dan etkilenmez.

## 11. Sürüm geçmişi

| Tarih | Değişiklik |
|---|---|
| 2026-09-29 | Worker repoya eklendi; `/td-series` parametreleri URL'ye kodlanıyor; `wrangler.toml` ile CLI deploy; API anahtarları secret'a taşındı; README/PROJECT/RULES ve .gitignore eklendi |
| 2026-09-29 | Yatırımlarım: Toplam Yatırım kartında günlük / haftalık / aylık performans (mevcut adetlerin geçmiş fiyatlarla değeri) |
| 2026-09-29 | Varlık Dağılımı pastası SVG halka grafiğe dönüştü (pürüzsüz kenar, eşit aralıklar, küçük paylar en az 14°) |
| 2026-09-29 | Yatırımlarım: Emtia'ya gümüş eklendi (fiyat arka planda Yahoo SI=F), kategori ve varlık adları büyük harf; Net Varlık ve Yatırım/Borç Oranı kartlarına renkli ton (oran eşikleri %50 / %100); tonlu kartlarda sol kenar tam renk |
| 2026-09-29 | Borçlarım'da Toplam Borç öne çıkan kart (2 sütun, 26 px, kırmızı ton, nabız); Yatırımlarım'da Toplam Yatırım yeşil ve 23 px |
| 2026-09-29 | Harcama grafiği ve Kategoriler dikeyde ≈%23 küçüldü (288 → 223 px); kategori çubukları en büyüğe göre ölçekli; telefon alt menüsünde kısa etiketler (7 sekme sığmıyordu, Bay Piyasa kesiliyordu) |
| 2026-09-29 | Çeşitlendirme, Borç karşılama ve Döviz koruması: açıklamaya yer açıldı (çubuk ≈%18 kısa, sabit değer sütunu), telefonda çubuklar tam genişlik ve eşit |
| 2026-09-29 | Portföy yaşı bölümü sadeleşti: ayrı grafik ve tablo tek ince listede birleşti (≈500 → 290 px), yaş tıkla-düzenle, ortalama çizgisi; tekrar eden uyarılar kaldırıldı |
| 2026-09-29 | Portföy İstatistikleri'nde genel puan öne çıkan kart oldu (2 sütun, büyük puan, derece rozeti) |
| 2026-09-29 | Sol menü gruplandı (Varlık ve borç · İstatistikler · Asistan); görev testi: 7 görevin hepsi tek tık |
| 2026-09-29 | Harcama İstatistikleri ve Portföy İstatistikleri ortak tasarım diline uyduruldu: anlamlı kart renkleri (puana göre yeşil/sarı/kırmızı), yıl/ay seçimi bölüm başlığında, ortak tablo ve çubuk stili, bölüm başlığında puan/toplam, açıklamalar sayfa sonundaki Not'ta |
| 2026-09-29 | Harcamalarda dolar ve gram altın karşılıkları (her ay kendi ortalama kuruyla), tüm dönem ortalaması, Kategorisiz kategori; 2025 Mart–Aralık aylık toplamları D1'e eklendi |
| 2026-09-29 | 2026 Ocak–Eylül harcamaları bütçe Excel'inden D1'e bir kereliğine aktarıldı (79 kayıt, 8 ay toplamı Excel ile birebir); ortalamalar yalnızca tamamlanmış aylardan hesaplanıyor |
| 2026-09-29 | Harcama İstatistikleri sekmesi: tek tek harcama ve aylık toplam girişi, 9 kategori, aylık grafik, kategori dağılımı, aylık tablo, ortalamalar; Bay Piyasa harcama analizi; `ft_harcamalar_v1` senkron anahtarı (Worker'a eklendi) |
| 2026-09-29 | Finansal Durumum, Yatırımlarım, Borçlarım ve Portföy İstatistikleri Piyasa Özeti'nin tasarım diline geçti: ortak özet kartları, bölüm başlığında toplam ve + Ekle, satır içi ✎ düzenleme, sayfa sonunda tek Not; üst çubuk alt başlıkları eklendi |
| 2026-09-29 | Haberler kurumların kendi RSS yayınlarından: Türkçe kaynaklar (Investing.com Türkiye, Bloomberg HT, Anadolu Ajansı) öncelikli, BBC/CNBC Google Çeviri ile Türkçe açılır; basın bültenleri ve fon sayfaları elenir; Worker proxy izin listesine haber alan adları eklendi |
| 2026-09-29 | Tüm kartların altında bilgi satırları: Dün/Aralık (döviz, altın, Brent), 24s önce/24s aralık (kripto), Önceki (uranyum, işlem görmeyen ETF) |
| 2026-09-29 | Piyasa Özeti kartları dikeyde kısaltıldı (yüzde ve seans notu aynı satırda, sıkı seans satırları); 1440×900 ekranda grafik kaydırmadan görünür |
| 2026-09-29 | Döviz kurları her turun başında çekiliyor, tüm TL karşılıkları hemen güncelleniyor (nakit borçta kurun saati görünür); ETF kartlarında seans öncesi / kapanış / sonrası satırları |
| 2026-09-29 | Test sonrası düzeltmeler: ilk taksidi gelmemiş krediler görünür; kripto fiyatları Binance'e taşındı (CoinGecko 429); yatırım listesi artık dakikada bir sunucuya yazılmıyor; Excel tarih kayması ve "Kalan Ana Para" sütunu düzeltildi; Excel şablonu eklendi; telefon görünümü (alt sekme çubuğu, taşmalar) düzeltildi; sekme simgesi eklendi |
