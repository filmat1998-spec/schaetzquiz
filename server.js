// Self-paced Schätzquiz Web-App für Mitarbeiterversammlungen
// -----------------------------------------------------------
// Render:
//   Build Command: npm install
//   Start Command: npm start
//   Environment Variables optional:
//     ADMIN_PIN=2468
//     MODERATION_KEY=2468

const os = require("os");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PIN = String(process.env.ADMIN_PIN || "1234").trim();
const MODERATION_KEY = String(process.env.MODERATION_KEY || ADMIN_PIN).trim();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const sampleQuestions = [
  {
    id: "testfrage1",
    text: "Wie viele Tassen Kaffee werden bei uns ungefähr pro Monat getrunken?",
    answer: 1250,
    unit: "Tassen"
  },
  {
    id: "testfrage2",
    text: "Wie viele Mitarbeitende waren ungefähr bei der letzten Mitarbeiterversammlung dabei?",
    answer: 20,
    unit: "Personen"
  },
  {
    id: "testfrage3",
    text: "Wie viele Kilometer legt unser Team zusammen ungefähr pro Arbeitswoche zurück?",
    answer: 480,
    unit: "km"
  }
];

const state = {
  quizStatus: "draft", // draft | open | closed | released | podium
  teams: {},
  questions: sampleQuestions.map(q => ({ ...q })),
  answers: Object.fromEntries(sampleQuestions.map(q => [q.id, {}]))
};

const activeTeamSockets = {};

function now() { return Date.now(); }
function makeId() { return Math.random().toString(36).slice(2, 10); }
function cleanText(value, max = 180) { return String(value || "").replace(/[<>]/g, "").trim().slice(0, max); }
function teamKey(value) { return cleanText(value, 80).toLowerCase().replace(/\s+/g, " "); }

function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const input = String(value || "").trim().replace(/\s/g, "");
  if (!input) return null;
  let normalized = input;
  if (input.includes(",")) normalized = input.replace(/\./g, "").replace(",", ".");
  else {
    const dotCount = (input.match(/\./g) || []).length;
    if (dotCount > 1) normalized = input.replace(/\./g, "");
    else if (/^[-+]?\d{1,3}\.\d{3}$/.test(input)) normalized = input.replace(/\./g, "");
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
  state.questions.forEach(q => {
    const answer = (state.answers[q.id] || {})[key];
    if (answer) result[q.id] = answer;
  });
  return result;
}

function countTeamAnswers(key) { return Object.keys(getTeamAnswers(key)).length; }
function totalGivenAnswers() { return state.questions.reduce((sum, q) => sum + Object.keys(state.answers[q.id] || {}).length, 0); }

function teamProgress() {
  return Object.values(state.teams)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(team => {
      const answered = countTeamAnswers(team.key);
      return {
        key: team.key,
        label: team.label,
        online: !!team.online,
        answered,
        total: state.questions.length,
        complete: state.questions.length > 0 && answered >= state.questions.length
      };
    });
}

function getQuestionDistribution(questionId) {
  const q = state.questions.find(item => item.id === questionId);
  if (!q) return [];
  return Object.entries(state.answers[questionId] || {})
    .map(([key, answer]) => {
      const team = state.teams[key] || { label: "Unbekannt" };
      const diff = Math.abs(answer.value - q.answer);
      return { teamKey: key, teamLabel: team.label, value: answer.value, valueLabel: fmt(answer.value), diff, at: answer.at };
    })
    .sort((a, b) => a.value - b.value || a.teamLabel.localeCompare(b.teamLabel));
}

function getQuestionRanking(questionId) {
  const rows = getQuestionDistribution(questionId).slice();
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

function questionResults() {
  return state.questions.map(q => ({
    id: q.id,
    text: q.text,
    answer: q.answer,
    answerLabel: fmt(q.answer),
    unit: q.unit,
    answerCount: Object.keys(state.answers[q.id] || {}).length,
    distribution: getQuestionDistribution(q.id)
  }));
}

function scoreMap() {
  const map = {};
  Object.values(state.teams).forEach(team => {
    map[team.key] = { teamKey: team.key, teamLabel: team.label, score: 0, totalDiff: 0, answered: 0, avgDiff: Infinity };
  });
  state.questions.forEach(q => {
    getQuestionRanking(q.id).forEach(row => {
      if (!map[row.teamKey]) map[row.teamKey] = { teamKey: row.teamKey, teamLabel: row.teamLabel, score: 0, totalDiff: 0, answered: 0, avgDiff: Infinity };
      if (row.rank === 1) map[row.teamKey].score += 3;
      if (row.rank === 2) map[row.teamKey].score += 2;
      if (row.rank === 3) map[row.teamKey].score += 1;
      map[row.teamKey].totalDiff += row.diff;
      map[row.teamKey].answered += 1;
    });
  });
  Object.values(map).forEach(row => {
    row.avgDiff = row.answered ? row.totalDiff / row.answered : Infinity;
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

function buildAdminPayload(req) {
  const origin = req ? baseUrl(req) : "/";
  return {
    quizStatus: state.quizStatus,
    adminPin: ADMIN_PIN,
    moderationUrl: origin + "moderation?key=" + encodeURIComponent(MODERATION_KEY),
    questions: state.questions,
    teamCount: Object.keys(state.teams).length
  };
}

function buildModerationPayload() {
  const board = leaderboard();
  return {
    quizStatus: state.quizStatus,
    teams: Object.values(state.teams).sort((a, b) => a.label.localeCompare(b.label)),
    teamProgress: teamProgress(),
    totalAnswers: totalGivenAnswers(),
    questionResults: questionResults(),
    podium: board.filter(row => row.rank <= 3),
    leaderboard: board
  };
}

function buildParticipantPayload(key) {
  const answers = getTeamAnswers(key);
  const nextQuestion = state.questions.find(q => !answers[q.id]) || null;
  return {
    quizStatus: state.quizStatus,
    team: state.teams[key] || null,
    questionCount: state.questions.length,
    answeredCount: Object.keys(answers).length,
    nextQuestion: state.quizStatus === "open" && nextQuestion ? {
      id: nextQuestion.id,
      index: state.questions.findIndex(q => q.id === nextQuestion.id),
      text: nextQuestion.text,
      unit: nextQuestion.unit
    } : null
  };
}

function pushAdmin() { io.to("admins").emit("adminState", buildAdminPayload()); }
function pushModeration() { io.to("moderation").emit("moderationState", buildModerationPayload()); }
function pushTeam(key) { io.to("team:" + key).emit("participantState", buildParticipantPayload(key)); }
function pushAll() { pushAdmin(); pushModeration(); Object.keys(state.teams).forEach(pushTeam); }

function requireAdmin(socket) {
  if (!socket.data.isAdmin) socket.emit("adminError", "Bitte zuerst als Admin anmelden.");
  return !!socket.data.isAdmin;
}

function requireModerator(socket) {
  if (!socket.data.isModerator) socket.emit("moderationError", "Bitte zuerst den Moderationsmodus freischalten.");
  return !!socket.data.isModerator;
}

function addQuestion(data, socket) {
  if (state.quizStatus !== "draft") return socket.emit("adminError", "Fragen können nur geändert werden, solange das Quiz noch nicht geöffnet wurde.");
  const text = cleanText(data && data.text, 240);
  const answer = parseNumber(data && data.answer);
  const unit = cleanText(data && data.unit, 40);
  if (!text || answer === null) return socket.emit("adminError", "Bitte Fragetext und richtige Zahl eintragen.");
  const q = { id: makeId(), text, answer, unit };
  state.questions.push(q);
  state.answers[q.id] = {};
  pushAll();
}

function updateQuestion(data, socket) {
  if (state.quizStatus !== "draft") return socket.emit("adminError", "Fragen können nur geändert werden, solange das Quiz noch nicht geöffnet wurde.");
  const q = state.questions.find(item => item.id === String(data && data.id || ""));
  if (!q) return socket.emit("adminError", "Frage wurde nicht gefunden.");
  const text = cleanText(data && data.text, 240);
  const answer = parseNumber(data && data.answer);
  const unit = cleanText(data && data.unit, 40);
  if (!text || answer === null) return socket.emit("adminError", "Bitte Fragetext und gültige richtige Zahl eintragen.");
  q.text = text;
  q.answer = answer;
  q.unit = unit;
  pushAll();
}

function removeQuestion(data, socket) {
  if (state.quizStatus !== "draft") return socket.emit("adminError", "Fragen können nur gelöscht werden, solange das Quiz noch nicht geöffnet wurde.");
  const id = String(data && data.id || "");
  state.questions = state.questions.filter(q => q.id !== id);
  delete state.answers[id];
  pushAll();
}

function resetTeams() {
  state.teams = {};
  state.answers = {};
  state.questions.forEach(q => { state.answers[q.id] = {}; });
  state.quizStatus = "draft";
  Object.keys(activeTeamSockets).forEach(key => delete activeTeamSockets[key]);
  pushAll();
}

function openQuiz(socket) {
  if (!state.questions.length) return socket.emit("moderationError", "Bitte zuerst mindestens eine Frage anlegen.");
  if (!Object.keys(state.teams).length) return socket.emit("moderationError", "Bitte zuerst mindestens ein Team beitreten lassen.");
  state.quizStatus = "open";
  pushAll();
}

function closeQuiz(socket) {
  if (state.quizStatus !== "open") return socket.emit("moderationError", "Das Quiz ist aktuell nicht offen.");
  state.quizStatus = "closed";
  pushAll();
}

function releaseResults(socket) {
  if (!["closed", "released", "podium"].includes(state.quizStatus)) return socket.emit("moderationError", "Bitte das Quiz zuerst schließen.");
  if (state.quizStatus !== "podium") state.quizStatus = "released";
  pushAll();
}

function releasePodium(socket) {
  if (!["released", "podium"].includes(state.quizStatus)) return socket.emit("moderationError", "Bitte zuerst die Ergebnisse freigeben.");
  state.quizStatus = "podium";
  pushAll();
}

app.get("/healthz", (req, res) => res.type("text/plain").send("ok"));

app.get("/qr.svg", async (req, res) => {
  try {
    const svg = await QRCode.toString(baseUrl(req), {
      type: "svg",
      margin: 1,
      width: 380,
      color: { dark: "#1D1D1F", light: "#FFFFFF" }
    });
    res.type("image/svg+xml").send(svg);
  } catch (error) {
    res.status(500).send("QR-Code konnte nicht erzeugt werden.");
  }
});

app.get("/", (req, res) => res.send(participantHtml()));
app.get("/admin", (req, res) => res.send(adminHtml()));
app.get("/moderation", (req, res) => res.send(moderationHtml()));

io.on("connection", socket => {
  socket.on("participantJoin", data => {
    const label = cleanText(data && data.teamLabel, 80);
    const key = teamKey(label);
    if (!label || !key) return socket.emit("participantError", "Bitte gebt euren Teamnamen ein.");

    const knownTeam = !!state.teams[key];
    if (state.quizStatus !== "draft" && !knownTeam) {
      return socket.emit("participantError", "Das Quiz wurde bereits gestartet. Neue Teams können jetzt nicht mehr beitreten.");
    }

    activeTeamSockets[key] ||= new Set();
    activeTeamSockets[key].add(socket.id);
    state.teams[key] = {
      key,
      label: knownTeam ? state.teams[key].label : label,
      online: true,
      joinedAt: state.teams[key]?.joinedAt || now(),
      lastSeen: now()
    };
    socket.data.teamKey = key;
    socket.join("team:" + key);
    socket.emit("participantAccepted", { teamKey: key, teamLabel: state.teams[key].label });
    socket.emit("participantState", buildParticipantPayload(key));
    pushAll();
  });

  socket.on("submitAnswer", data => {
    const key = socket.data.teamKey;
    const qid = String(data && data.questionId || "");
    const q = state.questions.find(item => item.id === qid);
    if (!key || !state.teams[key]) return socket.emit("participantError", "Bitte tretet zuerst mit eurem Teamnamen bei.");
    if (state.quizStatus !== "open") return socket.emit("participantError", "Das Quiz ist aktuell nicht für Antworten geöffnet.");
    if (!q) return socket.emit("participantError", "Diese Frage wurde nicht gefunden.");
    state.answers[qid] ||= {};
    if (state.answers[qid][key]) {
      socket.emit("participantError", "Diese Frage wurde von euch bereits beantwortet.");
      return socket.emit("participantState", buildParticipantPayload(key));
    }
    const value = parseNumber(data && data.value);
    if (value === null) return socket.emit("participantError", "Bitte gebt eine gültige Zahl ein, z. B. 1500 oder 12,5.");
    state.answers[qid][key] = { value, at: now() };
    socket.emit("participantState", buildParticipantPayload(key));
    pushAll();
  });

  socket.on("adminAuth", data => {
    if (String(data && data.pin || "").trim() === ADMIN_PIN) {
      socket.data.isAdmin = true;
      socket.join("admins");
      socket.emit("adminAuthed");
      socket.emit("adminState", buildAdminPayload());
    } else socket.emit("adminError", "Falsche PIN.");
  });

  socket.on("moderationAuth", data => {
    if (String(data && data.key || "").trim() === MODERATION_KEY) {
      socket.data.isModerator = true;
      socket.join("moderation");
      socket.emit("moderationAuthed");
      socket.emit("moderationState", buildModerationPayload());
    } else socket.emit("moderationError", "Moderationsmodus konnte nicht freigeschaltet werden.");
  });

  socket.on("adminAddQuestion", data => { if (requireAdmin(socket)) addQuestion(data, socket); });
  socket.on("adminUpdateQuestion", data => { if (requireAdmin(socket)) updateQuestion(data, socket); });
  socket.on("adminRemoveQuestion", data => { if (requireAdmin(socket)) removeQuestion(data, socket); });
  socket.on("adminResetTeams", () => { if (requireAdmin(socket)) resetTeams(); });
  socket.on("modOpenQuiz", () => { if (requireModerator(socket)) openQuiz(socket); });
  socket.on("modCloseQuiz", () => { if (requireModerator(socket)) closeQuiz(socket); });
  socket.on("modReleaseResults", () => { if (requireModerator(socket)) releaseResults(socket); });
  socket.on("modReleasePodium", () => { if (requireModerator(socket)) releasePodium(socket); });

  socket.on("disconnect", () => {
    const key = socket.data.teamKey;
    if (key && state.teams[key]) {
      if (activeTeamSockets[key]) activeTeamSockets[key].delete(socket.id);
      state.teams[key].online = !!(activeTeamSockets[key] && activeTeamSockets[key].size);
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
  --bg:#F5F5F7;
  --paper:#FFFFFF;
  --ink:#1D1D1F;
  --muted:#6E6E73;
  --line:#D2D2D7;
  --blue:#0071E3;
  --blue-hover:#0077ED;
  --gray-button:#E8E8ED;
  --gray-button-hover:#DEDEE3;
  --green:#34C759;
  --green-dark:#248A3D;
  --red:#FF3B30;
  --shadow:0 18px 46px rgba(0,0,0,.055);
  --shadow-strong:0 22px 60px rgba(0,0,0,.10);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Segoe UI",sans-serif;line-height:1.45;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
h1,h2,h3,.podiumName{margin:0;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Segoe UI",sans-serif;letter-spacing:-.035em}
h1{font-size:clamp(40px,5.4vw,76px);line-height:1.02;font-weight:760;margin:18px 0 12px}
h2{font-size:28px;line-height:1.12;font-weight:720;margin-bottom:16px}
h3{font-size:18px;line-height:1.35;font-weight:650;margin-bottom:10px}
.wrap{max-width:1180px;margin:0 auto;padding:28px}.narrow{max-width:760px}.hero{padding:34px 0 24px}.sub{max-width:760px;margin-left:auto;margin-right:auto;color:var(--muted);font-size:18px;line-height:1.5}.muted{color:var(--muted)}.big{font-size:24px}.huge{font-size:48px;font-weight:900;line-height:1.05}.ok{color:var(--green-dark)}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--muted);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.brandDots{display:inline-flex;gap:4px;align-items:center}.brandDot{width:8px;height:8px;border-radius:50%;display:inline-block}.d1{background:#8E8E93}.d2{background:#AEAEB2}.d3{background:#C7C7CC}
.card,.panel,.item{background:var(--paper);border:1px solid rgba(210,210,215,.78);border-radius:26px;padding:28px;box-shadow:var(--shadow)}.item{border-radius:20px;background:#FBFBFD}.panel{padding:30px}.screen{min-height:54vh;display:grid;place-items:center;text-align:center}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.between{display:flex;justify-content:space-between;gap:12px;align-items:center}.hide{display:none!important}
input,textarea{width:100%;border:1px solid var(--line);background:#FFFFFF;border-radius:16px;padding:16px 17px;color:var(--ink);font:inherit;outline:none;transition:border-color .15s,box-shadow .15s,background .15s}input:focus,textarea:focus{border-color:var(--blue);box-shadow:0 0 0 4px rgba(0,113,227,.14)}input::placeholder,textarea::placeholder{color:#86868B}textarea{min-height:112px;resize:vertical}label{display:block;margin:18px 0 8px;color:var(--ink);font-size:14px;font-weight:650}
.btn{border:0;border-radius:999px;background:var(--blue);color:#FFFFFF;padding:12px 18px;font:inherit;font-size:14px;font-weight:650;cursor:pointer;box-shadow:none;transition:background .15s,transform .15s,opacity .15s}.btn:hover{background:var(--blue-hover);transform:translateY(-1px)}.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}.btn.alt,.btn.green{background:var(--blue)}.btn.alt:hover,.btn.green:hover{background:var(--blue-hover)}.btn.ghost{background:var(--gray-button);color:var(--ink)}.btn.ghost:hover{background:var(--gray-button-hover)}
.pill{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);background:#FFFFFF;color:var(--ink);border-radius:999px;padding:7px 11px;font-size:14px;font-weight:800}.status{background:var(--ink);color:#FFFFFF;border-color:var(--ink)}.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:5;display:none;background:var(--ink);color:#FFFFFF;padding:12px 16px;border-radius:999px;box-shadow:0 18px 46px rgba(0,0,0,.18)}.toast.show{display:block}
.table{width:100%;border-collapse:collapse;margin-top:18px}.table th,.table td{text-align:left;border-bottom:1px solid var(--line);padding:10px 8px;vertical-align:top}.table th{color:var(--muted);font-size:13px;text-transform:uppercase;letter-spacing:.04em}.teamChips{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}.teamChip{border:1px solid var(--line);background:#FFFFFF;border-radius:999px;padding:10px 12px}.qr,.qrLarge{background:#FFFFFF;border:1px solid var(--line);box-shadow:0 12px 30px rgba(0,0,0,.06)}.qr{width:220px;max-width:100%;border-radius:16px;padding:10px}.qrLarge{width:min(380px,70vw);border-radius:24px;padding:14px}
#game:not(.hide){min-height:calc(100dvh - 56px);display:grid;place-items:center}.statusStack .pill{margin-bottom:14px}.statusStack h2{margin-bottom:14px}.statusStack .sub{margin-top:0}.questionPanel{display:block;text-align:left;padding:32px;padding-bottom:92px;position:relative}@media(min-width:861px){body.playing .wrap.narrow{width:min(100% - 64px,1180px);max-width:1180px}body.playing #game{min-height:calc(100dvh - 56px)}body.playing #game>.card,body.playing #game>.panel{width:100%;min-height:min(78vh,820px)}body.playing .questionPanel{padding:64px 64px 112px;display:flex;flex-direction:column;justify-content:center}body.playing .questionPanel h2{font-size:clamp(42px,3.7vw,64px);line-height:1.14}body.playing .answerInput{min-height:72px;font-size:24px}body.playing .questionPanel .btn{font-size:18px;padding:16px 26px}body.playing .card.screen h2{font-size:clamp(44px,3.8vw,66px)}body.playing .card.screen .sub{font-size:25px}}.questionPanel .pill{background:var(--ink);color:#FFFFFF;border-color:var(--ink);align-self:flex-start}.questionPanel h2{margin-top:20px;margin-bottom:18px;line-height:1.25}.questionPanel .muted{margin-bottom:0}.guessLabel{margin-top:34px}.answerInput{min-height:56px;margin-top:0;margin-bottom:20px;font-size:18px;background:#FFFFFF}.answerHint{position:absolute;left:32px;right:32px;bottom:30px;margin:0;font-size:14px;line-height:1.45}#joinBtn{margin-top:16px}
.distRow{display:grid;grid-template-columns:190px 140px 1fr;gap:14px;align-items:center;margin:12px 0}.distValue{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.barTrack{height:30px;border:1px solid var(--line);border-radius:999px;background:var(--gray-button);overflow:hidden}.barFill{height:100%;min-width:18px;max-width:100%;border-radius:999px}.barFill.red{background:var(--red)}.barFill.green{background:var(--green)}.solutionRow{background:transparent;border-color:transparent}.solutionLabel{font-weight:900;color:var(--green-dark)}.answerCard{display:inline-flex;flex-direction:column;align-items:center;gap:6px;margin:28px auto 72px;padding:20px 34px;border:1px solid #B7E7C4;border-radius:22px;background:#F2FFF5}.answerCardLabel{font-size:14px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--green-dark)}.answerCardValue{font-size:clamp(34px,4vw,58px);line-height:1;font-weight:780;color:var(--ink)}
.podium{display:grid;grid-template-columns:1fr 1.18fr 1fr;gap:18px;align-items:end;margin-top:22px;width:100%}.podiumCard{border:1px solid var(--line);border-radius:22px;padding:30px;text-align:center;background:#FFFFFF;box-shadow:var(--shadow)}.podiumCard.first{min-height:310px;background:var(--ink);color:#FFFFFF}.podiumCard.first h2,.podiumCard.first .podiumName{color:#FFFFFF}.podiumCard.second{min-height:250px}.podiumCard.third{min-height:215px}.medal{font-size:70px;filter:saturate(.92)}.podiumName{font-size:clamp(32px,5vw,72px);font-weight:900;line-height:1}.reveal{display:grid;place-items:center;min-height:380px;text-align:center}.reveal .medal{font-size:120px}.reveal .podiumName{font-size:clamp(48px,8vw,110px);font-weight:780}
.displayWrap{width:100%;max-width:none;min-height:100vh;padding:32px clamp(28px,4vw,64px);display:flex;flex-direction:column}.displayWrap .hero{position:fixed;top:22px;left:24px;z-index:15;padding:0}.displayWrap .brand{font-size:13px}#display{width:100%;flex:1;display:grid;place-items:center;min-height:0}.displayCard{width:min(100%,1280px);min-height:calc(100vh - 150px);padding:clamp(42px,5vw,76px);padding-bottom:clamp(118px,11vh,160px);border-radius:30px;position:relative}.displayCard>div{width:min(1040px,100%);margin:0 auto;display:flex;flex-direction:column;align-items:center}.displayWrap h1{font-size:clamp(58px,7vw,108px);line-height:1.02;margin:0 0 24px}.displayWrap h2{font-size:clamp(34px,4vw,58px)}.displayWrap .sub{max-width:920px;font-size:clamp(21px,2vw,30px);margin-top:0;margin-bottom:30px}.displayWrap .huge{font-size:clamp(56px,6vw,92px);margin:18px 0 34px}.displayWrap .qrLarge{width:min(520px,58vw);border-radius:28px;padding:18px;margin:6px 0 30px}.displayWrap .teamChips{gap:14px;margin:8px 0 36px}.displayWrap .teamChip{font-size:22px;padding:14px 20px}.displayWrap .btn{font-size:20px;padding:17px 28px}.displayActions{position:absolute;left:50%;bottom:clamp(34px,4.5vh,58px);transform:translateX(-50%);justify-content:center;gap:16px;width:max-content;max-width:calc(100% - 48px)}.displayWrap .table{font-size:22px;margin-top:8px;margin-bottom:20px}.displayWrap .table th,.displayWrap .table td{padding:16px 12px}.displayWrap .distRow{grid-template-columns:240px 170px 1fr;gap:20px;font-size:22px;margin:18px 0}.displayWrap .barTrack{height:40px}.displayWrap .item{width:min(100%,980px);padding:34px;margin-top:12px}.resultCard{display:flex;align-items:center;justify-content:center;text-align:center}.resultContent{justify-content:center;padding-bottom:clamp(120px,12vh,170px)}.displayWrap .resultQuestion{max-width:1040px;margin-left:auto;margin-right:auto;margin-bottom:10px;font-size:clamp(40px,4.6vw,72px);line-height:1.12}.displayWrap .medal{font-size:92px}.displayWrap .reveal{min-height:520px}.displayWrap .reveal .medal{font-size:160px}.displayWrap .reveal .podiumName{font-size:clamp(72px,9vw,140px)}.displayWrap .podiumName{font-size:clamp(42px,5vw,82px)}.displayWrap .podium{gap:26px;margin-bottom:64px}.displayWrap .podiumCard{padding:40px 30px;border-radius:28px}.displayWrap .podiumCard.first{min-height:370px}.displayWrap .podiumCard.second{min-height:300px}.displayWrap .podiumCard.third{min-height:260px}
.fullscreenBtn{position:fixed;top:22px;right:24px;z-index:20;width:42px;height:42px;border:1px solid rgba(210,210,215,.8);border-radius:50%;background:rgba(255,255,255,.82);color:var(--ink);font-size:21px;font-weight:700;display:grid;place-items:center;cursor:pointer;box-shadow:0 10px 28px rgba(0,0,0,.08);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}.fullscreenBtn:hover{background:#FFFFFF}
.adminPage{background:var(--bg);color:var(--ink)}.adminPage .hero{padding:38px 0 30px}.adminPage .sub{margin-left:0;font-size:17px}.adminPage .card{border-radius:26px;padding:30px}.adminTopCard{display:flex;align-items:center;justify-content:space-between;gap:28px}.adminTopCard p{margin:0}.adminLayout{display:grid;grid-template-columns:minmax(340px,430px) 1fr;gap:30px;align-items:start;margin-top:30px}.adminActions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:26px}.adminQuestion{padding:22px 22px 20px;margin-top:22px;border-radius:20px;background:#FBFBFD}.adminQuestion:first-of-type{margin-top:0}.adminQuestion .row{margin-top:20px}.adminQuestion .btn.alt{background:#E8F2FF;color:#0066CC}.adminQuestion .btn.alt:hover{background:#DCEBFF}.adminResetCard{margin-top:22px;padding:22px}.adminResetCard h3{margin-bottom:8px}.adminResetCard .btn{margin-top:12px}.adminResetHint{max-width:340px;font-size:13px;margin-top:16px}
@media(max-width:860px){.wrap{padding:18px}h1{font-size:42px}.card,.panel,.item{padding:22px;border-radius:22px}.questionPanel{padding:24px}.questionPanel .btn{width:100%;justify-content:center}.podium,.distRow,.adminLayout{grid-template-columns:1fr}.distValue{text-align:left}.between,.adminTopCard{align-items:flex-start;flex-direction:column}.displayCard{min-height:auto;padding:26px}.displayWrap h1{font-size:44px}.displayWrap .qrLarge{width:min(360px,80vw)}.displayWrap .distRow{grid-template-columns:1fr}.displayWrap .btn{font-size:16px;padding:13px 18px}.adminPage .card{padding:24px}.adminPage h1{font-size:40px}}
</style>
</head>`;
}

function brand(label) {
  return `<div class="brand"><span class="brandDots"><span class="brandDot d1"></span><span class="brandDot d2"></span><span class="brandDot d3"></span></span><span>${label}</span></div>`;
}

function participantHtml() {
  return `${commonHead("Schätzquiz")}
<body>
<div class="wrap narrow">
  <section id="intro" class="hero">${brand("Schätzquiz")}<h1>Wer liegt am nächsten?</h1><p class="sub">Gebt euer zugeordnetes Tier ein und beantwortet die Schätzfragen in eurem Tempo.</p></section>
  <section id="join" class="card"><h2>Mitspielen</h2><label for="teamLabel">Teamname eingeben</label><input id="teamLabel" maxlength="80" autocomplete="off" placeholder="z. B. Löwe oder Giraffe"><button class="btn alt" id="joinBtn">Beitreten</button></section>
  <section id="game" class="hide"></section>
</div>
<div id="toast" class="toast"></div>
<script src="/socket.io/socket.io.js"></script>
<script>
var socket=io(),currentState=null,teamStorageKey="schaetzquizTeamLabel";
function qs(s){return document.querySelector(s)}function clear(n){while(n.firstChild)n.removeChild(n.firstChild)}function el(t,c,x){var n=document.createElement(t);if(c)n.className=c;if(x!=null)n.textContent=x;return n}function toast(m){var n=qs("#toast");n.textContent=m;n.classList.add("show");setTimeout(function(){n.classList.remove("show")},2600)}
function join(){var label=qs("#teamLabel").value.trim();if(!label){toast("Bitte Teamnamen eingeben.");return}localStorage.setItem(teamStorageKey,label);socket.emit("participantJoin",{teamLabel:label})}
function submitAnswer(){if(!currentState||!currentState.nextQuestion)return;var input=qs("#answerInput");socket.emit("submitAnswer",{questionId:currentState.nextQuestion.id,value:input?input.value:""})}
function showMain(){document.body.classList.add("playing");qs("#intro").classList.add("hide");qs("#join").classList.add("hide");qs("#game").classList.remove("hide")}
function renderMessage(title,text,label){var root=qs("#game");clear(root);var card=el("div","card screen"),inner=el("div","statusStack");inner.appendChild(el("div","pill status",label||"Hinweis"));inner.appendChild(el("h2","",title));inner.appendChild(el("p","sub",text));card.appendChild(inner);root.appendChild(card)}
function renderQuestion(s){var root=qs("#game");clear(root);var q=s.nextQuestion,card=el("div","panel questionPanel");card.appendChild(el("div","pill","Frage "+(q.index+1)+" von "+s.questionCount));card.appendChild(el("h2","",q.text));var input=el("input","answerInput");input.id="answerInput";input.inputMode="decimal";input.placeholder=q.unit?"Zahl in "+q.unit+" eingeben":"Zahl eingeben";input.setAttribute("aria-label","Schätzung eingeben");card.appendChild(input);var btn=el("button","btn alt","Antwort absenden");btn.onclick=submitAnswer;card.appendChild(btn);card.appendChild(el("p","muted answerHint","Nach dem Absenden kann eure Antwort nicht mehr geändert werden."));root.appendChild(card);setTimeout(function(){input.focus()},50);input.addEventListener("keydown",function(e){if(e.key==="Enter")submitAnswer()})}
function render(s){currentState=s;if(!s.team)return;showMain();if(s.quizStatus==="draft")return renderMessage("Das Quiz ist noch nicht geöffnet.","Bitte wartet auf die Moderation.","Wartebereich");if(s.quizStatus==="closed")return renderMessage("Das Quiz ist geschlossen.","Die Ergebnisse werden gleich freigegeben.","Geschlossen");if(s.quizStatus==="released")return renderMessage("Die Auflösung läuft vorne über die Moderation.","Bitte schaut auf die Leinwand. Die Platzierungen bleiben bis zur Siegerehrung verborgen.","Ergebnisse freigegeben");if(s.quizStatus==="podium")return renderMessage("Die Siegerehrung läuft vorne über die Moderation.","Bitte schaut auf die Leinwand. Die Gewinner werden Schritt für Schritt enthüllt.","Siegerehrung freigegeben");if(s.quizStatus==="open"&&s.nextQuestion)return renderQuestion(s);if(s.quizStatus==="open")return renderMessage("Danke, eure Antworten wurden gespeichert.","Die Ergebnisse werden später freigegeben.","Fertig")}
var storedTeam=localStorage.getItem(teamStorageKey);if(storedTeam)qs("#teamLabel").value=storedTeam;qs("#joinBtn").onclick=join;qs("#teamLabel").addEventListener("keydown",function(e){if(e.key==="Enter")join()});socket.on("participantAccepted",function(d){localStorage.setItem(teamStorageKey,d.teamLabel)});socket.on("participantError",toast);socket.on("participantState",render);
</script>
</body></html>`;
}

function clientJs() {
  return `<script src="/socket.io/socket.io.js"></script>
<script>
var socket=io(),state=null,editingQuestionId=null,resultIndex=0,podiumStep=0,displayView="auto";
function qs(s){return document.querySelector(s)}function clear(n){while(n.firstChild)n.removeChild(n.firstChild)}function el(t,c,x){var n=document.createElement(t);if(c)n.className=c;if(x!=null)n.textContent=x;return n}function fmt(v){return new Intl.NumberFormat("de-DE",{maximumFractionDigits:2}).format(v)}function toast(m){var n=qs("#toast");n.textContent=m;n.classList.add("show");setTimeout(function(){n.classList.remove("show")},2600)}
function table(headers,rows){var t=el("table","table"),thead=document.createElement("thead"),trh=document.createElement("tr");headers.forEach(function(h){trh.appendChild(el("th","",h))});thead.appendChild(trh);t.appendChild(thead);var tb=document.createElement("tbody");rows.forEach(function(r){var tr=document.createElement("tr");r.forEach(function(c){tr.appendChild(el("td","",c))});tb.appendChild(tr)});t.appendChild(tb);return t}
function teamProgress(t){if(!t.total)return"wartet auf Fragen";if(t.complete)return"fertig";return t.answered+" von "+t.total}
function inputBlock(label,id,type,placeholder,value){var w=el("div"),l=el("label","",label),i=type==="textarea"?document.createElement("textarea"):document.createElement("input");l.setAttribute("for",id);i.id=id;i.placeholder=placeholder||"";i.value=value||"";if(type!=="textarea")i.inputMode=id.toLowerCase().includes("answer")?"decimal":"text";w.appendChild(l);w.appendChild(i);return w}
function barChart(q){var wrap=el("div","item"),rows=q.distribution.map(function(r){return{type:"team",label:r.teamLabel,value:r.value,valueLabel:r.valueLabel,diff:r.diff}});rows.push({type:"solution",label:"Richtige Antwort",value:q.answer,valueLabel:q.answerLabel,diff:0});rows.sort(function(a,b){return a.value-b.value||(a.type==="solution"?-1:1)||a.label.localeCompare(b.label)});var max=Math.max.apply(null,rows.map(function(r){return Math.abs(r.value)}).concat([1]));rows.forEach(function(r){var line=el("div","distRow"+(r.type==="solution"?" solutionRow":""));line.appendChild(el("div",r.type==="solution"?"solutionLabel":"",r.label));line.appendChild(el("div","distValue",r.valueLabel+" "+(q.unit||"")));var track=el("div","barTrack"),fill=el("div","barFill "+(r.type==="solution"||r.diff===0?"green":"red"));fill.style.width=Math.max(6,Math.min(100,Math.abs(r.value)/max*100))+"%";track.appendChild(fill);line.appendChild(track);wrap.appendChild(line)});return wrap}
function podiumView(rows){var places=[rows.filter(function(r){return r.rank===2}),rows.filter(function(r){return r.rank===1}),rows.filter(function(r){return r.rank===3})],labels=[["🥈","Platz 2","second"],["🥇","Platz 1","first"],["🥉","Platz 3","third"]],podium=el("div","podium");labels.forEach(function(label,i){var card=el("div","podiumCard "+label[2]);card.appendChild(el("div","medal",label[0]));card.appendChild(el("h2","",label[1]));if(!places[i].length)card.appendChild(el("p","muted","Noch kein Team auf diesem Platz"));places[i].forEach(function(r){card.appendChild(el("div","podiumName",r.teamLabel));card.appendChild(el("p","big",r.score+" Punkte"))});podium.appendChild(card)});return podium}
function revealPlace(rank){var rows=state.podium.filter(function(r){return r.rank===rank}),box=el("div","reveal"),medal=rank===1?"🥇":rank===2?"🥈":"🥉";box.appendChild(el("div","medal",medal));box.appendChild(el("h2","","Team"));if(!rows.length)box.appendChild(el("p","sub","Noch kein Team auf diesem Platz"));rows.forEach(function(r){box.appendChild(el("div","podiumName",r.teamLabel));box.appendChild(el("p","big",r.score+" Punkte"))});return box}
function resultSlide(){if(!state.questionResults.length)return el("div","card","Noch keine Fragen vorhanden.");if(resultIndex<0)resultIndex=0;if(resultIndex>=state.questionResults.length)resultIndex=state.questionResults.length-1;var q=state.questionResults[resultIndex],card=el("div","card screen displayCard resultCard"),inner=el("div","resultContent");inner.style.width="100%";inner.appendChild(el("h1","resultQuestion",q.text));var answerCard=el("div","answerCard");answerCard.appendChild(el("div","answerCardLabel","Richtige Antwort"));answerCard.appendChild(el("div","answerCardValue",q.answerLabel+" "+(q.unit||"")));inner.appendChild(answerCard);inner.appendChild(barChart(q));var nav=el("div","row displayActions"),prev=el("button","btn ghost","Vorherige Frage");prev.disabled=resultIndex===0;prev.onclick=function(){resultIndex--;render()};nav.appendChild(prev);if(resultIndex<state.questionResults.length-1){var next=el("button","btn alt","Nächste Frage");next.onclick=function(){resultIndex++;render()};nav.appendChild(next)}else if(state.quizStatus==="released"){var rel=el("button","btn green","Siegerehrung freigeben");rel.onclick=function(){displayView="podium";podiumStep=0;socket.emit("modReleasePodium")};nav.appendChild(rel)}if(state.quizStatus==="podium"){var pod=el("button","btn green","Zur Siegerehrung");pod.onclick=function(){displayView="podium";render()};nav.appendChild(pod)}inner.appendChild(nav);card.appendChild(inner);return card}
function podiumSlide(){var card=el("div","card screen displayCard"),inner=el("div");inner.style.width="100%";var titles=["Jetzt kommt die Siegerehrung","Platz 3","Platz 2","Platz 1","Unsere Gewinnerteams"];inner.appendChild(el("h1","",titles[podiumStep]||titles[0]));if(podiumStep===0)inner.appendChild(el("p","sub","Gleich enthüllen wir die Top 3."));if(podiumStep===1)inner.appendChild(revealPlace(3));if(podiumStep===2)inner.appendChild(revealPlace(2));if(podiumStep===3)inner.appendChild(revealPlace(1));if(podiumStep>=4){inner.appendChild(podiumView(state.podium));inner.appendChild(table(["Platz","Team/Symbol","Punkte"],state.leaderboard.map(function(r){return["#"+r.rank,r.teamLabel,String(r.score)]})))}var nav=el("div","row displayActions");if(podiumStep>0){var back=el("button","btn ghost","Zurück");back.onclick=function(){podiumStep--;render()};nav.appendChild(back)}if(podiumStep<4){var next=el("button","btn alt","Weiter");next.onclick=function(){podiumStep++;render()};nav.appendChild(next)}else{var toResults=el("button","btn ghost","Zurück zur Auflösung");toResults.onclick=function(){displayView="results";render()};nav.appendChild(toResults)}inner.appendChild(nav);card.appendChild(inner);return card}
function renderDisplay(){var root=qs("#display");clear(root);if(state.quizStatus==="draft"){var c=el("div","card screen displayCard"),i=el("div");i.appendChild(el("h1","","Jetzt beitreten"));var img=document.createElement("img");img.className="qrLarge";img.src="/qr.svg";i.appendChild(img);i.appendChild(el("p","sub","Scannt den QR-Code und gebt euer Team-Symbol ein. Wartet, bis euer Team auf der Leinwand erscheint."));var chips=el("div","teamChips");state.teamProgress.forEach(function(t){chips.appendChild(el("div","teamChip",t.label))});i.appendChild(chips);var actions=el("div","row displayActions"),start=el("button","btn green","Quiz starten");start.onclick=function(){socket.emit("modOpenQuiz")};actions.appendChild(start);i.appendChild(actions);c.appendChild(i);root.appendChild(c);return}if(state.quizStatus==="open"){var open=el("div","card screen displayCard"),o=el("div"),done=state.teamProgress.filter(function(t){return t.complete}).length;o.appendChild(el("h1","","Das Quiz läuft"));o.appendChild(el("p","sub","Beantwortet alle Fragen auf eurem Handy."));o.appendChild(el("div","huge",done+" von "+state.teamProgress.length+" Teams fertig"));o.appendChild(table(["Team/Symbol","Status"],state.teamProgress.map(function(t){return[t.label,teamProgress(t)]})));var actions=el("div","row displayActions"),close=el("button","btn alt","Quiz schließen");close.onclick=function(){socket.emit("modCloseQuiz")};actions.appendChild(close);o.appendChild(actions);open.appendChild(o);root.appendChild(open);return}if(state.quizStatus==="closed"){var closed=el("div","card screen displayCard"),ci=el("div");ci.appendChild(el("h1","","Das Quiz ist geschlossen"));ci.appendChild(el("p","sub","Gleich beginnt die Auflösung."));var actions=el("div","row displayActions"),res=el("button","btn green","Auflösung starten");res.onclick=function(){resultIndex=0;displayView="results";socket.emit("modReleaseResults")};actions.appendChild(res);ci.appendChild(actions);closed.appendChild(ci);root.appendChild(closed);return}if(state.quizStatus==="released"||displayView==="results"){root.appendChild(resultSlide());return}root.appendChild(podiumSlide())}
function renderAdmin(){var root=qs("#adminContent");clear(root);var top=el("div","card adminTopCard");var topText=el("div");topText.appendChild(el("h2","","Moderationsmodus"));topText.appendChild(el("p","muted","Durchführung und Präsentation laufen im Moderationsmodus."));var open=el("button","btn green","Moderationsmodus öffnen");open.onclick=function(){window.open(state.moderationUrl,"_blank")};top.appendChild(topText);top.appendChild(open);root.appendChild(top);var layout=el("div","adminLayout");var form=el("div","card adminForm"),list=el("div","card adminList");form.appendChild(el("h2","","Neue Frage"));form.appendChild(inputBlock("Fragetext","qText","textarea","z. B. Wie viele Mitarbeitende hatte das Unternehmen im Jahr 2015?"));form.appendChild(inputBlock("Richtige Zahl","qAnswer","input","z. B. 735"));form.appendChild(inputBlock("Einheit optional","qUnit","input","z. B. Personen, €, Stück, km"));var actions=el("div","adminActions");var add=el("button","btn green","Frage hinzufügen");add.onclick=function(){socket.emit("adminAddQuestion",{text:qs("#qText").value,answer:qs("#qAnswer").value,unit:qs("#qUnit").value})};actions.appendChild(add);form.appendChild(actions);var left=el("div");left.appendChild(form);var resetCard=el("div","card adminResetCard");resetCard.appendChild(el("h3","","Testlauf zurücksetzen"));resetCard.appendChild(el("p","muted adminResetHint","Löscht Teams und Antworten. Eure Fragen bleiben erhalten."));var reset=el("button","btn ghost","Teams & Antworten zurücksetzen");reset.onclick=function(){if(confirm("Teams und Antworten zurücksetzen? Die Fragen bleiben erhalten."))socket.emit("adminResetTeams")};resetCard.appendChild(reset);left.appendChild(resetCard);layout.appendChild(left);list.appendChild(el("h2","","Fragen verwalten"));if(!state.questions.length)list.appendChild(el("p","muted","Noch keine Fragen angelegt."));else state.questions.forEach(function(q,i){list.appendChild(questionItem(q,i))});layout.appendChild(list);root.appendChild(layout)}
function questionItem(q,i){var item=el("div","item adminQuestion");if(editingQuestionId===q.id){item.appendChild(el("h3","","Frage "+(i+1)+" bearbeiten"));item.appendChild(inputBlock("Fragetext","editText"+q.id,"textarea","",q.text));item.appendChild(inputBlock("Richtige Zahl","editAnswer"+q.id,"input","",fmt(q.answer)));item.appendChild(inputBlock("Einheit","editUnit"+q.id,"input","",q.unit));var row=el("div","row"),save=el("button","btn green","Speichern"),cancel=el("button","btn ghost","Abbrechen");save.onclick=function(){socket.emit("adminUpdateQuestion",{id:q.id,text:qs("#editText"+q.id).value,answer:qs("#editAnswer"+q.id).value,unit:qs("#editUnit"+q.id).value});editingQuestionId=null};cancel.onclick=function(){editingQuestionId=null;renderAdmin()};row.appendChild(save);row.appendChild(cancel);item.appendChild(row);return item}item.appendChild(el("h3","",(i+1)+". "+q.text));item.appendChild(el("p","muted","Lösung: "+fmt(q.answer)+" "+(q.unit||"")));var row=el("div","row"),edit=el("button","btn alt","Bearbeiten"),del=el("button","btn ghost","Löschen");edit.onclick=function(){editingQuestionId=q.id;renderAdmin()};del.onclick=function(){if(confirm("Diese Frage wirklich löschen?"))socket.emit("adminRemoveQuestion",{id:q.id})};row.appendChild(edit);row.appendChild(del);item.appendChild(row);return item}
function render(){if(!state)return;if(qs("#display"))renderDisplay();if(qs("#adminContent"))renderAdmin()}
function toggleFullscreen(){if(!document.fullscreenElement){document.documentElement.requestFullscreen().catch(function(){toast("Vollbildmodus konnte nicht gestartet werden.")})}else{document.exitFullscreen()}}
function updateFullscreenButton(){var btn=qs("#fullscreenBtn");if(!btn)return;var active=!!document.fullscreenElement;btn.textContent=active?"×":"⛶";btn.title=active?"Vollbild beenden":"Vollbild starten"}
document.addEventListener("fullscreenchange",updateFullscreenButton);
</script>`;
}

function adminHtml() {
  return `${commonHead("Schätzquiz Admin")}
<body class="adminPage">
<div class="wrap">
  <section class="hero">${brand("Admin")}<h1>Backend verwalten</h1><p class="sub">Fragen vorbereiten und den Moderationsmodus öffnen.</p></section>
  <section id="login" class="card narrow"><h2>Admin-PIN</h2><input id="pin" type="password" placeholder="PIN eingeben"><div style="height:14px"></div><button class="btn alt" id="loginBtn">Einloggen</button><p class="muted">Standard-PIN ist 1234, falls in Render keine eigene PIN gesetzt wurde.</p></section>
  <main id="admin" class="hide"><div id="adminContent"></div></main>
</div>
<div id="toast" class="toast"></div>
${clientJs()}
<script>
qs("#loginBtn").onclick=function(){socket.emit("adminAuth",{pin:qs("#pin").value})};
qs("#pin").addEventListener("keydown",function(e){if(e.key==="Enter")socket.emit("adminAuth",{pin:qs("#pin").value})});
socket.on("adminAuthed",function(){qs("#login").classList.add("hide");qs("#admin").classList.remove("hide")});
socket.on("adminError",toast);socket.on("adminState",function(s){state=s;render()});
</script>
</body></html>`;
}

function moderationHtml() {
  return `${commonHead("Schätzquiz Moderation")}
<body>
<button id="fullscreenBtn" class="fullscreenBtn" title="Vollbild starten" onclick="toggleFullscreen()">⛶</button>
<div class="wrap displayWrap"><section class="hero">${brand("Moderation")}</section><main id="display"></main></div>
<div id="toast" class="toast"></div>
${clientJs()}
<script>
var key=new URLSearchParams(window.location.search).get("key")||"";
function showKeyForm(){var root=qs("#display"),card=el("div","card narrow"),input=document.createElement("input"),btn=el("button","btn alt","Moderationsmodus öffnen");card.appendChild(el("h2","","Moderationsschlüssel"));input.placeholder="Schlüssel eingeben";input.type="password";card.appendChild(input);var spacer=el("div");spacer.style.height="14px";card.appendChild(spacer);btn.onclick=function(){socket.emit("moderationAuth",{key:input.value})};card.appendChild(btn);root.appendChild(card)}
if(key)socket.emit("moderationAuth",{key:key});else showKeyForm();
socket.on("moderationAuthed",function(){});socket.on("moderationError",toast);socket.on("moderationState",function(s){state=s;render()});
</script>
</body></html>`;
}
