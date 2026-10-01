# Who Said That?

A real-time party game for a shared host screen and 2–16 player phones. Everyone answers the same funny prompt, then guesses who wrote each anonymous answer. Five rounds, one point per correct guess, and a live scoreboard. Includes 36 built-in prompts.

## Install

Use **Node.js 20 or newer** (Node.js 24 LTS recommended) and npm:

```sh
npm ci
```

Only Express and Socket.IO are runtime dependencies. Socket.IO’s client library is served by the same server; no CDN, frontend compilation, database, or environment secrets are needed. The Socket.IO client dev dependency is used for integration tests.

## Run locally

```sh
npm start
```

The server binds to all interfaces on `process.env.PORT || 3000`. Open `/host` on your computer or TV browser and create a room. Open `/` on each phone, then enter the room code and a unique display name, or use the host’s join link.

For local phone play, connect the devices to the same Wi-Fi and open the host screen using your computer’s **LAN address** and port, so its generated join link is reachable by phones. A computer-only loopback address will not work on another device. All browser assets and Socket.IO connections use the current origin; there are no hardcoded hostnames.

To use another port:

```sh
PORT=8080 npm start
```

Run the tests:

```sh
npm test
```

Tests start an isolated server on an ephemeral port and exercise real Socket.IO clients: a complete five-round game, private answers, scoring, validation, stale actions, reconnects, late joins, and disconnected voters. `/health` returns `{ "ok": true }` for a basic server health check.

## How to play

1. Host creates a room at `/host`. A four-letter code and join URL appear.
2. Players join from their phones. Names are unique within the room, ignoring case and normalizing Unicode.
3. Host starts once at least two players are connected. Each player gets the same prompt and locks in a private answer (up to 180 characters).
4. Once all connected round participants have answered, the host reveals the first anonymous answer. Submitted answers are shuffled.
5. Players tap a name to lock their guess. The author sits out their own answer. Each correct guess earns one point.
6. The author is revealed automatically when all connected eligible players have guessed. The host can also close guessing early; only submitted guesses count.
7. Host reveals the next answer, then shows the round scoreboard and starts the next round.
8. After five rounds, everyone sees the final scores. Host can play again with reset scores and a fresh random selection of prompts, or reset to the lobby at any time.

## Project structure

```text
server.js            Express entry point, room state, Socket.IO handlers
prompts.js           Built-in prompt bank
public/
  index.html         Player phone page at /
  host.html          Shared host page at /host
  app.js             Vanilla JS, socket lifecycle, host/player rendering
  style.css          Responsive dark game-show styling
test/
  game.test.js       Node test runner + Socket.IO integration tests
package.json         npm start / npm test / npm run build and dependencies
package-lock.json    Reproducible dependency installation
```

## Socket.IO game flow

The Node server is authoritative. Each in-memory room holds its players, scores, prompt deck, round participants, private submissions, shuffled answers, and guesses. Clients send actions with acknowledgements (`{ ok: true }` or `{ ok: false, error }`); the server validates the screen’s role, phase, round, and inputs before changing state.

| Client event | Purpose |
| --- | --- |
| `create_room` | Create a room and a host session |
| `join_room` | Join with `{ code, name }` and receive a player session |
| `resume_session` | Restore a host/player using the saved session token |
| `start_game` | Host begins a new five-round game |
| `submit_answer` | Player submits `{ text, round }` once per round |
| `submit_guess` | Player submits `{ playerId, round, answerNumber }` once per answer |
| `host_advance` | Host advances with `{ phase, round, answerNumber }`; stale controls are rejected |
| `reset_lobby` | Host ends the current game and resets scores |

The server emits `room_state` to each screen after changes. Snapshots contain only the current revealed answer; the host and other phones cannot see pending answer text, session tokens, or the correct author before the reveal. Player snapshots additionally include that player’s own submission and guess. The room phases are:

```text
lobby → answering → ready → guessing → reveal
                              ↑          │
                              └──────────┘ (next answer)
                                         │
                                    scoreboard → answering (next round)
                                         │
                                      finished (after round 5)
```

The host controls answer pacing and round transitions. Scores update on each author reveal, with ties supported in final results. Answer and guess text is rendered as text/escaped HTML, and the server enforces player limits, payload limits, and basic per-connection event throttling.

## Reconnects and leaving

Host and player sessions are saved in browser `localStorage`, separately. A brief connection loss or page refresh restores the same seat, answer, and score. Opening the same saved session in a second tab replaces the older connection. Session tokens are lightweight reconnect capabilities, not accounts or a login system; keep a host’s browser session private.

Disconnected players appear offline and are excluded from answer/guess waiting checks. Previously submitted answers and guesses still count. Reconnecting before submissions close lets a player finish; after they close, that player waits for the next round. Players joining mid-round also wait for the next round. Offline names and scores remain reserved for reconnecting players, and offline players are not included in future rounds until they reconnect. If nobody can answer, the host can use **Reset to lobby** and wait for players to return.

Room state exists only in memory. Restarting the Node process loses all rooms. Completely disconnected rooms expire after six hours. In-progress games do not survive deployments, and a reconnect cannot recover state after a server restart.

## Deployment on SiteGround Node.js hosting

Deploy these files to your Node.js application directory, select Node.js 20+ (preferably 24), install runtime dependencies with `npm ci --omit=dev`, and set the startup file to **`server.js`** (or run `npm start`, depending on the hosting panel). Let the hosting service provide `PORT`. Use your actual domain and HTTPS to open `/host` and `/`.

In Site Tools → Node.js Deployment Options, choose **Express**, branch **main**, and package manager **npm**. In the build command field, enter **`run build`** after its prefilled `npm` prefix. Leave the output directory blank to use the repository root. The full command is `npm run build`: it checks the syntax of the server, prompts, and browser JavaScript, then exits. The application serves its existing files directly, so this script does not generate a `dist` directory. Keep `npm start` as the application startup command.

The application needs a **single persistent Node process** and the hosting reverse proxy must forward HTTP and Socket.IO traffic at `/socket.io/`. Socket.IO supports both HTTP long-polling and WebSocket upgrades; enable WebSocket upgrades where supported. Check both transport support and Node.js application availability for your specific SiteGround plan; static-only/PHP hosting cannot run this server. No SiteGround-specific SDK or configuration is required by the application.

Keep one process/instance for v1: a cluster or multiple replicas would split in-memory rooms, and deployments restart games. Persistent shared storage and a Socket.IO adapter would be separate future work. HTTPS also enables the host’s copy-link button; the join URL remains visible when clipboard access is unavailable.
