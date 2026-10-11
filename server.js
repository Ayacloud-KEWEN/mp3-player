// Lyra 音频播放器 —— 零依赖 Node.js 服务（适合树莓派）
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------- 读取 .env ----------
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv(path.join(__dirname, '.env'));

const PORT = parseInt(process.env.PORT || '10020', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MEDIA_DIR = path.resolve(__dirname, process.env.MEDIA_DIR || './media');
const PUBLIC_DIR = path.join(__dirname, 'public');
// 电脑版工具（生成字幕 / 翻译）：需在 .env 中设置 ENABLE_TOOLS=1，默认只允许本机访问
const TOOLS = process.env.ENABLE_TOOLS === '1';
const TOOLS_LAN = process.env.TOOLS_ALLOW_LAN === '1';
const TOOLS_DIR = path.join(__dirname, 'tools');
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
  for (const d of fs.readdirSync(MEDIA_DIR, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const tracks = listTracks(d.name);
    if (tracks.length) result.push({ name: d.name, count: tracks.length });
  }
  return result.sort((a, b) => collator.compare(a.name, b.name));
}

function listTracks(dir) {
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
      return { title: base, file: dir + '/' + f, sub, tr };
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
  if (!listPlaylists().some(p => p.name === dir)) throw new Error('Liste introuvable');
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

function runNext() {
  if (jobs.some(j => j.status === 'running')) return;
  const job = jobs.find(j => j.status === 'queued');
  if (!job) return;
  if (!fs.existsSync(PYTHON)) { job.status = 'failed'; job.log.push('Environnement Python introuvable : ' + PYTHON + ' (lancez tools/setup.bat)'); return runNext(); }
  job.status = 'running';
  job.started = Date.now();
  const p = spawn(PYTHON, ['-u', ...job.args], { cwd: TOOLS_DIR, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  job.proc = p;
  let buf = '';
  const onData = d => {
    buf += d.toString('utf8');
    const lines = buf.split(/\r?\n|\r/); buf = lines.pop();
    for (const l of lines) {
      if (!l.trim() || /warn/i.test(l)) continue;
      job.log.push(l);
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { reject(e); } });
  });
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

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/config') return sendJSON(res, { tools: toolsAllowed(req) });
  if (pathname.startsWith('/api/jobs')) return handleJobs(req, res, pathname);
  if (pathname === '/api/playlists') return sendJSON(res, listPlaylists());
  if (pathname === '/api/tracks') return sendJSON(res, listTracks(url.searchParams.get('dir') || ''));

  if (pathname.startsWith('/media/')) {
    const file = safeJoin(MEDIA_DIR, pathname.slice(7));
    if (!file) { res.writeHead(403); return res.end(); }
    const isSub = /\.(srt|vtt|lrc)$/i.test(file);
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
