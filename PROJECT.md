# Proje Dokümantasyonu

Finansal Takip Paneli'nin teknik yapısı. Genel tanıtım için [README.md](README.md), geliştirme kuralları için [RULES.md](RULES.md).

## 1. Genel yapı

Uygulama iki parçadan oluşur:

- **Ön yüz:** [piyasa-paneli.html](piyasa-paneli.html), tek dosya, çerçeve (framework) ve derleme adımı yok. GitHub Pages'ten sunulur. Tek dış kütüphane: SheetJS (`xlsx`, Excel içe aktarma için, cdnjs'ten).
- **Arka uç:** [cloudflare-worker.js](cloudflare-worker.js), Cloudflare Worker (`weathered-dream-54b3`). API anahtarlarını saklar, dış servislere aracılık eder, verileri D1'de tutar.

Worker adresi ön yüzde `MY_WORKER` sabitindedir.

## 2. Kimlik doğrulama

1. Açılışta oturum yoksa giriş ekranı gösterilir: **E-posta** + **Şifre** (göster/gizle düğmeli; tarayıcı şifre yöneticisiyle uyumlu `autocomplete=username/current-password`). `/auth/check` isteğinde şifre `Authorization: Bearer`, e-posta `X-Kullanici` başlığıyla gider. Worker şifreyi `ACCESS_TOKEN`, e-postayı `LOGIN_USER` (virgülle birden fazla, büyük/küçük harf duyarsız, sabit zamanlı karşılaştırma) ile doğrular; hata mesajı hangi bilginin yanlış olduğunu söylemez. Başarılıysa şifre `ft_erisim`, e-posta (yalnızca kolaylık için) `ft_giris_eposta` anahtarında saklanır. E-posta yalnızca girişte kontrol edilir; sonraki istekler yalnızca şifreyle doğrulanır (açık oturumlar etkilenmez).
2. `window.fetch` sarmalanmıştır: **yalnızca** `MY_WORKER` adresine giden isteklere `Authorization: Bearer <kod>` başlığı eklenir. Üçüncü taraf proxy'lere kod asla gönderilmez.
3. Worker 401 dönerse giriş ekranı yeniden açılır.
4. Worker tarafında karşılaştırma SHA-256 üzerinden sabit zamanlıdır. Hatalı denemeler (yanlış şifre ve yanlış e-posta) D1'deki `auth_fail` tablosuna yazılır; 15 dakikada 8 hata → IP kilidi (429).
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
| `ft_butce_v1` | Bütçe: kategori başına aylık sınır `[{ id:'b-<kat>', kat, limit, tarih }]` |
| `ft_gelirler_v1` | Gelirler: `{ id, tur:'duzenli', ad, tutar, baslangic, bitis }` ya da `{ id, tur:'tek', ad, tutar, ay }` (aylar `YYYY-MM`) |
| `ft_borc_plan_v1` | Borç planı ayarları: `{ id:'ayar', ek, tek, strateji }` ve faiz işleyen kartlar `{ id:'kart-<kartId>', faizli, oran, asgari }` |
| `ft_odemeler_v1` | Ödeme Takvimi (kart kaydında ayrıca `donem: { 'YYYY-MM': tutar }`): düzenli ödemeler `{ id:'o-…', tur:'duzenli', ad, tutar, gun, periyot:'aylik'\|'yillik', ay, kat }` ve kart son ödeme günleri `{ id:'kart-<kartId>', tur:'kart', kartId, gun }` |
| `ft_net_gecmis_v1` | Günlük net varlık kaydı `{ id:'YYYY-MM-DD', net, varlik, yatirim, borc, usd, gram, t }` (`gram`: o anki gram 24 ayar altın TL fiyatı) |
| `ft_hedefler_v1` | Birikim hedefleri `{ id:'hd-…', ad, hedef, birim:'TL'\|'USD', ay, kaynak:'elle'\|'tum'\|'y:<yatırımId>', birikmis, baslangic, baslangicDeger }` |
| `ft_raporlar_v1` | Aylık Rapor'un Bay Piyasa yorumları `{ id:'YYYY-MM', metin, model, maliyet, ts }` (son 36 ay) |

Yalnızca yerelde tutulanlar: `ft_erisim` (giriş şifresi), `ft_giris_eposta` (son giriş e-postası), `ft_senkron_meta` (senkron durumu), `ft_fx_son_bilinen_v1` (son bilinen kurlar), `ft_gunluk_kur_v1` (günlük USD/TRY ve gram altın kapanışları; kuru olmayan eski net varlık kayıtları için), `ft_aylik_kur_v1` (her ayın ortalama USD/TRY kuru ve gram altın fiyatı; harcamaların dolar/altın karşılığı için), `ft_yatirim_son_fiyat_v1` (yatırımların son bilinen fiyat/tutarı; fiyat her yenilendiğinde senkron listesi yeniden yazılmasın diye ayrı tutulur).

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
| `/auth/check` | GET | Giriş: şifre (`Authorization`) + e-posta (`X-Kullanici`, `LOGIN_USER` tanımlıysa) doğrular, D1 bağlı mı bildirir |
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
| BİST hisseleri (Yatırımlarım, kod + adet) | Yahoo `KOD.IS` (≈15 dk gecikmeli), 5 dakikada bir (`bistFiyatlariYenile`); eklerken kod doğrulanır (404 → hemen uyarı). Eski, elle TL değeri girilmiş BİST kayıtları (`kod` alanı yok) elle güncellenir |
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

## 7b. KMH (canlı faiz)

- KMH kaydı: `{ id, ad, tutar, tarih, faizAylik?, anapara?, kkdf?, bsmv? }` (`ft_kmh_v1`). `tutar` + `tarih` son girilen borçtur (başlangıç noktası).
- Faiz girilmişse güncel borç her gün kendiliğinden artar (`kmhCanli`): **günlük artış = anapara × (aylık faiz ÷ 30) × (1 + KKDF + BSMV)**, KKDF ve BSMV varsayılan %15. Faiz birikmiş faize değil **kullanılan anaparaya** işler; anapara girilmezse borcun tamamı kullanılır. Güncel borç = tutar + günlük artış × geçen takvim günü.
- Doğrulama: Enpara, anapara ₺4.000, %4,25 → 4.000 × 0,0425/30 × 1,30 = 7,3667 ₺/gün; bankanın 29→30 Eylül'de gösterdiği 4.261,44 → 4.268,81 ile birebir.
- Satırda ⚙ (`kmhAyarAc`): güncel borç, aylık faiz, anapara, KKDF, BSMV; canlı önizleme; kaydedince bugünkü borç yeni başlangıç noktası olur (ekstre kesiminde faiz anaparaya eklendiğinde kullanılır). ✎ yalnızca bugünkü borcu günceller.
- Borç toplamları, özet kartı ve Bay Piyasa bağlamı canlı değeri kullanır; her fiyat turunda yeniden hesaplanır.
- Elden nakit borçlarda satır ışığı: dövizli (USD/EUR) kalemin TL karşılığı **güncel kurla** hesaplanıyorsa yeşil; TL kalemde veya kur alınamayıp son bilinen kur kullanılıyorsa son elle güncelleme bugünse yeşil, değilse kırmızı. Özet kartı da en az bir dövizli kalem canlıysa yeşil yanar ve "güncel kurla" yazar.

## 8. Harcama Takibim

- Veri `ft_harcamalar_v1` dizisinde (senkronda id'ye göre birleşir):
  - `{ id:'h-…', tur:'kayit', tarih:'YYYY-MM-01', kat, tutar, not }` — harcama kalemi. Harcamalar **ay bazında tek kalem** girilir (ör. Eylül · Market · ₺32.000): formda gün yerine ay seçilir (son 18 ay; ayın ilk 10 gününde varsayılan önceki ay), listede "Eylül 2026" görünür, aynı ay ve kategorideki kalemler toplanır, aynı ayda en son eklenen üstte
  - `{ id:'ay-YYYY-MM-kat', tur:'aylik', ay:'YYYY-MM', kat, tutar }` — o ayın kategori toplamı; varsa o ay ve kategori için **kayıtların toplamı yerine** geçer (tabloda ✎ ile işaretli)
- Kategoriler (`HARCAMA_KATEGORILER`): market, akaryakıt, araç bakım (`aracbakim`), kişisel, fatura ve aidat, ev giderleri, yeme-içme ve eğlence, sağlık, eğitim, sigorta (`sigorta`), vergi (`vergi`), diğer; ayrıca formda seçilmeyen **Kategorisiz** (`genel`) — kategori ayrımı olmayan eski aylık toplamlar (2025 Mart–Aralık) için.
- **Dolar ve gram altın karşılığı:** her ayın harcaması o ayın ortalama kuruyla çevrilir (`aylikKurlariGuncelle`: Yahoo günlük USDTRY=X ve GC=F kapanışlarının ay ortalaması; gram = ons × kur ÷ 31,1035). Tablo altında $ ve gr satırları, kartlarda ve grafik ipucunda gösterilir; yıl toplamı $/gr her ayın kendi kuruyla toplanır.
- **Tüm dönem ortalaması** (`harcamaTumDonem`): bütün yılların tamamlanmış aylarının TL/$/gr ortalaması.
- Aylık ortalama = seçili yılda harcama girilmiş **tamamlanmış** ayların ortalaması (süren ay yarım olduğu için katılmaz; kategori ortalamaları da aynı); yıl sonu tahmini = ortalama × 12. Süren ay kartında önceki ayla kıyas yerine "ortalamanın %X kadarı · ayın G/N günü" gösterilir.
- 2025 Mart–Aralık aylık toplamları (HrcmAylık sayfası, toplam ₺675.029) `genel` kategorisinde aylık toplam olarak eklendi.
- 2026 Ocak–Eylül verisi eski bütçe Excel'inden (Bütçe Hedef Gider 2026.xlsx) bir kereliğine aktarıldı: Ocak–Ağustos aylık kategori toplamı (`kaynak:'excel'`), Eylül tek tek kayıt (`xl-2026-09-*`). Excel artık kullanılmıyor; harcamalar panelden girilir.
- Grafik (`harcamaGrafikCiz`, yükseklik `HARCAMA_GRAFIK_H` = 165 px; grafik + Kategoriler satırı ≈223 px): tek renk sütunlar (≤24 px, 4 px yuvarlak üst), ortalama çizgisi, bant genişliğinde isabet alanıyla fare/klavye ipucu; aylık tablo grafiğin tablo karşılığıdır. Kategori dağılımı tek renk yatay çubuk (kimliği etiket taşır; 9 kategori renkle ayırt edilmez); çubuklar en büyük kategoriye göre ölçeklenir, değer sütunu sabit (yıl toplamı + silik aylık ortalama).
- Bay Piyasa: portföy paylaşımı açıkken harcama özeti bağlama eklenir; "💸 Harcama analizi" hazır raporu vardır.

## 8b. Bütçe

- Veri `ft_butce_v1`; harcamalar `ft_harcamalar_v1`'den okunur (`butceAyHarcama`: `harcamaTablosu` yıl başına bir kez).
- **Öneri** (`butceOnerileri`): her kategori için son 6 tamamlanmış ve kategorili ayın **medyanı**, 500 TL'ye yukarı yuvarlanır. Ortalama kullanılmaz: Haziran 2026'daki ₺51.608'lik yeme-içme ortalamayı ~₺15 bine çıkarıyor, medyan ₺9.500 veriyor. Bütçe yokken sayfa öneriyi gösterir ve tek tıkla uygular (`butceOnerileriUygula`); ✎/+ satırında boş Kaydet de öneriyi kullanır.
- Varsayılan ay: harcama girilmiş en son ay (harcamalar ay bitince girildiği için). Seçici son 24 ay; ısı tablosunda ay başlığına tıklamak da ayı seçer.
- Durum (`butceDurum`): >%100 aşım (kırmızı), >%90 ya da süren ayda geçen gün oranının 15 puan önünde sınırda (sarı), değilse iyi (yeşil). Çubuk %150'ye kadar çizer, bütçe sınırı çubuğun üçte ikisinde çizgiyle işaretli (`BUTCE_OLCEK`) — aşımın büyüklüğü görünsün; süren ayda ikinci ince çizgi ayın geçen kısmıdır.
- Toplam = ayın bütün harcaması (bütçesiz kategoriler ve 2025 `genel` dahil) ÷ kategori bütçelerinin toplamı. Geçmiş aylar bugünkü bütçeyle karşılaştırılır (bütçe geçmişi tutulmaz).
- Bay Piyasa bağlamına `butceOzetMetni` eklenir.

## 8c. Nakit Akışı

- Kalan = gelir − harcama − kredi taksitleri (`nakitAyi`). Kart ödemeleri gider sayılmaz (kartla yapılan harcama zaten harcamalarda); KMH faizi nakit çıkışı değil, borca eklenir.
- Taksit tutarı ödeme planından (`krediTaksitleri`): önceki kalan anapara − bu kalan anapara + önceki anapara × aylık faiz/30 × gün × (1 + KKDF + BSMV). İlk taksitte önceki anapara `orijinalAnapara` (yoksa ilk iki satırın farkından tahmin), önceki tarih `kullandirimTarihi` (yoksa bir ay önce). Gerçek veriyle: On Bank Eylül ₺10.706, Garanti ₺2.141.
- Düzenli gelirde ✎: başlangıcı geçmişteyse eski kayıt geçen ay biter, bu aydan yeni kayıt açılır (geçmiş aylar eski tutarla kalır); 0 = bu aydan itibaren biter. ✕ tamamen siler.
- Süren ve gelecek aylarda harcama tahmini (`harcamaTahmini`): bütçe toplamı, yoksa son 6 dolu ayın medyanı; girilen tutar tahminden büyükse o kullanılır.
- Grafik (`nakitGrafikCiz`): 6 geçmiş ay + bu ay + 11 gelecek ay; her ayda gelir çubuğu ve üst üste harcama + taksit; tahmin aylar soluk, tahmini harcama kesik çerçeveli. Bant 34 px'ten darsa etiketler 3 ayda bir. Bir aya tıklamak kartları o aya getirir.
- Kartlar: seçili ayın geliri, gideri, kalanı (`.ton`, tasarruf oranına göre: <0 kırmızı, %0–20 sarı, ≥%20 yeşil) ve önümüzdeki 12 ayın taksit toplamı + kredilerin bittiği ay ve ardından açılan aylık pay.

## 8h. Aylık Rapor

- `raporVerisi(ay)`: harcama (önceki ay, önceki 6 dolu ayın ortalaması, kategori bazında), bütçe (toplam ve aşanlar), Nakit Akışı (`nakitAyi`), kredi anaparası azalışı (`krediKalanTarihte`: önceki ayın son günü ile bu ayın son günü arasında ödeme planındaki kalan anapara farkı), ay içindeki ilk ve son net varlık kaydı.
- "Öne çıkanlar" (`raporOneCikanlar`) kurallıdır, API'ye gitmez: toplam değişim (±%5 eşiği), ortalamaya göre, en çok artan/azalan kategori (en az ₺500 ve %10), ortalamasının 1,8 katını aşan kategori, bütçe, tasarruf oranı, borç ve net varlık.
- Bay Piyasa yorumu (`raporYorumla`): yalnızca rakamlardan oluşan `raporMetni` + borç planı ve hedef özetleri; `BP_SISTEM`, seçili model, günlük limit ve maliyet sayacı (`bpHarcamaEkle`); paylaşım izni yoksa önce onay. Sonuç `ft_raporlar_v1`'e ay kimliğiyle yazılır (tekrar açınca ücret yok; "Yeniden yorumla" üzerine yazar).
- Yazdır / PDF: `@media print` yalnızca rapor sekmesini basar.

## 8g. Birikim Hedefleri

- `hedefHesap`: birikim (elle `birikmis`; bağlı ise `yatirimDegerHesapla` ile canlı TL, $ hedefte ÷ kur), kalan, kalan ay (bu ay hariç, hedef ayı dahil; en az 1), ayda gereken = kalan ÷ ay. Plan çizgisi: eklendiği gün `baslangicDeger`'den hedef ayının sonuna doğrusal; birikim çizginin önündeyse "planın önünde".
- Kartlar: toplam hedef (TL; $ hedefler bugünkü kurla), biriken ve yüzde, ayda gereken toplam (gelir girildiyse Nakit Akışı'nın son 6 ay ortalama kalanıyla kıyas), en yakın hedef.
- Satır: + birikime ekle/çıkar (yalnızca elle), ✎ hedef tutarı, ✕ sil; satır içi işlem kutusu `_hedefIslem`. Bağlı hedefler her fiyat turunda (sekme açık ve işlem kutusu kapalıyken) yeniden çizilir.

## 8f. Net Varlık Geçmişi

- Kayıt (`netGecmisKaydet`): `refreshAll` fiyat turu bitince; `_senkronHazir` değilse ya da yatırım varken `_toplamYatirimTL` 0 ise yazmaz. Günde bir kayıt (id = tarih); aynı gün yalnızca 30 dakika geçmiş ve net en az ₺100 / %0,1 değişmişse güncellenir. En fazla 3650 gün tutulur.
- `netDurum()` Finansal Durumum'un hesabıyla aynı: varlıklar + yatırımlar − (kredi + kart + KMH + elden).
- Kartlar: bugünkü net (canlı) ve $ karşılığı; 7 ve 30 gün değişimi (hedef güne eşit ya da önceki en yakın kayda göre; yatırım ve borç katkısıyla); başlangıçtan beri (TL ve günün kuruyla $).
- Birim: grafik ₺ TL / $ Dolar / Altın (gram 24 ayar) arasında seçilir (`_netBirim`); her gün kendi kuruyla çevrilir (`netKayitKur`: önce kayıttaki `usd`/`gram`, yoksa `ft_gunluk_kur_v1`'deki o gün ya da önceki 4 günün kapanışı — `gunlukKurlariTamamla`, Yahoo USDTRY=X ve GC=F, 10 dakikada en fazla bir deneme). Gram = ons ÷ 31,1035 × kur (`gramAltinTL`). Bugünkü kayıtta kur ya da gram eksikse yarım saat kuralı beklenmeden tamamlanır. Aylık özette Dolar ve Altın (gr) sütunları; bugün kartında $ ve gr; başlangıçtan beri kartında dolar ve altın bazında değişim.
- Grafik 30/90/365 gün/tümü; fareyle en yakın günün varlık/yatırım/borç dökümü. Aylık özet: her ayın son kaydı ve önceki aya göre değişim.
- Geriye dönük doldurma yok: kayıt ilk açılış gününden başlar (RULES › Veri 5 istisnası).

## 8e. Ödeme Takvimi

- Olaylar (`odemeOlaylari(bas, bit)`): kredi taksitleri (`krediTaksitleri`, "Taksit n/N"), kart son ödeme günleri (tutar yalnızca sıradaki ödemede = bugünkü kart borcu; sonrakiler "ekstreye göre"), düzenli ödemeler (aylık ya da yıllık ayında). Gün ayda yoksa son güne kayar (31 → 28 Şubat).
- Kartlar (seçili ay; liste ve takvimle aynı): **1) "Ekim ödemeleri"** — ayın bütün ödemelerinin toplamı, ödenenler dahil, gün geçtikçe değişmez (altında Taksit / Kart / Düzenli dağılımı); **2) "Ekim kalan"** — bugünden önceki ödemeler ödendi sayılır; altında Ödendi ✓ ve Sıradaki; kenar: ödeme 2 gün içindeyse kırmızı, hepsi ödendiyse yeşil; 3) aylık sabit ödemeler; 4) abonelikler (yıllık). Listede geçmiş ödemeler "✓ ödendi" soluk ve üstü çizili, takvimde ✓.
- Kart dönem tutarı (`odemeKartDonemKaydet`, `renderOdeme` ve saatlik şerit tazelemesinde): kartın sıradaki son ödeme ayına bugünkü kart borcu `donem['YYYY-MM']` olarak yazılır; tarih geçince donar ve geçmiş/ödenmiş satırda o tutar kullanılır (kart borcu ödeme sonrası düşse de ay toplamı sabit kalır). Gün değiştirilince dönemler korunur.
- Takvim ızgarası (Pzt başlangıç), güne tıklayınca o günün ödemeleri. "Yaklaşan ödemeler" listesi takvimle **aynı ayı** gösterir (iki seçici birlikte değişir; liste bir sonraki aya taşmaz): bu aydaysa bugünden sonrası, gelecek ayda tamamı, geçmiş ayda soluk. Varsayılan ay: bu ayda bugünden sonra ödeme kalmışsa bu ay, yoksa sonraki ay.
- Kart tutarı yalnızca **sıradaki** son ödeme gününde (bugünden itibaren hesaplanır) bugünkü kart borcudur; hangi ay görüntülenirse görüntülensin sonrakiler "ekstreye göre" (toplama girmez).
- Piyasa Özeti'nin üstünde `#odemeSerit`: 3 gün içindeki ödemeler (tıklayınca Ödeme Takvimi). Açılışta ve saatte bir tazelenir.
- Nakit Akışı'na eklenmez (faturalar harcamalarda zaten var); yalnızca hatırlatma.

## 8d. Borç Kapatma Planı

- Plana girenler (`planBorclari`): krediler (bakiye `loanGuncelBorc`, asgari = ödeme planındaki sıradaki taksit), KMH (bakiye `kmhCanli`, asgari = yalnızca faiz), elden borçlar (faizsiz, asgari yok) ve kullanıcının “faiz işliyor” diye işaretlediği kartlar (asgari = faiz ile bakiyenin %20'sinden büyüğü). Her ay tamamı ödenen kartlar harcama sayılır, girmez. Etkin aylık oran = aylık faiz × (1 + KKDF + BSMV).
- Benzetim (`borcBenzet`): ay ay faiz eklenir, asgariler ödenir. Plan senaryosunda borca ayrılan aylık toplam (ilk ayın asgarileri + ek) sabit kalır; artan para ve biten borcun boşalan ödemesi yöntemin sıradaki borcuna gider (Çığ: en yüksek oran; Kartopu: en küçük bakiye). Tek seferlik ödeme 0. ayda aynı sırayla dağıtılır. “Yalnız asgari” senaryosu aktarım yapmaz; yalnızca vadesiz borç kalınca durur (KMH ve elden borç kendiliğinden kapanmaz).
- Doğrulama: yalnız asgaride On Bank Tem 2027'de, Garanti Şub 2029'da bitiyor (ödeme planıyla aynı; Garanti planda Mar 2029 — son taksit ayı yuvarlaması). Gerçek veriyle ₺5.000 ek ödeme: Çığ Ağu 2027, faiz ₺22.908; Kartopu ₺30.544.
- Ek ödeme kutusu yazarken hemen hesaplar, 600 ms sonra kaydeder (her tuşta senkron yazmasın).

## 9. Arayüz

- Menü hep açık grup başlıklarıyla: Piyasa Özeti · **Varlık ve borç** (Finansal Durumum, Yatırımlarım, Borçlarım) · **Harcama ve bütçe** (Harcama Takibim, Ödeme Takvimi, Nakit Akışı, Bütçe) · **İstatistikler** (Net Varlık Geçmişi, Portföy İstatistikleri) · **Planlama** (Borç Kapatma Planı, Birikim Hedefleri) · **Asistan** (Bay Piyasa, Aylık Rapor). Açılır/kapanır alt menü bilinçli olarak kullanılmadı: harcama girişi sık yapılan bir iş, fazladan tık istemez; telefondaki alt çubukta da çalışmaz.
- Masaüstünde solda sabit menü; 900 px altında menü **alta sabit sekme çubuğu** olur: yalnızca `data-alt` işaretli 6 sayfa (Piyasa · Durum · Yatırım · Borç · Harcama · Asistan — kısa etiket `data-kisa`) ve **Diğer** düğmesi. Diğer, alttan açılan bir sayfada geri kalan sayfaları menüdeki gruplarıyla listeler (`digerMenuAc`, menüden otomatik üretilir); böyle bir sayfa açıkken Diğer yanar. Senkron durumu ve çıkış üstte ince bir satırda kalır.
- Tüm sekmeler 390 px telefon genişliğinde yatay taşma olmadan test edilir.
- ETF dışı kartların alt satırları (`kartEkSatirlari`): **Dün** — önceki kapanış ve düne göre fark (Dolar/Euro/Brent: Yahoo; altın: Twelve Data `previous_close`), **Aralık** — günün en düşük–en yüksek değeri; kriptoda **24s önce** ve **24s aralık** (Binance ticker `openPrice`, `lowPrice`, `highPrice`); uranyumda **Önceki** (yüzdeden geri hesaplanır). ETF'de hiç seans satırı yoksa **Önceki** kapanış gösterilir. 1000 üstü değerlerde alt satırlarda küsurat gösterilmez.
- **Ortak tasarım dili** (Finansal Durumum, Yatırımlarım, Borçlarım, Harcama Takibim, Portföy İstatistikleri — Piyasa Özeti kartlarıyla aynı). Her sayfa üstte özet kartları, altında başlığında toplamı/puanı olan bölümler ve sonda tek Not ile kurulur; tablolar `.ist-tablo`, dağılım çubukları `istHbar`, başlıktaki seçiciler `.bolum-secim`:
  - Özet kartı `.ozet-kart` (renkli sol kenar: yeşil varlık, kırmızı borç, sarı oran; `.ozet-etiket`, `.ozet-deger`, `.ozet-alt`, çizgili detay satırları `.card-seanslar`), ızgara `.ozet-grid`.
  - Bölüm `.bolum`: başlık + bölüm toplamı + **+ Ekle** (`bolumFormAc`) ile açılan `.bolum-form`.
  - Liste satırı `satirHtml()`: LED, ad (`dil` ile büyük harf kuralı: ETF/kripto adları `en` → BITCOIN; Türkçe adlar sayfa dili `tr` → ALTIN, GÜMÜŞ), alt bilgi, tutar, ✎ (satır içi düzenleme) ve ✕ sil / ✓ kapattım. Düzenleme durumu `_duzen` ile saklanır; dakikalık yeniden çizimde açık kutu ve yazılan değer korunur.
  - Açıklamalar her sayfanın altında tek bir **Not** satırındadır.
- **Portföy yaşı** bölümü ince bir listedir (grafik + tablo birleşik): kod + tam ad + kategori (geniş sütun; telefonda ad kodun altında) · daha kısa yaş çubuğu (kategori rengi; sarı dikey çizgi = ortalama) · yaş · pay, yaşa göre sıralı. Yaşa tıklanınca satır içinde düzenlenir (`istYasDuzenle`; Enter kaydeder, Esc vazgeçer, odaktan çıkınca kaydeder). Yeniden çizimde açık kutu ve değer korunur; çizim sırasında kaldırılan kutunun `blur`'u kaydetme sayılmaz (`_yasCiziliyor`).
- **Yatırım performansı** (Yatırımlarım › Toplam Yatırım kartı): Günlük / Haftalık / Aylık ▲▼ yüzde ve ₺ farkı. Bugünkü adetler 1, 7 ve 30 gün önceki kapanış fiyatları ve o günkü USD/TRY ile değerlenir (`yatirimPerformans`); yalnızca piyasa hareketini gösterir, BİST sabit. Seriler: Yahoo günlük (ETF, GC=F, SI=F, USDTRY=X) ve Binance günlük (kripto), 30 dk bellekte önbellek (`perfSerileriGetir`). Referans **takvim gününe** göre seçilir (`seriDeger`): Yahoo çubukları açılış saatiyle işaretli olduğundan saate göre kesmek "dün"ü bir önceki işlem gününe kaydırıyordu. Telefonda ₺ farkı kısa biçimde ("+₺12 bin").
- Finansal Durumum › Varlık Dağılımı: SVG halka grafik (`halkaGrafikSvg`) — dilimler arası 2 px eşit aralık (kart zemini), açı = taban + (360 − n × taban) × pay (taban ≤ 12°): küçük paylar görünür (%0,5 ≈ 13°), dönüşüm doğrusal ve artan olduğu için büyük pay her zaman daha büyük çizilir (sıra bozulmaz); gerçek yüzdeler açıklamada ve dilim ipucunda. Ortası boş.
- Çeşitlendirme / Borç karşılama / Döviz koruması çubukları: açıklama sütunu 250 px (Çeşitlendirme'de kod + tam ad), değer sütunu sabit 150 px (çubuklar aynı yerde biter), çubuk ≈%18 kısa; telefonda üst satır açıklama + değer, altında tam genişlik çubuk.
- **Çerçeve rengi:** Yatırımlarım'daki tür çerçeveleri `.bolum.cerceve-varlik` (yeşil), Borçlarım'daki çerçeveler `.bolum.cerceve-borc` (kırmızı): 4 px renkli sol çizgi ve soldan hafif renk yansıması; diğer kenarlar normal. Tutarlar türün kendi rengini korur. Yatırımlar tek "Portföyüm" çerçevesi yerine çerçevesiz bir başlık (toplam + Ekle) altında türe göre ayrı çerçevelerdedir; türün + düğmesi formu o tür seçili açar (`yatirimEkleAc`).
- **Öne çıkan kart** `.ozet-kart.vurgu`: sayfanın tek ana göstergesi için (ör. Portföy İstatistikleri'nde genel puan) — 2 sütun, 34 px değer, derece rozeti `.puan-rozet`, kalın çubuk, puan renginde hafif zemin; telefonda tam genişlik. Sayfa başına en fazla bir tane. `.orta` varyantı 26 px değer kullanır (Borçlarım › Toplam Borç; nabız efektiyle). Yatırımlarım › Toplam Yatırım yeşil 23 px ve nabızlı; kartında `.ton` varyantı var (öne çıkan kartın renkli çerçevesi ve zemin yansıması, genişlik değişmeden; sol kenar tam renk). `.ton` ayrıca: Finansal Durumum › Net Varlık (çerçeve ve rakam yeşil; eksi ise kırmızı), Yatırımlarım › Yatırım / Borç Oranı (%50 altı kırmızı, %50–99 sarı, %100+ yeşil — kenar, çerçeve ve zemin birlikte).
- Piyasa Özeti kartları kompakttır: yüzde değişim ve seans notu aynı satırda, ETF seans satırları ince bir çizgiyle ayrılır. Hedef: 1440×900 ekranda kartlar ve grafik kaydırmadan görünsün.

## 10. Deploy

- **Ön yüz:** `main` dalına push → GitHub Pages.
- **Worker:** `npx.cmd wrangler deploy` ([wrangler.toml](wrangler.toml)). `keep_vars = true` panelden eklenen değişkenleri korur, `preview_urls = false` sürüme özel önizleme adreslerini kapatır; secret'lar deploy'dan etkilenmez.

## 11. Sürüm geçmişi

| Tarih | Değişiklik |
|---|---|
| 2026-09-29 | Worker repoya eklendi; `/td-series` parametreleri URL'ye kodlanıyor; `wrangler.toml` ile CLI deploy; API anahtarları secret'a taşındı; README/PROJECT/RULES ve .gitignore eklendi |
| 2026-09-30 | Ödeme Takvimi kartları: 1. "Ekim ödemeleri" ayın sabit toplamı, 2. "Ekim kalan" (Önümüzdeki 7 gün kaldırıldı); kart dönem tutarı kaydedilir, ödeme günü geçince toplam değişmez |
| 2026-09-30 | Harcama ve bütçe grubunda sıra: Harcama Takibim, Ödeme Takvimi, Nakit Akışı, Bütçe |
| 2026-09-30 | Ödeme Takvimi: "Bu ay · kalan" kartı seçili ayın ödemeleri oldu (ör. Ekim ödemeleri); bugünden önceki ödemeler ödendi sayılır, kalan tutar ona göre |
| 2026-09-30 | Harcama kategorilerine Araç bakım, Sigorta ve Vergi eklendi (12 kategori) |
| 2026-09-30 | Ödeme Takvimi: yaklaşan ödemeler 45 gün yerine takvimle aynı ay (ay taşması yok); kart tutarı yalnızca sıradaki son ödeme gününde |
| 2026-09-30 | Menüde İstatistikler grubu Planlama'nın üstüne alındı |
| 2026-09-30 | Net Varlık Geçmişi: grafik TL / dolar / gram 24 ayar altın bazında; kayda gram altın fiyatı eklendi; aylık özete Altın (gr) sütunu; kuru olmayan eski kayıtlara günlük kapanış |
| 2026-09-30 | Yatırımlarım'da her tür (ABD ETF, Kripto, BİST, Emtia) ayrı çerçevede (tür, kalem sayısı, pay, toplam, o türü seçili açan +); yatırım çerçeveleri yeşil, borç çerçeveleri kırmızı 4 px sol çizgi + hafif yansıma |
| 2026-09-30 | "Harcama İstatistikleri" sayfasının adı "Harcama Takibim" oldu (menü, başlık, notlar) |
| 2026-09-30 | Aylık Rapor: ayın harcama/bütçe/nakit/borç/net varlık özeti, kurallı öne çıkanlar, kategori tablosu, kaydedilen Bay Piyasa yorumu, yazdır/PDF |
| 2026-09-30 | Birikim Hedefleri: TL/$ hedefler, ayda gereken, plan çizgisi, elle ya da yatırıma bağlı birikim, Nakit Akışı kıyası |
| 2026-09-30 | Net Varlık Geçmişi: günlük otomatik kayıt, 7/30 gün ve başlangıçtan beri değişim, aralık seçmeli grafik, aylık özet |
| 2026-09-30 | Ödeme Takvimi: taksitler, kart son ödeme günleri, düzenli ödemeler ve abonelikler; 45 günlük liste, aylık takvim, Piyasa Özeti'nde 3 günlük uyarı şeridi |
| 2026-09-30 | Borç Kapatma Planı: ek/tek seferlik ödeme, Çığ ve Kartopu karşılaştırması, yalnız asgari senaryosu, borç azalış grafiği, kapatma sırası, faiz işleyen kart seçimi; menüye Planlama grubu |
| 2026-09-30 | Nakit Akışı sayfası: gelirler (düzenli/tek seferlik, zam geçmişi korunur), kredi taksitleri ödeme planından, ay sonu kalan ve tasarruf oranı, 18 aylık gerçekleşen + tahmin grafiği, kredilerin bitişi |
| 2026-09-30 | Bütçe sayfası (kategori sınırları, medyan öneri, aşım, 12 aylık ısı tablosu); menüye "Harcama ve bütçe" grubu; telefonda alt çubuk 6 sayfa + Diğer menüsü; yeni senkron anahtarları Worker'a eklendi |
| 2026-09-30 | KMH canlı faiz: aylık faiz + anapara ile borç her gün kendiliğinden artıyor (faiz + %15 KKDF + %15 BSMV, anaparaya işler); ⚙ ayar penceresi; formül bankanın gerçek rakamıyla doğrulandı |
| 2026-09-30 | Elden nakit: dövizli borcun TL karşılığı güncel kurla hesaplanıyorsa satır ve özet ışığı yeşil yanar |
| 2026-09-30 | E-posta + şifre ile giriş ekranı (yeni tasarım, şifre göster/gizle, Türkçe doğrulama mesajları, e-posta hatırlama); Worker'da `LOGIN_USER` kontrolü, birleşik hata mesajı; gerçek Worker kodu yerelde (wrangler dev) test edildi |
| 2026-09-29 | Harcama girişi ay bazında: tarih yerine ay seçimi (ayın ilk 10 gününde önceki ay varsayılan), kayıtlarda "Eylül 2026", en son eklenen üstte |
| 2026-09-29 | BİST hisseleri kod + adetle eklenip arka planda takip ediliyor (Yahoo KOD.IS, 15 dk gecikmeli, günlük değişim, performansa dahil); geçersiz kod anında uyarı |
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
