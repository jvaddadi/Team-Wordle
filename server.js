const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
// Glitch uses .data/ for persistent storage; fallback to local for other hosts
const DATA_DIR = fs.existsSync('/app/.data') ? '/app/.data' : __dirname;
const DATA_FILE = path.join(DATA_DIR, 'scores.json');

// ============ SCORE STORAGE ============
let scores = [];

function loadScores() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      scores = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Could not load scores:', e.message);
    scores = [];
  }
}

function saveScores() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(scores, null, 2));
  } catch (e) {
    console.error('Could not save scores:', e.message);
  }
}

loadScores();

// ============ HELPERS ============
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ============ LEADERBOARD LOGIC ============
function getLeaderboard(roundFilter) {
  let filtered = scores;
  if (roundFilter !== undefined) {
    filtered = scores.filter(s => s.round === roundFilter);
  }

  // Group by player, compute aggregate stats
  const playerMap = {};
  filtered.forEach(s => {
    if (!playerMap[s.name]) {
      playerMap[s.name] = {
        name: s.name,
        totalPlayed: 0,
        totalWins: 0,
        totalGuesses: 0,
        bestTime: Infinity,
        totalTime: 0,
        rounds: [],
      };
    }
    const p = playerMap[s.name];
    p.totalPlayed++;
    if (s.won) {
      p.totalWins++;
      p.totalGuesses += s.guesses;
      if (s.time < p.bestTime) p.bestTime = s.time;
      p.totalTime += s.time;
    }
    p.rounds.push(s);
  });

  // Convert to sorted array
  const players = Object.values(playerMap).map(p => ({
    name: p.name,
    played: p.totalPlayed,
    wins: p.totalWins,
    winPct: p.totalPlayed ? Math.round(p.totalWins / p.totalPlayed * 100) : 0,
    avgGuesses: p.totalWins ? +(p.totalGuesses / p.totalWins).toFixed(1) : null,
    bestTime: p.bestTime === Infinity ? null : p.bestTime,
    avgTime: p.totalWins ? Math.round(p.totalTime / p.totalWins) : null,
    // Score: lower is better (avg guesses * 100 + avg time). Wins break ties.
    score: p.totalWins
      ? Math.round((p.totalGuesses / p.totalWins) * 100 + (p.totalTime / p.totalWins))
      : 99999,
  }));

  // Sort by score (lower = better), then by wins desc
  players.sort((a, b) => a.score - b.score || b.wins - a.wins);

  return players;
}

function getRoundLeaderboard(round) {
  const roundScores = scores.filter(s => s.round === round);
  // Sort: winners first (by guesses asc, then time asc), then losers
  roundScores.sort((a, b) => {
    if (a.won && !b.won) return -1;
    if (!a.won && b.won) return 1;
    if (a.won && b.won) {
      if (a.guesses !== b.guesses) return a.guesses - b.guesses;
      return a.time - b.time;
    }
    return a.time - b.time;
  });
  return roundScores;
}

function getRecentActivity(limit = 20) {
  return scores.slice(-limit).reverse();
}

// ============ SERVER ============
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // ---- API ROUTES ----

  // Submit a score
  if (pathname === '/api/score' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { name, round, guesses, time, won, emoji, date } = body;

      if (!name || round === undefined || guesses === undefined || time === undefined || won === undefined) {
        return sendJSON(res, 400, { error: 'Missing required fields: name, round, guesses, time, won' });
      }

      // Prevent duplicate submissions for same player + round + date
      const dateStr = date || new Date().toISOString().slice(0, 10);
      const existing = scores.find(s => s.name === name && s.round === round && s.date === dateStr);
      if (existing) {
        return sendJSON(res, 409, { error: 'Score already submitted for this round', existing });
      }

      const score = {
        name: String(name).slice(0, 20),
        round: Number(round),
        guesses: Number(guesses),
        time: Number(time),
        won: Boolean(won),
        emoji: String(emoji || ''),
        date: dateStr,
        timestamp: Date.now(),
      };

      scores.push(score);
      saveScores();

      return sendJSON(res, 201, { ok: true, score });
    } catch (e) {
      return sendJSON(res, 400, { error: 'Invalid JSON body' });
    }
  }

  // Overall leaderboard
  if (pathname === '/api/leaderboard' && req.method === 'GET') {
    const players = getLeaderboard();
    return sendJSON(res, 200, { players });
  }

  // Round-specific leaderboard
  if (pathname.startsWith('/api/round/') && req.method === 'GET') {
    const round = parseInt(pathname.split('/')[3]);
    if (isNaN(round)) return sendJSON(res, 400, { error: 'Invalid round number' });
    const results = getRoundLeaderboard(round);
    return sendJSON(res, 200, { round, results });
  }

  // Recent activity feed
  if (pathname === '/api/activity' && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit')) || 20;
    const activity = getRecentActivity(limit);
    return sendJSON(res, 200, { activity });
  }

  // Today's stats
  if (pathname === '/api/today' && req.method === 'GET') {
    const today = new Date().toISOString().slice(0, 10);
    const todayScores = scores.filter(s => s.date === today);
    const uniquePlayers = new Set(todayScores.map(s => s.name)).size;
    const totalRoundsPlayed = todayScores.length;
    const wins = todayScores.filter(s => s.won).length;
    return sendJSON(res, 200, { date: today, players: uniquePlayers, rounds: totalRoundsPlayed, wins });
  }

  // ---- STATIC FILES ----
  if (pathname === '/' || pathname === '/index.html') {
    return serveStatic(res, path.join(__dirname, 'wordle.html'));
  }

  // Serve other static files
  const filePath = path.join(__dirname, pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return serveStatic(res, filePath);
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n🟩 Team Wordle server running at http://localhost:${PORT}\n`);
  console.log(`Share this URL with your team to play together!`);
  console.log(`Scores are saved to ${DATA_FILE}\n`);
});
