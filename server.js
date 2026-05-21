const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ─── Config ───────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'mlkbelga_dev_king_2024';
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

[UPLOADS_DIR, DATA_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const upload = multer({ storage: multer.memoryStorage() }); // memória, sem disco
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Store de Sessão em Arquivo (persiste no Render via users.json) ───────────
// Implementa a interface RemoteAuth Store usando arquivo JSON
class FileStore {
  constructor(userId) { this.userId = userId; }

  async sessionExists({ session }) {
    const users = readUsers();
    const user = users.find(u => u.id === this.userId);
    return !!(user?.waSession);
  }

  async save({ session }) {
    // Salva sessão zipada em base64 dentro do JSON do usuário
    const zipPath = path.join(DATA_DIR, `${this.userId}.zip`);
    if (fs.existsSync(zipPath)) {
      const data = fs.readFileSync(zipPath).toString('base64');
      const users = readUsers();
      const idx = users.findIndex(u => u.id === this.userId);
      if (idx !== -1) { users[idx].waSession = data; writeUsers(users); }
      fs.unlinkSync(zipPath);
    }
  }

  async extract({ session, path: destPath }) {
    const users = readUsers();
    const user = users.find(u => u.id === this.userId);
    if (user?.waSession) {
      const zipPath = destPath + '.zip';
      fs.writeFileSync(zipPath, Buffer.from(user.waSession, 'base64'));
    }
  }

  async delete({ session }) {
    const users = readUsers();
    const idx = users.findIndex(u => u.id === this.userId);
    if (idx !== -1) { delete users[idx].waSession; writeUsers(users); }
  }
}

// ─── Usuários ─────────────────────────────────────────────────────────────────
function readUsers() {
  // Tenta ler do arquivo, senão usa variável de ambiente (fallback Render)
  if (fs.existsSync(USERS_FILE)) {
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
  }
  if (process.env.USERS_DATA) {
    try { return JSON.parse(process.env.USERS_DATA); } catch { return []; }
  }
  return [];
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function findUser(username) {
  return readUsers().find(u => u.username === username);
}

async function ensureAdmin() {
  const users = readUsers();
  if (!users.find(u => u.role === 'admin')) {
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = await bcrypt.hash(adminPass, 10);
    users.push({
      id: 'admin',
      username: process.env.ADMIN_USERNAME || 'admin',
      password: hash,
      role: 'admin',
      active: true,
      createdAt: new Date().toISOString()
    });
    writeUsers(users);
    console.log(`👑 Admin criado: ${process.env.ADMIN_USERNAME || 'admin'} / ${adminPass}`);
  }
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token obrigatório' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido' }); }
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
    next();
  });
}

// ─── WhatsApp Manager ─────────────────────────────────────────────────────────
const waClients = {};

function getUserState(userId) {
  if (!waClients[userId]) {
    waClients[userId] = {
      client: null, isReady: false, contacts: [],
      dispatchTimer: null,
      dispatchState: {
        running: false, current: 0, total: 0, log: [],
        savedTargets: [], savedMessage: '', savedInterval: 10,
        savedMediaBuffer: null, savedMediaName: null, savedMediaMime: null,
        canResume: false
      }
    };
  }
  return waClients[userId];
}

function initWhatsAppForUser(userId) {
  const state = getUserState(userId);
  if (state.client) { try { state.client.destroy(); } catch(e) {} }

  const store = new FileStore(userId);

  const client = new Client({
    authStrategy: new RemoteAuth({
      clientId: userId,
      store,
      backupSyncIntervalMs: 300000 // salva sessão a cada 5 min
    }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
             '--disable-accelerated-2d-canvas','--no-first-run','--disable-gpu',
             '--single-process','--no-zygote']
    }
  });

  state.client = client;
  state.isReady = false;

  client.on('qr', async (qr) => {
    try {
      const qrDataUrl = await qrcode.toDataURL(qr);
      io.to(`user:${userId}`).emit('qr', qrDataUrl);
      io.to(`user:${userId}`).emit('status', { type: 'qr', message: 'Escaneie o QR Code' });
    } catch(e) {}
  });

  client.on('authenticated', () => {
    io.to(`user:${userId}`).emit('status', { type: 'authenticated', message: 'Autenticado! Carregando...' });
  });

  client.on('remote_session_saved', () => {
    console.log(`💾 Sessão salva para ${userId}`);
  });

  client.on('ready', async () => {
    console.log(`✅ WA pronto para ${userId}`);
    state.isReady = true;
    io.to(`user:${userId}`).emit('wa_ready', true);
    io.to(`user:${userId}`).emit('status', { type: 'ready', message: 'WhatsApp conectado!' });
    await loadContactsForUser(userId);
  });

  client.on('disconnected', () => {
    state.isReady = false;
    io.to(`user:${userId}`).emit('wa_ready', false);
    io.to(`user:${userId}`).emit('status', { type: 'disconnected', message: 'Desconectado' });
  });

  client.initialize();
}

async function loadContactsForUser(userId) {
  const state = getUserState(userId);
  try {
    io.to(`user:${userId}`).emit('status', { type: 'loading', message: 'Carregando contatos...' });
    const all = await state.client.getContacts();
    state.contacts = all
      .filter(c => c.name && c.isMyContact && !c.isGroup)
      .map(c => ({ id: c.id._serialized, name: c.name || c.pushname || 'Sem nome', number: c.number }));
    io.to(`user:${userId}`).emit('contacts', state.contacts);
    io.to(`user:${userId}`).emit('status', { type: 'ready', message: `${state.contacts.length} contatos` });
  } catch(e) {
    io.to(`user:${userId}`).emit('status', { type: 'error', message: 'Erro ao carregar contatos' });
  }
}

// ─── Disparo ──────────────────────────────────────────────────────────────────
function runDispatch(userId, targets, message, intervalSeconds, mediaBuffer, mediaName, mediaMime, resumeFrom) {
  const state = getUserState(userId);
  if (state.dispatchTimer) { clearInterval(state.dispatchTimer); state.dispatchTimer = null; }

  state.dispatchState.savedTargets = targets;
  state.dispatchState.savedMessage = message;
  state.dispatchState.savedInterval = intervalSeconds;
  state.dispatchState.savedMediaBuffer = mediaBuffer;
  state.dispatchState.savedMediaName = mediaName;
  state.dispatchState.savedMediaMime = mediaMime;
  state.dispatchState.canResume = false;

  const queue = targets.slice(resumeFrom || 0);
  let current = resumeFrom || 0;

  state.dispatchState.running = true;
  state.dispatchState.current = current;
  state.dispatchState.total = targets.length;
  if (!resumeFrom) state.dispatchState.log = [];

  io.to(`user:${userId}`).emit('dispatch_status', { running: true, current, total: targets.length, canResume: false });

  let media = null;
  if (mediaBuffer) {
    media = new MessageMedia(mediaMime, mediaBuffer.toString('base64'), mediaName);
  }

  const sendNext = async () => {
    if (queue.length === 0) {
      clearInterval(state.dispatchTimer); state.dispatchTimer = null;
      state.dispatchState.running = false; state.dispatchState.canResume = false;
      io.to(`user:${userId}`).emit('dispatch_status', { running: false, current: state.dispatchState.current, total: state.dispatchState.total, canResume: false });
      io.to(`user:${userId}`).emit('dispatch_done', { total: state.dispatchState.total });
      return;
    }

    const contact = queue.shift();
    current++; state.dispatchState.current = current;
    const msg = message.replace(/\{nome\}/gi, contact.name.split(' ')[0]);

    try {
      if (media) await state.client.sendMessage(contact.id, media, { caption: msg });
      else await state.client.sendMessage(contact.id, msg);
      const entry = { name: contact.name, number: contact.number, status: 'enviado', time: new Date().toLocaleTimeString('pt-BR') };
      state.dispatchState.log.push(entry);
      io.to(`user:${userId}`).emit('message_sent', entry);
    } catch(e) {
      const entry = { name: contact.name, number: contact.number, status: 'erro', time: new Date().toLocaleTimeString('pt-BR') };
      state.dispatchState.log.push(entry);
      io.to(`user:${userId}`).emit('message_error', entry);
    }
    io.to(`user:${userId}`).emit('dispatch_status', { running: true, current: state.dispatchState.current, total: state.dispatchState.total, canResume: false });
  };

  sendNext();
  if (queue.length > 0) state.dispatchTimer = setInterval(sendNext, intervalSeconds * 1000);
}

// ─── Rotas Auth ───────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = findUser(username);
  if (!user) return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  if (!user.active) return res.status(403).json({ error: 'Conta desativada. Fale com o administrador.' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, username: user.username, role: user.role });
});

// ─── Rotas Admin ──────────────────────────────────────────────────────────────
app.get('/api/admin/users', adminMiddleware, (req, res) => {
  res.json(readUsers().map(({ password, waSession, ...u }) => u));
});

app.post('/api/admin/users', adminMiddleware, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Campos obrigatórios' });
  const users = readUsers();
  if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Usuário já existe' });
  const hash = await bcrypt.hash(password, 10);
  const newUser = { id: `user_${Date.now()}`, username, password: hash, role: 'user', active: true, createdAt: new Date().toISOString() };
  users.push(newUser);
  writeUsers(users);
  const { password: _, ...safe } = newUser;
  res.json(safe);
});

app.patch('/api/admin/users/:id', adminMiddleware, (req, res) => {
  const users = readUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  if (users[idx].role === 'admin' && req.body.active === false) return res.status(400).json({ error: 'Não pode desativar o admin' });
  if (req.body.active !== undefined) users[idx].active = req.body.active;
  writeUsers(users);
  const { password, waSession, ...safe } = users[idx];
  res.json(safe);
});

app.delete('/api/admin/users/:id', adminMiddleware, (req, res) => {
  const users = readUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Não encontrado' });
  if (user.role === 'admin') return res.status(400).json({ error: 'Não pode deletar o admin' });
  if (waClients[user.id]?.client) try { waClients[user.id].client.destroy(); } catch(e) {}
  delete waClients[user.id];
  writeUsers(users.filter(u => u.id !== req.params.id));
  res.json({ success: true });
});

app.patch('/api/admin/users/:id/password', adminMiddleware, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Senha obrigatória' });
  const users = readUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  users[idx].password = await bcrypt.hash(password, 10);
  writeUsers(users);
  res.json({ success: true });
});

// ─── Rotas WhatsApp ───────────────────────────────────────────────────────────
app.post('/api/wa/connect', authMiddleware, (req, res) => {
  initWhatsAppForUser(req.user.id);
  res.json({ success: true });
});

app.post('/api/wa/disconnect', authMiddleware, (req, res) => {
  const state = waClients[req.user.id];
  if (state?.client) {
    try { state.client.destroy(); } catch(e) {}
    // Apaga sessão salva
    const users = readUsers();
    const idx = users.findIndex(u => u.id === req.user.id);
    if (idx !== -1) { delete users[idx].waSession; writeUsers(users); }
    delete waClients[req.user.id];
  }
  res.json({ success: true });
});

app.get('/api/wa/contacts', authMiddleware, (req, res) => {
  const state = getUserState(req.user.id);
  res.json({ contacts: state.contacts, isReady: state.isReady });
});

app.post('/api/wa/reload-contacts', authMiddleware, async (req, res) => {
  const state = getUserState(req.user.id);
  if (!state.isReady) return res.status(400).json({ error: 'WhatsApp não conectado' });
  await loadContactsForUser(req.user.id);
  res.json({ success: true });
});

app.post('/api/wa/dispatch', authMiddleware, upload.single('image'), (req, res) => {
  const { filters, message, interval, resume } = req.body;
  const state = getUserState(req.user.id);
  if (!state.isReady) return res.status(400).json({ error: 'WhatsApp não conectado' });

  if (resume === 'true' && state.dispatchState.canResume) {
    const ds = state.dispatchState;
    runDispatch(req.user.id, ds.savedTargets, ds.savedMessage, ds.savedInterval, ds.savedMediaBuffer, ds.savedMediaName, ds.savedMediaMime, ds.current);
    return res.json({ success: true, resumed: true });
  }

  if (!message) return res.status(400).json({ error: 'Mensagem obrigatória' });
  const keywords = (filters || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  let targets = keywords.length
    ? [...new Map(state.contacts.filter(c => keywords.some(k => c.name.toLowerCase().includes(k))).map(t => [t.id, t])).values()]
    : state.contacts;

  if (!targets.length) return res.status(400).json({ error: 'Nenhum contato encontrado' });

  const mediaBuffer = req.file ? req.file.buffer : null;
  runDispatch(req.user.id, targets, message, parseInt(interval) || 10, mediaBuffer, req.file?.originalname || null, req.file?.mimetype || null, 0);
  res.json({ success: true, count: targets.length });
});

app.post('/api/wa/stop', authMiddleware, (req, res) => {
  const state = getUserState(req.user.id);
  if (state.dispatchTimer) { clearInterval(state.dispatchTimer); state.dispatchTimer = null; }
  state.dispatchState.running = false;
  state.dispatchState.canResume = state.dispatchState.current < state.dispatchState.total;
  io.to(`user:${req.user.id}`).emit('dispatch_status', {
    running: false, current: state.dispatchState.current,
    total: state.dispatchState.total, canResume: state.dispatchState.canResume
  });
  res.json({ success: true });
});

// ─── Socket ───────────────────────────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Token obrigatório'));
  try { socket.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { next(new Error('Token inválido')); }
});

io.on('connection', (socket) => {
  const userId = socket.user.id;
  socket.join(`user:${userId}`);
  const state = getUserState(userId);
  socket.emit('wa_ready', state.isReady);
  socket.emit('status', { type: state.isReady ? 'ready' : 'waiting', message: state.isReady ? `${state.contacts.length} contatos disponíveis` : 'Conecte seu WhatsApp' });
  if (state.isReady) socket.emit('contacts', state.contacts);
  socket.emit('dispatch_status', { running: state.dispatchState.running, current: state.dispatchState.current, total: state.dispatchState.total, canResume: state.dispatchState.canResume });
});

// ─── Start ────────────────────────────────────────────────────────────────────
ensureAdmin().then(() => {
  server.listen(PORT, () => {
    console.log(`\n🟢 Servidor em http://localhost:${PORT}`);
    console.log(`👑 Admin: ${process.env.ADMIN_USERNAME || 'admin'} / ${process.env.ADMIN_PASSWORD || 'admin123'}\n`);
  });
});
