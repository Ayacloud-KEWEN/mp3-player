// 播客订阅（电脑版工具）：解析 Apple Podcasts 链接或 RSS，下载节目到 PODCAST_DIR/<节目名>/
// 订阅信息保存在 PODCAST_DIR/.subscriptions.json
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const UA = 'Mozilla/5.0 (Lyra podcast)';

module.exports = function createPodcasts({ dir }) {
  const subsFile = path.join(dir, '.subscriptions.json');
  let subs = load();

  function load() {
    try { return JSON.parse(fs.readFileSync(subsFile, 'utf8')); } catch { return []; }
  }
  function save() {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(subsFile + '.part', JSON.stringify(subs, null, 1));
    fs.renameSync(subsFile + '.part', subsFile);
  }

  const safeName = s => String(s).replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 90) || 'podcast';
  const decode = s => String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
  const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1]) : ''; };

  async function get(url) {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status} : ${url}`);
    return r;
  }

  // Apple Podcasts 链接 → RSS 地址；其他链接视为 RSS
  async function resolveFeed(input) {
    const url = String(input || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('Lien invalide');
    const id = url.includes('podcasts.apple.com') && url.match(/\/id(\d+)/)?.[1];
    if (!id) return url;
    try {
      const j = await (await get(`https://itunes.apple.com/lookup?id=${id}&entity=podcast`)).json();
      const f = j.results?.find(r => r.feedUrl)?.feedUrl;
      if (f) return f;
    } catch {}
    const html = await (await get(url)).text();
    const f = html.match(/"feedUrl":"([^"]+)"/)?.[1];
    if (!f) throw new Error('Flux RSS introuvable pour ce podcast');
    return f.replace(/\\u002F/gi, '/');
  }

  async function fetchFeed(feedUrl) {
    const xml = await (await get(feedUrl)).text();
    const channel = xml.split(/<item[\s>]/i)[0];
    const items = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map(m => {
      const it = m[0];
      const enc = it.match(/<enclosure[^>]*url="([^"]+)"[^>]*>/i);
      const len = it.match(/<enclosure[^>]*length="(\d+)"/i);
      const date = new Date(tag(it, 'pubDate'));
      return {
        guid: tag(it, 'guid') || enc?.[1],
        title: tag(it, 'title'),
        url: enc ? decode(enc[1]) : null,
        size: len ? +len[1] : 0,
        date: isNaN(date) ? null : date.toISOString().slice(0, 10),
        duration: tag(it, 'itunes:duration'),
      };
    }).filter(e => e.url);
    return { title: tag(channel, 'title') || 'Podcast', items };
  }

  const subDir = s => path.join(dir, s.folder);
  const fileFor = (s, ep) => {
    const ext = (path.extname(new URL(ep.url).pathname) || '.mp3').toLowerCase().slice(0, 5);
    return `${ep.date || 'sans-date'} - ${safeName(ep.title)}${ext}`;
  };
  const isDownloaded = (s, ep) => !!s.files?.[ep.guid] && fs.existsSync(path.join(subDir(s), s.files[ep.guid]));

  async function download(s, ep, log) {
    const name = fileFor(s, ep), dst = path.join(subDir(s), name), tmp = dst + '.part';
    fs.mkdirSync(subDir(s), { recursive: true });
    log(`↓ ${name}`);
    const r = await get(ep.url);
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
    fs.renameSync(tmp, dst);
    s.files = { ...s.files, [ep.guid]: name };
    save();
  }

  return {
    list: () => subs.map(s => ({ id: s.id, title: s.title, folder: s.folder, feedUrl: s.feedUrl,
      count: Object.values(s.files || {}).filter(f => fs.existsSync(path.join(subDir(s), f))).length })),

    // 订阅：返回订阅信息；初次下载由调用方排队
    async subscribe(input) {
      const feedUrl = await resolveFeed(input);
      const old = subs.find(s => s.feedUrl === feedUrl);
      if (old) return old;
      const feed = await fetchFeed(feedUrl);
      const s = { id: crypto.randomBytes(4).toString('hex'), title: feed.title, feedUrl, folder: safeName(feed.title), files: {}, added: Date.now() };
      subs.push(s); save();
      return s;
    },
    unsubscribe(id) { subs = subs.filter(s => s.id !== id); save(); },   // 已下载的文件保留

    async episodes(id, limit = 30) {
      const s = subs.find(x => x.id === id);
      if (!s) throw new Error('Abonnement introuvable');
      const feed = await fetchFeed(s.feedUrl);
      return feed.items.slice(0, limit).map(ep => ({ ...ep, downloaded: isDownloaded(s, ep) }));
    },

    // 下载任务：guids 为空时下载最新 n 期中尚未下载的
    async run(id, { guids, latest = 5 }, log, cancelled = () => false) {
      const s = subs.find(x => x.id === id);
      if (!s) throw new Error('Abonnement introuvable');
      log(`Lecture du flux : ${s.title}`);
      const feed = await fetchFeed(s.feedUrl);
      const pick = guids?.length ? feed.items.filter(e => guids.includes(e.guid)) : feed.items.slice(0, latest);
      const todo = pick.filter(e => !isDownloaded(s, e));
      if (!todo.length) return log('Rien de nouveau à télécharger');
      for (let i = 0; i < todo.length; i++) {
        if (cancelled()) return log("Annulé");
        log(`[${i + 1}/${todo.length}]`);
        await download(s, todo[i], log);
      }
      log(`Terminé : ${todo.length} épisode(s) téléchargé(s)`);
    },
  };
};
