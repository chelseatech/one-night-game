const path = require('node:path');
const { randomBytes, randomInt } = require('node:crypto');
const { createServer: createHttpServer } = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const prompts = require('./prompts');

const TOTAL_ROUNDS = 5;
const MAX_PLAYERS = 16;
const ROOM_TTL = 6 * 60 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const token = () => randomBytes(24).toString('hex');
const shuffle = (items) => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};
const fail = (message) => { throw new Error(message); };

function createGameServer() {
  const app = express();
  app.disable('x-powered-by');
  const httpServer = createHttpServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 16 * 1024 });
  const rooms = new Map();
  const publicDirectory = path.join(__dirname, 'public');
  // An explicit root keeps hidden deployment ancestors (such as .nodeapp)
  // out of Express's dotfile check without allowing hidden public files.
  app.get('/host', (_req, res) => res.sendFile('host.html', { root: publicDirectory }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(express.static(publicDirectory));

  function newCode() {
    if (rooms.size >= 1000) fail('The server is full. Please try again later.');
    let code;
    do {
      code = Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    } while (rooms.has(code));
    return code;
  }

  function playerList(room) {
    return [...room.players.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  function currentAnswer(room) {
    return room.answers[room.answerIndex];
  }

  function voters(room) {
    const answer = currentAnswer(room);
    if (!answer) return [];
    return [...room.players.values()].filter((p) => room.participants.has(p.id) && p.id !== answer.playerId);
  }

  // Serialize only what this screen is allowed to know. Answers and credentials
  // stay on the server until their designated reveal.
  function snapshot(room, playerId) {
    const answer = currentAnswer(room);
    const visible = ['guessing', 'reveal'].includes(room.phase) && answer;
    const player = room.players.get(playerId);
    const expectedAnswers = [...room.participants].filter((id) => room.players.get(id)?.connected || room.submissions.has(id));
    const expectedVotes = voters(room).filter((p) => p.connected || room.guesses.has(p.id));
    return {
      code: room.code,
      phase: room.phase,
      hostConnected: Boolean(room.hostSocketId),
      round: room.round,
      totalRounds: TOTAL_ROUNDS,
      prompt: room.prompt,
      players: playerList(room).map((p) => ({
        id: p.id, name: p.name, score: p.score, connected: p.connected,
        participating: room.participants.has(p.id),
        answered: room.submissions.has(p.id),
        guessed: room.guesses.has(p.id)
      })),
      answeredCount: room.submissions.size,
      expectedAnswers: expectedAnswers.length,
      guessCount: room.guesses.size,
      expectedGuesses: expectedVotes.length,
      answerNumber: room.answerIndex + 1,
      answerTotal: room.answers.length,
      answer: visible ? { text: answer.text } : null,
      author: room.phase === 'reveal' && answer ? {
        id: answer.playerId, name: room.players.get(answer.playerId).name
      } : null,
      correctGuessers: room.phase === 'reveal'
        ? [...room.guesses].filter(([, id]) => id === answer.playerId).map(([id]) => id)
        : [],
      // The list of candidates is the same for everyone and leaks no mapping
      // between a submission and its author.
      candidates: visible ? [...room.participants].map((id) => ({ id, name: room.players.get(id).name })) : [],
      me: player ? {
        id: player.id,
        answer: room.submissions.get(player.id) ?? null,
        guess: room.guesses.get(player.id) ?? null,
        participating: room.participants.has(player.id),
        canGuess: room.phase === 'guessing' && room.participants.has(player.id) && answer.playerId !== player.id,
        isAuthor: Boolean(visible && answer.playerId === player.id)
      } : null
    };
  }

  function broadcast(room) {
    if (room.hostSocketId) io.to(room.hostSocketId).emit('room_state', snapshot(room));
    for (const p of room.players.values()) {
      if (p.socketId) io.to(p.socketId).emit('room_state', snapshot(room, p.id));
    }
  }

  function finishGuess(room) {
    const answer = currentAnswer(room);
    for (const [playerId, guessedId] of room.guesses) {
      if (guessedId === answer.playerId) room.players.get(playerId).score += 1;
    }
    room.phase = 'reveal';
  }

  function progress(room) {
    if (room.phase === 'answering') {
      const connected = [...room.participants].filter((id) => room.players.get(id)?.connected);
      if (room.submissions.size > 0 && connected.every((id) => room.submissions.has(id))) {
        room.answers = shuffle([...room.submissions].map(([playerId, text]) => ({ playerId, text })));
        room.phase = 'ready';
      }
    } else if (room.phase === 'guessing') {
      const connectedVoters = voters(room).filter((p) => p.connected);
      if (connectedVoters.every((p) => room.guesses.has(p.id))) finishGuess(room);
    }
  }

  function nextRound(room) {
    room.round += 1;
    room.prompt = room.prompts[room.round - 1];
    room.participants = new Set([...room.players.values()].filter((p) => p.connected).map((p) => p.id));
    room.submissions = new Map();
    room.answers = [];
    room.answerIndex = 0;
    room.guesses = new Map();
    room.phase = 'answering';
  }

  function attachedRoom(socket, role) {
    const room = rooms.get(socket.data.code);
    if (!room) fail('This room has expired. Create or join a new room.');
    if (role && socket.data.role !== role) fail('This action is not available on this screen.');
    if (socket.data.role === 'host' && room.hostSocketId !== socket.id) fail('The host has moved to another screen.');
    if (socket.data.role === 'player' && room.players.get(socket.data.playerId)?.socketId !== socket.id) fail('Your player has moved to another screen.');
    room.updatedAt = Date.now();
    return room;
  }

  function replaceSocket(oldId, socket) {
    if (oldId && oldId !== socket.id) {
      const old = io.sockets.sockets.get(oldId);
      if (old) {
        old.emit('session_replaced');
        old.disconnect(true);
      }
    }
  }

  io.on('connection', (socket) => {
    // Cheap per-socket event throttling; no infrastructure required.
    let windowStart = Date.now();
    let events = 0;
    function on(event, handler) {
      socket.on(event, (data, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          if (Date.now() - windowStart > 1000) { windowStart = Date.now(); events = 0; }
          if (++events > 20) fail('Slow down and try again in a moment.');
          if (!data || typeof data !== 'object' || Array.isArray(data)) fail('Invalid request.');
          const result = handler(data);
          reply({ ok: true, ...result });
        } catch (error) {
          reply({ ok: false, error: error.message });
        }
      });
    }

    on('create_room', () => {
      if (socket.data.code) fail('You already have a room on this screen.');
      const room = {
        code: newCode(), hostToken: token(), hostSocketId: socket.id,
        players: new Map(), phase: 'lobby', round: 0, prompt: '',
        participants: new Set(), submissions: new Map(), guesses: new Map(),
        answers: [], answerIndex: 0, updatedAt: Date.now()
      };
      rooms.set(room.code, room);
      socket.data = { role: 'host', code: room.code };
      broadcast(room);
      return { session: { role: 'host', code: room.code, token: room.hostToken } };
    });

    on('join_room', ({ code, name }) => {
      if (socket.data.code) fail('You already joined a room on this screen.');
      if (typeof code !== 'string' || !/^[A-Z]{4}$/.test(code.trim().toUpperCase())) fail('Enter a four-letter room code.');
      if (typeof name !== 'string') fail('Enter your display name.');
      name = name.trim().replace(/\s+/g, ' ');
      if (name.length < 1 || name.length > 20 || /[\p{Cc}\p{Cf}]/u.test(name)) fail('Use a name between 1 and 20 characters, with no hidden control characters.');
      const room = rooms.get(code.trim().toUpperCase());
      if (!room) fail('Room not found. Double-check the code with your host.');
      if (room.players.size >= MAX_PLAYERS) fail(`This room is full (${MAX_PLAYERS} players maximum).`);
      const nameKey = name.normalize('NFKC').toLowerCase();
      if ([...room.players.values()].some((p) => p.nameKey === nameKey)) fail('That name is already taken. Choose another, or reconnect on your original phone.');
      const player = { id: token(), token: token(), name, nameKey, score: 0, connected: true, socketId: socket.id };
      room.players.set(player.id, player);
      socket.data = { role: 'player', code: room.code, playerId: player.id };
      room.updatedAt = Date.now();
      broadcast(room);
      return { session: { role: 'player', code: room.code, playerId: player.id, token: player.token } };
    });

    on('resume_session', ({ role, code, playerId, token: credential }) => {
      if (socket.data.code) fail('This screen is already connected to a room.');
      const room = rooms.get(code);
      if (!room || typeof credential !== 'string') fail('Your room is no longer available. Join or create a new one.');
      if (role === 'host' && room.hostToken === credential) {
        const oldId = room.hostSocketId;
        room.hostSocketId = socket.id;
        socket.data = { role, code };
        replaceSocket(oldId, socket);
      } else if (role === 'player' && room.players.get(playerId)?.token === credential) {
        const player = room.players.get(playerId);
        const oldId = player.socketId;
        player.socketId = socket.id;
        player.connected = true;
        socket.data = { role, code, playerId };
        replaceSocket(oldId, socket);
      } else fail('Unable to restore this session. Join or create a new room.');
      room.updatedAt = Date.now();
      progress(room);
      broadcast(room);
      return {};
    });

    on('start_game', () => {
      const room = attachedRoom(socket, 'host');
      if (!['lobby', 'finished'].includes(room.phase)) fail('A game is already in progress.');
      if ([...room.players.values()].filter((p) => p.connected).length < 2) fail('You need at least two connected players to start.');
      for (const p of room.players.values()) p.score = 0;
      room.prompts = shuffle(prompts).slice(0, TOTAL_ROUNDS);
      room.round = 0;
      nextRound(room);
      broadcast(room);
    });

    on('submit_answer', ({ text, round }) => {
      const room = attachedRoom(socket, 'player');
      const id = socket.data.playerId;
      if (room.phase !== 'answering' || round !== room.round || !room.participants.has(id)) fail('You cannot submit an answer in this round.');
      if (room.submissions.has(id)) fail('Your answer is already locked in.');
      if (typeof text !== 'string' || !text.trim() || text.trim().length > 180 || /[\p{Cc}\p{Cf}]/u.test(text.replace(/[\n\r\t]/g, ''))) fail('Write an answer between 1 and 180 characters.');
      room.submissions.set(id, text.trim());
      progress(room);
      broadcast(room);
    });

    on('submit_guess', ({ playerId, round, answerNumber }) => {
      const room = attachedRoom(socket, 'player');
      const id = socket.data.playerId;
      if (room.phase !== 'guessing' || round !== room.round || answerNumber !== room.answerIndex + 1) fail('This guess has already closed.');
      if (!room.participants.has(id)) fail('You can play from the next round.');
      if (currentAnswer(room).playerId === id) fail('You wrote this answer. Sit this guess out.');
      if (room.guesses.has(id)) fail('Your guess is already locked in.');
      if (typeof playerId !== 'string' || !room.participants.has(playerId)) fail('Choose a player from this round.');
      room.guesses.set(id, playerId);
      progress(room);
      broadcast(room);
    });

    on('host_advance', ({ phase, round, answerNumber }) => {
      const room = attachedRoom(socket, 'host');
      if (phase !== room.phase || round !== room.round || answerNumber !== room.answerIndex + 1) fail('The game has moved on. Use the current host controls.');
      if (room.phase === 'ready') {
        room.phase = 'guessing';
        progress(room);
      } else if (room.phase === 'guessing') {
        // Host can close a stalled vote. Only guesses already submitted count.
        finishGuess(room);
      } else if (room.phase === 'reveal') {
        if (room.answerIndex + 1 < room.answers.length) {
          room.answerIndex += 1;
          room.guesses = new Map();
          room.phase = 'guessing';
          progress(room);
        } else {
          room.phase = room.round === TOTAL_ROUNDS ? 'finished' : 'scoreboard';
        }
      } else if (room.phase === 'scoreboard') {
        if (![...room.players.values()].some((p) => p.connected)) fail('Wait for a player to reconnect before the next round.');
        nextRound(room);
      } else fail('Wait for players to finish their answers.');
      broadcast(room);
    });

    on('reset_lobby', () => {
      const room = attachedRoom(socket, 'host');
      room.phase = 'lobby';
      room.round = 0;
      room.prompt = '';
      room.participants = new Set();
      room.submissions = new Map();
      room.answers = [];
      room.guesses = new Map();
      room.answerIndex = 0;
      for (const p of room.players.values()) p.score = 0;
      broadcast(room);
    });

    socket.on('disconnect', () => {
      const room = rooms.get(socket.data.code);
      if (!room) return;
      if (socket.data.role === 'host' && room.hostSocketId === socket.id) room.hostSocketId = null;
      const player = room.players.get(socket.data.playerId);
      if (player?.socketId === socket.id) { player.connected = false; player.socketId = null; }
      room.updatedAt = Date.now();
      progress(room);
      broadcast(room);
    });
  });

  const cleanup = setInterval(() => {
    for (const [code, room] of rooms) {
      const occupied = room.hostSocketId || [...room.players.values()].some((p) => p.connected);
      if (!occupied && Date.now() - room.updatedAt > ROOM_TTL) rooms.delete(code);
    }
  }, 60_000);
  cleanup.unref();
  httpServer.on('close', () => clearInterval(cleanup));
  return { app, httpServer, io };
}

if (require.main === module) {
  const { httpServer } = createGameServer();
  const port = process.env.PORT || 3000;
  httpServer.listen(port, '0.0.0.0', () => console.log(`Who Said That? listening on port ${port}`));
}

module.exports = { createGameServer };
