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

app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

const DATA_FILE = path.join(__dirname, 'data.json');
let data = {
  users: {},
  messages: { general: [] },
  groups: {},
  sessions: {}
};

if (fs.existsSync(DATA_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    data = { ...data, ...loaded };
    if (!data.messages.general) data.messages.general = [];
    if (!data.sessions) data.sessions = {};
    for (let user in data.users) {
      if (!data.users[user].avatar) data.users[user].avatar = '';
      if (!data.users[user].description) data.users[user].description = '';
      if (!data.users[user].friends) data.users[user].friends = [];
    }
  } catch (e) { console.error('Ошибка чтения data.json'); }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ====== API РЕГИСТРАЦИИ / ВХОДА ======
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  if (data.users[username]) return res.status(400).json({ error: 'Пользователь уже существует' });
  const passwordHash = bcrypt.hashSync(password, 8);
  data.users[username] = {
    passwordHash,
    friends: [],
    groups: [],
    avatar: '',
    description: ''
  };
  saveData();
  res.json({ success: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  const user = data.users[username];
  if (!user) return res.status(401).json({ error: 'Неверный ник или пароль' });
  if (!bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Неверный ник или пароль' });
  }
  const token = generateToken();
  data.sessions[token] = username;
  saveData();
  res.json({ token, username });
});

app.get('/api/me', (req, res) => {
  const token = req.headers.authorization;
  if (!token || !data.sessions[token]) return res.status(401).json({ error: 'Не авторизован' });
  const username = data.sessions[token];
  const user = data.users[username];
  res.json({ username, avatar: user?.avatar || '', description: user?.description || '' });
});

app.get('/api/user/:username', (req, res) => {
  const username = req.params.username;
  const user = data.users[username];
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ username, avatar: user.avatar || '', description: user.description || '' });
});

app.post('/api/update-profile', (req, res) => {
  const token = req.headers.authorization;
  if (!token || !data.sessions[token]) return res.status(401).json({ error: 'Не авторизован' });
  const username = data.sessions[token];
  const { avatar, description } = req.body;
  if (avatar !== undefined) data.users[username].avatar = avatar;
  if (description !== undefined) data.users[username].description = description;
  saveData();
  // Оповещаем всех об изменении аватара
  io.emit('avatar-updated', { username, avatar: data.users[username].avatar });
  res.json({ success: true, avatar: data.users[username].avatar, description: data.users[username].description });
});

// ====== AI-ДРУГ ======
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
    if (clean.includes(key)) {
      const answers = aiReplies[key];
      return answers[Math.floor(Math.random() * answers.length)];
    }
  }
  return randomPhrases[Math.floor(Math.random() * randomPhrases.length)];
}

// ====== ПОЛЬЗОВАТЕЛИ ОНЛАЙН ======
const onlineUsers = new Map(); // socket.id -> username
const userSockets = new Map(); // username -> socket.id

io.on('connection', (socket) => {
  console.log('Подключился:', socket.id);

  socket.on('register', (username) => {
    if (!username || !data.users[username]) return;
    onlineUsers.set(socket.id, username);
    userSockets.set(username, socket.id);
    socket.emit('user-data', {
      name: username,
      friends: data.users[username].friends || [],
      groups: getGroupsForUser(username),
      avatar: data.users[username].avatar || '',
      description: data.users[username].description || ''
    });
    broadcastUsersList();
  });

  socket.on('disconnect', () => {
    const username = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    if (username) userSockets.delete(username);
    broadcastUsersList();
  });

  // ====== СООБЩЕНИЯ ======
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

  // ====== ДРУЗЬЯ И ГРУППЫ ======
  socket.on('add-friend', (friendName) => {
    const myName = onlineUsers.get(socket.id);
    if (!myName || !data.users[friendName]) return;
    if (!data.users[myName].friends.includes(friendName)) {
      data.users[myName].friends.push(friendName);
      saveData();
      socket.emit('user-data', {
        name: myName,
        friends: data.users[myName].friends,
        groups: getGroupsForUser(myName),
        avatar: data.users[myName].avatar || '',
        description: data.users[myName].description || ''
      });
    }
  });

  socket.on('remove-friend', (friendName) => {
    const myName = onlineUsers.get(socket.id);
    if (!myName) return;
    data.users[myName].friends = data.users[myName].friends.filter(f => f !== friendName);
    saveData();
    socket.emit('user-data', {
      name: myName,
      friends: data.users[myName].friends,
      groups: getGroupsForUser(myName),
      avatar: data.users[myName].avatar || '',
      description: data.users[myName].description || ''
    });
  });

  socket.on('create-group', (groupData) => {
    const { name, members } = groupData;
    if (!name || data.groups[name]) return;
    if (!members || members.length < 1) return;
    const myName = onlineUsers.get(socket.id);
    const allMembers = [myName, ...members.filter(m => m !== myName)];
    data.groups[name] = { members: allMembers, messages: [] };
    saveData();
    allMembers.forEach(member => {
      const sockId = userSockets.get(member);
      if (sockId) {
        io.to(sockId).emit('user-data', {
          name: member,
          friends: data.users[member]?.friends || [],
          groups: getGroupsForUser(member),
          avatar: data.users[member]?.avatar || '',
          description: data.users[member]?.description || ''
        });
      }
    });
  });

  socket.on('change-name', (newName) => {
    const oldName = onlineUsers.get(socket.id);
    if (!oldName || !newName.trim() || data.users[newName.trim()]) return;
    const finalName = newName.trim();
    data.users[finalName] = data.users[oldName];
    delete data.users[oldName];
    for (let user in data.users) {
      const friends = data.users[user].friends;
      const idx = friends.indexOf(oldName);
      if (idx !== -1) friends[idx] = finalName;
    }
    onlineUsers.set(socket.id, finalName);
    userSockets.delete(oldName);
    userSockets.set(finalName, socket.id);
    saveData();
    socket.emit('user-data', {
      name: finalName,
      friends: data.users[finalName].friends,
      groups: getGroupsForUser(finalName),
      avatar: data.users[finalName].avatar || '',
      description: data.users[finalName].description || ''
    });
    broadcastUsersList();
  });

  // ====== WEBRTC ЗВОНКИ ======
  socket.on('call-user', ({ toId, offer }) => {
    const callerName = onlineUsers.get(socket.id) || 'Неизвестный';
    const receiverSocket = userSockets.get(toId); // toId здесь – имя получателя
    if (receiverSocket) {
      io.to(receiverSocket).emit('incoming-call', { from: callerName, offer });
    }
  });

  socket.on('answer-call', ({ to, answer }) => {
    const receiverSocket = userSockets.get(to);
    if (receiverSocket) {
      io.to(receiverSocket).emit('call-answered', { answer });
    }
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    const receiverSocket = userSockets.get(to);
    if (receiverSocket) {
      io.to(receiverSocket).emit('ice-candidate', { candidate });
    }
  });

  socket.on('end-call', ({ to }) => {
    const receiverSocket = userSockets.get(to);
    if (receiverSocket) {
      io.to(receiverSocket).emit('call-ended');
    }
  });
});

// ====== ВСПОМОГАТЕЛЬНЫЕ ======
function getPrivateKey(a, b) {
  return [a, b].sort().join(':');
}

function broadcastUsersList() {
  const list = [{ id: 'ai-bot', name: '🤖 AI Друг', isAI: true, avatar: '' }];
  onlineUsers.forEach((name, id) => {
    const user = data.users[name];
    list.push({
      id,
      name,
      isAI: false,
      avatar: user?.avatar || '',
      description: user?.description || ''
    });
  });
  io.emit('users-update', list);
}

function getGroupsForUser(userName) {
  const result = [];
  for (let groupName in data.groups) {
    if (data.groups[groupName].members.includes(userName)) {
      result.push(groupName);
    }
  }
  return result;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
