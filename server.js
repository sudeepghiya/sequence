// Sequence — multiplayer server (Express + Socket.IO). All game state lives in memory.
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 20000, pingTimeout: 25000 });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.send('ok'));

// ---------- Board ----------
// XX = free corner (counts for every team). T = 10.
const LAYOUT = `
XX 2S 3S 4S 5S 6S 7S 8S 9S XX
6C 5C 4C 3C 2C AH KH QH TH TS
7C AS 2D 3D 4D 5D 6D 7D 9H QS
8C KS 6C 5C 4C 3C 2C 8D 8H KS
9C QS 7C 6H 5H 4H AH 9D 7H AS
TC TS 8C 7H 2H 3H KH TD 6H 2D
QC 9S 9C 8H 9H TH QH QD 5H 3D
KC 8S TC QC KC AC AD KD 4H 4D
AC 7S 6S 5S 4S 3S 2S 2H 3H 5D
XX AD KD QD TD 9D 8D 7D 6D XX
`.trim().split('\n').map(row => row.trim().split(/\s+/));

const POS = {};
LAYOUT.forEach((row, r) => row.forEach((card, c) => {
  if (card !== 'XX') (POS[card] = POS[card] || []).push([r, c]);
}));

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const HAND_SIZE = { 2: 7, 3: 6, 4: 6, 6: 5, 8: 4, 9: 4, 10: 3, 12: 3 };
const TEAM_NAMES = ['Blue', 'Green', 'Red'];

const isTwoEyed = c => c === 'JD' || c === 'JC';   // wild: place anywhere
const isOneEyed = c => c === 'JS' || c === 'JH';   // remove an opponent chip
const inBounds = (r, c) => Number.isInteger(r) && Number.isInteger(c) && r >= 0 && r < 10 && c >= 0 && c < 10;
const isCorner = (r, c) => LAYOUT[r][c] === 'XX';

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function newDeck() {
  const d = [];
  for (let k = 0; k < 2; k++) for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  return shuffle(d);
}
function cardName(card) {
  const sym = { S: '♠', H: '♥', D: '♦', C: '♣' }[card[1]];
  return (card[0] === 'T' ? '10' : card[0]) + sym;
}

// ---------- Rooms ----------
const rooms = new Map();
const newId = () => crypto.randomBytes(12).toString('hex');

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}
function cleanName(n) {
  return String(n || '').replace(/[<>]/g, '').trim().slice(0, 16);
}
function addLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 100) room.log.shift();
}
function smallestTeam(room) {
  const counts = Array(room.numTeams).fill(0);
  room.players.forEach(p => { if (p.team < room.numTeams) counts[p.team]++; });
  return counts.indexOf(Math.min(...counts));
}
function isLocked(room, r, c) {
  return room.sequences.some(s => s.cells.some(([a, b]) => a === r && b === c));
}

function createRoom(hostPlayer) {
  const room = {
    code: newCode(),
    hostId: hostPlayer.id,
    numTeams: 2,
    players: [hostPlayer],
    phase: 'lobby',
    board: emptyBoard(),
    sequences: [],
    deck: [],
    discard: [],
    order: [],
    turn: 0,
    deadUsed: false,
    lastMove: null,
    winner: null,
    log: [],
    games: 0,
    lastActive: Date.now(),
  };
  hostPlayer.team = 0;
  rooms.set(room.code, room);
  return room;
}
function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(10).fill(null));
}

function viewFor(room, pid) {
  const me = room.players.find(p => p.id === pid);
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    you: pid,
    numTeams: room.numTeams,
    players: room.players.map(p => ({
      id: p.id, name: p.name, team: p.team, connected: p.connected, cards: p.hand.length,
    })),
    order: room.order,
    turn: room.turn,
    board: room.board,
    sequences: room.sequences,
    seqNeeded: room.numTeams === 3 ? 1 : 2,
    hand: me ? me.hand : [],
    deckCount: room.deck.length,
    lastMove: room.lastMove,
    log: room.log.slice(-40),
    winner: room.winner,
    deadUsed: room.deadUsed,
    canPlay: me && room.phase === 'playing' ? hasLegalPlay(room, me) : false,
  };
}
function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('state', viewFor(room, p.id));
  }
}

function drawCard(room, p) {
  if (room.deck.length === 0 && room.discard.length > 0) {
    room.deck = shuffle(room.discard);
    room.discard = [];
    addLog(room, 'Deck reshuffled');
  }
  if (room.deck.length > 0) p.hand.push(room.deck.pop());
}

// Find sequences of 5 created by a chip placed at (r, c).
// Corners count for everyone. A new sequence may share at most one chip with
// any existing sequence of the same team.
function findNewSequences(room, r, c, team) {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  const owned = (rr, cc) => inBounds(rr, cc) && (isCorner(rr, cc) || room.board[rr][cc] === team);
  const found = [];
  for (const [dr, dc] of dirs) {
    const cells = [[r, c]];
    let rr = r - dr, cc = c - dc;
    while (owned(rr, cc)) { cells.unshift([rr, cc]); rr -= dr; cc -= dc; }
    rr = r + dr; cc = c + dc;
    while (owned(rr, cc)) { cells.push([rr, cc]); rr += dr; cc += dc; }
    if (cells.length < 5) continue;
    const idx = cells.findIndex(([a, b]) => a === r && b === c);
    for (let s = Math.max(0, idx - 4); s <= Math.min(idx, cells.length - 5); s++) {
      const win = cells.slice(s, s + 5);
      const existing = room.sequences.filter(q => q.team === team).concat(found);
      const ok = existing.every(seq => {
        const overlap = win.filter(([a, b]) => seq.cells.some(([x, y]) => x === a && y === b)).length;
        return overlap <= 1;
      });
      if (ok) found.push({ team, cells: win });
    }
  }
  return found;
}

const isDead = (room, card) => card[0] !== 'J' && POS[card].every(([r, c]) => room.board[r][c] !== null);

// Can this player place or remove a chip with any card in hand?
function hasLegalPlay(room, p) {
  return p.hand.some(card => {
    if (isTwoEyed(card)) return room.board.some((row, r) => row.some((v, c) => v === null && !isCorner(r, c)));
    if (isOneEyed(card)) return room.board.some((row, r) => row.some((v, c) => v !== null && v !== p.team && !isLocked(room, r, c)));
    return !isDead(room, card);
  });
}
const boardFull = room => room.board.every((row, r) => row.every((v, c) => v !== null || isCorner(r, c)));

function startGame(room) {
  const n = room.numTeams;
  const teams = Array.from({ length: n }, (_, t) => room.players.filter(p => p.team === t));
  const size = teams[0].length;
  if (size === 0 || teams.some(t => t.length !== size)) {
    return `Teams must be the same size (${teams.map((t, i) => `${TEAM_NAMES[i]} ${t.length}`).join(', ')})`;
  }
  const total = room.players.length;
  if (!HAND_SIZE[total]) return `Can't play with ${total} players`;

  // Turn order alternates teams; rotate who starts each game.
  const order = [];
  for (let i = 0; i < size; i++) for (let t = 0; t < n; t++) order.push(teams[t][i].id);
  const shift = room.games % order.length;
  room.order = order.slice(shift).concat(order.slice(0, shift));

  room.deck = newDeck();
  room.discard = [];
  room.board = emptyBoard();
  room.sequences = [];
  room.lastMove = null;
  room.winner = null;
  room.turn = 0;
  room.deadUsed = false;
  room.log = [];
  for (const p of room.players) {
    p.hand = [];
    for (let k = 0; k < HAND_SIZE[total]; k++) p.hand.push(room.deck.pop());
  }
  room.phase = 'playing';
  room.games++;
  const first = room.players.find(p => p.id === room.order[0]);
  addLog(room, `Game started. ${first.name} goes first.`);
  return null;
}

// ---------- Socket handlers ----------
io.on('connection', socket => {
  const ctx = () => {
    const room = rooms.get(socket.data.code);
    const p = room && room.players.find(x => x.id === socket.data.pid);
    return { room, p };
  };
  const attach = (room, p) => {
    p.socketId = socket.id;
    p.connected = true;
    socket.data.code = room.code;
    socket.data.pid = p.id;
  };
  const reply = (cb, data) => { if (typeof cb === 'function') cb(data); };

  socket.on('create', ({ name } = {}, cb) => {
    name = cleanName(name);
    if (!name) return reply(cb, { error: 'Enter your name' });
    const p = { id: newId(), name, team: 0, hand: [], connected: true };
    const room = createRoom(p);
    attach(room, p);
    addLog(room, `${name} created the room`);
    reply(cb, { ok: true, code: room.code, pid: p.id });
    broadcast(room);
  });

  socket.on('join', ({ code, name, pid } = {}, cb) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return reply(cb, { error: 'Room not found' });
    let p = pid && room.players.find(x => x.id === pid);
    if (!p) {
      if (room.phase !== 'lobby') return reply(cb, { error: 'That game has already started' });
      if (room.players.length >= 12) return reply(cb, { error: 'Room is full' });
      name = cleanName(name);
      if (!name) return reply(cb, { error: 'Enter your name' });
      p = { id: newId(), name, team: smallestTeam(room), hand: [], connected: true };
      room.players.push(p);
      addLog(room, `${name} joined`);
    }
    attach(room, p);
    reply(cb, { ok: true, code: room.code, pid: p.id });
    broadcast(room);
  });

  socket.on('setTeams', ({ n } = {}) => {
    const { room, p } = ctx();
    if (!room || room.phase !== 'lobby' || p.id !== room.hostId) return;
    if (n !== 2 && n !== 3) return;
    room.numTeams = n;
    room.players.forEach(x => { if (x.team >= n) x.team = smallestTeam(room); });
    broadcast(room);
  });

  socket.on('pickTeam', ({ team } = {}) => {
    const { room, p } = ctx();
    if (!room || room.phase !== 'lobby') return;
    if (!Number.isInteger(team) || team < 0 || team >= room.numTeams) return;
    p.team = team;
    broadcast(room);
  });

  socket.on('start', (_, cb) => {
    const { room, p } = ctx();
    if (!room || room.phase !== 'lobby') return reply(cb, { error: 'Not in lobby' });
    if (p.id !== room.hostId) return reply(cb, { error: 'Only the host can start' });
    const err = startGame(room);
    if (err) return reply(cb, { error: err });
    broadcast(room);
    reply(cb, { ok: true });
  });

  socket.on('play', ({ card, r, c } = {}, cb) => {
    const { room, p } = ctx();
    if (!room || room.phase !== 'playing') return reply(cb, { error: 'No game in progress' });
    if (room.order[room.turn] !== p.id) return reply(cb, { error: "It's not your turn" });
    const i = p.hand.indexOf(card);
    if (i < 0) return reply(cb, { error: "You don't have that card" });
    if (!inBounds(r, c) || isCorner(r, c)) return reply(cb, { error: 'Invalid space' });

    const cell = room.board[r][c];
    let action;
    if (isOneEyed(card)) {
      if (cell === null || cell === p.team) return reply(cb, { error: 'Pick an opponent chip to remove' });
      if (isLocked(room, r, c)) return reply(cb, { error: "That chip is part of a sequence and can't be removed" });
      room.board[r][c] = null;
      action = 'remove';
    } else {
      if (cell !== null) return reply(cb, { error: 'That space is taken' });
      if (!isTwoEyed(card) && LAYOUT[r][c] !== card) return reply(cb, { error: "That card doesn't match this space" });
      room.board[r][c] = p.team;
      action = 'place';
    }

    p.hand.splice(i, 1);
    room.discard.push(card);
    const where = cardName(LAYOUT[r][c]);
    if (action === 'remove') addLog(room, `${p.name} used ${cardName(card)} to remove a ${TEAM_NAMES[cell]} chip from ${where}`);
    else addLog(room, `${p.name} played ${cardName(card)}${isTwoEyed(card) ? ` (wild) on ${where}` : ''}`);

    if (action === 'place') {
      const made = findNewSequences(room, r, c, p.team);
      if (made.length) {
        room.sequences.push(...made);
        addLog(room, `🎉 ${TEAM_NAMES[p.team]} made ${made.length > 1 ? made.length + ' sequences' : 'a sequence'}!`);
      }
    }
    room.lastMove = { r, c, team: p.team, action, card, by: p.id };
    drawCard(room, p);

    const needed = room.numTeams === 3 ? 1 : 2;
    const have = room.sequences.filter(s => s.team === p.team).length;
    if (have >= needed) {
      room.phase = 'over';
      room.winner = p.team;
      addLog(room, `🏆 ${TEAM_NAMES[p.team]} team wins!`);
    } else {
      room.turn = (room.turn + 1) % room.order.length;
      room.deadUsed = false;
    }
    broadcast(room);
    reply(cb, { ok: true });
  });

  // A dead card is a normal card whose two board spaces are both covered.
  socket.on('deadCard', ({ card } = {}, cb) => {
    const { room, p } = ctx();
    if (!room || room.phase !== 'playing') return reply(cb, { error: 'No game in progress' });
    if (room.order[room.turn] !== p.id) return reply(cb, { error: "It's not your turn" });
    // One swap per turn, unless you'd otherwise have no legal play at all.
    if (room.deadUsed && hasLegalPlay(room, p)) return reply(cb, { error: 'You can only swap one dead card per turn' });
    const i = p.hand.indexOf(card);
    if (i < 0) return reply(cb, { error: "You don't have that card" });
    if (!isDead(room, card)) return reply(cb, { error: "That card isn't dead" });
    p.hand.splice(i, 1);
    room.discard.push(card);
    drawCard(room, p);
    room.deadUsed = true;
    addLog(room, `${p.name} swapped a dead ${cardName(card)}`);
    broadcast(room);
    reply(cb, { ok: true });
  });

  // Escape hatch: no legal play and no dead card to swap (e.g. only one-eyed Jacks
  // with nothing to remove). Discard a card, draw, and pass the turn.
  socket.on('pass', (_, cb) => {
    const { room, p } = ctx();
    if (!room || room.phase !== 'playing') return reply(cb, { error: 'No game in progress' });
    if (room.order[room.turn] !== p.id) return reply(cb, { error: "It's not your turn" });
    if (hasLegalPlay(room, p) || p.hand.some(c => isDead(room, c))) return reply(cb, { error: 'You still have a move' });
    if (boardFull(room)) {
      room.phase = 'over';
      room.winner = null;
      addLog(room, 'The board is full — the game is a draw');
    } else {
      const card = p.hand.shift();
      if (card) { room.discard.push(card); drawCard(room, p); }
      addLog(room, `${p.name} had no move and passed`);
      room.turn = (room.turn + 1) % room.order.length;
      room.deadUsed = false;
    }
    broadcast(room);
    reply(cb, { ok: true });
  });

  socket.on('backToLobby', () => {
    const { room, p } = ctx();
    if (!room || p.id !== room.hostId || room.phase === 'lobby') return;
    room.phase = 'lobby';
    room.players.forEach(x => { x.hand = []; });
    addLog(room, 'Back to the lobby');
    broadcast(room);
  });

  socket.on('leave', () => {
    const { room, p } = ctx();
    if (!room) return;
    socket.data.code = null;
    if (room.phase !== 'lobby') { p.connected = false; p.socketId = null; broadcast(room); return; }
    room.players = room.players.filter(x => x.id !== p.id);
    if (room.players.length === 0) { rooms.delete(room.code); return; }
    if (room.hostId === p.id) room.hostId = room.players[0].id;
    addLog(room, `${p.name} left`);
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const { room, p } = ctx();
    if (!room || !p || p.socketId !== socket.id) return;
    p.connected = false;
    p.socketId = null;
    broadcast(room);
  });
});

// Drop rooms nobody has touched in 3 hours.
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.lastActive < cutoff && room.players.every(p => !p.connected)) rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => console.log(`Sequence server running on port ${PORT}`));
}
module.exports = { server, LAYOUT, POS, findNewSequences };
