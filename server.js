const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const PORT = process.env.PORT || 3000;

// Kalau deploy di Railway dan mau setting-nya tetap ada setelah redeploy,
// attach sebuah Volume dan set env DATA_DIR ke mount path volume itu (mis. /data).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}
function saveSettings(patch) {
  const current = loadSettings();
  const next = { ...current, ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}
function maskKey(key) {
  if (!key) return null;
  if (key.length <= 8) return '••••';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}
function currentApiKey() {
  const s = loadSettings();
  return s.apiKey || process.env.ROBLOX_API_KEY || '';
}
function currentUserId() {
  const s = loadSettings();
  return s.userId || process.env.ROBLOX_CREATOR_ID || '';
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Role names we consider "cukup" untuk upload atas nama grup.
const QUALIFYING_ROLE_PATTERN = /owner|admin|developer/i;

app.get('/api/settings', (req, res) => {
  const apiKey = currentApiKey();
  const userId = currentUserId();
  res.json({
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: maskKey(apiKey),
    userId,
  });
});

app.post('/api/settings', (req, res) => {
  try {
    const patch = {};
    if (typeof req.body.apiKey === 'string' && req.body.apiKey.trim()) {
      patch.apiKey = req.body.apiKey.trim();
    }
    if (typeof req.body.userId === 'string') {
      patch.userId = req.body.userId.trim();
    }
    const saved = saveSettings(patch);
    res.json({
      ok: true,
      hasApiKey: Boolean(saved.apiKey || process.env.ROBLOX_API_KEY),
      apiKeyMasked: maskKey(saved.apiKey || process.env.ROBLOX_API_KEY),
      userId: saved.userId || '',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Gagal menyimpan pengaturan: ' + err.message });
  }
});

// Ambil daftar SEMUA grup tempat userId ini punya role. "qualifying" ditandai untuk
// grup yang kelihatannya Admin/Developer/Owner (dari nama role, rank tertinggi/255,
// atau memang pemilik grup itu — dicek dari field owner.userId, bukan cuma nama role,
// karena banyak grup mengganti nama role Owner jadi custom seperti "Founder"/"CEO").
app.get('/api/groups', async (req, res) => {
  const userId = req.query.userId || currentUserId();
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
    // Qualifying dulu (owner di atas), lalu sisanya, masing-masing diurutkan nama.
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

// Extension -> { assetType, mimeType } accepted by this endpoint.
const EXT_CONFIG = {
  '.rbxm': { assetType: 'Animation', mime: 'model/x-rbxm' },
  '.rbxmx': { assetType: 'Animation', mime: 'model/x-rbxm' },
  '.mp3': { assetType: 'Audio', mime: 'audio/mpeg' },
  '.ogg': { assetType: 'Audio', mime: 'audio/ogg' },
  '.wav': { assetType: 'Audio', mime: 'audio/wav' },
  '.flac': { assetType: 'Audio', mime: 'audio/flac' },
};

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const apiKey = currentApiKey();
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: 'API key belum diisi. Buka bagian Pengaturan dan simpan API key dulu.' });
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
    const creatorId = req.body.creatorId || (creatorType === 'user' ? currentUserId() : '');

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

// Manual status check (useful if a poll timed out and the user wants to re-check later)
app.get('/api/status/:operationId', async (req, res) => {
  try {
    const result = await pollOperation(currentApiKey(), req.params.operationId, 1);
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
