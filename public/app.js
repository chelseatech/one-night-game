(() => {
  'use strict';
  const role = document.body.dataset.role;
  const screen = document.getElementById('screen');
  const errorBox = document.getElementById('error');
  const notice = document.getElementById('notice');
  const connection = document.getElementById('connection');
  const sessionKey = `who-said-that:${role}`;
  const socket = io({ autoConnect: false });
  let session = readSession();
  let state = null;
  let viewKey = '';
  let busy = false;
  let replaced = false;
  let answerDraft = '';
  let draftRound = 0;

  function readSession() {
    try { return JSON.parse(localStorage.getItem(sessionKey)); } catch { return null; }
  }
  function saveSession(value) {
    session = value;
    try {
      if (value) localStorage.setItem(sessionKey, JSON.stringify(value));
      else localStorage.removeItem(sessionKey);
    } catch {
      showError('Browser storage is unavailable. Keep this page open to preserve your session.');
    }
  }
  function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function showError(message) { errorBox.textContent = message; errorBox.hidden = !message; }
  function showNotice(message) { notice.textContent = message; notice.hidden = !message; }
  function joinURL() {
    const url = new URL('/', window.location.href);
    url.searchParams.set('room', state.code);
    return url.href;
  }
  async function request(event, data = {}) {
    if (!socket.connected) throw new Error('You are offline. Wait for your connection to return.');
    const result = await socket.timeout(8000).emitWithAck(event, data).catch(() => {
      throw new Error('The server did not respond. Check your connection and try again.');
    });
    if (!result.ok) throw new Error(result.error || 'Something went wrong. Try again.');
    return result;
  }
  async function perform(button, action) {
    if (busy) return;
    busy = true;
    showError('');
    if (button) button.disabled = true;
    try { await action(); }
    catch (error) { showError(error.message); }
    finally {
      busy = false;
      if (button?.isConnected) button.disabled = false;
    }
  }
  function roundHeader(label = 'ROUND') {
    return `<div class="round-header"><p class="eyebrow">${label} ${state.round} / ${state.totalRounds}</p><div class="round-pips" aria-hidden="true">${Array.from({ length: state.totalRounds }, (_, i) => `<span class="${i < state.round ? 'filled' : ''}"></span>`).join('')}</div></div>`;
  }
  function playerStatus(player) {
    if (!player.connected) return 'Offline · can reconnect';
    if (state.phase === 'lobby') return 'Ready to play';
    if (!player.participating && !['finished', 'scoreboard'].includes(state.phase)) return 'Joining next round';
    if (state.phase === 'answering') return player.answered ? 'Answer locked in' : 'Thinking of an answer…';
    if (state.phase === 'guessing') return player.guessed ? 'Guess locked in' : 'On the guessing screen';
    return 'Connected';
  }
  function scores(large = false) {
    let lastScore;
    let rank;
    return `<ol class="score-list ${large ? 'standings-large' : ''}">${state.players.map((player, index) => {
      if (player.score !== lastScore) rank = index + 1;
      lastScore = player.score;
      const leader = state.phase !== 'lobby' && rank === 1 && player.score > 0;
      return `<li class="${leader ? 'leader' : ''}"><span class="rank">${String(rank).padStart(2, '0')}</span><span class="avatar" aria-hidden="true">${escape(Array.from(player.name)[0]?.toUpperCase())}</span><div class="person"><strong>${escape(player.name)}${state.me?.id === player.id ? ' <small>(you)</small>' : ''}</strong><small>${escape(playerStatus(player))}</small></div><span class="points" aria-label="${player.score} points">${player.score}</span></li>`;
    }).join('')}</ol>`;
  }
  function winnerMarkup() {
    const best = state.players[0]?.score ?? 0;
    const winners = state.players.filter((p) => p.score === best);
    return `<p class="eyebrow">FIVE ROUNDS. ONE BRAGGING RIGHT.</p><h1 class="display">${winners.length === 1 ? 'WE HAVE A<br><em>WINNER.</em>' : 'IT’S A<br><em>TIE.</em>'}</h1><p class="winner">${winners.map((p) => escape(p.name)).join(' &amp; ')}</p><p class="winner-score">${best} point${best === 1 ? '' : 's'} · ${winners.length === 1 ? 'Suspiciously good at reading the room.' : 'Shared glory. Shared suspicions.'}</p>`;
  }
  function renderInitial(restoring = false) {
    state = null;
    viewKey = '';
    if (role === 'host') {
      document.getElementById('room-strip').innerHTML = '';
      document.getElementById('host-sidebar').innerHTML = '';
      screen.innerHTML = `<section class="host-intro show-in"><div class="intro"><p class="eyebrow">THE WHO-WROTE-IT PARTY GAME</p><h1 class="display">YOUR FRIENDS.<br>THEIR <em>WEIRD</em><br>ANSWERS.</h1><p class="lede">One question. A room full of anonymous answers. Can you spot who said what?</p><button class="button" data-action="create" ${restoring ? 'disabled' : ''}>${restoring ? 'Reconnecting to your room…' : 'Create a room <span aria-hidden="true">↗</span>'}</button><p class="hint">2–16 players · 5 rounds · absolutely no downloads</p></div><div class="panel intro-copy"><p class="eyebrow">HERE’S THE DEAL</p><ol class="how-to"><li><b>01</b><span><strong>Get everyone in.</strong><br>Put this screen on a TV. Join from your phones.</span></li><li><b>02</b><span><strong>Write something ridiculous.</strong><br>Everyone answers the same prompt, privately.</span></li><li><b>03</b><span><strong>Read the room.</strong><br>Guess the author. Get it right. Earn a point.</span></li></ol><p class="score-legend">Keep this host screen visible. All the good reveals happen here.</p></div></section>`;
    } else {
      document.getElementById('player-scores').innerHTML = '';
      const code = new URLSearchParams(window.location.search).get('room') || '';
      screen.innerHTML = `<section class="intro show-in"><p class="eyebrow">THE WHO-WROTE-IT PARTY GAME</p><h1 class="display">WHO SAID<br><em>THAT?</em></h1><p class="lede">Your friends are about to say some weird things. Let’s find out who said what.</p>${restoring ? '<div class="panel"><p class="progress-note"><span class="pulse"></span>Reconnecting to your game…</p></div>' : `<form id="join-form" class="panel join-form"><label for="room-code">Room code</label><input id="room-code" name="code" class="code-input" placeholder="ABCD" value="${escape(code.slice(0, 4))}" minlength="4" maxlength="4" pattern="[A-Za-z]{4}" autocomplete="off" autocapitalize="characters" spellcheck="false" required><label for="player-name">Your name</label><input id="player-name" name="name" placeholder="What do your friends call you?" maxlength="20" autocomplete="nickname" required><button class="button wide" type="submit">Join the party <span aria-hidden="true">↗</span></button><p class="hint">Find the four-letter code on your host’s screen.</p></form>`}</section>`;
    }
  }

  function renderHost() {
    const connected = state.players.filter((p) => p.connected).length;
    document.getElementById('room-strip').innerHTML = `<div class="meta">ROOM <strong>${escape(state.code)}</strong></div><div><button class="text-button" data-action="copy">Copy join link</button>${state.phase !== 'lobby' ? '<button class="text-button" data-action="reset">Reset to lobby</button>' : ''}</div>`;
    document.getElementById('host-sidebar').innerHTML = `<div class="panel"><h2 class="score-heading">${state.phase === 'lobby' ? 'THE GUEST LIST' : 'LIVE SCOREBOARD'}<span>${connected} ONLINE</span></h2>${state.players.length ? scores() : '<p class="score-empty">An empty room is a quiet room.<br>Get your friends in here.</p>'}<p class="score-legend">${state.phase === 'lobby' ? 'At least 2 connected players to start.' : '1 point per correct guess. Authors sit out their own answer.'}</p></div>`;
    let content;
    if (state.phase === 'lobby') {
      content = `<p class="eyebrow">THE PARTY STARTS HERE</p><h1 class="question">Phones out.<br>Secrets in.</h1><div class="join-box"><p class="meta">YOUR FOUR-LETTER ROOM CODE</p><div class="room-code">${escape(state.code)}</div><p class="join-address"><a href="${escape(joinURL())}">${escape(joinURL())}</a></p><p class="hint">Open this link on your phone, or enter the code on this site.</p></div><p class="progress-note"><span class="pulse"></span><span><strong>${connected} player${connected === 1 ? '' : 's'}</strong> in the room. ${connected < 2 ? 'Waiting for the crew…' : 'Ready when you are.'}</span></p><div class="action-row"><button class="button" data-action="start" ${connected < 2 ? 'disabled' : ''}>Let’s play <span aria-hidden="true">→</span></button><span class="hint">5 rounds. Trust no one.</span></div>`;
    } else if (state.phase === 'answering') {
      content = `${roundHeader()}<h1 class="question">${escape(state.prompt)}</h1><p class="lede">Answer on your phone. Keep it short. Keep it secret.</p><div class="action-row"><p class="progress-note"><span class="pulse"></span><span><strong>${state.answeredCount} / ${state.expectedAnswers}</strong> answers locked in</span></p></div><p class="hint">Answers appear after everyone connected has submitted. Offline players won’t hold up the round.</p>`;
    } else if (state.phase === 'ready') {
      content = `${roundHeader()}<h1 class="question">${escape(state.prompt)}</h1><div class="status-icon" aria-hidden="true">✓</div><h2 class="status-title">Everyone’s in.<br>Let the accusations begin.</h2><p class="lede">${state.answerTotal} anonymous answer${state.answerTotal === 1 ? '' : 's'}. Reveal them one at a time.</p><div class="action-row"><button class="button" data-action="advance">Reveal the first answer <span aria-hidden="true">→</span></button></div>`;
    } else if (['guessing', 'reveal'].includes(state.phase)) {
      const correct = state.correctGuessers.length;
      content = `${roundHeader()}<p class="small-prompt">${escape(state.prompt)}</p><p class="meta">ANSWER ${state.answerNumber} OF ${state.answerTotal}</p><h1 class="answer-quote">“${escape(state.answer.text)}”</h1>${state.phase === 'guessing' ? `<p class="lede">Who said that? Lock your guess on your phone.</p><p class="progress-note"><span class="pulse"></span><span><strong>${state.guessCount} / ${state.expectedGuesses}</strong> guesses locked in</span></p><div class="action-row"><button class="button secondary" data-action="advance">Close guesses &amp; reveal</button><span class="hint">Reveals automatically when all guesses are in.</span></div>` : `<p class="reveal-label">THE AUTHOR WAS</p><h2 class="reveal-author">${escape(state.author.name)}</h2><p class="lede">${correct ? `${correct} player${correct === 1 ? '' : 's'} got it right. +1 point each.` : 'Nobody saw that coming. No points this time.'}</p><div class="action-row"><button class="button" data-action="advance">${state.answerNumber < state.answerTotal ? 'Next anonymous answer' : state.round === state.totalRounds ? 'See the final scores' : 'Round scoreboard'} <span aria-hidden="true">→</span></button></div>`}`;
    } else if (state.phase === 'scoreboard') {
      content = `${roundHeader('ROUND COMPLETE')}<h1 class="question">The plot thickens.</h1><p class="lede">Check the scoreboard. There’s still time to read your friends better.</p>${scores(true)}<div class="action-row"><button class="button" data-action="advance">Start round ${state.round + 1} <span aria-hidden="true">→</span></button></div>`;
    } else {
      content = `${winnerMarkup()}${scores(true)}<div class="action-row"><button class="button" data-action="start" ${connected < 2 ? 'disabled' : ''}>Play again <span aria-hidden="true">↗</span></button></div><p class="hint">New prompts. Scores reset. ${connected < 2 ? 'Wait for at least two players to reconnect.' : 'Same questionable friends.'}</p>`;
    }
    screen.innerHTML = `<section class="panel game-panel">${content}</section>`;
  }

  function renderPlayer() {
    if (!state.me) return;
    const me = state.me;
    const mine = state.players.find((p) => p.id === me.id);
    const scoreContainer = document.getElementById('player-scores');
    const wasOpen = scoreContainer.querySelector('details')?.open;
    scoreContainer.innerHTML = `<details class="score-details" ${wasOpen ? 'open' : ''}><summary>Live scoreboard · ${mine.score} point${mine.score === 1 ? '' : 's'} for you</summary>${scores()}</details>`;
    // Keep the writing field and keyboard intact when other players update.
    const key = JSON.stringify([state.phase, state.round, state.answerNumber, state.prompt, me, state.answer, state.author, state.candidates, state.phase === 'reveal' ? state.correctGuessers : null, state.phase === 'finished' ? state.players.map((p) => [p.id, p.score]) : null]);
    if (key === viewKey) return;
    viewKey = key;
    if (draftRound !== state.round) { answerDraft = ''; draftRound = state.round; }
    const heading = `<p class="player-id"><strong>${escape(mine.name)}</strong> <span aria-hidden="true">·</span> Room ${escape(state.code)}</p>`;
    let content;
    if (state.phase === 'lobby') {
      content = `<p class="eyebrow">YOU’RE ON THE GUEST LIST</p><div class="status-icon" aria-hidden="true">✓</div><h1 class="status-title">You’re in,<br>${escape(mine.name)}.</h1><p class="lede">Make yourself comfortable. Your host will start the game when everyone’s here.</p><p class="progress-note"><span class="pulse"></span>Eyes on the big screen.</p><p class="hint">5 rounds. 1 point for every correct guess.</p>`;
    } else if (state.phase === 'finished') {
      content = `${winnerMarkup()}${scores(true)}<p class="hint">Your host can start a fresh game with this room.</p>`;
    } else if (!me.participating) {
      content = `${roundHeader()}<h1 class="status-title">Fashionably late.</h1><p class="lede">This round is already underway. You’ll join the action on the next round.</p><p class="progress-note"><span class="pulse"></span>Enjoy the show for now.</p>`;
    } else if (state.phase === 'answering' && me.answer === null) {
      content = `${roundHeader()}<h1 class="question">${escape(state.prompt)}</h1><form id="answer-form"><label for="answer-text">Your secret answer</label><textarea id="answer-text" name="text" maxlength="180" placeholder="Make it sound like you. Or don’t." required>${escape(answerDraft)}</textarea><div class="field-footer"><span>Only revealed anonymously.</span><span id="char-count">${answerDraft.length}/180</span></div><button class="button wide" type="submit">Lock in my answer <span aria-hidden="true">→</span></button><p class="hint">Once submitted, your answer is final.</p></form>`;
    } else if (['answering', 'ready'].includes(state.phase)) {
      content = `${roundHeader()}<div class="status-icon" aria-hidden="true">✓</div><h1 class="status-title">Secret safely<br>submitted.</h1>${me.answer !== null ? `<div class="locked-answer">“${escape(me.answer)}”</div>` : ''}<p class="progress-note"><span class="pulse"></span>${state.phase === 'ready' ? 'Look up. Your host is about to reveal the answers.' : 'Waiting for the other answers…'}</p>`;
    } else if (state.phase === 'guessing') {
      content = `${roundHeader()}<p class="meta">ANSWER ${state.answerNumber} OF ${state.answerTotal}</p><h1 class="answer-quote">“${escape(state.answer.text)}”</h1>${me.isAuthor ? '<div class="status-icon" aria-hidden="true">?</div><h2 class="status-title">Sound familiar?</h2><p class="lede">This is your answer. Keep a straight face while everyone else guesses.</p><p class="hint">You sit out your own answer. No free points!</p>' : me.guess ? `<div class="status-icon" aria-hidden="true">✓</div><h2 class="status-title">Guess locked.</h2><p class="lede">You picked <strong>${escape(state.candidates.find((p) => p.id === me.guess)?.name)}</strong>. Let’s see if you read the room right.</p>` : `<h2 class="status-title">Who said that?</h2><p class="hint" style="margin-bottom:18px">Tap a name to lock your guess. Correct guess = 1 point.</p><div class="guess-grid">${state.candidates.filter((p) => p.id !== me.id).map((p) => `<button class="guess-button" data-action="guess" data-player="${escape(p.id)}">${escape(p.name)}</button>`).join('')}</div>`}`;
    } else if (state.phase === 'reveal') {
      const correct = state.correctGuessers.includes(me.id);
      content = `${roundHeader()}<h1 class="answer-quote">“${escape(state.answer.text)}”</h1><p class="reveal-label">THE AUTHOR WAS</p><h2 class="reveal-author">${escape(state.author.name)}</h2><div class="status-icon" aria-hidden="true">${correct ? '+1' : me.isAuthor ? '?' : '→'}</div><h2 class="status-title">${correct ? 'Nailed it.' : me.isAuthor ? 'The secret is out.' : me.guess ? 'Not this time.' : 'No guess this time.'}</h2><p class="lede">${correct ? 'One more point for your detective work.' : me.isAuthor ? 'Hope you kept a straight face.' : 'There’s always the next answer.'}</p><p class="hint">Look up. Your host will keep things moving.</p>`;
    } else {
      content = `${roundHeader('ROUND COMPLETE')}<h1 class="status-title">That’s a wrap<br>on round ${state.round}.</h1><p class="lede">You have <strong>${mine.score} point${mine.score === 1 ? '' : 's'}</strong>. Your host will start the next round.</p>${scores()}`;
    }
    screen.innerHTML = `${heading}<section class="panel show-in">${content}</section>`;
  }

  function updateNotice() {
    if (replaced) showNotice('This session is now open on another screen. Refresh this page to use it here.');
    else if (!socket.connected) showNotice('Connection lost. Reconnecting automatically — keep this page open.');
    else if (state && !state.hostConnected) showNotice('The host is reconnecting. Your answers and scores are safe for now.');
    else showNotice('');
  }

  socket.on('connect', async () => {
    connection.textContent = 'Connected';
    connection.classList.add('online');
    updateNotice();
    if (session) {
      try { await request('resume_session', session); }
      catch (error) {
        // A timeout is not proof the saved session expired. Keep it for retry.
        if (!socket.connected || error.message.includes('did not respond')) {
          showError(error.message);
          return;
        }
        saveSession(null);
        renderInitial();
        showError(error.message);
      }
    }
  });
  socket.on('disconnect', () => {
    connection.textContent = 'Reconnecting';
    connection.classList.remove('online');
    updateNotice();
  });
  socket.on('connect_error', () => {
    connection.textContent = 'Connecting';
    connection.classList.remove('online');
    showNotice('Can’t reach the game server yet. We’ll keep trying automatically.');
  });
  socket.on('session_replaced', () => {
    replaced = true;
    socket.disconnect();
    updateNotice();
  });
  socket.on('room_state', (value) => {
    state = value;
    showError('');
    if (role === 'host') renderHost();
    else renderPlayer();
    updateNotice();
  });

  document.addEventListener('submit', (event) => {
    if (!['join-form', 'answer-form'].includes(event.target.id)) return;
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    perform(form.querySelector('button'), async () => {
      if (form.id === 'join-form') {
        const result = await request('join_room', { code: data.get('code').trim().toUpperCase(), name: data.get('name') });
        saveSession(result.session);
      } else {
        await request('submit_answer', { text: data.get('text'), round: state.round });
      }
    });
  });
  document.addEventListener('input', (event) => {
    if (event.target.id === 'answer-text') {
      answerDraft = event.target.value;
      document.getElementById('char-count').textContent = `${answerDraft.length}/180`;
    }
    if (event.target.id === 'room-code') event.target.value = event.target.value.toUpperCase();
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'reset' && !window.confirm('End this game and reset all scores? Everyone stays in the room.')) return;
    if (action === 'advance' && state.phase === 'guessing' && !window.confirm('Close guessing now? Only guesses already submitted will count.')) return;
    perform(button, async () => {
      if (action === 'create') {
        const result = await request('create_room');
        saveSession(result.session);
      } else if (action === 'start') await request('start_game');
      else if (action === 'advance') await request('host_advance', { phase: state.phase, round: state.round, answerNumber: state.answerNumber });
      else if (action === 'reset') await request('reset_lobby');
      else if (action === 'guess') await request('submit_guess', { playerId: button.dataset.player, round: state.round, answerNumber: state.answerNumber });
      else if (action === 'copy') {
        if (!navigator.clipboard) throw new Error(`Copy this join link: ${joinURL()}`);
        await navigator.clipboard.writeText(joinURL()).catch(() => { throw new Error(`Copy this join link: ${joinURL()}`); });
        showNotice('Join link copied. Send it to your friends.');
      }
    });
  });

  renderInitial(Boolean(session));
  socket.connect();
})();
