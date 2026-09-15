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
    unit: "Tassen",
    explanation: "Diese Testfrage könnt ihr vor der echten Runde löschen oder bearbeiten."
  },
  {
    id: "testfrage2",
    text: "Wie viele Mitarbeitende waren ungefähr bei der letzten Mitarbeiterversammlung dabei?",
    answer: 20,
    unit: "Personen",
    explanation: "Diese Testfrage dient nur zum schnellen Testen des Ablaufs."
  },
  {
    id: "testfrage3",
    text: "Wie viele Kilometer legt unser Team zusammen ungefähr pro Arbeitswoche zurück?",
    answer: 480,
    unit: "km",
    explanation: "Diese Testfrage ist ein Platzhalter und kann später gelöscht werden."
  }
];

const state = {
  quizStatus: "draft", // draft | open | closed | released | podium
  teams: {},
  questions: sampleQuestions.map(q => ({ ...q })),
  answers: Object.fromEntries(sampleQuestions.map(q => [q.id, {}]))
};

const activeTeamSockets = {};

function now() {
  return Date.now();
}

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function cleanText(value, max = 180) {
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

function countTeamAnswers(key) {
  return Object.keys(getTeamAnswers(key)).length;
}

function totalPossibleAnswers() {
  return Object.keys(state.teams).length * state.questions.length;
}

function totalGivenAnswers() {
  return state.questions.reduce((sum, q) => sum + Object.keys(state.answers[q.id] || {}).length, 0);
}

function questionStats() {
  return state.questions.map((q, index) => ({
    id: q.id,
    index,
    text: q.text,
    unit: q.unit,
    answerCount: Object.keys(state.answers[q.id] || {}).length
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
      return {
        teamKey: key,
        teamLabel: team.label,
        value: answer.value,
        valueLabel: fmt(answer.value),
        diff,
        diffLabel: fmt(diff),
        at: answer.at
      };
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
    explanation: q.explanation,
    answerCount: Object.keys(state.answers[q.id] || {}).length,
    distribution: getQuestionDistribution(q.id)
  }));
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
      avgDiff: Infinity,
      avgDiffLabel: "-"
    };
  });

  state.questions.forEach(q => {
    getQuestionRanking(q.id).forEach(row => {
      if (!map[row.teamKey]) {
        map[row.teamKey] = {
          teamKey: row.teamKey,
          teamLabel: row.teamLabel,
          score: 0,
          totalDiff: 0,
          answered: 0,
          avgDiff: Infinity,
          avgDiffLabel: "-"
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
    if (row.answered) {
      row.avgDiff = row.totalDiff / row.answered;
      row.avgDiffLabel = fmt(row.avgDiff);
    }
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
  const board = leaderboard();
  const origin = req ? baseUrl(req) : "/";
  return {
    quizStatus: state.quizStatus,
    adminPin: ADMIN_PIN,
    moderationUrl: origin + "moderation?key=" + encodeURIComponent(MODERATION_KEY),
    teams: Object.values(state.teams).sort((a, b) => a.label.localeCompare(b.label)),
    questions: state.questions,
    questionStats: questionStats(),
    teamProgress: teamProgress(),
    totalAnswers: totalGivenAnswers(),
    totalPossibleAnswers: totalPossibleAnswers(),
    questionResults: questionResults(),
    podium: board.filter(row => row.rank <= 3)
  };
}

function buildModerationPayload() {
  const board = leaderboard();
  return {
    quizStatus: state.quizStatus,
    teams: Object.values(state.teams).sort((a, b) => a.label.localeCompare(b.label)),
    questions: state.questions,
    questionStats: questionStats(),
    teamProgress: teamProgress(),
    totalAnswers: totalGivenAnswers(),
    totalPossibleAnswers: totalPossibleAnswers(),
    questionResults: questionResults(),
    podium: board.filter(row => row.rank <= 3)
  };
}

function buildParticipantPayload(key) {
  const answers = getTeamAnswers(key);
  const nextQuestion = state.questions.find(q => !answers[q.id]) || null;
  const board = leaderboard();
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
    } : null,
    podium: state.quizStatus === "podium" ? board.filter(row => row.rank <= 3) : []
  };
}

function pushAdmin() {
  io.to("admins").emit("adminState", buildAdminPayload());
}

function pushModeration() {
  io.to("moderation").emit("moderationState", buildModerationPayload());
}

function pushTeam(key) {
  io.to("team:" + key).emit("participantState", buildParticipantPayload(key));
}

function pushAll() {
  pushAdmin();
  pushModeration();
  Object.keys(state.teams).forEach(pushTeam);
}

function requireAdmin(socket) {
  if (!socket.data.isAdmin) socket.emit("adminError", "Bitte zuerst als Admin anmelden.");
  return !!socket.data.isAdmin;
}

function requireControl(socket) {
  const ok = socket.data.isAdmin || socket.data.isModerator;
  if (!ok) socket.emit("moderationError", "Bitte zuerst den Moderationsmodus freischalten.");
  return ok;
}

function addQuestion(data, socket) {
  if (state.quizStatus !== "draft") {
    socket.emit(socket.data.isAdmin ? "adminError" : "moderationError", "Fragen können nur geändert werden, solange das Quiz noch nicht geöffnet wurde.");
    return;
  }
  const text = cleanText(data && data.text, 240);
  const answer = parseNumber(data && data.answer);
  const unit = cleanText(data && data.unit, 40);
  const explanation = cleanText(data && data.explanation, 420);
  if (!text || answer === null) {
    socket.emit(socket.data.isAdmin ? "adminError" : "moderationError", "Bitte Fragetext und richtige Zahl eintragen.");
    return;
  }
  const q = { id: makeId(), text, answer, unit, explanation };
  state.questions.push(q);
  state.answers[q.id] = {};
  pushAll();
}

function updateQuestion(data, socket) {
  if (state.quizStatus !== "draft") {
    socket.emit("adminError", "Fragen können nur geändert werden, solange das Quiz noch nicht geöffnet wurde.");
    return;
  }
  const q = state.questions.find(item => item.id === String(data && data.id || ""));
  if (!q) {
    socket.emit("adminError", "Frage wurde nicht gefunden.");
    return;
  }
  const text = cleanText(data && data.text, 240);
  const answer = parseNumber(data && data.answer);
  const unit = cleanText(data && data.unit, 40);
  const explanation = cleanText(data && data.explanation, 420);
  if (!text || answer === null) {
    socket.emit("adminError", "Bitte Fragetext und gültige richtige Zahl eintragen.");
    return;
  }
  q.text = text;
  q.answer = answer;
  q.unit = unit;
  q.explanation = explanation;
  pushAll();
}

function removeQuestion(data, socket) {
  if (state.quizStatus !== "draft") {
    socket.emit("adminError", "Fragen können nur gelöscht werden, solange das Quiz noch nicht geöffnet wurde.");
    return;
  }
  const id = String(data && data.id || "");
  state.questions = state.questions.filter(q => q.id !== id);
  delete state.answers[id];
  pushAll();
}

function openQuiz(socket) {
  if (!state.questions.length) {
    socket.emit(socket.data.isAdmin ? "adminError" : "moderationError", "Bitte zuerst mindestens eine Frage anlegen.");
    return;
  }
  if (!Object.keys(state.teams).length) {
    socket.emit(socket.data.isAdmin ? "adminError" : "moderationError", "Bitte zuerst mindestens ein Team beitreten lassen.");
    return;
  }
  state.quizStatus = "open";
  pushAll();
}

function closeQuiz(socket) {
  if (state.quizStatus !== "open") {
    socket.emit(socket.data.isAdmin ? "adminError" : "moderationError", "Das Quiz ist aktuell nicht offen.");
    return;
  }
  state.quizStatus = "closed";
  pushAll();
}

function releaseResults(socket) {
  if (!["closed", "released", "podium"].includes(state.quizStatus)) {
    socket.emit(socket.data.isAdmin ? "adminError" : "moderationError", "Bitte das Quiz zuerst schließen.");
    return;
  }
  if (state.quizStatus !== "podium") state.quizStatus = "released";
  pushAll();
}

function releasePodium(socket) {
  if (!["released", "podium"].includes(state.quizStatus)) {
    socket.emit(socket.data.isAdmin ? "adminError" : "moderationError", "Bitte zuerst die Ergebnisse freigeben.");
    return;
  }
  state.quizStatus = "podium";
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

function resetAll() {
  state.teams = {};
  state.questions = [];
  state.answers = {};
  state.quizStatus = "draft";
  Object.keys(activeTeamSockets).forEach(key => delete activeTeamSockets[key]);
  pushAll();
}

app.get("/healthz", (req, res) => res.type("text/plain").send("ok"));

app.get("/qr.svg", async (req, res) => {
  try {
    const svg = await QRCode.toString(baseUrl(req), {
      type: "svg",
      margin: 1,
      width: 380,
      color: { dark: "#1F1A17", light: "#FFF8EA" }
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
    if (!label || !key) {
      socket.emit("participantError", "Bitte gebt euren Teamnamen oder euer Symbol ein.");
      return;
    }

    const knownTeam = !!state.teams[key];
    if (state.quizStatus !== "draft" && !knownTeam) {
      socket.emit("participantError", "Das Quiz wurde bereits gestartet. Neue Teams können jetzt nicht mehr beitreten.");
      return;
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

    if (!key || !state.teams[key]) {
      socket.emit("participantError", "Bitte tretet zuerst mit eurem Teamnamen oder Symbol bei.");
      return;
    }
    if (state.quizStatus !== "open") {
      socket.emit("participantError", "Das Quiz ist aktuell nicht für Antworten geöffnet.");
      return;
    }
    if (!q) {
      socket.emit("participantError", "Diese Frage wurde nicht gefunden.");
      return;
    }

    state.answers[qid] ||= {};
    if (state.answers[qid][key]) {
      socket.emit("participantError", "Diese Frage wurde von euch bereits beantwortet.");
      socket.emit("participantState", buildParticipantPayload(key));
      return;
    }

    const value = parseNumber(data && data.value);
    if (value === null) {
      socket.emit("participantError", "Bitte gebt eine gültige Zahl ein, z. B. 1500 oder 12,5.");
      return;
    }

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
    } else {
      socket.emit("adminError", "Falsche PIN.");
    }
  });

  socket.on("moderationAuth", data => {
    if (String(data && data.key || "").trim() === MODERATION_KEY) {
      socket.data.isModerator = true;
      socket.join("moderation");
      socket.emit("moderationAuthed");
      socket.emit("moderationState", buildModerationPayload());
    } else {
      socket.emit("moderationError", "Moderationsmodus konnte nicht freigeschaltet werden.");
    }
  });

  socket.on("adminAddQuestion", data => { if (requireAdmin(socket)) addQuestion(data, socket); });
  socket.on("adminUpdateQuestion", data => { if (requireAdmin(socket)) updateQuestion(data, socket); });
  socket.on("adminRemoveQuestion", data => { if (requireAdmin(socket)) removeQuestion(data, socket); });
  socket.on("adminOpenQuiz", () => { if (requireAdmin(socket)) openQuiz(socket); });
  socket.on("adminCloseQuiz", () => { if (requireAdmin(socket)) closeQuiz(socket); });
  socket.on("adminReleaseResults", () => { if (requireAdmin(socket)) releaseResults(socket); });
  socket.on("adminReleasePodium", () => { if (requireAdmin(socket)) releasePodium(socket); });
  socket.on("adminResetTeams", () => { if (requireAdmin(socket)) resetTeams(); });
  socket.on("adminResetAll", () => { if (requireAdmin(socket)) resetAll(); });

  socket.on("modOpenQuiz", () => { if (requireControl(socket)) openQuiz(socket); });
  socket.on("modCloseQuiz", () => { if (requireControl(socket)) closeQuiz(socket); });
  socket.on("modReleaseResults", () => { if (requireControl(socket)) releaseResults(socket); });
  socket.on("modReleasePodium", () => { if (requireControl(socket)) releasePodium(socket); });

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
:root{--bg:#FFF8EA;--paper:#FFFFFF;--ink:#1F1A17;--muted:#71665B;--line:#E9D9BD;--accent:#B7410E;--accent2:#0F6B5F;--warn:#B88716;--good:#167048;--bad:#A33A2A;--shadow:0 14px 40px rgba(60,39,18,.12)}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,#FFE9B5,transparent 34%),var(--bg);color:var(--ink);font-family:Arial,Helvetica,sans-serif;line-height:1.45}.wrap{max-width:1180px;margin:0 auto;padding:24px}.narrow{max-width:760px}.hero{padding:32px 0 18px}.brand{display:inline-flex;align-items:center;gap:10px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;color:var(--accent)}.brandDots{display:inline-flex;gap:4px;align-items:center}.brandDot{width:10px;height:10px;border-radius:50%;display:inline-block}.d1{background:var(--accent2)}.d2{background:var(--accent)}.d3{background:var(--warn)}h1{font-family:Georgia,serif;font-size:clamp(36px,6vw,72px);line-height:.94;margin:18px 0 10px;letter-spacing:-.05em}h2{font-family:Georgia,serif;font-size:30px;margin:0 0 16px;letter-spacing:-.03em}h3{margin:0 0 10px;font-size:19px}.sub{font-size:19px;color:var(--muted);max-width:760px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card{background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:20px;box-shadow:var(--shadow)}.panel{background:#231B16;color:#FFF8EA;border-radius:22px;padding:24px}.panel .muted{color:#E8D6BA}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.between{display:flex;justify-content:space-between;gap:12px;align-items:center}.muted{color:var(--muted)}.big{font-size:24px}.huge{font-size:48px;font-weight:900}.ok{color:var(--good)}.bad{color:var(--bad)}input,button,textarea{font:inherit}input,textarea{width:100%;border:1px solid var(--line);background:#FFFDF8;border-radius:12px;padding:13px 14px;color:var(--ink)}textarea{min-height:86px;resize:vertical}label{display:block;font-weight:700;margin:12px 0 6px}.btn{border:0;border-radius:999px;background:var(--ink);color:#fff;padding:12px 18px;font-weight:800;cursor:pointer;transition:.15s transform,.15s opacity}.btn:hover{transform:translateY(-1px)}.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}.btn.alt{background:var(--accent)}.btn.green{background:var(--accent2)}.btn.ghost{background:#F4E6CC;color:var(--ink)}.btn.danger{background:var(--bad)}.pill{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);background:#FFFDF8;border-radius:999px;padding:7px 11px;font-size:14px;font-weight:800}.status{background:#241A14;color:#FFF8EA;border-color:#241A14}.list{display:grid;gap:10px}.item{border:1px solid var(--line);background:#FFFDF8;border-radius:14px;padding:14px}.table{width:100%;border-collapse:collapse}.table th,.table td{text-align:left;border-bottom:1px solid var(--line);padding:10px 8px;vertical-align:top}.table th{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}.qr{width:220px;max-width:100%;background:#FFF8EA;border-radius:16px;padding:10px}.qrLarge{width:min(380px,70vw);background:#FFF8EA;border-radius:24px;padding:14px}.screen{min-height:54vh;display:grid;place-items:center;text-align:center}.answerBox{font-size:30px;text-align:center;font-weight:900}.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:#1F1A17;color:white;padding:12px 16px;border-radius:999px;box-shadow:var(--shadow);display:none;z-index:5}.toast.show{display:block}.hide{display:none!important}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 18px}.tab{border:1px solid var(--line);background:#FFFDF8;color:var(--ink);border-radius:999px;padding:10px 14px;font-weight:800;cursor:pointer}.tab.active{background:var(--ink);color:#fff;border-color:var(--ink)}.tabPage{display:none}.tabPage.active{display:block}.metric{font-size:32px;font-weight:900}.progressOuter{height:12px;border-radius:999px;background:#F0DFC1;overflow:hidden}.progressInner{height:100%;background:var(--accent2);width:0}.teamChips{display:flex;gap:8px;flex-wrap:wrap}.teamChip{border:1px solid var(--line);background:#FFFDF8;border-radius:14px;padding:10px 12px}.distRow{display:grid;grid-template-columns:190px 130px 1fr 145px;gap:12px;align-items:center;margin:12px 0}.distValue,.distDiff{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.barTrack{height:28px;border-radius:999px;background:#F0DFC1;position:relative;overflow:hidden;border:1px solid #E3CEAA}.barFill{height:100%;border-radius:999px;min-width:18px;max-width:100%;display:flex;align-items:center;justify-content:flex-end;padding-right:8px;color:#fff;font-size:12px;font-weight:900;white-space:nowrap}.barFill.red{background:#A33A2A}.barFill.green{background:#167048}.solutionRow{background:#F1FAF4;border-color:#B9DEC8}.solutionLabel{font-weight:900;color:var(--good)}.podium{display:grid;grid-template-columns:1fr 1.18fr 1fr;gap:18px;align-items:end;margin-top:22px;width:100%}.podiumCard{border:1px solid var(--line);border-radius:22px;padding:30px;text-align:center;background:#FFFDF8}.podiumCard.first{background:#231B16;color:#FFF8EA;min-height:310px}.podiumCard.second{min-height:250px}.podiumCard.third{min-height:215px}.medal{font-size:62px}.podiumName{font-family:Georgia,serif;font-size:clamp(28px,4vw,52px);font-weight:900;line-height:1}.small{font-size:14px}.displayWrap{max-width:1240px}.displayCard{min-height:68vh}.displayActions{justify-content:center;margin-top:22px}.adminOnlyNote{font-size:13px;color:var(--muted);margin-top:10px}@media(max-width:860px){.grid,.grid3,.grid4,.podium,.distRow{grid-template-columns:1fr}.wrap{padding:16px}h1{font-size:42px}.between{align-items:flex-start;flex-direction:column}.huge{font-size:34px}.tabs{overflow:auto;flex-wrap:nowrap;padding-bottom:4px}.tab{white-space:nowrap}.distValue,.distDiff{text-align:left}.displayCard{min-height:auto}}
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
  <section id="intro" class="hero">
    ${brand("Schätzquiz")}
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
var currentState = null;
var teamStorageKey = "schaetzquizTeamLabel";
function qs(s){return document.querySelector(s)}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild)}
function el(t,c,x){var n=document.createElement(t);if(c)n.className=c;if(x!=null)n.textContent=x;return n}
function toast(m){var n=qs("#toast");n.textContent=m;n.classList.add("show");setTimeout(function(){n.classList.remove("show")},2600)}
function join(){var label=qs("#teamLabel").value.trim();if(!label){toast("Bitte Teamnamen oder Symbol eingeben.");return}localStorage.setItem(teamStorageKey,label);socket.emit("participantJoin",{teamLabel:label})}
function submitAnswer(){if(!currentState||!currentState.nextQuestion)return;var input=qs("#answerInput");socket.emit("submitAnswer",{questionId:currentState.nextQuestion.id,value:input?input.value:""})}
function showMain(){qs("#intro").classList.add("hide");qs("#join").classList.add("hide");qs("#game").classList.remove("hide")}
function renderMessage(title,text,label){var root=qs("#game");clear(root);var card=el("div","card screen");var inner=el("div");inner.appendChild(el("div","pill status",label||"Hinweis"));inner.appendChild(el("h2","",title));inner.appendChild(el("p","sub",text));card.appendChild(inner);root.appendChild(card)}
function renderQuestion(s){var root=qs("#game");clear(root);var q=s.nextQuestion;var card=el("div","panel");card.appendChild(el("div","pill","Frage "+(q.index+1)+" von "+s.questionCount));card.appendChild(el("h2","",q.text));if(q.unit)card.appendChild(el("p","muted","Einheit: "+q.unit));var input=el("input","answerBox");input.id="answerInput";input.inputMode="decimal";input.placeholder="Eure Schätzung";card.appendChild(input);var spacer=el("div");spacer.style.height="14px";card.appendChild(spacer);var btn=el("button","btn alt","Antwort absenden");btn.onclick=submitAnswer;card.appendChild(btn);card.appendChild(el("p","muted","Nach dem Absenden geht es automatisch zur nächsten Frage."));root.appendChild(card);setTimeout(function(){input.focus()},50);input.addEventListener("keydown",function(e){if(e.key==="Enter")submitAnswer()})}
function podiumView(rows){var places=[rows.filter(function(r){return r.rank===2}),rows.filter(function(r){return r.rank===1}),rows.filter(function(r){return r.rank===3})];var labels=[["🥈","Platz 2","second"],["🥇","Platz 1","first"],["🥉","Platz 3","third"]];var podium=el("div","podium");labels.forEach(function(label,i){var card=el("div","podiumCard "+label[2]);card.appendChild(el("div","medal",label[0]));card.appendChild(el("h2","",label[1]));if(!places[i].length)card.appendChild(el("p","muted","-"));places[i].forEach(function(r){card.appendChild(el("div","podiumName",r.teamLabel));card.appendChild(el("p","big",r.score+" Punkte"))});podium.appendChild(card)});return podium}
function renderPodium(s){var root=qs("#game");clear(root);var card=el("div","card screen");var inner=el("div");inner.appendChild(el("div","pill status","Siegerehrung freigegeben"));inner.appendChild(el("h1","","Herzlichen Glückwunsch!"));inner.appendChild(el("p","sub","Die Top 3 wurden freigegeben."));inner.appendChild(podiumView(s.podium));card.appendChild(inner);root.appendChild(card)}
function render(s){currentState=s;if(!s.team)return;showMain();if(s.quizStatus==="draft")return renderMessage("Das Quiz ist noch nicht geöffnet.","Bitte wartet auf die Moderation.","Wartebereich");if(s.quizStatus==="closed")return renderMessage("Das Quiz ist geschlossen.","Die Ergebnisse werden gleich freigegeben.","Geschlossen");if(s.quizStatus==="released")return renderMessage("Die Auflösung läuft vorne über die Moderation.","Bitte schaut auf die Leinwand. Die Platzierungen bleiben bis zur Siegerehrung verborgen.","Ergebnisse freigegeben");if(s.quizStatus==="podium")return renderPodium(s);if(s.quizStatus==="open"&&s.nextQuestion)return renderQuestion(s);if(s.quizStatus==="open")return renderMessage("Danke, eure Antworten wurden gespeichert.","Die Ergebnisse werden später freigegeben.","Fertig")}
var storedTeam=localStorage.getItem(teamStorageKey);if(storedTeam)qs("#teamLabel").value=storedTeam;
qs("#joinBtn").onclick=join;qs("#teamLabel").addEventListener("keydown",function(e){if(e.key==="Enter")join()});
socket.on("participantAccepted",function(d){localStorage.setItem(teamStorageKey,d.teamLabel)});socket.on("participantError",toast);socket.on("participantState",render);
</script>
</body></html>`;
}

function sharedClientJs(mode) {
  return `<script src="/socket.io/socket.io.js"></script>
<script>
var socket=io(),state=null,currentTab="overview",editingQuestionId=null,resultIndex=0,pendingTab=null;
var tabs=[["overview","Übersicht"],["questions","Fragen"],["progress","Fortschritt"],["results","Ergebnisse"],["settings","Einstellungen"]];
function qs(s){return document.querySelector(s)}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild)}
function el(t,c,x){var n=document.createElement(t);if(c)n.className=c;if(x!=null)n.textContent=x;return n}
function fmt(v){return new Intl.NumberFormat("de-DE",{maximumFractionDigits:2}).format(v)}
function toast(m){var n=qs("#toast");n.textContent=m;n.classList.add("show");setTimeout(function(){n.classList.remove("show")},2600)}
function table(headers,rows){var t=el("table","table"),thead=document.createElement("thead"),trh=document.createElement("tr");headers.forEach(function(h){trh.appendChild(el("th","",h))});thead.appendChild(trh);t.appendChild(thead);var tb=document.createElement("tbody");rows.forEach(function(r){var tr=document.createElement("tr");r.forEach(function(c){tr.appendChild(el("td","",c))});tb.appendChild(tr)});t.appendChild(tb);return t}
function statusLabel(s){if(s==="open")return"Offen für Antworten";if(s==="closed")return"Geschlossen";if(s==="released")return"Ergebnisse freigegeben";if(s==="podium")return"Siegerehrung freigegeben";return"Noch nicht geöffnet"}
function teamStatus(t){return t.online?"verbunden":"nicht verbunden"}
function teamProgress(t){if(!t.total)return"wartet auf Fragen";if(state.quizStatus==="draft")return"bereit";if(t.complete)return"fertig";return t.answered+" von "+t.total}
function percent(){return state.totalPossibleAnswers?Math.round(state.totalAnswers/state.totalPossibleAnswers*100):0}
function completionText(){return state.totalAnswers+" von "+state.totalPossibleAnswers+" Antworten abgegeben"}
function metric(label,value){var c=el("div","card");c.appendChild(el("div","muted",label));c.appendChild(el("div","metric",value));return c}
function send(eventName,goTab){if(goTab)pendingTab=goTab;if(eventName==="adminReleaseResults"||eventName==="modReleaseResults")resultIndex=0;socket.emit(eventName)}
function action(text,cls,eventName,goTab,confirmText){var b=el("button","btn "+cls,text);b.onclick=function(){if(confirmText&&!confirm(confirmText))return;send(eventName,goTab)};return b}
function inputBlock(label,id,type,placeholder,value){var w=el("div"),l=el("label","",label),i=type==="textarea"?document.createElement("textarea"):document.createElement("input");l.setAttribute("for",id);i.id=id;i.placeholder=placeholder||"";i.value=value||"";if(type!=="textarea")i.inputMode=id.toLowerCase().includes("answer")?"decimal":"text";w.appendChild(l);w.appendChild(i);return w}
function buildTabs(){var root=qs("#tabs");if(!root)return;clear(root);tabs.forEach(function(tab){var b=el("button","tab"+(currentTab===tab[0]?" active":""),tab[1]);b.onclick=function(){currentTab=tab[0];render()};root.appendChild(b)});tabs.forEach(function(tab){var p=qs("#tab-"+tab[0]);if(p)p.className="tabPage"+(currentTab===tab[0]?" active":"")})}
function renderOverview(){var root=qs("#tab-overview");clear(root);var g=el("div","grid4");g.appendChild(metric("Quiz-Status",statusLabel(state.quizStatus)));g.appendChild(metric("Teams",String(state.teams.length)));g.appendChild(metric("Fragen",String(state.questions.length)));g.appendChild(metric("Fortschritt",percent()+"%"));root.appendChild(g);var c=el("div","card");c.style.marginTop="16px";c.appendChild(el("h2","","Backend-Aktionen"));var bar=el("div","progressOuter"),inner=el("div","progressInner");inner.style.width=percent()+"%";bar.appendChild(inner);c.appendChild(bar);c.appendChild(el("p","muted",completionText()));var r=el("div","row");r.appendChild(action("Quiz öffnen","green","adminOpenQuiz"));r.appendChild(action("Quiz schließen","ghost","adminCloseQuiz"));r.appendChild(action("Ergebnisse freigeben","alt","adminReleaseResults","results"));r.appendChild(action("Siegerehrung freigeben","alt","adminReleasePodium"));r.appendChild(action("Moderationsmodus öffnen","green","openModeration"));r.lastChild.onclick=function(){window.open(state.moderationUrl,"_blank")};c.appendChild(r);c.appendChild(el("p","adminOnlyNote","Die Beameransicht läuft künftig über den Moderationsmodus."));root.appendChild(c);var teams=el("div","card");teams.style.marginTop="16px";teams.appendChild(el("h2","","Beigetretene Teams/Symbole"));if(!state.teamProgress.length)teams.appendChild(el("p","muted","Noch keine Teams beigetreten."));else{var chips=el("div","teamChips");state.teamProgress.forEach(function(t){var chip=el("div","teamChip");chip.appendChild(el("b","",t.label));chip.appendChild(el("div","small",teamStatus(t)+" · "+teamProgress(t)));chips.appendChild(chip)});teams.appendChild(chips)}root.appendChild(teams)}
function renderQuestions(){var root=qs("#tab-questions");clear(root);var g=el("div","grid"),form=el("div","card"),list=el("div","card");form.appendChild(el("h2","","Neue Frage anlegen"));form.appendChild(inputBlock("Fragetext","qText","textarea","z. B. Wie viele Mitarbeitende hatte das Unternehmen im Jahr 2015?"));form.appendChild(inputBlock("Richtige Zahl","qAnswer","input","z. B. 735"));form.appendChild(inputBlock("Einheit optional","qUnit","input","z. B. Personen, €, Stück, km"));form.appendChild(inputBlock("Erklärung optional","qExplanation","textarea","z. B. 2015 lag die Zahl der Mitarbeitenden bei 735."));var add=el("button","btn green","Frage hinzufügen");add.onclick=function(){socket.emit("adminAddQuestion",{text:qs("#qText").value,answer:qs("#qAnswer").value,unit:qs("#qUnit").value,explanation:qs("#qExplanation").value})};form.appendChild(add);if(state.quizStatus!=="draft")form.appendChild(el("p","muted","Fragen können nur geändert werden, solange das Quiz noch nicht geöffnet wurde."));g.appendChild(form);list.appendChild(el("h2","","Fragenliste"));if(!state.questions.length)list.appendChild(el("p","muted","Noch keine Fragen angelegt."));else state.questions.forEach(function(q,i){list.appendChild(questionItem(q,i))});g.appendChild(list);root.appendChild(g)}
function questionItem(q,i){var item=el("div","item");if(editingQuestionId===q.id){item.appendChild(el("h3","","Frage "+(i+1)+" bearbeiten"));item.appendChild(inputBlock("Fragetext","editText"+q.id,"textarea","",q.text));item.appendChild(inputBlock("Richtige Zahl","editAnswer"+q.id,"input","",fmt(q.answer)));item.appendChild(inputBlock("Einheit","editUnit"+q.id,"input","",q.unit));item.appendChild(inputBlock("Erklärung","editExplanation"+q.id,"textarea","",q.explanation));var row=el("div","row"),save=el("button","btn green","Speichern"),cancel=el("button","btn ghost","Abbrechen");save.onclick=function(){socket.emit("adminUpdateQuestion",{id:q.id,text:qs("#editText"+q.id).value,answer:qs("#editAnswer"+q.id).value,unit:qs("#editUnit"+q.id).value,explanation:qs("#editExplanation"+q.id).value});editingQuestionId=null};cancel.onclick=function(){editingQuestionId=null;render()};row.appendChild(save);row.appendChild(cancel);item.appendChild(row);return item}item.appendChild(el("h3","",(i+1)+". "+q.text));item.appendChild(el("p","muted","Lösung: "+fmt(q.answer)+" "+(q.unit||"")));if(q.explanation)item.appendChild(el("p","muted",q.explanation));var r=el("div","row"),edit=el("button","btn alt","Bearbeiten"),del=el("button","btn ghost","Löschen");edit.onclick=function(){editingQuestionId=q.id;render()};del.onclick=function(){if(confirm("Diese Frage wirklich löschen?"))socket.emit("adminRemoveQuestion",{id:q.id})};r.appendChild(edit);r.appendChild(del);item.appendChild(r);return item}
function renderProgress(){var root=qs("#tab-progress");clear(root);var g=el("div","grid"),teams=el("div","card"),questions=el("div","card");teams.appendChild(el("h2","","Fortschritt je Team"));teams.appendChild(state.teamProgress.length?table(["Team/Symbol","Fortschritt","Status"],state.teamProgress.map(function(t){return[t.label,teamProgress(t),teamStatus(t)]})):el("p","muted","Noch keine Teams beigetreten."));g.appendChild(teams);questions.appendChild(el("h2","","Antwortanzahl je Frage"));questions.appendChild(state.questionStats.length?table(["Frage","Antworten"],state.questionStats.map(function(q){return[String(q.index+1),q.answerCount+" Antworten"]})):el("p","muted","Noch keine Fragen angelegt."));g.appendChild(questions);root.appendChild(g)}
function barChart(q){var wrap=el("div","item"),rows=q.distribution.map(function(r){return{type:"team",label:r.teamLabel,value:r.value,valueLabel:r.valueLabel,diff:r.diff,diffLabel:r.diffLabel}});rows.push({type:"solution",label:"Richtige Antwort",value:q.answer,valueLabel:q.answerLabel,diff:0,diffLabel:"0"});rows.sort(function(a,b){return a.value-b.value||(a.type==="solution"?-1:1)||a.label.localeCompare(b.label)});var max=Math.max.apply(null,rows.map(function(r){return Math.abs(r.value)}).concat([1]));wrap.appendChild(el("p","muted","Grün = richtige Antwort oder exakt richtige Schätzung · Rot = abweichende Schätzung · sortiert nach Schätzwert."));rows.forEach(function(r){var line=el("div","distRow"+(r.type==="solution"?" solutionRow":""));line.appendChild(el("div",r.type==="solution"?"solutionLabel":"",r.label));line.appendChild(el("div","distValue",r.valueLabel+" "+(q.unit||"")));var track=el("div","barTrack"),fill=el("div","barFill "+(r.type==="solution"||r.diff===0?"green":"red"));fill.style.width=Math.max(6,Math.min(100,Math.abs(r.value)/max*100))+"%";fill.textContent=r.type==="solution"?"Lösung":"";track.appendChild(fill);line.appendChild(track);line.appendChild(el("div","distDiff",r.type==="solution"?"Lösung":"Abstand: "+r.diffLabel+" "+(q.unit||"")));wrap.appendChild(line)});return wrap}
function renderResults(){var root=qs("#tab-results");clear(root);if(state.quizStatus!=="released"&&state.quizStatus!=="podium"){var c=el("div","card screen"),i=el("div");i.appendChild(el("div","pill status",statusLabel(state.quizStatus)));i.appendChild(el("h2","","Die Ergebnisse sind noch nicht freigegeben."));i.appendChild(el("p","sub","Im Ergebnisbereich erscheinen keine Punkte, Platzierungen oder Gewinner."));c.appendChild(i);root.appendChild(c);return}root.appendChild(resultSlide(false))}
function resultSlide(isDisplay){if(!state.questionResults.length)return el("div","card","Noch keine Fragen vorhanden.");if(resultIndex<0)resultIndex=0;if(resultIndex>=state.questionResults.length)resultIndex=state.questionResults.length-1;var q=state.questionResults[resultIndex],card=el("div","card screen"+(isDisplay?" displayCard":"")),inner=el("div");inner.style.width="100%";inner.appendChild(el("div","pill status","Auflösung · Frage "+(resultIndex+1)+" von "+state.questionResults.length));inner.appendChild(el("h1","",q.text));inner.appendChild(el("div","huge",q.answerLabel+" "+(q.unit||"")));if(q.explanation)inner.appendChild(el("p","sub",q.explanation));inner.appendChild(barChart(q));inner.appendChild(table(["Team/Symbol","Schätzung","Abstand"],q.distribution.map(function(r){return[r.teamLabel,r.valueLabel+" "+(q.unit||""),r.diffLabel+" "+(q.unit||"")]})));var nav=el("div","row displayActions"),prev=el("button","btn ghost","Vorherige Frage");prev.disabled=resultIndex===0;prev.onclick=function(){resultIndex--;render()};nav.appendChild(prev);if(resultIndex<state.questionResults.length-1){var next=el("button","btn alt","Nächste Frage");next.onclick=function(){resultIndex++;render()};nav.appendChild(next)}else if(state.quizStatus==="released"){nav.appendChild(action("Siegerehrung freigeben","green",isDisplay?"modReleasePodium":"adminReleasePodium","podium"))}if(state.quizStatus==="podium"){var pod=el("button","btn green","Zur Siegerehrung");pod.onclick=function(){currentTab="podium";render()};nav.appendChild(pod)}inner.appendChild(nav);card.appendChild(inner);return card}
function podiumView(rows){var places=[rows.filter(function(r){return r.rank===2}),rows.filter(function(r){return r.rank===1}),rows.filter(function(r){return r.rank===3})];var labels=[["🥈","Platz 2","second"],["🥇","Platz 1","first"],["🥉","Platz 3","third"]];var podium=el("div","podium");labels.forEach(function(label,i){var card=el("div","podiumCard "+label[2]);card.appendChild(el("div","medal",label[0]));card.appendChild(el("h2","",label[1]));if(!places[i].length)card.appendChild(el("p","muted","-"));places[i].forEach(function(r){card.appendChild(el("div","podiumName",r.teamLabel));card.appendChild(el("p","big",r.score+" Punkte"))});podium.appendChild(card)});return podium}
function renderPodiumPage(root){clear(root);if(state.quizStatus!=="podium"){var w=el("div","card screen"),i=el("div");i.appendChild(el("div","pill status","Siegerehrung"));i.appendChild(el("h2","","Die Siegerehrung wurde noch nicht freigegeben."));i.appendChild(el("p","sub","Nach der Freigabe erscheinen hier ausschließlich die Top 3."));w.appendChild(i);root.appendChild(w);return}var c=el("div","card screen"),i2=el("div");i2.appendChild(el("div","pill status","Siegerehrung"));i2.appendChild(el("h1","","Herzlichen Glückwunsch!"));i2.appendChild(el("p","sub","Unsere Gewinnerteams"));i2.appendChild(podiumView(state.podium));c.appendChild(i2);root.appendChild(c)}
function renderSettings(){var root=qs("#tab-settings");clear(root);var c=el("div","card");c.appendChild(el("h2","","Einstellungen & Zurücksetzen"));c.appendChild(el("p","muted","Aktuelle Admin-PIN: "+state.adminPin));c.appendChild(el("p","muted","Die Daten werden nur im Arbeitsspeicher gespeichert. Bei einem Neustart des Servers können Daten verloren gehen."));var r=el("div","row");r.appendChild(action("Nur Teams & Antworten zurücksetzen","ghost","adminResetTeams",null,"Teams, Antworten und Fortschritt löschen, aber Fragen behalten?"));r.appendChild(action("Alles zurücksetzen","danger","adminResetAll",null,"Wirklich alles löschen, inklusive Fragen?"));c.appendChild(r);root.appendChild(c)}
function renderAdmin(){buildTabs();renderOverview();renderQuestions();renderProgress();renderResults();renderSettings()}
function renderDisplay(){var root=qs("#display");clear(root);if(state.quizStatus==="draft"){var c=el("div","card screen displayCard"),i=el("div");i.appendChild(el("h1","","Jetzt beitreten"));var img=document.createElement("img");img.className="qrLarge";img.src="/qr.svg";i.appendChild(img);i.appendChild(el("p","sub","Scannt den QR-Code und gebt euer Team-Symbol ein. Wartet, bis euer Team auf der Leinwand erscheint."));var chips=el("div","teamChips");state.teamProgress.forEach(function(t){chips.appendChild(el("div","teamChip",t.label))});i.appendChild(chips);i.appendChild(action("Quiz starten","green","modOpenQuiz"));c.appendChild(i);root.appendChild(c);return}if(state.quizStatus==="open"){var open=el("div","card screen displayCard"),o=el("div");var done=state.teamProgress.filter(function(t){return t.complete}).length;o.appendChild(el("h1","","Das Quiz läuft"));o.appendChild(el("p","sub","Beantwortet alle Fragen auf eurem Handy."));o.appendChild(el("div","huge",done+" von "+state.teamProgress.length+" Teams fertig"));o.appendChild(table(["Team/Symbol","Status"],state.teamProgress.map(function(t){return[t.label,teamProgress(t)]})));o.appendChild(action("Quiz schließen","alt","modCloseQuiz"));open.appendChild(o);root.appendChild(open);return}if(state.quizStatus==="closed"){var closed=el("div","card screen displayCard"),ci=el("div");ci.appendChild(el("h1","","Das Quiz ist geschlossen"));ci.appendChild(el("p","sub","Gleich beginnt die Auflösung."));ci.appendChild(action("Auflösung starten","green","modReleaseResults","results"));closed.appendChild(ci);root.appendChild(closed);return}if(state.quizStatus==="released"){root.appendChild(resultSlide(true));return}renderPodiumPage(root)}
function render(){if(!state)return;if(qs("#tabs"))renderAdmin();if(qs("#display"))renderDisplay();var p=qs("#tab-podium");if(p)renderPodiumPage(p)}
</script>`;
}

function adminHtml() {
  return `${commonHead("Schätzquiz Admin")}
<body>
<div class="wrap">
  <section class="hero between"><div>${brand("Admin")}
    <h1>Backend verwalten</h1><p class="sub">Fragen vorbereiten, Teams prüfen, Einstellungen verwalten und den Moderationsmodus öffnen.</p></div>
    <div class="card" style="text-align:center"><img class="qr" src="/qr.svg" alt="QR-Code"><div class="muted">QR-Code für Teams</div></div>
  </section>
  <section id="login" class="card narrow"><h2>Admin-PIN</h2><input id="pin" type="password" placeholder="PIN eingeben"><div style="height:14px"></div><button class="btn alt" id="loginBtn">Einloggen</button><p class="muted">Standard-PIN ist 1234, falls in Render keine eigene PIN gesetzt wurde.</p></section>
  <main id="admin" class="hide"><nav class="tabs" id="tabs"></nav><section id="tab-overview" class="tabPage active"></section><section id="tab-questions" class="tabPage"></section><section id="tab-progress" class="tabPage"></section><section id="tab-results" class="tabPage"></section><section id="tab-settings" class="tabPage"></section></main>
</div>
<div id="toast" class="toast"></div>
${sharedClientJs("admin")}
<script>
qs("#loginBtn").onclick=function(){socket.emit("adminAuth",{pin:qs("#pin").value})};
qs("#pin").addEventListener("keydown",function(e){if(e.key==="Enter")socket.emit("adminAuth",{pin:qs("#pin").value})});
socket.on("adminAuthed",function(){qs("#login").classList.add("hide");qs("#admin").classList.remove("hide")});
socket.on("adminError",toast);socket.on("adminState",function(s){state=s;if(pendingTab){currentTab=pendingTab;pendingTab=null}render()});
</script>
</body></html>`;
}

function moderationHtml() {
  return `${commonHead("Schätzquiz Moderation")}
<body>
<div class="wrap displayWrap">
  <section class="hero"><div>${brand("Moderation")}</div></section>
  <main id="display"></main>
</div>
<div id="toast" class="toast"></div>
${sharedClientJs("moderation")}
<script>
var key=new URLSearchParams(window.location.search).get("key")||"";
if(!key){var root=qs("#display");var c=el("div","card narrow"),i=document.createElement("input"),b=el("button","btn alt","Moderationsmodus öffnen");c.appendChild(el("h2","","Moderationsschlüssel"));i.placeholder="Schlüssel eingeben";i.type="password";c.appendChild(i);c.appendChild(el("div","",""));b.onclick=function(){socket.emit("moderationAuth",{key:i.value})};c.appendChild(b);root.appendChild(c)}else socket.emit("moderationAuth",{key:key});
socket.on("moderationAuthed",function(){});socket.on("moderationError",toast);socket.on("moderationState",function(s){state=s;if(pendingTab){currentTab=pendingTab;pendingTab=null}render()});
</script>
</body></html>`;
}
