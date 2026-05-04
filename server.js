const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const DATA_FILE = path.join(__dirname, 'data.json');
let data = {
  users: {},
  messages: { general: [] },
  groups: {}
};

// Загрузка данных с диска
if (fs.existsSync(DATA_FILE)) {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const loaded = JSON.parse(raw);
    if (loaded.users) data.users = loaded.users;
    if (loaded.messages) data.messages = loaded.messages;
    if (loaded.groups) data.groups = loaded.groups;
    if (!data.messages.general) data.messages.general = [];
  } catch (e) {
    console.error('Ошибка чтения data.json');
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ====== AI-друг ======
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
  // Проверяем ключи обычным циклом for...in (работает везде)
  for (let key in aiReplies) {
    if (clean.indexOf(key) !== -1) {
      const answers = aiReplies[key];
      return answers[Math.floor(Math.random() * answers.length)];
    }
  }
  return randomPhrases[Math.floor(Math.random() * randomPhrases.length)];
}

// ====== Пользователи онлайн ======
const onlineUsers = new Map(); // socket.id -> имя
const userSockets = new Map(); // имя -> socket.id

io.on('connection', function (socket) {
  console.log('Подключился:', socket.id);

  socket.on('register', function (name) {
    const cleanName = (name || '').trim();
    if (!cleanName) return;
    if (!data.users[cleanName]) {
      data.users[cleanName] = { friends: [] };
      saveData();
    }
    onlineUsers.set(socket.id, cleanName);
    userSockets.set(cleanName, socket.id);

    socket.emit('user-data', {
      name: cleanName,
      friends: data.users[cleanName].friends,
      groups: getGroupsForUser(cleanName)
    });

    broadcastUsersList();
  });

  socket.on('disconnect', function () {
    const name = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    if (name) userSockets.delete(name);
    broadcastUsersList();
  });

  socket.on('change-name', function (newName) {
    const oldName = onlineUsers.get(socket.id);
    if (!oldName || !newName || !newName.trim() || data.users[newName.trim()]) return;
    const finalName = newName.trim();
    data.users[finalName] = data.users[oldName] || { friends: [] };
    delete data.users[oldName];
    // Обновляем упоминания в друзьях
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
      groups: getGroupsForUser(finalName)
    });
    broadcastUsersList();
  });

  // ====== Сообщения ======
  socket.on('chat message', function (msgData) {
    const sender = onlineUsers.get(socket.id);
    if (!sender) return;
    const text = msgData.text || '';
    const image = msgData.image || null;
    const target = msgData.target;
    const isGroup = msgData.isGroup;

    const msg = {
      author: sender,
      text: text,
      image: image,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    // Лог в консоль
    const logText = image ? '📷 Фото' : text;
    const groupSuffix = isGroup ? ' ; группа ' + target : '';
    console.log(sender + ': ' + logText + groupSuffix);

    if (isGroup) {
      if (!data.groups[target]) return;
      data.groups[target].messages.push(msg);
      const members = data.groups[target].members;
      for (let i = 0; i < members.length; i++) {
        const member = members[i];
        const sockId = userSockets.get(member);
        if (sockId) io.to(sockId).emit('group message', { group: target, msg: msg });
      }
    } else if (target === 'general') {
      data.messages.general.push(msg);
      if (data.messages.general.length > 200) data.messages.general.shift();
      io.emit('general message', msg);
    } else if (target === 'ai-bot') {
      const chatKey = getPrivateKey(sender, 'ai-bot');
      if (!data.messages[chatKey]) data.messages[chatKey] = [];
      data.messages[chatKey].push(msg);
      socket.emit('private message', msg);
      const aiReply = getAIReply(text);
      const aiMsg = {
        author: '🤖 AI Друг',
        text: aiReply,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        fromAI: true
      };
      data.messages[chatKey].push(aiMsg);
      socket.emit('private message', aiMsg);
    } else {
      // Личное сообщение другому пользователю
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

  // Запрос истории
  socket.on('get-history', function (chatInfo) {
    const target = chatInfo.target;
    const isGroup = chatInfo.isGroup;
    if (target === 'general') {
      socket.emit('chat-history', { target: 'general', messages: data.messages.general || [], isGroup: false });
      return;
    }
    if (isGroup) {
      const messages = data.groups[target] ? data.groups[target].messages : [];
      socket.emit('chat-history', { target: target, messages: messages, isGroup: true });
    } else {
      const myName = onlineUsers.get(socket.id);
      const chatKey = getPrivateKey(myName, target);
      const messages = data.messages[chatKey] || [];
      socket.emit('chat-history', { target: target, messages: messages, isGroup: false });
    }
  });

  // Друзья
  socket.on('add-friend', function (friendName) {
    const myName = onlineUsers.get(socket.id);
    if (!myName || !data.users[friendName]) return;
    if (data.users[myName].friends.indexOf(friendName) === -1) {
      data.users[myName].friends.push(friendName);
      saveData();
      socket.emit('user-data', {
        name: myName,
        friends: data.users[myName].friends,
        groups: getGroupsForUser(myName)
      });
      broadcastUsersList();
    }
  });

  socket.on('remove-friend', function (friendName) {
    const myName = onlineUsers.get(socket.id);
    if (!myName) return;
    data.users[myName].friends = data.users[myName].friends.filter(function (f) {
      return f !== friendName;
    });
    saveData();
    socket.emit('user-data', {
      name: myName,
      friends: data.users[myName].friends,
      groups: getGroupsForUser(myName)
    });
  });

  // Группы
  socket.on('create-group', function (groupData) {
    const name = groupData.name;
    const members = groupData.members || [];
    if (!name || data.groups[name]) return;
    if (members.length < 1) return;
    const myName = onlineUsers.get(socket.id);
    const allMembers = [myName];
    for (let i = 0; i < members.length; i++) {
      if (allMembers.indexOf(members[i]) === -1) allMembers.push(members[i]);
    }
    data.groups[name] = { members: allMembers, messages: [] };
    saveData();
    for (let i = 0; i < allMembers.length; i++) {
      const member = allMembers[i];
      const sockId = userSockets.get(member);
      if (sockId) {
        io.to(sockId).emit('user-data', {
          name: member,
          friends: data.users[member] ? data.users[member].friends : [],
          groups: getGroupsForUser(member)
        });
      }
    }
  });
});

// Вспомогательные функции
function getPrivateKey(userA, userB) {
  const names = [userA, userB];
  names.sort();
  return names.join(':');
}

function broadcastUsersList() {
  const list = [{ id: 'ai-bot', name: '🤖 AI Друг', isAI: true }];
  onlineUsers.forEach(function (name, id) {
    list.push({ id: id, name: name, isAI: false });
  });
  io.emit('users-update', list);
}

function getGroupsForUser(userName) {
  const result = [];
  for (let groupName in data.groups) {
    if (data.groups[groupName].members.indexOf(userName) !== -1) {
      result.push(groupName);
    }
  }
  return result;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, function () {
  console.log('Сервер запущен: http://localhost:' + PORT);
});