# Geliştirme Kuralları

Bu projede değişiklik yaparken uyulacak kurallar.

## Güvenlik

1. **Repoya hiçbir anahtar, parola veya erişim kodu yazılmaz.** Tüm anahtarlar Cloudflare'de **Secret** türünde saklanır (düz metin değişken olarak değil).
2. Erişim kodu yalnızca `MY_WORKER` adresine gönderilir; üçüncü taraf servislere asla.
3. Worker'daki `/` dışındaki her yeni uç nokta kimlik kapısının (`yetkiKontrol`) **arkasında** olmalıdır.
4. Proxy'ye yeni bir alan adı eklemek bilinçli bir karardır; `allowed` listesine yalnızca gerçekten gereken adresler girer.
5. Dış servislere giden URL'lerdeki kullanıcı kaynaklı parametreler `encodeURIComponent` ile kodlanır.
6. Üçüncü taraf yedek proxy'lerden (`allorigins`, `corsproxy`, `codetabs`) yalnızca herkese açık piyasa/haber verisi geçer; kullanıcı verisi, erişim kodu veya yapay zekâ istekleri asla bu proxy'lere gönderilmez.
7. Bir anahtar herhangi bir yerde (log, ekran görüntüsü, sohbet) açığa çıkarsa hemen yenilenir ve eskisi iptal edilir.

## Kod

1. Ön yüz **tek dosya** olarak kalır ([piyasa-paneli.html](piyasa-paneli.html)); derleme adımı ve framework eklenmez.
2. Dış kütüphane yalnızca gerçekten gerekiyorsa ve güvenilir bir CDN'den (cdnjs) eklenir.
3. Kod mevcut stile uyar: **Türkçe** değişken/fonksiyon adları ve yorumlar, bölümler `// ---------- Başlık ----------` ile ayrılır.
4. Hata mesajları kullanıcıya Türkçe ve anlaşılır gösterilir.
5. Her ekran telefon genişliğinde (390 px) yatay taşma olmadan çalışmalıdır; sabit genişlikli satırlar için `@media (max-width:640px)` kuralı yazılır.
6. Native `confirm`/`alert` yerine panelin kendi pencereleri kullanılır: `showConfirmModal` (onay) ve `showAlertModal` (uyarı).

## Veri

1. Yeni bir senkron anahtarı eklenirse **hem** ön yüzdeki `SENKRON_ANAHTARLARI` **hem** Worker'daki `IZINLI_ANAHTARLAR` güncellenir.
2. Veri anahtarları `ft_<ad>_v<sürüm>` biçimindedir (istisna: yalnızca yerelde tutulan `ft_erisim` ve `ft_senkron_meta`). Veri yapısı geriye uyumsuz değişirse sürüm artırılır (`_v2`) ve eski veriden taşıma yazılır.
3. Tek kayıt 1,5 MB'ı geçemez (D1 sınırı).
4. Kullanıcı verisi (kredi, borç, portföy) koddan sabit değer olarak üretilmez veya uydurulmaz.
5. Senkronlanan listelere türetilmiş veya önbellek bilgisi (son fiyat, hesaplanan tutar vb.) yazılmaz; bunlar yalnızca yerel anahtarlarda tutulur. Senkron listeleri yalnızca kullanıcı bir şeyi eklediğinde, değiştirdiğinde veya sildiğinde yazılır.

## Yapay zekâ

1. Kullanılan model adları Worker'daki `ALLOWED_MODELS` ile ön yüzdeki model listesinde aynı olmalıdır.
2. Maliyet yaratan özellikler (web araması, yüksek `max_tokens`) varsayılan olarak **kapalı** veya sınırlıdır.
3. Yapay zekâ çağıran her yeni özellik Bay Piyasa'daki **günlük harcama limitine** (`bp.ayar.limit`) uyar; limit dolduysa istek gönderilmez (haber çevirisindeki `bpBugunHarcama()` kontrolü gibi).
4. Ucuz işler (çeviri, kısa özet) için Haiku, belge okuma gibi doğruluk isteyen işler için Sonnet kullanılır; daha pahalı modeller yalnızca kullanıcı seçerse devreye girer.

## Git ve deploy

1. Commit mesajları Türkçe, kısa bir başlık ve gerekirse açıklama içerir.
2. Push'tan önce `git pull --rebase` yapılır: GitHub web arayüzünden de dosya yüklendiği için uzak dal önde olabilir.
3. Worker değişikliği commit edildikten sonra `npx.cmd wrangler deploy` ile yayınlanır; önce `--dry-run` ile kontrol edilebilir. Windows PowerShell'de `npx` yerine `npx.cmd` kullanılır.
4. [wrangler.toml](wrangler.toml)'daki `keep_vars = true` ve D1 bağlantısı (`DB`) kaldırılmaz; kaldırılırsa deploy panelden eklenen ayarları siler.
5. `.wrangler/` klasörü (yerel önbellek) commit edilmez.
6. Deploy sonrası temel kontrol: panele giriş, fiyatların gelmesi, Bay Piyasa'nın cevap vermesi.

## Dokümantasyon

Her değişiklik veya eklentide ilgili dokümanlar **aynı commit'te** güncellenir:

- [README.md](README.md): özellik veya kurulum değiştiyse
- [PROJECT.md](PROJECT.md): mimari, uç nokta, veri anahtarı, kaynak veya model değiştiyse; ayrıca **Sürüm geçmişi** tablosuna bir satır eklenir
- [RULES.md](RULES.md): yeni bir kural veya karar ortaya çıktıysa
