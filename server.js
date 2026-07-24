const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ── Config ────────────────────────────────────────────
const PORT        = process.env.PORT        || 3000;
const MONGO_URI   = process.env.MONGO_URI   || 'mongodb://localhost:27017/trust_system';
const SYNC_SECRET = process.env.SYNC_SECRET || 'crabor-trust-2026';
const BAN_THRESHOLD = 30;

// ── Discord Config ────────────────────────────────────
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1529326032522580020/uyCZYHNg0ISWveLt6043JkVVMkhzAiVDdiensUHTPNtF9KZHe4dpu9X-eby7quur-7iU';
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN  || '';
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';

// ═══════════════════════════════════════════════════════
//  DISCORD WEBHOOK — gửi notification lên Discord
// ═══════════════════════════════════════════════════════

function sendDiscordWebhook(title, description, color = 0x00d2ff, fields = []) {
  try {
    const embed = {
      title,
      description,
      color,
      timestamp: new Date().toISOString(),
      footer: { text: 'TrustSystem Bot' },
    };
    if (fields.length > 0) embed.fields = fields;

    const payload = JSON.stringify({ embeds: [embed] });
    const url = new URL(DISCORD_WEBHOOK_URL);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 204 && res.statusCode !== 200) {
        console.error(`[Discord] webhook responded ${res.statusCode}`);
      }
    });
    req.on('error', (e) => console.error('[Discord] webhook error:', e.message));
    req.write(payload);
    req.end();
  } catch (e) {
    console.error('[Discord] webhook exception:', e.message);
  }
}

// ═══════════════════════════════════════════════════════
//  DISCORD BOT — nhận lệnh điều khiển từ Discord
// ═══════════════════════════════════════════════════════

let discordBot = null;
let discordReady = false;

function initDiscordBot() {
  if (!DISCORD_BOT_TOKEN || DISCORD_BOT_TOKEN.length < 10) {
    console.log('[Discord] Bot token not set — skipping bot. Webhook notifications still active.');
    return;
  }

  try {
    const { Client, GatewayIntentBits } = require('discord.js');

    discordBot = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    discordBot.on('ready', () => {
      discordReady = true;
      console.log(`🤖 Discord bot online: ${discordBot.user.tag}`);
      sendDiscordWebhook(
        '🟢 Bot Online',
        `TrustSystem Bot đã kết nối!\nSẵn sàng nhận lệnh: \`!trust <command>\``,
        0x2ed573
      );
    });

    discordBot.on('messageCreate', async (msg) => {
      // Ignore bots & DMs
      if (msg.author.bot) return;
      if (msg.channel.type !== 0) return;
      // Restrict to specific channel if set
      if (DISCORD_CHANNEL_ID && msg.channelId !== DISCORD_CHANNEL_ID) return;

      const text = msg.content.trim();
      if (!text.toLowerCase().startsWith('!trust')) return;

      const parts = text.split(/\s+/);
      const cmd = (parts[1] || '').toLowerCase();
      const args = parts.slice(2);

      try {
        switch (cmd) {
          case 'help':
          case 'h': {
            const helpEmbed = {
              title: '🤖 TrustSystem — Lệnh Discord',
              color: 0x00d2ff,
              fields: [
                { name: '!trust list [page]', value: 'Danh sách người chơi (mặc định 30/trang)', inline: false },
                { name: '!trust info <tên hoặc uuid>', value: 'Xem thông tin chi tiết 1 player', inline: false },
                { name: '!trust score <tên hoặc uuid> <điểm>', value: 'Chỉnh điểm tin nhiệm (0-100)', inline: false },
                { name: '!trust kick <tên hoặc uuid> [lý do]', value: 'Kick player (−30₫)', inline: false },
                { name: '!trust ban <tên hoặc uuid>', value: 'Cấm vĩnh viễn (score=0)', inline: false },
                { name: '!trust pardon <tên hoặc uuid>', value: 'Gỡ cấm (score=30)', inline: false },
                { name: '!trust griefer <tên hoặc uuid> <on|off>', value: 'Bật/tắt griefer lock', inline: false },
                { name: '!trust role <tên hoặc uuid> <player|admin|co-owner>', value: 'Chỉnh role player', inline: false },
                { name: '!trust stats', value: 'Thống kê tổng quan', inline: false },
              ],
              footer: { text: 'TrustSystem Bot' },
            };
            msg.channel.send({ embeds: [helpEmbed] });
            break;
          }

          case 'list':
          case 'ls': {
            const page = Math.max(1, parseInt(args[0]) || 1);
            const limit = 20;
            const total = await Player.countDocuments();
            const players = await Player.find({})
              .sort({ score: -1 })
              .skip((page - 1) * limit)
              .limit(limit)
              .lean();

            if (players.length === 0) {
              msg.reply('📭 Không có player nào.');
              break;
            }

            const lines = players.map((p, i) => {
              const rank = (page - 1) * limit + i + 1;
              const status = p.banned ? '🔴 BAN' : p.griefer ? '🟡 GRIEF' : p.score < 50 ? '🟠 LOW' : '🟢';
                           const roleIcon = p.role === 'owner' ? '👑 ' : p.role === 'co-owner' ? '💎 ' : p.role === 'admin' ? '🔰 ' : '';
return `\`${rank}.\` ${status} **${roleIcon}${p.lastName}** — ${p.score}₫ | Kick: ${p.kickCount} | ${p.serverName || '?'}`;
            });

            msg.channel.send({
              embeds: [{
                title: `📋 Danh sách người chơi (Trang ${page}/${Math.ceil(total / limit)})`,
                description: lines.join('\n'),
                color: 0x00d2ff,
                footer: { text: `Tổng: ${total} players` },
              }],
            });
            break;
          }

          case 'info':
          case 'i': {
            if (!args[0]) { msg.reply('❌ Cú pháp: `!trust info <tên hoặc uuid>`'); break; }
            const query = args.join(' ');
            const isUuid = query.length > 20 && /^[a-f0-9]/i.test(query);
            const doc = isUuid
              ? await Player.findOne({ uuid: { $regex: query, $options: 'i' } }).lean()
              : await Player.findOne({ lastName: { $regex: query, $options: 'i' } }).lean();

            if (!doc) { msg.reply(`❌ Không tìm thấy: \`${query}\``); break; }

            const status = doc.banned ? '🔴 BANNED' : doc.griefer ? '🟡 GRIEFER' : doc.score < 50 ? '🟠 AT RISK' : '🟢 OK';
            msg.channel.send({
              embeds: [{
                title: `👤 ${doc.lastName}`,
                color: doc.banned ? 0xff4757 : doc.griefer ? 0xffa502 : 0x2ed573,
                fields: [
                  { name: 'UUID', value: `\`${doc.uuid}\``, inline: false },
                  { name: 'Role', value: doc.role || 'player', inline: true },
                  { name: 'Trust Score', value: `${doc.score}₫`, inline: true },
                  { name: 'Status', value: status, inline: true },
                  { name: 'Kick Count', value: String(doc.kickCount), inline: true },
                  { name: 'Vote Count', value: String(doc.voteCount), inline: true },
                  { name: 'Griefer', value: doc.griefer ? 'Yes' : 'No', inline: true },
                  { name: 'Server', value: doc.serverName || 'N/A', inline: true },
                  { name: 'Last Seen', value: doc.lastSeen ? new Date(doc.lastSeen).toLocaleString('vi-VN') : 'N/A', inline: true },
                ],
                footer: { text: 'TrustSystem Bot' },
              }],
            });
            break;
          }

          case 'score': {
            if (args.length < 2) { msg.reply('❌ Cú pháp: `!trust score <tên hoặc uuid> <điểm>`'); break; }
            const scoreVal = parseInt(args[args.length - 1]);
            const nameQuery = args.slice(0, -1).join(' ');
            if (isNaN(scoreVal)) { msg.reply('❌ Điểm phải là số (0-100).'); break; }
            const clamped = Math.max(0, Math.min(100, scoreVal));

            const isUuid = nameQuery.length > 20 && /^[a-f0-9]/i.test(nameQuery);
            const doc = await Player.findOne(isUuid
              ? { uuid: { $regex: nameQuery, $options: 'i' } }
              : { lastName: { $regex: nameQuery, $options: 'i' } }
            );
            if (!doc) { msg.reply(`❌ Không tìm thấy: \`${nameQuery}\``); break; }

            const oldScore = doc.score;
            doc.score = clamped;
            doc.pendingScore = clamped;
            if (clamped < BAN_THRESHOLD) { doc.banned = true; doc.pendingBan = true; }
            await doc.save();

            pushUpdate(doc.uuid, { score: clamped });
            sendDiscordWebhook(
              '📝 Điểm đã chỉnh',
              `Admin **${msg.author.tag}** đã chỉnh điểm`,
              0x00d2ff,
              [
                { name: 'Player', value: doc.lastName, inline: true },
                { name: 'Cũ → Mới', value: `${oldScore}₫ → ${clamped}₫`, inline: true },
              ]
            );
            msg.reply(`✅ Đã chỉnh điểm **${doc.lastName}**: ${oldScore}₫ → **${clamped}₫**`);
            break;
          }

          case 'kick': {
            if (!args[0]) { msg.reply('❌ Cú pháp: `!trust kick <tên hoặc uuid> [lý do]`'); break; }
            const reason = args.slice(1).join(' ') || `Kick bởi ${msg.author.tag} qua Discord`;
            const nameQuery = args[0];

            const isUuid = nameQuery.length > 20 && /^[a-f0-9]/i.test(nameQuery);
            const doc = await Player.findOne(isUuid
              ? { uuid: { $regex: nameQuery, $options: 'i' } }
              : { lastName: { $regex: nameQuery, $options: 'i' } }
            );
            if (!doc) { msg.reply(`❌ Không tìm thấy: \`${nameQuery}\``); break; }

            const newScore = Math.max(0, doc.score - 30);
            doc.score = newScore;
            doc.kickCount = (doc.kickCount || 0) + 1;
            doc.kickReasons = [...(doc.kickReasons || []), reason];
            doc.pendingScore = newScore;
            doc.pendingBan = newScore < BAN_THRESHOLD;
            doc.pendingKick = reason;
            await doc.save();

            pushUpdate(doc.uuid, { score: newScore, kick: true, kickReason: reason });
            sendDiscordWebhook(
              '🦶 Player bị kick',
              `Admin **${msg.author.tag}** đã kick player`,
              0xffa502,
              [
                { name: 'Player', value: doc.lastName, inline: true },
                { name: 'Lý do', value: reason, inline: true },
                { name: 'Score', value: `${doc.score}₫`, inline: true },
              ]
            );
            msg.reply(`🦶 Đã kick **${doc.lastName}** — Lý do: ${reason} — Score: ${doc.score}₫`);
            break;
          }

          case 'ban': {
            if (!args[0]) { msg.reply('❌ Cú pháp: `!trust ban <tên hoặc uuid>`'); break; }
            const nameQuery = args.join(' ');

            const isUuid = nameQuery.length > 20 && /^[a-f0-9]/i.test(nameQuery);
            const doc = await Player.findOne(isUuid
              ? { uuid: { $regex: nameQuery, $options: 'i' } }
              : { lastName: { $regex: nameQuery, $options: 'i' } }
            );
            if (!doc) { msg.reply(`❌ Không tìm thấy: \`${nameQuery}\``); break; }

            doc.banned = true;
            doc.score = 0;
            doc.pendingBan = true;
            doc.pendingScore = 0;
            await doc.save();

            pushUpdate(doc.uuid, { banned: true, score: 0 });
            sendDiscordWebhook(
              '🔴 Player bị BAN',
              `Admin **${msg.author.tag}** đã cấm vĩnh viễn`,
              0xff4757,
              [
                { name: 'Player', value: doc.lastName, inline: true },
                { name: 'UUID', value: `\`${doc.uuid}\``, inline: false },
                  { name: 'Role', value: doc.role || 'player', inline: true },
              ]
            );
            msg.reply(`🔴 Đã cấm vĩnh viễn **${doc.lastName}** (${doc.uuid})`);
            break;
          }

          case 'pardon': {
            if (!args[0]) { msg.reply('❌ Cú pháp: `!trust pardon <tên hoặc uuid>`'); break; }
            const nameQuery = args.join(' ');

            const isUuid = nameQuery.length > 20 && /^[a-f0-9]/i.test(nameQuery);
            const doc = await Player.findOne(isUuid
              ? { uuid: { $regex: nameQuery, $options: 'i' } }
              : { lastName: { $regex: nameQuery, $options: 'i' } }
            );
            if (!doc) { msg.reply(`❌ Không tìm thấy: \`${nameQuery}\``); break; }

            doc.banned = false;
            doc.griefer = false;
            doc.score = BAN_THRESHOLD;
            doc.pendingBan = false;
            doc.pendingGriefer = false;
            doc.pendingScore = BAN_THRESHOLD;
            await doc.save();

            pushUpdate(doc.uuid, { banned: false, griefer: false, score: BAN_THRESHOLD });
            sendDiscordWebhook(
              '🟢 Player được pardon',
              `Admin **${msg.author.tag}** đã gỡ cấm`,
              0x2ed573,
              [
                { name: 'Player', value: doc.lastName, inline: true },
                { name: 'Score', value: `${BAN_THRESHOLD}₫`, inline: true },
              ]
            );
            msg.reply(`🟢 Đã gỡ cấm **${doc.lastName}** — Score: ${BAN_THRESHOLD}₫`);
            break;
          }

          case 'griefer': {
            if (args.length < 2) { msg.reply('❌ Cú pháp: `!trust griefer <tên hoặc uuid> <on|off>`'); break; }
            const state = args[args.length - 1].toLowerCase();
            const nameQuery = args.slice(0, -1).join(' ');
            if (state !== 'on' && state !== 'off') { msg.reply('❌ Giá trị phải là `on` hoặc `off`.'); break; }
            const griefer = state === 'on';

            const isUuid = nameQuery.length > 20 && /^[a-f0-9]/i.test(nameQuery);
            const doc = await Player.findOne(isUuid
              ? { uuid: { $regex: nameQuery, $options: 'i' } }
              : { lastName: { $regex: nameQuery, $options: 'i' } }
            );
            if (!doc) { msg.reply(`❌ Không tìm thấy: \`${nameQuery}\``); break; }

            doc.griefer = griefer;
            doc.pendingGriefer = griefer;
            await doc.save();

            pushUpdate(doc.uuid, { griefer });
            sendDiscordWebhook(
              griefer ? '🟡 Griefer Lock ON' : '🟢 Griefer Lock OFF',
              `Admin **${msg.author.tag}** ${griefer ? 'bật' : 'tắt'} griefer lock`,
              griefer ? 0xffa502 : 0x2ed573,
              [{ name: 'Player', value: doc.lastName, inline: true }]
            );
            msg.reply(`${griefer ? '🟡 Bật' : '🟢 Tắt'} griefer lock cho **${doc.lastName}**`);
            break;
          }

          case 'role': {
            if (args.length < 2) { msg.reply('❌ Cú pháp: `!trust role <tên hoặc uuid> <player|admin|co-owner>`'); break; }
            const roleVal = args[args.length - 1].toLowerCase();
            const nameQuery = args.slice(0, -1).join(' ');
            
            const validRoles = ['player', 'admin', 'co-owner', 'owner'];
            if (!validRoles.includes(roleVal)) { msg.reply('❌ Role không hợp lệ. Chọn một trong: player, admin, co-owner'); break; }

            const isUuid = nameQuery.length > 20 && /^[a-f0-9]/i.test(nameQuery);
            const doc = await Player.findOne(isUuid
              ? { uuid: { $regex: nameQuery, $options: 'i' } }
              : { lastName: { $regex: nameQuery, $options: 'i' } }
            );
            if (!doc) { msg.reply(`❌ Không tìm thấy: \`${nameQuery}\``); break; }

            const oldRole = doc.role || 'player';
            doc.role = roleVal;
            doc.pendingRole = roleVal;
            await doc.save();

            pushUpdate(doc.uuid, { role: roleVal });
            sendDiscordWebhook(
              '👑 Role Changed',
              `Admin **${msg.author.tag}** đã chỉnh role`,
              0xa29bfe,
              [
                { name: 'Player', value: doc.lastName, inline: true },
                { name: 'Cũ → Mới', value: `${oldRole} → ${roleVal}`, inline: true },
              ]
            );
            msg.reply(`👑 Đã chỉnh role **${doc.lastName}**: ${oldRole} → **${roleVal}**`);
            break;
          }

          case 'stats': {
            const total = await Player.countDocuments();
            const banned = await Player.countDocuments({ banned: true });
            const griefer = await Player.countDocuments({ griefer: true });
            const atRisk = await Player.countDocuments({ score: { $lt: 50, $gte: BAN_THRESHOLD } });
            const avgAgg = await Player.aggregate([{ $group: { _id: null, avg: { $avg: '$score' } } }]);
            const avgScore = Math.round(avgAgg[0]?.avg ?? 0);

                        const admins = await Player.countDocuments({ role: 'admin' });
            const coOwners = await Player.countDocuments({ role: 'co-owner' });
msg.channel.send({
              embeds: [{
                title: '📊 Thống kê TrustSystem',
                color: 0x00d2ff,
                fields: [
                  { name: 'Tổng Players', value: String(total), inline: true },
                  { name: 'Banned', value: String(banned), inline: true },
                  { name: 'Griefers', value: String(griefer), inline: true },
                  { name: 'At Risk (<50₫)', value: String(atRisk), inline: true },
                  { name: 'Admins', value: String(admins), inline: true },
                  { name: 'Co-Owners', value: String(coOwners), inline: true },
                  { name: 'Avg Score', value: `${avgScore}₫`, inline: true },
                  { name: 'Servers Online', value: String(connectedServers.size), inline: true },
                ],
                footer: { text: 'TrustSystem Bot' },
              }],
            });
            break;
          }

          default:
            msg.reply('❓ Lệnh không hợp lệ. Gõ `!trust help` để xem danh sách lệnh.');
        }
      } catch (cmdErr) {
        console.error('[Discord] command error:', cmdErr.message);
        msg.reply('❌ Lỗi: ' + cmdErr.message);
      }
    });

    discordBot.login(DISCORD_BOT_TOKEN);
  } catch (e) {
    console.error('[Discord] Bot init failed (discord.js not installed?):', e.message);
    console.log('[Discord] Webhook notifications still active. Bot commands need "discord.js" package.');
  }
}

// ═══════════════════════════════════════════════════════
//  HTTP + WebSocket Server
// ═══════════════════════════════════════════════════════
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// Track connected game servers: ws -> { serverName, lastPing }
// (Lưu ý: đây là kết nối WS từ trình duyệt dashboard, KHÔNG phải server Mindustry —
//  plugin TrustSync chỉ gọi HTTP, không mở WebSocket.)
const connectedServers = new Map();

// Registry các server Mindustry đang gửi sync (qua POST /api/sync), key = server_name.
// Cập nhật mỗi lần /api/sync được gọi (mỗi ~5 phút/server). Không cần lưu Mongo vì
// đây là dữ liệu "hiện diện" tạm thời — mất khi restart cũng tự có lại sau lần sync kế tiếp.
const gameServers = new Map(); // serverName -> {serverName, ip, port, desc, modeName, mapName, playerCount, lastSeen}
const SERVER_ONLINE_THRESHOLD_MS = 6 * 60 * 1000; // 6 phút (chu kỳ sync là 5 phút)

// Remote control: cho phep dashboard tat/bat auto-sync va kich hoat TAT CA server sync ngay lap tuc, cung 1 thoi diem.
// Plugin (Java) poll GET /api/sync/control moi ~5s de nhan lenh nay gan nhu tuc thi (khong can WebSocket).
let globalSyncEnabled = true;             // cong tac tong: tat/bat sync tu dong cho TOAN BO server
let globalForceSyncNonce = 0;             // moi lan bam "Đồng bộ tất cả ngay" -> +1; server nao thay nonce moi se sync ngay
const perServerEnabled = new Map();       // serverName -> bool, cho phep tat/bat rieng 1 server (mac dinh true neu khong co)

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
  pendingKick:    { type: String, default: null },
  role:           { type: String, default: 'player', enum: ['player','admin','co-owner','owner'] },
  pendingRole:    { type: String, default: null },
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
app.post('/api/sync/join', requireSecret, async (req, res) => {
  try {
    const { uuid, name, server_name } = req.body;
    if (!uuid) return res.status(400).json({ error: 'uuid required' });

    let doc = await Player.findOne({ uuid });
    const isNew = !doc;
    if (!doc) {
      doc = new Player({
        uuid,
        lastName: name || 'Unknown',
        serverName: server_name || '',
        lastSeen: new Date(),
      });
      if (req.body.role) doc.role = req.body.role;
      await doc.save();
      console.log(`🆕 New player: ${name} (${uuid})`);

      // ── Discord notification: player mới ──
      sendDiscordWebhook(
        '🆕 Player mới tham gia',
        `Người chơi mới đã được sync vào backend`,
        0x2ed573,
        [
          { name: 'Tên', value: name || 'Unknown', inline: true },
          { name: 'Score', value: '100₫', inline: true },
          { name: 'Server', value: server_name || 'Unknown', inline: true },
          { name: 'UUID', value: `\`${uuid}\``, inline: false },
        ]
      );
    } else {
      doc.lastName   = name || doc.lastName;
      doc.serverName  = server_name || doc.serverName;
      doc.lastSeen    = new Date();
      if (req.body.role) doc.role = req.body.role;
      await doc.save();
      console.log(`👋 Player joined: ${name} (${uuid})`);

      // ── Discord notification: player quay lại ──
      sendDiscordWebhook(
        '👋 Player join server',
        `${name || 'Unknown'} đã vào server`,
        0x00d2ff,
        [
          { name: 'Tên', value: name || 'Unknown', inline: true },
          { name: 'Score', value: `${doc.score}₫`, inline: true },
          { name: 'Banned', value: doc.banned ? 'YES' : 'No', inline: true },
          { name: 'Server', value: server_name || 'Unknown', inline: true },
        ]
      );
    }

    return res.json({
      ok: true,
      is_new: isNew,
      player: {
        uuid:               doc.uuid,
        score:              doc.score,
        banned:             doc.banned,
        griefer:            doc.griefer,
        kickCount:          doc.kickCount,
        voteCount:          doc.voteCount,
        grief_break_count:  doc.grief_break_count,
        is_new_player:      doc.is_new_player,
        role:               doc.role,
      },
    });
  } catch (err) {
    console.error('[sync/join] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/sync/leave  ← plugin gọi khi player LEAVE server
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

    const oldScore = doc.score;
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
    doc.pendingRole    = null;

    await doc.save();
    console.log(`📤 Player left & synced: ${name} (${uuid})`);

    // ── Discord notification: player leave ──
    if (oldScore !== doc.score) {
      sendDiscordWebhook(
        '📤 Player leave & sync',
        `${name || 'Unknown'} đã rời server`,
        0xa29bfe,
        [
          { name: 'Tên', value: name || 'Unknown', inline: true },
          { name: 'Score', value: `${oldScore}₫ → ${doc.score}₫`, inline: true },
          { name: 'Server', value: server_name || 'Unknown', inline: true },
        ]
      );
    } else {
      sendDiscordWebhook(
        '📤 Player leave',
        `${name || 'Unknown'} đã rời server — Score: ${doc.score}₫`,
        0xa29bfe,
        [
          { name: 'Server', value: server_name || 'Unknown', inline: true },
        ]
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[sync/leave] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/sync/update  ← plugin gọi khi player score thay đổi
app.post('/api/sync/update', requireSecret, async (req, res) => {
  try {
    const {
      uuid, name, score_delta, kick_count_delta, vote_count_delta,
      griefer, grief_break_count, is_new_player, server_name,
    } = req.body;

    if (!uuid) return res.status(400).json({ error: 'uuid required' });

    const scoreDelta = Number(score_delta) || 0;
    const kickDelta  = Number(kick_count_delta) || 0;
    const voteDelta  = Number(vote_count_delta) || 0;

    // Merge kieu DELTA giong het /api/sync (xem giai thich chi tiet o do) — dam bao 1 nguoi choi
    // duoc sync tu 2 server gan nhu cung luc van cong dung, khong ai "thang" ai.
    const setStage = {
      lastName: name ? name : { $ifNull: ['$lastName', 'Unknown'] },
      score: { $add: [{ $ifNull: ['$score', 100] }, scoreDelta] },
      kickCount: { $add: [{ $ifNull: ['$kickCount', 0] }, kickDelta] },
      voteCount: { $add: [{ $ifNull: ['$voteCount', 0] }, voteDelta] },
      griefer: griefer === true ? true : { $ifNull: ['$griefer', false] },
      serverName: server_name ? server_name : { $ifNull: ['$serverName', ''] },
      lastSeen: new Date(),
    };
    if (grief_break_count !== undefined) setStage.grief_break_count = grief_break_count;
    if (is_new_player     !== undefined) setStage.is_new_player   = is_new_player;

    await Player.updateOne(
      { uuid },
      [
        { $set: setStage },
        { $set: { banned: { $lt: ['$score', BAN_THRESHOLD] } } },
      ],
      { upsert: true }
    );

    const fresh = await Player.findOne({ uuid }).lean();

    const updates = [];
    if (fresh) {
      const hasPending = fresh.pendingScore !== null || fresh.pendingBan !== null || fresh.pendingGriefer !== null || fresh.pendingKick !== null || fresh.pendingRole !== null;
      if (hasPending) {
        const entry = { uuid: fresh.uuid };
        if (fresh.pendingScore   !== null) entry.score      = fresh.pendingScore;
        if (fresh.pendingBan     !== null) entry.banned     = fresh.pendingBan;
        if (fresh.pendingGriefer !== null) entry.griefer    = fresh.pendingGriefer;
        if (fresh.pendingKick    !== null) entry.kickReason = fresh.pendingKick;
        if (fresh.pendingRole    !== null) entry.role       = fresh.pendingRole;
        updates.push(entry);
        await Player.updateOne({ uuid }, { $set: { pendingScore: null, pendingBan: null, pendingGriefer: null, pendingKick: null, pendingRole: null } });
      }
    }

    console.log(`🔄 Player delta-synced: ${name || uuid} (Δscore=${scoreDelta}, Δkick=${kickDelta}, Δvote=${voteDelta})`);

    return res.json({
      ok: true, uuid,
      score: fresh?.score, kickCount: fresh?.kickCount, voteCount: fresh?.voteCount,
      griefer: fresh?.griefer, banned: fresh?.banned,
      updates,
    });
  } catch (err) {
    console.error('[sync/update] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/pending-updates ← plugin poll mỗi 2 giây
app.get('/api/pending-updates', requireSecret, async (req, res) => {
  try {
    const players = await Player.find({
      $or: [
        { pendingScore:   { $ne: null } },
        { pendingBan:     { $ne: null } },
        { pendingGriefer: { $ne: null } },
        { pendingKick:    { $ne: null } },
        { pendingRole:    { $ne: null } }
      ]
    }).lean();

    const updates = players.map(p => {
      const entry = { uuid: p.uuid };
      if (p.pendingScore   !== null) entry.score      = p.pendingScore;
      if (p.pendingBan     !== null) entry.banned     = p.pendingBan;
      if (p.pendingGriefer !== null) entry.griefer    = p.pendingGriefer;
      if (p.pendingKick    !== null) entry.kickReason = p.pendingKick;
      if (p.pendingRole    !== null) entry.role       = p.pendingRole;
      return entry;
    });

    if (players.length > 0) {
      await Player.updateMany(
        { _id: { $in: players.map(p => p._id) } },
        { $set: { pendingScore: null, pendingBan: null, pendingGriefer: null, pendingKick: null, pendingRole: null } }
      );
    }

    return res.json({ updates, count: updates.length });
  } catch (err) {
    console.error('[pending-updates] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/sync  ← (backward compat — periodic sync cũ)
app.post('/api/sync', requireSecret, async (req, res) => {
  try {
    const { server_name, players = [], team_stats = [], ip, port, desc, mode_name, map_name, player_count } = req.body;

    if (server_name) {
      const prev = gameServers.get(server_name) || {};
      gameServers.set(server_name, {
        serverName: server_name,
        ip: ip || prev.ip || '',
        port: (port !== undefined && port !== null) ? port : (prev.port ?? null),
        desc: (desc !== undefined) ? desc : (prev.desc || ''),
        modeName: mode_name || prev.modeName || '',
        mapName: map_name || prev.mapName || '',
        playerCount: (player_count !== undefined) ? player_count : players.length,
        lastSeen: Date.now(),
      });
    }

    const validPlayers = players.filter(p => p && p.uuid);
    if (validPlayers.length === 0) {
      return res.json({ ok: true, updates: [], results: [], received: players.length });
    }

    const uuids = validPlayers.map(p => p.uuid);

    // ===== Merge kieu DELTA (khong con overwrite tuyet doi) =====
    // Moi server gui "chenh lech" (score_delta, kick_count_delta, vote_count_delta) so voi lan sync
    // truoc cua CHINH NO. Dung pipeline-update ($add tren gia tri hien co trong Mongo, co $ifNull cho
    // truong hop player moi/upsert) -> ket qua LUON cong dung du 4 server cung sync gan nhu dong thoi,
    // khong con chuyen "ai sync sau thi thang" nua. banned duoc tinh lai NGAY SAU KHI cong diem, tu
    // gia tri score MOI (khong tin score/banned server tu gui len). griefer chi "leo thang" len true,
    // khong bao gio bi ha xuong false qua duong nay (giefer=false tu 1 server khac khong duoc phep xoa
    // co giefer=true da co) — pardon griefer chi thuc hien qua dashboard (pendingGriefer).
    const bulkOps = validPlayers.map(p => {
      const scoreDelta = Number(p.score_delta) || 0;
      const kickDelta  = Number(p.kick_count_delta) || 0;
      const voteDelta  = Number(p.vote_count_delta) || 0;

      const setStage = {
        uuid: p.uuid,
        lastName: p.name ? p.name : { $ifNull: ['$lastName', 'Unknown'] },
        score: { $add: [{ $ifNull: ['$score', 100] }, scoreDelta] },
        kickCount: { $add: [{ $ifNull: ['$kickCount', 0] }, kickDelta] },
        voteCount: { $add: [{ $ifNull: ['$voteCount', 0] }, voteDelta] },
        griefer: p.griefer === true ? true : { $ifNull: ['$griefer', false] },
        serverName: server_name ? server_name : { $ifNull: ['$serverName', ''] },
        lastSeen: new Date(),
      };
      if (p.grief_break_count !== undefined) setStage.grief_break_count = p.grief_break_count;
      if (p.is_new_player     !== undefined) setStage.is_new_player   = p.is_new_player;

      return {
        updateOne: {
          filter: { uuid: p.uuid },
          update: [
            { $set: setStage },
            { $set: { banned: { $lt: ['$score', BAN_THRESHOLD] } } }, // tinh lai TU score da hop nhat
          ],
          upsert: true,
        }
      };
    });

    if (bulkOps.length > 0) {
      await Player.bulkWrite(bulkOps, { ordered: false });
    }

    // 1 round-trip: doc lai gia tri CANONICAL (da hop nhat) de tra ve cho plugin — plugin se dung de
    // cap nhat local + RESET baseline (delta lan sync ke tiep chi tinh tu day, khong cong don 2 lan).
    const freshDocs = await Player.find({ uuid: { $in: uuids } }).lean();
    const freshMap = new Map(freshDocs.map(d => [d.uuid, d]));

    const updates = [];
    const results = [];
    const pendingClearOps = [];

    for (const uuid of uuids) {
      const fresh = freshMap.get(uuid);
      if (!fresh) continue;

      results.push({
        uuid: fresh.uuid, score: fresh.score, kickCount: fresh.kickCount,
        voteCount: fresh.voteCount, griefer: fresh.griefer, banned: fresh.banned,
      });

      const hasPending = fresh.pendingScore !== null || fresh.pendingBan !== null || fresh.pendingGriefer !== null || fresh.pendingKick !== null || fresh.pendingRole !== null;
      if (hasPending) {
        const entry = { uuid: fresh.uuid };
        if (fresh.pendingScore   !== null) entry.score      = fresh.pendingScore;
        if (fresh.pendingBan     !== null) entry.banned     = fresh.pendingBan;
        if (fresh.pendingGriefer !== null) entry.griefer    = fresh.pendingGriefer;
        if (fresh.pendingKick    !== null) entry.kickReason = fresh.pendingKick;
        if (fresh.pendingRole    !== null) entry.role       = fresh.pendingRole;
        updates.push(entry);
        pendingClearOps.push({
          updateOne: {
            filter: { uuid: fresh.uuid },
            update: { $set: { pendingScore: null, pendingBan: null, pendingGriefer: null, pendingKick: null, pendingRole: null } },
          }
        });
      }
    }

    if (pendingClearOps.length > 0) {
      await Player.bulkWrite(pendingClearOps, { ordered: false });
    }

    return res.json({ ok: true, updates, results, received: players.length });
  } catch (err) {
    console.error('[sync] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/player-update (NEW - per-player 30s poll)
app.get('/api/player-update', requireSecret, async (req, res) => {
  try {
    const { uuid } = req.query;
    if (!uuid) return res.status(400).json({ error: 'uuid required' });
    
    const doc = await Player.findOne({ uuid }).lean();
    if (!doc) return res.json({ update: null });
    
    // Only return update if there are pending changes
    const hasPending = doc.pendingScore !== null || doc.pendingBan !== null || 
                       doc.pendingGriefer !== null || doc.pendingKick !== null || doc.pendingRole !== null;
    
    if (!hasPending) return res.json({ update: null });
    
    const update = { uuid: doc.uuid };
    if (doc.pendingScore !== null) update.score = doc.pendingScore;
    if (doc.pendingBan !== null) update.banned = doc.pendingBan;
    if (doc.pendingGriefer !== null) update.griefer = doc.pendingGriefer;
    if (doc.pendingKick !== null) update.kickReason = doc.pendingKick;
    if (doc.pendingRole !== null) update.role = doc.pendingRole;
    
    // Clear pending after sending
    await Player.updateOne({ uuid }, { $set: { 
      pendingScore: null, pendingBan: null, 
      pendingGriefer: null, pendingKick: null, pendingRole: null 
    }});
    
    return res.json({ update });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/sync/role-update (NEW)
app.post('/api/sync/role-update', requireSecret, async (req, res) => {
  try {
    const { uuid, role, name, server_name } = req.body;
    if (!uuid || !role) return res.status(400).json({ error: 'uuid and role required' });
    
    const validRoles = ['player', 'admin', 'co-owner', 'owner'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'invalid role' });
    
    const doc = await Player.findOneAndUpdate(
      { uuid },
      { $set: { role, ...(name ? { lastName: name } : {}), ...(server_name ? { serverName: server_name } : {}), lastSeen: new Date() } },
      { new: true, upsert: true }
    );
    
    pushUpdate(doc.uuid, { role });
    console.log(`[role-update] ${doc.lastName} (${uuid}) → ${role}`);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  Admin REST API
// ═══════════════════════════════════════════════════════

app.get('/api/players', async (req, res) => {
  try {
    const { search = '', page = 1, limit = 30, sort = 'lastName', order = 'asc', role = '', status = '', server_name = '' } = req.query;
    let q = search ? { $or: [
      { lastName: { $regex: search, $options: 'i' } },
      { uuid: { $regex: search, $options: 'i' } },
      { serverName: { $regex: search, $options: 'i' } },
    ] } : {};
    if (server_name) q = { ...q, serverName: server_name };
    if (role) q = { ...q, role };
    if (status === 'banned') q = { ...q, banned: true };
    else if (status === 'griefer') q = { ...q, griefer: true };
    else if (status === 'atrisk') q = { ...q, score: { $lt: 50, $gte: 30 } };
    const sortObj = { [sort]: order === 'desc' ? -1 : 1 };
    const total = await Player.countDocuments(q);
    const players = await Player.find(q).sort(sortObj).skip((page - 1) * limit).limit(Number(limit)).lean();
    return res.json({ total, page: Number(page), limit: Number(limit), players });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/players/:id', async (req, res) => {
  try {
    const isObjId = mongoose.Types.ObjectId.isValid(req.params.id);
    const doc = isObjId
      ? await Player.findById(req.params.id).lean()
      : await Player.findOne({ uuid: req.params.id }).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    return res.json(doc);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/servers', (req, res) => {
  const now = Date.now();
  const servers = Array.from(gameServers.values())
    .map(s => ({
      ...s,
      online: (now - s.lastSeen) < SERVER_ONLINE_THRESHOLD_MS,
      syncEnabled: globalSyncEnabled && (perServerEnabled.has(s.serverName) ? perServerEnabled.get(s.serverName) : true),
    }))
    .sort((a, b) => a.serverName.localeCompare(b.serverName));
  return res.json({ servers, total: servers.length, globalSyncEnabled, forceSyncNonce: globalForceSyncNonce });
});

// GET /api/sync/control — plugin (Java) poll endpoint nay moi ~5s de biet co duoc sync khong
// va co lenh "sync ngay" moi khong (force_sync_nonce). Dung requireSecret giong cac route /api/sync* khac.
app.get('/api/sync/control', requireSecret, (req, res) => {
  const { server_name } = req.query;
  const enabled = globalSyncEnabled && (perServerEnabled.has(server_name) ? perServerEnabled.get(server_name) : true);
  return res.json({ enabled, force_sync_nonce: globalForceSyncNonce });
});

// POST /api/servers/sync-toggle  body: { enabled: bool, server_name?: string }
// Khong co server_name -> ap dung cho TAT CA server (cong tac tong). Co server_name -> chi rieng server do.
app.post('/api/servers/sync-toggle', (req, res) => {
  try {
    const { enabled, server_name } = req.body;
    if (server_name) {
      perServerEnabled.set(server_name, !!enabled);
    } else {
      globalSyncEnabled = !!enabled;
    }
    return res.json({ ok: true, globalSyncEnabled, server_name: server_name || null, enabled: !!enabled });
  } catch (err) {
    console.error('[sync-toggle] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/force-sync — tang nonce toan cuc. Tat ca server dang poll /api/sync/control
// se thay nonce moi trong vong toi da ~5s va goi syncWithBackend(force=true) ngay lap tuc, cung 1 luc.
app.post('/api/servers/force-sync', (req, res) => {
  try {
    globalForceSyncNonce++;
    return res.json({ ok: true, force_sync_nonce: globalForceSyncNonce });
  } catch (err) {
    console.error('[force-sync] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/connections', (req, res) => {
  const servers = [];
  for (const [ws, info] of connectedServers) {
    servers.push({ serverName: info.serverName, connected: ws.readyState === WebSocket.OPEN, lastPing: info.lastPing });
  }
  return res.json({ servers, count: servers.length });
});

app.patch('/api/players/:id/score', async (req, res) => {
  try {
    const { score } = req.body;
    if (score === undefined || isNaN(score)) return res.status(400).json({ error: 'score required' });
    const clamped = Math.max(0, Math.min(100, Number(score)));
    const isObjId = mongoose.Types.ObjectId.isValid(req.params.id);
    const q = isObjId ? { _id: req.params.id } : { uuid: req.params.id };
    const doc = await Player.findOneAndUpdate(q, { $set: { score: clamped, pendingScore: clamped } }, { new: true });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    pushUpdate(doc.uuid, { score: clamped });
    sendDiscordWebhook('📝 Score changed (Web)', `**${doc.lastName}** → ${clamped}₫`, 0x00d2ff);
    return res.json({ ok: true, player: doc });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/players/:id/role', async (req, res) => {
  try {
    const { role } = req.body;
    const validRoles = ['player', 'admin', 'co-owner', 'owner'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'invalid role' });
    const isObjId = mongoose.Types.ObjectId.isValid(req.params.id);
    const q = isObjId ? { _id: req.params.id } : { uuid: req.params.id };
    const doc = await Player.findOneAndUpdate(q, { $set: { role, pendingRole: role } }, { new: true });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    pushUpdate(doc.uuid, { role });
    sendDiscordWebhook('👑 Role Changed (Web)', `**${doc.lastName}** → ${role}`, 0xa29bfe);
    return res.json({ ok: true, player: doc });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/players/:id/ban', async (req, res) => {
  try {
    const isObjId = mongoose.Types.ObjectId.isValid(req.params.id);
    const q = isObjId ? { _id: req.params.id } : { uuid: req.params.id };
    const doc = await Player.findOneAndUpdate(q, { $set: { banned: true, score: 0, pendingBan: true, pendingScore: 0 } }, { new: true });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    pushUpdate(doc.uuid, { banned: true, score: 0 });
    sendDiscordWebhook('🔴 BAN (Web)', `**${doc.lastName}** đã bị cấm qua Web Dashboard`, 0xff4757);
    return res.json({ ok: true, player: doc });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/players/:id/pardon', async (req, res) => {
  try {
    const isObjId = mongoose.Types.ObjectId.isValid(req.params.id);
    const q = isObjId ? { _id: req.params.id } : { uuid: req.params.id };
    const doc = await Player.findOneAndUpdate(q, { $set: { banned: false, griefer: false, score: BAN_THRESHOLD, pendingBan: false, pendingGriefer: false, pendingScore: BAN_THRESHOLD } }, { new: true });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    pushUpdate(doc.uuid, { banned: false, griefer: false, score: BAN_THRESHOLD });
    sendDiscordWebhook('🟢 Pardon (Web)', `**${doc.lastName}** đã được gỡ cấm qua Web Dashboard`, 0x2ed573);
    return res.json({ ok: true, player: doc });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/players/:id/kick', async (req, res) => {
  try {
    const { reason = 'Admin kick via dashboard' } = req.body;
    const isObjId = mongoose.Types.ObjectId.isValid(req.params.id);
    const q = isObjId ? { _id: req.params.id } : { uuid: req.params.id };
    const doc = await Player.findOne(q);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const newScore = Math.max(0, doc.score - 30);
    doc.score = newScore;
    doc.kickCount = (doc.kickCount || 0) + 1;
    doc.kickReasons = [...(doc.kickReasons || []), reason];
    doc.pendingScore = newScore;
    doc.pendingBan = newScore < BAN_THRESHOLD;
    doc.pendingKick = reason;
    await doc.save();
    pushUpdate(doc.uuid, { score: newScore, kick: true, kickReason: reason, ban: newScore < BAN_THRESHOLD });
    sendDiscordWebhook('🦶 Kick (Web)', `**${doc.lastName}** bị kick — Lý do: ${reason} — Score: ${newScore}₫`, 0xffa502);
    return res.json({ ok: true, player: doc });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/players/:id/griefer', async (req, res) => {
  try {
    const griefer = req.body.griefer !== false;
    const isObjId = mongoose.Types.ObjectId.isValid(req.params.id);
    const q = isObjId ? { _id: req.params.id } : { uuid: req.params.id };
    const doc = await Player.findOneAndUpdate(q, { $set: { griefer, pendingGriefer: griefer } }, { new: true });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    pushUpdate(doc.uuid, { griefer });
    sendDiscordWebhook(griefer ? '🟡 Griefer ON (Web)' : '🟢 Griefer OFF (Web)', `**${doc.lastName}** — griefer ${griefer ? 'ON' : 'OFF'}`, griefer ? 0xffa502 : 0x2ed573);
    return res.json({ ok: true, player: doc });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/players/:id', async (req, res) => {
  try {
    const isObjId = mongoose.Types.ObjectId.isValid(req.params.id);
    const q = isObjId ? { _id: req.params.id } : { uuid: req.params.id };
    await Player.deleteOne(q);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const total = await Player.countDocuments();
    const banned = await Player.countDocuments({ banned: true });
    const griefer = await Player.countDocuments({ griefer: true });
    const atRisk = await Player.countDocuments({ score: { $lt: 50, $gte: BAN_THRESHOLD } });
    const avg = await Player.aggregate([{ $group: { _id: null, avg: { $avg: '$score' } } }]);
        const admins = await Player.countDocuments({ role: 'admin' });
    const coOwners = await Player.countDocuments({ role: 'co-owner' });
return res.json({
      total, banned, griefer, atRisk,
      avgScore: Math.round(avg[0]?.avg ?? 0),
      admins, coOwners,
      connectedServers: connectedServers.size,
      onlineServers: Array.from(gameServers.values()).filter(s => (Date.now() - s.lastSeen) < SERVER_ONLINE_THRESHOLD_MS).length,
      totalServers: gameServers.size,
      globalSyncEnabled,
      discordBot: discordReady,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Serve static files ───────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

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
    server.listen(PORT, () => {
      console.log(`🚀 Trust Backend running on http://localhost:${PORT}`);
      console.log(`📢 Discord webhook: ${DISCORD_WEBHOOK_URL ? 'configured' : 'not set'}`);
      initDiscordBot();
    });
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });
