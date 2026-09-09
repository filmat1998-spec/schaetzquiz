// Schätzquiz Web-App für Mitarbeiterversammlungen
// ------------------------------------------------
// Online-Start über Render:
//   Build Command: npm install
//   Start Command: npm start
//   Environment Variable optional: ADMIN_PIN=2468
//
// Lokal, falls irgendwann möglich:
//   npm install
//   ADMIN_PIN=2468 node server.js

const os = require("os");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PIN = String(process.env.ADMIN_PIN || "1234").trim();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const state = {
  participants: {},
  questions: [],
  answers: {},
  scores: {},
  currentQuestionId: null,
  status: "lobby",
  awarded: {},
  history: []
};

function now() {
  return Date.now();
}

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function cleanText(value, max = 120) {
  return String(value || "").replace(/[<>]/g, "").trim().slice(0, max);
}

function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const normalized = String(value || "")
    .trim()
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .replace(",", ".");

  if (!/^[-+]?\d+(\.\d+)?$/.test(normalized)) return null;

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function fmt(number) {
  if (!Number.isFinite(number)) return "";
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(number);
}

function currentQuestion() {
  return state.questions.find(question => question.id === state.currentQuestionId) || null;
}

function getResults(questionId) {
  const question = state.questions.find(item => item.id === questionId);
  if (!question) return [];

  const rows = Object.entries(state.answers[questionId] || {}).map(([participantId, answer]) => {
    const participant = state.participants[participantId] || { name: "Unbekannt" };
    const diff = Math.abs(answer.value - question.answer);
    return {
      participantId,
      name: participant.name,
      value: answer.value,
      valueLabel: fmt(answer.value),
      diff,
      diffLabel: fmt(diff),
      at: answer.at
    };
  });

  rows.sort((a, b) => a.diff - b.diff || a.at - b.at || a.name.localeCompare(b.name));

  let lastDiff = null;
  let rank = 0;

  rows.forEach((row, index) => {
    if (lastDiff === null || row.diff !== lastDiff) rank = index + 1;
    row.rank = rank;
    lastDiff = row.diff;
  });

  return rows;
}

function awardCurrentQuestion() {
  const question = currentQuestion();
  if (!question || state.awarded[question.id]) return;

  const results = getResults(question.id);
  const points = { 1: 3, 2: 2, 3: 1 };

  results.forEach(result => {
    if (result.rank <= 3) {
      state.scores[result.participantId] = (state.scores[result.participantId] || 0) + points[result.rank];
    }
  });

  state.awarded[question.id] = true;
  state.history.push({
    questionId: question.id,
    text: question.text,
    answer: question.answer,
    unit: question.unit,
    winners: results.filter(result => result.rank === 1).map(result => result.name)
  });
}

function leaderboard() {
  const rows = Object.values(state.participants).map(participant => ({
    participantId: participant.id,
    name: participant.name,
    score: state.scores[participant.id] || 0,
    online: participant.online
  }));

  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  let lastScore = null;
  let rank = 0;

  rows.forEach((row, index) => {
    if (lastScore === null || row.score !== lastScore) rank = index + 1;
    row.rank = rank;
    lastScore = row.score;
  });

  return rows;
}

function adminPayload() {
  const question = currentQuestion();
  return {
    participants: Object.values(state.participants).sort((a, b) => a.name.localeCompare(b.name)),
    questions: state.questions,
    currentQuestion: question,
    status: state.status,
    answerCount: question ? Object.keys(state.answers[question.id] || {}).length : 0,
    results: question ? getResults(question.id) : [],
    leaderboard: leaderboard(),
    history: state.history
  };
}

function participantPayload(participantId) {
  const question = currentQuestion();
  const answer = question ? (state.answers[question.id] || {})[participantId] : null;
  const results = question && state.status === "revealed" ? getResults(question.id) : [];
  const ownResult = results.find(result => result.participantId === participantId) || null;

  return {
    participant: state.participants[participantId] || null,
    currentQuestion: question ? { id: question.id, text: question.text, unit: question.unit } : null,
    correctAnswer: question && state.status === "revealed" ? question.answer : null,
    status: state.status,
    answer: answer ? { value: answer.value, valueLabel: fmt(answer.value) } : null,
    results: results.slice(0, 8),
    ownResult,
    leaderboard: leaderboard().slice(0, 10),
    history: state.history
  };
}

function pushAll() {
  io.to("admins").emit("adminState", adminPayload());

  Object.keys(state.participants).forEach(participantId => {
    io.to("participant:" + participantId).emit("participantState", participantPayload(participantId));
  });
}

function requireAdmin(socket) {
  if (!socket.data.isAdmin) {
    socket.emit("adminError", "Bitte zuerst als Moderation anmelden.");
    return false;
  }
  return true;
}

function baseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "") + "/";
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  return proto + "://" + req.get("host") + "/";
}

function localUrls() {
  const urls = ["http://localhost:" + PORT + "/"];
  const nets = os.networkInterfaces();

  Object.keys(nets).forEach(name => {
    (nets[name] || []).forEach(net => {
      if (net.family === "IPv4" && !net.internal) {
        urls.push("http://" + net.address + ":" + PORT + "/");
      }
    });
  });

  return urls;
}

app.get("/healthz", (req, res) => {
  res.type("text/plain").send("ok");
});

app.get("/qr.svg", async (req, res) => {
  try {
    const svg = await QRCode.toString(baseUrl(req), {
      type: "svg",
      margin: 1,
      width: 360,
      color: { dark: "#1F1A17", light: "#FFF8EA" }
    });
    res.type("image/svg+xml").send(svg);
  } catch (error) {
    res.status(500).send("QR-Code konnte nicht erzeugt werden.");
  }
});

app.get("/", (req, res) => res.send(participantHtml()));
app.get("/admin", (req, res) => res.send(adminHtml()));

io.on("connection", socket => {
  socket.on("participantJoin", data => {
    const participantId = cleanText(data && data.id, 40) || makeId();
    const name = cleanText(data && data.name, 40) || "Gast";

    state.participants[participantId] = {
      id: participantId,
      name,
      online: true,
      joinedAt: state.participants[participantId]?.joinedAt || now(),
      lastSeen: now()
    };

    socket.data.participantId = participantId;
    socket.join("participant:" + participantId);
    socket.emit("participantAccepted", { id: participantId, name });
    socket.emit("participantState", participantPayload(participantId));
    pushAll();
  });

  socket.on("submitGuess", data => {
    const participantId = socket.data.participantId;
    const question = currentQuestion();

    if (!participantId || !question || state.status !== "open") return;
    if (String(data && data.questionId) !== question.id) return;

    const value = parseNumber(data && data.value);

    if (value === null) {
      socket.emit("participantError", "Bitte gib eine gültige Zahl ein.");
      return;
    }

    state.answers[question.id] ||= {};
    state.answers[question.id][participantId] = { value, at: now() };

    socket.emit("participantState", participantPayload(participantId));
    pushAll();
  });

  socket.on("adminAuth", data => {
    const pin = String(data && data.pin || "").trim();

    if (pin === ADMIN_PIN) {
      socket.data.isAdmin = true;
      socket.join("admins");
      socket.emit("adminAuthed");
      socket.emit("adminState", adminPayload());
      console.log("Admin login successful");
    } else {
      socket.emit("adminError", "Falsche PIN.");
      console.log("Admin login failed");
    }
  });

  socket.on("adminAddQuestion", data => {
    if (!requireAdmin(socket)) return;

    const text = cleanText(data && data.text, 180);
    const answer = parseNumber(data && data.answer);
    const unit = cleanText(data && data.unit, 30);

    if (!text || answer === null) {
      socket.emit("adminError", "Bitte Frage und richtige Zahl eintragen.");
      return;
    }

    const question = { id: makeId(), text, answer, unit };
    state.questions.push(question);
    state.answers[question.id] = {};
    pushAll();
  });

  socket.on("adminRemoveQuestion", data => {
    if (!requireAdmin(socket)) return;

    const questionId = String(data && data.id);
    state.questions = state.questions.filter(question => question.id !== questionId);
    delete state.answers[questionId];
    delete state.awarded[questionId];

    if (state.currentQuestionId === questionId) {
      state.currentQuestionId = null;
      state.status = "lobby";
    }

    pushAll();
  });

  socket.on("adminStartQuestion", data => {
    if (!requireAdmin(socket)) return;

    const questionId = String(data && data.id);
    if (!state.questions.find(question => question.id === questionId)) return;

    state.currentQuestionId = questionId;
    state.status = "open";
    state.answers[questionId] = {};
    delete state.awarded[questionId];
    pushAll();
  });

  socket.on("adminCloseQuestion", () => {
    if (!requireAdmin(socket)) return;
    if (!currentQuestion()) return;

    state.status = "closed";
    pushAll();
  });

  socket.on("adminRevealQuestion", () => {
    if (!requireAdmin(socket)) return;
    if (!currentQuestion()) return;

    awardCurrentQuestion();
    state.status = "revealed";
    pushAll();
  });

  socket.on("adminBackToLobby", () => {
    if (!requireAdmin(socket)) return;

    state.currentQuestionId = null;
    state.status = "lobby";
    pushAll();
  });

  socket.on("adminResetScores", () => {
    if (!requireAdmin(socket)) return;

    state.scores = {};
    state.awarded = {};
    state.history = [];
    pushAll();
  });

  socket.on("adminResetAll", () => {
    if (!requireAdmin(socket)) return;

    state.participants = {};
    state.questions = [];
    state.answers = {};
    state.scores = {};
    state.currentQuestionId = null;
    state.status = "lobby";
    state.awarded = {};
    state.history = [];
    pushAll();
  });

  socket.on("disconnect", () => {
    const participantId = socket.data.participantId;

    if (participantId && state.participants[participantId]) {
      state.participants[participantId].online = false;
      state.participants[participantId].lastSeen = now();
      pushAll();
    }
  });
});

server.listen(PORT, () => {
  console.log("\nSchätzquiz läuft.");
  console.log("Moderations-PIN:", ADMIN_PIN);
  console.log("\nAdressen:");
  localUrls().forEach(url => console.log("  Teilnehmende: " + url + " | Admin: " + url + "admin"));
  console.log("");
});

function commonHead(title) {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root{
  --bg:#FFF8EA;
  --paper:#FFFFFF;
  --ink:#1F1A17;
  --muted:#71665B;
  --line:#E9D9BD;
  --accent:#B7410E;
  --accent2:#0F6B5F;
  --warn:#B88716;
  --good:#167048;
  --bad:#A33A2A;
  --shadow:0 14px 40px rgba(60,39,18,.12);
}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(circle at top left,#FFE9B5,transparent 34%),var(--bg);color:var(--ink);font-family:Arial,Helvetica,sans-serif;line-height:1.45}
.wrap{max-width:1120px;margin:0 auto;padding:24px}
.narrow{max-width:760px}
.hero{padding:32px 0 18px}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;color:var(--accent)}
.dot{width:14px;height:14px;border-radius:50%;background:var(--accent2);box-shadow:18px 0 0 var(--accent),36px 0 0 var(--warn)}
h1{font-family:Georgia,serif;font-size:clamp(34px,6vw,72px);line-height:.94;margin:18px 0 10px;letter-spacing:-.05em}
h2{font-family:Georgia,serif;font-size:30px;margin:0 0 16px;letter-spacing:-.03em}
h3{margin:0 0 10px;font-size:19px}
.sub{font-size:19px;color:var(--muted);max-width:720px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.card{background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:20px;box-shadow:var(--shadow)}
.panel{background:#231B16;color:#FFF8EA;border-radius:22px;padding:24px}
.panel .muted{color:#E8D6BA}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.between{display:flex;justify-content:space-between;gap:12px;align-items:center}
.muted{color:var(--muted)}
.big{font-size:24px}
.huge{font-size:44px;font-weight:900}
.ok{color:var(--good)}
.bad{color:var(--bad)}
input,button,textarea{font:inherit}
input,textarea{width:100%;border:1px solid var(--line);background:#FFFDF8;border-radius:12px;padding:13px 14px;color:var(--ink)}
textarea{min-height:86px;resize:vertical}
label{display:block;font-weight:700;margin:12px 0 6px}
.btn{border:0;border-radius:999px;background:var(--ink);color:#fff;padding:12px 18px;font-weight:800;cursor:pointer;transition:.15s transform,.15s opacity}
.btn:hover{transform:translateY(-1px)}
.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.btn.alt{background:var(--accent)}
.btn.green{background:var(--accent2)}
.btn.ghost{background:#F4E6CC;color:var(--ink)}
.btn.danger{background:var(--bad)}
.pill{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);background:#FFFDF8;border-radius:999px;padding:7px 11px;font-size:14px;font-weight:800}
.status{background:#241A14;color:#FFF8EA;border-color:#241A14}
.list{display:grid;gap:10px}
.item{border:1px solid var(--line);background:#FFFDF8;border-radius:14px;padding:14px}
.table{width:100%;border-collapse:collapse}
.table th,.table td{text-align:left;border-bottom:1px solid var(--line);padding:10px 8px}
.table th{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.rank{font-weight:900;font-size:20px}
.qr{width:220px;max-width:100%;background:#FFF8EA;border-radius:16px;padding:10px}
.screen{min-height:56vh;display:grid;place-items:center;text-align:center}
.answerBox{font-size:30px;text-align:center;font-weight:900}
.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:#1F1A17;color:white;padding:12px 16px;border-radius:999px;box-shadow:var(--shadow);display:none;z-index:5}
.toast.show{display:block}
.hide{display:none!important}
@media(max-width:820px){.grid{grid-template-columns:1fr}.wrap{padding:16px}h1{font-size:42px}.between{align-items:flex-start;flex-direction:column}.huge{font-size:34px}}
</style>
</head>`;
}

function participantHtml() {
  return `${commonHead("Schätzquiz")}
<body>
<div class="wrap narrow">
  <section class="hero">
    <div class="brand"><span class="dot"></span><span>Schätzquiz</span></div>
    <h1>Wer liegt am nächsten?</h1>
    <p class="sub">Gib deinen Namen ein, schätze die Zahl und sammle Punkte.</p>
  </section>

  <section id="join" class="card">
    <h2>Mitspielen</h2>
    <label for="name">Dein Name oder Teamname</label>
    <input id="name" maxlength="40" autocomplete="name" placeholder="z. B. Anna oder Team Einkauf">
    <div style="height:14px"></div>
    <button class="btn alt" id="joinBtn">Beitreten</button>
  </section>

  <section id="game" class="hide"></section>
</div>
<div id="toast" class="toast"></div>
<script src="/socket.io/socket.io.js"></script>
<script>
var socket = io();
var pidKey = "schaetzquizTeilnehmerId";
var nameKey = "schaetzquizName";
var pid = localStorage.getItem(pidKey) || Math.random().toString(36).slice(2,10);
var lastState = null;

function qs(selector) {
  return document.querySelector(selector);
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"]/g, function(character) {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    return "&quot;";
  });
}

function formatNumber(value) {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(value);
}

function toast(message) {
  var element = qs("#toast");
  element.textContent = message;
  element.classList.add("show");
  setTimeout(function() { element.classList.remove("show"); }, 2400);
}

function join() {
  var name = qs("#name").value.trim();
  if (!name) {
    toast("Bitte Namen eingeben.");
    return;
  }

  localStorage.setItem(pidKey, pid);
  localStorage.setItem(nameKey, name);
  socket.emit("participantJoin", { id: pid, name: name });
}

function submitGuess() {
  var input = qs("#guess");
  if (!lastState || !lastState.currentQuestion || !input) return;
  socket.emit("submitGuess", { questionId: lastState.currentQuestion.id, value: input.value });
}

function resultsHtml(rows, unit) {
  if (!rows.length) return '<p class="muted">Noch keine Ergebnisse.</p>';

  return '<h3>Beste Schätzungen</h3><table class="table"><thead><tr><th>Platz</th><th>Name</th><th>Schätzung</th><th>Abstand</th></tr></thead><tbody>' +
    rows.map(function(row) {
      return '<tr><td class="rank">#' + row.rank + '</td><td>' + escapeHtml(row.name) + '</td><td>' + escapeHtml(row.valueLabel) + ' ' + escapeHtml(unit) + '</td><td>' + escapeHtml(row.diffLabel) + ' ' + escapeHtml(unit) + '</td></tr>';
    }).join('') +
    '</tbody></table>';
}

function leaderboardHtml(rows) {
  if (!rows.length) return '';

  return '<div style="height:18px"></div><h3>Gesamtrangliste</h3><table class="table"><tbody>' +
    rows.slice(0, 5).map(function(row) {
      return '<tr><td class="rank">#' + row.rank + '</td><td>' + escapeHtml(row.name) + '</td><td><b>' + row.score + '</b> Punkte</td></tr>';
    }).join('') +
    '</tbody></table>';
}

function render(state) {
  var element = qs("#game");
  if (!state.participant) return;

  if (!state.currentQuestion) {
    element.innerHTML = '<div class="card screen"><div><div class="pill status">Wartebereich</div><h2>Hallo ' + escapeHtml(state.participant.name) + '</h2><p class="sub">Die Moderation startet gleich die nächste Schätzfrage.</p>' + leaderboardHtml(state.leaderboard) + '</div></div>';
    return;
  }

  if (state.status === "open") {
    element.innerHTML = '<div class="panel"><div class="pill">Frage läuft</div><h2 style="font-size:38px;margin-top:18px">' + escapeHtml(state.currentQuestion.text) + '</h2><p class="muted">Gib deine Schätzung als Zahl ein. Du kannst deine Antwort ändern, solange die Frage offen ist.</p><input id="guess" class="answerBox" inputmode="decimal" placeholder="Deine Schätzung" value="' + escapeHtml(state.answer ? state.answer.valueLabel : '') + '"><div style="height:14px"></div><button class="btn alt" id="submitGuessBtn">Schätzung absenden</button>' + (state.answer ? '<p class="ok"><b>Gespeichert:</b> ' + escapeHtml(state.answer.valueLabel) + ' ' + escapeHtml(state.currentQuestion.unit) + '</p>' : '') + '</div>';
    qs("#submitGuessBtn").onclick = submitGuess;
    setTimeout(function() {
      var guess = qs("#guess");
      if (guess) guess.focus();
    }, 30);
    return;
  }

  if (state.status === "closed") {
    element.innerHTML = '<div class="card screen"><div><div class="pill status">Antworten geschlossen</div><h2>Danke, deine Schätzung ist drin.</h2><p class="sub">Gleich wird aufgelöst.</p>' + (state.answer ? '<p class="big"><b>Deine Schätzung:</b> ' + escapeHtml(state.answer.valueLabel) + ' ' + escapeHtml(state.currentQuestion.unit) + '</p>' : '<p class="bad">Du hast keine Schätzung abgegeben.</p>') + '</div></div>';
    return;
  }

  if (state.status === "revealed") {
    var unit = state.currentQuestion.unit || "";
    var own = state.ownResult ? '<p class="big">Dein Platz: <b>#' + state.ownResult.rank + '</b> · Abstand: <b>' + escapeHtml(state.ownResult.diffLabel) + ' ' + escapeHtml(unit) + '</b></p>' : '<p class="bad">Keine gültige Antwort abgegeben.</p>';
    element.innerHTML = '<div class="card"><div class="pill status">Auflösung</div><h2>' + escapeHtml(state.currentQuestion.text) + '</h2><div class="huge">' + escapeHtml(formatNumber(state.correctAnswer)) + ' ' + escapeHtml(unit) + '</div>' + own + resultsHtml(state.results, unit) + leaderboardHtml(state.leaderboard) + '</div>';
  }
}

if (localStorage.getItem(nameKey)) {
  qs("#name").value = localStorage.getItem(nameKey);
}

qs("#joinBtn").onclick = join;
qs("#name").addEventListener("keydown", function(event) {
  if (event.key === "Enter") join();
});

socket.on("participantAccepted", function(data) {
  pid = data.id;
  localStorage.setItem(pidKey, pid);
  qs("#join").classList.add("hide");
  qs("#game").classList.remove("hide");
});

socket.on("participantError", toast);
socket.on("participantState", function(state) {
  lastState = state;
  render(state);
});
</script>
</body></html>`;
}

function adminHtml() {
  return `${commonHead("Schätzquiz Moderation")}
<body>
<div class="wrap">
  <section class="hero between">
    <div>
      <div class="brand"><span class="dot"></span><span>Moderation</span></div>
      <h1>Schätzquiz steuern</h1>
      <p class="sub">Fragen starten, Antworten schließen, Gewinner anzeigen und am Ende die Gesamtrangliste präsentieren.</p>
    </div>
    <div class="card" style="text-align:center">
      <img class="qr" src="/qr.svg" alt="QR-Code zum Mitspielen">
      <div class="muted">QR-Code für Teilnehmende</div>
    </div>
  </section>

  <section id="login" class="card narrow">
    <h2>Moderations-PIN</h2>
    <input id="pin" type="password" placeholder="PIN eingeben">
    <div style="height:14px"></div>
    <button class="btn alt" id="loginBtn">Einloggen</button>
    <p class="muted">Standard-PIN ist 1234, falls du in Render keine eigene PIN gesetzt hast.</p>
  </section>

  <main id="admin" class="hide">
    <div class="grid">
      <section class="card">
        <h2>Neue Schätzfrage</h2>
        <label for="qText">Frage</label>
        <textarea id="qText" placeholder="z. B. Wie viele Kaffee wurden letztes Jahr ungefähr getrunken?"></textarea>
        <div class="grid">
          <div><label for="qAnswer">Richtige Zahl</label><input id="qAnswer" inputmode="decimal" placeholder="z. B. 12500"></div>
          <div><label for="qUnit">Einheit optional</label><input id="qUnit" placeholder="z. B. Tassen, €, Stück"></div>
        </div>
        <div style="height:14px"></div>
        <button class="btn green" id="addBtn">Frage hinzufügen</button>
      </section>

      <section class="card">
        <div class="between"><h2>Live-Status</h2><span id="statusPill" class="pill status">Lobby</span></div>
        <div id="liveBox"></div>
        <div class="row" style="margin-top:14px">
          <button class="btn ghost" id="closeBtn">Antworten schließen</button>
          <button class="btn alt" id="revealBtn">Auflösen & Punkte vergeben</button>
          <button class="btn ghost" id="lobbyBtn">Zur Lobby</button>
        </div>
      </section>
    </div>

    <div style="height:16px"></div>
    <div class="grid">
      <section class="card"><h2>Fragen</h2><div id="questions" class="list"></div></section>
      <section class="card"><h2>Teilnehmende</h2><div id="participants" class="list"></div></section>
    </div>

    <div style="height:16px"></div>
    <div class="grid">
      <section class="card"><h2>Ergebnis aktuelle Frage</h2><div id="results"></div></section>
      <section class="card">
        <h2>Gesamtrangliste</h2>
        <div id="leaderboard"></div>
        <div class="row" style="margin-top:14px">
          <button class="btn ghost" id="resetScoresBtn">Punkte zurücksetzen</button>
          <button class="btn danger" id="resetAllBtn">Alles löschen</button>
        </div>
      </section>
    </div>
  </main>
</div>
<div id="toast" class="toast"></div>
<script src="/socket.io/socket.io.js"></script>
<script>
var socket = io();
var state = null;

function qs(selector) {
  return document.querySelector(selector);
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"]/g, function(character) {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    return "&quot;";
  });
}

function formatNumber(value) {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(value);
}

function toast(message) {
  var element = qs("#toast");
  element.textContent = message;
  element.classList.add("show");
  setTimeout(function() { element.classList.remove("show"); }, 2600);
}

function statusText(status) {
  if (status === "open") return "Offen";
  if (status === "closed") return "Geschlossen";
  if (status === "revealed") return "Aufgelöst";
  return "Lobby";
}

function startQuestion(questionId) {
  socket.emit("adminStartQuestion", { id: questionId });
}

function removeQuestion(questionId) {
  if (confirm("Frage löschen?")) {
    socket.emit("adminRemoveQuestion", { id: questionId });
  }
}

function renderLive() {
  var question = state.currentQuestion;
  var box = qs("#liveBox");

  if (!question) {
    box.innerHTML = '<p class="muted">Noch keine Frage aktiv.</p><p><b>' + state.participants.length + '</b> Teilnehmende verbunden.</p>';
    return;
  }

  box.innerHTML = '<h3>' + escapeHtml(question.text) + '</h3><p class="big"><b>' + state.answerCount + '</b> Antworten</p><p class="muted">Lösung: ' + escapeHtml(formatNumber(question.answer)) + ' ' + escapeHtml(question.unit || '') + '</p>';
}

function renderQuestions() {
  var box = qs("#questions");
  box.innerHTML = "";

  if (!state.questions.length) {
    box.innerHTML = '<p class="muted">Noch keine Fragen angelegt.</p>';
    return;
  }

  state.questions.forEach(function(question, index) {
    var item = document.createElement("div");
    item.className = "item";

    var line = document.createElement("div");
    line.className = "between";

    var info = document.createElement("div");
    var title = document.createElement("b");
    title.textContent = (index + 1) + ". " + question.text;

    var meta = document.createElement("span");
    meta.className = "muted";
    meta.textContent = "Lösung: " + formatNumber(question.answer) + " " + (question.unit || "");

    info.appendChild(title);
    info.appendChild(document.createElement("br"));
    info.appendChild(meta);

    var actions = document.createElement("div");
    actions.className = "row";

    var startButton = document.createElement("button");
    startButton.className = "btn alt";
    startButton.textContent = "Start";
    startButton.onclick = function() { startQuestion(question.id); };

    var removeButton = document.createElement("button");
    removeButton.className = "btn ghost";
    removeButton.textContent = "Löschen";
    removeButton.onclick = function() { removeQuestion(question.id); };

    actions.appendChild(startButton);
    actions.appendChild(removeButton);
    line.appendChild(info);
    line.appendChild(actions);
    item.appendChild(line);
    box.appendChild(item);
  });
}

function renderParticipants() {
  var box = qs("#participants");

  if (!state.participants.length) {
    box.innerHTML = '<p class="muted">Noch niemand beigetreten.</p>';
    return;
  }

  box.innerHTML = state.participants.map(function(participant) {
    return '<div class="item between"><span><b>' + escapeHtml(participant.name) + '</b></span><span class="pill">' + (participant.online ? 'online' : 'offline') + '</span></div>';
  }).join('');
}

function renderResults() {
  var box = qs("#results");
  var question = state.currentQuestion;

  if (!question) {
    box.innerHTML = '<p class="muted">Keine aktive Frage.</p>';
    return;
  }

  var unit = question.unit || "";

  if (!state.results.length) {
    box.innerHTML = '<p class="muted">Noch keine Antworten.</p>';
    return;
  }

  box.innerHTML = '<table class="table"><thead><tr><th>Platz</th><th>Name</th><th>Schätzung</th><th>Abstand</th></tr></thead><tbody>' +
    state.results.map(function(result) {
      return '<tr><td class="rank">#' + result.rank + '</td><td>' + escapeHtml(result.name) + '</td><td>' + escapeHtml(result.valueLabel) + ' ' + escapeHtml(unit) + '</td><td>' + escapeHtml(result.diffLabel) + ' ' + escapeHtml(unit) + '</td></tr>';
    }).join('') +
    '</tbody></table>';
}

function renderLeaderboard() {
  var box = qs("#leaderboard");

  if (!state.leaderboard.length) {
    box.innerHTML = '<p class="muted">Noch keine Punkte.</p>';
    return;
  }

  box.innerHTML = '<table class="table"><thead><tr><th>Platz</th><th>Name</th><th>Punkte</th></tr></thead><tbody>' +
    state.leaderboard.map(function(row) {
      return '<tr><td class="rank">#' + row.rank + '</td><td>' + escapeHtml(row.name) + '</td><td><b>' + row.score + '</b></td></tr>';
    }).join('') +
    '</tbody></table><p class="muted">Punkte pro Frage: Platz 1 = 3, Platz 2 = 2, Platz 3 = 1. Bei Gleichstand bekommen beide denselben Platz.</p>';
}

function render() {
  if (!state) return;
  qs("#statusPill").textContent = statusText(state.status);
  renderLive();
  renderQuestions();
  renderParticipants();
  renderResults();
  renderLeaderboard();
}

qs("#loginBtn").onclick = function() {
  socket.emit("adminAuth", { pin: qs("#pin").value });
};

qs("#pin").addEventListener("keydown", function(event) {
  if (event.key === "Enter") {
    socket.emit("adminAuth", { pin: qs("#pin").value });
  }
});

qs("#addBtn").onclick = function() {
  socket.emit("adminAddQuestion", {
    text: qs("#qText").value,
    answer: qs("#qAnswer").value,
    unit: qs("#qUnit").value
  });
};

qs("#closeBtn").onclick = function() {
  socket.emit("adminCloseQuestion");
};

qs("#revealBtn").onclick = function() {
  socket.emit("adminRevealQuestion");
};

qs("#lobbyBtn").onclick = function() {
  socket.emit("adminBackToLobby");
};

qs("#resetScoresBtn").onclick = function() {
  if (confirm("Punkte und Historie zurücksetzen?")) {
    socket.emit("adminResetScores");
  }
};

qs("#resetAllBtn").onclick = function() {
  if (confirm("Alles löschen: Fragen, Teilnehmende und Punkte?")) {
    socket.emit("adminResetAll");
  }
};

socket.on("connect", function() {
  console.log("Admin verbunden");
});

socket.on("adminAuthed", function() {
  qs("#login").classList.add("hide");
  qs("#admin").classList.remove("hide");
});

socket.on("adminError", toast);

socket.on("adminState", function(nextState) {
  state = nextState;
  render();
});
</script>
</body></html>`;
}
