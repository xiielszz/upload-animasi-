const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const PORT = process.env.PORT || 3000;

// PENTING: kredensial Roblox (API key/User ID) TIDAK disimpan di server — itu tersimpan
// per-browser lewat localStorage (lihat public/index.html) supaya banyak orang bisa
// pakai website ini bersamaan tanpa saling menimpa pengaturan.
function resolveApiKey(req) {
  return (req.body && req.body.apiKey) || process.env.ROBLOX_API_KEY || '';
}
function resolveUserId(req) {
  return (req.body && req.body.creatorId) || process.env.ROBLOX_CREATOR_ID || '';
}

// ---------------------------------------------------------------------------
// Access Key store — INI yang disimpan di server, karena sifatnya memang daftar
// pusat yang dikelola 1 admin untuk membatasi siapa saja yang boleh pakai tool ini.
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const KEYS_PATH = path.join(DATA_DIR, 'keys.json');
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

function loadKeys() {
  try {
    return JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8'));
  } catch (e) {
    return {};
  }
}
function saveKeys(keys) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2), 'utf-8');
}
function genKey() {
  return 'RBXT-' + crypto.randomBytes(9).toString('base64url').toUpperCase();
}
function keyStatus(entry) {
  if (!entry) return 'not_found';
  if (entry.expiresAt && Date.now() > entry.expiresAt) return 'expired';
  return 'active';
}

function requireAccessKey(req, res, next) {
  const key = req.header('x-access-key') || req.body.accessKey || req.query.accessKey;
  if (!key) return res.status(401).json({ ok: false, error: 'Access key belum diisi. Masukkan key di halaman login.' });
  const keys = loadKeys();
  const entry = keys[key];
  const status = keyStatus(entry);
  if (status === 'not_found') return res.status(401).json({ ok: false, error: 'Access key tidak valid.' });
  if (status === 'expired') return res.status(401).json({ ok: false, error: 'Access key sudah expired. Minta key baru ke admin.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET) {
    return res.status(503).json({ ok: false, error: 'ADMIN_SECRET belum di-set di environment server. Set dulu supaya panel admin bisa dipakai.' });
  }
  const secret = req.header('x-admin-secret') || req.body.adminSecret || req.query.adminSecret;
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: 'Admin secret salah.' });
  }
  next();
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------------------------------------------------------------------------
// Access key: verifikasi (dipanggil frontend saat login) + admin create/list/delete
// ---------------------------------------------------------------------------
app.get('/api/verify-key', (req, res) => {
  const key = req.header('x-access-key') || req.query.key;
  if (!key) return res.status(400).json({ ok: false, error: 'Key kosong.' });
  const keys = loadKeys();
  const entry = keys[key];
  const status = keyStatus(entry);
  if (status === 'not_found') return res.status(401).json({ ok: false, error: 'Access key tidak valid.' });
  if (status === 'expired') return res.status(401).json({ ok: false, error: 'Access key sudah expired.' });
  res.json({ ok: true, label: entry.label || '', expiresAt: entry.expiresAt || null });
});

app.get('/api/admin/keys', requireAdmin, (req, res) => {
  const keys = loadKeys();
  const list = Object.entries(keys).map(([key, entry]) => ({
    key,
    label: entry.label || '',
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt || null,
    status: keyStatus(entry),
  })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ ok: true, keys: list });
});

app.post('/api/admin/keys', requireAdmin, (req, res) => {
  const label = String(req.body.label || '').slice(0, 80);
  const expiresInDays = Number(req.body.expiresInDays);
  const keys = loadKeys();
  const key = genKey();
  const createdAt = Date.now();
  const expiresAt = expiresInDays > 0 ? createdAt + expiresInDays * 24 * 60 * 60 * 1000 : null;
  keys[key] = { label, createdAt, expiresAt };
  saveKeys(keys);
  res.json({ ok: true, key, label, createdAt, expiresAt });
});

app.delete('/api/admin/keys/:key', requireAdmin, (req, res) => {
  const keys = loadKeys();
  if (!keys[req.params.key]) return res.status(404).json({ ok: false, error: 'Key tidak ditemukan.' });
  delete keys[req.params.key];
  saveKeys(keys);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Groups (endpoint publik Roblox) — dilindungi access key supaya tidak dipakai
// sembarang orang yang tidak dikasih key.
// ---------------------------------------------------------------------------
const QUALIFYING_ROLE_PATTERN = /owner|admin|developer/i;

app.get('/api/groups', requireAccessKey, async (req, res) => {
  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).json({ ok: false, error: 'userId belum diisi.' });
  }
  try {
    const r = await fetch(`https://groups.roblox.com/v2/users/${encodeURIComponent(userId)}/groups/roles`);
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      return res.status(r.status).json({ ok: false, error: j?.errors?.[0]?.message || 'Gagal mengambil daftar grup dari Roblox.' });
    }
    const all = (j.data || []).map((entry) => {
      const isOwner = entry.group.owner && String(entry.group.owner.userId) === String(userId);
      const nameMatches = QUALIFYING_ROLE_PATTERN.test(entry.role.name);
      const highRank = entry.role.rank === 255 || entry.role.rank >= 200;
      return {
        groupId: entry.group.id,
        groupName: entry.group.name,
        roleName: entry.role.name,
        rank: entry.role.rank,
        isOwner,
        qualifies: Boolean(isOwner || nameMatches || highRank),
      };
    });
    all.sort((a, b) => {
      if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
      if (a.qualifies !== b.qualifies) return a.qualifies ? -1 : 1;
      return a.groupName.localeCompare(b.groupName);
    });
    const qualifying = all.filter((g) => g.qualifies);
    res.json({ ok: true, all, qualifying });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Gagal menghubungi Roblox: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// Upload (Animation / Audio) via Roblox Open Cloud Assets API
// ---------------------------------------------------------------------------
const EXT_CONFIG = {
  '.rbxm': { assetType: 'Animation', mime: 'model/x-rbxm' },
  '.rbxmx': { assetType: 'Animation', mime: 'model/x-rbxm' },
  '.mp3': { assetType: 'Audio', mime: 'audio/mpeg' },
  '.ogg': { assetType: 'Audio', mime: 'audio/ogg' },
  '.wav': { assetType: 'Audio', mime: 'audio/wav' },
  '.flac': { assetType: 'Audio', mime: 'audio/flac' },
};

app.post('/api/upload', requireAccessKey, upload.single('file'), async (req, res) => {
  try {
    const apiKey = resolveApiKey(req);
    if (!apiKey) {
      return res.status(400).json({ ok: false, error: 'API key belum diisi. Isi di bagian Pengaturan (tersimpan di browser ini saja).' });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'Tidak ada file yang dikirim.' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const cfg = EXT_CONFIG[ext];
    if (!cfg) {
      return res.status(400).json({ ok: false, error: 'Ekstensi tidak didukung. Gunakan .rbxm/.rbxmx untuk animasi atau .mp3/.ogg/.wav/.flac untuk audio.' });
    }

    const requestedType = req.body.assetType === 'Audio' ? 'Audio' : req.body.assetType === 'Animation' ? 'Animation' : cfg.assetType;
    if (requestedType !== cfg.assetType) {
      return res.status(400).json({ ok: false, error: `Ekstensi file (${ext}) tidak cocok dengan asset type yang diminta (${requestedType}).` });
    }

    const displayName = (req.body.displayName || path.basename(req.file.originalname, ext)).slice(0, 50);
    const description = (req.body.description || '').slice(0, 1000);
    const creatorType = req.body.creatorType === 'group' ? 'group' : 'user';
    const creatorId = req.body.creatorId || (creatorType === 'user' ? resolveUserId(req) : '');

    if (!creatorId) {
      return res.status(400).json({ ok: false, error: 'Target upload (userId/groupId) belum dipilih.' });
    }

    const creator = creatorType === 'group' ? { groupId: String(creatorId) } : { userId: String(creatorId) };

    const requestJson = {
      assetType: cfg.assetType,
      displayName,
      description,
      creationContext: { creator },
    };

    const form = new FormData();
    form.append('request', JSON.stringify(requestJson));
    form.append('fileContent', new Blob([req.file.buffer], { type: cfg.mime }), req.file.originalname);

    const createRes = await fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: form,
    });
    const createJson = await createRes.json().catch(() => null);

    if (!createRes.ok) {
      return res.status(createRes.status).json({ ok: false, error: createJson?.message || 'Upload gagal.', raw: createJson });
    }

    const operationId = createJson.path.split('/').pop();
    const result = await pollOperation(apiKey, operationId);
    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || 'Unknown server error.' });
  }
});

app.get('/api/status/:operationId', requireAccessKey, async (req, res) => {
  const apiKey = req.query.apiKey || process.env.ROBLOX_API_KEY || '';
  if (!apiKey) return res.status(400).json({ ok: false, error: 'apiKey belum diisi.' });
  try {
    const result = await pollOperation(apiKey, req.params.operationId, 1);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

async function pollOperation(apiKey, operationId, maxTries = 25) {
  for (let i = 0; i < maxTries; i++) {
    const r = await fetch(`https://apis.roblox.com/assets/v1/operations/${operationId}`, {
      headers: { 'x-api-key': apiKey },
    });
    const j = await r.json().catch(() => null);

    if (!r.ok) {
      return { ok: false, error: j?.message || 'Gagal cek status operation.', operationId };
    }
    if (j.done) {
      if (j.response) {
        const a = j.response;
        return {
          ok: true,
          done: true,
          assetId: a.assetId,
          displayName: a.displayName,
          moderationState: a.moderationResult?.moderationState || 'unknown',
          url: `https://www.roblox.com/library/${a.assetId}`,
        };
      }
      return { ok: false, done: true, error: j.error?.message || 'Upload diproses tapi gagal (kemungkinan ditolak moderasi atau format tidak valid).', operationId };
    }
    if (maxTries > 1) await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: false, done: false, error: 'Timeout menunggu hasil, coba cek status lagi nanti.', operationId };
}

app.listen(PORT, () => {
  console.log(`Roblox tools running on port ${PORT}`);
});
