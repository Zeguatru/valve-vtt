// ═══════════════════════════════════════════════════
//  VALVE VTT — Backend Server
//  Stack: Node.js + ws (WebSocket) + JSON file (sem compilação nativa)
// ═══════════════════════════════════════════════════
const http = require('http');
const fs   = require('fs');
const path = require('path');
const WebSocket = require('ws');

// ── CONFIG ──────────────────────────────────────────
const PORT    = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'valve-data.json');

// ── BANCO DE DADOS (JSON simples) ──────────────────
// Estrutura: { rooms: { [code]: { masterName, sessionName, createdAt, players: { [id]: { name, fichaData } } } } }

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch(e) { console.error('Erro ao ler banco:', e.message); }
  return { rooms: {} };
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch(e) { console.error('Erro ao salvar banco:', e.message); }
}

// Carrega dados ao iniciar
let db = loadDB();

// Salva a cada 10 segundos automaticamente
setInterval(() => saveDB(db), 10000);

// ── HTTP SERVER (serve os arquivos do frontend) ─────
// Detecta o caminho correto automaticamente (local e Railway)
function findFrontendDir() {
  const candidates = [
    path.join(__dirname, '..', 'frontend'),
    path.join(process.cwd(), 'frontend'),
    path.join(__dirname, 'frontend'),
  ];
  for (const dir of candidates) {
    try { if (fs.existsSync(path.join(dir, 'index.html'))) return dir; } catch(e) {}
  }
  return candidates[0];
}
const frontendDir = findFrontendDir();
console.log('Frontend dir:', frontendDir);

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  let filePath = path.join(frontendDir, urlPath === '/' ? 'index.html' : urlPath);

  // Segurança: impede path traversal
  if (!filePath.startsWith(frontendDir)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback — sempre serve o index.html
      fs.readFile(path.join(frontendDir, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(500); res.end('Erro interno'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
      return;
    }
    const mimes = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
    const ext  = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimes[ext] || 'text/plain' });
    res.end(data);
  });
});

// ── WEBSOCKET ────────────────────────────────────────
const wss = new WebSocket.Server({ server });

// Estado em memória dos WebSockets ativos
// liveRooms: { [code]: { masterWs: WebSocket|null, players: { [id]: { ws, name, fichaData } } } }
const liveRooms = {};

// ── HELPERS ──────────────────────────────────────────
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = 'VALVE-';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastRoom(code, data, exclude = null) {
  const room = liveRooms[code];
  if (!room) return;
  const msg = JSON.stringify(data);
  if (room.masterWs && room.masterWs !== exclude && room.masterWs.readyState === WebSocket.OPEN) {
    room.masterWs.send(msg);
  }
  Object.values(room.players).forEach(p => {
    if (p.ws && p.ws !== exclude && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
    }
  });
}

function playersSnapshot(code) {
  const room = liveRooms[code];
  if (!room) return {};
  const snap = {};
  Object.entries(room.players).forEach(([id, p]) => {
    snap[id] = { id, name: p.name, online: !!(p.ws && p.ws.readyState === WebSocket.OPEN) };
  });
  return snap;
}

// ── MENSAGENS ────────────────────────────────────────
function handleMsg(ws, msg) {
  switch (msg.type) {

    // ── MESTRE CRIA SALA ──────────────────────────
    case 'create_room': {
      const { masterName, sessionName } = msg;
      if (!masterName || !sessionName) return;

      let code;
      let attempts = 0;
      do { code = genCode(); attempts++; } while (db.rooms[code] && attempts < 20);

      // Salva no banco JSON
      db.rooms[code] = { masterName, sessionName, createdAt: Date.now(), players: {} };
      saveDB(db);

      // Registra na memória
      liveRooms[code] = { masterWs: ws, players: {} };
      ws._role     = 'master';
      ws._roomCode = code;
      ws._name     = masterName;

      send(ws, { type: 'room_created', roomCode: code, sessionName, masterName });
      console.log(`[SALA CRIADA] ${code} — Mestre: ${masterName}`);
      break;
    }

    // ── JOGADOR ENTRA ─────────────────────────────
    case 'join_room': {
      const { playerName, roomCode } = msg;
      if (!playerName || !roomCode) return;
      const code = roomCode.trim().toUpperCase();

      // Verifica se a sala existe
      const dbRoom = db.rooms[code];
      if (!dbRoom) {
        send(ws, { type: 'room_error', message: 'Sala não encontrada. Verifique o código.' });
        return;
      }

      // Garante que a sala está em memória
      if (!liveRooms[code]) {
        liveRooms[code] = { masterWs: null, players: {} };
        // Restaura jogadores do banco
        Object.entries(dbRoom.players || {}).forEach(([id, p]) => {
          liveRooms[code].players[id] = { ws: null, name: p.name, fichaData: p.fichaData || {} };
        });
      }

      const playerId = genId();
      liveRooms[code].players[playerId] = { ws, name: playerName, fichaData: {} };
      ws._role     = 'player';
      ws._roomCode = code;
      ws._name     = playerName;
      ws._playerId = playerId;

      // Persiste no banco
      if (!db.rooms[code].players) db.rooms[code].players = {};
      db.rooms[code].players[playerId] = { name: playerName, fichaData: {} };
      saveDB(db);

      send(ws, { type: 'room_joined', roomCode: code, sessionName: dbRoom.sessionName, playerId });
      broadcastRoom(code, { type: 'players_update', players: playersSnapshot(code) });
      console.log(`[ENTROU] ${playerName} na sala ${code}`);
      break;
    }

    // ── RECONEXÃO ─────────────────────────────────
    case 'reconnect': {
      const { role, name, roomCode } = msg;
      const code = roomCode?.toUpperCase();
      if (!code || !db.rooms[code]) return;

      const dbRoom = db.rooms[code];
      if (!liveRooms[code]) liveRooms[code] = { masterWs: null, players: {} };

      ws._roomCode = code;
      ws._name     = name;
      ws._role     = role;

      if (role === 'master') {
        liveRooms[code].masterWs = ws;
        send(ws, { type: 'room_created', roomCode: code, sessionName: dbRoom.sessionName, masterName: name });
        send(ws, { type: 'players_update', players: playersSnapshot(code) });
      } else {
        const playerId = genId();
        ws._playerId = playerId;
        liveRooms[code].players[playerId] = { ws, name, fichaData: {} };
        send(ws, { type: 'room_joined', roomCode: code, sessionName: dbRoom.sessionName, playerId });
        broadcastRoom(code, { type: 'players_update', players: playersSnapshot(code) });
      }
      console.log(`[RECONECTADO] ${name} como ${role} na sala ${code}`);
      break;
    }

    // ── JOGADOR ENVIA DADOS DA FICHA ──────────────
    case 'ficha_data': {
      if (ws._role !== 'player' || !ws._roomCode) return;
      const code = ws._roomCode;
      const room = liveRooms[code];
      if (!room) return;

      // Atualiza em memória
      if (room.players[ws._playerId]) {
        room.players[ws._playerId].fichaData = msg.fichaData;
      }

      // Persiste no banco
      if (db.rooms[code]?.players?.[ws._playerId]) {
        db.rooms[code].players[ws._playerId].fichaData = msg.fichaData;
        // Salve será feito pelo intervalo de 10s (não sobrecarrega o disco)
      }

      // Encaminha para o mestre
      if (room.masterWs && room.masterWs.readyState === WebSocket.OPEN) {
        send(room.masterWs, { type: 'ficha_update', playerId: ws._playerId, fichaData: msg.fichaData });
      }
      break;
    }

    // ── MESTRE PEDE FICHA DE UM JOGADOR ──────────
    case 'request_ficha': {
      if (ws._role !== 'master' || !ws._roomCode) return;
      const room = liveRooms[ws._roomCode];
      if (!room) return;
      const { playerId } = msg;
      const player = room.players[playerId];

      if (player?.ws?.readyState === WebSocket.OPEN) {
        // Pede para o jogador enviar dados atuais
        send(player.ws, { type: 'send_ficha' });
      } else {
        // Envia do banco
        const cached = db.rooms[ws._roomCode]?.players?.[playerId]?.fichaData || {};
        send(ws, { type: 'ficha_update', playerId, fichaData: cached });
      }
      break;
    }

    case 'pong': ws._alive = true; break;
  }
}

function handleDisconnect(ws) {
  const { _role, _roomCode, _name, _playerId } = ws;
  if (!_roomCode || !liveRooms[_roomCode]) return;
  const room = liveRooms[_roomCode];

  if (_role === 'master') {
    room.masterWs = null;
    console.log(`[MESTRE SAIU] sala ${_roomCode}`);
    broadcastRoom(_roomCode, { type: 'master_left' });
  } else if (_role === 'player' && _playerId) {
    if (room.players[_playerId]) room.players[_playerId].ws = null;
    console.log(`[JOGADOR SAIU] ${_name} da sala ${_roomCode}`);
    broadcastRoom(_roomCode, { type: 'players_update', players: playersSnapshot(_roomCode) });
  }
}

// ── CONEXÕES ─────────────────────────────────────────
wss.on('connection', (ws) => {
  ws._alive    = true;
  ws._role     = null;
  ws._roomCode = null;
  ws._name     = null;
  ws._playerId = null;

  ws.on('pong', () => { ws._alive = true; });
  ws.on('message', (raw) => {
    try { handleMsg(ws, JSON.parse(raw)); }
    catch(e) { console.error('Parse error:', e.message); }
  });
  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', (e) => console.error('WS error:', e.message));
});

// ── KEEPALIVE ─────────────────────────────────────────
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws._alive) { ws.terminate(); return; }
    ws._alive = false;
    try { ws.ping(); } catch(e) {}
  });
}, 30000);

// ── LIMPEZA DE SALAS ANTIGAS (mais de 48h) ───────────
setInterval(() => {
  const cutoff = Date.now() - 48 * 3600 * 1000;
  let changed  = false;
  Object.entries(db.rooms).forEach(([code, room]) => {
    if (room.createdAt < cutoff) {
      delete db.rooms[code];
      delete liveRooms[code];
      changed = true;
    }
  });
  if (changed) saveDB(db);
}, 3600000);

// ── INICIAR ────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n══════════════════════════════════════');
  console.log('  VALVE VTT — Servidor Ativo');
  console.log(`  Porta: ${PORT}`);
  console.log(`  Acesse: http://localhost:${PORT}`);
  console.log('══════════════════════════════════════\n');
});

process.on('uncaughtException', (err) => {
  console.error('ERRO FATAL:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('PROMISE REJEITADA:', reason);
});
