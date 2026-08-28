const express = require('express');
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const PORT = process.env.PORT || 3000;

// PENTING: server ini TIDAK menyimpan API key/User ID siapa pun di disk.
// Kalau website ini dipakai lebih dari 1 orang (mis. dibagikan lewat 1 domain Railway),
// setiap request upload wajib membawa apiKey/creatorId-nya sendiri (dikirim dari
// localStorage browser masing-masing lewat form/JS). ROBLOX_API_KEY di env hanya
// dipakai sebagai fallback kalau kamu deploy khusus untuk dirimu sendiri dan malas
// isi form tiap buka browser baru.
function resolveApiKey(req) {
  return (req.body && req.body.apiKey) || process.env.ROBLOX_API_KEY || '';
}
function resolveUserId(req) {
  return (req.body && req.body.creatorId) || process.env.ROBLOX_CREATOR_ID || '';
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Role names we consider "cukup" untuk upload atas nama grup.
const QUALIFYING_ROLE_PATTERN = /owner|admin|developer/i;

// Non-secret: cuma memberi tahu apakah operator server ini men-set default lewat env.
app.get('/api/settings', (req, res) => {
  res.json({
    hasEnvApiKey: Boolean(process.env.ROBLOX_API_KEY),
    envUserId: process.env.ROBLOX_CREATOR_ID || '',
  });
});

// Ambil daftar SEMUA grup tempat userId ini punya role. "qualifying" ditandai untuk
// grup yang kelihatannya Admin/Developer/Owner (dari nama role, rank tinggi, atau
// memang pemilik grup itu — dicek dari field owner.userId, bukan cuma nama role).
// Endpoint publik Roblox ini tidak butuh API key.
app.get('/api/groups', async (req, res) => {
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

// Extension -> { assetType, mimeType } accepted by the upload endpoint.
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

// Manual status check (kalau poll timeout dan mau dicek lagi nanti).
app.get('/api/status/:operationId', async (req, res) => {
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

// ---------------------------------------------------------------------------
// Download audio by asset ID, lewat Roblox Asset Delivery API (endpoint publik,
// tidak butuh API key — ini jalur yang sama yang dipakai client Roblox untuk
// memutar audio, jadi hanya berfungsi untuk asset yang statusnya public/approved).
// ---------------------------------------------------------------------------
app.get('/api/download-audio', async (req, res) => {
  const assetId = String(req.query.assetId || '').replace(/\D/g, '');
  if (!assetId) {
    return res.status(400).json({ ok: false, error: 'assetId tidak valid.' });
  }
  try {
    const r = await fetch(`https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`);
    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: `Roblox merespons status ${r.status} — asset mungkin private, sudah dihapus, atau belum lolos moderasi.`,
      });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const contentType = r.headers.get('content-type') || 'audio/mpeg';
    let ext = 'mp3';
    if (contentType.includes('ogg')) ext = 'ogg';
    else if (contentType.includes('wav')) ext = 'wav';
    else if (contentType.includes('flac')) ext = 'flac';

    const rawName = String(req.query.filename || `audio_${assetId}`).replace(/[^a-zA-Z0-9 _\-]+/g, '_').slice(0, 80);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${rawName}.${ext}"`);
    res.setHeader('X-File-Ext', ext);
    res.setHeader('Access-Control-Expose-Headers', 'X-File-Ext, Content-Disposition');
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Gagal mengambil audio dari Roblox: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Roblox tools running on port ${PORT}`);
});
