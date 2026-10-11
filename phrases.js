// 日常句子：分组保存在 MEDIA_DIR/.phrases/phrases.json，
// 每个分组用 Piper 合成为一个 WAV + SRT，作为一个普通播放列表出现（名称前加 ✦）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PREFIX = '✦ ';
const LEAD = 0.4;   // 开头留白（秒）
const GAP = 1.0;    // 句间停顿（秒）

module.exports = function createPhrases({ mediaDir, python, toolsDir, voice, speaker, voices = {} }) {
  const root = path.join(mediaDir, '.phrases');
  const dataFile = path.join(root, 'phrases.json');
  const cacheDir = path.join(root, 'cache');
  const outDir = path.join(root, 'out');
  const voiceKey = voice + (speaker != null ? '#' + speaker : '');

  let data = load();
  const builds = {};      // gid -> { status: 'idle'|'building'|'error', file, error }
  let building = false, dirty = new Set();

  function load() {
    try { return JSON.parse(fs.readFileSync(dataFile, 'utf8')); }
    catch { return { groups: [{ id: newId(), name: 'Quotidien', items: [] }] }; }
  }
  function save() {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(dataFile + '.part', JSON.stringify(data, null, 1));
    fs.renameSync(dataFile + '.part', dataFile);
  }
  function newId() { return crypto.randomBytes(5).toString('hex'); }
  const hash = s => crypto.createHash('sha1').update(voiceKey + '\n' + s).digest('hex').slice(0, 16);
  const cacheWav = text => path.join(cacheDir, hash(text) + '.wav');

  // 校验并规范客户端提交的数据
  function sanitize(input) {
    const groups = Array.isArray(input?.groups) ? input.groups : [];
    const seen = new Set();
    const out = groups.slice(0, 50).map(g => ({
      id: /^[0-9a-f]{10}$/.test(g.id) && !seen.has(g.id) ? (seen.add(g.id), g.id) : newId(),
      name: String(g.name || 'Groupe').trim().slice(0, 60) || 'Groupe',
      items: (Array.isArray(g.items) ? g.items : []).slice(0, 500)
        .map(it => ({
          id: /^[0-9a-f]{10}$/.test(it.id) ? it.id : newId(),
          text: String(it.text || '').replace(/\s+/g, ' ').trim().slice(0, 500),
          note: String(it.note || '').trim().slice(0, 300),
          created: Number(it.created) || Date.now(),
        }))
        .filter(it => it.text),
    }));
    if (!out.length) out.push({ id: newId(), name: 'Quotidien', items: [] });
    return { groups: out };
  }

  // ---------- 语音合成 ----------
  // texts → WAV。v/spk/out 默认为日常句子的声音与缓存位置
  function synth(texts, v = voice, spk = speaker, out = cacheWav) {
    const todo = [...new Set(texts)].filter(t => !fs.existsSync(out(t)));
    if (!todo.length) return Promise.resolve();
    fs.mkdirSync(path.dirname(out(todo[0])), { recursive: true });
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(python)) return reject(new Error('Python introuvable : ' + python));
      const p = spawn(python, ['-u', path.join(toolsDir, 'tts.py')], { cwd: toolsDir, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      let err = '';
      p.stderr.on('data', d => { err += d; if (err.length > 4000) err = err.slice(-4000); });
      p.on('error', reject);
      p.on('close', code => code === 0 ? resolve() : reject(new Error(err.split('\n').filter(Boolean).slice(-2).join(' ') || 'tts failed')));
      p.stdin.end(JSON.stringify({ voice: v, speaker: spk, items: todo.map(t => ({ text: t, out: out(t) })) }));
    });
  }

  // ---------- WAV 拼接 ----------
  function readWav(file) {
    const b = fs.readFileSync(file);
    let pos = 12, fmt = null, pcm = null;
    while (pos + 8 <= b.length) {
      const id = b.toString('ascii', pos, pos + 4), size = b.readUInt32LE(pos + 4);
      if (id === 'fmt ') fmt = { channels: b.readUInt16LE(pos + 10), rate: b.readUInt32LE(pos + 12), bits: b.readUInt16LE(pos + 22) };
      if (id === 'data') pcm = b.subarray(pos + 8, pos + 8 + size);
      pos += 8 + size + (size & 1);
    }
    if (!fmt || !pcm) throw new Error('WAV invalide : ' + file);
    return { fmt, pcm };
  }
  function wavHeader(fmt, dataLen) {
    const h = Buffer.alloc(44), block = fmt.channels * fmt.bits / 8;
    h.write('RIFF', 0); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(fmt.channels, 22);
    h.writeUInt32LE(fmt.rate, 24); h.writeUInt32LE(fmt.rate * block, 28); h.writeUInt16LE(block, 32); h.writeUInt16LE(fmt.bits, 34);
    h.write('data', 36); h.writeUInt32LE(dataLen, 40);
    return h;
  }
  const ts = t => {
    const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  };

  async function buildGroup(g) {
    const dir = path.join(outDir, g.id);
    builds[g.id] = { ...builds[g.id], status: 'building' };
    try {
      await synth(g.items.map(it => it.text));
      fs.mkdirSync(dir, { recursive: true });
      const parts = [], cues = [];
      let fmt = null, t = LEAD;
      const silence = sec => Buffer.alloc(Math.round(sec * fmt.rate) * fmt.channels * fmt.bits / 8);
      for (const it of g.items) {
        const w = readWav(cacheWav(it.text));
        if (!fmt) { fmt = w.fmt; parts.push(silence(LEAD)); }
        const dur = w.pcm.length / (fmt.rate * fmt.channels * fmt.bits / 8);
        cues.push(`${cues.length + 1}\n${ts(t)} --> ${ts(t + dur)}\n${it.text}\n`);
        parts.push(w.pcm, silence(GAP));
        t += dur + GAP;
      }
      // 清理旧文件；音频文件名带内容哈希，浏览器缓存不会读到旧版本
      for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
      if (!fmt) { builds[g.id] = { status: 'idle', file: null }; return; }
      const pcm = Buffer.concat(parts);
      const name = crypto.createHash('sha1').update(pcm).digest('hex').slice(0, 12);
      fs.writeFileSync(path.join(dir, name + '.wav'), Buffer.concat([wavHeader(fmt, pcm.length), pcm]));
      fs.writeFileSync(path.join(dir, name + '.srt'), cues.join('\n'));
      builds[g.id] = { status: 'idle', file: name };
    } catch (e) {
      builds[g.id] = { status: 'error', error: e.message };
      console.error('phrases build', g.name, e.message);
    }
  }

  // 依次重建标记为 dirty 的分组
  async function pump() {
    if (building) return;
    building = true;
    while (dirty.size) {
      const gid = dirty.values().next().value; dirty.delete(gid);
      const g = data.groups.find(x => x.id === gid);
      if (g) await buildGroup(g);
    }
    // 清理不再被任何句子使用的缓存音频（被删除或修改过的句子）
    const keep = new Set(data.groups.flatMap(g => g.items.map(it => path.basename(cacheWav(it.text)))));
    if (fs.existsSync(cacheDir)) for (const f of fs.readdirSync(cacheDir)) if (!keep.has(f)) fs.rmSync(path.join(cacheDir, f), { force: true });
    building = false;
  }
  function markDirty(gids) { gids.forEach(id => { dirty.add(id); builds[id] = { ...builds[id], status: 'building' }; }); pump(); }

  // 启动时：找回已有的合成结果，缺失的重建
  for (const g of data.groups) {
    const dir = path.join(outDir, g.id);
    const wav = fs.existsSync(dir) && fs.readdirSync(dir).find(f => f.endsWith('.wav'));
    builds[g.id] = { status: 'idle', file: wav ? wav.slice(0, -4) : null };
    if (g.items.length && !wav) dirty.add(g.id);
  }
  pump();

  return {
    PREFIX,
    get: () => ({ ...data, voice, status: Object.fromEntries(data.groups.map(g => [g.id, builds[g.id] || { status: 'idle' }])) }),
    put(input) {
      const next = sanitize(input);
      const sig = g => g.items.map(i => i.text).join('\n');
      const old = Object.fromEntries(data.groups.map(g => [g.id, sig(g)]));
      const changed = next.groups.filter(g => old[g.id] !== sig(g)).map(g => g.id);
      // 删除的分组：清理其输出
      for (const g of data.groups) if (!next.groups.some(x => x.id === g.id)) { fs.rmSync(path.join(outDir, g.id), { recursive: true, force: true }); delete builds[g.id]; }
      data = next; save();
      markDirty(changed);
      return this.get();
    },
    // 试听单句：返回缓存 WAV 的路径（相对 MEDIA_DIR）
    async preview(text) {
      text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (!text) throw new Error('Texte vide');
      await synth([text]);
      return path.relative(mediaDir, cacheWav(text)).split(path.sep).join('/');
    },
    // 查词朗读：按语言选声音，缓存在 .phrases/say/ 下（不随日常句子清理）
    async say(text, lang) {
      text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
      if (!text) throw new Error('Texte vide');
      const v = lang === 'fr' ? { voice, speaker } : voices[lang];
      if (!v) throw new Error('Langue non prise en charge : ' + lang);
      const key = v.voice + (v.speaker != null ? '#' + v.speaker : '');
      const out = t => path.join(root, 'say', crypto.createHash('sha1').update(key + '\n' + t).digest('hex').slice(0, 16) + '.wav');
      await synth([text], v.voice, v.speaker ?? null, out);
      return path.relative(mediaDir, out(text)).split(path.sep).join('/');
    },
    // 作为播放列表出现
    playlists: () => data.groups.filter(g => builds[g.id]?.file && g.items.length)
      .map(g => ({ name: PREFIX + g.name, count: g.items.length, phrases: g.id })),
    tracks(name) {
      const g = data.groups.find(x => PREFIX + x.name === name);
      const f = g && builds[g.id]?.file;
      if (!f) return null;
      return [{ title: g.name, file: `.phrases/out/${g.id}/${f}.wav`, sub: `.phrases/out/${g.id}/${f}.srt`, tr: {}, phrases: g.id }];
    },
  };
};
