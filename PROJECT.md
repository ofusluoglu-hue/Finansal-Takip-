# Proje Dokümantasyonu

Finansal Takip Paneli'nin teknik yapısı. Genel tanıtım için [README.md](README.md), geliştirme kuralları için [RULES.md](RULES.md).

## 1. Genel yapı

Uygulama iki parçadan oluşur:

- **Ön yüz:** [piyasa-paneli.html](piyasa-paneli.html), tek dosya, çerçeve (framework) ve derleme adımı yok. GitHub Pages'ten sunulur. Tek dış kütüphane: SheetJS (`xlsx`, Excel içe aktarma için, cdnjs'ten).
- **Arka uç:** [cloudflare-worker.js](cloudflare-worker.js), Cloudflare Worker (`weathered-dream-54b3`). API anahtarlarını saklar, dış servislere aracılık eder, verileri D1'de tutar.

Worker adresi ön yüzde `MY_WORKER` sabitindedir.

## 2. Kimlik doğrulama ve hesaplar

Panel çok kullanıcılıdır. Kayıt ekranı yoktur; hesapları yönetici açar.

1. **Tablolar (D1):** `users (id, email UNIQUE, ad, pass_hash, pass_salt, pass_iter, role 'admin'|'user', disabled, must_change, created_at, last_login, foto, ayar)` (`foto`: 192×192 JPEG data URL, en fazla 120 KB, `FOTO_RE` ile doğrulanır; `ayar`: JSON tercihler, yalnız `TERCIH_ALANLARI` = `acilis`; iki sütun `semaHazirla`'da `pragma_table_info` kontrolüyle bir kez eklenir), `sessions (token_hash PK, user_id, created_at, expires_at, last_seen)`, `ukv (user_id, key, value, updated_at, PK(user_id, key))`, `auth_fail (ip, ts)`. Eski tek kullanıcılı `kv` tablosu yedek olarak durur, artık okunmaz.
2. **Şifre:** PBKDF2-SHA256, 16 bayt rastgele tuz, `SIFRE_ITER` = 20.000 tekrar (Workers ücretsiz planı istek başına ~10 ms CPU verir; 60.000 ≈ 22 ms ölçüldü). Tekrar sayısı kullanıcı başına saklanır; artırılırsa eski şifreler kendi sayısıyla doğrulanmaya devam eder. En az 8 karakter.
3. **Giriş:** `POST /auth/login {email, password}` → `{token, kullanici:{id,email,ad,rol,sifreDegismeli}}`. Token 32 rastgele bayt (base64url); veritabanında yalnızca SHA-256 özeti tutulur. 180 gün geçerli, kullanıldıkça uzar (saatte en fazla bir yazma). Kayıtlı olmayan e-postada da aynı PBKDF2 hesabı yapılır (e-postanın kayıtlı olup olmadığı süreden anlaşılmasın); hata mesajı hangi bilginin yanlış olduğunu söylemez.
4. **Kilit:** her hatalı deneme `auth_fail`'e IP ve `e:<eposta>` olarak yazılır; 15 dakikada 8 hata → o IP ve o e-posta 429. Açık oturumla yapılan istekleri e-posta kilidi etkilemez.
5. **Ön yüz:** oturum anahtarı `ft_erisim`, hesap bilgisi `ft_kullanici` (yalnızca yerel). `window.fetch` sarmalanmıştır: **yalnızca** `MY_WORKER` adresine giden isteklere `Authorization: Bearer <oturum>` eklenir; üçüncü taraf proxy'lere asla. Worker 401 dönerse giriş ekranı açılır ("Oturumun sona erdi").
6. **Zorunlu şifre değişimi:** yöneticinin açtığı ya da şifresini sıfırladığı hesapta `must_change = 1`; açılışta kapatılamayan "Şifremi değiştir" penceresi çıkar (`formModal`). `POST /auth/sifre {eski, yeni}` başarılıysa diğer oturumlar kapatılır.
7. **Cihazda hesap değişimi:** `oturumKaydet` önceki `ft_kullanici.id` farklıysa yerel senkron verisini, senkron durumunu ve `ft_yedek_*` anahtarlarını siler (veriler karışmasın). Hesap bilgisi olmayan eski cihazdaki veri yöneticinin sayılır.
8. **Eski sürümden geçiş:** `ft_erisim`'de eski erişim kodu varsa ve `ft_kullanici` yoksa `oturumYukselt` açılışta `/auth/me` (eski kodla) → `/auth/login` (aynı e-posta ve kodla) yapar ve kodu oturum anahtarıyla değiştirir; kullanıcı yeniden giriş yapmaz. Worker geçiş süresince `Bearer == ACCESS_TOKEN`'ı ilk yöneticinin oturumu sayar ve `/auth/check`'i yanıtlar. Kullanıcı tablosu boşsa ilk istekte `LOGIN_USER` + `ACCESS_TOKEN` ile yönetici açılır ve `kv` satırları ona kopyalanır (`semaHazirla`, bir kez).
9. **Yönetici:** menüde **Yönetim › Kullanıcılar** ve kılavuzdaki ilgili bölüm `.nav-yonetim[hidden]` ile yalnız yöneticide görünür (`hesapArayuzu`); Worker'daki `/admin/*` uçları ayrıca rolü kontrol eder. Yönetici kendi hesabını devre dışı bırakamaz ve silemez.
9b. **Profil:** kenar çubuğunun en üstünde `#profilKutu` (avatar `avatarHtml`: fotoğraf ya da baş harfler, renk e-posta/id'den; görünen ad `gorunenAd`); tıklayınca `profil` sekmesi (menüde ayrı öğe değil, `switchTab('profil')`). Hesap bilgisi `ft_kullanici`'de önbelleklenir, açılışta ve Profilim açılınca `/auth/me` ile tazelenir (`profilYenile`). Fotoğraf tarayıcıda ortadan kare kırpılıp 192 px JPEG'e çevrilir (`profilFotoSec`). Açılış sayfası tercihi sayfa yüklenirken uygulanır (`acilisSayfasi`; yönetici sayfası yalnız yöneticide). Telefonda üst satırda avatar + ad solda, senkron durumu sağda; çıkış Diğer › Hesap ve Profilim'de.
10. **Çıkış:** bekleyen değişiklikler gönderilir, `/auth/logout` oturumu siler, yerel veriler silinir.
11. **Yapay zekâ (kendi anahtarını getir):** yönetici `ANTHROPIC_API_KEY` ile çalışır. Diğer kullanıcı Profilim › Bay Piyasa'da anahtarını ekler: `POST /auth/ai-anahtar` biçimi denetler (`sk-ant-…`), Anthropic `GET /v1/models` ile ücretsiz doğrular, AES-GCM ile şifreler (anahtar: secret `AI_ANAHTAR_SIFRE`; ek doğrulama verisi kullanıcı kimliği — şifreli metin başka hesaba kopyalanırsa çözülmez) ve `users.ai_anahtar / ai_ipucu / ai_eklendi`'ye yazar; `DELETE` siler. İstemciye yalnız `aiAnahtar: {var, ipucu: 'sk-ant-…ab12', eklendi}` döner. `/ai` ve `/extract-loan` kullanıcının anahtarını çözer; yoksa 403 `anahtar_gerekli`, Anthropic anahtarı reddederse 400 `anahtar_gecersiz` (401 dönülmez: panelde oturum bitti sayılır). Panelde `aiKullanilabilir()`: anahtarı olmayana Bay Piyasa'da "Anahtarını ekle" notu ve göndermede yönlendirme; haber çevirisi yapılmaz. Yer kararı: BYOK uygulamalarındaki yaygın kalıp (ayarlar + özelliğin kilitli olduğu yerde bağlam düğmesi).

## 3. Veri saklama ve senkron

- `localStorage` hızlı önbellektir; kalıcı kaynak **Cloudflare D1** (`finansal-takip` veritabanı, `ukv` tablosu: her satır bir kullanıcının bir anahtarı).
- Senkronlanan anahtarlar hem ön yüzde (`SENKRON_ANAHTARLARI`) hem Worker'da (`IZINLI_ANAHTARLAR`) tanımlıdır. **İkisi aynı olmalıdır.**

| Anahtar | İçerik |
|---|---|
| `ft_yatirimlar_v1` | Yatırımlar (portföy) |
| `ft_varliklarim_v1` | Varlıklar |
| `ft_custom_loans_v1` | Kullanıcının eklediği krediler |
| `ft_closed_loans_v1` | Kapatılan kredilerin id listesi |
| `ft_sabit_krediler_v1` | Eski sürümde kodda tanımlı olan krediler (yalnız ilk yöneticinin hesabında; yeni kullanıcıda boş — kod artık kişisel kredi verisi içermez) |
| `ft_kredi_kartlari_v1` | Kredi kartları |
| `ft_kmh_v1` | KMH borçları |
| `ft_elden_nakit_v1` | Elden nakit borçlar |
| `ft_bay_piyasa_v1` | Bay Piyasa sohbetleri, ayarları, harcama |
| `ft_haber_ceviri_v1` | Haber başlığı çeviri önbelleği |
| `ft_harcamalar_v1` | Harcamalar: tek harcama kayıtları ve elle yazılan aylık kategori toplamları |
| `ft_butce_v1` | Bütçe: kategori başına aylık sınır `[{ id:'b-<kat>', kat, limit, tarih }]`; aya özel `{ id:'b-<kat>-YYYY-MM', kat, ay, limit }` |
| `ft_gelirler_v1` | Gelirler: `{ id, tur:'duzenli', ad, tutar, baslangic, bitis }` ya da `{ id, tur:'tek', ad, tutar, ay }` (aylar `YYYY-MM`) |
| `ft_borc_plan_v1` | Borç planı ayarları: `{ id:'ayar', ek, tek, strateji }`, faiz işleyen kartlar `{ id:'kart-<kartId>', faizli, oran, asgari }` ve Nakit Akışı varsayımları `{ id:'nakit-ayar', enf, elle, artis }` |
| `ft_odemeler_v1` | Ödeme Takvimi (kart kaydında ayrıca `donem`, `ekstre`, `asgari`, `plan`: `{ 'YYYY-MM': tutar }`; düzenli ödemede `harcamaKat`, `atla`): düzenli ödemeler `{ id:'o-…', tur:'duzenli', ad, tutar, gun, periyot:'aylik'\|'yillik', ay, kat }` ve kart son ödeme günleri `{ id:'kart-<kartId>', tur:'kart', kartId, gun }` |
| `ft_net_gecmis_v1` | Günlük net varlık kaydı `{ id:'YYYY-MM-DD', net, varlik, yatirim, borc, usd, gram, t, tamam? }` (`gram`: o anki gram 24 ayar altın TL fiyatı; `tamam`: ay sonu sonradan tamamlandıysa varlık/borcun alındığı gerçek kaydın günü) |
| `ft_hedefler_v1` | Birikim hedefleri `{ id:'hd-…', ad, hedef, birim:'TL'\|'USD', ay, kaynak:'elle'\|'tum'\|'yatirim'\|'varlik', yatirimlar:[id], varliklar:[id], acil?, birikmis, baslangic, baslangicDeger }` (eski `kaynak:'y:<id>'` de okunur) |
| `ft_kartlar_v1` | Piyasa Özeti kart seçimi: `{ id:'ayar', gorunen:[kart anahtarları, sırayla] }` ve kullanıcının eklediği semboller `{ id:'oz-<sembol>' (kripto: 'oz-k-<sembol>'), tur:'etf'\|'kripto', sembol, ad }`. Kayıt yoksa yöneticide tüm hazır kartlar, diğerlerinde `VARSAYILAN_KARTLAR` (Dolar, Euro, Altın, Bitcoin, VOO, QQQM); bu varsayılan kendiliğinden yazılmaz |
| `ft_raporlar_v1` | Aylık Rapor'un Bay Piyasa yorumları `{ id:'YYYY-MM', metin, model, maliyet, ts }` (son 36 ay) |

Yalnızca yerelde tutulanlar: `ft_erisim` (oturum anahtarı), `ft_kullanici` (giriş yapan hesap: id, e-posta, ad, rol, şifre değişmeli mi), `ft_giris_eposta` (son giriş e-postası), `ft_senkron_meta` (senkron durumu), `ft_fx_son_bilinen_v1` (son bilinen kurlar), `ft_gram_altin_son_v1` (son bilinen gram altın TL fiyatı; altın cinsinden varlık için, fiyat gelmeden açılışta), `ft_harcama_birim` (Harcama grafiği birimi), `ft_gunluk_kur_v1` (günlük USD/TRY ve gram altın kapanışları; kuru olmayan eski net varlık kayıtları için), `ft_aylik_kur_v1` (her ayın ortalama USD/TRY kuru ve gram altın fiyatı; harcamaların dolar/altın karşılığı için), `ft_yatirim_son_fiyat_v1` (yatırımların son bilinen fiyat/tutarı; fiyat her yenilendiğinde senkron listesi yeniden yazılmasın diye ayrı tutulur).

**Senkron akışı:**
- `localStorage.setItem` sarmalanmıştır; senkron anahtarlarına yazılan her **değişiklik** "bekleyen" olarak işaretlenir (değer aynıysa gönderilmez) ve Worker'a `PUT /data/:anahtar` ile gönderilir.
- Çekme: `GET /data?since=<zaman>`, yalnızca son çekmeden sonra değişenler gelir. Açılışta, sekmeye dönüldüğünde ve 5 dakikada bir çalışır.
- Çakışma: istemci `expected` (son bildiği `updated_at`) gönderir; sunucudaki kayıt daha yeniyse Worker 409 ve güncel değeri döner.
- `updated_at` kullanıcının tüm anahtarları genelinde kesinlikle artandır (aynı milisaniyedeki yazmalar `since` çekmesinde kaybolmasın diye).

## 4. Worker uç noktaları

`/` ve `/auth/login` dışındaki her uç nokta geçerli bir oturum ister; `/data` her zaman oturum sahibinin verisini okur/yazar.

| Yol | Metot | Görev |
|---|---|---|
| `/` | GET | Sağlık kontrolü (`{ok:true}`) |
| `/auth/login` | POST | `{email, password}` → `{token, kullanici}`; hatalı denemede kilit sayacı |
| `/auth/me` | GET | Oturumun hesabı (ad, foto, ayar, üyelik ve son giriş tarihi, açık oturum sayısı) |
| `/auth/logout` | POST | Oturumu siler |
| `/auth/profil` | POST | `{ad?, foto?, ayar?}` (foto `null` = kaldır) → güncel `kullanici` |
| `/auth/ai-anahtar` | POST, DELETE | `{anahtar}`: Anthropic'te doğrula, şifreli sakla → güncel `kullanici` (anahtar asla dönmez); DELETE siler |
| `/auth/cikis-diger` | POST | Bu oturum dışındaki bütün oturumları siler → `{kapanan}` |
| `/auth/sifre` | POST | `{eski, yeni}`: kendi şifresini değiştirir, diğer oturumları kapatır |
| `/auth/check` | GET | Eski panel uyumluluğu (geçiş süresince) |
| `/admin/kullanicilar` | GET, POST | Yönetici: hesap listesi (kayıt sayısı ve boyutla) / hesap aç `{email, ad, sifre}` (geçici şifre, `must_change=1`) |
| `/admin/kullanicilar/:id/sifre` | POST | Yönetici: geçici şifre ver, oturumlarını kapat |
| `/admin/kullanicilar/:id/durum` | POST | Yönetici: `{disabled}` girişi kapat/aç |
| `/admin/kullanicilar/:id` | DELETE | Yönetici: hesabı, oturumlarını ve tüm verisini sil |
| `/data` | GET | `since` sonrası değişen kayıtlar |
| `/data/:anahtar` | PUT | Kayıt yazar (`{value, expected}`), en fazla 1,5 MB |
| `/proxy?url=` | GET | CORS proxy; yalnızca izin listesindeki adresler; 60 sn ortak önbellek |
| `/ai` | POST | Anthropic Messages API geçidi (model beyaz listesi, `max_tokens` 200–4000, isteğe bağlı web araması) |
| `/extract-loan` | POST | Kredi planı PDF'ini (`pdfBase64`) Claude ile JSON'a çevirir (banka, faiz, anapara, kullandırım tarihi, ödeme planı) |
| `/td` | GET | Twelve Data anlık fiyat (5 dk önbellek: günlük 800 kredilik ortak kota kullanıcı sayısından bağımsız ≈288/gün kalır) |
| `/td-series` | GET | Twelve Data geçmiş veri (grafik; 10 dk önbellek) |
| `/fh` | GET | Finnhub anlık fiyat (60 sn önbellek) |
| `/fh-ara` | GET | `?q=`: ABD hisse/ETF araması (Finnhub symbol lookup, `exchange=US`); yalnız Common Stock / ADR / ETP / REIT ve `^[A-Z][A-Z.]{0,6}$` semboller, en fazla 15, tam eşleşme önce; aynı sorgu 1 gün önbellekte |
| `/uranyum` | GET | Uranyum (U3O8) fiyatı, MetalCharts sayfasından; 20 dk önbellek |
| `/uranyum-gecmis` | GET | `?aralik=1M` (günlük) / `1Y` (haftalık): U3O8 $/lb geçmişi, MetalCharts API `/v1/history/UXA` (secret `metalcharts`). Ücretsiz katman ayda 200 istek: sonuç D1 `onbellek` tablosunda 12 saat tutulur (en fazla ~120 istek/ay); geçici hata 1 saat, kalıcı hata (plan kapsamı, geçersiz anahtar) 7 gün önbelleklenir (kota boşa gitmez). **Durum (2026-10-01):** ücretsiz katman UXA geçmişini kapsamıyor ("Upgrade to basic or higher"); grafik SRUUF eğilimiyle çalışır, Basic API planına geçilirse kod değişmeden gerçek geçmişe döner, varsa eski sonuç döner. Ücretsiz katman şartı: grafikte görünür "Metal prices by MetalCharts" bağlantısı (`#chartKaynak`) |

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
  - `{ id:'ay-YYYY-MM-kat', tur:'aylik', ay:'YYYY-MM', kat, tutar, kaynak? }` — eski aylık toplam kalemi (Excel aktarımı, 2025 kategorisiz, eskiden tablodan yazılanlar). Artık **diğer kalemlerle toplanır** (yerlerine geçmez); listede "aylık toplam" olarak görünür, ✎/✕ ile düzenlenir. Yeni aylık toplam yazılamaz.
  - **Aylık tablo salt okunurdur** (`harcamaTablosu`: her hücre = o ay ve kategorideki bütün kalemlerin toplamı, `harcamaKalemAyi`). Hücreye tıklamak o ayın o kategorideki kalemlerini listede açar (`harcamaAyKalemleri`, `_harcamaKatFiltre`; ay seçimi ya da yeni kayıt filtreyi kaldırır).
- Kategoriler (`HARCAMA_KATEGORILER`): market, akaryakıt, araç bakım (`aracbakim`), kişisel, fatura ve aidat, ev giderleri, yeme-içme ve eğlence, sağlık, eğitim, sigorta (`sigorta`), vergi (`vergi`), diğer; ayrıca formda seçilmeyen **Kategorisiz** (`genel`) — kategori ayrımı olmayan eski aylık toplamlar (2025 Mart–Aralık) için.
- **Dolar ve gram altın karşılığı:** her ayın harcaması o ayın ortalama kuruyla çevrilir (`aylikKurlariGuncelle`: Yahoo günlük USDTRY=X ve GC=F kapanışlarının ay ortalaması; gram = ons × kur ÷ 31,1035). Tablo altında $ ve gr satırları, kartlarda ve grafik ipucunda gösterilir; yıl toplamı $/gr her ayın kendi kuruyla toplanır.
- **Tüm dönem ortalaması** (`harcamaTumDonem`): bütün yılların tamamlanmış aylarının TL/$/gr ortalaması.
- Aylık ortalama = seçili yılda harcama girilmiş **tamamlanmış** ayların ortalaması (süren ay yarım olduğu için katılmaz; kategori ortalamaları da aynı); yıl sonu tahmini = ortalama × 12. Süren ay kartında önceki ayla kıyas yerine "ortalamanın %X kadarı · ayın G/N günü" gösterilir.
- 2025 Mart–Aralık aylık toplamları (HrcmAylık sayfası, toplam ₺675.029) `genel` kategorisinde aylık toplam olarak eklendi.
- 2026 Ocak–Eylül verisi eski bütçe Excel'inden (Bütçe Hedef Gider 2026.xlsx) bir kereliğine aktarıldı: Ocak–Ağustos aylık kategori toplamı (`kaynak:'excel'`), Eylül tek tek kayıt (`xl-2026-09-*`). Excel artık kullanılmıyor; harcamalar panelden girilir.
- **Grafik birimi** (yıl seçicinin yanında ₺ TL / $ Dolar / Altın; `_harcamaBirim`, bu cihazda `ft_harcama_birim` ile hatırlanır): her ay **o ayın** ortalama kuru ve gram altın fiyatıyla (`T.ayUSD`, `T.ayGr`; `ft_aylik_kur_v1`). Çubuk rengi TL sarı-turuncu, dolar yeşil, altın altın sarısı; eksen, ortalama çizgisi ve başlıktaki yıl toplamı seçili birimde (kuru henüz gelmeyen ay "…" ve başlıkta "… + n ay kur bekleniyor"). İpucu seçili birimde değer + ortalamaya göre fark + diğer iki birim + o ayın ortalama kuru/gram fiyatı + en büyük 3 kategori (seçili birimde). Çubuklar `pointer-events:none` — ipucu çubuğun üstünde de açılır (önceden uzun çubuğun üstünde açılmıyordu).
- Grafik (`harcamaGrafikCiz`, yükseklik `HARCAMA_GRAFIK_H` = 165 px; grafik + Kategoriler satırı ≈223 px): tek renk sütunlar (≤24 px, 4 px yuvarlak üst), ortalama çizgisi, bant genişliğinde isabet alanıyla fare/klavye ipucu; aylık tablo grafiğin tablo karşılığıdır. Kategori dağılımı tek renk yatay çubuk (kimliği etiket taşır; 9 kategori renkle ayırt edilmez); çubuklar en büyük kategoriye göre ölçeklenir, değer sütunu sabit (yıl toplamı + silik aylık ortalama).
- Bay Piyasa: portföy paylaşımı açıkken harcama özeti bağlama eklenir; "💸 Harcama analizi" hazır raporu vardır.

## 8b. Bütçe Planlaması

- Veri `ft_butce_v1`; harcamalar `ft_harcamalar_v1`'den okunur (`butceAyHarcama`: `harcamaTablosu` yıl başına bir kez).
- **Öneri** (`butceOnerileri`): her kategori için son 6 tamamlanmış ve kategorili ayın **medyanı**, 500 TL'ye yukarı yuvarlanır. Ortalama kullanılmaz: Haziran 2026'daki ₺51.608'lik yeme-içme ortalamayı ~₺15 bine çıkarıyor, medyan ₺9.500 veriyor. Bütçe yokken sayfa öneriyi gösterir ve tek tıkla uygular (`butceOnerileriUygula`); ✎/+ satırında boş Kaydet de öneriyi kullanır.
- **İleri plan:** seçici gelecek 12 ayı da içerir ("(plan)"). Tutar "her ay" (`{ id:'b-<kat>', kat, limit }`) ya da "yalnız o ay" (`{ id:'b-<kat>-YYYY-MM', kat, ay, limit }`) kaydedilir; `butceLimitleri(ay)` aya özel tutarı her aykinin yerine koyar. Gelecek ay seçiliyken form ve ✎ varsayılanı "yalnız o ay"; satırda "yalnız Kasım 2026" etiketi; ✕ aya özeli kaldırır (her ayki geri gelir), her aykini kaldırırken aya özeller kalır. Gelecek ayın harcaması, düzenli ödemelerden şimdiden eklenenlerdir ("şimdiden bütçenin %…'i"). Isı tablosunda her ay kendi sınırıyla karşılaştırılır, gelecek aylar "plan" olarak soluk.
- Varsayılan ay: harcama girilmiş en son ay (harcamalar ay bitince girildiği için). Seçici 12 ileri + bu ay + 24 geri; ısı tablosunda ay başlığına tıklamak da ayı seçer.
- Durum (`butceDurum`): >%100 aşım (kırmızı), >%90 ya da süren ayda geçen gün oranının 15 puan önünde sınırda (sarı), değilse iyi (yeşil). Çubuk %150'ye kadar çizer, bütçe sınırı çubuğun üçte ikisinde çizgiyle işaretli (`BUTCE_OLCEK`) — aşımın büyüklüğü görünsün; süren ayda ikinci ince çizgi ayın geçen kısmıdır.
- Toplam = ayın bütün harcaması (bütçesiz kategoriler ve 2025 `genel` dahil) ÷ kategori bütçelerinin toplamı. Geçmiş aylar bugünkü bütçeyle karşılaştırılır (bütçe geçmişi tutulmaz).
- Bay Piyasa bağlamına `butceOzetMetni` eklenir.

## 8c. Nakit Akışı

- Kalan = gelir − harcama − kredi taksitleri (`nakitAyi`). Kart ödemeleri gider sayılmaz (kartla yapılan harcama zaten harcamalarda); KMH faizi nakit çıkışı değil, borca eklenir.
- Taksit tutarı ödeme planından (`krediTaksitleri`): önceki kalan anapara − bu kalan anapara + önceki anapara × aylık faiz/30 × gün × (1 + KKDF + BSMV). İlk taksitte önceki anapara `orijinalAnapara` (yoksa ilk iki satırın farkından tahmin), önceki tarih `kullandirimTarihi` (yoksa bir ay önce). Gerçek veriyle: On Bank Eylül ₺10.706, Garanti ₺2.141.
- Düzenli gelirde ✎: başlangıcı geçmişteyse eski kayıt geçen ay biter, bu aydan yeni kayıt açılır (geçmiş aylar eski tutarla kalır); 0 = bu aydan itibaren biter. ✕ tamamen siler.
- **Enflasyon ve satın alma gücüyle tahmin** (`nakitTahminModeli`; `harcamaTahmini` aynı modeli döndürür):
  - Veri (`ENFLASYON_VERI`, 30.09.2026'da derlendi): TÜİK Ağustos 2026 TÜFE aylık %1,84, yıllık %31,51; TCMB Eylül 2026 Piyasa Katılımcıları Anketi 2026 yıl sonu %29,61, 12 ay sonrası %23,70, 24 ay sonrası %18,32 (hanehalkı 12 ay %45,60 bilgi amaçlı). Derleme ayı 2 aydan eskiyse sayfada turuncu uyarı.
  - Enflasyon yolu (ayar): **TCMB beklentisi** (varsayılan; ilk 12 ay yıllık %23,70 → aylık ≈%1,79, sonrası %18,32 → ≈%1,41), **son resmi TÜFE**, **kişisel** (`kisiselEnflasyon`: son 12 ayın, bir yıl önceki aynı ayı da girilmiş en az 3 ayında harcama toplamının yıllık değişimi — gerçek veriyle Mar–Ağu 2026/2025: %28,72) ya da **elle**. Geçmiş ayları bugüne taşımak için resmi yıllık TÜFE'nin aylık karşılığı (≈%2,31) kullanılır (kişisel/elle seçiliyse o oran).
  - Harcama: taban = bütçe toplamı (bugünün fiyatlarıyla) ya da son 6 dolu ayın **bugünün fiyatlarına taşınmış** medyanı (gerçek veri: ₺94.947); k ay sonrası = taban × Π(1 + aylık enflasyon). Aya özel bütçe olan ayda o ayın toplamı (nominal). Süren ay / girilen tutar büyükse girilen.
  - Maaş (ayar): **her Ocak son 12 ayın enflasyonu kadar** (varsayılan; Ocak 2027 = %30,2), **Ocak ve Temmuz son 6 ayın**, ya da **artış yok**. Yalnız düzenli gelire ve gelecek aylara uygulanır.
  - Taksitler nominal (ödeme planı); reel yükleri azalır. Görünüm: **Nominal ₺** ya da **Bugünün parasıyla** (gelecek tutarlar fiyat çarpanına bölünür; ipucunda diğeri de yazar). Başlıkta 12 ay tahmini birikim hem nominal hem bugünün parasıyla.
  - Ayar `ft_borc_plan_v1` içinde `{ id:'nakit-ayar', enf, elle, artis }` (gelir listesine konmaz: gelir kaydederken liste yeniden yazıldığı için ayar kaybolurdu). Doğrulama: model çıktıları elle hesapla birebir (kişisel %28,72, taşınmış medyan ₺94.947, 12 ay çarpanı 1,2370, Ocak zammı %30,2).
- Grafik (`nakitGrafikCiz`): 6 geçmiş ay + bu ay + 11 gelecek ay; her ayda gelir çubuğu ve üst üste harcama + taksit; tahmin aylar soluk, tahmini harcama kesik çerçeveli. Bant 34 px'ten darsa etiketler 3 ayda bir. Bir aya tıklamak kartları o aya getirir.
- Sayfa her açıldığında içinde bulunulan ay seçilir (süren ayda harcama tahminle tamamlanır). Kartlar: seçili ayın geliri, gideri, kalanı (`.ton`, tasarruf oranına göre: <0 kırmızı, %0–20 sarı, ≥%20 yeşil) ve önümüzdeki 12 ayın taksit toplamı + kredilerin bittiği ay ve ardından açılan aylık pay.

## 8i. Kullanım Kılavuzu

- Sekme `kilavuz` (menüde en altta Yardım grubu; telefonda Diğer menüsünde). İçerik HTML içinde statik: arama kutusu, "İlk kurulum" adımları (bağlantılı), her sayfa için `<details class="kv-bolum">` (ne işe yarar · nasıl kullanılır · örnek · 💡 ipucu · "…'e git" düğmesi), Sık sorulan sorular, Terimler sözlüğü, Verilerin ve güvenlik.
- Arama (`kilavuzAra`): eşleşen bölümleri açar, diğerlerini gizler, kelimeyi `<mark>` ile işaretler (metin düğümlerinde; HTML'e dokunmaz), sonuç sayısını ve Terimler'de bulunduysa onu yazar; boş arama her şeyi geri getirir.
- **Sık Sorulan Sorular** ayrı sekme (`sss`, Yardım grubunda): konulara göre gruplu `<details class="kv-bolum kv-sss">` sorular (Başlarken, Harcama ve bütçe, Borçlar ve kartlar, Gelir ve tahminler, Yatırım ve varlıklar, Hedefler ve acil fon, Görünüm, Hesap–güvenlik–Bay Piyasa). Kılavuzda soru tekrarlanmaz; yerine SSS'ye giden yönlendirme kutusu (`.kv-yonlendir`). Arama ortak: `kilavuzAra(q, sekme, sonucId)`, `kilavuzHepsi(ac, sekme)`; sonuç yoksa diğer yardım sayfasını önerir.
- Her özellik değişikliğinde kılavuz ve SSS son duruma göre kontrol edilip aynı committe güncellenir (RULES › Dokümantasyon).
- Yazım ilkesi: ekrandaki özet kutularına "kutu", kredi kartına "kart" denir (karışmasın). Örnek rakamlar gerçekçi ama açıklama içindir.

## 8h. Aylık Rapor

- `raporVerisi(ay)`: harcama (önceki ay, önceki 6 dolu ayın ortalaması, kategori bazında), bütçe (toplam ve aşanlar), Nakit Akışı (`nakitAyi`), kredi anaparası azalışı (`krediKalanTarihte`: önceki ayın son günü ile bu ayın son günü arasında ödeme planındaki kalan anapara farkı), ay içindeki ilk ve son net varlık kaydı.
- "Öne Çıkan Gelişmeler" (`raporOneCikanlar`) kurallıdır, API'ye gitmez; her madde tam cümle (konu → karşılaştırılan değer → değişim → sonuç, rakamdan sonra ek yerine "tutarı" gibi bir isim): toplam değişim (±%5 eşiği), ortalamaya göre, en çok artan/azalan kategori (en az ₺500 ve %10), ortalamasının 1,8 katını aşan kategori, bütçe, tasarruf oranı, borç ve net varlık.
- Bay Piyasa yorumu (`raporYorumla`): `max_tokens` 12000 (düşünme de bu bütçeden harcar), kesilirse en fazla 2 kez otomatik devam; yalnızca rakamlardan oluşan `raporMetni` + borç planı ve hedef özetleri; `BP_SISTEM`, seçili model, günlük limit ve maliyet sayacı (`bpHarcamaEkle`); paylaşım izni yoksa önce onay. Sonuç `ft_raporlar_v1`'e ay kimliğiyle yazılır (tekrar açınca ücret yok; "Yeniden yorumla" üzerine yazar).
- Sıra: başlık ve KPI kutuları → Bay Piyasa'nın yorumu (başlıkta `BP_AVATAR_SVG` 44 px, `raporYorumAlt`) → Öne Çıkan Gelişmeler → Kategoriler.
- Yazdır / PDF: `@media print` yalnızca rapor sekmesini basar.

## 8g. Birikim Hedefleri

- `hedefHesap`: birikim (elle `birikmis`; bağlı ise `yatirimDegerHesapla` ile canlı TL, $ hedefte ÷ kur), kalan, kalan ay (bu ay hariç, hedef ayı dahil; en az 1), ayda gereken = kalan ÷ ay. Plan çizgisi: eklendiği gün `baslangicDeger`'den hedef ayının sonuna doğrusal; birikim çizginin önündeyse "planın önünde".
- Kartlar: toplam hedef (TL; $ hedefler bugünkü kurla), biriken ve yüzde, ayda gereken toplam — üçünde de **güncel dolar (yeşil) ve gram 24 ayar altın (sarı) karşılığı** (canlı `_fxRates.USD` ve `gramAltinTL()`; sekme açıkken `tlKarsiliklariniYenile` ile her kur/fiyat güncellemesinde yeniden çizilir, işlem kutusu açıkken dokunulmaz) (gelir girildiyse Nakit Akışı'nın son 6 ay ortalama kalanıyla kıyas), en yakın hedef.
- **Dövizli / altın varlık:** Nakit / Mevduat türünde varlık ₺ TL, $ Dolar, € Euro ya da gram altın olarak girilir (`{ birim:'USD'|'EUR'|'ALTIN', miktar, deger }`). TL değeri her yerde `varlikDegerTL` ile canlı hesaplanır (dolar/euro `_fxRates`, gram altın `gramAltinTL()`; yoksa yerel son bilinen gram fiyatı, o da yoksa `deger`). `deger` yalnızca kullanıcı ekleyip ✎ ile değiştirdiğinde o anki fiyatla yazılan TL yedeğidir (fiyat turlarında yazılmaz). Satırda miktar (dolar yeşil, altın sarı) ve güncel kur/gram fiyatı; LED yeşil güncel, kırmızı son bilinen; ✎ yeni miktar alır. Toplam varlık, dağılım, net varlık ve geçmişi, portföy istatistikleri, Bay Piyasa ve hedefler canlı değeri kullanır; kur değişince `tlKarsiliklariniYenile` → `renderYatirim` → `renderVarlik` ile güncellenir. Finansal Durumum sekmesi her açılışta yeniden çizilir (acil fon göstergesi güncel olsun).
- **Acil durum fonu:** Varlıklarım'a **Nakit / Mevduat** türü eklendi (dağılımda "Nakit"). Hedef kaynağı **Varlıklarımdan** (`kaynak:'varlik', varliklar:[id]`; birikim = seçili varlıkların değeri). Formda "Bu bir acil durum fonu" (`acil:true`; eski hedefler adında "acil" geçiyorsa tanınır): ad boşsa "Acil durum fonu" yazılır, Nakit / Mevduat varlıkları kendiliğinden seçilir (adında "acil" geçen varsa yalnız o), 3 ve 6 aylık gidere göre önerilen tutar düğmeleri (5.000'e yuvarlı) çıkar. Aylık zorunlu gider (`aylikZorunluGider`) = Nakit Akışı harcama tabanı (son 6 ayın bugünün fiyatına taşınmış medyanı ya da bütçe) + önümüzdeki 3 ayın ortalama kredi taksidi (gerçek veriyle ₺94.947 + ₺12.782 = ₺107.730). Hedef satırında "🛟 n aylık gider" (<1 kırmızı, <3 sarı, ≥3 yeşil); Finansal Durumum › Toplam Varlık kartında "Acil fon ₺… · n ay" (`acilFonDurum`); Bay Piyasa bağlamına eklenir.
- Birikim kaynağı seçici (`hedefKaynakHtml`; formda `hkf`, satırda ⇄ ile `hks`): **Elle gireceğim** (şu an biriken tutar) ya da **Yatırımlarımdan (otomatik)** — türlere göre gruplu, güncel değerli onay kutuları (çoklu seçim) veya "Tüm yatırımlarım (sonradan eklenenler dahil)" (`kaynak:'tum'`); seçilen toplam anında gösterilir. Kaynak ⇄ ile değişince önceki elle `birikmis` saklanır (elle takibe dönülürse o gelir, yoksa o anki değer yazılır) ve plan çizgisi o günden, o anki birikimden yeniden başlar.
- Satır: + birikime ekle/çıkar (yalnızca elle), ⇄ kaynak, ✎ hedef tutarı, ✕ sil; satır içi işlem kutusu `_hedefIslem`. Bağlı hedefler her fiyat turunda (sekme açık ve işlem kutusu kapalıyken) yeniden çizilir.

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
- Kart satırında sıradaki dönem için **dönem borcu** (`ekstre`), **asgari** (`asgari`) ve **ödeyeceğim** (`plan`) girilir (`odemeKartDonemYaz`; kart kaydında `{ 'YYYY-MM': tutar }`, son 24 dönem). Takvime yazılan tutar (`kartDonemTutari`): ödeyeceğim > dönem borcu > toplam kart borcu. Satırda "ödeme sonrası kalan borç ≈ toplam − ödenecek", ödenecek dönem borcundan azsa "₺… sonraki döneme kalır (faiz işler)", asgariden azsa "asgarinin altında" uyarısı. Ödeme günü geçtiği halde kart borcu (Borçlarım, `tarih`) o günden beri güncellenmediyse 20 gün boyunca "kalan borcu Borçlarım'dan güncelle" hatırlatması (`kartGuncelleHatirlat`). Kalan bakiye otomatik düşülmez; kullanıcı Borçlarım'dan girer.
- Kart dönem tutarı (`odemeKartDonemKaydet`, `renderOdeme` ve saatlik şerit tazelemesinde): kartın sıradaki son ödeme ayına bugünkü kart borcu `donem['YYYY-MM']` olarak yazılır; tarih geçince donar ve geçmiş/ödenmiş satırda o tutar kullanılır (kart borcu ödeme sonrası düşse de ay toplamı sabit kalır). Gün değiştirilince dönemler korunur.
- Takvim ızgarası (Pzt başlangıç), güne tıklayınca o günün ödemeleri. "Yaklaşan ödemeler" listesi takvimle **aynı ayı** gösterir (iki seçici birlikte değişir; liste bir sonraki aya taşmaz): bu aydaysa bugünden sonrası, gelecek ayda tamamı, geçmiş ayda soluk. Varsayılan ay: bu ayda bugünden sonra ödeme kalmışsa bu ay, yoksa sonraki ay.
- Kart tutarı yalnızca **sıradaki** son ödeme gününde (bugünden itibaren hesaplanır) bugünkü kart borcudur; hangi ay görüntülenirse görüntülensin sonrakiler "ekstreye göre" (toplama girmez).
- Piyasa Özeti'nin üstünde `#odemeSerit`: 3 gün içindeki ödemeler (tıklayınca Ödeme Takvimi). Açılışta ve saatte bir tazelenir.
- **Düzenli ödemeler → Harcama Takibim** (`duzenliHarcamaEkle`; senkron hazır olunca, saatlik şerit tazelemesinde ve ödeme eklenince): her düzenli ödeme için **bu ay ve gelecek ay** birer harcama kaydı `{ id:'od-<ödemeId>-YYYY-MM', tur:'kayit', tarih:'YYYY-MM-01', kat, tutar, not:'<ad> — düzenli ödeme', kaynak:'odeme', odemeId }` (yıllık ödeme yalnızca kendi ayında; sabit id ile kopya/çakışma olmaz). Kategori `odemeHarcamaKat`: ödemedeki `harcamaKat`, yoksa abonelik → Yeme-içme ve eğlence, fatura ve kira → Fatura ve aidat, sigorta → Sigorta, diğer → Diğer; 'yok' = eklenmez (satırda ve formda seçilir). Harcamalardan silinen ay ödemenin `atla` listesine yazılır, tekrar eklenmez; elle tutarı değiştirilen kayıt `elle:true` olur ve kendiliğinden güncellenmez. Ödeme tutarı/kategorisi değişince bu ay ve sonrası güncellenir, ödeme silinince bu ay ve sonrası kalkar (geçmiş kalır). Harcama listesinde ↻ ile işaretlidir. Nakit Akışı giderleri harcamalardan geldiği için orada da sayılır.

## 8d. Borç Kapatma Planı

- Plana girenler (`planBorclari`): krediler (bakiye `loanGuncelBorc`, asgari = ödeme planındaki sıradaki taksit), KMH (bakiye `kmhCanli`, asgari = yalnızca faiz), elden borçlar (faizsiz, asgari yok) ve kullanıcının “faiz işliyor” diye işaretlediği kartlar (asgari = faiz ile bakiyenin %20'sinden büyüğü). Her ay tamamı ödenen kartlar harcama sayılır, girmez. Etkin aylık oran = aylık faiz × (1 + KKDF + BSMV).
- Benzetim (`borcBenzet`): ay ay faiz eklenir, asgariler ödenir. Plan senaryosunda borca ayrılan aylık toplam (ilk ayın asgarileri + ek) sabit kalır; artan para ve biten borcun boşalan ödemesi yöntemin sıradaki borcuna gider (Çığ: en yüksek oran; Kartopu: en küçük bakiye). Tek seferlik ödeme 0. ayda aynı sırayla dağıtılır. “Yalnız asgari” senaryosu aktarım yapmaz; yalnızca vadesiz borç kalınca durur (KMH ve elden borç kendiliğinden kapanmaz).
- Doğrulama: yalnız asgaride On Bank Tem 2027'de, Garanti Şub 2029'da bitiyor (ödeme planıyla aynı; Garanti planda Mar 2029 — son taksit ayı yuvarlaması). Gerçek veriyle ₺5.000 ek ödeme: Çığ Ağu 2027, faiz ₺22.908; Kartopu ₺30.544.
- Ek ödeme kutusu yazarken hemen hesaplar, 600 ms sonra kaydeder (her tuşta senkron yazmasın).

## 9. Arayüz

- Menü hep açık grup başlıklarıyla: Piyasa Özeti · **Varlık ve borç** (Finansal Durumum, Yatırımlarım, Borçlarım) · **Harcama ve bütçe** (Harcama Takibim, Ödeme Takvimi, Nakit Akışı, Bütçe Planlaması) · **İstatistikler** (Net Varlık Geçmişi, Portföy İstatistikleri) · **Planlama** (Borç Kapatma Planı, Birikim Hedefleri) · **Asistan** (Bay Piyasa, Aylık Rapor) · **Yardım** (Kullanım Kılavuzu, Sık Sorulan Sorular, Destek ve İletişim) · yalnız yöneticide **Yönetim** (Kullanıcılar). Açılır/kapanır alt menü bilinçli olarak kullanılmadı: harcama girişi sık yapılan bir iş, fazladan tık istemez; telefondaki alt çubukta da çalışmaz.
- Masaüstünde solda sabit menü; 900 px altında menü **alta sabit sekme çubuğu** olur: yalnızca `data-alt` işaretli 6 sayfa (Piyasa · Durum · Yatırım · Borç · Harcama · Asistan — kısa etiket `data-kisa`) ve **Diğer** düğmesi. Diğer, alttan açılan bir sayfada geri kalan sayfaları menüdeki gruplarıyla listeler (`digerMenuAc`, menüden otomatik üretilir); böyle bir sayfa açıkken Diğer yanar. Telefonda üst başlık bloğu (sayfa adı, saat, durum) yapışık değildir (3 satır, ekranın ~%40'ını kaplıyordu). Senkron durumu ve çıkış üstte ince bir satırda kalır; hesap satırı (e-posta, Şifremi değiştir) telefonda gizlenir, Diğer menüsünün sonundaki **Hesap** bölümünde yer alır.
- **Kenar menüsü sıkılığı:** masaüstünde menü öğesi 31 px (`padding:7px 12px`); her grup başlığının üstünde profil çizgisiyle aynı 1 px `var(--border)` tam genişlik çizgi (`margin-top:4px`, `padding:7px 12px 3px`). Menünün tamamı 1440×900'de 857 px ile kaydırmadan görünür (eskiden 1045 px). Ayırıcı için denenip elenenler: kısa sarı vurgu çizgisi (süs gibi, ayırmıyor), başlığın yanından uzanan çizgi (grupları yeterince ayırmıyor), kesikli (kalabalık), silik çizgi (profil çizgisiyle tutarsız), daha az boşluk (başlık çizgiye yapışıyor). Kısa ekranda (`min-width:901px and max-height:880px`, ör. 1366×768 laptop) öğe 27 px'e iner; yine sığmazsa `.sidebar-kutu` `max-height:calc(100vh - 24px)` ile kendi içinde kayar (sayfa değil), alt satırdaki senkron durumu ve **🔒 Çıkış** tek satırdadır. Daha sık (26 px) varyant tüm ekranlarda denendi: gruplar birbirine yapıştığı için yalnız kısa ekranda kullanılır. Telefondaki alt çubuk etkilenmez.
- Tüm sekmeler 390 px telefon genişliğinde yatay taşma olmadan test edilir.
- ETF dışı kartların alt satırları (`kartEkSatirlari`): **Dün** — önceki kapanış ve düne göre fark (Dolar/Euro/Brent: Yahoo; altın: Twelve Data `previous_close`), **Aralık** — günün en düşük–en yüksek değeri; kriptoda **24s önce** ve **24s aralık** (Binance ticker `openPrice`, `lowPrice`, `highPrice`); uranyumda **Önceki** (yüzdeden geri hesaplanır). ETF'de hiç seans satırı yoksa **Önceki** kapanış gösterilir. 1000 üstü değerlerde alt satırlarda küsurat gösterilmez.
- Finansal Durumum › Varlık Dağılımı (`.pasta-kart`): açıklama satırı `.pl-oge` (renk noktası · ad (taşarsa …) · sağa hizalı yüzde). Telefonda (≤640 px) kart tam genişlik, halka 84 px solda, açıklama tek sütun — ortada ve sağda halka denendi: ortası kartı ~55 px uzatıp üst kartlarla hizayı bozdu, sağı okuma sırasını ters çevirdi; iki sütun 360 px'te adları kesti.
- **Ortak tasarım dili** (Finansal Durumum, Yatırımlarım, Borçlarım, Harcama Takibim, Portföy İstatistikleri — Piyasa Özeti kartlarıyla aynı). Her sayfa üstte özet kartları, altında başlığında toplamı/puanı olan bölümler ve sonda tek Not ile kurulur; tablolar `.ist-tablo`, dağılım çubukları `istHbar`, başlıktaki seçiciler `.bolum-secim`:
  - Özet kartı `.ozet-kart` (renkli sol kenar: yeşil varlık, kırmızı borç, sarı oran; `.ozet-etiket`, `.ozet-deger`, `.ozet-alt`, çizgili detay satırları `.card-seanslar`), ızgara `.ozet-grid`.
  - Bölüm `.bolum`: başlık + bölüm toplamı + **+ Ekle** (`bolumFormAc`) ile açılan `.bolum-form`.
  - Liste satırı `satirHtml()`: LED, ad (`dil` ile büyük harf kuralı: ETF/kripto adları `en` → BITCOIN; Türkçe adlar sayfa dili `tr` → ALTIN, GÜMÜŞ), alt bilgi, tutar, ✎ (satır içi düzenleme) ve ✕ sil / ✓ kapattım. Düzenleme durumu `_duzen` ile saklanır; dakikalık yeniden çizimde açık kutu ve yazılan değer korunur.
  - Açıklamalar her sayfanın altında tek bir **Not** satırındadır.
- **Portföy İstatistikleri listeleri** (Portföy yaşı, Çeşitlendirme, Borç karşılama, Döviz koruması) aynı satır düzenini ve sütun ızgarasını kullanır (`.yas-satir`, `istListe`); sarı dikey çizgi her bölümde bir referanstır (ortalama yaş, eşit dağılım payı, toplam borç).
- **Portföy yaşı** bölümü ince bir listedir (grafik + tablo birleşik): kod + tam ad + kategori (geniş sütun; telefonda ad kodun altında) · daha kısa yaş çubuğu (kategori rengi; sarı dikey çizgi = ortalama) · yaş · pay, yaşa göre sıralı. Yaşa tıklanınca satır içinde düzenlenir (`istYasDuzenle`; Enter kaydeder, Esc vazgeçer, odaktan çıkınca kaydeder). Yeniden çizimde açık kutu ve değer korunur; çizim sırasında kaldırılan kutunun `blur`'u kaydetme sayılmaz (`_yasCiziliyor`).
- **Yatırım performansı** (Yatırımlarım › Toplam Yatırım kartı): Günlük / Haftalık / Aylık ▲▼ yüzde ve ₺ farkı. Bugünkü adetler 1, 7 ve 30 gün önceki kapanış fiyatları ve o günkü USD/TRY ile değerlenir (`yatirimPerformans`); yalnızca piyasa hareketini gösterir, BİST sabit. Seriler: Yahoo günlük (ETF, GC=F, SI=F, USDTRY=X) ve Binance günlük (kripto), 30 dk bellekte önbellek (`perfSerileriGetir`). Referans **takvim gününe** göre seçilir (`seriDeger`): Yahoo çubukları açılış saatiyle işaretli olduğundan saate göre kesmek "dün"ü bir önceki işlem gününe kaydırıyordu. Telefonda ₺ farkı kısa biçimde ("+₺12 bin").
- Finansal Durumum › Varlık Dağılımı: SVG halka grafik (`halkaGrafikSvg`) — dilimler arası 2 px eşit aralık (kart zemini), açı = taban + (360 − n × taban) × pay (taban ≤ 12°): küçük paylar görünür (%0,5 ≈ 13°), dönüşüm doğrusal ve artan olduğu için büyük pay her zaman daha büyük çizilir (sıra bozulmaz); gerçek yüzdeler açıklamada ve dilim ipucunda. Ortası boş.
- Çeşitlendirme / Borç karşılama / Döviz koruması çubukları: açıklama sütunu 250 px (Çeşitlendirme'de kod + tam ad), değer sütunu sabit 150 px (çubuklar aynı yerde biter), çubuk ≈%18 kısa; telefonda üst satır açıklama + değer, altında tam genişlik çubuk.
- **Çerçeve rengi:** Yatırımlarım'daki tür çerçeveleri `.bolum.cerceve-varlik` (yeşil), Borçlarım'daki çerçeveler `.bolum.cerceve-borc` (kırmızı): 4 px renkli sol çizgi ve soldan hafif renk yansıması; diğer kenarlar normal. Tutarlar türün kendi rengini korur. Yatırımlar tek "Portföyüm" çerçevesi yerine çerçevesiz bir başlık (toplam + Ekle) altında türe göre ayrı çerçevelerdedir; türün + düğmesi formu o tür seçili açar (`yatirimEkleAc`).
- **Öne çıkan kart** `.ozet-kart.vurgu`: sayfanın tek ana göstergesi için (ör. Portföy İstatistikleri'nde genel puan) — 2 sütun, 34 px değer, derece rozeti `.puan-rozet`, kalın çubuk, puan renginde hafif zemin; telefonda tam genişlik. Sayfa başına en fazla bir tane. `.orta` varyantı 26 px değer kullanır (Borçlarım › Toplam Borç; nabız efektiyle). Yatırımlarım › Toplam Yatırım yeşil 23 px ve nabızlı; kartında `.ton` varyantı var (öne çıkan kartın renkli çerçevesi ve zemin yansıması, genişlik değişmeden; sol kenar tam renk). `.ton` ayrıca: Finansal Durumum › Net Varlık (çerçeve ve rakam yeşil; eksi ise kırmızı), Yatırımlarım › Yatırım / Borç Oranı (%50 altı kırmızı, %50–99 sarı, %100+ yeşil — kenar, çerçeve ve zemin birlikte).
- **Kart seçimi** (`kartGorunumUygula`, `kartDuzenAc`): `CARDS` hazır katalogdur; kullanıcının eklediği semboller açılışta `CARDS`'a eklenir (`kartOzelCfg`: ABD hisse/ETF → Finnhub, kripto → Binance `<SEMBOL>USDT`, küçük fiyatlar için `fmt:'oto'`). Bütün kart öğeleri DOM'da durur; seçime göre sıralanır ve gizlenir. **Kartları düzenle** düğmesi (`#kartDuzenBtn`) üst çubukta saatle birlikte `.app-bar-orta` grubundadır; yalnız Piyasa Özeti'nde görünür, diğer sayfalarda `visibility:hidden` ile yeri korunur (saat sekme değişince kaymasın), telefonda `display:none`. Geniş ekranda (≥1200 px) üst çubuk ızgarası `1.12fr auto 1fr`: başlık bloğu durum bloğundan geniş olduğu için grup bu oranla iki taraf arasındaki boşluğun ortasına gelir (1440'ta 112/119 px). Dar ekranda uzun durum metni `…` ile kısalır, gruba binmez. Ekleme sırasında sembol bir kez çekilerek doğrulanır. Fiyat turunda yalnızca `kartGerekliSet()` çekilir: görünen kartlar + Dolar/Euro + altın (TL ve gram altın hesapları) + yatırımlarda kullanılanlar. Binance toplu isteği geçersiz bir sembolle bozulursa hazır kriptolar toplu, kullanıcınınkiler tek tek denenir. Yatırımda kullanılan özel kart silinemez (yalnız gizlenir).
- Piyasa Özeti kartları kompakttır: yüzde değişim ve seans notu aynı satırda, ETF seans satırları ince bir çizgiyle ayrılır. Hedef: 1440×900 ekranda kartlar ve grafik kaydırmadan görünsün.

## 10. Deploy

- **Ön yüz:** `main` dalına push → GitHub Pages.
- **Worker:** `npx.cmd wrangler deploy` ([wrangler.toml](wrangler.toml)). `keep_vars = true` panelden eklenen değişkenleri korur, `preview_urls = false` sürüme özel önizleme adreslerini kapatır; secret'lar deploy'dan etkilenmez.

## 11. Sürüm geçmişi

| Tarih | Değişiklik |
|---|---|
| 2026-09-29 | Worker repoya eklendi; `/td-series` parametreleri URL'ye kodlanıyor; `wrangler.toml` ile CLI deploy; API anahtarları secret'a taşındı; README/PROJECT/RULES ve .gitignore eklendi |
| 2026-10-01 | Fiyat (dakikada bir) ve haber (10 dakikada bir) turları yalnız sekme görünürken çalışır; sekmeye dönünce eskimişse hemen tazelenir (`arkaPlanTuru`). Ölçüm: açık sekme dakikada ~10–16 Worker isteği; 100 kullanıcıda arka plan sekmeleri Workers ücretsiz planının günlük 100 bin isteğini aşardı |
| 2026-10-02 | Aylık Rapor yorumu yeniden yazıldı: ayrı "uzmanlık paketi" `RAPOR_SISTEM` (Türkiye koşullarında kişisel finans danışmanı: tasarruf oranı, borç servis oranı, KKDF/BSMV dahil etkin faiz ve çığ önceliği, acil fon 3–6 ay, TÜFE ile reel değişim, net varlığın $/altın bazında yorumu, yatırım yoğunlaşması; öncelik sırası; rakam uydurmama, eksik veriyi söyleme; çıktı: özet, sağlık tablosu, öne çıkanlar, gelecek ay planı, dikkat). Veri dosyası `raporMetni` genişledi: veri durumu/eksikler, gelir-nakit akışı ve son 3 ay tasarruf oranı, reel harcama, kategori payları, net varlık ay sonu değişimi (₺/$/gr), yatırım dağılımı, borçlar ve aylık faiz maliyeti, borç planı, acil fon/hedefler, gelecek ay (taksit + takvim ödemeleri + tahmini harcama), TÜFE. `max_tokens` 1200 → 3000; Haiku seçiliyse rapor için Sonnet. Sayfadaki kurallı öne çıkanlara reel değişim, borç servis oranı, faiz maliyeti, acil fon ve ay sonu net varlık (₺/$) eklendi (`raporSaglik`) |
| 2026-10-02 | Piyasa Özeti grafiği açılışta **1 Yıl** aralığıyla gelir (`currentPeriod = 'yil'`) |
| 2026-10-02 | Bay Piyasa karakteri: "BP" yazılı sarı daire yerine Benjamin Graham'ın "Mr. Market"inden esinli karakter (`BP_AVATAR_SVG`: silindir şapka, yuvarlak gözlük, bıyık, papyon; şapka bandı ve papyon yükseliş yeşili), sarı daire zemin korunur; daire sohbette 30 → 40 px, karşılama ekranında 48 → 88 px; kırpma 3 varyantla denendi (`viewBox 6 4 52 52`: yüz büyür, papyon görünür) |
| 2026-10-02 | Başlık toplamları beyaz ve 17 px (kullanıcı tercihi; satır tutarları 15 px): Varlıklarım, Yatırımlarım › Portföyüm ve tür çerçeveleri, Borçlarım; satır tutarları türün renginde kalır |
| 2026-10-02 | Çerçeveli listelerin (Varlıklarım, Yatırımlarım türleri, Borçlarım) başlığı ayraçla listeden ayrıldı ve toplamın önüne "TOPLAM" etiketi geldi: başlık toplamı ilk satırın tutarıyla karışıyordu. 3 varyant denendi (yalnız ayraç: yetersiz; nötr renk: Borçlarım'daki renk eşleşmesini bozuyordu). Telefonda uzun başlıklar iki satıra kayar (KMH, Elden Nakit Borçlar kesiliyordu) |
| 2026-10-02 | Aylık Rapor: "Bay Piyasa'nın yorumu" artık KPI kutularının hemen altında, "Öne çıkanlar" ondan sonra; yorum başlığında 44 px Bay Piyasa karakteri ve "Kişisel finans danışmanın · <Ay Yıl> değerlendirmesi" alt satırı, başlık altı ayraç (4 yerleşim denendi; telefonda düğme alt satıra iner, başlık kesilmez). Veri dosyasında acil durum fonu tek satır: TL + dolar bazlı tutar ($), kaç aylık zorunlu gider ve gider dökümü (harcama + taksit); hedef özetindeki tekrar kaldırıldı |
| 2026-10-02 | Aylık Rapor yorumu yarıda kesiliyordu: model yazmadan önce düşünüyor ve düşünme de `max_tokens`'tan harcıyor; 3000'de görünen metin birkaç cümlede bitiyordu. Rapor bütçesi 12000, Worker `/ai` üst sınırı 4000 → 16000 (ücret yalnız üretilen token kadar). `stop_reason: max_tokens` gelirse en fazla 2 kez "kaldığın yerden devam et" istenir, parçalar birleştirilir; yine kesikse metnin sonuna not düşülür. Veri dosyasında her acil fon hedefi ayrı satır: hedef (kendi biriminde ve ₺), biriken, kaynak, yüzde, tamamlanınca kaç aylık gider; birikim 0 ise modele "fonun yok deme, birikimi girmesini öner" uyarısı |
| 2026-10-02 | Aylık Rapor › Öne çıkanlar işaretleri: iyi = yeşil ▲, kötü = kırmızı ▼ (eskiden nokta), durağan = koyu sarı – (`#C9A227`) ve aynı renkte sol şerit |
| 2026-10-02 | Aylık Rapor: "Öne çıkanlar" → **"Öne Çıkan Gelişmeler"**; bütün maddeler devrik/eksik cümle yerine tam cümle (ör. "Harcaman, son 6 ayın ortalaması olan ₺84.000 tutarının %12 üstüne çıkarak ₺93.000 oldu."): önceki aya ve ortalamaya göre (±%1 içinde "neredeyse aynı"), kategori artış/azalışı önceki ve yeni tutarla, ortalamanın katı, bütçe (kullanılmayan kısım / aşım), bütçeyi aşan kategoriler bütçeye karşı tutarla, gelir-çıkış-kalan, taksitin anapara ve faiz kısmı, reel değişim, borç servis oranı, faiz maliyeti, acil fon (birikimi 0 ise "girilmemiş"), net varlığın yeni değeri |
| 2026-10-02 | Aylık Rapor › Bay Piyasa'nın yorumu: başlığın sağında küçük ▾ okuyla aç/kapa (`raporYorumKatla`); varsayılan açık, kapalılık yalnız bu cihazda `ft_rapor_yorum_kapali` ile hatırlanır (eşitlenmez); yeni yorum istenince kendiliğinden açılır; telefonda kapalıyken "Yeniden yorumla" düğmesi de gizlenir |
| 2026-10-02 | Yorum aç/kapa oku "Yeniden yorumla"nın soluna alındı ve belirginleştirildi: 36 px amber düğme, SVG ok; 1,4 sn'de dolu amber ↔ boş çerçeve yanıp söner, etrafa halka yayılır, ok kendi yönünde hafifçe zıplar (kapalıyken sağa döner); üstüne gelince durur, "hareketi azalt" tercihinde sabit. İlk deneme (ince parıltı) yan düğmeden ayırt edilmiyordu |
| 2026-10-02 | Aç/kapa oku başlığın hemen sağına taşındı ("Bay Piyasa'nın yorumu ⌄", 26 px); düğme yanındayken "Yeniden yorumla"ya aitmiş gibi algılanıyordu. İki yer denendi: başlık yanı (seçildi) ve karakterin solu (telefonda alt satırı sıkıştırıyor, ayrı bir düğme gibi duruyordu). Başlık metni de tıklanınca açar/kapar |
| 2026-10-01 | Finansal Durumum › Varlıklarım standarda alındı: Yatırımlarım'daki tür çerçeveleri gibi `cerceve-varlik` (yeşil sol çizgi) ve başlıkta "N kalem · servetin %X" açıklaması (başlıktaki toplam artık etiketsiz bir satır gibi okunmuyor); çerçeve başlığındaki açıklama telefonda başlığın altına iner (`.bolum-bas.aciklamali`, Yatırımlarım tür başlıkları da); form ipucundaki kişisel örnek genel örnekle değiştirildi |
| 2026-10-01 | Yardım grubuna **Destek ve İletişim** sayfası (`DESTEK_EPOSTA`): mailto şablonu (konu, hesap e-postası, cihaz/tarayıcı, ekran, panel adresi; finansal veri eklenmez), adresi kopyala, SSS/Kılavuz/Bay Piyasa kısayolları; SSS ve Kılavuz sonunda yönlendirme, SSS'ye "kime yazarım?" sorusu. Menünün 1440×900'e sığması için satır dolgusu 7 → 6,5 px (yönetici görünümü 871 px) |
| 2026-10-01 | Portföy İstatistikleri: Çeşitlendirme, Borç karşılama ve Döviz koruması listeleri Portföy yaşı düzenine geçti (ortak `istListe`: üstte sarı çizgili özet satırı + sütun adı, satırda nokta · kalın ad · açıklama · kategori | çubuk + sarı referans çizgisi | kalın değer | ikinci değer); dört bölüm aynı sütun ızgarasında (çubuk ve değerler hizalı); referanslar: eşit dağılım payı, toplam borç; borç ölçeği yatırım/borca göre (konut ölçeği ezmiyor); telefonda değer ve ikinci değer sağda alt alta, özet satırı kaydırmalı |
| 2026-10-01 | Net Varlık Geçmişi › Aylık özet her ayın **son günü**: panel ayın son günü açık değilse yeni ayda ilk açılışta tamamlanır (`ayTamamlaGecmis`, oturumda bir kez): yatırımlar o günün gerçek kapanışlarıyla (Yahoo: ETF/hisse/BİST/GC=F/USDTRY=X, Binance: kripto; hafta sonu/tatilde en fazla 7 gün geriye son işlem günü), varlık ve borç o tarihe kadarki son gerçek kayıttan; o tarihte panelde olmayan yatırımlar sayılmaz; kayıtta `tamam` alanı. Tabloda "ay sonu", "ay sonu · tamamlandı ⓘ", "devam ediyor", "… gün (ay sonu değil)" etiketleri. Gerçek fiyatlarla test: elle hesapla %0,00 fark |
| 2026-10-01 | Grafikte gezinme çizgisi: fare/dokunma ile dikey kesikli çizgi + noktada işaret, ipucunda tarih (5 yılda "… haftası"), kartın biçiminde fiyat (₺, küçük kripto ondalıkları) ve grafiğin ilk günündeki fiyata göre değişim ("+%9,46 · 3 Eyl 2026 fiyatına göre"; ilk noktada "grafiğin başlangıç günü"); kutu sağ kenarda sola geçer; telefonda `touch-action:pan-y` (yatay sürükleme çizgi, dikey kaydırma sayfa). Grafik artık yalnız genişlik değişince yeniden çizilir (telefonda adres çubuğu açılıp kapanınca çizgi kaybolmuyordu) |
| 2026-10-01 | Grafik aralıkları **1 Ay · 1 Yıl · 5 Yıl** (`GRAFIK_ARALIK`: Yahoo 1mo/1d, 1y/1d, 5y/1wk; Binance 1d×30, 1d×365, 1w×261; Twelve Data 1day×30, 1day×260, 1week×260; CoinGecko yedeği en fazla 365 gün, 5 yılda haftalık örneklenir; FRED; MetalCharts yalnız 1M/1Y). Başlıkta dönem değişimi; veri aralıktan kısaysa "veri … tarihinden beri"; 1 yıldan uzun aralıkta eksen ay + yıl. Denetim: 50 kart × 3 aralık = 150 grafik gerçek veriyle sorunsuz (yeni varlıklarda tarih notu) |
| 2026-10-01 | Bay Piyasa diğer kullanıcılar için açıldı: Profilim › Bay Piyasa (yapay zekâ) bölümünde kendi Anthropic API anahtarı (doğrulama, AES-GCM şifreleme, ipucu, değiştir/kaldır, nasıl alınır yardımı); Bay Piyasa sayfasında "Anahtarını ekle" düğmesi; anahtarı olan kullanıcıda haber çevirisi, PDF okuma ve Aylık Rapor yorumu da çalışır; yeni secret `AI_ANAHTAR_SIFRE`; kılavuz ve SSS (2 soru) güncellendi |
| 2026-10-01 | Tüm enstrüman denetimi (gerçek Yahoo/Binance/CoinGecko verisiyle): BİST 130/130, ABD 25/25 (hazır + popüler), kripto 30/30 fiyat ve geçmiş; panelde 50 kartın fiyatı kaynakla %0,00 farkla, 100/100 grafik (günlük ≥15, haftalık ≥20 nokta), 8 yatırım kaleminin TL değeri elle hesapla %0,03 içinde. Bulunan ve düzeltilen: altın grafiği Twelve Data cevap vermezse boş kalıyordu → Yahoo GC=F yedeği; Binance'te geçmişi kısa coinlerde (HYPE: 8 gün) grafik → CoinGecko günlük geçmişi. Not: REXC 6 aylık fon (26 haftalık nokta, doğal); TON'da CoinGecko yedeği Binance'ten %4 farklı (yalnız yedek) |
| 2026-10-01 | BİST araması: doğrulanmış 130 hisselik `BIST_LISTE` (kod, kısa Türkçe ad, Yahoo resmi adı; her kod Yahoo'da fiyat ve adla doğrulandı, geçersiz 4 aday çıkarıldı) + Türkçe karakterden bağımsız arama (`asciiNormal`: tüpraş = tupras); listede az sonuç varsa Yahoo araması (borsa `IST`); kod biliniyorsa doğrudan deneme. Yatırımlarım › BİST'te arama kutusu (kayıtta `isim` alanı; `ad` = kod portföy istatistikleri için aynen kalır; eski kayıtların adı listeden gösterilir); Kartları düzenle'de BİST kartı (Yahoo `KOD.IS`, `fmt:'try2'` ₺, grup BİST) |
| 2026-10-01 | Hisse araması Yahoo arama servisine geçti (ana kaynak; `abdHisseAra`, Worker proxy, ABD borsaları NMS/NGM/NCM/NYQ/ASE/PCX/BTS, EQUITY/ETF): şirket adı, ilk harfler ve yazım hatasıyla bulur ("tes" → TSLA, "nvidya" → NVDA, "coca" → KO); bulamazsa Finnhub `/fh-ara`. Boş arama artık önbelleğe alınmaz (önceki sürümde ilk başarısız arama oturum boyunca boş kalıyordu). Kutuya tıklayınca popüler 18 hisse; adlar sadeleşir (`yahooAdDuzelt`: "Tesla, Inc." → "Tesla"); kripto adlarıyla da aranır ("ripple" → XRP); noktalı semboller (BRK.B) Yahoo'da BRK-B'ye çevrilir, kart kimliği `oz-brk_b` |
| 2026-10-01 | Tüm ABD hisse/ETF'ler aranabilir (`/fh-ara`, ortak arama kutusu `sembolKutusuKur`: Kartları düzenle ve Yatırımlarım › ABD ETF & Hisse); şirket adları temizlenir (`adDuzelt`: "TAIWAN SEMICONDUCTOR-SP ADR" → "Taiwan Semiconductor"); yatırımda aranan hisse Piyasa Özeti'ne eklenmeden takip edilir; en büyük 30 kripto hazır kart (Binance çifti + CoinGecko kimliği doğrulandı), kayıtsız yöneticide eski 18 kart korunur (`ESKI_KARTLAR`); listede olmayan coin Binance'te denenir |
| 2026-10-01 | Ortak kota: Twelve Data anlık fiyat önbelleği 60 sn → 5 dk (altın fiyatı çok kullanıcıda da günlük 800 kredi sınırına takılmaz). Kullanıcıların piyasa verisi için API anahtarı gerekmez; anahtarlar sunucuda ortak |
| 2026-10-01 | Uranyum grafiği gerçek U3O8 $/lb geçmişi: MetalCharts API (Worker `/uranyum-gecmis`, D1 `onbellek` tablosu, 12 saat önbellek, hatada 1 saat bekleme); grafikte zorunlu "Metal prices by MetalCharts" bağlantısı; alınamazsa SRUUF eğilimi |
| 2026-10-01 | Grafik düzeltmesi: ABD hisse/ETF kartlarında (QQQM, VOO, URA, NLR, XLE, REXC, REMX, NVDA ve kullanıcının eklediği semboller) geçmiş Yahoo'dan, yedek Twelve Data; uranyumda UX=F geçmişi olmadığı için eğilim olarak SRUUF (başlıkta not); hızlı kart değişiminde eski cevabın yeni grafiğin üstüne çizilmesi engellendi (`_grafikIstek`) |
| 2026-10-01 | Kartları düzenle üst çubuğa, saatin yanına taşındı (yalnız Piyasa Özeti'nde; telefonda saatin sağında); saat + düğme boşluğun ortasında, sekme değişince saat kaymaz; dar ekranda durum metni kısalır; ızgaradaki kutu kaldırıldı |
| 2026-10-01 | Kenar menüsünde gruplar (Varlık ve borç, Harcama ve bütçe, İstatistikler, Planlama, Asistan, Yardım, Yönetim) profil çizgisiyle aynı ince çizgiyle ayrıldı; 6 varyant denendi; menü 1440×900'e sığmaya devam ediyor |
| 2026-10-01 | Kenar menüsü sıklaştırıldı: masaüstünde menünün tamamı ekrana sığar (1045 → 836 px), laptop ekranında bir kademe daha sık ve gerekirse menü kendi içinde kayar; senkron durumu ve Çıkış tek satırda |
| 2026-10-01 | Profilim: menünün en üstünde fotoğraf/baş harf, ad soyad ve e-posta; profil sayfası (fotoğraf yükle/kaldır, ad soyad, açılış sayfası, kart düzenleme kısayolu, şifre, açık oturum sayısı, diğer cihazlardan çıkış, çıkış); Worker'da `users.foto`/`users.ayar`, `/auth/profil`, `/auth/cikis-diger`, zengin `/auth/me`; Kullanıcılar listesinde avatar; ilk yönetici adı artık boş başlar; kılavuz ve SSS (3 yeni soru) güncellendi |
| 2026-10-01 | Piyasa Özeti'nde kullanıcı başına kart seçimi (`ft_kartlar_v1`, Worker izin listesine eklendi): göster/gizle, sırala, varsayılana dön, ABD hisse/ETF ve kripto sembolü ekleme (doğrulamalı; Yatırımlarım'da da seçilir); gizli ve kullanılmayan kartların fiyatı çekilmez; "QQM" etiketi QQQM olarak düzeltildi; kılavuz ve SSS güncellendi |
| 2026-10-01 | **Çok kullanıcılı yapı:** kullanıcı hesapları (PBKDF2 şifre, oturum anahtarı, 180 gün), her kullanıcının verisi ayrı (`ukv`); yönetici için Kullanıcılar sayfası (hesap aç, geçici şifre, girişi kapat, sil); ilk girişte zorunlu şifre değişimi; Şifremi değiştir; eski erişim kodunun otomatik oturuma yükseltilmesi ve verilerin yönetici hesabına taşınması; IP + e-posta kilidi; Twelve Data / Finnhub / proxy için 60 sn ortak önbellek; koddaki kişisel kredi verisi (`LOANS_TOHUM`) kaldırıldı; AI şimdilik yalnız yöneticide; kılavuza Hesabın ve Kullanıcılar bölümleri, SSS'ye 5 hesap sorusu; yerelde (wrangler dev, yedek veriyle) uçtan uca test edildi |
| 2026-10-01 | Yardım grubuna Sık Sorulan Sorular sekmesi (26 soru, konulara göre, aranabilir); kılavuzdaki sorular buraya taşındı, kılavuzda yönlendirme kutusu |
| 2026-10-01 | Kullanım Kılavuzu sayfası (Yardım grubu): ilk kurulum, sayfa sayfa anlatım ve örnekler, SSS, terimler, arama; Piyasa Özeti'nde Bitcoin etiketi BITCOIN |
| 2026-10-01 | Nakit / Mevduat varlığı $ / € / gram altın olarak tutulabilir (miktar girilir, TL karşılığı canlı kur ve altın fiyatıyla); acil fon hedefi ve göstergesi bunu kullanır |
| 2026-10-01 | Acil durum fonu: Varlıklarım'a Nakit / Mevduat türü; hedef kaynağı "Varlıklarımdan"; "acil durum fonu" hedefi 3/6 aylık gidere göre öneri ve "kaç aylık gideri karşılıyor" göstergesi (hedef satırı, Finansal Durumum) |
| 2026-10-01 | Harcama Takibim: aylık tablo salt okunur (yalnız kayıtlardan hesaplanır, hücre tıklanınca o ayın kayıtları açılır); eski aylık toplamlar listede görünür ve diğer kayıtlarla toplanır (tablodan yazılan toplamın kayıtları gizlemesi giderildi) |
| 2026-10-01 | Finansal Durumum: Varlık Dağılımı kartı telefonda tam genişlik, halka solda, açıklama tek sütun ve yüzdeler sağa hizalı (yazı taşması giderildi; 360 px'te de kesilmez) |
| 2026-10-01 | Harcama Takibim: aylık harcamalar grafiği ₺ TL / $ Dolar / gram Altın olarak seçilebilir (her ay kendi kuruyla); çubuk üstünde ipucu açılmama hatası giderildi |
| 2026-10-01 | Nakit Akışı tahminleri enflasyon ve satın alma gücüyle: TCMB beklentisi / resmi TÜFE / kişisel / elle enflasyon yolu, harcama bugünün fiyatına taşınıp enflasyonla büyütülür, maaş artışı varsayımı (Ocak / Ocak-Temmuz / yok), "bugünün parasıyla" görünümü |
| 2026-09-30 | Bütçe Planlaması: gelecek 12 ay seçilebilir; tutar "her ay" ya da "yalnız o ay" için kaydedilir (aya özel bütçe), ısı tablosunda gelecek aylar "plan" |
| 2026-09-30 | "Bütçe" sayfasının adı "Bütçe Planlaması" oldu |
| 2026-09-30 | Nakit Akışı her açılışta içinde bulunulan ayla açılır |
| 2026-09-30 | Birikim Hedefleri kartlarında dolar yeşil, altın sarı |
| 2026-09-30 | Birikim Hedefleri: "şu an biriken" için Elle / Yatırımlarımdan (otomatik) seçimi — birden fazla yatırım ya da tüm yatırımlar; mevcut hedefte ⇄ ile kaynak değiştirme |
| 2026-09-30 | Birikim Hedefleri: Hedefler, Biriken ve Ayda ayırman gereken kartlarına güncel dolar ve gram altın karşılığı (kur değişince anında güncellenir) |
| 2026-09-30 | Düzenli ödemeler ve abonelikler Harcama Takibim'e bu ay ve gelecek ay için otomatik eklenir (harcama kategorisi seçilebilir; silinen ay geri gelmez, elle değiştirilen korunur) |
| 2026-09-30 | Ödeme Takvimi: kartın sıradaki dönemi için dönem borcu, asgari ve ödeyeceğim tutarı; takvim ödeyeceğin tutarı kullanır; kalan borç ve asgari uyarıları, ödeme sonrası güncelleme hatırlatması |
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
