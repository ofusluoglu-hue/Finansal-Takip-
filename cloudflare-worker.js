// =====================================================================
// Finansal Takip Paneli — Cloudflare Worker (çok kullanıcılı)
//
//   GÜVENLİK: Kök adres ve /auth/login dışındaki HER istek bir oturum ister (Authorization: Bearer <oturum>).
//   Hesapları yalnızca yönetici açar (kayıt ekranı yok). Şifreler PBKDF2-SHA256 + tuzla saklanır; oturum anahtarı
//   veritabanında yalnızca SHA-256 özeti olarak durur. 15 dakikada 8 hatalı giriş → o IP ve o e-posta 15 dk kilitlenir.
//   Her kullanıcının verisi ayrıdır (ukv tablosu, user_id ile).
//
//   Uç noktalar:
//     /auth/login (POST) · /auth/logout (POST) · /auth/me (GET) · /auth/sifre (POST, kendi şifresini değiştirir)
//     /auth/profil (POST: ad, fotoğraf, tercihler) · /auth/cikis-diger (POST: diğer cihazlardaki oturumları kapatır)
//     /auth/ai-anahtar (POST: kullanıcının Anthropic anahtarını doğrulayıp şifreli saklar · DELETE: siler)
//     /admin/kullanicilar (GET, POST) · /admin/kullanicilar/:id/sifre (POST) · /admin/kullanicilar/:id/durum (POST)
//     /admin/kullanicilar/:id (DELETE)                                   — yalnız yönetici
//     /data (GET), /data/:anahtar (PUT)    -> kullanıcının verileri (cihazlar arası senkron)
//     /proxy?url=...                       -> CORS proxy (Yahoo, FRED, Google News, haber RSS'leri; 60 sn önbellek)
//     /ai, /extract-loan                   -> Anthropic geçidi (yönetici: sunucunun anahtarı; diğer kullanıcılar: kendi kayıtlı anahtarı)
//     /td, /td-series, /fh                 -> Twelve Data / Finnhub geçitleri (ortak kota için 60 sn önbellek)
//     /fh-ara?q=                           -> ABD hisse/ETF sembol araması (Finnhub, 1 gün önbellek)
//     /uranyum                             -> uranyum fiyatı
//     /uranyum-gecmis?aralik=1M|1Y         -> uranyum U3O8 $/lb geçmişi (MetalCharts API, secret: metalcharts; D1'de 12 saat önbellek)
//     /auth/check                          -> ESKİ panel uyumluluğu (geçiş süresince)
//
// KURULUM (Cloudflare panelinde):
//   A) D1 veritabanı: finansal-takip  →  Worker > Settings > Bindings > D1 (Variable name: DB)
//   B) Secrets: ANTHROPIC_API_KEY, TWELVEDATA_API_KEY, FINNHUB_API_KEY, AI_ANAHTAR_SIFRE (32 bayt rastgele, base64: kullanıcıların
//      Anthropic anahtarlarını şifreler — değişirse kayıtlı anahtarlar çözülemez, kullanıcılar yeniden girer)
//      İlk yönetici hesabı: LOGIN_USER (e-posta) + ACCESS_TOKEN (şifre). Kullanıcı tablosu boşsa ilk istekte bu
//      bilgilerle yönetici açılır ve eski tek kullanıcılı veriler (kv tablosu) bu hesaba kopyalanır. Sonrasında
//      ACCESS_TOKEN yalnızca geçiş süresince eski panelin çalışması için kullanılır.
//      (İsteğe bağlı) ALLOWED_ORIGIN = izin verilen site adres(ler)i, virgülle; boşsa https://ofusluoglu-hue.github.io
//   (Anahtarları ve parolaları ASLA bu kodun içine yazma.)
// =====================================================================

const VARSAYILAN_ORIGIN = 'https://ofusluoglu-hue.github.io';

// Senkronize edilebilen anahtarlar (başka anahtarlar reddedilir)
const IZINLI_ANAHTARLAR = new Set([
  'ft_yatirimlar_v1', 'ft_varliklarim_v1', 'ft_custom_loans_v1', 'ft_closed_loans_v1',
  'ft_kredi_kartlari_v1', 'ft_kmh_v1', 'ft_elden_nakit_v1', 'ft_sabit_krediler_v1',
  'ft_bay_piyasa_v1', 'ft_haber_ceviri_v1', 'ft_harcamalar_v1',
  'ft_butce_v1', 'ft_gelirler_v1', 'ft_odemeler_v1', 'ft_borc_plan_v1', 'ft_hedefler_v1', 'ft_net_gecmis_v1', 'ft_raporlar_v1',
  'ft_kartlar_v1',
]);
const MAX_DEGER_BAYT = 1500000;      // D1 satır sınırı 2 MB
const KILIT_ESIK = 8;                // 15 dk içinde bu kadar yanlış deneme → kilit
const KILIT_PENCERE_MS = 15 * 60 * 1000;
const OTURUM_SURE_MS = 180 * 24 * 3600 * 1000;   // 180 gün; kullanıldıkça uzar
const SIFRE_ITER = 20000;            // PBKDF2 tekrar sayısı: ücretsiz plan istek başına ~10 ms CPU verir (60 bin ≈ 22 ms). Kullanıcı başına saklanır, ileride artırılabilir.
const SIFRE_MIN = 8;
const FOTO_MAX = 120000;             // profil fotoğrafı (panel 192×192 JPEG'e küçültür, ~15–30 KB)
const FOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const TERCIH_ALANLARI = ['acilis'];   // users.ayar içinde saklanabilen tercihler

// İstemciye giden hesap bilgisi (şifre özeti vb. asla)
function kullaniciCikti(u, ek) {
  let ayar = {};
  try { ayar = JSON.parse(u.ayar || '{}') || {}; } catch { ayar = {}; }
  return Object.assign({ id: u.id, email: u.email, ad: u.ad, rol: u.role, sifreDegismeli: !!u.must_change, foto: u.foto || null, ayar,
    olusturma: u.created_at || null, sonGiris: u.last_login || null,
    aiAnahtar: u.ai_anahtar ? { var: true, ipucu: u.ai_ipucu || null, eklendi: u.ai_eklendi || null } : { var: false } }, ek || {});   // anahtarın kendisi asla
}

function corsBasliklari(request, env) {
  const izinli = ((env && env.ALLOWED_ORIGIN) || VARSAYILAN_ORIGIN).split(',').map(x => x.trim());
  const origin = request.headers.get('Origin');
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Kullanici',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (origin && izinli.includes(origin)) h['Access-Control-Allow-Origin'] = origin;   // başka siteler tarayıcıda engellenir
  return h;
}

// ---------- Uranyum (U3O8) fiyatı ----------
// Yahoo'daki UX=F kontratı neredeyse hiç işlem görmediği için (son işlem haftalar önce) güncel fiyat, herkese açık
// bir sayfadan okunur (NYMEX UxC uranyum vadelisi, lb başına USD). Sayfa yapısı değişirse ayrıştırma başarısız olur
// ve panel Yahoo'ya düşer. Sonuç 20 dakika önbelleğe alınır (siteye gereksiz yük bindirmemek için).
const AY_NO = { january:1, february:2, march:3, april:4, may:5, june:6, july:7, august:8, september:9, october:10, november:11, december:12 };

function uranyumAyristir(html) {
  const metin = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ');
  const m = metin.match(/As of ([A-Za-z]+) (\d{1,2}), (\d{4}),? the uranium price is \$\s?([\d,]+(?:\.\d+)?) per pound(?:,? (up|down) ([\d.]+)%)?/i);
  if (!m) throw new Error('sayfa biçimi tanınmadı');
  const ay = AY_NO[m[1].toLowerCase()];
  const price = parseFloat(m[4].replace(/,/g, ''));
  if (!ay || !isFinite(price) || price < 20 || price > 400) throw new Error('fiyat makul aralık dışında');
  const yuzde = m[6] ? parseFloat(m[6]) * (m[5].toLowerCase() === 'down' ? -1 : 1) : 0;
  return {
    price,
    chgPct: yuzde,
    asOf: m[3] + '-' + String(ay).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0'),
    kaynak: 'MetalCharts (NYMEX UxC vadeli, U3O8 $/lb)',
  };
}

async function uranyumGetir() {
  const cache = (typeof caches !== 'undefined' && caches.default) ? caches.default : null;
  const anahtar = new Request('https://onbellek.finansal-takip.invalid/uranyum');
  if (cache) {
    const bulunan = await cache.match(anahtar);
    if (bulunan) return await bulunan.json();
  }
  const res = await fetch('https://metalcharts.org/uranium-price', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FinansTakip/1.0)', 'Accept': 'text/html' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const sonuc = uranyumAyristir(await res.text());
  if (cache) {
    await cache.put(anahtar, new Response(JSON.stringify(sonuc), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=1200' },
    }));
  }
  return sonuc;
}

// ---------- Ortak dış istekler için kısa önbellek (birden çok kullanıcı aynı fiyatı çekince kota korunur) ----------
async function onbellekliGetir(hedefUrl, sureSn, secenek) {
  const cache = (typeof caches !== 'undefined' && caches.default) ? caches.default : null;
  const anahtar = new Request('https://onbellek.finansal-takip.invalid/d?u=' + encodeURIComponent(hedefUrl));
  if (cache) {
    const b = await cache.match(anahtar);
    if (b) return { status: b.status, body: await b.arrayBuffer(), type: b.headers.get('Content-Type') || 'application/json' };
  }
  const up = await fetch(hedefUrl, secenek);
  const body = await up.arrayBuffer();
  const type = up.headers.get('Content-Type') || 'application/json';
  if (cache && up.ok) {
    await cache.put(anahtar, new Response(body, { status: up.status, headers: { 'Content-Type': type, 'Cache-Control': 'max-age=' + sureSn } }));
  }
  return { status: up.status, body, type };
}

// ---------- Kriptografi yardımcıları ----------
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64url = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
async function sha256(metin) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(metin)));
}
async function esitMi(a, b) {                // sabit zamanlı karşılaştırma
  const x = await sha256(a), y = await sha256(b);
  let fark = 0;
  for (let i = 0; i < x.length; i++) fark |= x[i] ^ y[i];
  return fark === 0;
}
async function sifreOzeti(sifre, tuzB64, iter) {
  const tuz = Uint8Array.from(atob(tuzB64), c => c.charCodeAt(0));
  const anahtar = await crypto.subtle.importKey('raw', new TextEncoder().encode(sifre), 'PBKDF2', false, ['deriveBits']);
  const bit = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: tuz, iterations: iter }, anahtar, 256);
  return b64(bit);
}
async function yeniSifreKaydi(sifre) {
  const tuz = b64(crypto.getRandomValues(new Uint8Array(16)));
  return { pass_salt: tuz, pass_iter: SIFRE_ITER, pass_hash: await sifreOzeti(sifre, tuz, SIFRE_ITER) };
}
// ---------- Kullanıcı Anthropic anahtarı: AES-GCM, ek doğrulama verisi kullanıcı kimliği (başka hesaba kopyalanan şifreli metin çözülmez) ----------
async function aiSifreAnahtari(env) {
  if (!env.AI_ANAHTAR_SIFRE) throw new Error('AI_ANAHTAR_SIFRE tanımlı değil');
  const ham = Uint8Array.from(atob(env.AI_ANAHTAR_SIFRE.trim()), c => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', ham, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function aiSifrele(env, metin, kullaniciId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(kullaniciId) }, await aiSifreAnahtari(env), new TextEncoder().encode(metin));
  return b64(iv) + '.' + b64(ct);
}
async function aiCoz(env, kayit, kullaniciId) {
  const [iv, ct] = String(kayit).split('.').map(x => Uint8Array.from(atob(x), c => c.charCodeAt(0)));
  const acik = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(kullaniciId) }, await aiSifreAnahtari(env), ct);
  return new TextDecoder().decode(acik);
}
const epostaNormal = e => String(e || '').trim().toLocaleLowerCase('tr-TR');
const epostaGecerli = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

// ---------- Şema ve ilk kurulum (tek kullanıcılıdan çok kullanıcılıya geçiş) ----------
let _semaDb = null;
async function semaHazirla(env) {
  if (!env.DB || _semaDb === env.DB) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'),   // eski (yedek olarak kalır)
    env.DB.prepare('CREATE TABLE IF NOT EXISTS auth_fail (ip TEXT NOT NULL, ts INTEGER NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_auth_fail ON auth_fail (ip, ts)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, ad TEXT, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, pass_iter INTEGER NOT NULL, role TEXT NOT NULL DEFAULT \'user\', disabled INTEGER NOT NULL DEFAULT 0, must_change INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_login INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS ukv (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, key))'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ukv_user_time ON ukv (user_id, updated_at)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS onbellek (k TEXT PRIMARY KEY, v TEXT NOT NULL, ts INTEGER NOT NULL)'),   // kotalı dış servis cevapları
    // Mesaj kutusu: yöneticiden kullanıcıya (alici = kullanıcı kimliği ya da '*' = herkes); okundu/silindi kullanıcı başına
    env.DB.prepare('CREATE TABLE IF NOT EXISTS mesajlar (id TEXT PRIMARY KEY, alici TEXT NOT NULL, gonderen TEXT, baslik TEXT NOT NULL, metin TEXT NOT NULL, ts INTEGER NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_mesajlar_alici ON mesajlar (alici, ts)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS mesaj_durum (mesaj_id TEXT NOT NULL, user_id TEXT NOT NULL, okundu INTEGER, silindi INTEGER, PRIMARY KEY (mesaj_id, user_id))'),
  ]);
  // Sonradan eklenen sütunlar (profil fotoğrafı, tercihler)
  const { results: sutunlar } = await env.DB.prepare("SELECT name FROM pragma_table_info('users')").all();
  const var_ = new Set((sutunlar || []).map(x => x.name));
  if (!var_.has('foto')) await env.DB.prepare('ALTER TABLE users ADD COLUMN foto TEXT').run();
  if (!var_.has('ayar')) await env.DB.prepare('ALTER TABLE users ADD COLUMN ayar TEXT').run();
  if (!var_.has('ai_anahtar')) await env.DB.prepare('ALTER TABLE users ADD COLUMN ai_anahtar TEXT').run();
  if (!var_.has('ai_ipucu')) await env.DB.prepare('ALTER TABLE users ADD COLUMN ai_ipucu TEXT').run();
  if (!var_.has('ai_eklendi')) await env.DB.prepare('ALTER TABLE users ADD COLUMN ai_eklendi INTEGER').run();
  // Kullanıcı tablosu boşsa: ilk yöneticiyi LOGIN_USER + ACCESS_TOKEN ile aç, eski verileri ona kopyala (bir kez)
  const say = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (!say || !say.n) {
    const eposta = epostaNormal((env.LOGIN_USER || '').split(',')[0]);
    if (eposta && env.ACCESS_TOKEN) {
      const id = 'u_' + b64url(crypto.getRandomValues(new Uint8Array(9)));
      const s = await yeniSifreKaydi(env.ACCESS_TOKEN.trim());
      await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO users (id, email, ad, pass_hash, pass_salt, pass_iter, role, created_at) VALUES (?, ?, ?, ?, ?, ?, \'admin\', ?)')
          .bind(id, eposta, null, s.pass_hash, s.pass_salt, s.pass_iter, Date.now()),
        // Aynı anda iki ilk istek gelirse kullanıcı satırı bir kez oluşur (e-posta UNIQUE); veri de o satırın kimliğine kopyalanır
        env.DB.prepare('INSERT OR IGNORE INTO ukv (user_id, key, value, updated_at) SELECT (SELECT id FROM users WHERE email = ?), key, value, updated_at FROM kv').bind(eposta),
      ]);
    }
  }
  _semaDb = env.DB;
}

async function kilitliMi(env, anahtar) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_fail WHERE ip = ? AND ts > ?').bind(anahtar, Date.now() - KILIT_PENCERE_MS).first();
  return r && r.n >= KILIT_ESIK;
}
async function hataliDeneme(env, ...anahtarlar) {
  const simdi = Date.now();
  await env.DB.batch([
    ...anahtarlar.map(a => env.DB.prepare('INSERT INTO auth_fail (ip, ts) VALUES (?, ?)').bind(a, simdi)),
    env.DB.prepare('DELETE FROM auth_fail WHERE ts < ?').bind(simdi - 24 * 3600 * 1000),
  ]);
}

// Oturumu çözer: { id, email, ad, role, must_change } ya da null
async function oturumKullanici(request, env) {
  const baslik = request.headers.get('Authorization') || '';
  const token = baslik.startsWith('Bearer ') ? baslik.slice(7).trim() : '';
  if (!token) return null;
  const ozet = hex(await sha256(token));
  const simdi = Date.now();
  const r = await env.DB.prepare('SELECT s.token_hash, s.expires_at, s.last_seen, u.id, u.email, u.ad, u.role, u.disabled, u.must_change FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').bind(ozet).first();
  if (r) {
    if (r.expires_at < simdi || r.disabled) return null;
    if (simdi - r.last_seen > 3600 * 1000) {   // kullanıldıkça uzar (saatte en fazla bir yazma)
      await env.DB.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?').bind(simdi, simdi + OTURUM_SURE_MS, ozet).run();
    }
    return { id: r.id, email: r.email, ad: r.ad, role: r.role, must_change: !!r.must_change };
  }
  // Geçiş: eski panel erişim kodunu (ACCESS_TOKEN) gönderiyorsa ilk yöneticinin hesabı sayılır
  if (env.ACCESS_TOKEN && await esitMi(token, env.ACCESS_TOKEN.trim())) {
    const y = await env.DB.prepare('SELECT id, email, ad, role, must_change FROM users WHERE role = \'admin\' AND disabled = 0 ORDER BY created_at LIMIT 1').first();
    if (y) return { id: y.id, email: y.email, ad: y.ad, role: y.role, must_change: !!y.must_change, eski: true };
  }
  return null;
}

async function oturumAc(env, kullaniciId) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const simdi = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)')
    .bind(hex(await sha256(token)), kullaniciId, simdi, simdi + OTURUM_SURE_MS, simdi).run();
  return token;
}

const LOAN_EXTRACT_SYSTEM_PROMPT = `Sen bir banka kredi ödeme planı belgesini yapılandırılmış veriye çeviren bir araçsın.
Sana bir kredi ödeme planı PDF'i verilecek (Türkiye'deki bankalardan). Görevin, belgedeki ödeme
planı tablosunu SADECE aşağıdaki JSON şemasında, başka hiçbir metin/açıklama/markdown olmadan döndürmek:

{
  "banka": "string (belgeden okunan banka adı)",
  "faizOraniAylik": number (aylık faiz oranı, % olarak, örn 1.99),
  "kkdfOrani": number (KKDF/Fon oranının faize oranı, % olarak — genelde tabloda Fon sütunu Faiz sütununun yaklaşık %15'i ise 15 yaz),
  "bsmvOrani": number (BSMV/Vergi oranının faize oranı, % olarak — genelde 15),
  "orijinalAnapara": number veya null (belgede varsa toplam/orijinal kredi tutarı),
  "kullandirimTarihi": "YYYY-MM-DD" veya null (kredinin kullandırıldığı/açıldığı tarih, belgede varsa),
  "dogrulamaTarihi": "YYYY-MM-DD" veya null (belgede "bugünkü kredi borcu" gibi bir anlık rakam varsa o rakamın tarihi),
  "dogrulamaTutari": number veya null (o anlık "bugünkü borç" rakamı, varsa),
  "schedule": [
    { "tarih": "YYYY-MM-DD", "kalanAnapara": number }
  ]
}

Kurallar:
- "schedule" dizisi, PDF'teki HER satırı eksiksiz içermeli — hiçbir taksiti atlama.
- "kalanAnapara", o taksit ödendikten SONRA kalan anapara sütunudur (genelde "Kalan Anapara" başlıklı sütun).
- Tarihleri DD.MM.YYYY formatından YYYY-MM-DD formatına çevir.
- Türkçe ondalık ayırıcı (virgül, binlik nokta) kullanılmışsa düzgün sayıya çevir (1.234,56 -> 1234.56).
- Emin olmadığın bir sayısal alanı ASLA uydurma; o alanı null bırak.
- Bu bir kredi ödeme planı değilse veya tablo okunamıyorsa, şu JSON'u döndür: {"hata": "kısa açıklama"}.
- Yanıtın SADECE JSON olsun — markdown kod bloğu (\`\`\`), başlık veya açıklama ekleme.`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const CORS_HEADERS = corsBasliklari(request, env);
    const json = (obj, status = 200, ek) => new Response(JSON.stringify(obj), {
      status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(ek || {}) },
    });
    const ip = request.headers.get('CF-Connecting-IP') || 'bilinmiyor';

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    if (url.pathname === '/') return json({ ok: true });
    if (!env.DB) return json({ error: 'D1 bağlı değil (Worker > Settings > Bindings > D1 database, değişken adı: DB)' }, 503);
    await semaHazirla(env);

    // ---------- GİRİŞ (oturum gerektirmeyen tek uç) ----------
    if (url.pathname === '/auth/login' && request.method === 'POST') {
      let g; try { g = await request.json(); } catch { return json({ error: 'geçersiz istek' }, 400); }
      const eposta = epostaNormal(g.email), sifre = String(g.password || '');
      if (await kilitliMi(env, ip) || (eposta && await kilitliMi(env, 'e:' + eposta))) {
        return json({ error: 'çok fazla hatalı deneme — 15 dakika sonra tekrar dene' }, 429, { 'Retry-After': '900' });
      }
      const u = eposta ? await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(eposta).first() : null;
      // Kullanıcı yoksa da aynı süre harcansın (e-postanın kayıtlı olup olmadığı anlaşılmasın)
      const ozet = await sifreOzeti(sifre, u ? u.pass_salt : 'AAAAAAAAAAAAAAAAAAAAAA==', u ? u.pass_iter : SIFRE_ITER);
      if (!u || u.disabled || !(await esitMi(ozet, u.pass_hash))) {
        await hataliDeneme(env, ip, ...(eposta ? ['e:' + eposta] : []));
        return json({ error: 'kullanıcı adı veya şifre hatalı' }, 401);
      }
      await env.DB.prepare('UPDATE users SET last_login = ? WHERE id = ?').bind(Date.now(), u.id).run();
      const token = await oturumAc(env, u.id);
      return json({ token, kullanici: kullaniciCikti(u) });
    }

    // ---------- KİMLİK KAPISI: bundan sonraki her şey geçerli bir oturum ister ----------
    if (await kilitliMi(env, ip)) return json({ error: 'çok fazla hatalı deneme — 15 dakika sonra tekrar dene' }, 429, { 'Retry-After': '900' });
    const ben = await oturumKullanici(request, env);
    if (!ben) {
      const b = request.headers.get('Authorization') || '';
      if (b.startsWith('Bearer ') && b.length > 7) await hataliDeneme(env, ip);
      return json({ error: 'giriş gerekli' }, 401);
    }
    const yonetici = ben.role === 'admin';

    // ---------- Eski panel uyumluluğu (geçiş süresince) ----------
    if (url.pathname === '/auth/check') return json({ ok: true, d1: true });

    if (url.pathname === '/auth/me') {
      const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(ben.id).first();
      const o = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?').bind(ben.id, Date.now()).first();
      return json({ kullanici: kullaniciCikti(u, { oturum: o ? o.n : 0 }) });
    }

    if (url.pathname === '/auth/profil' && request.method === 'POST') {
      let g; try { g = await request.json(); } catch { return json({ error: 'geçersiz istek' }, 400); }
      const alanlar = [], degerler = [];
      if (g.ad !== undefined) {
        const ad = String(g.ad || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        alanlar.push('ad = ?'); degerler.push(ad || null);
      }
      if (g.foto !== undefined) {
        if (g.foto !== null && (typeof g.foto !== 'string' || g.foto.length > FOTO_MAX || !FOTO_RE.test(g.foto))) return json({ error: 'fotoğraf geçersiz ya da çok büyük' }, 400);
        alanlar.push('foto = ?'); degerler.push(g.foto);
      }
      if (g.ayar !== undefined) {
        if (!g.ayar || typeof g.ayar !== 'object') return json({ error: 'tercihler geçersiz' }, 400);
        const temiz = {};
        TERCIH_ALANLARI.forEach(k => { if (typeof g.ayar[k] === 'string' && g.ayar[k].length <= 40) temiz[k] = g.ayar[k]; });
        alanlar.push('ayar = ?'); degerler.push(JSON.stringify(temiz));
      }
      if (!alanlar.length) return json({ error: 'değişiklik yok' }, 400);
      await env.DB.prepare('UPDATE users SET ' + alanlar.join(', ') + ' WHERE id = ?').bind(...degerler, ben.id).run();
      const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(ben.id).first();
      return json({ ok: true, kullanici: kullaniciCikti(u) });
    }

    if (url.pathname === '/auth/ai-anahtar') {
      if (request.method === 'DELETE') {
        await env.DB.prepare('UPDATE users SET ai_anahtar = NULL, ai_ipucu = NULL, ai_eklendi = NULL WHERE id = ?').bind(ben.id).run();
        const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(ben.id).first();
        return json({ ok: true, kullanici: kullaniciCikti(u) });
      }
      if (request.method !== 'POST') return json({ error: 'desteklenmeyen istek' }, 405);
      let g; try { g = await request.json(); } catch { return json({ error: 'geçersiz istek' }, 400); }
      const anahtar = String(g.anahtar || '').trim();
      if (!/^sk-ant-[A-Za-z0-9_-]{20,200}$/.test(anahtar)) return json({ error: 'Bu bir Anthropic API anahtarına benzemiyor (sk-ant- ile başlamalı).' }, 400);
      // Anthropic'e ücretsiz bir istekle doğrula (model listesi; jeton harcamaz)
      let durum = 0, mesaj = '';
      try {
        const t = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': anahtar, 'anthropic-version': '2023-06-01' } });
        durum = t.status;
        if (!t.ok) { const d = await t.json().catch(() => ({})); mesaj = (d.error && d.error.message) || ''; }
      } catch (e) { return json({ error: 'Anthropic’e ulaşılamadı, biraz sonra tekrar dene.' }, 502); }
      if (durum === 401) return json({ error: 'Anthropic bu anahtarı tanımadı. Doğru kopyaladığından ve iptal edilmediğinden emin ol.' }, 400);
      if (durum === 403) return json({ error: 'Bu anahtarın yetkisi yok' + (mesaj ? ' (' + mesaj + ')' : '') + '.' }, 400);
      if (durum !== 200) return json({ error: 'Anahtar doğrulanamadı (Anthropic: ' + (mesaj || 'HTTP ' + durum) + ').' }, 400);
      let sifreli;
      try { sifreli = await aiSifrele(env, anahtar, ben.id); } catch (e) { return json({ error: 'Sunucu ayarı eksik (AI_ANAHTAR_SIFRE).' }, 503); }
      const ipucu = anahtar.slice(0, 7) + '…' + anahtar.slice(-4);
      await env.DB.prepare('UPDATE users SET ai_anahtar = ?, ai_ipucu = ?, ai_eklendi = ? WHERE id = ?').bind(sifreli, ipucu, Date.now(), ben.id).run();
      const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(ben.id).first();
      return json({ ok: true, kullanici: kullaniciCikti(u) });
    }

    if (url.pathname === '/auth/cikis-diger' && request.method === 'POST') {
      const b = (request.headers.get('Authorization') || '').slice(7).trim();
      const r = await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(ben.id, hex(await sha256(b))).run();
      return json({ ok: true, kapanan: (r.meta && r.meta.changes) || 0 });
    }

    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      const b = (request.headers.get('Authorization') || '').slice(7).trim();
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hex(await sha256(b))).run();
      return json({ ok: true });
    }

    if (url.pathname === '/auth/sifre' && request.method === 'POST') {
      let g; try { g = await request.json(); } catch { return json({ error: 'geçersiz istek' }, 400); }
      const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(ben.id).first();
      if (!u || !(await esitMi(await sifreOzeti(String(g.eski || ''), u.pass_salt, u.pass_iter), u.pass_hash))) {
        await hataliDeneme(env, ip, 'e:' + u.email);
        return json({ error: 'mevcut şifre hatalı' }, 400);
      }
      const yeni = String(g.yeni || '');
      if (yeni.length < SIFRE_MIN) return json({ error: 'yeni şifre en az ' + SIFRE_MIN + ' karakter olmalı' }, 400);
      const s = await yeniSifreKaydi(yeni);
      const b = (request.headers.get('Authorization') || '').slice(7).trim();
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET pass_hash = ?, pass_salt = ?, pass_iter = ?, must_change = 0 WHERE id = ?').bind(s.pass_hash, s.pass_salt, s.pass_iter, ben.id),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(ben.id, hex(await sha256(b))),   // diğer cihazlardan çıkış
      ]);
      return json({ ok: true });
    }

    // ---------- YÖNETİM: kullanıcılar (yalnız yönetici) ----------
    // ---------- MESAJ KUTUSU (kullanıcı) ----------
    // GET /mesajlar · POST /mesajlar/okundu {ids:[…]} ya da {hepsi:true} · DELETE /mesajlar/<id> (yalnız kendi kutusundan kaldırır)
    if (url.pathname === '/mesajlar' && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        "SELECT m.id, m.baslik, m.metin, m.ts, m.alici, d.okundu, g.ad AS gonderen_ad FROM mesajlar m LEFT JOIN mesaj_durum d ON d.mesaj_id = m.id AND d.user_id = ? LEFT JOIN users g ON g.id = m.gonderen "
        + "WHERE (m.alici = ? OR m.alici = '*') AND NOT (m.alici = '*' AND m.gonderen = ?) AND d.silindi IS NULL ORDER BY m.ts DESC LIMIT 100"
      ).bind(ben.id, ben.id, ben.id).all();
      const mesajlar = (results || []).map(m => ({ id: m.id, baslik: m.baslik, metin: m.metin, ts: m.ts, herkese: m.alici === '*', okundu: !!m.okundu, gonderen: m.gonderen_ad || 'Yönetici' }));
      return json({ mesajlar, okunmamis: mesajlar.filter(m => !m.okundu).length });
    }
    if (url.pathname === '/mesajlar/okundu' && request.method === 'POST') {
      let g; try { g = await request.json(); } catch { return json({ error: 'geçersiz istek' }, 400); }
      const simdi = Date.now(), gorunur = "(alici = ? OR alici = '*')";
      const ust = 'INSERT INTO mesaj_durum (mesaj_id, user_id, okundu) SELECT id, ?, ? FROM mesajlar WHERE ' + gorunur;
      const son = ' ON CONFLICT (mesaj_id, user_id) DO UPDATE SET okundu = COALESCE(mesaj_durum.okundu, excluded.okundu)';
      if (g.hepsi) await env.DB.prepare(ust + son).bind(ben.id, simdi, ben.id).run();
      else {
        const ids = (Array.isArray(g.ids) ? g.ids : []).map(String).filter(x => /^ms_[\w-]{6,40}$/.test(x)).slice(0, 100);
        if (!ids.length) return json({ ok: true });
        await env.DB.prepare(ust + ' AND id IN (' + ids.map(() => '?').join(',') + ')' + son).bind(ben.id, simdi, ben.id, ...ids).run();
      }
      return json({ ok: true });
    }
    if (url.pathname.startsWith('/mesajlar/') && request.method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.slice('/mesajlar/'.length));
      const m = await env.DB.prepare("SELECT id FROM mesajlar WHERE id = ? AND (alici = ? OR alici = '*')").bind(id, ben.id).first();
      if (!m) return json({ error: 'mesaj bulunamadı' }, 404);
      const simdi = Date.now();
      await env.DB.prepare('INSERT INTO mesaj_durum (mesaj_id, user_id, okundu, silindi) VALUES (?, ?, ?, ?) ON CONFLICT (mesaj_id, user_id) DO UPDATE SET silindi = excluded.silindi, okundu = COALESCE(mesaj_durum.okundu, excluded.okundu)')
        .bind(id, ben.id, simdi, simdi).run();
      return json({ ok: true });
    }

    // ---------- MESAJ GÖNDERME (yönetici) ----------
    // GET /admin/mesajlar (gönderilenler + kaç kişi okudu) · POST /admin/mesajlar {alici, baslik, metin} · DELETE /admin/mesajlar/<id> (herkesten geri alır)
    if (url.pathname === '/admin/mesajlar' || url.pathname.startsWith('/admin/mesajlar/')) {
      if (!yonetici) return json({ error: 'yetki yok' }, 403);
      if (url.pathname === '/admin/mesajlar' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          "SELECT m.id, m.alici, m.baslik, m.metin, m.ts, u.email AS alici_email, u.ad AS alici_ad, (SELECT COUNT(*) FROM mesaj_durum d WHERE d.mesaj_id = m.id AND d.okundu IS NOT NULL) AS okuyan FROM mesajlar m LEFT JOIN users u ON u.id = m.alici ORDER BY m.ts DESC LIMIT 100"
        ).all();
        const herkes = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE disabled = 0 AND id != ?').bind(ben.id).first();
        return json({ mesajlar: results || [], herkesSayisi: herkes ? herkes.n : 0 });
      }
      if (url.pathname === '/admin/mesajlar' && request.method === 'POST') {
        let g; try { g = await request.json(); } catch { return json({ error: 'geçersiz istek' }, 400); }
        const alici = String(g.alici || ''), baslik = String(g.baslik || '').trim().slice(0, 120), metin = String(g.metin || '').trim().slice(0, 4000);
        if (!baslik) return json({ error: 'konu yaz' }, 400);
        if (!metin) return json({ error: 'mesajı yaz' }, 400);
        if (alici !== '*') {
          const u = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(alici).first();
          if (!u) return json({ error: 'alıcı bulunamadı' }, 404);
        }
        const id = 'ms_' + b64url(crypto.getRandomValues(new Uint8Array(9)));
        await env.DB.prepare('INSERT INTO mesajlar (id, alici, gonderen, baslik, metin, ts) VALUES (?, ?, ?, ?, ?, ?)').bind(id, alici, ben.id, baslik, metin, Date.now()).run();
        return json({ ok: true, id });
      }
      if (url.pathname.startsWith('/admin/mesajlar/') && request.method === 'DELETE') {
        const id = decodeURIComponent(url.pathname.slice('/admin/mesajlar/'.length));
        await env.DB.batch([
          env.DB.prepare('DELETE FROM mesaj_durum WHERE mesaj_id = ?').bind(id),
          env.DB.prepare('DELETE FROM mesajlar WHERE id = ?').bind(id),
        ]);
        return json({ ok: true });
      }
      return json({ error: 'desteklenmeyen istek' }, 405);
    }

    if (url.pathname === '/admin/kullanicilar' || url.pathname.startsWith('/admin/kullanicilar/')) {
      if (!yonetici) return json({ error: 'yetki yok' }, 403);
      const parca = url.pathname.split('/').filter(Boolean);   // ['admin','kullanicilar', id?, eylem?]
      const hedefId = parca[2] ? decodeURIComponent(parca[2]) : null, eylem = parca[3] || null;

      if (!hedefId && request.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT u.id, u.email, u.ad, u.foto, u.role, u.disabled, u.must_change, u.created_at, u.last_login, (SELECT COUNT(*) FROM ukv WHERE user_id = u.id) AS kayit, (SELECT COALESCE(SUM(LENGTH(value)), 0) FROM ukv WHERE user_id = u.id) AS boyut FROM users u ORDER BY u.created_at').all();
        return json({ kullanicilar: results || [] });
      }
      if (!hedefId && request.method === 'POST') {
        let g; try { g = await request.json(); } catch { return json({ error: 'geçersiz istek' }, 400); }
        const eposta = epostaNormal(g.email), sifre = String(g.sifre || ''), ad = String(g.ad || '').trim().slice(0, 80);
        if (!epostaGecerli(eposta)) return json({ error: 'geçerli bir e-posta yaz' }, 400);
        if (sifre.length < SIFRE_MIN) return json({ error: 'geçici şifre en az ' + SIFRE_MIN + ' karakter olmalı' }, 400);
        const var_ = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(eposta).first();
        if (var_) return json({ error: 'bu e-postayla bir kullanıcı zaten var' }, 409);
        const id = 'u_' + b64url(crypto.getRandomValues(new Uint8Array(9)));
        const s = await yeniSifreKaydi(sifre);
        await env.DB.prepare('INSERT INTO users (id, email, ad, pass_hash, pass_salt, pass_iter, role, must_change, created_at) VALUES (?, ?, ?, ?, ?, ?, \'user\', 1, ?)')
          .bind(id, eposta, ad || null, s.pass_hash, s.pass_salt, s.pass_iter, Date.now()).run();
        return json({ ok: true, id });
      }
      if (hedefId) {
        const hedef = await env.DB.prepare('SELECT id, email, role FROM users WHERE id = ?').bind(hedefId).first();
        if (!hedef) return json({ error: 'kullanıcı bulunamadı' }, 404);
        if (eylem === 'sifre' && request.method === 'POST') {
          let g; try { g = await request.json(); } catch { return json({ error: 'geçersiz istek' }, 400); }
          const sifre = String(g.sifre || '');
          if (sifre.length < SIFRE_MIN) return json({ error: 'şifre en az ' + SIFRE_MIN + ' karakter olmalı' }, 400);
          const s = await yeniSifreKaydi(sifre);
          await env.DB.batch([
            env.DB.prepare('UPDATE users SET pass_hash = ?, pass_salt = ?, pass_iter = ?, must_change = ? WHERE id = ?').bind(s.pass_hash, s.pass_salt, s.pass_iter, hedef.id === ben.id ? 0 : 1, hedef.id),
            env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(hedef.id),
          ]);
          return json({ ok: true });
        }
        if (eylem === 'durum' && request.method === 'POST') {
          if (hedef.id === ben.id) return json({ error: 'kendi hesabını devre dışı bırakamazsın' }, 400);
          let g; try { g = await request.json(); } catch { return json({ error: 'geçersiz istek' }, 400); }
          const kapali = g.disabled ? 1 : 0;
          await env.DB.batch([
            env.DB.prepare('UPDATE users SET disabled = ? WHERE id = ?').bind(kapali, hedef.id),
            ...(kapali ? [env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(hedef.id)] : []),
          ]);
          return json({ ok: true });
        }
        if (!eylem && request.method === 'DELETE') {
          if (hedef.id === ben.id) return json({ error: 'kendi hesabını buradan silemezsin' }, 400);
          await env.DB.batch([
            env.DB.prepare('DELETE FROM ukv WHERE user_id = ?').bind(hedef.id),
            env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(hedef.id),
            env.DB.prepare('DELETE FROM mesaj_durum WHERE user_id = ? OR mesaj_id IN (SELECT id FROM mesajlar WHERE alici = ?)').bind(hedef.id, hedef.id),
            env.DB.prepare('DELETE FROM mesajlar WHERE alici = ?').bind(hedef.id),
            env.DB.prepare('DELETE FROM users WHERE id = ?').bind(hedef.id),
          ]);
          return json({ ok: true });
        }
      }
      return json({ error: 'desteklenmeyen istek' }, 405);
    }

    // ---------- URANYUM ----------
    if (url.pathname === '/uranyum') {
      try { return json(await uranyumGetir()); }
      catch (e) { return json({ error: 'uranyum fiyatı alınamadı: ' + e.message }, 502); }
    }

    // ---------- URANYUM GEÇMİŞİ (MetalCharts; ücretsiz katman ayda 200 istek → 12 saat D1 önbelleği, hatada 1 saat bekleme) ----------
    if (url.pathname === '/uranyum-gecmis') {
      const anahtar = (env.metalcharts || env.METALCHARTS_API_KEY || '').trim();
      if (!anahtar) return json({ error: 'MetalCharts anahtarı tanımlı değil' }, 503);
      const aralik = url.searchParams.get('aralik') === '1Y' ? '1Y' : '1M';
      const ck = 'mc:UXA:' + aralik;
      const simdi = Date.now();
      const kayit = await env.DB.prepare('SELECT v, ts FROM onbellek WHERE k = ?').bind(ck).first();
      if (kayit && simdi - kayit.ts < 12 * 3600 * 1000) return json(JSON.parse(kayit.v));
      const hata = await env.DB.prepare('SELECT v, ts FROM onbellek WHERE k = ?').bind(ck + ':hata').first();
      // Geçici hata: 1 saat; plan kapsamı / geçersiz anahtar gibi kalıcı hata: 7 gün yeniden denenmez (ücretsiz kota boşa gitmesin)
      const kalici = hata && /plan|upgrade|invalid api key|requires an api key/i.test(hata.v);
      if (hata && simdi - hata.ts < (kalici ? 7 * 24 : 1) * 3600 * 1000) {
        return kayit ? json(JSON.parse(kayit.v)) : json({ error: 'MetalCharts şu an kullanılamıyor: ' + hata.v }, 502);
      }
      try {
        const res = await fetch(`https://api.metalcharts.org/v1/history/UXA?range=${aralik}&interval=${aralik === '1Y' ? '1w' : '1d'}`, {
          headers: { Authorization: 'Bearer ' + anahtar, 'Accept': 'application/json', 'User-Agent': 'FinansTakip/1.0' },
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || !Array.isArray(d.data)) throw new Error((d && d.error) || ('HTTP ' + res.status));
        const noktalar = d.data.map(x => [Date.parse(x.timestamp), Number(x.close != null ? x.close : x.price)]).filter(x => isFinite(x[0]) && isFinite(x[1]) && x[1] > 0);
        if (noktalar.length < 2) throw new Error('veri yok');
        const sonuc = { noktalar, kaynak: 'MetalCharts', birim: 'USD/lb', aralik, alindi: simdi };
        await env.DB.prepare('INSERT OR REPLACE INTO onbellek (k, v, ts) VALUES (?, ?, ?)').bind(ck, JSON.stringify(sonuc), simdi).run();
        return json(sonuc);
      } catch (e) {
        await env.DB.prepare('INSERT OR REPLACE INTO onbellek (k, v, ts) VALUES (?, ?, ?)').bind(ck + ':hata', String(e.message || e).slice(0, 200), simdi).run();
        return kayit ? json(JSON.parse(kayit.v)) : json({ error: 'uranyum geçmişi alınamadı: ' + (e.message || e) }, 502);
      }
    }

    // ---------- VERİ (her kullanıcının kendi verisi) ----------
    if (url.pathname === '/data' || url.pathname.startsWith('/data/')) {
      if (url.pathname === '/data' && request.method === 'GET') {
        const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
        const { results } = await env.DB.prepare('SELECT key, value, updated_at FROM ukv WHERE user_id = ? AND updated_at > ? ORDER BY updated_at').bind(ben.id, since).all();
        return json({ items: results || [] });
      }
      if (url.pathname.startsWith('/data/') && request.method === 'PUT') {
        let anahtar;
        try { anahtar = decodeURIComponent(url.pathname.slice('/data/'.length)); } catch { return json({ error: 'geçersiz anahtar' }, 400); }
        if (!IZINLI_ANAHTARLAR.has(anahtar)) return json({ error: 'bu anahtara izin yok' }, 400);
        let govde;
        try { govde = await request.json(); } catch { return json({ error: 'geçersiz JSON' }, 400); }
        if (typeof govde.value !== 'string') return json({ error: 'value (string) gerekli' }, 400);
        if (govde.value.length > MAX_DEGER_BAYT) return json({ error: 'veri çok büyük' }, 413);

        const mevcut = await env.DB.prepare('SELECT value, updated_at FROM ukv WHERE user_id = ? AND key = ?').bind(ben.id, anahtar).first();
        // Başka bir cihaz bu anahtarı bizden sonra güncellemişse üzerine yazma; güncel halini döndür
        if (mevcut && govde.expected != null && mevcut.updated_at > Number(govde.expected)) {
          return json({ error: 'çakışma', current: { value: mevcut.value, updated_at: mevcut.updated_at } }, 409);
        }
        // Zaman damgası kullanıcının TÜM anahtarları için kesinlikle artan olmalı (aynı milisaniyedeki iki yazmadan biri
        // "since" ile çekmede kaybolmasın): tek atomik ifadeyle max(şimdi, kullanıcının en yüksek damgası + 1)
        await env.DB.prepare(
          'INSERT INTO ukv (user_id, key, value, updated_at) VALUES (?, ?, ?, MAX(?, COALESCE((SELECT MAX(updated_at) FROM ukv WHERE user_id = ?), 0) + 1)) ' +
          'ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
        ).bind(ben.id, anahtar, govde.value, Date.now(), ben.id).run();
        const kayit = await env.DB.prepare('SELECT updated_at FROM ukv WHERE user_id = ? AND key = ?').bind(ben.id, anahtar).first();
        return json({ ok: true, updated_at: kayit.updated_at });
      }
      return json({ error: 'desteklenmeyen istek' }, 405);
    }

    // ---------- CORS PROXY ----------
    if (url.pathname === '/proxy') {
      const target = url.searchParams.get('url');
      if (!target) return json({ error: 'url parametresi gerekli' }, 400);
      // Sadece izin verilen kaynaklara gitsin (güvenlik)
      const allowed = [
        'query1.finance.yahoo.com',
        'query2.finance.yahoo.com',
        'fred.stlouisfed.org',
        'news.google.com',
        'stooq.com',
        // Haber kurumlarının RSS yayınları (Piyasa Özeti › Güncel Haberler)
        'investing.com',               // www. ve tr. alt alan adları
        'bloomberght.com',
        'aa.com.tr',
        'feeds.bbci.co.uk',
        'cnbc.com',
        'feeds.content.dowjones.io',   // MarketWatch
      ];
      let targetHost;
      try { targetHost = new URL(target).hostname; } catch { return json({ error: 'geçersiz url' }, 400); }
      if (!allowed.some(h => targetHost === h || targetHost.endsWith('.' + h))) return json({ error: 'bu adrese izin yok' }, 403);
      try {
        const r = await onbellekliGetir(target, 60, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FinansTakip/1.0)', 'Accept': '*/*' } });
        return new Response(r.body, { status: r.status, headers: { ...CORS_HEADERS, 'Content-Type': r.type || 'text/plain', 'Cache-Control': 'no-store' } });
      } catch (e) {
        return json({ error: 'kaynak alınamadı: ' + e.message }, 502);
      }
    }

    // ---------- AI GEÇİDİ ----------
    if (url.pathname === '/ai' || url.pathname === '/extract-loan') {
      if (request.method !== 'POST') return json({ error: 'POST bekleniyor' }, 405);
      // Yönetici: sunucunun anahtarı. Diğer kullanıcılar: Profilim'de kaydettikleri kendi anahtarı (ücret onların Anthropic hesabından)
      const hataVer = (m, kod, st) => json(url.pathname === '/ai' ? { error: { message: m }, kod } : { error: m, kod }, st);
      let apiAnahtari;
      if (yonetici) {
        apiAnahtari = env.ANTHROPIC_API_KEY;
        if (!apiAnahtari) return json({ error: 'ANTHROPIC_API_KEY tanımlı değil (Worker > Settings > Variables and Secrets)' }, 500);
      } else {
        const k = await env.DB.prepare('SELECT ai_anahtar FROM users WHERE id = ?').bind(ben.id).first();
        if (!k || !k.ai_anahtar) return hataVer('Bay Piyasa için Profilim › Bay Piyasa bölümünden kendi Anthropic API anahtarını ekle.', 'anahtar_gerekli', 403);
        try { apiAnahtari = await aiCoz(env, k.ai_anahtar, ben.id); }
        catch (e) { return hataVer('Kayıtlı anahtarın okunamadı; Profilim › Bay Piyasa bölümünden yeniden ekle.', 'anahtar_gerekli', 403); }
      }
      // Kullanıcının anahtarı Anthropic'te reddedilirse 401 yerine 400 (401 panelde "oturum bitti" sayılır)
      const anahtarHatasi = st => !yonetici && (st === 401 || st === 403);
      let payload;
      try { payload = await request.json(); } catch { return json({ error: 'geçersiz JSON' }, 400); }

      if (url.pathname === '/ai') {
        const ALLOWED_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1'];
        const model = ALLOWED_MODELS.includes(payload.model) ? payload.model : 'claude-sonnet-5';
        // Cevap uzunluğu istemciden gelir (en fazla 16000: yeni modeller yazmadan önce düşünür, düşünme de bu bütçeden harcar;
        // ücret yalnız gerçekten üretilen token kadardır). Web araması ARAMA BAŞINA $0,01 ücretlidir; yalnız istenirse.
        const maxTokens = Math.min(Math.max(parseInt(payload.max_tokens, 10) || 2500, 200), 16000);
        const body = { model, max_tokens: maxTokens, system: payload.system || '', messages: payload.messages || [] };
        if (payload.webSearch === true) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
        try {
          const upstream = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiAnahtari, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify(body),
          });
          if (anahtarHatasi(upstream.status)) return hataVer('Anthropic anahtarın reddedildi (geçersiz, iptal edilmiş ya da bakiyesi yok). Profilim › Bay Piyasa’dan kontrol et.', 'anahtar_gecersiz', 400);
          return json(await upstream.json(), upstream.status);
        } catch (e) {
          return json({ error: 'AI isteği başarısız: ' + e.message }, 502);
        }
      }

      // /extract-loan — kredi ödeme planı PDF'i
      if (!payload.pdfBase64) return json({ error: 'pdfBase64 alanı gerekli' }, 400);
      try {
        const upstream = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiAnahtari, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-5',
            max_tokens: 4000,
            system: LOAN_EXTRACT_SYSTEM_PROMPT,
            messages: [{
              role: 'user',
              content: [
                { type: 'document', source: { type: 'base64', media_type: payload.mediaType || 'application/pdf', data: payload.pdfBase64 } },
                { type: 'text', text: 'Bu kredi ödeme planını yukarıdaki JSON şemasına göre çıkar.' },
              ],
            }],
          }),
        });
        if (anahtarHatasi(upstream.status)) return hataVer('Anthropic anahtarın reddedildi (geçersiz, iptal edilmiş ya da bakiyesi yok). Profilim › Bay Piyasa’dan kontrol et.', 'anahtar_gecersiz', 400);
        const data = await upstream.json();
        if (!upstream.ok) return json({ error: 'Anthropic API hatası', detail: data }, upstream.status === 401 ? 502 : upstream.status);
        const textBlock = (data.content || []).find(b => b.type === 'text');
        const rawText = textBlock ? textBlock.text : '';
        let extracted;
        try {
          const cleaned = rawText.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
          extracted = JSON.parse(cleaned);
        } catch (e) {
          return json({ error: 'Model yanıtı JSON olarak ayrıştırılamadı', raw: rawText }, 502);
        }
        return json(extracted);
      } catch (e) {
        return json({ error: 'Kredi çıkarma isteği başarısız: ' + e.message }, 502);
      }
    }

    // ---------- ABD HİSSE / ETF ARAMA (Finnhub symbol lookup; aynı sorgu 1 gün önbellekte) ----------
    if (url.pathname === '/fh-ara') {
      const q = (url.searchParams.get('q') || '').trim().toUpperCase().slice(0, 30);
      if (q.length < 1) return json({ sonuc: [] });
      if (!env.FINNHUB_API_KEY) return json({ error: 'FINNHUB_API_KEY tanımlı değil' }, 500);
      try {
        const r = await onbellekliGetir(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&exchange=US&token=${env.FINNHUB_API_KEY}`, 86400);
        const d = JSON.parse(new TextDecoder().decode(r.body));
        if (r.status !== 200) throw new Error((d && d.error) || ('HTTP ' + r.status));
        const sonuc = (d.result || [])
          .filter(x => x && /^[A-Z][A-Z.]{0,6}$/.test(x.symbol || '') && /Common Stock|ADR|ETP|ETF|REIT/i.test(x.type || ''))
          .map(x => ({ sembol: x.symbol, ad: String(x.description || '').slice(0, 60), tur: x.type }))
          .sort((a, b) => (b.sembol === q) - (a.sembol === q))
          .slice(0, 15);
        return json({ sonuc });
      } catch (e) {
        return json({ error: 'arama yapılamadı: ' + (e.message || e) }, 502);
      }
    }

    // ---------- TWELVE DATA / FINNHUB (ortak kota: 60 sn önbellek) ----------
    if (url.pathname === '/td' || url.pathname === '/td-series' || url.pathname === '/fh') {
      const symbol = url.searchParams.get('symbol');
      if (!symbol) return json({ error: 'symbol parametresi gerekli' }, 400);
      let hedef;
      if (url.pathname === '/fh') {
        if (!env.FINNHUB_API_KEY) return json({ error: 'FINNHUB_API_KEY tanımlı değil (Worker > Settings > Variables and Secrets)' }, 500);
        hedef = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${env.FINNHUB_API_KEY}`;
      } else {
        if (!env.TWELVEDATA_API_KEY) return json({ error: 'TWELVEDATA_API_KEY tanımlı değil (Worker > Settings > Variables and Secrets)' }, 500);
        hedef = url.pathname === '/td'
          ? `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${env.TWELVEDATA_API_KEY}`
          : `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(url.searchParams.get('interval') || '1day')}&outputsize=${encodeURIComponent(url.searchParams.get('outputsize') || '30')}&apikey=${env.TWELVEDATA_API_KEY}`;
      }
      try {
        // Twelve Data günde 800 kredi: kaç kullanıcı olursa olsun anlık fiyat en fazla 5 dakikada bir (≈288/gün), geçmiş 10 dakikada bir çekilir
        const r = await onbellekliGetir(hedef, url.pathname === '/td-series' ? 600 : url.pathname === '/td' ? 300 : 60);
        return new Response(r.body, { status: r.status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      } catch (e) {
        return json({ error: (url.pathname === '/fh' ? 'Finnhub' : 'Twelve Data') + ' isteği başarısız: ' + e.message }, 502);
      }
    }

    return json({ error: 'bulunamadı' }, 404);
  },
};
