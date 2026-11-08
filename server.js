const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const GAME_WIDTH = 1600;
const GAME_HEIGHT = 900;
const PLAYER_RADIUS = 18;
const PLAYER_SPEED = 220;
const MAX_HEALTH = 100;

const WEAPONS = {
  pistol: { label: "Pistol", damage: 18, fireRate: 340, bulletSpeed: 700, spread: 0.08, color: "#ffffff" },
  smg: { label: "SMG", damage: 11, fireRate: 110, bulletSpeed: 760, spread: 0.12, color: "#67f7d1" },
  rifle: { label: "Rifle", damage: 15, fireRate: 260, bulletSpeed: 820, spread: 0.05, color: "#7ec8ff" },
  shotgun: { label: "Shotgun", damage: 9, fireRate: 620, bulletSpeed: 640, spread: 0.22, pellets: 6, color: "#ffd166" },
  blaster: { label: "Blaster", damage: 28, fireRate: 230, bulletSpeed: 920, spread: 0.04, color: "#ff7f7f" }
};

const players = {};
const bullets = [];

const match = {
  started: false,
  round: 0,
  timer: 0,
  questions: []
};

let roundResetPending = false;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function getLevelFromScore(score) {
  return Math.max(1, Math.floor(score / 300) + 1);
}

function getRankFromLevel(level) {
  if (level >= 25) return "Elite Commander";
  if (level >= 18) return "Legend";
  if (level >= 12) return "Veteran";
  if (level >= 8) return "Sharpshooter";
  if (level >= 5) return "Advanced";
  if (level >= 3) return "Ranger";
  return "Rookie";
}

function makeSpawnPoint() {
  return {
    x: randomBetween(80, GAME_WIDTH - 80),
    y: randomBetween(80, GAME_HEIGHT - 80)
  };
}

function generateMathQuestion() {
  const type = Math.floor(Math.random() * 7);

  if (type === 0) {
    const a = randomBetween(2, 12);
    const b = randomBetween(1, 14);
    const x = randomBetween(2, 9);
    return {
      text: `If y = ${a}x + ${b} and x = ${x}, what is y?`,
      answer: a * x + b
    };
  }

  if (type === 1) {
    const a = randomBetween(2, 8);
    const b = randomBetween(1, 12);
    const c = randomBetween(1, 9);
    const root1 = randomBetween(1, 5);
    const root2 = randomBetween(1, 5);
    const sum = root1 + root2;
    const product = root1 * root2;
    const coefficientA = 1;
    const coefficientB = -sum;
    const coefficientC = product;
    const quadraticText = `What is the sum of the solutions of x^2 ${coefficientB < 0 ? "-" : "+"} ${Math.abs(coefficientB)}x ${coefficientC < 0 ? "-" : "+"} ${Math.abs(coefficientC)} = 0?`;
    return { text: quadraticText, answer: sum };
  }

  if (type === 2) {
    const a = randomBetween(2, 9);
    const b = randomBetween(2, 12);
    return {
      text: `Solve: ${a}x + ${b} = ${a * 3 + b}?`,
      answer: 3
    };
  }

  if (type === 3) {
    const value = randomBetween(1, 5);
    return {
      text: `Evaluate: log_2(2^${value})`,
      answer: value
    };
  }

  if (type === 4) {
    const base = randomBetween(2, 5);
    const power1 = randomBetween(2, 4);
    const power2 = randomBetween(2, 4);
    return {
      text: `Simplify: ${base}^{power1} × ${base}^{power2}`,
      answer: Math.pow(base, power1 + power2)
    };
  }

  if (type === 5) {
    const a = randomBetween(2, 9);
    const b = randomBetween(2, 12);
    return {
      text: `If sin(θ) = ${a}/${b} and θ is acute, what is cos(θ)?`,
      answer: Math.sqrt(1 - (a / b) ** 2)
    };
  }

  const x = randomBetween(2, 7);
  const y = randomBetween(1, 6);
  return {
    text: `If 2x + 3y = ${2 * x + 3 * y} and x = ${x}, what is y?`,
    answer: y
  };
}

function generateRoundQuestions() {
  return Array.from({ length: 3 }, () => generateMathQuestion());
}

function getPublicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    x: player.x,
    y: player.y,
    angle: player.angle,
    health: player.health,
    kills: player.kills,
    deaths: player.deaths,
    score: player.score,
    level: player.level,
    rank: player.rank,
    weapon: player.weapon,
    alive: player.alive
  };
}

function getLeaderboard() {
  return Object.values(players)
    .map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      level: player.level,
      rank: player.rank
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

function createPlayer(socketId, name) {
  const spawn = makeSpawnPoint();
  return {
    id: socketId,
    name: String(name).slice(0, 18) || "Player",
    x: spawn.x,
    y: spawn.y,
    angle: 0,
    health: MAX_HEALTH,
    weapon: "pistol",
    kills: 0,
    deaths: 0,
    score: 0,
    level: 1,
    rank: "Rookie",
    alive: true,
    input: { up: false, down: false, left: false, right: false },
    lastShotAt: 0,
    answersSolved: 0,
    questionIndex: 0,
    respawnTimer: 0
  };
}

function beginRound() {
  match.round += 1;
  match.timer = 45;
  match.questions = generateRoundQuestions();

  for (const playerId in players) {
    const player = players[playerId];
    player.answersSolved = 0;
    player.questionIndex = 0;
    player.health = MAX_HEALTH;
  }

  io.emit("roundUpdate", {
    round: match.round,
    timer: match.timer,
    questions: match.questions,
    totalQuestions: 3
  });

  for (const socket of io.sockets.sockets.values()) {
    sendPlayerState(socket);
  }
}

function startMatch() {
  if (match.started) return;
  match.started = true;
  beginRound();
}

function queueNextRound() {
  if (roundResetPending) return;
  roundResetPending = true;
  setTimeout(() => {
    roundResetPending = false;
    beginRound();
  }, 2000);
}

function playerProgress(player) {
  const questionIndex = Math.min(player.answersSolved, 2);
  const currentQuestion = match.questions[questionIndex] || {
    text: "Round complete! Preparing a new challenge...",
    answer: null
  };

  return {
    round: match.round,
    timer: match.timer,
    totalQuestions: 3,
    answeredCount: player.answersSolved,
    currentQuestion,
    score: player.score,
    level: player.level,
    rank: player.rank
  };
}

function sendPlayerState(socket) {
  const player = players[socket.id];
  if (!player) return;
  socket.emit("playerState", playerProgress(player));
}

function broadcastGameState() {
  const payload = {
    players: Object.fromEntries(Object.entries(players).map(([id, player]) => [id, getPublicPlayer(player)])),
    bullets: bullets.map((bullet) => ({
      x: bullet.x,
      y: bullet.y,
      color: bullet.color,
      radius: bullet.radius,
      ttl: bullet.ttl
    })),
    round: match.round,
    timer: match.timer,
    leaderboard: getLeaderboard(),
    started: match.started
  };

  io.emit("gameState", payload);
}

function triggerShot(player) {
  const weapon = WEAPONS[player.weapon];
  if (!weapon) return;

  const now = Date.now();
  if (now - player.lastShotAt < weapon.fireRate) return;

  player.lastShotAt = now;

  const pelletCount = weapon.pellets || 1;

  for (let i = 0; i < pelletCount; i += 1) {
    const angleDelta = weapon.spread ? randomBetween(-weapon.spread, weapon.spread) : 0;
    const angle = player.angle + angleDelta;

    bullets.push({
      x: player.x + Math.cos(angle) * (PLAYER_RADIUS + 10),
      y: player.y + Math.sin(angle) * (PLAYER_RADIUS + 10),
      vx: Math.cos(angle) * weapon.bulletSpeed,
      vy: Math.sin(angle) * weapon.bulletSpeed,
      ownerId: player.id,
      color: weapon.color,
      radius: weapon.pellets ? 4 : 5,
      ttl: 1800,
      damage: weapon.damage
    });
  }
}

function resetPlayer(player) {
  const spawn = makeSpawnPoint();
  player.x = spawn.x;
  player.y = spawn.y;
  player.health = MAX_HEALTH;
  player.alive = true;
  player.respawnTimer = 0;
}

function handleShoot(socket) {
  const player = players[socket.id];
  if (!player || !player.alive) return;
  triggerShot(player);
}

function handleAnswer(socket, answerText) {
  const player = players[socket.id];
  if (!player || !match.questions.length) return;

  const currentQuestion = match.questions[player.answersSolved];
  if (!currentQuestion) return;

  const guess = Number(answerText);
  if (Number.isNaN(guess)) {
    socket.emit("answerFeedback", { correct: false, message: "Please enter a valid number." });
    return;
  }

  const closeEnough = Math.abs(guess - currentQuestion.answer) < 0.00001;
  if (!closeEnough) {
    socket.emit("answerFeedback", { correct: false, message: "Incorrect. Try again!" });
    return;
  }

  player.answersSolved += 1;
  player.score += 150;
  player.level = getLevelFromScore(player.score);
  player.rank = getRankFromLevel(player.level);
  player.health = clamp(player.health + 10, 0, MAX_HEALTH);

  socket.emit("answerFeedback", { correct: true, message: "Correct! +150 points" });

  if (player.answersSolved >= 3) {
    player.score += 200;
    player.level = getLevelFromScore(player.score);
    player.rank = getRankFromLevel(player.level);
    socket.emit("answerFeedback", { correct: true, message: "Round clear! Great job!" });
  }

  if (Object.values(players).every((entry) => entry.answersSolved >= 3)) {
    queueNextRound();
  }

  sendPlayerState(socket);
  broadcastGameState();
}

function updatePlayers(dt) {
  for (const playerId in players) {
    const player = players[playerId];
    if (!player.alive) {
      player.respawnTimer -= dt;
      if (player.respawnTimer <= 0) {
        resetPlayer(player);
      }
      continue;
    }

    const input = player.input;
    let dx = 0;
    let dy = 0;

    if (input.up) dy -= 1;
    if (input.down) dy += 1;
    if (input.left) dx -= 1;
    if (input.right) dx += 1;

    if (dx !== 0 || dy !== 0) {
      const length = Math.hypot(dx, dy) || 1;
      player.x += (dx / length) * PLAYER_SPEED * dt;
      player.y += (dy / length) * PLAYER_SPEED * dt;
    }

    player.x = clamp(player.x, PLAYER_RADIUS, GAME_WIDTH - PLAYER_RADIUS);
    player.y = clamp(player.y, PLAYER_RADIUS, GAME_HEIGHT - PLAYER_RADIUS);
  }
}

function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i -= 1) {
    const bullet = bullets[i];
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;
    bullet.ttl -= dt * 1000;

    if (
      bullet.x < -20 ||
      bullet.y < -20 ||
      bullet.x > GAME_WIDTH + 20 ||
      bullet.y > GAME_HEIGHT + 20 ||
      bullet.ttl <= 0
    ) {
      bullets.splice(i, 1);
      continue;
    }

    for (const playerId in players) {
      const player = players[playerId];
      if (!player.alive || player.id === bullet.ownerId) continue;

      const dx = bullet.x - player.x;
      const dy = bullet.y - player.y;
      const distance = Math.hypot(dx, dy);

      if (distance <= PLAYER_RADIUS + bullet.radius) {
        player.health -= bullet.damage;
        bullets.splice(i, 1);

        if (player.health <= 0) {
          const killer = players[bullet.ownerId];
          if (killer) {
            killer.kills += 1;
            killer.score += 120;
            killer.level = getLevelFromScore(killer.score);
            killer.rank = getRankFromLevel(killer.level);
          }

          player.deaths += 1;
          player.alive = false;
          player.respawnTimer = 2.5;
          player.health = 0;
        }

        break;
      }
    }
  }
}

setInterval(() => {
  const dt = 1 / 60;
  if (match.started) {
    match.timer = Math.max(0, match.timer - dt);
    if (match.timer <= 0) {
      const unfinishedPlayers = Object.values(players).filter((player) => player.answersSolved < 3);
      unfinishedPlayers.forEach((player) => {
        player.score += 25;
        player.level = getLevelFromScore(player.score);
        player.rank = getRankFromLevel(player.level);
      });
      queueNextRound();
      match.timer = 0;
    }
  }

  updatePlayers(dt);
  updateBullets(dt);
  broadcastGameState();

  for (const socket of io.sockets.sockets.values()) {
    sendPlayerState(socket);
  }
}, 1000 / 60);

io.on("connection", (socket) => {
  socket.on("joinGame", ({ name }) => {
    if (players[socket.id]) return;

    const player = createPlayer(socket.id, name);
    players[socket.id] = player;
    startMatch();
    sendPlayerState(socket);
    broadcastGameState();
  });

  socket.on("input", ({ up, down, left, right }) => {
    const player = players[socket.id];
    if (!player) return;
    player.input = {
      up: !!up,
      down: !!down,
      left: !!left,
      right: !!right
    };
  });

  socket.on("aim", ({ angle }) => {
    const player = players[socket.id];
    if (!player) return;
    player.angle = Number(angle) || 0;
  });

  socket.on("switchWeapon", (weaponKey) => {
    const player = players[socket.id];
    if (!player || !WEAPONS[weaponKey]) return;
    player.weapon = weaponKey;
  });

  socket.on("shoot", () => {
    handleShoot(socket);
  });

  socket.on("submitAnswer", ({ answer }) => {
    handleAnswer(socket, answer);
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    if (Object.keys(players).length === 0) {
      match.started = false;
      match.round = 0;
      match.timer = 0;
      match.questions = [];
      roundResetPending = false;
    }
    broadcastGameState();
  });
});

app.get("/health", (_, res) => {
  res.json({ ok: true, players: Object.keys(players).length, round: match.round });
});

server.listen(PORT, () => {
  console.log(`Math Arena running on http://localhost:${PORT}`);
});
