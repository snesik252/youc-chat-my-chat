const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

// ====== Хранилище данных ======
const DATA_FILE = path.join(__dirname, 'data.json');
let data = {
  users: {},        // { username: { passwordHash, friends: [], groups: [] } }
  messages: { general: [] },
  groups: {},
  sessions: {}      // token -> username (срок 7 дней)
};

if (fs.existsSync(DATA_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    data = { ...data, ...loaded };
    if (!data.messages.general) data.messages.general = [];
    if (!data.sessions) data.sessions = {};
  } catch (e) { console.error('Ошибка чтения data.json'); }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ====== Хелперы ======
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getUserByToken(token) {
  return data.sessions[token] ? data.users[data.sessions[token]] : null;
}

// ====== API регистрации / входа ======
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  if (data.users[username]) return res.status(400).json({ error: 'Пользователь уже существует' });

  const passwordHash = bcrypt.hashSync(password, 8);
  data.users[username] = {
    passwordHash,
    friends: [],
    groups: []
  };
  saveData();
  res.json({ success: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });

  const user = data.users[username];
  if (!user) return res.status(401).json({ error: 'Неверный ник или пароль' });

  const valid = bcrypt.compareSync(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Неверный ник или пароль' });

  const token = generateToken();
  data.sessions[token] = username;
  saveData();
  res.json({ token, username });
});

// Проверка сессии
app.get('/api/me', (req, res) => {
  const token = req.headers.authorization;
  if (!token || !data.sessions[token]) return res.status(401).json({ error: 'Не авторизован' });
  const username = data.sessions[token];
  res.json({ username });
});

// ====== AI-друг (встроенные ответы) ======
const aiReplies = {
  "привет": ["Привет! Как у тебя дела?", "Приветик!", "Здравствуй!"],
  "как дела": ["У меня всё отлично! А у тебя?", "Супер!", "Хорошо, спасибо что спросил."],
  "что делаешь": ["Общаюсь с тобой – лучшее занятие.", "Отвечаю на сообщения."],
  "пока": ["Пока! Береги себя.", "До встречи!", "Счастливо!"],
  "спасибо": ["Пожалуйста!", "Не за что.", "Всегда к твоим услугам."]
};
const randomPhrases = [
  "Интересно!", "Расскажи подробнее.", "Согласен.", "Это круто!",
  "Улыбнись!", "Ты классный собеседник.", "Хорошая мысль."
];

function getAIReply(userText) {
  const clean = userText.trim().toLowerCase().replace(/[^а-яёa-z0-9 ]/g, '');
  for (let key in aiReplies) {
    if (clean.indexOf(key) !== -1) {
      const answers = aiReplies[key];
      return answers[Math.floor(Math.random() * answers.length)];
    }
  }
  return randomPhrases[Math.floor(Math.random() * randomPhrases.length)];
}

// ====== Пользователи онлайн ======
const onlineUsers = new Map(); // socket.id -> username
const userSockets = new Map(); // username -> socket.id

io.on('connection', (socket) => {
  console.log('Подключился:', socket.id);

  // Идентификация (после входа или проверки сессии)
  socket.on('register', (username) => {
    if (!username || !data.users[username]) return;
    onlineUsers.set(socket.id, username);
    userSockets.set(username, socket.id);
    broadcastUsersList();
  });

  socket.on('disconnect', () => {
    const username = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    if (username) userSockets.delete(username);
    broadcastUsersList();
  });

  // ====== Чат ======
  socket.on('chat message', (msgData) => {
    const sender = onlineUsers.get(socket.id);
    if (!sender) return;
    const { text, image, target, isGroup } = msgData;
    const msg = {
      author: sender,
      text: text || '',
      image: image || null,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    if (isGroup) {
      if (!data.groups[target]) return;
      data.groups[target].messages.push(msg);
      data.groups[target].members.forEach(member => {
        const sockId = userSockets.get(member);
        if (sockId) io.to(sockId).emit('group message', { group: target, msg });
      });
    } else if (target === 'general') {
      data.messages.general.push(msg);
      if (data.messages.general.length > 200) data.messages.general.shift();
      io.emit('general message', msg);
    } else if (target === 'ai-bot') {
      const chatKey = getPrivateKey(sender, 'ai-bot');
      if (!data.messages[chatKey]) data.messages[chatKey] = [];
      data.messages[chatKey].push(msg);
      socket.emit('private message', msg);
      const aiReply = getAIReply(msg.text);
      const aiMsg = {
        author: '🤖 AI Друг',
        text: aiReply,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        fromAI: true
      };
      data.messages[chatKey].push(aiMsg);
      socket.emit('private message', aiMsg);
    } else {
      const receiver = target;
      const chatKey = getPrivateKey(sender, receiver);
      if (!data.messages[chatKey]) data.messages[chatKey] = [];
      data.messages[chatKey].push(msg);
      const recvSock = userSockets.get(receiver);
      if (recvSock) io.to(recvSock).emit('private message', msg);
      socket.emit('private message', msg);
    }
    saveData();
  });

  socket.on('get-history', (chatInfo) => {
    const { target, isGroup } = chatInfo;
    if (target === 'general') {
      socket.emit('chat-history', { target: 'general', messages: data.messages.general, isGroup: false });
      return;
    }
    if (isGroup) {
      socket.emit('chat-history', { target, messages: data.groups[target]?.messages || [], isGroup: true });
    } else {
      const myName = onlineUsers.get(socket.id);
      const chatKey = getPrivateKey(myName, target);
      socket.emit('chat-history', { target, messages: data.messages[chatKey] || [], isGroup: false });
    }
  });

  // ====== Друзья и группы (как раньше) ======
  // ... оставил без изменений для краткости, они будут как в предыдущей версии
});

function getPrivateKey(a, b) {
  return [a, b].sort().join(':');
}

function broadcastUsersList() {
  const list = [{ id: 'ai-bot', name: '🤖 AI Друг', isAI: true }];
  onlineUsers.forEach((name, id) => {
    list.push({ id, name, isAI: false });
  });
  io.emit('users-update', list);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));
