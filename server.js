const express = require('express');
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const PORT = process.env.PORT || 3000;
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY || '';
const DEFAULT_CREATOR_TYPE = (process.env.ROBLOX_CREATOR_TYPE || 'user').toLowerCase(); // 'user' | 'group'
const DEFAULT_CREATOR_ID = process.env.ROBLOX_CREATOR_ID || '';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Non-secret defaults so the frontend can prefill the creator fields.
app.get('/api/config', (req, res) => {
  res.json({
    hasApiKey: Boolean(ROBLOX_API_KEY),
    defaultCreatorType: DEFAULT_CREATOR_TYPE,
    defaultCreatorId: DEFAULT_CREATOR_ID,
  });
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!ROBLOX_API_KEY) {
      return res.status(500).json({ ok: false, error: 'ROBLOX_API_KEY belum di-set di server (env variable).' });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'Tidak ada file yang dikirim.' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext !== '.rbxm' && ext !== '.rbxmx') {
      return res.status(400).json({ ok: false, error: 'File harus .rbxm atau .rbxmx.' });
    }

    const displayName = (req.body.displayName || path.basename(req.file.originalname, ext)).slice(0, 50);
    const description = (req.body.description || '').slice(0, 1000);
    const creatorType = (req.body.creatorType || DEFAULT_CREATOR_TYPE) === 'group' ? 'group' : 'user';
    const creatorId = req.body.creatorId || DEFAULT_CREATOR_ID;

    if (!creatorId) {
      return res.status(400).json({ ok: false, error: 'creatorId (userId/groupId) belum diisi.' });
    }

    const creator = creatorType === 'group' ? { groupId: String(creatorId) } : { userId: String(creatorId) };

    const requestJson = {
      assetType: 'Animation',
      displayName,
      description,
      creationContext: { creator },
    };

    const form = new FormData();
    form.append('request', JSON.stringify(requestJson));
    form.append('fileContent', new Blob([req.file.buffer], { type: 'model/x-rbxm' }), req.file.originalname);

    const createRes = await fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST',
      headers: { 'x-api-key': ROBLOX_API_KEY },
      body: form,
    });
    const createJson = await createRes.json().catch(() => null);

    if (!createRes.ok) {
      return res.status(createRes.status).json({ ok: false, error: createJson?.message || 'Upload gagal.', raw: createJson });
    }

    const operationId = createJson.path.split('/').pop();
    const result = await pollOperation(operationId);
    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || 'Unknown server error.' });
  }
});

// Manual status check (useful if a poll timed out and the user wants to re-check later)
app.get('/api/status/:operationId', async (req, res) => {
  try {
    const result = await pollOperation(req.params.operationId, 1);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

async function pollOperation(operationId, maxTries = 25) {
  for (let i = 0; i < maxTries; i++) {
    const r = await fetch(`https://apis.roblox.com/assets/v1/operations/${operationId}`, {
      headers: { 'x-api-key': ROBLOX_API_KEY },
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
