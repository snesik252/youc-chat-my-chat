const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

// ====== Supabase ======
const supabaseUrl = process.env.SUPABASE_URL || 'https://oafwaofiuczljckmxmko.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || 'ваш_сервисный_ключ';
const supabase = createClient(supabaseUrl, supabaseKey);

// Проверка подключения
(async () => {
  const { error } = await supabase.from('users').select('username').limit(1);
  if (error) console.error('❌ Supabase error:', error.message);
  else console.log('✅ Supabase подключена');
})();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function getUserByToken(token) {
  const { data } = await supabase.from('sessions').select('username').eq('token', token).maybeSingle();
  return data?.username || null;
}

// Тестовый аккаунт
async function ensureTestAccount() {
  const { data } = await supabase.from('users').select('*').eq('username', 'Алексей').maybeSingle();
  if (!data) {
    await supabase.from('users').insert([{
      username: 'Алексей',
      passwordHash: bcrypt.hashSync('1234', 8),
      friends: [],
      groups: [],
      avatar: '',
      description: 'Тестовый аккаунт'
    }]);
    console.log('✅ Аккаунт Алексей создан');
  }
}

// API
app.post('/api/register', async (req, res) => {
  try {
    const username = req.body.username?.trim();
    const password = req.body.password?.trim();
    if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });

    const { data: existingUser } = await supabase.from('users').select('username').eq('username', username).maybeSingle();
    if (existingUser) return res.status(400).json({ error: 'Пользователь уже существует' });

    await supabase.from('users').insert([{
      username,
      passwordHash: bcrypt.hashSync(password, 8),
      friends: [],
      groups: [],
      avatar: '',
      description: ''
    }]);
    console.log(`✅ Зарегистрирован: ${username}`);
    res.json({ success: true });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const username = req.body.username?.trim();
    const password = req.body.password?.trim();
    if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });

    console.log(`🔐 Попытка входа: ${username}`);
    const { data: user, error } = await supabase.from('users').select('*').eq('username', username).maybeSingle();
    if (error) {
      console.error('❌ Supabase error:', error.message);
      return res.status(500).json({ error: 'Ошибка базы данных' });
    }
    if (!user) {
      console.log(`❌ Пользователь ${username} не найден`);
      return res.status(401).json({ error: 'Неверный ник или пароль' });
    }

    if (!bcrypt.compareSync(password, user.passwordHash)) {
      console.log(`❌ Пароль для ${username} не совпадает`);
      return res.status(401).json({ error: 'Неверный ник или пароль' });
    }

    const token = generateToken();
    await supabase.from('sessions').insert([{ token, username }]);
    console.log(`✅ Успешный вход: ${username}`);
    res.json({ token, username });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/me', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  const username = await getUserByToken(token);
  if (!username) return res.status(401).json({ error: 'Не авторизован' });
  const { data: user } = await supabase.from('users').select('*').eq('username', username).maybeSingle();
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const { data: notifications } = await supabase.from('notifications').select('*').eq('username', username);
  res.json({ username: user.username, avatar: user.avatar, description: user.description, friends: user.friends, notifications });
});

app.get('/api/user/:username', async (req, res) => {
  const { data: user } = await supabase.from('users').select('*').eq('username', req.params.username).maybeSingle();
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ username: user.username, avatar: user.avatar, description: user.description, friends: user.friends });
});

app.post('/api/update-profile', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  const username = await getUserByToken(token);
  if (!username) return res.status(401).json({ error: 'Не авторизован' });
  const { avatar, description } = req.body;
  const updates = {};
  if (avatar !== undefined) updates.avatar = avatar;
  if (description !== undefined) updates.description = description;
  await supabase.from('users').update(updates).eq('username', username);
  io.emit('avatar-updated', { username, avatar: avatar || '' });
  res.json({ success: true });
});

// Запросы в друзья
app.get('/api/friend-requests', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  const username = await getUserByToken(token);
  if (!username) return res.status(401).json({ error: 'Не авторизован' });
  const { data } = await supabase.from('friend_requests').select('*').eq('to', username).eq('status', 'pending');
  res.json(data);
});

app.post('/api/send-friend-request', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  const from = await getUserByToken(token);
  const { to } = req.body;
  const { data: userFrom } = await supabase.from('users').select('friends').eq('username', from).maybeSingle();
  if (!userFrom) return res.status(404).json({ error: 'Пользователь не найден' });
  if (userFrom.friends.includes(to)) return res.status(400).json({ error: 'Вы уже друзья' });
  await supabase.from('friend_requests').insert([{ requestId: Date.now().toString(), from, to, status: 'pending' }]);
  res.json({ success: true });
});

app.post('/api/handle-friend-request', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  const username = await getUserByToken(token);
  const { requestId, action } = req.body;
  const { data: request } = await supabase.from('friend_requests').select('*').eq('requestId', requestId).maybeSingle();
  if (!request || request.to !== username || request.status !== 'pending') return res.status(404).json({ error: 'Заявка не найдена' });
  if (action === 'accept') {
    await supabase.from('friend_requests').update({ status: 'accepted' }).eq('requestId', requestId);
    const { data: userFrom } = await supabase.from('users').select('friends').eq('username', request.from).maybeSingle();
    const { data: userTo } = await supabase.from('users').select('friends').eq('username', username).maybeSingle();
    if (userFrom && userTo) {
      userFrom.friends.push(username);
      userTo.friends.push(request.from);
      await supabase.from('users').update({ friends: userFrom.friends }).eq('username', request.from);
      await supabase.from('users').update({ friends: userTo.friends }).eq('username', username);
    }
  } else {
    await supabase.from('friend_requests').update({ status: 'rejected' }).eq('requestId', requestId);
  }
  res.json({ success: true });
});

// AI-друг
const aiReplies = {
  "привет": ["Привет! Как у тебя дела?", "Приветик!", "Здравствуй!"],
  "как дела": ["У меня всё отлично! А у тебя?", "Супер!", "Хорошо, спасибо что спросил."],
  "что делаешь": ["Общаюсь с тобой – лучшее занятие.", "Отвечаю на сообщения."],
  "пока": ["Пока! Береги себя.", "До встречи!", "Счастливо!"],
  "спасибо": ["Пожалуйста!", "Не за что.", "Всегда к твоим услугам."]
};
const randomPhrases = ["Интересно!", "Расскажи подробнее.", "Согласен.", "Это круто!", "Улыбнись!", "Ты классный собеседник.", "Хорошая мысль."];

function getAIReply(userText) {
  const clean = userText.trim().toLowerCase().replace(/[^а-яёa-z0-9 ]/g, '');
  for (let key in aiReplies) if (clean.includes(key)) return aiReplies[key][Math.floor(Math.random() * aiReplies[key].length)];
  return randomPhrases[Math.floor(Math.random() * randomPhrases.length)];
}

// ==================== СОКЕТЫ ====================
const onlineUsers = new Map();
const userSockets = new Map();

io.on('connection', (socket) => {
  console.log('Подключился:', socket.id);

  socket.on('register', async (username) => {
    const { data: user } = await supabase.from('users').select('*').eq('username', username).maybeSingle();
    if (!user) return;
    onlineUsers.set(socket.id, username);
    userSockets.set(username, socket.id);
    socket.emit('user-data', {
      name: username,
      friends: user.friends,
      groups: user.groups,
      avatar: user.avatar,
      description: user.description
    });
    broadcastUsersList();
  });

  socket.on('disconnect', async () => {
    const username = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    if (username) userSockets.delete(username);
    broadcastUsersList();
  });

  // Сообщения
  socket.on('chat message', async (msgData) => {
    const sender = onlineUsers.get(socket.id);
    if (!sender) return;
    const { text, image, target, isGroup } = msgData;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (isGroup) {
      const { data: group } = await supabase.from('groups').select('*').eq('name', target).maybeSingle();
      if (!group) return;
      const msg = { chatKey: 'group:' + target, author: sender, text: text || '', image: image || null, time, target, isGroup: true };
      await supabase.from('messages').insert([msg]);
      group.members.forEach(member => {
        const sockId = userSockets.get(member);
        if (sockId) io.to(sockId).emit('group message', { group: target, msg });
      });
    } else if (target === 'general') {
      const msg = { chatKey: 'general', author: sender, text: text || '', image: image || null, time, target: 'general' };
      await supabase.from('messages').insert([msg]);
      io.emit('general message', msg);
    } else if (target === 'ai-bot') {
      const chatKey = [sender, 'ai-bot'].sort().join(':');
      const msg = { chatKey, author: sender, text: text || '', image: image || null, time, target: 'ai-bot' };
      await supabase.from('messages').insert([msg]);
      socket.emit('private message', msg);
      const aiReply = getAIReply(text);
      const aiMsg = { chatKey, author: '🤖 AI Друг', text: aiReply, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), target: sender, fromAI: true };
      await supabase.from('messages').insert([aiMsg]);
      socket.emit('private message', aiMsg);
    } else {
      const receiver = target;
      const chatKey = [sender, receiver].sort().join(':');
      const msg = { chatKey, author: sender, text: text || '', image: image || null, time, target: receiver };
      await supabase.from('messages').insert([msg]);
      const recvSock = userSockets.get(receiver);
      if (recvSock) io.to(recvSock).emit('private message', msg);
      socket.emit('private message', msg);
    }
  });

  socket.on('get-history', async (chatInfo) => {
    const { target, isGroup } = chatInfo;
    let chatKey;
    if (target === 'general') chatKey = 'general';
    else if (isGroup) chatKey = 'group:' + target;
    else {
      const myName = onlineUsers.get(socket.id);
      chatKey = [myName, target].sort().join(':');
    }
    const { data: messages } = await supabase.from('messages').select('*').eq('chatKey', chatKey).order('time', { ascending: true });
    socket.emit('chat-history', { target, messages, isGroup });
  });

  // Запросы дружбы
  socket.on('send-friend-request', async (to) => {
    const from = onlineUsers.get(socket.id);
    if (!from) return;
    const { data: userFrom } = await supabase.from('users').select('friends').eq('username', from).maybeSingle();
    if (!userFrom) return;
    if (userFrom.friends.includes(to)) return;
    await supabase.from('friend_requests').insert([{ requestId: Date.now().toString(), from, to, status: 'pending' }]);
    const toSock = userSockets.get(to);
    if (toSock) io.to(toSock).emit('new-notification', {
      id: Date.now(),
      text: `${from} хочет добавить вас в друзья`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      read: false
    });
  });

  socket.on('respond-friend-request', async ({ requestId, action }) => {
    const username = onlineUsers.get(socket.id);
    const { data: request } = await supabase.from('friend_requests').select('*').eq('requestId', requestId).maybeSingle();
    if (!request || request.to !== username || request.status !== 'pending') return;
    if (action === 'accept') {
      await supabase.from('friend_requests').update({ status: 'accepted' }).eq('requestId', requestId);
      const { data: userFrom } = await supabase.from('users').select('friends').eq('username', request.from).maybeSingle();
      const { data: userTo } = await supabase.from('users').select('friends').eq('username', username).maybeSingle();
      if (userFrom && userTo) {
        userFrom.friends.push(username);
        userTo.friends.push(request.from);
        await supabase.from('users').update({ friends: userFrom.friends }).eq('username', request.from);
        await supabase.from('users').update({ friends: userTo.friends }).eq('username', username);
      }
    } else {
      await supabase.from('friend_requests').update({ status: 'rejected' }).eq('requestId', requestId);
    }
    const fromSock = userSockets.get(request.from);
    if (fromSock) {
      const { data: fromUser } = await supabase.from('users').select('*').eq('username', request.from).maybeSingle();
      if (fromUser) io.to(fromSock).emit('user-data', { name: request.from, friends: fromUser.friends, groups: fromUser.groups, avatar: fromUser.avatar });
    }
    socket.emit('user-data', { name: username, friends: userTo?.friends || [], groups: userTo?.groups || [], avatar: userTo?.avatar || '' });
  });

  // Группы
  socket.on('create-group', async (groupData) => {
    const myName = onlineUsers.get(socket.id);
    if (!myName) return;
    const { name, members } = groupData;
    if (!name || members.length === 0) return;
    const allMembers = [myName, ...members.filter(m => m !== myName)];
    await supabase.from('groups').insert([{ name, members: allMembers }]);
    for (const member of allMembers) {
      const { data: user } = await supabase.from('users').select('groups').eq('username', member).maybeSingle();
      if (user) {
        const updatedGroups = [...user.groups, name];
        await supabase.from('users').update({ groups: updatedGroups }).eq('username', member);
      }
    }
    for (const member of allMembers) {
      const sockId = userSockets.get(member);
      if (sockId) {
        const { data: user } = await supabase.from('users').select('*').eq('username', member).maybeSingle();
        if (user) io.to(sockId).emit('user-data', { name: member, friends: user.friends, groups: user.groups, avatar: user.avatar });
      }
    }
  });

  // WebRTC
  socket.on('call-user', ({ toId, offer }) => {
    const callerName = onlineUsers.get(socket.id) || 'Неизвестный';
    const receiverSocket = userSockets.get(toId);
    if (receiverSocket) io.to(receiverSocket).emit('incoming-call', { from: callerName, offer });
  });
  socket.on('answer-call', ({ to, answer }) => {
    const receiverSocket = userSockets.get(to);
    if (receiverSocket) io.to(receiverSocket).emit('call-answered', { answer });
  });
  socket.on('ice-candidate', ({ to, candidate }) => {
    const receiverSocket = userSockets.get(to);
    if (receiverSocket) io.to(receiverSocket).emit('ice-candidate', { candidate });
  });
  socket.on('end-call', ({ to }) => {
    const receiverSocket = userSockets.get(to);
    if (receiverSocket) io.to(receiverSocket).emit('call-ended');
  });
});

async function broadcastUsersList() {
  const list = [{ id: 'ai-bot', name: ' AI Друг', isAI: true, avatar: '' }];
  for (let [id, name] of onlineUsers) {
    const { data: user } = await supabase.from('users').select('*').eq('username', name).maybeSingle();
    list.push({ id, name, isAI: false, avatar: user?.avatar || '', description: user?.description || '' });
  }
  io.emit('users-update', list);
}

// ==================== СТАРТ ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
  await ensureTestAccount();
});
