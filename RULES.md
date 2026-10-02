# Geliştirme Kuralları

Bu projede değişiklik yaparken uyulacak kurallar.

## Güvenlik

1. **Repoya hiçbir anahtar, parola veya erişim kodu yazılmaz.** Tüm anahtarlar Cloudflare'de **Secret** türünde saklanır (düz metin değişken olarak değil).
2. Oturum anahtarı yalnızca `MY_WORKER` adresine gönderilir; üçüncü taraf servislere asla.
3. Worker'daki `/` ve `/auth/login` dışındaki her yeni uç nokta kimlik kapısının (`oturumKullanici`) **arkasında** olmalıdır. Kullanıcı verisine dokunan her sorgu `user_id = ben.id` ile sınırlanır; istemciden gelen kullanıcı kimliğine asla güvenilmez. Yönetim uçları ayrıca `role = 'admin'` kontrol eder.
4. Proxy'ye yeni bir alan adı eklemek bilinçli bir karardır; `allowed` listesine yalnızca gerçekten gereken adresler girer.
5. Dış servislere giden URL'lerdeki kullanıcı kaynaklı parametreler `encodeURIComponent` ile kodlanır.
6. Üçüncü taraf yedek proxy'lerden (`allorigins`, `corsproxy`, `codetabs`) yalnızca herkese açık piyasa/haber verisi geçer; kullanıcı verisi, oturum anahtarı veya yapay zekâ istekleri asla bu proxy'lere gönderilmez.
7. Giriş hatalarında hangi bilginin (e-posta mı şifre mi) yanlış olduğu söylenmez; yanlış e-posta da kilit sayacına işlenir.
8. Kimlik doğrulama değişiklikleri önce yerelde `wrangler dev` (geçici `.dev.vars`, commit edilmez) ile test edilir; canlı sunucuya yanlış giriş denemesi gönderilmez (IP kilidi).
9. Bir anahtar herhangi bir yerde (log, ekran görüntüsü, sohbet) açığa çıkarsa hemen yenilenir ve eskisi iptal edilir.
10. Şifre ve oturum anahtarı düz metin saklanmaz: şifre PBKDF2 (tuzlu), oturum SHA-256 özeti. PBKDF2 tekrar sayısı Workers CPU sınırına göre seçilir (`SIFRE_ITER`); artırmadan önce istek süresi ölçülür.
11. Kodda hiçbir kullanıcının kişisel verisi (kredi, banka, tutar, ad, e-posta) bulunmaz (tek istisna: yöneticinin bilerek yayımladığı destek adresi `DESTEK_EPOSTA`); kılavuz örnekleri genel adlarla yazılır (“Ev”, “ihtiyaç kredisi”). Yeni kullanıcı boş hesapla başlar.
12. Bir cihazda başka bir hesapla giriş yapılırsa önceki hesabın yerel verisi silinir (`oturumKaydet`); veriler hesaplar arasında asla birleştirilmez.
13b. Kullanıcıdan gelen profil alanları sunucuda doğrulanır: ad kırpılır ve 80 karakterle sınırlanır, fotoğraf yalnız `data:image/(jpeg|png|webp);base64` ve 120 KB'a kadar, tercihler yalnız izinli anahtarlar. Fotoğraf sayfaya yalnız bu biçimde doğrulandıktan sonra `<img src>` olarak konur.
13. Yapay zekâ uçları sunucunun Anthropic anahtarını yalnızca yönetici için kullanır; diğer kullanıcılar kendi anahtarlarıyla çalışır. Kullanıcı anahtarı yalnız şifreli (AES-GCM, kullanıcı kimliğine bağlı) saklanır, hiçbir uçtan geri döndürülmez, loglanmaz; istemciye yalnız ipucu gider. Kullanıcı anahtarı Anthropic'te reddedilirse 401 dönülmez (oturum bitti sanılır).

## Kod

1. Ön yüz **tek dosya** olarak kalır ([piyasa-paneli.html](piyasa-paneli.html)); derleme adımı ve framework eklenmez.
2. Dış kütüphane yalnızca gerçekten gerekiyorsa ve güvenilir bir CDN'den (cdnjs) eklenir.
3. Kod mevcut stile uyar: **Türkçe** değişken/fonksiyon adları ve yorumlar, bölümler `// ---------- Başlık ----------` ile ayrılır.
4. Hata mesajları kullanıcıya Türkçe ve anlaşılır gösterilir.
5. Her ekran telefon genişliğinde (390 px) yatay taşma olmadan çalışmalıdır; sabit genişlikli satırlar için `@media (max-width:640px)` kuralı yazılır.
6. Yeni ekranlar ortak tasarım dilini kullanır: üstte özet için `.ozet-kart` (kenar rengi anlam taşır: yeşil iyi/varlık, sarı orta/süren, kırmızı zayıf/borç/gider), bölüm için `.bolum` + `bolumFormAc` (başlığın sağında toplam ya da puan), liste için `satirHtml()`, tablo için `.ist-tablo`, dağılım için `istHbar`, başlıkta seçim için `.bolum-secim`. Sayfanın en üstüne ayrı filtre satırı konmaz. Açıklama metinleri sayfa sonundaki tek **Not** satırına yazılır.
7. Varlık/yatırım listeleri `.bolum.cerceve-varlik` (yeşil sol çizgi), borç listeleri `.bolum.cerceve-borc` (kırmızı sol çizgi) ile çerçevelenir; çerçevenin tamamı renklendirilmez. Çerçeve başlığında toplamın yanında ne olduğunu anlatan soluk açıklama bulunur ("N kalem · %…"; `.bolum-bas.aciklamali` + `.baslik-aciklama`, telefonda başlığın altına iner); toplam etiketsiz bırakılmaz: çerçeve başlığı ince bir ayraçla listeden ayrılır ve tutarın önünde küçük "TOPLAM" etiketi durur (başlık toplamı beyazdır — Varlıklarım, Portföyüm ve yatırım türleri, borçlar; renk satırlarda kalır); telefonda uzun başlık kesilmez, iki satıra kayar.
7a'. Kullanıcıya gösterilen hazır listeler (BİST, kripto) uydurulmaz: her kod canlı kaynakta (Yahoo/Binance) doğrulanır ve doğrulama tarihi kodda yazılır. Türkçe arama `asciiNormal` ile karakterden bağımsızdır.
7a. Hisse/kripto seçimi sabit listeyle sınırlanmaz ve kullanıcıdan kod bilmesi beklenmez: ABD hisse/ETF'ler şirket adıyla aranır (Yahoo arama, yedek Finnhub `/fh-ara`); boş ya da başarısız arama sonucu önbelleğe alınmaz; yeni sembol eklenmeden önce fiyatı bir kez çekilerek doğrulanır (`ozelKartHazirla`). Finnhub'ın borsa adları kullanıcıya ham gösterilmez (`adDuzelt`).
7b. Piyasa Özeti'ne yeni hazır kart `CARDS`'a eklenir; kimsenin görünümünü kendiliğinden değiştirmez (kayıtlı seçimi olan kullanıcıda "Hazır kartlardan ekle"de çıkar). Varsayılan set (`VARSAYILAN_KARTLAR`) kısa tutulur; fiyat isteği yalnız gereken kartlar için yapılır (`kartGerekliSet`).
7c. Kenar menüsüne öğe eklerken 1440×900'de menünün tamamının kaydırmadan görünmesi korunur (öğe yüksekliği ve grup aralıkları büyütülmez); kısa ekran için ayrı kural (`max-height:880px`) ve menü içi kaydırma vardır.
8. Yeni sayfa menüye kendi grubunun altına eklenir; telefondaki alt çubukta yalnızca `data-alt` işaretli 6 sayfa durur, diğerleri kendiliğinden **Diğer** menüsüne düşer (alt çubuğa yeni sayfa eklenmez).
9. Native `confirm`/`alert` yerine panelin kendi pencereleri kullanılır: `showConfirmModal` (onay) ve `showAlertModal` (uyarı).

## Veri

1. Yeni bir senkron anahtarı eklenirse **hem** ön yüzdeki `SENKRON_ANAHTARLARI` **hem** Worker'daki `IZINLI_ANAHTARLAR` güncellenir.
2. Veri anahtarları `ft_<ad>_v<sürüm>` biçimindedir (istisna: yalnızca yerelde tutulan `ft_erisim`, `ft_kullanici` ve `ft_senkron_meta`). Veri yapısı geriye uyumsuz değişirse sürüm artırılır (`_v2`) ve eski veriden taşıma yazılır.
3. Tek kayıt 1,5 MB'ı geçemez (D1 sınırı).
3b. Nakit Akışı'nın enflasyon verisi (`ENFLASYON_VERI`: TÜİK aylık TÜFE ve TCMB Piyasa Katılımcıları Anketi) her yeni açıklamada kaynağıyla birlikte güncellenir; değerler uydurulmaz, derleme ayı ve kaynak yorumda yazılır.
4. Kullanıcı verisi (kredi, borç, portföy) koddan sabit değer olarak üretilmez veya uydurulmaz.
5. Senkronlanan listelere türetilmiş veya önbellek bilgisi (son fiyat, hesaplanan tutar vb.) yazılmaz; bunlar yalnızca yerel anahtarlarda tutulur. Senkron listeleri yalnızca kullanıcı bir şeyi eklediğinde, değiştirdiğinde veya sildiğinde yazılır. (Dövizli/altın varlıktaki `deger` alanı da yalnız bu anlarda, o anki fiyatla yazılan bir yedektir; görünen değer her zaman canlı hesaplanır.) **İstisnalar** (sonradan yeniden hesaplanamayan kayıtlar): kart kayıtlarındaki dönem tutarları `ft_odemeler_v1 › donem` (sıradaki son ödemeye kadar kart borcuyla güncellenir, tarih geçince donar; son 24 dönem) ve `ft_net_gecmis_v1`: günlük net varlık kaydı sonradan yeniden hesaplanamayan bir geçmiştir; günde bir kayıt, gün içinde en fazla yarım saatte bir ve yalnızca anlamlı değişimde güncellenir, senkron bitmeden ve yatırım değeri hesaplanmadan yazılmaz. Geçmiş geriye dönük tahmin edilip doldurulmaz; tek istisna **ay sonu tamamlama** (`ayTamamlaGecmis`): ilk kayıttan sonraki bir ayın son günü kayıt yoksa, yatırımlar o günün gerçek kapanış fiyatları ve kuruyla, varlık/borç son gerçek kayıttan hesaplanıp `tamam: <taban kayıt günü>` işaretiyle eklenir; gerçek kayıt değiştirilmez, fiyatı bulunamayan ay atlanır.

## Haberler

1. Yalnızca köklü, kurumsal haber kaynakları kullanılır (Reuters, Bloomberg, Bloomberg HT, BBC, Anadolu Ajansı, Investing.com, CNBC, MarketWatch vb.). Yeni kaynak eklemek bilinçli bir karardır ve Worker proxy izin listesine de eklenmelidir.
2. Basın bültenleri, sponsorlu içerik ve fiyat/fon tanıtım sayfaları haber olarak gösterilmez.
3. Türkçe okunabilir haber (Türkçe kaynak ya da Google Çeviri ile açılabilen İngilizce kaynak) önceliklidir; çevrilemeyen kaynaklar "İngilizce" diye işaretlenir.

## Yapay zekâ

1. Kullanılan model adları Worker'daki `ALLOWED_MODELS` ile ön yüzdeki model listesinde aynı olmalıdır.
2. Maliyet yaratan özellikler (web araması, yüksek `max_tokens`) varsayılan olarak **kapalı** veya sınırlıdır.
3. Yapay zekâ çağıran her yeni özellik Bay Piyasa'daki **günlük harcama limitine** (`bp.ayar.limit`) uyar; limit dolduysa istek gönderilmez (haber çevirisindeki `bpBugunHarcama()` kontrolü gibi).
4c. Periyodik istekler (fiyat, haber, senkron) yalnız sekme görünürken çalışır (`document.visibilityState`); yeni bir periyodik iş eklerken de bu kural uygulanır.
4b. Kotalı dış servisler (ör. MetalCharts: ayda 200 istek) Worker'da D1 `onbellek` tablosuyla önbelleklenir ve hata durumu da önbelleklenir; istemci isteği sayısı kotayı belirlemez. Ücretsiz katmanın atıf şartı (görünür kaynak bağlantısı) kaldırılmaz.
4. Ucuz işler (çeviri, kısa özet) için Haiku, belge okuma gibi doğruluk isteyen işler için Sonnet kullanılır; daha pahalı modeller yalnızca kullanıcı seçerse devreye girer.

## Git ve deploy

1. Commit mesajları Türkçe, kısa bir başlık ve gerekirse açıklama içerir.
2. Push'tan önce `git pull --rebase` yapılır: GitHub web arayüzünden de dosya yüklendiği için uzak dal önde olabilir.
3. Worker değişikliği commit edildikten sonra `npx.cmd wrangler deploy` ile yayınlanır; önce `--dry-run` ile kontrol edilebilir. Windows PowerShell'de `npx` yerine `npx.cmd` kullanılır.
4. [wrangler.toml](wrangler.toml)'daki `keep_vars = true` ve D1 bağlantısı (`DB`) kaldırılmaz; kaldırılırsa deploy panelden eklenen ayarları siler.
5. `.wrangler/` klasörü (yerel önbellek) commit edilmez.
6. Deploy sonrası temel kontrol: panele giriş, fiyatların gelmesi, Bay Piyasa'nın cevap vermesi.
7. Kimlik/veri yapısı değişikliklerinde sıra: üretim D1'in tam yedeği (`wrangler d1 export … --remote`) → yerelde yedekle test → **önce Worker** (geriye uyumlu) → sonra ön yüz. Eski `kv` tablosu silinmez.

## Dokümantasyon

- **Her değişiklikte** panel içindeki **Kullanım Kılavuzu** (`#tab-kilavuz`) ve **Sık Sorulan Sorular** (`#tab-sss`) son duruma göre kontrol edilir ve aynı committe güncellenir: ilgili sayfa bölümü, adımlar, örnek rakamlar, menü adları/sırası, SSS ve Terimler. Kılavuz kullanıcıya yanlış adım tarif etmemelidir; bir soru iki yerde tekrarlanmaz (SSS'de olur, kılavuz yönlendirir).

Her değişiklik veya eklentide ilgili dokümanlar **aynı commit'te** güncellenir:

- [README.md](README.md): özellik veya kurulum değiştiyse
- [PROJECT.md](PROJECT.md): mimari, uç nokta, veri anahtarı, kaynak veya model değiştiyse; ayrıca **Sürüm geçmişi** tablosuna bir satır eklenir
- [RULES.md](RULES.md): yeni bir kural veya karar ortaya çıktıysa
