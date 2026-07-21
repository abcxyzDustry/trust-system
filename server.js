const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ────────────────────────────────────────────
const PORT        = process.env.PORT        || 3000;
const MONGO_URI   = process.env.MONGO_URI   || 'mongodb://localhost:27017/trust_system';
const SYNC_SECRET = process.env.SYNC_SECRET || 'crabor-trust-2026';
const BAN_THRESHOLD = 30;

// ── Mongoose Schema ───────────────────────────────────
const playerSchema = new mongoose.Schema({
  uuid:           { type: String, required: true, unique: true },
  lastName:       { type: String, default: 'Unknown' },
  score:          { type: Number, default: 100 },
  kickCount:      { type: Number, default: 0 },
  voteCount:      { type: Number, default: 0 },
  scoreGainCount: { type: Number, default: 0 },
  lang:           { type: String, default: 'en' },
  kickReasons:    { type: [String], default: [] },
  griefer:        { type: Boolean, default: false },
  banned:         { type: Boolean, default: false },
  // Extra tracking from plugin v4.0
  grief_break_count: { type: Number, default: 0 },
  is_new_player:     { type: Boolean, default: false },
  // Admin overrides pending delivery to plugin
  pendingScore:   { type: Number, default: null },
  pendingBan:     { type: Boolean, default: null },
  pendingGriefer: { type: Boolean, default: null },
  // Meta
  serverName:     { type: String, default: '' },
  lastSeen:       { type: Date, default: Date.now },
  createdAt:      { type: Date, default: Date.now },
}, { versionKey: false });

const Player = mongoose.model('Player', playerSchema);

// ── Auth middleware ───────────────────────────────────
function requireSecret(req, res, next) {
  const secret = req.body?.secret || req.query?.secret || req.headers['x-sync-secret'];
  if (secret !== SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─────────────────────────────────────────────────────
//  POST /api/sync   ← called by Mindustry plugin every 5 min
//  Body: { action:"sync", secret, server_name, players:[...], team_stats:[...] }
//  Returns: { ok:true, updates:[{uuid, score?, banned?, griefer?}, ...] }
// ─────────────────────────────────────────────────────
app.post('/api/sync', requireSecret, async (req, res) => {
  try {
    const { server_name, players = [], team_stats = [] } = req.body;

    const updates = [];

    for (const p of players) {
      if (!p.uuid) continue;

      // Find or upsert player record
      let doc = await Player.findOne({ uuid: p.uuid });

      if (!doc) {
        // New player – create from plugin data
        doc = new Player({
          uuid:           p.uuid,
          lastName:       p.name || 'Unknown',
          score:          p.score ?? 100,
          kickCount:      p.kick_count ?? 0,
          voteCount:      p.vote_count ?? 0,
          griefer:        p.griefer ?? false,
          banned:         p.banned  ?? false,
          grief_break_count: p.grief_break_count ?? 0,
          is_new_player:     p.is_new_player     ?? false,
          serverName:     server_name || '',
          lastSeen:       new Date(),
        });
        await doc.save();
      } else {
        // Existing – update from plugin data
        doc.lastName       = p.name || doc.lastName;
        doc.score          = p.score          ?? doc.score;
        doc.kickCount      = p.kick_count     ?? doc.kickCount;
        doc.voteCount      = p.vote_count     ?? doc.voteCount;
        doc.griefer        = p.griefer        ?? doc.griefer;
        doc.banned         = p.banned         ?? doc.banned;
        doc.grief_break_count = p.grief_break_count ?? doc.grief_break_count;
        doc.is_new_player  = p.is_new_player  ?? doc.is_new_player;
        doc.serverName     = server_name || doc.serverName;
        doc.lastSeen       = new Date();

        // Check if there are pending admin overrides to send back to plugin
        const hasPending = doc.pendingScore !== null || doc.pendingBan !== null || doc.pendingGriefer !== null;
        if (hasPending) {
          const entry = { uuid: doc.uuid };
          if (doc.pendingScore !== null)   entry.score   = doc.pendingScore;
          if (doc.pendingBan   !== null)   entry.banned  = doc.pendingBan;
          if (doc.pendingGriefer !== null) entry.griefer = doc.pendingGriefer;
          updates.push(entry);

          // Clear pending flags
          doc.pendingScore   = null;
          doc.pendingBan     = null;
          doc.pendingGriefer = null;
        }

        await doc.save();
      }
    }

    return res.json({ ok: true, updates, received: players.length });
  } catch (err) {
    console.error('[sync] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────
//  Admin REST API  (no auth — as requested)
// ─────────────────────────────────────────────────────

// GET /api/players?search=&page=1&limit=50
app.get('/api/players', async (req, res) => {
  try {
    const { search = '', page = 1, limit = 50, sort = 'lastName', order = 'asc' } = req.query;
    const q = search
      ? { $or: [
          { lastName:  { $regex: search, $options: 'i' } },
          { uuid:      { $regex: search, $options: 'i' } },
          { serverName:{ $regex: search, $options: 'i' } },
        ] }
      : {};

    const sortObj = { [sort]: order === 'desc' ? -1 : 1 };
    const total   = await Player.countDocuments(q);
    const players = await Player.find(q)
      .sort(sortObj)
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();

    return res.json({ total, page: Number(page), limit: Number(limit), players });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/players/:uuid
app.get('/api/players/:uuid', async (req, res) => {
  try {
    const doc = await Player.findOne({ uuid: req.params.uuid }).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    return res.json(doc);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/players/:uuid/score   { score: N }
app.patch('/api/players/:uuid/score', async (req, res) => {
  try {
    const { score } = req.body;
    if (score === undefined || isNaN(score)) return res.status(400).json({ error: 'score required' });
    const clamped = Math.max(0, Math.min(100, Number(score)));
    const doc = await Player.findOneAndUpdate(
      { uuid: req.params.uuid },
      { $set: { score: clamped, pendingScore: clamped } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true, player: doc });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/players/:uuid/ban
app.post('/api/players/:uuid/ban', async (req, res) => {
  try {
    const doc = await Player.findOneAndUpdate(
      { uuid: req.params.uuid },
      { $set: { banned: true, score: 0, pendingBan: true, pendingScore: 0 } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true, player: doc });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/players/:uuid/pardon
app.post('/api/players/:uuid/pardon', async (req, res) => {
  try {
    const doc = await Player.findOneAndUpdate(
      { uuid: req.params.uuid },
      { $set: { banned: false, griefer: false, score: BAN_THRESHOLD, pendingBan: false, pendingGriefer: false, pendingScore: BAN_THRESHOLD } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true, player: doc });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/players/:uuid/kick  (schedule a kick next sync)
app.post('/api/players/:uuid/kick', async (req, res) => {
  try {
    const { reason = 'Admin kick via dashboard' } = req.body;
    const doc = await Player.findOne({ uuid: req.params.uuid });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    // Deduct 30 points (KICK_PENALTY) and queue
    const newScore = Math.max(0, doc.score - 30);
    doc.score        = newScore;
    doc.kickCount    = (doc.kickCount || 0) + 1;
    doc.kickReasons  = [...(doc.kickReasons || []), reason];
    doc.pendingScore = newScore;
    doc.pendingBan   = newScore < BAN_THRESHOLD;
    await doc.save();
    return res.json({ ok: true, player: doc });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/players/:uuid/griefer  { griefer: true/false }
app.post('/api/players/:uuid/griefer', async (req, res) => {
  try {
    const griefer = req.body.griefer !== false;
    const doc = await Player.findOneAndUpdate(
      { uuid: req.params.uuid },
      { $set: { griefer, pendingGriefer: griefer } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true, player: doc });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/players/:uuid  — full delete
app.delete('/api/players/:uuid', async (req, res) => {
  try {
    await Player.deleteOne({ uuid: req.params.uuid });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/stats
app.get('/api/stats', async (req, res) => {
  try {
    const total   = await Player.countDocuments();
    const banned  = await Player.countDocuments({ banned: true });
    const griefer = await Player.countDocuments({ griefer: true });
    const atRisk  = await Player.countDocuments({ score: { $lt: 50, $gte: BAN_THRESHOLD } });
    const avg     = await Player.aggregate([{ $group: { _id: null, avg: { $avg: '$score' } } }]);
    return res.json({
      total, banned, griefer, atRisk,
      avgScore: Math.round(avg[0]?.avg ?? 0),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Connect & Start ───────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB connected:', MONGO_URI);
    app.listen(PORT, () => console.log(`🚀 Trust Backend running on http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });
