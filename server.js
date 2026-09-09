// Schätzquiz Web-App für Mitarbeiterversammlungen
// ------------------------------------------------
// Start:
//   npm init -y
//   npm install express socket.io qrcode
//   ADMIN_PIN=2468 node server.js
//
// Danach im Browser öffnen:
//   Moderation: http://<deine-ip>:3000/admin
//   Teilnehmende: QR-Code auf der Moderationsseite scannen

const os = require("os");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PIN = String(process.env.ADMIN_PIN || "1234");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

const now = () => Date.now();
const id = () => Math.random().toString(36).slice(2, 10);

function cleanText(v, max = 120) {
  return String(v || "").replace(/[<>]/g, "").trim().slice(0, max);
}

function parseNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v || "")
    .trim()
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function fmt(n) {
  if (!Number.isFinite(n)) return "";
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(n);
}

function q() {
  return state.questions.find(x => x.id === state.currentQuestionId) || null;
}

function getResults(questionId) {
  const question = state.questions.find(x => x.id === questionId);
  if (!question) return [];
  const rows = Object.entries(state.answers[questionId] || {}).map(([pid, a]) => {
    const p = state.participants[pid] || { name: "Unbekannt" };
    return {
      participantId: pid,
      name: p.name,
      value: a.value,
      valueLabel: fmt(a.value),
      diff: Math.abs(a.value - question.answer),
      diffLabel: fmt(Math.abs(a.value - question.answer)),
      at: a.at
    };
  });
  rows.sort((a, b) => a.diff - b.diff || a.at - b.at || a.name.localeCompare(b.name));
  let lastDiff = null;
  let rank = 0;
  rows.forEach((r, i) => {
    if (lastDiff === null || r.diff !== lastDiff) rank = i + 1;
    r.rank = rank;
    lastDiff = r.diff;
  });
  return rows;
}

function awardCurrentQuestion() {
  const question = q();
  if (!question || state.awarded[question.id]) return;
  const results = getResults(question.id);
  const points = { 1: 3, 2: 2, 3: 1 };
  results.forEach(r => {
    if (r.rank <= 3) {
      state.scores[r.participantId] = (state.scores[r.participantId] || 0) + points[r.rank];
    }
  });
  state.awarded[question.id] = true;
  state.history.push({
    questionId: question.id,
    text: question.text,
    answer: question.answer,
    unit: question.unit,
    winners: results.filter(r => r.rank === 1).map(r => r.name)
  });
}

function leaderboard() {
  const rows = Object.values(state.participants).map(p => ({
    participantId: p.id,
    name: p.name,
    score: state.scores[p.id] || 0,
    online: p.online
  }));
  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  let lastScore = null;
  let rank = 0;
  rows.forEach((r, i) => {
    if (lastScore === null || r.score !== lastScore) rank = i + 1;
    r.rank = rank;
    lastScore = r.score;
  });
  return rows;
}

function adminPayload() {
  const question = q();
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

function participantPayload(pid) {
  const question = q();
  const answer = question ? (state.answers[question.id] || {})[pid] : null;
  const results = question && state.status === "revealed" ? getResults(question.id) : [];
  const own = results.find(r => r.participantId === pid) || null;
  return {
    participant: state.participants[pid] || null,
    currentQuestion: question ? { id: question.id, text: question.text, unit: question.unit } : null,
    correctAnswer: question && state.status === "revealed" ? question.answer : null,
    status: state.status,
    answer: answer ? { value: answer.value, valueLabel: fmt(answer.value) } : null,
    results: results.slice(0, 8),
    ownResult: own,
    leaderboard: leaderboard().slice(0, 10),
    history: state.history
  };
}

function pushAll() {
  io.to("admins").emit("adminState", adminPayload());
  for (const pid of Object.keys(state.participants)) {
    io.to("participant:" + pid).emit("participantState", participantPayload(pid));
  }
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

app.get("/qr.svg", async (req, res) => {
  try {
    const svg = await QRCode.toString(baseUrl(req), {
      type: "svg",
      margin: 1,
      width: 360,
      color: { dark: "#1F1A17", light: "#FFF8EA" }
    });
    res.type("image/svg+xml").send(svg);
  } catch (e) {
    res.status(500).send("QR-Code konnte nicht erzeugt werden.");
  }
});

app.get("/", (req, res) => res.send(participantHtml()));
app.get("/admin", (req, res) => res.send(adminHtml()));

io.on("connection", socket => {
  socket.on("participantJoin", data => {
    const pid = cleanText(data && data.id, 40) || id();
    const name = cleanText(data && data.name, 40) || "Gast";
    state.participants[pid] = {
      id: pid,
      name,
      online: true,
      joinedAt: state.participants[pid]?.joinedAt || now(),
      lastSeen: now()
    };
    socket.data.pid = pid;
    socket.join("participant:" + pid);
    socket.emit("participantAccepted", { id: pid, name });
    socket.emit("participantState", participantPayload(pid));
    pushAll();
  });

  socket.on("submitGuess", data => {
    const pid = socket.data.pid;
    const question = q();
    if (!pid || !question || state.status !== "open") return;
    if (String(data && data.questionId) !== question.id) return;
    const value = parseNumber(data && data.value);
    if (value === null) {
      socket.emit("participantError", "Bitte gib eine gültige Zahl ein.");
      return;
    }
    state.answers[question.id] ||= {};
    state.answers[question.id][pid] = { value, at: now() };
    socket.emit("participantState", participantPayload(pid));
    pushAll();
  });

  socket.on("adminAuth", data => {
    if (String(data && data.pin) === ADMIN_PIN) {
      socket.data.isAdmin = true;
      socket.join("admins");
      socket.emit("adminAuthed");
      socket.emit("adminState", adminPayload());
    } else {
      socket.emit("adminError", "Falsche PIN.");
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
    const question = { id: id(), text, answer, unit };
    state.questions.push(question);
    state.answers[question.id] = {};
    pushAll();
  });

  socket.on("adminRemoveQuestion", data => {
    if (!requireAdmin(socket)) return;
    const qid = String(data && data.id);
    state.questions = state.questions.filter(x => x.id !== qid);
    delete state.answers[qid];
    delete state.awarded[qid];
    if (state.currentQuestionId === qid) {
      state.currentQuestionId = null;
      state.status = "lobby";
    }
    pushAll();
  });

  socket.on("adminStartQuestion", data => {
    if (!requireAdmin(socket)) return;
    const qid = String(data && data.id);
    if (!state.questions.find(x => x.id === qid)) return;
    state.currentQuestionId = qid;
    state.status = "open";
    state.answers[qid] = {};
    delete state.awarded[qid];
    pushAll();
  });

  socket.on("adminCloseQuestion", () => {
    if (!requireAdmin(socket)) return;
    if (!q()) return;
    state.status = "closed";
    pushAll();
  });

  socket.on("adminRevealQuestion", () => {
    if (!requireAdmin(socket)) return;
    if (!q()) return;
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
    const pid = socket.data.pid;
    if (pid && state.participants[pid]) {
      state.participants[pid].online = false;
      state.participants[pid].lastSeen = now();
      pushAll();
    }
  });
});

server.listen(PORT, () => {
  console.log("\nSchätzquiz läuft.");
  console.log("Moderations-PIN:", ADMIN_PIN);
  console.log("\nÖffne die Moderation möglichst über eine Netzwerk-Adresse, nicht über localhost:");
  for (const u of lanUrls()) console.log("  " + u + "admin");
  console.log("");
});

function lanUrls() {
  const urls = ["http://localhost:" + PORT + "/"];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) urls.push("http://" + net.address + ":" + PORT + "/");
    }
  }
  return urls;
}

function commonHead(title) {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root{
  --bg:#FFF8EA; --paper:#FFFFFF; --ink:#1F1A17; --muted:#71665B;
  --line:#E9D9BD; --accent:#B7410E; --accent2:#0F6B5F; --warn:#B88716;
  --good:#167048; --bad:#A33A2A; --shadow:0 14px 40px rgba(60,39,18,.12);
}
*{box-sizing:border-box} body{margin:0;background:radial-gradient(circle at top left,#FFE9B5,transparent 34%),var(--bg);color:var(--ink);font-family:Arial,Helvetica,sans-serif;line-height:1.45}
.wrap{max-width:1120px;margin:0 auto;padding:24px}.narrow{max-width:760px}.hero{padding:32px 0 18px}.brand{display:inline-flex;align-items:center;gap:10px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;color:var(--accent)}
.dot{width:14px;height:14px;border-radius:50%;background:var(--accent2);box-shadow:18px 0 0 var(--accent),36px 0 0 var(--warn)}
h1{font-family:Georgia,serif;font-size:clamp(34px,6vw,72px);line-height:.94;margin:18px 0 10px;letter-spacing:-.05em}h2{font-family:Georgia,serif;font-size:30px;margin:0 0 16px;letter-spacing:-.03em}h3{margin:0 0 10px;font-size:19px}.sub{font-size:19px;color:var(--muted);max-width:720px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}.card{background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:20px;box-shadow:var(--shadow)}
.panel{background:#231B16;color:#FFF8EA;border-radius:22px;padding:24px}.panel .muted{color:#E8D6BA}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.between{display:flex;justify-content:space-between;gap:12px;align-items:center}.muted{color:var(--muted)}.big{font-size:24px}.huge{font-size:44px;font-weight:900}.ok{color:var(--good)}.bad{color:var(--bad)}
input,button,textarea{font:inherit}input,textarea{width:100%;border:1px solid var(--line);background:#FFFDF8;border-radius:12px;padding:13px 14px;color:var(--ink)}textarea{min-height:86px;resize:vertical}label{display:block;font-weight:700;margin:12px 0 6px}.btn{border:0;border-radius:999px;background:var(--ink);color:#fff;padding:12px 18px;font-weight:800;cursor:pointer;transition:.15s transform,.15s opacity}.btn:hover{transform:translateY(-1px)}.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}.btn.alt{background:var(--accent)}.btn.green{background:var(--accent2)}.btn.ghost{background:#F4E6CC;color:var(--ink)}.btn.danger{background:var(--bad)}
.pill{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);background:#FFFDF8;border-radius:999px;padding:7px 11px;font-size:14px;font-weight:800}.status{background:#241A14;color:#FFF8EA;border-color:#241A14}.list{display:grid;gap:10px}.item{border:1px solid var(--line);background:#FFFDF8;border-radius:14px;padding:14px}.table{width:100%;border-collapse:collapse}.table th,.table td{text-align:left;border-bottom:1px solid var(--line);padding:10px 8px}.table th{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}.rank{font-weight:900;font-size:20px}.qr{width:220px;max-width:100%;background:#FFF8EA;border-radius:16px;padding:10px}.screen{min-height:56vh;display:grid;place-items:center;text-align:center}.answerBox{font-size:30px;text-align:center;font-weight:900}.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:#1F1A17;color:white;padding:12px 16px;border-radius:999px;box-shadow:var(--shadow);display:none;z-index:5}.toast.show{display:block}.hide{display:none!important}
@media(max-width:820px){.grid,.grid3{grid-template-columns:1fr}.wrap{padding:16px}h1{font-size:42px}.between{align-items:flex-start;flex-direction:column}.huge{font-size:34px}}
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
const socket = io();
const $ = s => document.querySelector(s);
const pidKey = "schaetzquizTeilnehmerId";
const nameKey = "schaetzquizName";
let pid = localStorage.getItem(pidKey) || Math.random().toString(36).slice(2,10);
let lastState = null;

if (localStorage.getItem(nameKey)) $("#name").value = localStorage.getItem(nameKey);

function toast(t){ const el=$("#toast"); el.textContent=t; el.classList.add("show"); setTimeout(()=>el.classList.remove("show"),2400); }
function esc(s){ return String(s ?? "").replace(/[&<>\"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;"}[c])); }
function join(){
  const name = $("#name").value.trim();
  if(!name){ toast("Bitte Namen eingeben."); return; }
  localStorage.setItem(pidKey,pid); localStorage.setItem(nameKey,name);
  socket.emit("participantJoin", {id:pid, name});
}
$("#joinBtn").onclick = join;
$("#name").addEventListener("keydown", e => { if(e.key === "Enter") join(); });

socket.on("participantAccepted", d => { pid=d.id; localStorage.setItem(pidKey,pid); $("#join").classList.add("hide"); $("#game").classList.remove("hide"); });
socket.on("participantError", toast);
socket.on("participantState", s => { lastState=s; render(s); });

function submitGuess(){
  const input = $("#guess");
  socket.emit("submitGuess", {questionId:lastState.currentQuestion.id, value:input.value});
}

function render(s){
  const el = $("#game");
  if(!s.participant){ return; }
  if(!s.currentQuestion){
    el.innerHTML = '<div class="card screen"><div><div class="pill status">Wartebereich</div><h2>Hallo '+esc(s.participant.name)+'</h2><p class="sub">Die Moderation startet gleich die nächste Schätzfrage.</p>'+leaderboardHtml(s.leaderboard)+'</div></div>';
    return;
  }
  if(s.status === "open"){
    el.innerHTML = '<div class="panel"><div class="pill">Frage läuft</div><h2 style="font-size:38px;margin-top:18px">'+esc(s.currentQuestion.text)+'</h2><p class="muted">Gib deine Schätzung als Zahl ein. Du kannst deine Antwort ändern, solange die Frage offen ist.</p><input id="guess" class="answerBox" inputmode="decimal" placeholder="Deine Schätzung" value="'+esc(s.answer ? s.answer.valueLabel : '')+'"><div style="height:14px"></div><button class="btn alt" onclick="submitGuess()">Schätzung absenden</button>'+(s.answer?'<p class="ok"><b>Gespeichert:</b> '+esc(s.answer.valueLabel)+' '+esc(s.currentQuestion.unit)+'</p>':'')+'</div>';
    setTimeout(()=>{ const g=$("#guess"); if(g) g.focus(); },30);
    return;
  }
  if(s.status === "closed"){
    el.innerHTML = '<div class="card screen"><div><div class="pill status">Antworten geschlossen</div><h2>Danke, deine Schätzung ist drin.</h2><p class="sub">Gleich wird aufgelöst.</p>'+(s.answer?'<p class="big"><b>Deine Schätzung:</b> '+esc(s.answer.valueLabel)+' '+esc(s.currentQuestion.unit)+'</p>':'<p class="bad">Du hast keine Schätzung abgegeben.</p>')+'</div></div>';
    return;
  }
  if(s.status === "revealed"){
    const unit = s.currentQuestion.unit || "";
    let own = s.ownResult ? '<p class="big">Dein Platz: <b>#'+s.ownResult.rank+'</b> · Abstand: <b>'+esc(s.ownResult.diffLabel)+' '+esc(unit)+'</b></p>' : '<p class="bad">Keine gültige Antwort abgegeben.</p>';
    el.innerHTML = '<div class="card"><div class="pill status">Auflösung</div><h2>'+esc(s.currentQuestion.text)+'</h2><div class="huge">'+esc(new Intl.NumberFormat("de-DE",{maximumFractionDigits:2}).format(s.correctAnswer))+' '+esc(unit)+'</div>'+own+resultsHtml(s.results, unit)+leaderboardHtml(s.leaderboard)+'</div>';
  }
}
function resultsHtml(rows, unit){
  if(!rows.length) return '<p class="muted">Noch keine Ergebnisse.</p>';
  return '<h3>Beste Schätzungen</h3><table class="table"><thead><tr><th>Platz</th><th>Name</th><th>Schätzung</th><th>Abstand</th></tr></thead><tbody>'+rows.map(r=>'<tr><td class="rank">#'+r.rank+'</td><td>'+esc(r.name)+'</td><td>'+esc(r.valueLabel)+' '+esc(unit)+'</td><td>'+esc(r.diffLabel)+' '+esc(unit)+'</td></tr>').join('')+'</tbody></table>';
}
function leaderboardHtml(rows){
  if(!rows.length) return '';
  return '<div style="height:18px"></div><h3>Gesamtrangliste</h3><table class="table"><tbody>'+rows.slice(0,5).map(r=>'<tr><td class="rank">#'+r.rank+'</td><td>'+esc(r.name)+'</td><td><b>'+r.score+'</b> Punkte</td></tr>').join('')+'</tbody></table>';
}
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
    <p class="muted">Standard-PIN ist 1234, falls du beim Start keine eigene PIN gesetzt hast.</p>
  </section>

  <main id="admin" class="hide">
    <div class="grid">
      <section class="card">
        <h2>Neue Schätzfrage</h2>
        <label>Frage</label>
        <textarea id="qText" placeholder="z. B. Wie viele Kaffee wurden letztes Jahr ungefähr getrunken?"></textarea>
        <div class="grid">
          <div><label>Richtige Zahl</label><input id="qAnswer" inputmode="decimal" placeholder="z. B. 12500"></div>
          <div><label>Einheit optional</label><input id="qUnit" placeholder="z. B. Tassen, €, Stück"></div>
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
      <section class="card"><h2>Gesamtrangliste</h2><div id="leaderboard"></div><div class="row" style="margin-top:14px"><button class="btn ghost" id="resetScoresBtn">Punkte zurücksetzen</button><button class="btn danger" id="resetAllBtn">Alles löschen</button></div></section>
    </div>
  </main>
</div>
<div id="toast" class="toast"></div>
<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io();
const $ = s => document.querySelector(s);
let state = null;
function toast(t){ const el=$("#toast"); el.textContent=t; el.classList.add("show"); setTimeout(()=>el.classList.remove("show"),2600); }
function esc(s){ return String(s ?? "").replace(/[&<>\"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;"}[c])); }
function fmt(n){ return new Intl.NumberFormat("de-DE",{maximumFractionDigits:2}).format(n); }

$("#loginBtn").onclick = () => socket.emit("adminAuth", {pin:$("#pin").value});
$("#pin").addEventListener("keydown", e => { if(e.key === "Enter") socket.emit("adminAuth", {pin:$("#pin").value}); });
$("#addBtn").onclick = () => socket.emit("adminAddQuestion", {text:$("#qText").value, answer:$("#qAnswer").value, unit:$("#qUnit").value});
$("#closeBtn").onclick = () => socket.emit("adminCloseQuestion");
$("#revealBtn").onclick = () => socket.emit("adminRevealQuestion");
$("#lobbyBtn").onclick = () => socket.emit("adminBackToLobby");
$("#resetScoresBtn").onclick = () => { if(confirm("Punkte und Historie zurücksetzen?")) socket.emit("adminResetScores"); };
$("#resetAllBtn").onclick = () => { if(confirm("Alles löschen: Fragen, Teilnehmende und Punkte?")) socket.emit("adminResetAll"); };

socket.on("adminAuthed", () => { $("#login").classList.add("hide"); $("#admin").classList.remove("hide"); });
socket.on("adminError", toast);
socket.on("adminState", s => { state = s; render(); });

function startQuestion(id){ socket.emit("adminStartQuestion", {id}); }
function removeQuestion(id){ if(confirm("Frage löschen?")) socket.emit("adminRemoveQuestion", {id}); }

function render(){
  if(!state) return;
  $("#statusPill").textContent = statusText(state.status);
  renderLive(); renderQuestions(); renderParticipants(); renderResults(); renderLeaderboard();
  $("#qText").value = $("#qText").value;
}
function statusText(s){ return s === "open" ? "Offen" : s === "closed" ? "Geschlossen" : s === "revealed" ? "Aufgelöst" : "Lobby"; }
function renderLive(){
  const q = state.currentQuestion;
  if(!q){ $("#liveBox").innerHTML = '<p class="muted">Noch keine Frage aktiv.</p><p><b>'+state.participants.length+'</b> Teilnehmende verbunden.</p>'; return; }
  $("#liveBox").innerHTML = '<h3>'+esc(q.text)+'</h3><p class="big"><b>'+state.answerCount+'</b> Antworten</p><p class="muted">Lösung: '+esc(fmt(q.answer))+' '+esc(q.unit||'')+'</p>';
}
function renderQuestions(){
  const box = $("#questions");
  if(!state.questions.length){ box.innerHTML = '<p class="muted">Noch keine Fragen angelegt.</p>'; return; }
  box.innerHTML = state.questions.map((q,i)=>'<div class="item"><div class="between"><div><b>'+(i+1)+'. '+esc(q.text)+'</b><br><span class="muted">Lösung: '+esc(fmt(q.answer))+' '+esc(q.unit||'')+'</span></div><div class="row"><button class="btn alt" onclick="startQuestion(\''+q.id+'\')">Start</button><button class="btn ghost" onclick="removeQuestion(\''+q.id+'\')">Löschen</button></div></div></div>').join('');
}
function renderParticipants(){
  const box = $("#participants");
  if(!state.participants.length){ box.innerHTML = '<p class="muted">Noch niemand beigetreten.</p>'; return; }
  box.innerHTML = state.participants.map(p=>'<div class="item between"><span><b>'+esc(p.name)+'</b></span><span class="pill">'+(p.online?'online':'offline')+'</span></div>').join('');
}
function renderResults(){
  const box = $("#results");
  const q = state.currentQuestion;
  if(!q){ box.innerHTML = '<p class="muted">Keine aktive Frage.</p>'; return; }
  const unit = q.unit || '';
  if(!state.results.length){ box.innerHTML = '<p class="muted">Noch keine Antworten.</p>'; return; }
  box.innerHTML = '<table class="table"><thead><tr><th>Platz</th><th>Name</th><th>Schätzung</th><th>Abstand</th></tr></thead><tbody>'+state.results.map(r=>'<tr><td class="rank">#'+r.rank+'</td><td>'+esc(r.name)+'</td><td>'+esc(r.valueLabel)+' '+esc(unit)+'</td><td>'+esc(r.diffLabel)+' '+esc(unit)+'</td></tr>').join('')+'</tbody></table>';
}
function renderLeaderboard(){
  const box = $("#leaderboard");
  if(!state.leaderboard.length){ box.innerHTML = '<p class="muted">Noch keine Punkte.</p>'; return; }
  box.innerHTML = '<table class="table"><thead><tr><th>Platz</th><th>Name</th><th>Punkte</th></tr></thead><tbody>'+state.leaderboard.map(r=>'<tr><td class="rank">#'+r.rank+'</td><td>'+esc(r.name)+'</td><td><b>'+r.score+'</b></td></tr>').join('')+'</tbody></table><p class="muted">Punkte pro Frage: Platz 1 = 3, Platz 2 = 2, Platz 3 = 1. Bei Gleichstand bekommen beide denselben Platz.</p>';
}
</script>
</body></html>`;
}
