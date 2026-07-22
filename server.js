const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ── Config ────────────────────────────────────────────
const PORT        = process.env.PORT        || 3000;
const MONGO_URI   = process.env.MONGO_URI   || 'mongodb://localhost:27017/trust_system';
const SYNC_SECRET = process.env.SYNC_SECRET || 'crabor-trust-2026';
const BAN_THRESHOLD = 30;

// ── HTTP + WebSocket Server ───────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// Track connected game servers: ws -> { serverName, lastPing }
const connectedServers = new Map();

// ── WebSocket handlers ─────────────────────────────────
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  let serverName = 'unknown';

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === 'register') {
        serverName = data.serverName || 'unknown';
        connectedServers.set(ws, { serverName, lastPing: Date.now() });
        console.log(`🎮 Game server connected: ${serverName}`);
      } else if (data.type === 'pong') {
        ws.isAlive = true;
        const info = connectedServers.get(ws);
        if (info) info.lastPing = Date.now();
      }
    } catch (e) {
      console.error('[ws] message parse error:', e.message);
    }
  });

  ws.on('close', () => {
    if (serverName !== 'unknown') console.log(`🎮 Game server disconnected: ${serverName}`);
    connectedServers.delete(ws);
  });

  ws.on('error', () => {
    connectedServers.delete(ws);
  });
});

// Heartbeat every 30s — kill dead connections
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      connectedServers.delete(ws);
      return;
    }
    ws.isAlive = false;
    ws.send(JSON.stringify({ type: 'ping' }));
  });
}, 30000);

// ── Push helper: gửi update tức thì qua WebSocket (cho admin dashboard) ──
function pushUpdate(uuid, updates) {
  const msg = JSON.stringify({ type: 'player_update', uuid, ...updates });
  let sent = 0;
  for (const [ws] of connectedServers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
      sent++;
    }
  }
  console.log(`📤 Pushed update for ${uuid} → ${sent} client(s)`);
  return sent;
}

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
  grief_break_count: { type: Number, default: 0 },
  is_new_player:     { type: Boolean, default: false },
  pendingScore:   { type: Number, default: null },
  pendingBan:     { type: Boolean, default: null },
  pendingGriefer: { type: Boolean, default: null },
  pendingKick:    { type: String, default: null },  // NEW: stores kick reason
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

// ═══════════════════════════════════════════════════════
//  SYNC ENDPOINTS (event-based)
// ═══════════════════════════════════════════════════════

// POST /api/sync/join  ← plugin gọi khi player JOIN server
//    Trả về toàn bộ data backend cho plugin apply trong game
app.post('/api/sync/join', requireSecret, async (req, res) => {
  try {
    const { uuid, name, server_name } = req.body;
    if (!uuid) return res.status(400).json({ error: 'uuid required' });

    let doc = await Player.findOne({ uuid });
    if (!doc) {
      doc = new Player({
        uuid,
        lastName: name || 'Unknown',
        serverName: server_name || '',
        lastSeen: new Date(),
      });
      await doc.save();
      console.log(`🆕 New player: ${name} (${uuid})`);
    } else {
      doc.lastName   = name || doc.lastName;
      doc.serverName  = server_name || doc.serverName;
      doc.lastSeen    = new Date();
      await doc.save();
      console.log(`👋 Player joined: ${name} (${uuid})`);
    }

    return res.json({
      ok: true,
      player: {
        uuid:               doc.uuid,
        score:              doc.score,
        banned:             doc.banned,
        griefer:            doc.griefer,
        kickCount:          doc.kickCount,
        voteCount:          doc.voteCount,
        grief_break_count:  doc.grief_break_count,
        is_new_player:      doc.is_new_player,
      },
    });
  } catch (err) {
    console.error('[sync/join] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/sync/leave  ← plugin gọi khi player LEAVE server
//    Plugin gửi toàn bộ data hiện tại → backend lưu
app.post('/api/sync/leave', requireSecret, async (req, res) => {
  try {
    const {
      uuid, name, score, kick_count, vote_count,
      griefer, banned, grief_break_count, is_new_player, server_name,
      score_gain_count,
    } = req.body;

    if (!uuid) return res.status(400).json({ error: 'uuid required' });

    let doc = await Player.findOne({ uuid });
    if (!doc) {
      doc = new Player({ uuid, lastName: name || 'Unknown' });
      console.log(`🆕 New player (on leave): ${name} (${uuid})`);
    }

    doc.lastName  = name || doc.lastName;
    if (score             !== undefined) doc.score             = score;
    if (kick_count        !== undefined) doc.kickCount        = kick_count;
    if (vote_count        !== undefined) doc.voteCount        = vote_count;
    if (score_gain_count  !== undefined) doc.scoreGainCount   = score_gain_count;
    if (griefer           !== undefined) doc.griefer          = griefer;
    if (banned            !== undefined) doc.banned           = banned;
    if (grief_break_count !== undefined) doc.grief_break_count = grief_break_count;
    if (is_new_player     !== undefined) doc.is_new_player   = is_new_player;
    doc.serverName = server_name || doc.serverName;
    doc.lastSeen   = new Date();

    doc.pendingScore   = null;
    doc.pendingBan     = null;
    doc.pendingGriefer = null;
    doc.pendingKick    = null;

    await doc.save();
    console.log(`📤 Player left & synced: ${name} (${uuid})`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[sync/leave] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/pending-updates ← plugin poll mỗi 2 giây để nhận update tức thì
//    Trả về tất cả pending changes và clear chúng
app.get('/api/pending-updates', requireSecret, async (req, res) => {
  try {
    const players = await Player.find({
      $or: [
        { pendingScore:   { $ne: null } },
        { pendingBan:     { $ne: null } },
        { pendingGriefer: { $ne: null } },
        { pendingKick:    { $ne: null } },
      ]
    }).lean();

    const updates = players.map(p => {
      const entry = { uuid: p.uuid };
      if (p.pendingScore   !== null) entry.score      = p.pendingScore;
      if (p.pendingBan     !== null) entry.banned     = p.pendingBan;
      if (p.pendingGriefer !== null) entry.griefer    = p.pendingGriefer;
      if (p.pendingKick    !== null) entry.kickReason = p.pendingKick;
      return entry;
    });

    // Clear pending fields
    if (players.length > 0) {
      await Player.updateMany(
        { _id: { $in: players.map(p => p._id) } },
        { $set: { pendingScore: null, pendingBan: null, pendingGriefer: null, pendingKick: null } }
      );
    }

    return res.json({ updates, count: updates.length });
  } catch (err) {
    console.error('[pending-updates] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/sync  ← (giữ lại cho backward compat — periodic sync cũ)
app.post('/api/sync', requireSecret, async (req, res) => {
  try {
    const { server_name, players = [], team_stats = [] } = req.body;
    const updates = [];

    for (const p of players) {
      if (!p.uuid) continue;

      let doc = await Player.findOne({ uuid: p.uuid });

      if (!doc) {
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

        const hasPending = doc.pendingScore !== null || doc.pendingBan !== null || doc.pendingGriefer !== null || doc.pendingKick !== null;
        if (hasPending) {
          const entry = { uuid: doc.uuid };
          if (doc.pendingScore   !== null) entry.score      = doc.pendingScore;
          if (doc.pendingBan     !== null) entry.banned     = doc.pendingBan;
          if (doc.pendingGriefer !== null) entry.griefer    = doc.pendingGriefer;
          if (doc.pendingKick    !== null) entry.kickReason = doc.pendingKick;
          updates.push(entry);
          doc.pendingScore   = null;
          doc.pendingBan     = null;
          doc.pendingGriefer = null;
          doc.pendingKick    = null;
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

// ═══════════════════════════════════════════════════════
//  Admin REST API
// ═══════════════════════════════════════════════════════

// GET /api/players
app.get('/api/players', async (req, res) => {
  try {
    const { search = '', page = 1, limit = 30, sort = 'lastName', order = 'asc' } = req.query;
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
    console.error('[api/players] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/players/:id (supports both _id and uuid)
app.get('/api/players/:id', async (req, res) => {
  try {
    const isObjId = mongoose.Types.ObjectId.isValid(req.params.id);
    const doc = isObjId
      ? await Player.findById(req.params.id).lean()
      : await Player.findOne({ uuid: req.params.id }).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    return res.json(doc);
  } catch (err) {
    console.error('[api/players/:id] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/connections — list game servers đang kết nối WebSocket
app.get('/api/connections', (req, res) => {
  const servers = [];
  for (const [ws, info] of connectedServers) {
    servers.push({
      serverName: info.serverName,
      connected: ws.readyState === WebSocket.OPEN,
      lastPing: info.lastPing,
    });
  }
  return res.json({ servers, count: servers.length });
});

// PATCH /api/players/:id/score
app.patch('/api/players/:id/score', async (req, res) => {
  try {
    const { score } = req.body;
    if (score === undefined || isNaN(score)) return res.status(400).json({ error: 'score required' });
    const clamped = Math.max(0, Math.min(100, Number(score)));
    const isObjId = mongoose.Types.ObjectId.isValid(req.params.id);
    const q = isObjId ? { _id: req.params.id } : { uuid: req.params.id };
    const doc = await Player.findOneAndUpdate(
      q,
      { $set: { score: clamped, pendingScore: clamped } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });

    // ⚡ PUSH TỨC THÌ
    pushUpdate(doc.uuid, { score: clamped });

    return res.json({ ok: true, player: doc });
  } catch (err) {
    console.error('[api/players/:id/score] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/players/:id/ban
app.post('/api/players/:id/ban', async (req, res) => {
  try {
    const isObjId = mongoose.Types.ObjectId.isValid(req.params.id);
    const q = isObjId ? { _id: req.params.id } : { uuid: req.params.id };
    const doc = await Player.findOneAndUpdate(
      q,
      { $set: { banned: true, score: 0, pendingBan: true, pendingScore: 0 } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });

    pushUpdate(doc.uuid, { banned: true, score: 0 });

    return res.json({ ok: true, player: doc });
  } catch (err) {
    console.error('[api/players/:id/ban] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/players/:id/pardon
app.post('/api/players/:id/pardon', async (req, res) => {
  try {
    const isObjId = mongoose.Types.ObjectId.isValid(req.params.id);
    const q = isObjId ? { _id: req.params.id } : { uuid: req.params.id };
    const doc = await Player.findOneAndUpdate(
      q,
      { $set: { banned: false, griefer: false, score: BAN_THRESHOLD, pendingBan: false, pendingGriefer: false, pendingScore: BAN_THRESHOLD } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });

    pushUpdate(doc.uuid, { banned: false, griefer: false, score: BAN_THRESHOLD });

    return res.json({ ok: true, player: doc });
  } catch (err) {
    console.error('[api/players/:id/pardon] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/players/:id/kick
app.post('/api/players/:id/kick', async (req, res) => {
  try {
    const { reason = 'Admin kick via dashboard' } = req.body;
    const isObjId = mongoose.Types.ObjectId.isValid(req.params.id);
    const q = isObjId ? { _id: req.params.id } : { uuid: req.params.id };
    const doc = await Player.findOne(q);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const newScore = Math.max(0, doc.score - 30);
    doc.score        = newScore;
    doc.kickCount    = (doc.kickCount || 0) + 1;
    doc.kickReasons  = [...(doc.kickReasons || []), reason];
    doc.pendingScore = newScore;
    doc.pendingBan   = newScore < BAN_THRESHOLD;
    doc.pendingKick  = reason;  // NEW: plugin sẽ kick player
    await doc.save();

    pushUpdate(doc.uuid, { score: newScore, kick: true, kickReason: reason, ban: newScore < BAN_THRESHOLD });

    return res.json({ ok: true, player: doc });
  } catch (err) {
    console.error('[api/players/:id/kick] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/players/:id/griefer
app.post('/api/players/:id/griefer', async (req, res) => {
  try {
    const griefer = req.body.griefer !== false;
    const isObjId = mongoose.Types.ObjectId.isValid(req.params.id);
    const q = isObjId ? { _id: req.params.id } : { uuid: req.params.id };
    const doc = await Player.findOneAndUpdate(
      q,
      { $set: { griefer, pendingGriefer: griefer } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'Not found' });

    pushUpdate(doc.uuid, { griefer });

    return res.json({ ok: true, player: doc });
  } catch (err) {
    console.error('[api/players/:id/griefer] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/players/:id
app.delete('/api/players/:id', async (req, res) => {
  try {
    const isObjId = mongoose.Types.ObjectId.isValid(req.params.id);
    const q = isObjId ? { _id: req.params.id } : { uuid: req.params.id };
    await Player.deleteOne(q);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[api/players/:id/delete] error:', err.message);
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
      connectedServers: connectedServers.size,
    });
  } catch (err) {
    console.error('[api/stats] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Serve static files ───────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Fallback: serve index.html cho tất cả route không phải API
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'API endpoint not found' });
  }
});

// ── Connect & Start ───────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB connected:', MONGO_URI);
    server.listen(PORT, () => console.log(`🚀 Trust Backend running on http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });
