"use strict";
/* =============================================================================
   Žebříček napříč všemi hrami.
   Trvalé uložení: soubor zebricek.json ve větvi `zebricek` GitHub repozitáře
   (nastav na Renderu proměnnou GITHUB_TOKEN – fine-grained token s právem
   Contents: Read and write jen pro tento repozitář).
   Bez tokenu se statistiky drží jen v paměti serveru (smažou se při restartu).
   ============================================================================= */
const TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.GITHUB_REPO || "w-bot-vv/bulanci";
const BRANCH = process.env.GITHUB_BRANCH || "zebricek";
const FILE = "zebricek.json";
const API = "https://api.github.com/repos/" + REPO;

let data = { players: {} };   // key -> {name, face, games, wins, rounds, kills, deaths, hits, last}
let sha = null, loaded = false, dirty = false, saving = false, lastError = "";

async function gh(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github+json", "User-Agent": "bulanci-online", ...(opts.headers || {}) },
  });
  if (!r.ok && r.status !== 404) throw new Error("GitHub " + r.status + " " + (await r.text()).slice(0, 200));
  return r.status === 404 ? null : r.json();
}

async function ensureBranch() {
  if (await gh("/git/ref/heads/" + BRANCH)) return;
  const main = await gh("/git/ref/heads/main");
  if (!main) throw new Error("větev main nenalezena");
  await gh("/git/refs", { method: "POST", body: JSON.stringify({ ref: "refs/heads/" + BRANCH, sha: main.object.sha }) });
}

async function load() {
  if (!TOKEN) { loaded = true; return; }
  try {
    await ensureBranch();
    const f = await gh("/contents/" + FILE + "?ref=" + encodeURIComponent(BRANCH));
    if (f) {
      sha = f.sha;
      const parsed = JSON.parse(Buffer.from(f.content, "base64").toString("utf8"));
      if (parsed && typeof parsed.players === "object") {
        // sloučit s tím, co se mezitím nahrálo do paměti
        for (const [k, v] of Object.entries(data.players)) merge(parsed.players, k, v);
        data = parsed;
      }
    }
    lastError = "";
  } catch (e) { lastError = e.message; console.log("Žebříček: načtení selhalo –", e.message); }
  loaded = true;
}

function merge(target, key, add) {
  const t = target[key] || (target[key] = { name: add.name, face: add.face || "", games: 0, wins: 0, rounds: 0, kills: 0, deaths: 0, hits: 0 });
  for (const f of ["games", "wins", "rounds", "kills", "deaths", "hits"]) t[f] = (t[f] | 0) + (add[f] | 0);
  t.name = add.name || t.name; t.face = add.face || t.face || ""; t.last = add.last || t.last;
}

async function save() {
  if (!TOKEN || saving || !dirty) return;
  saving = true; dirty = false;
  try {
    const body = { message: "Žebříček: výsledky zápasu", branch: BRANCH,
      content: Buffer.from(JSON.stringify(data, null, 1)).toString("base64") };
    if (sha) body.sha = sha;
    const r = await fetch(API + "/contents/" + FILE, {
      method: "PUT", body: JSON.stringify(body),
      headers: { Authorization: "Bearer " + TOKEN, Accept: "application/vnd.github+json", "User-Agent": "bulanci-online" },
    });
    if (r.status === 409 || r.status === 422) { sha = null; dirty = true; await load(); }   // nesedí verze → načíst a zkusit znovu
    else if (!r.ok) throw new Error("GitHub " + r.status + " " + (await r.text()).slice(0, 200));
    else { sha = (await r.json()).content.sha; lastError = ""; }
  } catch (e) { dirty = true; lastError = e.message; console.log("Žebříček: uložení selhalo –", e.message); }
  saving = false;
}
setInterval(save, 20000);   // ukládá se dávkově, nejvýš jednou za 20 s

/** Zapíše výsledky jednoho dohraného zápasu. rows: [{key,name,face,win,rounds,kills,deaths,hits}] */
function recordMatch(rows) {
  const now = new Date().toISOString();
  for (const r of rows) merge(data.players, r.key, { name: r.name, face: r.face, games: 1, wins: r.win ? 1 : 0,
    rounds: r.rounds, kills: r.kills, deaths: r.deaths, hits: r.hits, last: now });
  dirty = true;
  setTimeout(save, 1500);
}

function top(n = 50) {
  return Object.values(data.players)
    .sort((a, b) => b.wins - a.wins || b.kills - a.kills || b.hits - a.hits)
    .slice(0, n)
    .map((p) => ({ name: p.name, face: p.face, games: p.games, wins: p.wins, rounds: p.rounds, kills: p.kills, deaths: p.deaths, hits: p.hits }));
}

function status() { return { persistent: !!TOKEN && !lastError, ok: !lastError, loaded }; }

load();
module.exports = { recordMatch, top, status };
