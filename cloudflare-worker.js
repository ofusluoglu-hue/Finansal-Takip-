// =====================================================================
// Finansal Takip Paneli — Cloudflare Worker
//
//   GÜVENLİK: Worker'a gelen HER istek (kök adres hariç) erişim koduyla doğrulanır. Kod yanlışsa istek reddedilir,
//   8 yanlış denemeden sonra o IP 15 dakika kilitlenir. Böylece adresi bilen biri senin Claude/veri kotanı kullanamaz.
//
//   1) /proxy?url=...    -> CORS proxy (Yahoo, FRED, Google News, haber kurumlarının RSS yayınları)
//   2) /ai                -> Anthropic API geçidi (Bay Piyasa, haber çevirisi)
//   3) /extract-loan      -> Kredi ödeme planı PDF'ini okuyup JSON'a çevirir
//   4) /td, /td-series    -> Twelve Data geçidi (altın spot ons, döviz yedeği)
//   5) /fh                -> Finnhub geçidi (ABD hisse/ETF)
//   6) /data (GET), /data/:anahtar (PUT) -> Cloudflare D1'de saklanan veriler (cihazlar arası senkron)
//   7) /auth/check        -> erişim kodunu doğrular
//   8) /uranyum           -> uranyum (U3O8) güncel fiyatı (Yahoo'daki UX=F kontratı işlem görmediği için ayrı kaynak)
//
// KURULUM (Cloudflare panelinde, sırayla):
//   A) Storage & Databases > D1 SQL Database > Create  →  adı: finansal-takip
//   B) Bu Worker > Settings > Bindings > Add > D1 database  →  Variable name: DB  →  finansal-takip'i seç
//   C) Bu Worker > Settings > Variables and Secrets > Add (Type: Secret):
//        ACCESS_TOKEN       = kendi belirlediğin UZUN bir parola (en az 16 karakter) — giriş ekranındaki "Şifre"
//        LOGIN_USER         = giriş ekranındaki "E-posta veya kullanıcı adı"; virgülle birden fazla yazılabilir
//                             (ör. "ad@ornek.com,kullaniciadi"). Tanımlı değilse yalnızca şifre kontrol edilir.
//        ANTHROPIC_API_KEY  (console.anthropic.com)
//        TWELVEDATA_API_KEY (twelvedata.com)
//        FINNHUB_API_KEY    (finnhub.io)
//      (İsteğe bağlı) ALLOWED_ORIGIN = sitenin adresi; boş bırakılırsa https://ofusluoglu-hue.github.io kullanılır.
//   D) Bu kodu Worker düzenleyicisine yapıştır ve Deploy et. Tablolar ilk istekte kendiliğinden oluşur.
//   (Anahtarları ve parolayı ASLA bu kodun içine yazma.)
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

function corsBasliklari(request, env) {
  const izinli = ((env && env.ALLOWED_ORIGIN) || VARSAYILAN_ORIGIN).split(',').map(x => x.trim());
  const origin = request.headers.get('Origin');
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
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

async function sha256(metin) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(metin)));
}
async function esitMi(a, b) {                // sabit zamanlı karşılaştırma
  const x = await sha256(a), y = await sha256(b);
  let fark = 0;
  for (let i = 0; i < x.length; i++) fark |= x[i] ^ y[i];
  return fark === 0;
}

let _semaDb = null;   // tabloları hangi veritabanı bağlantısı için oluşturduk
async function semaHazirla(env) {
  if (!env.DB || _semaDb === env.DB) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS auth_fail (ip TEXT NOT NULL, ts INTEGER NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_auth_fail ON auth_fail (ip, ts)'),
  ]);
  _semaDb = env.DB;
}

// Erişim kodunu doğrular. Geçerliyse null, değilse hazır bir hata yanıtı döndürür.
async function yetkiKontrol(request, env, json) {
  if (!env.ACCESS_TOKEN) {
    return json({ error: 'Kurulum eksik: ACCESS_TOKEN secret\'ı tanımlı değil (Worker > Settings > Variables and Secrets)' }, 503);
  }
  const baslik = request.headers.get('Authorization') || '';
  const kod = baslik.startsWith('Bearer ') ? baslik.slice(7).trim() : '';
  if (!kod) return json({ error: 'giriş gerekli' }, 401);

  const ip = request.headers.get('CF-Connecting-IP') || 'bilinmiyor';
  if (env.DB) {
    await semaHazirla(env);
    const sonuc = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_fail WHERE ip = ? AND ts > ?')
      .bind(ip, Date.now() - KILIT_PENCERE_MS).first();
    if (sonuc && sonuc.n >= KILIT_ESIK) {
      return new Response(JSON.stringify({ error: 'çok fazla hatalı deneme — 15 dakika sonra tekrar dene' }), {
        status: 429,
        headers: { ...corsBasliklari(request, env), 'Content-Type': 'application/json', 'Retry-After': '900' },
      });
    }
  }
  if (await esitMi(kod, env.ACCESS_TOKEN.trim())) return null;

  if (env.DB) {
    await env.DB.prepare('INSERT INTO auth_fail (ip, ts) VALUES (?, ?)').bind(ip, Date.now()).run();
    await env.DB.prepare('DELETE FROM auth_fail WHERE ts < ?').bind(Date.now() - 24 * 3600 * 1000).run();
  }
  return json({ error: 'kullanıcı adı veya şifre hatalı' }, 401);   // hangisinin yanlış olduğu söylenmez
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
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

    // Tarayıcının ön kontrol (preflight) isteği
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Kök adres: sadece "çalışıyor" bilgisi (hiçbir ayrıntı vermez)
    if (url.pathname === '/') {
      return json({ ok: true });
    }

    // ---------- KİMLİK KAPISI: bundan sonraki her şey erişim kodu ister ----------
    const red = await yetkiKontrol(request, env, json);
    if (red) return red;

    // ---------- 0) GİRİŞ DOĞRULAMA (şifre yukarıda doğrulandı; burada e-posta / kullanıcı adı) ----------
    if (url.pathname === '/auth/check') {
      if (env.LOGIN_USER) {
        const izinli = env.LOGIN_USER.split(',').map(x => x.trim().toLocaleLowerCase('tr-TR')).filter(Boolean);
        const girilen = (request.headers.get('X-Kullanici') || '').trim().toLocaleLowerCase('tr-TR');
        let eslesti = false;
        for (const k of izinli) { if (await esitMi(girilen, k)) eslesti = true; }   // sabit zamanlı
        if (!eslesti) {
          // Hatalı kullanıcı adı da kilit sayacına işlenir; hangisinin yanlış olduğu söylenmez
          const ip = request.headers.get('CF-Connecting-IP') || 'bilinmiyor';
          if (env.DB) { await semaHazirla(env); await env.DB.prepare('INSERT INTO auth_fail (ip, ts) VALUES (?, ?)').bind(ip, Date.now()).run(); }
          return json({ error: 'kullanıcı adı veya şifre hatalı' }, 401);
        }
      }
      return json({ ok: true, d1: !!env.DB });
    }

    // ---------- 0c) URANYUM ----------
    if (url.pathname === '/uranyum') {
      try {
        return json(await uranyumGetir());
      } catch (e) {
        return json({ error: 'uranyum fiyatı alınamadı: ' + e.message }, 502);
      }
    }

    // ---------- 0b) VERİ (Cloudflare D1) ----------
    if (url.pathname === '/data' || url.pathname.startsWith('/data/')) {
      if (!env.DB) {
        return json({ error: 'D1 bağlı değil (Worker > Settings > Bindings > D1 database, değişken adı: DB)' }, 503);
      }
      await semaHazirla(env);

      if (url.pathname === '/data' && request.method === 'GET') {
        const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
        const { results } = await env.DB.prepare('SELECT key, value, updated_at FROM kv WHERE updated_at > ? ORDER BY updated_at').bind(since).all();
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

        const mevcut = await env.DB.prepare('SELECT value, updated_at FROM kv WHERE key = ?').bind(anahtar).first();
        // Başka bir cihaz bu anahtarı bizden sonra güncellemişse üzerine yazma; güncel halini döndür
        if (mevcut && govde.expected != null && mevcut.updated_at > Number(govde.expected)) {
          return json({ error: 'çakışma', current: { value: mevcut.value, updated_at: mevcut.updated_at } }, 409);
        }
        // Zaman damgası TÜM anahtarlar için kesinlikle artan olmalı: aksi halde aynı milisaniyede yazılan iki kayıttan biri,
        // "since" ile artımlı çekmede atlanabilir. Bu yüzden tek ve atomik bir SQL ifadesiyle max(şimdi, en yüksek+1) alınır.
        await env.DB.prepare(
          'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, MAX(?, COALESCE((SELECT MAX(updated_at) FROM kv), 0) + 1)) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
        ).bind(anahtar, govde.value, Date.now()).run();
        const kayit = await env.DB.prepare('SELECT updated_at FROM kv WHERE key = ?').bind(anahtar).first();
        return json({ ok: true, updated_at: kayit.updated_at });
      }

      return json({ error: 'desteklenmeyen istek' }, 405);
    }

    // ---------- 1) CORS PROXY ----------
    if (url.pathname === '/proxy') {
      const target = url.searchParams.get('url');
      if (!target) {
        return json({ error: 'url parametresi gerekli' }, 400);
      }

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
      try {
        targetHost = new URL(target).hostname;
      } catch {
        return json({ error: 'geçersiz url' }, 400);
      }
      if (!allowed.some(h => targetHost === h || targetHost.endsWith('.' + h))) {
        return json({ error: 'bu adrese izin yok' }, 403);
      }

      try {
        const upstream = await fetch(target, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; FinansTakip/1.0)',
            'Accept': '*/*',
          },
        });
        const body = await upstream.arrayBuffer();
        return new Response(body, {
          status: upstream.status,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': upstream.headers.get('Content-Type') || 'text/plain',
            'Cache-Control': 'no-store',
          },
        });
      } catch (e) {
        return json({ error: 'kaynak alınamadı: ' + e.message }, 502);
      }
    }

    // ---------- 2) AI GEÇİDİ ----------
    if (url.pathname === '/ai') {
      if (request.method !== 'POST') {
        return json({ error: 'POST bekleniyor' }, 405);
      }
      if (!env.ANTHROPIC_API_KEY) {
        return json({ error: 'ANTHROPIC_API_KEY tanımlı değil (Worker > Settings > Variables and Secrets)' }, 500);
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: 'geçersiz JSON' }, 400);
      }

      const ALLOWED_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1'];
      const model = ALLOWED_MODELS.includes(payload.model) ? payload.model : 'claude-sonnet-5';

      // Cevap uzunluğu istemciden gelir (en fazla 4000). Web araması ARAMA BAŞINA $0,01 ücretlidir,
      // bu yüzden varsayılan KAPALI — sadece istemci webSearch:true gönderirse aracı ekleriz.
      const maxTokens = Math.min(Math.max(parseInt(payload.max_tokens, 10) || 2500, 200), 4000);
      const body = {
        model,
        max_tokens: maxTokens,
        system: payload.system || '',
        messages: payload.messages || [],
      };
      if (payload.webSearch === true) {
        body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
      }

      try {
        const upstream = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        });

        const data = await upstream.json();
        return json(data, upstream.status);
      } catch (e) {
        return json({ error: 'AI isteği başarısız: ' + e.message }, 502);
      }
    }

    // ---------- 3) KREDİ ÖDEME PLANI ÇIKARMA ----------
    if (url.pathname === '/extract-loan') {
      if (request.method !== 'POST') {
        return json({ error: 'POST bekleniyor' }, 405);
      }
      if (!env.ANTHROPIC_API_KEY) {
        return json({ error: 'ANTHROPIC_API_KEY tanımlı değil (Worker > Settings > Variables and Secrets)' }, 500);
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: 'geçersiz JSON' }, 400);
      }

      if (!payload.pdfBase64) {
        return json({ error: 'pdfBase64 alanı gerekli' }, 400);
      }

      try {
        const upstream = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-5',
            max_tokens: 4000,
            system: LOAN_EXTRACT_SYSTEM_PROMPT,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: {
                    type: 'base64',
                    media_type: payload.mediaType || 'application/pdf',
                    data: payload.pdfBase64,
                  },
                },
                { type: 'text', text: 'Bu kredi ödeme planını yukarıdaki JSON şemasına göre çıkar.' },
              ],
            }],
          }),
        });

        const data = await upstream.json();
        if (!upstream.ok) {
          return json({ error: 'Anthropic API hatası', detail: data }, upstream.status);
        }

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

    // ---------- 4) TWELVE DATA GEÇİDİ ----------
    if (url.pathname === '/td') {
      const symbol = url.searchParams.get('symbol');
      if (!symbol) {
        return json({ error: 'symbol parametresi gerekli' }, 400);
      }
      if (!env.TWELVEDATA_API_KEY) {
        return json({ error: 'TWELVEDATA_API_KEY tanımlı değil (Worker > Settings > Variables and Secrets)' }, 500);
      }

      try {
        const tdUrl = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${env.TWELVEDATA_API_KEY}`;
        const upstream = await fetch(tdUrl);
        const data = await upstream.json();
        return json(data, upstream.status);
      } catch (e) {
        return json({ error: 'Twelve Data isteği başarısız: ' + e.message }, 502);
      }
    }

    // ---------- 4b) TWELVE DATA GEÇMİŞ VERİ (grafik) ----------
    if (url.pathname === '/td-series') {
      const symbol = url.searchParams.get('symbol');
      const interval = url.searchParams.get('interval') || '1day';
      const outputsize = url.searchParams.get('outputsize') || '30';
      if (!symbol) {
        return json({ error: 'symbol parametresi gerekli' }, 400);
      }
      if (!env.TWELVEDATA_API_KEY) {
        return json({ error: 'TWELVEDATA_API_KEY tanımlı değil (Worker > Settings > Variables and Secrets)' }, 500);
      }

      try {
        const tdUrl = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&outputsize=${encodeURIComponent(outputsize)}&apikey=${env.TWELVEDATA_API_KEY}`;
        const upstream = await fetch(tdUrl);
        const data = await upstream.json();
        return json(data, upstream.status);
      } catch (e) {
        return json({ error: 'Twelve Data geçmiş isteği başarısız: ' + e.message }, 502);
      }
    }

    // ---------- 5) FINNHUB GEÇİDİ (ABD hisse/ETF — günlük tavan yok, dakikada 60 istek) ----------
    if (url.pathname === '/fh') {
      const symbol = url.searchParams.get('symbol');
      if (!symbol) {
        return json({ error: 'symbol parametresi gerekli' }, 400);
      }
      if (!env.FINNHUB_API_KEY) {
        return json({ error: 'FINNHUB_API_KEY tanımlı değil (Worker > Settings > Variables and Secrets)' }, 500);
      }

      try {
        const fhUrl = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${env.FINNHUB_API_KEY}`;
        const upstream = await fetch(fhUrl);
        const data = await upstream.json();
        return json(data, upstream.status);
      } catch (e) {
        return json({ error: 'Finnhub isteği başarısız: ' + e.message }, 502);
      }
    }

    // ---------- Bilinmeyen yol ----------
    return json({ error: 'bulunamadı' }, 404);
  },
};
