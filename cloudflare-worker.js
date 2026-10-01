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
//     /admin/kullanicilar (GET, POST) · /admin/kullanicilar/:id/sifre (POST) · /admin/kullanicilar/:id/durum (POST)
//     /admin/kullanicilar/:id (DELETE)                                   — yalnız yönetici
//     /data (GET), /data/:anahtar (PUT)    -> kullanıcının verileri (cihazlar arası senkron)
//     /proxy?url=...                       -> CORS proxy (Yahoo, FRED, Google News, haber RSS'leri; 60 sn önbellek)
//     /ai, /extract-loan                   -> Anthropic geçidi (şimdilik yalnız yönetici; diğerleri kendi anahtarıyla — sonraki aşama)
//     /td, /td-series, /fh                 -> Twelve Data / Finnhub geçitleri (ortak kota için 60 sn önbellek)
//     /uranyum                             -> uranyum fiyatı
//     /auth/check                          -> ESKİ panel uyumluluğu (geçiş süresince)
//
// KURULUM (Cloudflare panelinde):
//   A) D1 veritabanı: finansal-takip  →  Worker > Settings > Bindings > D1 (Variable name: DB)
//   B) Secrets: ANTHROPIC_API_KEY, TWELVEDATA_API_KEY, FINNHUB_API_KEY
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
]);
const MAX_DEGER_BAYT = 1500000;      // D1 satır sınırı 2 MB
const KILIT_ESIK = 8;                // 15 dk içinde bu kadar yanlış deneme → kilit
const KILIT_PENCERE_MS = 15 * 60 * 1000;
const OTURUM_SURE_MS = 180 * 24 * 3600 * 1000;   // 180 gün; kullanıldıkça uzar
const SIFRE_ITER = 20000;            // PBKDF2 tekrar sayısı: ücretsiz plan istek başına ~10 ms CPU verir (60 bin ≈ 22 ms). Kullanıcı başına saklanır, ileride artırılabilir.
const SIFRE_MIN = 8;

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
  ]);
  // Kullanıcı tablosu boşsa: ilk yöneticiyi LOGIN_USER + ACCESS_TOKEN ile aç, eski verileri ona kopyala (bir kez)
  const say = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (!say || !say.n) {
    const eposta = epostaNormal((env.LOGIN_USER || '').split(',')[0]);
    if (eposta && env.ACCESS_TOKEN) {
      const id = 'u_' + b64url(crypto.getRandomValues(new Uint8Array(9)));
      const s = await yeniSifreKaydi(env.ACCESS_TOKEN.trim());
      await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO users (id, email, ad, pass_hash, pass_salt, pass_iter, role, created_at) VALUES (?, ?, ?, ?, ?, ?, \'admin\', ?)')
          .bind(id, eposta, 'Yönetici', s.pass_hash, s.pass_salt, s.pass_iter, Date.now()),
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
      return json({ token, kullanici: { id: u.id, email: u.email, ad: u.ad, rol: u.role, sifreDegismeli: !!u.must_change } });
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

    if (url.pathname === '/auth/me') return json({ kullanici: { id: ben.id, email: ben.email, ad: ben.ad, rol: ben.role, sifreDegismeli: ben.must_change } });

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
    if (url.pathname === '/admin/kullanicilar' || url.pathname.startsWith('/admin/kullanicilar/')) {
      if (!yonetici) return json({ error: 'yetki yok' }, 403);
      const parca = url.pathname.split('/').filter(Boolean);   // ['admin','kullanicilar', id?, eylem?]
      const hedefId = parca[2] ? decodeURIComponent(parca[2]) : null, eylem = parca[3] || null;

      if (!hedefId && request.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT u.id, u.email, u.ad, u.role, u.disabled, u.must_change, u.created_at, u.last_login, (SELECT COUNT(*) FROM ukv WHERE user_id = u.id) AS kayit, (SELECT COALESCE(SUM(LENGTH(value)), 0) FROM ukv WHERE user_id = u.id) AS boyut FROM users u ORDER BY u.created_at').all();
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
      // Şimdilik yalnız yönetici (sunucunun anahtarı). Diğer kullanıcılar sonraki aşamada kendi Anthropic anahtarıyla.
      if (!yonetici) {
        const m = 'Bay Piyasa ve PDF okuma için hesabına kendi Anthropic API anahtarını eklemen gerekecek — bu ayar yakında geliyor. Krediyi şimdilik elle ekleyebilirsin.';
        return json(url.pathname === '/ai' ? { error: { message: m }, kod: 'anahtar_gerekli' } : { error: m, kod: 'anahtar_gerekli' }, 403);
      }
      if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY tanımlı değil (Worker > Settings > Variables and Secrets)' }, 500);
      let payload;
      try { payload = await request.json(); } catch { return json({ error: 'geçersiz JSON' }, 400); }

      if (url.pathname === '/ai') {
        const ALLOWED_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1'];
        const model = ALLOWED_MODELS.includes(payload.model) ? payload.model : 'claude-sonnet-5';
        // Cevap uzunluğu istemciden gelir (en fazla 4000). Web araması ARAMA BAŞINA $0,01 ücretlidir; yalnız istenirse.
        const maxTokens = Math.min(Math.max(parseInt(payload.max_tokens, 10) || 2500, 200), 4000);
        const body = { model, max_tokens: maxTokens, system: payload.system || '', messages: payload.messages || [] };
        if (payload.webSearch === true) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
        try {
          const upstream = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify(body),
          });
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
          headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
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
        const data = await upstream.json();
        if (!upstream.ok) return json({ error: 'Anthropic API hatası', detail: data }, upstream.status);
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
        const r = await onbellekliGetir(hedef, url.pathname === '/td-series' ? 600 : 60);
        return new Response(r.body, { status: r.status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      } catch (e) {
        return json({ error: (url.pathname === '/fh' ? 'Finnhub' : 'Twelve Data') + ' isteği başarısız: ' + e.message }, 502);
      }
    }

    return json({ error: 'bulunamadı' }, 404);
  },
};
