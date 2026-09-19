import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({ ignoreAttributes: false });

const TIMELINE_KEY = 'timeline';
const SHOW_MS = 24 * 60 * 60 * 1000;   // display window
const KEEP_MS = 48 * 60 * 60 * 1000;   // storage window
const MAX_PER_FEED = 60;

const UA = 'Mozilla/5.0 (compatible; feedpeek/1.0)';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshFeeds(env).catch(e => console.error('scheduled refresh failed:', e)));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*' };

    if (url.pathname === '/api/items') {
      try {
        return Response.json(await getRecent(env), { headers: cors });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500, headers: cors });
      }
    }

    if (url.pathname === '/api/debug') {
      const store = await readStore(env);
      const feeds = await loadFeeds(env).then(
        f => f.map(x => ({ name: x.name, url: x.url })),
        e => 'ERROR: ' + e.message
      );
      return Response.json({
        now: Date.now(),
        nowIso: new Date().toISOString(),
        updated: store.updated,
        items: store.items.length,
        errors: store.errors,
        feeds,
      }, { headers: cors });
    }

    if (url.pathname === '/refresh') {
      const token = url.searchParams.get('token') ?? request.headers.get('x-refresh-token');
      if (!env.REFRESH_TOKEN || token !== env.REFRESH_TOKEN) {
        return new Response('Forbidden', { status: 403 });
      }
      try {
        const summary = await refreshFeeds(env);
        return Response.json({ ok: true, ...summary });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  },
};

// ---------- storage ----------

async function readStore(env) {
  const v = await env.RSS_KV.get(TIMELINE_KEY, 'json');
  if (Array.isArray(v)) return { updated: 0, items: v, errors: [] };  // legacy format
  return { updated: 0, items: [], errors: [], ...(v || {}) };
}

async function getRecent(env) {
  const store = await readStore(env);
  const cutoff = Date.now() - SHOW_MS;
  return {
    updated: store.updated,
    errors: store.errors,
    items: store.items.filter(i => i.pubDate >= cutoff),
  };
}

// ---------- refresh ----------

async function refreshFeeds(env) {
  const feeds = await loadFeeds(env);
  const store = await readStore(env);
  const seen = new Set(store.items.map(i => i.id));
  const errors = [];

  const results = await Promise.allSettled(feeds.map(async (feed) => {
    const res = await fetch(feed.url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await decodeBody(res);
    if (!xml || xml.length < 32) throw new Error('empty response');
    const parsed = parser.parse(xml);
    const raw = extractItems(parsed);
    return raw.slice(0, MAX_PER_FEED).map((it) => ({
      id: pickId(it, feed),
      title: decodeEntities(it.title) || '(untitled)',
      link: it.link || '',
      image: absolutize(extractImage(it), feed.url),
      pubDate: parseDate(it.pubDate),
      feed: feed.name,
      category: feed.category,
    }));
  }));

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      console.log(`[${feeds[i].name}] ok, ${r.value.length} items`);
      return;
    }
    const msg = String(r.reason?.message || r.reason).slice(0, 160);
    errors.push({ feed: feeds[i].name, error: msg });
    console.error(`[${feeds[i].name}] ${msg}`);
  });

  const fresh = [];
  const now = Date.now();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      if (!item.id || !item.link) continue;
      if (item.pubDate < now - KEEP_MS) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      fresh.push(item);
    }
  }

  const items = [...fresh, ...store.items]
    .filter(i => i.pubDate >= now - KEEP_MS)
    .sort((a, b) => b.pubDate - a.pubDate);

  await env.RSS_KV.put(TIMELINE_KEY, JSON.stringify({
    updated: now,
    items,
    errors,
  }));

  return { feeds: feeds.length, fetched: fresh.length, total: items.length, errors: errors.length };
}

// ---------- feeds.txt ----------

async function loadFeeds(env) {
  let text;
  if (env.FEEDS_URL) {
    const r = await fetch(env.FEEDS_URL, { cf: { cacheTtl: 0 } });
    if (!r.ok) throw new Error(`FEEDS_URL → HTTP ${r.status}`);
    text = await r.text();
  } else {
    if (!env.ASSETS) throw new Error('no FEEDS_URL and no ASSETS binding');
    const r = await env.ASSETS.fetch(new URL('/feeds.txt', 'https://assets.internal'));
    if (!r.ok) throw new Error(`ASSETS /feeds.txt → HTTP ${r.status}`);
    text = await r.text();
  }

  if (/^\s*</.test(text)) throw new Error('feeds source returned HTML, not a feed list');

  const feeds = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const p = line.split('|').map(s => s.trim());
    try {
      if (p.length >= 3)       feeds.push({ category: slug(p[0]), name: p[1], url: p.slice(2).join('|') });
      else if (p.length === 2) feeds.push({ category: slug(p[0]), name: host(p[1]), url: p[1] });
      else                     feeds.push({ category: 'general',   name: host(p[0]), url: p[0] });
    } catch (e) {
      console.error('bad feed line:', line, e.message);
    }
  }

  if (feeds.length === 0) throw new Error('feeds list parsed to zero entries');
  return feeds;
}

// ---------- rss / atom ----------

function toArray(x) { return Array.isArray(x) ? x : (x == null ? [] : [x]); }

function extractItems(parsed) {
  // RSS 2.0
  const channel = parsed?.rss?.channel;
  if (channel?.item) {
    return toArray(channel.item).map((i) => ({
      title: txt(i.title),
      link: linkOf(i.link),
      pubDate: txt(i.pubDate) || txt(i['dc:date']) || txt(i.date),
      guid: txt(i.guid) || txt(i['dc:identifier']),
      content: txt(i['content:encoded']) || txt(i.description),
      enclosure: i.enclosure,
      mediaThumbnail: i['media:thumbnail'],
      mediaContent: i['media:content'],
    }));
  }

  // Atom
  const feed = parsed?.feed;
  if (feed?.entry) {
    return toArray(feed.entry).map((e) => {
      const links = toArray(e.link);
      const alt = links.find(l => l?.['@_rel'] === 'alternate')
               || links.find(l => l?.['@_href'])
               || links[0];
      return {
        title: txt(e.title),
        link: alt?.['@_href'] || txt(e.id),
        pubDate: txt(e.published) || txt(e.updated),
        guid: txt(e.id),
        content: txt(e.content) || txt(e.summary),
        mediaThumbnail: e['media:thumbnail'],
        mediaContent: e['media:content'],
      };
    });
  }

  // RSS 1.0 / RDF
  const rdf = parsed?.['rdf:RDF'];
  if (rdf?.item) {
    return toArray(rdf.item).map((i) => ({
      title: txt(i.title),
      link: linkOf(i.link),
      pubDate: txt(i['dc:date']),
      guid: txt(i['dc:identifier']) || linkOf(i.link),
      content: txt(i['content:encoded']) || txt(i.description),
    }));
  }

  return [];
}

function linkOf(v) {
  if (v == null) return '';
  if (Array.isArray(v)) {
    const preferred = v.find(x => x?.['@_rel'] == null || x?.['@_rel'] === 'alternate');
    return txt(preferred ?? v[0]);
  }
  return txt(v);
}

function extractImage(i) {
  let u = attrUrl(i.mediaThumbnail) || attrUrl(i.mediaContent);
  if (!u) {
    const enc = toArray(i.enclosure).find(e =>
      String(e?.['@_type'] || '').startsWith('image/') && e?.['@_url']);
    if (enc) u = enc['@_url'];
  }
  if (!u) {
    const html = i.content || '';
    u = html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] || '';
  }
  return u;
}

function attrUrl(v) {
  for (const m of toArray(v)) if (m?.['@_url']) return m['@_url'];
  return '';
}

function txt(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === 'object') {
    if (v['#text'] != null) return String(v['#text']).trim();
    if (v._ != null) return String(v._).trim();
    return '';
  }
  return String(v).trim();
}

function pickId(it, feed) {
  const g = (it.guid || '').trim();
  const l = (it.link || '').trim();
  const t = (it.title || '').trim();
  return g || l || (t ? `${feed?.name || ''}:${t}` : '');
}

// ---------- utils ----------

const parseDate = (s) => {
  if (!s) return Date.now();
  const t = Date.parse(s);
  return Number.isNaN(t) ? Date.now() : t;
};
const absolutize = (u, base) => { if (!u) return ''; try { return new URL(u, base).href; } catch { return ''; } };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { throw new Error(`bad url: ${u}`); } };
const decodeEntities = (s) => {
  if (!s) return '';
  if (!s.includes('&')) return s;
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };
  return s
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return _; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return _; } })
    .replace(/&([a-z]+);/gi, (m, e) => named[e.toLowerCase()] ?? m);
};

// ---------- encoding ----------

async function decodeBody(res) {
  const buf = await res.arrayBuffer();
  const head = new TextDecoder('utf-8').decode(buf.slice(0, 400));
  let enc = res.headers.get('content-type')?.match(/charset=["']?([\w-]+)/i)?.[1]
         || head.match(/<\?xml[^>]*encoding=["']([\w-]+)["']/i)?.[1]
         || head.match(/<meta[^>]*charset=["']?([\w-]+)/i)?.[1]
         || 'utf-8';
  enc = enc.trim().toLowerCase();
  try {
    return new TextDecoder(enc, { fatal: false }).decode(buf);
  } catch {
    try { return new TextDecoder('windows-1251').decode(buf); }
    catch { return new TextDecoder('utf-8').decode(buf); }
  }
}