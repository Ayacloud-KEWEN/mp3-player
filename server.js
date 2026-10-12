// Lyra 音频播放器 —— 零依赖 Node.js 服务（适合树莓派）
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------- 读取 .env ----------
function parseEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
function loadEnv(file) {
  for (const [k, v] of Object.entries(parseEnv(file))) if (!(k in process.env)) process.env[k] = v;
}
// DeepSeek 设置每次从 .env 重新读取：填好密钥后无需重启服务
function aiEnv() {
  const e = parseEnv(path.join(__dirname, '.env'));
  const out = {};
  for (const k of ['DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'DEEPSEEK_VISION_MODEL', 'DEEPSEEK_BASE_URL'])
    { const v = (e[k] ?? process.env[k] ?? '').trim(); if (v) out[k] = v; }   // 空值不传，交给默认值
  return out;
}
const aiReady = () => !!aiEnv().DEEPSEEK_API_KEY;
loadEnv(path.join(__dirname, '.env'));

const PORT = parseInt(process.env.PORT || '10020', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MEDIA_DIR = path.resolve(__dirname, process.env.MEDIA_DIR || './media');
const PUBLIC_DIR = path.join(__dirname, 'public');
// 电脑版工具（生成字幕 / 翻译）：需在 .env 中设置 ENABLE_TOOLS=1，默认只允许本机访问
const TOOLS = process.env.ENABLE_TOOLS === '1';
const TOOLS_LAN = process.env.TOOLS_ALLOW_LAN === '1';
const TOOLS_DIR = path.join(__dirname, 'tools');
const noAnsi = t => String(t).replace(/\x1b\[[0-9;]*m/g, '');
const PYTHON = process.env.PYTHON || path.join(TOOLS_DIR, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac', '.webm']);
const SUB_EXT = ['.srt', '.vtt', '.lrc'];
const MIME = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.webm': 'audio/webm', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.srt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8', '.lrc': 'text/plain; charset=utf-8',
};

// 播客订阅（电脑版工具）
const podcasts = require('./podcasts')({ dir: path.resolve(MEDIA_DIR, process.env.PODCAST_DIR || 'fra/podcasts') });

// 日常句子（Piper 合成）
const phrases = require('./phrases')({
  mediaDir: MEDIA_DIR, python: PYTHON, toolsDir: TOOLS_DIR,
  voice: process.env.PIPER_VOICE || 'fr_FR-tom-medium',
  speaker: process.env.PIPER_SPEAKER ? parseInt(process.env.PIPER_SPEAKER, 10) : null,
  // 其他语言的查词朗读声音
  voices: { en: { voice: process.env.PIPER_VOICE_EN || 'en_GB-alan-medium' } },
});

const collator = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' });

// 安全地把相对路径解析到根目录下，防止 ../ 越权
function safeJoin(root, rel) {
  const p = path.resolve(root, '.' + path.sep + rel);
  if (p !== root && !p.startsWith(root + path.sep)) return null;
  return p;
}

function listPlaylists() {
  if (!fs.existsSync(MEDIA_DIR)) return [];
  const result = [];
  (function walk(rel, depth) {
    let entries;
    try { entries = fs.readdirSync(path.join(MEDIA_DIR, rel), { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      const name = rel ? rel + '/' + d.name : d.name;
      const tracks = listTracks(name);
      if (tracks.length) result.push({ name, count: tracks.length });
      if (depth < 4) walk(name, depth + 1);
    }
  })('', 1);
  return result.sort((a, b) => collator.compare(a.name, b.name)).concat(phrases.playlists());
}

function listTracks(dir) {
  if (dir.startsWith(phrases.PREFIX)) return phrases.tracks(dir) || [];
  const full = safeJoin(MEDIA_DIR, dir);
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isDirectory()) return [];
  const files = fs.readdirSync(full);
  const lower = new Map(files.map(f => [f.toLowerCase(), f]));
  return files
    .filter(f => AUDIO_EXT.has(path.extname(f).toLowerCase()))
    .sort(collator.compare)
    .map(f => {
      const base = f.slice(0, -path.extname(f).length);
      let sub = null;
      for (const ext of SUB_EXT) {
        const hit = lower.get((base + ext).toLowerCase());
        if (hit) { sub = dir + '/' + hit; break; }
      }
      // 译文字幕：<名>.<语言>.srt，如 lesson01.fr.srt
      const tr = {};
      for (const name of files) {
        const m = name.match(/^(.*)\.([a-z]{2})\.(srt|vtt|lrc)$/i);
        if (m && m[1].toLowerCase() === base.toLowerCase()) tr[m[2].toLowerCase()] = dir + '/' + name;
      }
      // 逐词时间：<名>.words.json（由 gen_subs.py 生成）
      const wj = lower.get((base + '.words.json').toLowerCase());
      return { title: base, file: dir + '/' + f, sub, tr, words: wj ? dir + '/' + wj : null };
    });
}

function sendJSON(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(body);
}

function sendFile(req, res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache };
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      let start = m && m[1] ? parseInt(m[1], 10) : NaN;
      let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start)) { start = st.size - end; end = st.size - 1; } // bytes=-N
      if (!m || start < 0 || start >= st.size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      end = Math.min(end, st.size - 1);
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    }
  });
}

// ---------- 后台任务队列（一次只跑一个，GPU 独占）----------
const LANGS = new Set(['en', 'fr', 'zh', 'de', 'es', 'it', 'ja', 'ru']);
const jobs = [];
let jobSeq = 0;

function toolsAllowed(req) {
  if (!TOOLS) return false;
  const ip = req.socket.remoteAddress || '';
  return TOOLS_LAN || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function addJob(body) {
  const dir = String(body.dir || '');
  if (!listPlaylists().some(p => p.name === dir && !p.phrases)) throw new Error('Liste introuvable');
  const folder = safeJoin(MEDIA_DIR, dir);
  let args, label;
  if (body.kind === 'subs') {
    args = ['gen_subs.py', folder];
    if (LANGS.has(body.lang)) args.push('--lang', body.lang);
    label = `Sous-titres · ${dir}${body.lang ? ' (' + body.lang + ')' : ''}`;
  } else if (body.kind === 'translate') {
    if (!LANGS.has(body.src) || !LANGS.has(body.tgt) || body.src === body.tgt) throw new Error('Langues invalides');
    args = ['translate_subs.py', folder, '--src', body.src, '--tgt', body.tgt];
    label = `Traduction ${body.src.toUpperCase()} → ${body.tgt.toUpperCase()} · ${dir}`;
  } else throw new Error('Tâche inconnue');
  if (body.force) args.push('--force');
  const job = { id: ++jobSeq, label, dir, args, status: 'queued', log: [], progress: '', created: Date.now() };
  jobs.push(job);
  while (jobs.length > 20 && jobs[0].status !== 'running' && jobs[0].status !== 'queued') jobs.shift();
  runNext();
  return job;
}

function runFn(job) {
  job.status = 'running';
  job.started = Date.now();
  const log = l => {
    job.log.push(l); if (job.log.length > 200) job.log.shift();
    const m = l.match(/^\[(\d+)\/(\d+)\]/); if (m) job.progress = `${m[1]}/${m[2]}`;
  };
  job.fn(log, () => job.status === 'cancelled')
    .then(() => { if (job.status !== 'cancelled') job.status = 'done'; })
    .catch(e => { log(e.message); if (job.status !== 'cancelled') job.status = 'failed'; })
    .finally(() => { job.ended = Date.now(); runNext(); });
}

function queueFn(label, dir, fn) {
  const job = { id: ++jobSeq, label, dir, fn, status: 'queued', log: [], progress: '', created: Date.now() };
  jobs.push(job);
  while (jobs.length > 20 && jobs[0].status !== 'running' && jobs[0].status !== 'queued') jobs.shift();
  runNext();
  return job;
}

function runNext() {
  if (jobs.some(j => j.status === 'running')) return;
  const job = jobs.find(j => j.status === 'queued');
  if (!job) return;
  if (job.fn) return runFn(job);
  if (!fs.existsSync(PYTHON)) { job.status = 'failed'; job.log.push('Environnement Python introuvable : ' + PYTHON + ' (lancez tools/setup.bat)'); return runNext(); }
  job.status = 'running';
  job.started = Date.now();
  const p = spawn(PYTHON, ['-u', ...job.args], { cwd: TOOLS_DIR, env: { ...process.env, ...aiEnv(), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  job.proc = p;
  let buf = '';
  const onData = d => {
    buf += d.toString('utf8');
    const lines = buf.split(/\r?\n|\r/); buf = lines.pop();
    for (const l of lines) {
      if (!l.trim() || /warn/i.test(l)) continue;
      job.log.push(noAnsi(l));
      if (job.log.length > 200) job.log.shift();
      const m = l.match(/^\[(\d+)\/(\d+)\]/); if (m) job.progress = `${m[1]}/${m[2]}`;
    }
  };
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  p.on('close', code => {
    delete job.proc;
    job.ended = Date.now();
    if (job.status !== 'cancelled') job.status = code === 0 ? 'done' : 'failed';
    runNext();
  });
}

const jobView = j => ({ id: j.id, label: j.label, dir: j.dir, status: j.status, progress: j.progress,
  last: j.log.slice(-3), started: j.started, ended: j.ended });

function readBody(req, limit = 4e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { chunks.push(c); n += c.length; if (n > limit) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
  });
}

// ---------- 双语阅读（电脑版）：文档库在 MEDIA_DIR/.library/<id>/ ----------
const LIB_DIR = path.join(MEDIA_DIR, '.library');
const VOICES = {
  fr: { voice: process.env.PIPER_VOICE || 'fr_FR-tom-medium', speaker: process.env.PIPER_SPEAKER || null },
  en: { voice: process.env.PIPER_VOICE_EN || 'en_GB-alan-medium', speaker: null },
};
const libDoc = id => /^[0-9a-f]{10}$/.test(id) ? path.join(LIB_DIR, id) : null;
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const exportName = t => String(t).replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').trim().replace(/\.+$/, '').slice(0, 80) || 'texte';

function queuePy(label, dir, args) {
  const job = { id: ++jobSeq, label, dir, args, status: 'queued', log: [], progress: '', created: Date.now() };
  jobs.push(job);
  runNext();
  return job;
}
function libStatus(id) {
  const j = [...jobs].reverse().find(x => x.lib === id);
  return j ? { status: j.status, progress: j.progress, kind: j.libKind, last: j.log.slice(-1)[0] || '' } : null;
}
function libList() {
  if (!fs.existsSync(LIB_DIR)) return [];
  return fs.readdirSync(LIB_DIR).filter(id => libDoc(id) && fs.existsSync(path.join(LIB_DIR, id, 'meta.json')))
    .map(id => ({ id, ...readJSON(path.join(LIB_DIR, id, 'meta.json'), {}), ready: fs.existsSync(path.join(LIB_DIR, id, 'doc.json')), job: libStatus(id) }))
    .sort((a, b) => b.created - a.created);
}
const engineOf = e => (e === 'local' || !aiReady()) ? 'local' : 'ai';
function libBuild(id, engine) {
  const job = queuePy(`Lecture · ${readJSON(path.join(LIB_DIR, id, 'meta.json'), {}).title}`, null, ['library.py', 'build', libDoc(id), '--engine', engineOf(engine)]);
  Object.assign(job, { lib: id, libKind: 'build' });
}

// ---------- 收件箱 books/：一个文件或一个子文件夹 = 一篇文章 ----------
const BOOKS_DIR = path.resolve(MEDIA_DIR, process.env.BOOKS_DIR || 'books');
const BOOKS_DONE = path.join(BOOKS_DIR, '_traité');
const INBOX_EXT = /\.(jpe?g|png|webp|bmp|tiff?|heic|pdf|txt|md)$/i;
function booksPending() {
  if (!fs.existsSync(BOOKS_DIR)) return [];
  const busy = new Set(jobs.filter(j => j.inbox && (j.status === 'queued' || j.status === 'running')).map(j => j.inbox));
  return fs.readdirSync(BOOKS_DIR, { withFileTypes: true })
    .filter(d => !d.name.startsWith('.') && !d.name.startsWith('_') && (d.isDirectory()
      ? fs.readdirSync(path.join(BOOKS_DIR, d.name)).some(f => INBOX_EXT.test(f)) : INBOX_EXT.test(d.name)))
    .map(d => ({ name: d.name, dir: d.isDirectory(), busy: busy.has(path.join(BOOKS_DIR, d.name)) }))
    .sort((a, b) => collator.compare(a.name, b.name));
}
function booksProcess(engine) {
  const todo = booksPending().filter(x => !x.busy);
  for (const it of todo) {
    const id = require('crypto').randomBytes(5).toString('hex'), dir = libDoc(id), item = path.join(BOOKS_DIR, it.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ title: it.name.replace(/\.[^.]+$/, ''), lang: 'en', created: Date.now(), source: 'books/' + it.name }));
    const job = queuePy(`Boîte · ${it.name}`, null, ['library.py', 'ingest', dir, item, '--done', BOOKS_DONE, '--engine', engineOf(engine)]);
    Object.assign(job, { lib: id, libKind: 'build', inbox: item });
  }
  return todo.length;
}

async function handleLibrary(req, res, pathname) {
  // 只读（文章列表、单篇文章）对所有设备开放，例如在树莓派上用 MacBook 阅读；
  // 新建、识别、翻译、删除、导出等仍只限开启了工具的电脑本机
  const readOnly = req.method === 'GET' && (pathname === '/api/library' || /^\/api\/library\/[0-9a-f]{10}$/.test(pathname));
  if (!readOnly && !toolsAllowed(req)) { res.writeHead(403); return res.end('tools disabled'); }
  try {
    if (pathname === '/api/library' && req.method === 'GET') return sendJSON(res, libList());
    if (pathname === '/api/ai' && req.method === 'GET') {
      const c = readJSON(path.join(TOOLS_DIR, 'models', 'deepseek.json'), null), k = aiEnv().DEEPSEEK_API_KEY;
      return sendJSON(res, { configured: !!k, models: c && k && c.key_tail === k.slice(-4) ? { text: c.text, vision: c.vision } : null });
    }
    if (pathname === '/api/ai/check' && req.method === 'POST') {
      if (!aiReady()) throw new Error('DEEPSEEK_API_KEY manquant dans .env');
      const out = await new Promise((resolve, reject) => {
        const p = spawn(PYTHON, ['-u', 'deepseek.py', '--refresh'], { cwd: TOOLS_DIR, env: { ...process.env, ...aiEnv(), PYTHONIOENCODING: 'utf-8' } });
        let o = '', e = '';
        p.stdout.on('data', d => o += d); p.stderr.on('data', d => { e += d; if (e.length > 4000) e = e.slice(-4000); });
        p.on('close', c => c === 0 ? resolve(o) : reject(new Error(noAnsi(e.split('\n').filter(Boolean).slice(-1)[0] || 'échec'))));
      });
      const c = JSON.parse(out);
      return sendJSON(res, { configured: true, models: { text: c.text, vision: c.vision }, all: c.all });
    }
    if (pathname === '/api/books' && req.method === 'GET') return sendJSON(res, { dir: path.relative(MEDIA_DIR, BOOKS_DIR) || BOOKS_DIR, items: booksPending(), ai: aiReady() });
    if (pathname === '/api/books/process' && req.method === 'POST') return sendJSON(res, { queued: booksProcess((await readBody(req)).engine) });
    if (pathname === '/api/library' && req.method === 'POST') {
      const b = await readBody(req);
      const text = String(b.text || '').trim();
      if (!text) throw new Error('Texte vide');
      if (text.length > 200000) throw new Error('Texte trop long (200 000 caractères max.)');
      const lang = b.lang === 'fr' ? 'fr' : 'en';
      const id = require('crypto').randomBytes(5).toString('hex'), dir = libDoc(id);
      const title = String(b.title || '').trim().slice(0, 120) || text.split('\n')[0].slice(0, 60);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'source.txt'), text);
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ title, lang, created: Date.now() }));
      libBuild(id, b.engine);
      return sendJSON(res, { id });
    }
    if (pathname === '/api/ocr' && req.method === 'POST') {
      const { images, engine } = await readBody(req, 40e6);
      if (!Array.isArray(images) || !images.length) throw new Error('Aucune image');
      const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lyra-ocr-'));
      try {
        const files = images.slice(0, 10).map((d, i) => {
          const m = String(d).match(/^data:(?:image\/(png|jpe?g|webp)|application\/(pdf));base64,(.+)$/);
          if (!m) throw new Error('Format d’image non pris en charge');
          const ext = m[2] || (m[1] === 'jpeg' ? 'jpg' : m[1]);
          const f = path.join(tmp, `${i}.${ext}`);
          fs.writeFileSync(f, Buffer.from(m[3], 'base64'));
          return f;
        });
        const out = await new Promise((resolve, reject) => {
          const p = spawn(PYTHON, ['-u', 'library.py', 'ocr', ...files, '--engine', engineOf(engine)], { cwd: TOOLS_DIR, env: { ...process.env, ...aiEnv(), PYTHONIOENCODING: 'utf-8' } });
          let o = '', e = '';
          p.stdout.on('data', d => o += d); p.stderr.on('data', d => { e += d; if (e.length > 4000) e = e.slice(-4000); });
          p.on('error', reject);
          p.on('close', c => c === 0 ? resolve(o) : reject(new Error(noAnsi(e.split('\n').filter(Boolean).slice(-1)[0] || 'OCR échoué'))));
        });
        return sendJSON(res, JSON.parse(out.trim().split('\n').pop()));
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
    const m = pathname.match(/^\/api\/library\/([0-9a-f]{10})(?:\/(export|rebuild|meta))?$/);
    const dir = m && libDoc(m[1]);
    if (!dir || !fs.existsSync(dir)) { res.writeHead(404); return res.end(); }
    if (!m[2] && req.method === 'GET') {
      return sendJSON(res, { id: m[1], ...readJSON(path.join(dir, 'meta.json'), {}), ...readJSON(path.join(dir, 'doc.json'), {}), job: libStatus(m[1]) });
    }
    if (!m[2] && req.method === 'DELETE') { fs.rmSync(dir, { recursive: true, force: true }); return sendJSON(res, { ok: true }); }
    if (m[2] === 'rebuild' && req.method === 'POST') { libBuild(m[1], (await readBody(req)).engine); return sendJSON(res, { ok: true }); }
    if (m[2] === 'meta' && req.method === 'POST') {
      const b = await readBody(req), meta = readJSON(path.join(dir, 'meta.json'), {});
      if (b.title) meta.title = String(b.title).trim().slice(0, 120);
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
      return sendJSON(res, meta);
    }
    if (m[2] === 'export' && req.method === 'POST') {
      const meta = readJSON(path.join(dir, 'meta.json'), {});
      if (!fs.existsSync(path.join(dir, 'doc.json'))) throw new Error('Traduction pas encore terminée');
      const v = VOICES[meta.lang] || VOICES.fr;
      const folder = 'lectures/' + exportName(meta.title);
      const args = ['library.py', 'export', dir, path.join(MEDIA_DIR, folder), '--voice', v.voice];
      if (v.speaker != null) args.push('--speaker', String(v.speaker));
      const job = queuePy(`Audio · ${meta.title}`, folder, args);
      Object.assign(job, { lib: m[1], libKind: 'export' });
      return sendJSON(res, { ok: true, playlist: folder });
    }
    res.writeHead(404); res.end();
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(e.message);
  }
}

async function handlePodcasts(req, res, pathname) {
  if (!toolsAllowed(req)) { res.writeHead(403); return res.end('tools disabled'); }
  try {
    if (pathname === '/api/podcasts' && req.method === 'GET') return sendJSON(res, podcasts.list());
    if (pathname === '/api/podcasts' && req.method === 'POST') {
      const { url, latest } = await readBody(req);
      const sub = await podcasts.subscribe(url);
      const n = Math.max(1, Math.min(50, parseInt(latest, 10) || 5));
      queueFn(`Podcast · ${sub.title} (${n} derniers)`, null, (log, c) => podcasts.run(sub.id, { latest: n }, log, c));
      return sendJSON(res, { id: sub.id, title: sub.title });
    }
    const m = pathname.match(/^\/api\/podcasts\/([0-9a-f]{8})(?:\/(episodes|download))?$/);
    if (m && !m[2] && req.method === 'DELETE') { podcasts.unsubscribe(m[1]); return sendJSON(res, { ok: true }); }
    if (m && m[2] === 'episodes' && req.method === 'GET') return sendJSON(res, await podcasts.episodes(m[1]));
    if (m && m[2] === 'download' && req.method === 'POST') {
      const { guids, latest } = await readBody(req);
      const sub = podcasts.list().find(x => x.id === m[1]);
      if (!sub) throw new Error('Abonnement introuvable');
      const g = Array.isArray(guids) ? guids.map(String).slice(0, 50) : null;
      queueFn(`Podcast · ${sub.title}${g ? ` (${g.length} épisode(s))` : ' (nouveautés)'}`, null,
        (log, c) => podcasts.run(sub.id, { guids: g, latest: parseInt(latest, 10) || 5 }, log, c));
      return sendJSON(res, { ok: true });
    }
    res.writeHead(404); res.end();
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(e.message);
  }
}

async function handleJobs(req, res, pathname) {
  if (!toolsAllowed(req)) { res.writeHead(403); return res.end('tools disabled'); }
  if (req.method === 'GET') return sendJSON(res, jobs.map(jobView));
  const cancel = pathname.match(/^\/api\/jobs\/(\d+)\/cancel$/);
  if (req.method === 'POST' && cancel) {
    const j = jobs.find(x => x.id === +cancel[1]);
    if (j && (j.status === 'queued' || j.status === 'running')) { j.status = 'cancelled'; j.proc?.kill(); }
    return sendJSON(res, { ok: true });
  }
  if (req.method === 'POST' && pathname === '/api/jobs') {
    try { return sendJSON(res, jobView(addJob(await readBody(req)))); }
    catch (e) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(e.message); }
  }
  res.writeHead(404); res.end();
}

async function handleSay(req, res) {
  try {
    const { text, lang } = await readBody(req);
    sendJSON(res, { file: await phrases.say(text, lang) });
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(e.message);
  }
}

async function handlePhrases(req, res, pathname) {
  try {
    if (req.method === 'GET' && pathname === '/api/phrases') return sendJSON(res, phrases.get());
    if (req.method === 'PUT' && pathname === '/api/phrases') return sendJSON(res, phrases.put(await readBody(req)));
    if (req.method === 'POST' && pathname === '/api/phrases/preview') {
      const { text } = await readBody(req);
      return sendJSON(res, { file: await phrases.preview(text) });
    }
    res.writeHead(404); res.end();
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(e.message);
  }
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/config') return sendJSON(res, { tools: toolsAllowed(req) });
  if (pathname.startsWith('/api/jobs')) return handleJobs(req, res, pathname);
  if (pathname.startsWith('/api/podcasts')) return handlePodcasts(req, res, pathname);
  if (pathname.startsWith('/api/library') || pathname === '/api/ocr' || pathname.startsWith('/api/ai') || pathname.startsWith('/api/books')) return handleLibrary(req, res, pathname);
  if (pathname.startsWith('/api/phrases')) return handlePhrases(req, res, pathname);
  if (pathname === '/api/say' && req.method === 'POST') return handleSay(req, res);
  if (pathname === '/api/playlists') return sendJSON(res, listPlaylists());
  if (pathname === '/api/tracks') return sendJSON(res, listTracks(url.searchParams.get('dir') || ''));

  if (pathname.startsWith('/media/')) {
    const file = safeJoin(MEDIA_DIR, pathname.slice(7));
    if (!file) { res.writeHead(403); return res.end(); }
    const isSub = /\.(srt|vtt|lrc|json)$/i.test(file);
    return sendFile(req, res, file, isSub ? 'no-cache' : 'public, max-age=86400');
  }

  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = safeJoin(PUBLIC_DIR, rel);
  if (!file) { res.writeHead(403); return res.end(); }
  sendFile(req, res, file, 'no-cache');
});

server.listen(PORT, HOST, () => {
  console.log(`Lyra 播放器已启动: http://${HOST}:${PORT}`);
  console.log(`音频目录: ${MEDIA_DIR}`);
  if (TOOLS) console.log(`电脑版工具已开启${TOOLS_LAN ? '（允许局域网）' : '（仅本机）'}，Python: ${PYTHON}`);
});
