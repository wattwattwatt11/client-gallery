// 简易客户相册（Pixieset 替代）
// 运行：ADMIN_PASSWORD=你的密码 node server.js
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { ZipArchive } = require('archiver');
const cookieParser = require('cookie-parser');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// 读取同目录下的 .env（管理员密码等配置）
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('请设置管理员密码：ADMIN_PASSWORD=xxxx node server.js');
  process.exit(1);
}

fs.mkdirSync(path.join(DATA_DIR, 'photos'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'tmp'), { recursive: true });

// 持久化 cookie 签名密钥，重启后客户无需重新输入密码
const secretFile = path.join(DATA_DIR, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));
const SECRET = process.env.SESSION_SECRET || fs.readFileSync(secretFile, 'utf8');

const db = new DatabaseSync(path.join(DATA_DIR, 'gallery.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS galleries (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    subtitle TEXT DEFAULT '',
    event_date TEXT DEFAULT '',
    password TEXT DEFAULT '',
    select_limit INTEGER DEFAULT 0,
    allow_download INTEGER DEFAULT 1,
    submitted_at TEXT,
    cover_photo_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gallery_id TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
    set_name TEXT NOT NULL CHECK (set_name IN ('original', 'retouched')),
    filename TEXT NOT NULL,
    stored TEXT NOT NULL,
    width INTEGER, height INTEGER, size INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS favorites (
    gallery_id TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (gallery_id, photo_id)
  );
`);

// 相册设计选项（旧数据库自动补列）
const DESIGN = {
  cover_style: { default: 'center', values: ['center', 'left', 'split', 'frame', 'none'] },
  cover_focus: { default: '50% 50%' },
  grid_style: { default: 'justified', values: ['masonry', 'justified', 'square'] },
  thumb_size: { default: 'regular', values: ['small', 'regular', 'large'] },
  grid_spacing: { default: 'regular', values: ['regular', 'large'] },
};
const galleryCols = db.prepare('PRAGMA table_info(galleries)').all().map((c) => c.name);
for (const [col, { default: def }] of Object.entries(DESIGN)) {
  if (!galleryCols.includes(col)) db.exec(`ALTER TABLE galleries ADD COLUMN ${col} TEXT DEFAULT '${def}'`);
}
// 文件夹（只用于原片）：一张照片最多属于一个文件夹，删除文件夹后照片回到「未分类」
db.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gallery_id TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort INTEGER DEFAULT 0,
    hidden INTEGER DEFAULT 0
  );
`);
if (!db.prepare('PRAGMA table_info(photos)').all().some((c) => c.name === 'folder_id')) {
  db.exec('ALTER TABLE photos ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL');
}

// 是否为这个相册提供精修（关闭后客户页面不出现选片，也不显示精修照片）
if (!galleryCols.includes('offer_retouch')) db.exec('ALTER TABLE galleries ADD COLUMN offer_retouch INTEGER DEFAULT 1');

// 照片排序：taken = 拍摄时间，filename = 文件名，manual = 手动拖动
const SORT_MODES = ['taken', 'filename', 'manual'];
if (!galleryCols.includes('sort_mode')) db.exec("ALTER TABLE galleries ADD COLUMN sort_mode TEXT DEFAULT 'taken'");
const photoCols = db.prepare('PRAGMA table_info(photos)').all().map((c) => c.name);
// taken_at：EXIF 拍摄时间 'YYYY-MM-DD HH:MM:SS.mmm'；'' 表示读不到；NULL 表示还没读过
if (!photoCols.includes('taken_at')) db.exec('ALTER TABLE photos ADD COLUMN taken_at TEXT');
if (!photoCols.includes('sort_pos')) db.exec('ALTER TABLE photos ADD COLUMN sort_pos INTEGER');

// 从 EXIF 读拍摄时间（DateTimeOriginal + 毫秒 SubSecTimeOriginal）
function exifTakenAt(exif) {
  try {
    if (!exif) return '';
    let b = exif;
    if (b.toString('latin1', 0, 4) === 'Exif') b = b.subarray(6);
    const le = b.toString('latin1', 0, 2) === 'II';
    const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
    const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    const ifd = (off) => {
      const tags = new Map();
      const n = u16(off);
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        if (type === 2) { // ASCII
          const at = count <= 4 ? e + 8 : u32(e + 8);
          tags.set(tag, b.toString('latin1', at, at + count).replace(/\0.*$/s, '').trim());
        } else if (type === 4) tags.set(tag, u32(e + 8));
      }
      return tags;
    };
    const ifd0 = ifd(u32(4));
    const exifOff = ifd0.get(0x8769);
    const ex = exifOff ? ifd(exifOff) : new Map();
    const dt = ex.get(0x9003) || ex.get(0x9004);
    const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(dt || '');
    if (!m || m[1] === '0000') return '';
    const sub = String(ex.get(0x9291) || '').replace(/\D/g, '').padEnd(3, '0').slice(0, 3);
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}.${sub}`;
  } catch { return ''; }
}

// ---------- 访问统计（不记 IP，只用随机访客代号；管理员自己的访问不计入）----------
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gallery_id TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
    visitor TEXT NOT NULL,
    type TEXT NOT NULL,           -- visit 打开相册 | view 放大看照片 | download 单张下载 | zip 打包下载
    photo_id INTEGER,
    detail TEXT DEFAULT '',
    device TEXT DEFAULT '',       -- mobile | desktop
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS events_g_time ON events (gallery_id, created_at);
  CREATE INDEX IF NOT EXISTS events_time ON events (created_at);
`);
const TZ = '+8 hours'; // 马来西亚 / 新加坡时间
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|curl|wget|python|headless/i;
// 同一访客 30 分钟内重复的同类事件只算一次（刷新页面、来回翻同一张照片不会灌水）
const DEDUPE = { visit: 30, view: 30 };
function track(req, res, gid, type, photoId = null, detail = '') {
  try {
    if (isAdmin(req)) return;
    const ua = req.get('user-agent') || '';
    if (!ua || BOT_RE.test(ua)) return;
    let vid = req.cookies.vid;
    if (!/^[\w-]{16,32}$/.test(vid || '')) {
      vid = crypto.randomBytes(12).toString('base64url');
      res.cookie('vid', vid, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 365 });
    }
    if (DEDUPE[type] && q(`SELECT 1 FROM events WHERE gallery_id = ? AND visitor = ? AND type = ? AND photo_id IS ?
        AND created_at > datetime('now', ?) LIMIT 1`).get(gid, vid, type, photoId, `-${DEDUPE[type]} minutes`)) return;
    const device = /Mobi|Android|iPhone|iPad|iPod/i.test(ua) ? 'mobile' : 'desktop';
    q('INSERT INTO events (gallery_id, visitor, type, photo_id, detail, device) VALUES (?, ?, ?, ?, ?, ?)')
      .run(gid, vid, type, photoId, String(detail).slice(0, 100), device);
  } catch (e) { console.error('统计失败', e.message); }
}
// 统计汇总：gid 为空 = 整个网站
function statsFor(gid, days) {
  const since = `-${days - 1} days`;
  const where = `created_at >= datetime(date('now', '${TZ}', ?), '-8 hours')` + (gid ? ' AND gallery_id = ?' : '');
  const args = gid ? [since, gid] : [since];
  const totals = q(`SELECT
      SUM(type = 'visit') AS visits, COUNT(DISTINCT visitor) AS visitors,
      SUM(type = 'view') AS views, SUM(type = 'download') AS downloads, SUM(type = 'zip') AS zips,
      COUNT(DISTINCT CASE WHEN device = 'mobile' THEN visitor END) AS mobile,
      COUNT(DISTINCT CASE WHEN device = 'desktop' THEN visitor END) AS desktop
    FROM events WHERE ${where}`).get(...args);
  for (const k in totals) totals[k] = totals[k] || 0;
  const rows = q(`SELECT date(created_at, '${TZ}') AS day,
      SUM(type = 'visit') AS visits, COUNT(DISTINCT visitor) AS visitors,
      SUM(type = 'view') AS views, SUM(type IN ('download', 'zip')) AS downloads
    FROM events WHERE ${where} GROUP BY day`).all(...args);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const daily = [];
  const today = q(`SELECT date('now', '${TZ}') AS d`).get().d;
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - i);
    const day = d.toISOString().slice(0, 10);
    daily.push({ day, visits: 0, visitors: 0, views: 0, downloads: 0, ...byDay.get(day) });
  }
  return { days, totals, daily };
}
const localTime = (col) => `strftime('%Y-%m-%d %H:%M', ${col}, '${TZ}')`;

const validDesign = (f, v) => {
  if (f === 'cover_focus') return /^\d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$/.test(v);
  return DESIGN[f].values.includes(v);
};

const q = (sql) => db.prepare(sql);
const naturalSort = (a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' });
const galleryDir = (gid) => path.join(DATA_DIR, 'photos', gid);
const fileFor = (p, size) => path.join(galleryDir(p.gallery_id), size, p.stored + (size === 'full' ? path.extname(p.filename).toLowerCase() : '.jpg'));
const foldersOf = (gid) => q('SELECT id, name, sort, hidden FROM folders WHERE gallery_id = ? ORDER BY sort, id').all(gid);
// 读不到拍摄时间的排在后面
const byTaken = (a, b) => (!a.taken_at - !b.taken_at) || (a.taken_at || '').localeCompare(b.taken_at || '');
const byPos = (a, b) => ((a.sort_pos ?? Infinity) - (b.sort_pos ?? Infinity)) || 0;
const COMPARE = {
  filename: naturalSort,
  taken: (a, b) => byTaken(a, b) || naturalSort(a, b),
  manual: (a, b) => byPos(a, b) || byTaken(a, b) || naturalSort(a, b), // 新上传还没排过的放最后
};
// 按文件夹顺序排，同一文件夹内按相册的排序方式；未分类排最后
function sortPhotos(photos, folders, mode = 'taken') {
  const rank = new Map(folders.map((f, i) => [f.id, i]));
  const r = (p) => rank.get(p.folder_id) ?? Infinity;
  const cmp = COMPARE[mode] || COMPARE.taken;
  return photos.sort((a, b) => (r(a) - r(b)) || cmp(a, b));
}
const isHiddenPhoto = (p) => !!p.folder_id && !!q('SELECT hidden FROM folders WHERE id = ?').get(p.folder_id)?.hidden;
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').trim() || '_';
const hashPw = (gid, pw) => crypto.createHmac('sha256', SECRET).update(gid + ':' + pw).digest('hex').slice(0, 32);

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(cookieParser(SECRET));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/vendor/Sortable.min.js', (req, res) => res.sendFile(require.resolve('sortablejs/Sortable.min.js')));

const cookieOpts = { signed: true, httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 90 };

// ---------- 权限 ----------
const isAdmin = (req) => req.signedCookies.adm === 'ok';
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: '请先登录' });
  next();
}
function loadGallery(req, res, next) {
  const g = q('SELECT * FROM galleries WHERE id = ?').get(req.params.gid);
  if (!g) return res.status(404).json({ error: '相册不存在' });
  req.gallery = g;
  next();
}
const hasAccess = (req, g) => isAdmin(req) || !g.password || req.signedCookies['g_' + g.id] === hashPw(g.id, g.password);
function requireAccess(req, res, next) {
  if (!hasAccess(req, req.gallery)) return res.status(403).json({ error: 'password' });
  next();
}

// ---------- 页面 ----------
// Cloudflare 会让浏览器缓存 CSS 4 小时；给 style.css 加上内容指纹，更新后客户立即拿到新样式
const cssVersion = crypto.createHash('md5').update(fs.readFileSync(path.join(__dirname, 'public', 'style.css'))).digest('hex').slice(0, 8);
const page = (name) => {
  const html = fs.readFileSync(path.join(__dirname, 'public', name), 'utf8').replace('/style.css', `/style.css?v=${cssVersion}`);
  return (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(html);
};
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', page('admin.html'));
app.get('/g/:gid', page('gallery.html'));

// ---------- 管理员 ----------
app.post('/api/admin/login', (req, res) => {
  const ok = typeof req.body.password === 'string' &&
    crypto.timingSafeEqual(crypto.createHash('sha256').update(req.body.password).digest(), crypto.createHash('sha256').update(ADMIN_PASSWORD).digest());
  if (!ok) return res.status(401).json({ error: '密码错误' });
  res.cookie('adm', 'ok', cookieOpts).json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => res.clearCookie('adm').json({ ok: true }));
app.get('/api/admin/me', (req, res) => res.json({ admin: isAdmin(req) }));

app.get('/api/admin/galleries', requireAdmin, (req, res) => {
  const rows = q(`
    SELECT g.*,
      (SELECT COUNT(*) FROM photos p WHERE p.gallery_id = g.id AND p.set_name = 'original') AS original_count,
      (SELECT COUNT(*) FROM photos p WHERE p.gallery_id = g.id AND p.set_name = 'retouched') AS retouched_count,
      (SELECT COUNT(*) FROM favorites f WHERE f.gallery_id = g.id) AS favorite_count,
      COALESCE(g.cover_photo_id, (SELECT id FROM photos p WHERE p.gallery_id = g.id ORDER BY id LIMIT 1)) AS cover_id
    FROM galleries g ORDER BY g.created_at DESC`).all();
  res.json(rows);
});

app.post('/api/admin/galleries', requireAdmin, (req, res) => {
  const { title, subtitle = '', event_date = '', password = '', select_limit = 0 } = req.body;
  if (!title) return res.status(400).json({ error: '请填写标题' });
  const id = crypto.randomBytes(6).toString('base64url');
  q('INSERT INTO galleries (id, title, subtitle, event_date, password, select_limit) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, title, subtitle, event_date, password, Number(select_limit) || 0);
  res.json({ id });
});

app.get('/api/admin/galleries/:gid', requireAdmin, loadGallery, (req, res) => {
  const folders = foldersOf(req.gallery.id);
  const photos = sortPhotos(q('SELECT id, set_name, filename, width, height, size, folder_id, taken_at, sort_pos FROM photos WHERE gallery_id = ?').all(req.gallery.id), folders, req.gallery.sort_mode);
  const favorites = q('SELECT photo_id, note, created_at FROM favorites WHERE gallery_id = ?').all(req.gallery.id);
  res.json({ gallery: req.gallery, photos, favorites, folders });
});

// ---------- 统计 ----------
const statDays = (req) => [7, 30, 90, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const days = statDays(req);
  const s = statsFor(null, days);
  s.galleries = q(`SELECT g.id, g.title, g.event_date,
      COALESCE(SUM(e.type = 'visit'), 0) AS visits, COUNT(DISTINCT e.visitor) AS visitors,
      COALESCE(SUM(e.type = 'view'), 0) AS views, COALESCE(SUM(e.type IN ('download', 'zip')), 0) AS downloads,
      (SELECT ${localTime('MAX(created_at)')} FROM events x WHERE x.gallery_id = g.id) AS last_visit
    FROM galleries g LEFT JOIN events e ON e.gallery_id = g.id
      AND e.created_at >= datetime(date('now', '${TZ}', ?), '-8 hours')
    GROUP BY g.id ORDER BY visits DESC, last_visit DESC`).all(`-${days - 1} days`);
  s.since = q(`SELECT ${localTime('MIN(created_at)')} AS t FROM events`).get().t;
  res.json(s);
});
app.get('/api/admin/galleries/:gid/stats', requireAdmin, loadGallery, (req, res) => {
  const gid = req.gallery.id;
  const s = statsFor(gid, statDays(req));
  Object.assign(s, q(`SELECT ${localTime('MIN(created_at)')} AS first_visit, ${localTime('MAX(created_at)')} AS last_visit,
      COUNT(*) AS all_events FROM events WHERE gallery_id = ?`).get(gid));
  s.all_visits = q("SELECT COUNT(*) AS n FROM events WHERE gallery_id = ? AND type = 'visit'").get(gid).n;
  s.all_visitors = q('SELECT COUNT(DISTINCT visitor) AS n FROM events WHERE gallery_id = ?').get(gid).n;
  s.top_photos = q(`SELECT p.id, p.filename, COUNT(*) AS views,
      (SELECT COUNT(*) FROM events d WHERE d.photo_id = p.id AND d.type = 'download') AS downloads
    FROM events e JOIN photos p ON p.id = e.photo_id
    WHERE e.gallery_id = ? AND e.type = 'view' GROUP BY p.id ORDER BY views DESC, downloads DESC LIMIT 12`).all(gid);
  s.recent = q(`SELECT ${localTime('e.created_at')} AS time, e.type, e.detail, e.device, p.filename
    FROM events e LEFT JOIN photos p ON p.id = e.photo_id
    WHERE e.gallery_id = ? AND e.type IN ('visit', 'zip', 'download') ORDER BY e.created_at DESC, e.id DESC LIMIT 30`).all(gid);
  res.json(s);
});

// ---------- 文件夹 ----------
app.post('/api/admin/galleries/:gid/folders', requireAdmin, loadGallery, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: '请填写文件夹名称' });
  const { m } = q('SELECT COALESCE(MAX(sort), -1) AS m FROM folders WHERE gallery_id = ?').get(req.gallery.id);
  const info = q('INSERT INTO folders (gallery_id, name, sort) VALUES (?, ?, ?)').run(req.gallery.id, name, m + 1);
  res.json({ id: Number(info.lastInsertRowid) });
});

app.patch('/api/admin/folders/:fid', requireAdmin, (req, res) => {
  const f = q('SELECT * FROM folders WHERE id = ?').get(req.params.fid);
  if (!f) return res.status(404).json({ error: '文件夹不存在' });
  if ('name' in req.body) {
    const name = String(req.body.name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: '请填写文件夹名称' });
    q('UPDATE folders SET name = ? WHERE id = ?').run(name, f.id);
  }
  if ('hidden' in req.body) q('UPDATE folders SET hidden = ? WHERE id = ?').run(req.body.hidden ? 1 : 0, f.id);
  res.json({ ok: true });
});

app.delete('/api/admin/folders/:fid', requireAdmin, (req, res) => {
  q('DELETE FROM folders WHERE id = ?').run(req.params.fid); // 照片的 folder_id 自动变为 NULL
  res.json({ ok: true });
});

app.put('/api/admin/galleries/:gid/folders/order', requireAdmin, loadGallery, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const set = q('UPDATE folders SET sort = ? WHERE id = ? AND gallery_id = ?');
  ids.forEach((id, i) => set.run(i, id, req.gallery.id));
  res.json({ ok: true });
});

// 手动排序：ids 为某一组照片（原片或精修）排好的顺序
app.put('/api/admin/galleries/:gid/photos/order', requireAdmin, loadGallery, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
  const set = q('UPDATE photos SET sort_pos = ? WHERE id = ? AND gallery_id = ?');
  db.exec('BEGIN');
  try { ids.forEach((id, i) => set.run(i, id, req.gallery.id)); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  q("UPDATE galleries SET sort_mode = 'manual' WHERE id = ?").run(req.gallery.id);
  res.json({ ok: true });
});

// 批量移动照片到某个文件夹（folder_id 为 null 表示未分类）
app.post('/api/admin/galleries/:gid/photos/move', requireAdmin, loadGallery, (req, res) => {
  const fid = req.body.folder_id == null ? null : Number(req.body.folder_id);
  if (fid !== null && !q('SELECT 1 FROM folders WHERE id = ? AND gallery_id = ?').get(fid, req.gallery.id)) {
    return res.status(400).json({ error: '文件夹不存在' });
  }
  const ids = Array.isArray(req.body.photo_ids) ? req.body.photo_ids : [];
  const move = q("UPDATE photos SET folder_id = ? WHERE id = ? AND gallery_id = ? AND set_name = 'original'");
  for (const id of ids) move.run(fid, id, req.gallery.id);
  res.json({ ok: true, moved: ids.length });
});

app.patch('/api/admin/galleries/:gid', requireAdmin, loadGallery, (req, res) => {
  const fields = ['title', 'subtitle', 'event_date', 'password', 'select_limit', 'allow_download', 'cover_photo_id', 'submitted_at', 'offer_retouch'];
  for (const f of fields) {
    if (f in req.body) q(`UPDATE galleries SET ${f} = ? WHERE id = ?`).run(req.body[f], req.gallery.id);
  }
  if ('sort_mode' in req.body) {
    if (!SORT_MODES.includes(req.body.sort_mode)) return res.status(400).json({ error: '无效的排序方式' });
    q('UPDATE galleries SET sort_mode = ? WHERE id = ?').run(req.body.sort_mode, req.gallery.id);
  }
  for (const f of Object.keys(DESIGN)) {
    if (!(f in req.body)) continue;
    if (!validDesign(f, req.body[f])) return res.status(400).json({ error: `无效的设置：${f}` });
    q(`UPDATE galleries SET ${f} = ? WHERE id = ?`).run(req.body[f], req.gallery.id);
  }
  res.json(q('SELECT * FROM galleries WHERE id = ?').get(req.gallery.id));
});

app.delete('/api/admin/galleries/:gid', requireAdmin, loadGallery, (req, res) => {
  q('DELETE FROM galleries WHERE id = ?').run(req.gallery.id);
  fs.rmSync(galleryDir(req.gallery.id), { recursive: true, force: true });
  res.json({ ok: true });
});

const upload = multer({ dest: path.join(DATA_DIR, 'tmp'), limits: { fileSize: 200 * 1024 * 1024 } });
app.post('/api/admin/galleries/:gid/photos', requireAdmin, loadGallery, upload.single('file'), async (req, res) => {
  const set = req.query.set === 'retouched' ? 'retouched' : 'original';
  if (!req.file) return res.status(400).json({ error: '没有文件' });
  const folderId = set === 'original' && req.query.folder
    ? q('SELECT id FROM folders WHERE id = ? AND gallery_id = ?').get(req.query.folder, req.gallery.id)?.id ?? null
    : null;
  const tmp = req.file.path;
  try {
    const filename = path.basename(Buffer.from(req.file.originalname, 'latin1').toString('utf8'));
    const stored = crypto.randomBytes(12).toString('hex');
    const dir = galleryDir(req.gallery.id);
    for (const s of ['full', 'web', 'thumb']) fs.mkdirSync(path.join(dir, s), { recursive: true });

    // 预览图转换为 sRGB 以保证网页上颜色准确；原图原封不动保留供下载
    const img = sharp(tmp, { failOn: 'none' }).rotate();
    const meta = await img.metadata();
    const takenAt = exifTakenAt(meta.exif);
    const web = await img.clone().resize(2400, 2400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 86, mozjpeg: true }).toFile(path.join(dir, 'web', stored + '.jpg'));
    await img.clone().resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true }).toFile(path.join(dir, 'thumb', stored + '.jpg'));
    fs.renameSync(tmp, path.join(dir, 'full', stored + path.extname(filename).toLowerCase()));

    // 同名文件重复上传则替换旧的
    const existing = q('SELECT * FROM photos WHERE gallery_id = ? AND set_name = ? AND filename = ?').get(req.gallery.id, set, filename);
    if (existing) removePhotoFiles(existing);
    const info = existing
      ? q('UPDATE photos SET stored = ?, width = ?, height = ?, size = ?, folder_id = ?, taken_at = ? WHERE id = ?').run(stored, web.width, web.height, req.file.size, folderId, takenAt, existing.id)
      : q('INSERT INTO photos (gallery_id, set_name, filename, stored, width, height, size, folder_id, taken_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(req.gallery.id, set, filename, stored, web.width, web.height, req.file.size, folderId, takenAt);
    res.json({ id: existing ? existing.id : Number(info.lastInsertRowid), filename, width: web.width, height: web.height, format: meta.format });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    console.error(e);
    res.status(400).json({ error: '无法处理该图片：' + e.message });
  }
});

function removePhotoFiles(p) {
  for (const s of ['full', 'web', 'thumb']) fs.rmSync(fileFor(p, s), { force: true });
}
app.delete('/api/admin/photos/:pid', requireAdmin, (req, res) => {
  const p = q('SELECT * FROM photos WHERE id = ?').get(req.params.pid);
  if (!p) return res.status(404).json({ error: '照片不存在' });
  q('DELETE FROM photos WHERE id = ?').run(p.id);
  q('UPDATE galleries SET cover_photo_id = NULL WHERE cover_photo_id = ?').run(p.id);
  removePhotoFiles(p);
  res.json({ ok: true });
});

// ---------- 客户 ----------
function publicGallery(g) {
  const { password, ...rest } = g;
  return { ...rest, has_password: !!password };
}

app.post('/api/g/:gid/auth', loadGallery, (req, res) => {
  if (req.body.password !== req.gallery.password) return res.status(401).json({ error: '密码不正确' });
  res.cookie('g_' + req.gallery.id, hashPw(req.gallery.id, req.gallery.password), cookieOpts).json({ ok: true });
});

app.get('/api/g/:gid', loadGallery, (req, res) => {
  const g = req.gallery;
  const first = q('SELECT id FROM photos WHERE gallery_id = ? ORDER BY id LIMIT 1').get(g.id);
  const cover_id = g.cover_photo_id || first?.id || null;
  if (!hasAccess(req, g)) return res.status(403).json({ error: 'password', gallery: { title: g.title, event_date: g.event_date, cover_id, cover_focus: g.cover_focus } });
  // 隐藏文件夹里的照片客户看不到
  const folders = foldersOf(g.id).filter((f) => !f.hidden).map(({ id, name }) => ({ id, name }));
  const photos = sortPhotos(q(`
    SELECT p.id, p.set_name, p.filename, p.width, p.height, p.folder_id, p.taken_at, p.sort_pos FROM photos p
    LEFT JOIN folders f ON f.id = p.folder_id
    WHERE p.gallery_id = ? AND COALESCE(f.hidden, 0) = 0
      AND (p.set_name = 'original' OR ? = 1)`).all(g.id, g.offer_retouch ? 1 : 0), folders, g.sort_mode)
    .map(({ taken_at, sort_pos, ...p }) => p);
  const favorites = q('SELECT photo_id, note FROM favorites WHERE gallery_id = ?').all(g.id);
  track(req, res, g.id, 'visit');
  res.json({ gallery: { ...publicGallery(g), cover_id }, photos, favorites, folders });
});

// 客户放大看某张照片时由页面上报
app.post('/api/g/:gid/view/:pid', loadGallery, requireAccess, (req, res) => {
  const p = q('SELECT id FROM photos WHERE id = ? AND gallery_id = ?').get(req.params.pid, req.gallery.id);
  if (p) track(req, res, req.gallery.id, 'view', p.id);
  res.sendStatus(204);
});

app.put('/api/g/:gid/favorites/:pid', loadGallery, requireAccess, (req, res) => {
  const g = req.gallery;
  if (!g.offer_retouch) return res.status(403).json({ error: '这个相册不提供精修选片' });
  if (g.submitted_at && !isAdmin(req)) return res.status(409).json({ error: '选片已提交，如需修改请联系摄影师' });
  const p = q("SELECT id, folder_id FROM photos WHERE id = ? AND gallery_id = ? AND set_name = 'original'").get(req.params.pid, g.id);
  if (!p || (isHiddenPhoto(p) && !isAdmin(req))) return res.status(404).json({ error: '照片不存在' });
  const exists = q('SELECT 1 FROM favorites WHERE gallery_id = ? AND photo_id = ?').get(g.id, p.id);
  if (!exists && g.select_limit > 0) {
    const { n } = q('SELECT COUNT(*) AS n FROM favorites WHERE gallery_id = ?').get(g.id);
    if (n >= g.select_limit) return res.status(409).json({ error: `最多只能选 ${g.select_limit} 张哦，可以先取消几张再选` });
  }
  q(`INSERT INTO favorites (gallery_id, photo_id, note) VALUES (?, ?, ?)
     ON CONFLICT (gallery_id, photo_id) DO UPDATE SET note = excluded.note`).run(g.id, p.id, String(req.body.note || '').slice(0, 1000));
  res.json({ ok: true });
});

app.delete('/api/g/:gid/favorites/:pid', loadGallery, requireAccess, (req, res) => {
  if (req.gallery.submitted_at && !isAdmin(req)) return res.status(409).json({ error: '选片已提交，如需修改请联系摄影师' });
  q('DELETE FROM favorites WHERE gallery_id = ? AND photo_id = ?').run(req.gallery.id, req.params.pid);
  res.json({ ok: true });
});

app.post('/api/g/:gid/submit', loadGallery, requireAccess, (req, res) => {
  if (!req.gallery.offer_retouch) return res.status(403).json({ error: '这个相册不提供精修选片' });
  const { n } = q('SELECT COUNT(*) AS n FROM favorites WHERE gallery_id = ?').get(req.gallery.id);
  if (n === 0) return res.status(400).json({ error: '还没有选择任何照片' });
  q("UPDATE galleries SET submitted_at = datetime('now') WHERE id = ?").run(req.gallery.id);
  res.json({ ok: true });
});

// 图片：thumb / web 用于浏览，full 为原图下载
app.get('/img/:pid/:size', (req, res) => {
  const size = req.params.size;
  if (!['thumb', 'web', 'full'].includes(size)) return res.sendStatus(404);
  const p = q('SELECT * FROM photos WHERE id = ?').get(req.params.pid);
  if (!p) return res.sendStatus(404);
  const g = q('SELECT * FROM galleries WHERE id = ?').get(p.gallery_id);
  // 封面图允许在密码页显示
  const isCover = size !== 'full' && (g.cover_photo_id === p.id ||
    (!g.cover_photo_id && q('SELECT id FROM photos WHERE gallery_id = ? ORDER BY id LIMIT 1').get(g.id)?.id === p.id));
  if (!isCover && !hasAccess(req, g)) return res.sendStatus(403);
  if (!isCover && isHiddenPhoto(p) && !isAdmin(req)) return res.sendStatus(404);
  if (size === 'full' && !g.allow_download && !isAdmin(req)) return res.sendStatus(403);
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  if (size === 'full') { track(req, res, g.id, 'download', p.id); return res.download(fileFor(p, 'full'), p.filename); }
  res.sendFile(fileFor(p, size));
});

// 打包下载：set = original | retouched | favorites，original 可加 folder=ID 只下载一个文件夹
app.get('/api/g/:gid/download', loadGallery, requireAccess, (req, res) => {
  const g = req.gallery;
  if (!g.allow_download && !isAdmin(req)) return res.sendStatus(403);
  const set = req.query.set;
  const admin = isAdmin(req);
  const folders = foldersOf(g.id).filter((f) => admin || !f.hidden);
  const folderName = new Map(folders.map((f) => [f.id, safeName(f.name)]));
  let photos = q('SELECT * FROM photos WHERE gallery_id = ?').all(g.id)
    .filter((p) => !p.folder_id || folderName.has(p.folder_id))
    .filter((p) => g.offer_retouch || p.set_name === 'original');
  let label = '全部';
  const folder = req.query.folder ? folders.find((f) => f.id === Number(req.query.folder)) : null;
  if (set === 'favorites') {
    const favIds = new Set(q('SELECT photo_id FROM favorites WHERE gallery_id = ?').all(g.id).map((f) => f.photo_id));
    photos = photos.filter((p) => favIds.has(p.id));
    label = '已选';
  } else if (set === 'original' && folder) {
    photos = photos.filter((p) => p.set_name === 'original' && p.folder_id === folder.id);
    label = folder.name;
  } else if (set === 'retouched' || set === 'original') {
    photos = photos.filter((p) => p.set_name === set);
    label = set === 'retouched' ? '精修' : '原片';
  }
  if (!photos.length) return res.status(404).send('没有照片');
  sortPhotos(photos, folders, g.sort_mode);
  // ZIP 内的路径：全部 → 原片/敬茶/xxx.jpg；原片 → 敬茶/xxx.jpg；单个文件夹、精修、已选 → 直接放根目录
  const sub = (p) => (p.set_name === 'original' && p.folder_id ? folderName.get(p.folder_id) + '/' : '');
  const dirFor = (p) => {
    if (!set) return (p.set_name === 'retouched' ? '精修/' : '原片/' + sub(p));
    if (set === 'original' && !folder) return sub(p);
    return '';
  };
  track(req, res, g.id, 'zip', null, `${label} · ${photos.length} 张`);
  const zipName = `${g.title} - ${label}.zip`.replace(/[\\/:*?"<>|]/g, '_');
  res.attachment(zipName);
  const archive = new ZipArchive({ store: true }); // JPG 已压缩，不再二次压缩，速度最快
  archive.on('error', (e) => { console.error(e); res.destroy(e); });
  archive.pipe(res);
  const used = new Set();
  for (const p of photos) {
    const dir = dirFor(p);
    let name = dir + p.filename;
    for (let i = 2; used.has(name); i++) name = dir + path.parse(p.filename).name + `-${i}` + path.extname(p.filename);
    used.add(name);
    archive.file(fileFor(p, 'full'), { name });
  }
  archive.finalize();
});

// 旧照片补读拍摄时间（只读一次，读不到记为 ''）
async function backfillTakenAt() {
  const rows = q('SELECT * FROM photos WHERE taken_at IS NULL').all();
  const set = q('UPDATE photos SET taken_at = ? WHERE id = ?');
  for (const p of rows) {
    let t = '';
    try { t = exifTakenAt((await sharp(fileFor(p, 'full'), { failOn: 'none' }).metadata()).exif); } catch {}
    set.run(t, p.id);
  }
  if (rows.length) console.log(`已补读 ${rows.length} 张照片的拍摄时间`);
}
backfillTakenAt();

app.listen(PORT, () => {
  console.log(`相册已启动：http://localhost:${PORT}/admin`);
});
