// Self-paced Schätzquiz Web-App für Mitarbeiterversammlungen
// -----------------------------------------------------------
// Online-Start über Render:
//   Build Command: npm install
//   Start Command: npm start
//   Environment Variable optional: ADMIN_PIN=2468
//
// Benötigte package.json:
// {
//   "scripts": { "start": "node server.js" },
//   "dependencies": { "express": "^4.18.3", "socket.io": "^4.7.5", "qrcode": "^1.5.3" }
// }

const os = require("os");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PIN = String(process.env.ADMIN_PIN || "1234").trim();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const state = {
  quizStatus: "draft", // draft | open | closed | released
  teams: {},
  questions: [],
  answers: {}
};

function now() {
  return Date.now();
}

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function cleanText(value, max = 160) {
  return String(value || "").replace(/[<>]/g, "").trim().slice(0, max);
}

function teamKey(value) {
  return cleanText(value, 80).toLowerCase().replace(/\s+/g, " ");
}

function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const input = String(value || "").trim().replace(/\s/g, "");
  if (!input) return null;

  let normalized = input;

  if (input.includes(",")) {
    normalized = input.replace(/\./g, "").replace(",", ".");
  } else {
    const dotCount = (input.match(/\./g) || []).length;
    if (dotCount > 1) {
      normalized = input.replace(/\./g, "");
    } else if (/^[-+]?\d{1,3}\.\d{3}$/.test(input)) {
      normalized = input.replace(/\./g, "");
    }
  }

  if (!/^[-+]?\d+(\.\d+)?$/.test(normalized)) return null;

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function fmt(number) {
  if (!Number.isFinite(number)) return "";
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(number);
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
      if (net.family === "IPv4" && !net.internal) urls.push("http://" + net.address + ":" + PORT + "/");
    });
  });

  return urls;
}

function getTeamAnswers(key) {
  const result = {};
  state.questions.forEach(question => {
    const answer = (state.answers[question.id] || {})[key];
    if (answer) result[question.id] = answer;
  });
  return result;
}

function countTeamAnswers(key) {
  return Object.keys(getTeamAnswers(key)).length;
}

function totalPossibleAnswers() {
  return Object.keys(state.teams).length * state.questions.length;
}

function totalGivenAnswers() {
  let count = 0;
  state.questions.forEach(question => {
    count += Object.keys(state.answers[question.id] || {}).length;
  });
  return count;
}

function questionStats() {
  return state.questions.map((question, index) => ({
    id: question.id,
    index,
    text: question.text,
    unit: question.unit,
    answerCount: Object.keys(state.answers[question.id] || {}).length
  }));
}

function teamProgress() {
  return Object.values(state.teams)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(team => {
      const answered = countTeamAnswers(team.key);
      return {
        key: team.key,
        label: team.label,
        online: team.online,
        answered,
        total: state.questions.length,
        complete: state.questions.length > 0 && answered >= state.questions.length
      };
    });
}

function getQuestionResults(questionId) {
  const question = state.questions.find(item => item.id === questionId);
  if (!question) return [];

  const rows = Object.entries(state.answers[questionId] || {}).map(([key, answer]) => {
    const team = state.teams[key] || { label: "Unbekannt" };
    const diff = Math.abs(answer.value - question.answer);
    return {
      teamKey: key,
      teamLabel: team.label,
      value: answer.value,
      valueLabel: fmt(answer.value),
      diff,
      diffLabel: fmt(diff),
      at: answer.at
    };
  });

  rows.sort((a, b) => a.diff - b.diff || a.at - b.at || a.teamLabel.localeCompare(b.teamLabel));

  let lastDiff = null;
  let rank = 0;
  rows.forEach((row, index) => {
    if (lastDiff === null || row.diff !== lastDiff) rank = index + 1;
    row.rank = rank;
    lastDiff = row.diff;
  });

  return rows;
}

function allQuestionResults() {
  return state.questions.map(question => {
    const results = getQuestionResults(question.id);
    return {
      id: question.id,
      text: question.text,
      answer: question.answer,
      answerLabel: fmt(question.answer),
      unit: question.unit,
      explanation: question.explanation,
      answerCount: results.length,
      winners: results.filter(row => row.rank === 1).map(row => row.teamLabel),
      results
    };
  });
}

function scoreMap() {
  const map = {};

  Object.values(state.teams).forEach(team => {
    map[team.key] = {
      teamKey: team.key,
      teamLabel: team.label,
      score: 0,
      totalDiff: 0,
      answered: 0,
      avgDiff: Infinity
    };
  });

  state.questions.forEach(question => {
    const rows = getQuestionResults(question.id);
    rows.forEach(row => {
      if (!map[row.teamKey]) {
        map[row.teamKey] = {
          teamKey: row.teamKey,
          teamLabel: row.teamLabel,
          score: 0,
          totalDiff: 0,
          answered: 0,
          avgDiff: Infinity
        };
      }

      if (row.rank === 1) map[row.teamKey].score += 3;
      if (row.rank === 2) map[row.teamKey].score += 2;
      if (row.rank === 3) map[row.teamKey].score += 1;

      map[row.teamKey].totalDiff += row.diff;
      map[row.teamKey].answered += 1;
    });
  });

  Object.values(map).forEach(row => {
    row.avgDiff = row.answered ? row.totalDiff / row.answered : Infinity;
    row.avgDiffLabel = Number.isFinite(row.avgDiff) ? fmt(row.avgDiff) : "-";
  });

  return map;
}

function leaderboard() {
  const rows = Object.values(scoreMap());

  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.avgDiff !== b.avgDiff) return a.avgDiff - b.avgDiff;
    return a.teamLabel.localeCompare(b.teamLabel);
  });

  let lastScore = null;
  let lastAvg = null;
  let rank = 0;

  rows.forEach((row, index) => {
    if (lastScore === null || row.score !== lastScore || row.avgDiff !== lastAvg) rank = index + 1;
    row.rank = rank;
    lastScore = row.score;
    lastAvg = row.avgDiff;
  });

  return rows;
}

function teamQuestionDetails(key) {
  const questions = allQuestionResults();
  return questions.map(question => {
    const own = question.results.find(row => row.teamKey === key) || null;
    return {
      id: question.id,
      text: question.text,
      answer: question.answer,
      answerLabel: question.answerLabel,
      unit: question.unit,
      explanation: question.explanation,
      ownValue: own ? own.value : null,
      ownValueLabel: own ? own.valueLabel : "-",
      ownDiff: own ? own.diff : null,
      ownDiffLabel: own ? own.diffLabel : "-",
      ownRank: own ? own.rank : null,
      winners: question.winners
    };
  });
}

function adminPayload() {
  return {
    quizStatus: state.quizStatus,
    adminPin: ADMIN_PIN,
    teams: Object.values(state.teams).sort((a, b) => a.label.localeCompare(b.label)),
    questions: state.questions,
    questionStats: questionStats(),
    teamProgress: teamProgress(),
    totalAnswers: totalGivenAnswers(),
    totalPossibleAnswers: totalPossibleAnswers(),
    leaderboard: leaderboard(),
    questionResults: allQuestionResults()
  };
}

function participantPayload(key) {
  const team = state.teams[key] || null;
  const answers = getTeamAnswers(key);
  const nextQuestion = state.questions.find(question => !answers[question.id]) || null;
  const board = leaderboard();
  const ownRank = board.find(row => row.teamKey === key) || null;

  return {
    quizStatus: state.quizStatus,
    team,
    questionCount: state.questions.length,
    answeredCount: Object.keys(answers).length,
    nextQuestion: state.quizStatus === "open" && nextQuestion ? {
      id: nextQuestion.id,
      index: state.questions.findIndex(question => question.id === nextQuestion.id),
      text: nextQuestion.text,
      unit: nextQuestion.unit
    } : null,
    ownRank: state.quizStatus === "released" ? ownRank : null,
    leaderboard: state.quizStatus === "released" ? board.slice(0, 5) : [],
    questionDetails: state.quizStatus === "released" ? teamQuestionDetails(key) : []
  };
}

function pushAdmin() {
  io.to("admins").emit("adminState", adminPayload());
}

function pushTeam(key) {
  io.to("team:" + key).emit("participantState", participantPayload(key));
}

function pushAll() {
  pushAdmin();
  Object.keys(state.teams).forEach(pushTeam);
}

function requireAdmin(socket) {
  if (!socket.data.isAdmin) {
    socket.emit("adminError", "Bitte zuerst als Moderation anmelden.");
    return false;
  }
  return true;
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
    const label = cleanText(data && data.teamLabel, 80);
    const key = teamKey(label);

    if (!label || !key) {
      socket.emit("participantError", "Bitte gebt euren Teamnamen oder euer Symbol ein.");
      return;
    }

    state.teams[key] = {
      key,
      label,
      online: true,
      joinedAt: state.teams[key]?.joinedAt || now(),
      lastSeen: now()
    };

    socket.data.teamKey = key;
    socket.join("team:" + key);
    socket.emit("participantAccepted", { teamKey: key, teamLabel: label });
    socket.emit("participantState", participantPayload(key));
    pushAll();
  });

  socket.on("submitAnswer", data => {
    const key = socket.data.teamKey;
    const questionId = String(data && data.questionId || "");
    const question = state.questions.find(item => item.id === questionId);

    if (!key || !state.teams[key]) {
      socket.emit("participantError", "Bitte tretet zuerst mit eurem Teamnamen oder Symbol bei.");
      return;
    }

    if (state.quizStatus !== "open") {
      socket.emit("participantError", "Das Quiz ist aktuell nicht für Antworten geöffnet.");
      return;
    }

    if (!question) {
      socket.emit("participantError", "Diese Frage wurde nicht gefunden.");
      return;
    }

    state.answers[questionId] ||= {};

    if (state.answers[questionId][key]) {
      socket.emit("participantError", "Diese Frage wurde von euch bereits beantwortet.");
      socket.emit("participantState", participantPayload(key));
      return;
    }

    const value = parseNumber(data && data.value);

    if (value === null) {
      socket.emit("participantError", "Bitte gebt eine gültige Zahl ein, z. B. 1500 oder 12,5.");
      return;
    }

    state.answers[questionId][key] = { value, at: now() };
    socket.emit("participantState", participantPayload(key));
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

    if (state.quizStatus !== "draft") {
      socket.emit("adminError", "Fragen können nur geändert werden, solange das Quiz noch nicht geöffnet wurde.");
      return;
    }

    const text = cleanText(data && data.text, 220);
    const answer = parseNumber(data && data.answer);
    const unit = cleanText(data && data.unit, 40);
    const explanation = cleanText(data && data.explanation, 360);

    if (!text || answer === null) {
      socket.emit("adminError", "Bitte Fragetext und richtige Zahl eintragen.");
      return;
    }

    const question = { id: makeId(), text, answer, unit, explanation };
    state.questions.push(question);
    state.answers[question.id] = {};
    pushAll();
  });

  socket.on("adminRemoveQuestion", data => {
    if (!requireAdmin(socket)) return;

    if (state.quizStatus !== "draft") {
      socket.emit("adminError", "Fragen können nur gelöscht werden, solange das Quiz noch nicht geöffnet wurde.");
      return;
    }

    const questionId = String(data && data.id || "");
    state.questions = state.questions.filter(question => question.id !== questionId);
    delete state.answers[questionId];
    pushAll();
  });

  socket.on("adminOpenQuiz", () => {
    if (!requireAdmin(socket)) return;

    if (!state.questions.length) {
      socket.emit("adminError", "Bitte zuerst mindestens eine Frage anlegen.");
      return;
    }

    state.quizStatus = "open";
    pushAll();
  });

  socket.on("adminCloseQuiz", () => {
    if (!requireAdmin(socket)) return;

    if (state.quizStatus !== "open") {
      socket.emit("adminError", "Das Quiz ist aktuell nicht offen.");
      return;
    }

    state.quizStatus = "closed";
    pushAll();
  });

  socket.on("adminReleaseResults", () => {
    if (!requireAdmin(socket)) return;

    if (state.quizStatus !== "closed" && state.quizStatus !== "released") {
      socket.emit("adminError", "Bitte das Quiz zuerst schließen.");
      return;
    }

    state.quizStatus = "released";
    pushAll();
  });

  socket.on("adminResetTeams", () => {
    if (!requireAdmin(socket)) return;

    state.teams = {};
    state.answers = {};
    state.questions.forEach(question => {
      state.answers[question.id] = {};
    });
    state.quizStatus = "draft";
    pushAll();
  });

  socket.on("adminResetAll", () => {
    if (!requireAdmin(socket)) return;

    state.teams = {};
    state.questions = [];
    state.answers = {};
    state.quizStatus = "draft";
    pushAll();
  });

  socket.on("disconnect", () => {
    const key = socket.data.teamKey;

    if (key && state.teams[key]) {
      state.teams[key].online = false;
      state.teams[key].lastSeen = now();
      pushAll();
    }
  });
});

server.listen(PORT, () => {
  console.log("\nSelf-paced Schätzquiz läuft.");
  console.log("Moderations-PIN:", ADMIN_PIN);
  console.log("\nAdressen:");
  localUrls().forEach(url => console.log("  Teams: " + url + " | Admin: " + url + "admin"));
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
.wrap{max-width:1180px;margin:0 auto;padding:24px}
.narrow{max-width:760px}
.hero{padding:32px 0 18px}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;color:var(--accent)}
.dot{width:14px;height:14px;border-radius:50%;background:var(--accent2);box-shadow:18px 0 0 var(--accent),36px 0 0 var(--warn)}
h1{font-family:Georgia,serif;font-size:clamp(34px,6vw,72px);line-height:.94;margin:18px 0 10px;letter-spacing:-.05em}
h2{font-family:Georgia,serif;font-size:30px;margin:0 0 16px;letter-spacing:-.03em}
h3{margin:0 0 10px;font-size:19px}.sub{font-size:19px;color:var(--muted);max-width:760px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.card{background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:20px;box-shadow:var(--shadow)}
.panel{background:#231B16;color:#FFF8EA;border-radius:22px;padding:24px}.panel .muted{color:#E8D6BA}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.between{display:flex;justify-content:space-between;gap:12px;align-items:center}.muted{color:var(--muted)}.big{font-size:24px}.huge{font-size:44px;font-weight:900}.ok{color:var(--good)}.bad{color:var(--bad)}
input,button,textarea{font:inherit}input,textarea{width:100%;border:1px solid var(--line);background:#FFFDF8;border-radius:12px;padding:13px 14px;color:var(--ink)}textarea{min-height:86px;resize:vertical}label{display:block;font-weight:700;margin:12px 0 6px}
.btn{border:0;border-radius:999px;background:var(--ink);color:#fff;padding:12px 18px;font-weight:800;cursor:pointer;transition:.15s transform,.15s opacity}.btn:hover{transform:translateY(-1px)}.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}.btn.alt{background:var(--accent)}.btn.green{background:var(--accent2)}.btn.ghost{background:#F4E6CC;color:var(--ink)}.btn.danger{background:var(--bad)}
.pill{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);background:#FFFDF8;border-radius:999px;padding:7px 11px;font-size:14px;font-weight:800}.status{background:#241A14;color:#FFF8EA;border-color:#241A14}.list{display:grid;gap:10px}.item{border:1px solid var(--line);background:#FFFDF8;border-radius:14px;padding:14px}.table{width:100%;border-collapse:collapse}.table th,.table td{text-align:left;border-bottom:1px solid var(--line);padding:10px 8px;vertical-align:top}.table th{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}.rank{font-weight:900;font-size:20px}.qr{width:220px;max-width:100%;background:#FFF8EA;border-radius:16px;padding:10px}.screen{min-height:54vh;display:grid;place-items:center;text-align:center}.answerBox{font-size:30px;text-align:center;font-weight:900}.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:#1F1A17;color:white;padding:12px 16px;border-radius:999px;box-shadow:var(--shadow);display:none;z-index:5}.toast.show{display:block}.hide{display:none!important}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 18px}.tab{border:1px solid var(--line);background:#FFFDF8;color:var(--ink);border-radius:999px;padding:10px 14px;font-weight:800;cursor:pointer}.tab.active{background:var(--ink);color:#fff;border-color:var(--ink)}.tabPage{display:none}.tabPage.active{display:block}.metric{font-size:32px;font-weight:900}.progressOuter{height:12px;border-radius:999px;background:#F0DFC1;overflow:hidden}.progressInner{height:100%;background:var(--accent2);width:0}.podium{display:grid;grid-template-columns:1fr 1.15fr 1fr;gap:16px;align-items:end;margin-top:22px}.podiumCard{background:#FFFDF8;border:1px solid var(--line);border-radius:22px;padding:24px;text-align:center}.podiumCard.first{background:#231B16;color:#FFF8EA;min-height:260px}.podiumCard.second{min-height:220px}.podiumCard.third{min-height:190px}.medal{font-size:52px}.small{font-size:14px}
@media(max-width:860px){.grid,.grid3,.grid4,.podium{grid-template-columns:1fr}.wrap{padding:16px}h1{font-size:42px}.between{align-items:flex-start;flex-direction:column}.huge{font-size:34px}.tabs{overflow:auto;flex-wrap:nowrap;padding-bottom:4px}.tab{white-space:nowrap}}
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
    <p class="sub">Gebt euer zugeordnetes Symbol ein und beantwortet die Schätzfragen in eurem Tempo.</p>
  </section>

  <section id="join" class="card">
    <h2>Mitspielen</h2>
    <label for="teamLabel">Teamname / Symbol eingeben</label>
    <input id="teamLabel" maxlength="80" autocomplete="off" placeholder="z. B. Team Sonne oder Symbol Stern">
    <p class="muted">Bitte gebt nur euren Teamnamen oder das euch zugeordnete Symbol ein.</p>
    <button class="btn alt" id="joinBtn">Beitreten</button>
  </section>

  <section id="game" class="hide"></section>
</div>
<div id="toast" class="toast"></div>
<script src="/socket.io/socket.io.js"></script>
<script>
var socket = io();
var teamStorageKey = "schaetzquizTeamLabel";
var currentState = null;

function qs(selector) { return document.querySelector(selector); }
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"]/g, function(character) {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    return "&quot;";
  });
}
function formatNumber(value) { return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(value); }
function toast(message) {
  var element = qs("#toast");
  element.textContent = message;
  element.classList.add("show");
  setTimeout(function() { element.classList.remove("show"); }, 2600);
}
function clear(element) { while (element.firstChild) element.removeChild(element.firstChild); }
function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function join() {
  var label = qs("#teamLabel").value.trim();
  if (!label) { toast("Bitte Teamnamen oder Symbol eingeben."); return; }
  localStorage.setItem(teamStorageKey, label);
  socket.emit("participantJoin", { teamLabel: label });
}
function submitAnswer() {
  if (!currentState || !currentState.nextQuestion) return;
  var input = qs("#answerInput");
  socket.emit("submitAnswer", { questionId: currentState.nextQuestion.id, value: input ? input.value : "" });
}
function renderWaiting(text) {
  var root = qs("#game");
  clear(root);
  var card = el("div", "card screen");
  var inner = el("div");
  inner.appendChild(el("div", "pill status", "Wartebereich"));
  inner.appendChild(el("h2", "", text));
  inner.appendChild(el("p", "sub", "Bitte lasst diese Seite geöffnet."));
  card.appendChild(inner);
  root.appendChild(card);
}
function renderQuestion(state) {
  var root = qs("#game");
  clear(root);
  var q = state.nextQuestion;
  var card = el("div", "panel");
  card.appendChild(el("div", "pill", "Frage " + (q.index + 1) + " von " + state.questionCount));
  card.appendChild(el("h2", "", q.text));
  if (q.unit) card.appendChild(el("p", "muted", "Einheit: " + q.unit));
  var input = el("input", "answerBox");
  input.id = "answerInput";
  input.inputMode = "decimal";
  input.placeholder = "Eure Schätzung";
  card.appendChild(input);
  var spacer = el("div");
  spacer.style.height = "14px";
  card.appendChild(spacer);
  var button = el("button", "btn alt", "Antwort absenden");
  button.id = "answerButton";
  button.onclick = submitAnswer;
  card.appendChild(button);
  var hint = el("p", "muted", "Nach dem Absenden geht es automatisch zur nächsten Frage. Antworten können danach nicht geändert werden.");
  card.appendChild(hint);
  root.appendChild(card);
  setTimeout(function() { input.focus(); }, 50);
  input.addEventListener("keydown", function(event) { if (event.key === "Enter") submitAnswer(); });
}
function renderDone() {
  var root = qs("#game");
  clear(root);
  var card = el("div", "card screen");
  var inner = el("div");
  inner.appendChild(el("div", "pill status", "Fertig"));
  inner.appendChild(el("h2", "", "Danke, eure Antworten wurden gespeichert."));
  inner.appendChild(el("p", "sub", "Die Ergebnisse werden später freigegeben."));
  card.appendChild(inner);
  root.appendChild(card);
}
function renderReleased(state) {
  var root = qs("#game");
  clear(root);
  var card = el("div", "card");
  card.appendChild(el("div", "pill status", "Ergebnisse freigegeben"));
  card.appendChild(el("h2", "", "Eure Auswertung"));
  if (state.ownRank) {
    card.appendChild(el("p", "big", "Gesamtplatz: #" + state.ownRank.rank + " · Punkte: " + state.ownRank.score + " · Ø Abstand: " + state.ownRank.avgDiffLabel));
  }
  card.appendChild(el("h3", "", "Top 5 Gesamtrangliste"));
  card.appendChild(table(["Platz", "Team/Symbol", "Punkte", "Ø Abstand"], state.leaderboard.map(function(row) {
    return ["#" + row.rank, row.teamLabel, String(row.score), row.avgDiffLabel];
  })));
  card.appendChild(el("h3", "", "Eure Antworten je Frage"));
  state.questionDetails.forEach(function(q) {
    var item = el("div", "item");
    item.appendChild(el("h3", "", q.text));
    item.appendChild(el("p", "", "Richtige Antwort: " + q.answerLabel + " " + (q.unit || "")));
    item.appendChild(el("p", "", "Eure Schätzung: " + q.ownValueLabel + " " + (q.unit || "")));
    item.appendChild(el("p", "", "Abstand: " + q.ownDiffLabel + " " + (q.unit || "") + " · Platz: " + (q.ownRank ? "#" + q.ownRank : "-")));
    item.appendChild(el("p", "muted", "Gewinnerteam(s): " + (q.winners.length ? q.winners.join(", ") : "-")));
    if (q.explanation) item.appendChild(el("p", "muted", q.explanation));
    card.appendChild(item);
  });
  root.appendChild(card);
}
function table(headers, rows) {
  var t = el("table", "table");
  var thead = document.createElement("thead");
  var hr = document.createElement("tr");
  headers.forEach(function(header) { hr.appendChild(el("th", "", header)); });
  thead.appendChild(hr);
  t.appendChild(thead);
  var tbody = document.createElement("tbody");
  rows.forEach(function(row) {
    var tr = document.createElement("tr");
    row.forEach(function(cell) { tr.appendChild(el("td", "", cell)); });
    tbody.appendChild(tr);
  });
  t.appendChild(tbody);
  return t;
}
function render(state) {
  currentState = state;
  if (!state.team) return;
  qs("#join").classList.add("hide");
  qs("#game").classList.remove("hide");
  if (state.quizStatus === "draft") return renderWaiting("Das Quiz ist noch nicht geöffnet. Bitte wartet auf die Moderation.");
  if (state.quizStatus === "closed") return renderWaiting("Das Quiz ist geschlossen. Die Ergebnisse werden gleich freigegeben.");
  if (state.quizStatus === "released") return renderReleased(state);
  if (state.quizStatus === "open" && state.nextQuestion) return renderQuestion(state);
  if (state.quizStatus === "open" && !state.nextQuestion) return renderDone();
}
var storedTeam = localStorage.getItem(teamStorageKey);
if (storedTeam) qs("#teamLabel").value = storedTeam;
qs("#joinBtn").onclick = join;
qs("#teamLabel").addEventListener("keydown", function(event) { if (event.key === "Enter") join(); });
socket.on("participantAccepted", function(data) { localStorage.setItem(teamStorageKey, data.teamLabel); });
socket.on("participantError", toast);
socket.on("participantState", render);
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
      <p class="sub">Self-paced Quiz: Teams beantworten alle Schätzfragen eigenständig. Ergebnisse werden erst nach Freigabe sichtbar.</p>
    </div>
    <div class="card" style="text-align:center">
      <img class="qr" src="/qr.svg" alt="QR-Code zum Mitspielen">
      <div class="muted">QR-Code für Teams</div>
    </div>
  </section>

  <section id="login" class="card narrow">
    <h2>Moderations-PIN</h2>
    <input id="pin" type="password" placeholder="PIN eingeben">
    <div style="height:14px"></div>
    <button class="btn alt" id="loginBtn">Einloggen</button>
    <p class="muted">Standard-PIN ist 1234, falls in Render keine eigene PIN gesetzt wurde.</p>
  </section>

  <main id="admin" class="hide">
    <nav class="tabs" id="tabs"></nav>

    <section id="tab-overview" class="tabPage active"></section>
    <section id="tab-questions" class="tabPage"></section>
    <section id="tab-progress" class="tabPage"></section>
    <section id="tab-results" class="tabPage"></section>
    <section id="tab-podium" class="tabPage"></section>
    <section id="tab-settings" class="tabPage"></section>
  </main>
</div>
<div id="toast" class="toast"></div>
<script src="/socket.io/socket.io.js"></script>
<script>
var socket = io();
var state = null;
var currentTab = "overview";
var tabList = [
  ["overview", "Übersicht"],
  ["questions", "Fragen"],
  ["progress", "Fortschritt"],
  ["results", "Ergebnisse"],
  ["podium", "Siegerehrung"],
  ["settings", "Einstellungen"]
];
function qs(selector) { return document.querySelector(selector); }
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"]/g, function(character) {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    return "&quot;";
  });
}
function formatNumber(value) { return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(value); }
function toast(message) {
  var element = qs("#toast");
  element.textContent = message;
  element.classList.add("show");
  setTimeout(function() { element.classList.remove("show"); }, 2600);
}
function clear(element) { while (element.firstChild) element.removeChild(element.firstChild); }
function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function table(headers, rows) {
  var t = el("table", "table");
  var thead = document.createElement("thead");
  var trh = document.createElement("tr");
  headers.forEach(function(header) { trh.appendChild(el("th", "", header)); });
  thead.appendChild(trh);
  t.appendChild(thead);
  var tbody = document.createElement("tbody");
  rows.forEach(function(row) {
    var tr = document.createElement("tr");
    row.forEach(function(cell) { tr.appendChild(el("td", "", cell)); });
    tbody.appendChild(tr);
  });
  t.appendChild(tbody);
  return t;
}
function statusLabel(status) {
  if (status === "open") return "Offen für Antworten";
  if (status === "closed") return "Geschlossen";
  if (status === "released") return "Ergebnisse freigegeben";
  return "Noch nicht geöffnet";
}
function completionText() {
  return state.totalAnswers + " von " + state.totalPossibleAnswers + " Antworten abgegeben";
}
function completionPercent() {
  if (!state.totalPossibleAnswers) return 0;
  return Math.round((state.totalAnswers / state.totalPossibleAnswers) * 100);
}
function buildTabs() {
  var tabs = qs("#tabs");
  clear(tabs);
  tabList.forEach(function(tab) {
    var button = el("button", "tab" + (currentTab === tab[0] ? " active" : ""), tab[1]);
    button.onclick = function() { currentTab = tab[0]; render(); };
    tabs.appendChild(button);
  });
  tabList.forEach(function(tab) {
    var page = qs("#tab-" + tab[0]);
    if (page) page.className = "tabPage" + (currentTab === tab[0] ? " active" : "");
  });
}
function metric(label, value) {
  var card = el("div", "card");
  card.appendChild(el("div", "muted", label));
  card.appendChild(el("div", "metric", value));
  return card;
}
function actionButton(text, className, eventName, confirmText) {
  var button = el("button", "btn " + className, text);
  button.onclick = function() {
    if (confirmText && !confirm(confirmText)) return;
    socket.emit(eventName);
  };
  return button;
}
function renderOverview() {
  var root = qs("#tab-overview");
  clear(root);
  var grid = el("div", "grid4");
  grid.appendChild(metric("Quiz-Status", statusLabel(state.quizStatus)));
  grid.appendChild(metric("Teams", String(state.teams.length)));
  grid.appendChild(metric("Fragen", String(state.questions.length)));
  grid.appendChild(metric("Fortschritt", completionPercent() + "%"));
  root.appendChild(grid);
  var card = el("div", "card");
  card.style.marginTop = "16px";
  card.appendChild(el("h2", "", "Hauptaktionen"));
  var progress = el("div", "progressOuter");
  var inner = el("div", "progressInner");
  inner.style.width = completionPercent() + "%";
  progress.appendChild(inner);
  card.appendChild(progress);
  card.appendChild(el("p", "muted", completionText()));
  var row = el("div", "row");
  row.appendChild(actionButton("Quiz öffnen", "green", "adminOpenQuiz"));
  row.appendChild(actionButton("Quiz schließen", "ghost", "adminCloseQuiz"));
  row.appendChild(actionButton("Ergebnisse freigeben", "alt", "adminReleaseResults"));
  card.appendChild(row);
  root.appendChild(card);
  var info = el("div", "card");
  info.style.marginTop = "16px";
  info.appendChild(el("h2", "", "QR-Code"));
  info.appendChild(el("p", "muted", "Den QR-Code oben rechts können Teams scannen. Ergebnisse sind erst nach Freigabe sichtbar."));
  root.appendChild(info);
}
function renderQuestions() {
  var root = qs("#tab-questions");
  clear(root);
  var grid = el("div", "grid");
  var form = el("div", "card");
  form.appendChild(el("h2", "", "Neue Frage anlegen"));
  form.appendChild(labelInput("Fragetext", "qText", "textarea", "z. B. Wie viele Mitarbeitende hatte das Unternehmen im Jahr 2015?"));
  form.appendChild(labelInput("Richtige Zahl", "qAnswer", "input", "z. B. 735"));
  form.appendChild(labelInput("Einheit optional", "qUnit", "input", "z. B. Personen, €, Stück, km"));
  form.appendChild(labelInput("Erklärung optional", "qExplanation", "textarea", "z. B. 2015 lag die Zahl der Mitarbeitenden bei 735."));
  var add = el("button", "btn green", "Frage hinzufügen");
  add.onclick = function() {
    socket.emit("adminAddQuestion", {
      text: qs("#qText").value,
      answer: qs("#qAnswer").value,
      unit: qs("#qUnit").value,
      explanation: qs("#qExplanation").value
    });
  };
  form.appendChild(add);
  if (state.quizStatus !== "draft") form.appendChild(el("p", "muted", "Fragen können nur geändert werden, solange das Quiz noch nicht geöffnet wurde."));
  grid.appendChild(form);
  var list = el("div", "card");
  list.appendChild(el("h2", "", "Fragenliste"));
  if (!state.questions.length) {
    list.appendChild(el("p", "muted", "Noch keine Fragen angelegt."));
  } else {
    state.questions.forEach(function(question, index) {
      var item = el("div", "item");
      item.appendChild(el("h3", "", (index + 1) + ". " + question.text));
      item.appendChild(el("p", "muted", "Lösung: " + formatNumber(question.answer) + " " + (question.unit || "")));
      if (question.explanation) item.appendChild(el("p", "muted", question.explanation));
      var del = el("button", "btn ghost", "Löschen");
      del.onclick = function() {
        if (confirm("Diese Frage wirklich löschen?")) socket.emit("adminRemoveQuestion", { id: question.id });
      };
      item.appendChild(del);
      list.appendChild(item);
    });
  }
  grid.appendChild(list);
  root.appendChild(grid);
}
function labelInput(labelText, id, type, placeholder) {
  var wrap = el("div");
  var label = el("label", "", labelText);
  label.setAttribute("for", id);
  var input = type === "textarea" ? document.createElement("textarea") : document.createElement("input");
  input.id = id;
  input.placeholder = placeholder;
  if (type !== "textarea") input.inputMode = id === "qAnswer" ? "decimal" : "text";
  wrap.appendChild(label);
  wrap.appendChild(input);
  return wrap;
}
function renderProgress() {
  var root = qs("#tab-progress");
  clear(root);
  var grid = el("div", "grid");
  var teams = el("div", "card");
  teams.appendChild(el("h2", "", "Fortschritt je Team"));
  if (!state.teamProgress.length) {
    teams.appendChild(el("p", "muted", "Noch keine Teams beigetreten."));
  } else {
    teams.appendChild(table(["Team/Symbol", "Fortschritt", "Status"], state.teamProgress.map(function(team) {
      return [team.label, team.answered + " von " + team.total, team.complete ? "Fertig" : (team.online ? "Online" : "Offline")];
    })));
  }
  grid.appendChild(teams);
  var questions = el("div", "card");
  questions.appendChild(el("h2", "", "Antwortanzahl je Frage"));
  if (!state.questionStats.length) {
    questions.appendChild(el("p", "muted", "Noch keine Fragen angelegt."));
  } else {
    questions.appendChild(table(["Frage", "Antworten"], state.questionStats.map(function(question) {
      return [String(question.index + 1), question.answerCount + " Antworten"];
    })));
  }
  grid.appendChild(questions);
  root.appendChild(grid);
}
function renderResults() {
  var root = qs("#tab-results");
  clear(root);
  if (state.quizStatus !== "released") {
    var card = el("div", "card screen");
    var inner = el("div");
    inner.appendChild(el("div", "pill status", statusLabel(state.quizStatus)));
    inner.appendChild(el("h2", "", "Die Ergebnisse sind noch nicht freigegeben."));
    inner.appendChild(el("p", "sub", "Schließe das Quiz und gib die Ergebnisse frei, damit Ranglisten und Auswertungen sichtbar werden."));
    card.appendChild(inner);
    root.appendChild(card);
    return;
  }
  var boardCard = el("div", "card");
  boardCard.appendChild(el("h2", "", "Top 10 Gesamtrangliste"));
  boardCard.appendChild(table(["Platz", "Team/Symbol", "Punkte", "Ø Abstand", "Beantwortet"], state.leaderboard.slice(0, 10).map(function(row) {
    return ["#" + row.rank, row.teamLabel, String(row.score), row.avgDiffLabel, String(row.answered)];
  })));
  var podiumBtn = el("button", "btn alt", "Siegerehrung anzeigen");
  podiumBtn.onclick = function() { currentTab = "podium"; render(); };
  boardCard.appendChild(podiumBtn);
  root.appendChild(boardCard);
  state.questionResults.forEach(function(question, index) {
    var card = el("div", "card");
    card.style.marginTop = "16px";
    card.appendChild(el("h2", "", "Frage " + (index + 1)));
    card.appendChild(el("h3", "", question.text));
    card.appendChild(el("p", "", "Richtige Antwort: " + question.answerLabel + " " + (question.unit || "")));
    card.appendChild(el("p", "muted", "Gewinnerteam(s): " + (question.winners.length ? question.winners.join(", ") : "-")));
    if (question.explanation) card.appendChild(el("p", "muted", question.explanation));
    card.appendChild(table(["Platz", "Team/Symbol", "Schätzung", "Abstand"], question.results.map(function(row) {
      return ["#" + row.rank, row.teamLabel, row.valueLabel + " " + (question.unit || ""), row.diffLabel + " " + (question.unit || "")];
    })));
    root.appendChild(card);
  });
}
function renderPodium() {
  var root = qs("#tab-podium");
  clear(root);
  var card = el("div", "card screen");
  var inner = el("div");
  inner.appendChild(el("div", "pill status", "Siegerehrung"));
  inner.appendChild(el("h1", "", "Herzlichen Glückwunsch!"));
  inner.appendChild(el("p", "sub", "Unsere Gewinnerteams"));
  if (state.quizStatus !== "released" || !state.leaderboard.length) {
    inner.appendChild(el("p", "muted", "Noch keine freigegebenen Ergebnisse vorhanden."));
    card.appendChild(inner);
    root.appendChild(card);
    return;
  }
  var places = [
    state.leaderboard.filter(function(row) { return row.rank === 1; }),
    state.leaderboard.filter(function(row) { return row.rank === 2; }),
    state.leaderboard.filter(function(row) { return row.rank === 3; })
  ];
  var podium = el("div", "podium");
  podium.appendChild(podiumCard("🥈", "Platz 2", places[1], "second"));
  podium.appendChild(podiumCard("🥇", "Platz 1", places[0], "first"));
  podium.appendChild(podiumCard("🥉", "Platz 3", places[2], "third"));
  inner.appendChild(podium);
  if (places.some(function(list) { return list.length > 1; })) inner.appendChild(el("p", "muted", "Hinweis: Es gibt einen Gleichstand auf dem Podium."));
  card.appendChild(inner);
  root.appendChild(card);
}
function podiumCard(icon, title, rows, extraClass) {
  var card = el("div", "podiumCard " + extraClass);
  card.appendChild(el("div", "medal", icon));
  card.appendChild(el("h2", "", title));
  if (!rows.length) {
    card.appendChild(el("p", "muted", "-"));
    return card;
  }
  rows.forEach(function(row) {
    card.appendChild(el("h3", "", row.teamLabel));
    card.appendChild(el("p", "", row.score + " Punkte"));
  });
  return card;
}
function renderSettings() {
  var root = qs("#tab-settings");
  clear(root);
  var card = el("div", "card");
  card.appendChild(el("h2", "", "Einstellungen & Zurücksetzen"));
  card.appendChild(el("p", "muted", "Aktuelle Admin-PIN: " + state.adminPin));
  card.appendChild(el("p", "muted", "Die Daten werden nur im Arbeitsspeicher gespeichert. Bei einem Neustart des Servers können Daten verloren gehen."));
  var row = el("div", "row");
  row.appendChild(actionButton("Nur Teams & Antworten zurücksetzen", "ghost", "adminResetTeams", "Teams, Antworten und Fortschritt löschen, aber Fragen behalten?"));
  row.appendChild(actionButton("Alles zurücksetzen", "danger", "adminResetAll", "Wirklich alles löschen, inklusive Fragen?"));
  card.appendChild(row);
  root.appendChild(card);
}
function render() {
  if (!state) return;
  buildTabs();
  renderOverview();
  renderQuestions();
  renderProgress();
  renderResults();
  renderPodium();
  renderSettings();
}
qs("#loginBtn").onclick = function() { socket.emit("adminAuth", { pin: qs("#pin").value }); };
qs("#pin").addEventListener("keydown", function(event) { if (event.key === "Enter") socket.emit("adminAuth", { pin: qs("#pin").value }); });
socket.on("connect", function() { console.log("Admin verbunden"); });
socket.on("adminAuthed", function() { qs("#login").classList.add("hide"); qs("#admin").classList.remove("hide"); });
socket.on("adminError", toast);
socket.on("adminState", function(nextState) { state = nextState; render(); });
</script>
</body></html>`;
}
