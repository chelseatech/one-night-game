const { test } = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createGameServer } = require('../server');
const prompts = require('../prompts');

async function setup(t) {
  const server = createGameServer();
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.socket.disconnect();
    await new Promise((resolve) => server.io.close(resolve));
  });
  async function client() {
    const socket = connect(url, { forceNew: true, reconnection: false, autoConnect: false });
    let lastCommand = 0;
    const value = {
      socket, state: null,
      async command(event, data = {}) {
        // Play at human speed so the production anti-spam limit stays enabled.
        const delay = Math.max(0, lastCommand + 55 - Date.now());
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        lastCommand = Date.now();
        return socket.timeout(3000).emitWithAck(event, data);
      },
      wait(predicate) {
        if (value.state && predicate(value.state)) return Promise.resolve(value.state);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            socket.off('room_state', listener);
            reject(new Error(`Timed out waiting for state; last phase: ${value.state?.phase}`));
          }, 3000);
          function listener(state) {
            if (predicate(state)) { clearTimeout(timer); socket.off('room_state', listener); resolve(state); }
          }
          socket.on('room_state', listener);
        });
      }
    };
    socket.on('room_state', (state) => { value.state = state; });
    clients.push(value);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
    return value;
  }
  const host = await client();
  const created = await host.command('create_room');
  assert.equal(created.ok, true);
  host.session = created.session;
  async function join(name) {
    const player = await client();
    const result = await player.command('join_room', { code: host.session.code, name });
    assert.equal(result.ok, true, result.error);
    player.session = result.session;
    player.name = name;
    return player;
  }
  async function advance() {
    const s = host.state;
    const result = await host.command('host_advance', { phase: s.phase, round: s.round, answerNumber: s.answerNumber });
    assert.equal(result.ok, true, result.error);
  }
  return { ...server, url, client, host, join, advance };
}

test('serves the phone, host, same-origin Socket.IO client, and health endpoint', async (t) => {
  const { url } = await setup(t);
  for (const route of ['/', '/host', '/style.css', '/app.js', '/socket.io/socket.io.js']) {
    const response = await fetch(`${url}${route}`);
    assert.equal(response.status, 200, route);
    assert.ok((await response.text()).length > 50);
  }
  assert.deepEqual(await (await fetch(`${url}/health`)).json(), { ok: true });
  assert.ok(prompts.length >= 25);
  assert.equal(new Set(prompts).size, prompts.length);
});

test('validates joins and actions, protects room roles and session tokens', async (t) => {
  const { host, client, join } = await setup(t);
  assert.match(host.session.code, /^[A-Z]{4}$/);
  assert.equal((await host.command('start_game')).ok, false);
  const alice = await join('Alice');
  const stranger = await client();
  for (const name of ['alice', ' ALICE ', 'Ａｌｉｃｅ', '', 'x'.repeat(21), 'Bad\u0000name']) {
    assert.equal((await stranger.command('join_room', { code: host.session.code, name })).ok, false, name);
  }
  assert.equal((await stranger.command('join_room', { code: '1234', name: 'Bob' })).ok, false);
  assert.equal((await stranger.command('join_room', { code: 'AAAAA', name: 'Bob' })).ok, false);
  assert.equal((await alice.command('start_game')).ok, false);
  assert.equal((await stranger.command('resume_session', { ...host.session, token: 'wrong' })).ok, false);
  const publicState = JSON.stringify(alice.state);
  assert.ok(!publicState.includes(host.session.token));
  assert.ok(!publicState.includes(alice.session.token));
  assert.equal((await alice.command('submit_answer', { text: 'Too early', round: 0 })).ok, false);
});

test('plays five rounds, keeps submissions private, scores guesses once, and starts a new game', async (t) => {
  const { host, join, advance } = await setup(t);
  const players = await Promise.all(['Alice', 'Bob', 'Charlie'].map(join));
  assert.equal((await host.command('start_game')).ok, true);
  const playedPrompts = new Set();
  const expected = new Map(players.map((p) => [p.session.playerId, 0]));
  for (let round = 1; round <= 5; round++) {
    await host.wait((s) => s.phase === 'answering' && s.round === round);
    playedPrompts.add(host.state.prompt);
    for (const player of players) {
      await player.wait((s) => s.phase === 'answering' && s.round === round);
      if (round === 1) {
        assert.equal((await player.command('submit_answer', { text: ' ', round })).ok, false);
        assert.equal((await player.command('submit_answer', { text: 'x'.repeat(181), round })).ok, false);
        assert.equal((await player.command('submit_answer', { text: 'stale', round: 0 })).ok, false);
      }
      assert.equal((await player.command('submit_answer', { text: `Private ${player.name} ${round}`, round })).ok, true);
      if (player !== players.at(-1)) {
        assert.equal(host.state.answer, null);
        assert.ok(!JSON.stringify(host.state).includes(`Private ${player.name}`));
        const other = players.find((p) => p !== player);
        assert.ok(!JSON.stringify(other.state).includes(`Private ${player.name}`));
      }
      assert.equal((await player.command('submit_answer', { text: 'duplicate', round })).ok, false);
    }
    await host.wait((s) => s.phase === 'ready');
    assert.equal(host.state.answerTotal, 3);
    await advance();
    for (let number = 1; number <= 3; number++) {
      await host.wait((s) => s.phase === 'guessing' && s.answerNumber === number);
      assert.equal(host.state.author, null);
      assert.ok(!JSON.stringify(host.state).includes('playerId'));
      const author = players.find((p) => host.state.answer.text === `Private ${p.name} ${round}`);
      assert.ok(author);
      await author.wait((s) => s.phase === 'guessing' && s.answerNumber === number);
      assert.equal(author.state.me.isAuthor, true);
      assert.equal((await author.command('submit_guess', { playerId: author.session.playerId, round, answerNumber: number })).ok, false);
      const eligible = players.filter((p) => p !== author);
      for (const [index, player] of eligible.entries()) {
        await player.wait((s) => s.phase === 'guessing' && s.answerNumber === number);
        const guess = round === 1 && number === 1 && index === 0
          ? eligible[1].session.playerId : author.session.playerId;
        if (guess === author.session.playerId) expected.set(player.session.playerId, expected.get(player.session.playerId) + 1);
        const guessed = await player.command('submit_guess', { playerId: guess, round, answerNumber: number });
        assert.equal(guessed.ok, true, guessed.error);
        assert.equal((await player.command('submit_guess', { playerId: guess, round, answerNumber: number })).ok, false);
      }
      await host.wait((s) => s.phase === 'reveal');
      assert.equal(host.state.author.name, author.name);
      for (const player of host.state.players) assert.equal(player.score, expected.get(player.id));
      assert.equal((await host.command('host_advance', { phase: 'guessing', round, answerNumber: number })).ok, false, 'stale host command must not advance the next answer');
      await advance();
    }
    if (round < 5) {
      assert.equal(host.state.phase, 'scoreboard');
      await advance();
    }
  }
  assert.equal(host.state.phase, 'finished');
  assert.equal(playedPrompts.size, 5);
  assert.equal([...expected.values()].reduce((a, b) => a + b, 0), 29);
  assert.equal((await host.command('start_game')).ok, true);
  assert.equal(host.state.phase, 'answering');
  assert.equal(host.state.round, 1);
  assert.ok(host.state.players.every((p) => p.score === 0));
});

test('handles departing players, mid-round joins, player and host reconnection', async (t) => {
  const { host, join, client, advance } = await setup(t);
  const alice = await join('Alice');
  const bob = await join('Bob');
  assert.equal((await host.command('start_game')).ok, true);
  await alice.wait((s) => s.phase === 'answering');
  assert.equal((await alice.command('submit_answer', { text: 'Alice only', round: 1 })).ok, true);
  const late = await join('Late');
  assert.equal(late.state.me.participating, false);
  assert.equal((await late.command('submit_answer', { text: 'late', round: 1 })).ok, false);
  bob.socket.disconnect();
  await host.wait((s) => s.phase === 'ready');
  assert.equal(host.state.answerTotal, 1);
  const returningBob = await client();
  assert.equal((await returningBob.command('resume_session', bob.session)).ok, true);
  assert.equal(returningBob.state.me.id, bob.session.playerId);
  assert.equal((await returningBob.command('submit_answer', { text: 'too late', round: 1 })).ok, false);
  await advance();
  await returningBob.wait((s) => s.phase === 'guessing');
  assert.equal((await late.command('submit_guess', { playerId: alice.session.playerId, round: 1, answerNumber: 1 })).ok, false);
  assert.equal((await returningBob.command('submit_guess', { playerId: alice.session.playerId, round: 1, answerNumber: 1 })).ok, true);
  await host.wait((s) => s.phase === 'reveal');
  host.socket.disconnect();
  await alice.wait((s) => !s.hostConnected);
  const restoredHost = await client();
  assert.equal((await restoredHost.command('resume_session', host.session)).ok, true);
  assert.equal(restoredHost.state.phase, 'reveal');
  assert.equal(restoredHost.state.players.find((p) => p.name === 'Bob').score, 1);
  const state = restoredHost.state;
  assert.equal((await restoredHost.command('host_advance', { phase: state.phase, round: state.round, answerNumber: state.answerNumber })).ok, true);
  const score = restoredHost.state;
  assert.equal((await restoredHost.command('host_advance', { phase: score.phase, round: score.round, answerNumber: score.answerNumber })).ok, true);
  await late.wait((s) => s.round === 2);
  assert.equal(late.state.me.participating, true);
  assert.equal(restoredHost.state.players.length, 3);
});

test('offline voters do not stall a reveal, and submitted answers survive a refreshed phone', async (t) => {
  const { host, join, client, advance } = await setup(t);
  const alice = await join('Alice');
  const bob = await join('Bob');
  await host.command('start_game');
  await alice.wait((s) => s.phase === 'answering');
  await alice.command('submit_answer', { text: '<script>private answer</script>', round: 1 });
  alice.socket.disconnect();
  const restored = await client();
  assert.equal((await restored.command('resume_session', alice.session)).ok, true);
  assert.equal(restored.state.me.answer, '<script>private answer</script>');
  await bob.command('submit_answer', { text: 'Bob answer', round: 1 });
  await host.wait((s) => s.phase === 'ready');
  await advance();
  const answerAuthor = host.state.answer.text === 'Bob answer' ? bob : restored;
  const voter = answerAuthor === bob ? restored : bob;
  voter.socket.disconnect();
  await host.wait((s) => s.phase === 'reveal');
  assert.equal(host.state.correctGuessers.length, 0);
  assert.ok(host.state.players.every((p) => p.score === 0));
  assert.equal((await host.command('reset_lobby')).ok, true);
  assert.equal(host.state.phase, 'lobby');
  assert.equal(host.state.answer, null);
});
