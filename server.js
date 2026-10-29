"use strict";
/* =============================================================================
   BULÁNCI ONLINE – autoritativní server
   - servíruje klienta z ./public
   - drží WebSocket, simuluje hru na 30 Hz a rozesílá stav
   - až 20 hráčů (MAX), volitelní boti pro doplnění
   Konfigurace přes proměnné prostředí:
     PORT    (default 3000)          – nastaví hosting sám (Render apod.)
     ROUNDS  (default 5)             – kol do výhry zápasu
     BOTS    (default 4)             – doplnit boty do tolika bojovníků (0 = vypnuto)
   ============================================================================= */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const ROUNDS_TO_WIN = parseInt(process.env.ROUNDS || "5", 10); // výchozí počet výher do konce zápasu (hostitel může změnit)
const ROUND_CHOICES = [3, 5, 7, 10];
const ROUND_TICKS = parseInt(process.env.ROUND_SECONDS || "90", 10) * 30; // pojistka: kolo nejdéle 90 s, pak remíza
const PUBLIC = path.join(__dirname, "public");

/* ---------- statické soubory ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json",
};
// Servírujeme jen soubory, které ve složce public existují při startu (whitelist).
// URL se nikdy nepřevádí na cestu na disku, takže nejde o path traversal ani pád na poškozené URL.
const STATIC = new Map();
(function load(dir, prefix) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) load(full, prefix + e.name + "/");
    else if (e.isFile()) STATIC.set(prefix + e.name, { data: fs.readFileSync(full), type: MIME[path.extname(e.name)] || "application/octet-stream" });
  }
})(PUBLIC, "/");
// CSP: povolený je jen náš vlastní inline skript (podle hashe) – vložené HTML s onerror/onload se nespustí
const inlineScripts = [...(STATIC.get("/index.html")?.data.toString("utf8") || "").matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => `'sha256-${crypto.createHash("sha256").update(m[1], "utf8").digest("base64")}'`);
const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'", `script-src ${inlineScripts.join(" ") || "'none'"}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
    "img-src 'self' data:", "connect-src 'self' ws: wss:", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};
const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); return res.end(); }
  let url = (req.url || "/").split("?")[0];
  if (url === "/") url = "/index.html";
  const f = STATIC.get(url);
  if (!f) { res.writeHead(404, SECURITY_HEADERS); return res.end("not found"); }
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": f.type, "Cache-Control": "no-cache" });
  res.end(req.method === "HEAD" ? undefined : f.data);
});
server.on("clientError", (err, socket) => { try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch {} });

/* ============================ HERNÍ KONSTANTY ============================ */
const W = 1000, H = 640, BR = 17, WALL = 22, SPEED = 2.7, MAX = 20, TICK = 1000 / 30;

/* ---------- mapy: každé kolo jiná (5 map) ---------- */
const BORDER = [
  { x: 0, y: 0, w: W, h: WALL }, { x: 0, y: H - WALL, w: W, h: WALL },
  { x: 0, y: 0, w: WALL, h: H }, { x: W - WALL, y: 0, w: WALL, h: H },
];
const MAPS = [
  { name: "Pevnost", walls: [
    { x: 150, y: 120, w: 120, h: 34 }, { x: W - 270, y: 120, w: 120, h: 34 },
    { x: 150, y: H - 154, w: 120, h: 34 }, { x: W - 270, y: H - 154, w: 120, h: 34 },
    { x: 150, y: 154, w: 34, h: 120 }, { x: W - 184, y: 154, w: 34, h: 120 },
    { x: 150, y: H - 274, w: 34, h: 120 }, { x: W - 184, y: H - 274, w: 34, h: 120 },
    { x: W / 2 - 110, y: H / 2 - 18, w: 220, h: 36 },
    { x: W / 2 - 18, y: H / 2 - 130, w: 36, h: 90 },
    { x: W / 2 - 18, y: H / 2 + 40, w: 36, h: 90 },
    { x: W / 2 - 200, y: 90, w: 34, h: 130 }, { x: W / 2 + 166, y: 90, w: 34, h: 130 },
    { x: W / 2 - 200, y: H - 220, w: 34, h: 130 }, { x: W / 2 + 166, y: H - 220, w: 34, h: 130 },
  ] },
  { name: "Sloupy", walls: [200, 400, 600, 800].flatMap((cx) =>
    [170, 320, 470].map((cy) => ({ x: cx - 28, y: cy - 28, w: 56, h: 56 }))) },
  { name: "Kříž", walls: [
    { x: 140, y: 302, w: 280, h: 36 }, { x: 580, y: 302, w: 280, h: 36 },
    { x: 482, y: 80, w: 36, h: 170 }, { x: 482, y: 390, w: 36, h: 170 },
    { x: 90, y: 90, w: 120, h: 30 }, { x: 90, y: 120, w: 30, h: 90 },
    { x: 790, y: 90, w: 120, h: 30 }, { x: 880, y: 120, w: 30, h: 90 },
    { x: 90, y: 520, w: 120, h: 30 }, { x: 90, y: 430, w: 30, h: 90 },
    { x: 790, y: 520, w: 120, h: 30 }, { x: 880, y: 430, w: 30, h: 90 },
  ] },
  { name: "Bludiště", walls: [
    { x: 120, y: 110, w: 300, h: 30 }, { x: 580, y: 110, w: 300, h: 30 },
    { x: 120, y: 500, w: 300, h: 30 }, { x: 580, y: 500, w: 300, h: 30 },
    { x: 250, y: 220, w: 30, h: 200 }, { x: 720, y: 220, w: 30, h: 200 },
    { x: 380, y: 300, w: 240, h: 30 },
    { x: 485, y: 190, w: 30, h: 60 }, { x: 485, y: 380, w: 30, h: 60 },
    { x: 100, y: 300, w: 80, h: 30 }, { x: 820, y: 300, w: 80, h: 30 },
  ] },
  { name: "Aréna", walls: [
    { x: 420, y: 120, w: 160, h: 30 }, { x: 420, y: 490, w: 160, h: 30 },
    { x: 270, y: 250, w: 30, h: 140 }, { x: 700, y: 250, w: 30, h: 140 },
    { x: 320, y: 160, w: 44, h: 44 }, { x: 636, y: 160, w: 44, h: 44 },
    { x: 320, y: 436, w: 44, h: 44 }, { x: 636, y: 436, w: 44, h: 44 },
    { x: 90, y: 80, w: 70, h: 70 }, { x: 840, y: 80, w: 70, h: 70 },
    { x: 90, y: 490, w: 70, h: 70 }, { x: 840, y: 490, w: 70, h: 70 },
    { x: 480, y: 300, w: 40, h: 40 },
  ] },
].map((m) => ({ name: m.name, walls: [...BORDER, ...m.walls] }));

// zdi aktuálně simulované místnosti (simulace je synchronní, místnosti se střídají)
let walls = MAPS[0].walls;
function useRoom(room) { walls = room.walls; }
function nextMap(room) {
  // projde všech 5 map v náhodném pořadí, pak zamíchá znovu; nikdy dvakrát stejná za sebou
  if (!room.mapQueue || room.mapQueue.length === 0) {
    const q = MAPS.map((_, i) => i);
    for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; }
    if (q[0] === room.mapIdx) q.push(q.shift());
    room.mapQueue = q;
  }
  room.mapIdx = room.mapQueue.shift();
  room.walls = MAPS[room.mapIdx].walls;
  useRoom(room);
  room.spawns = genSpawns();
}

const WEAPONS = {
  pistol:  { name: "Pistole",    dmg: 24, speed: 9.5, cd: 24, spread: 0,    count: 1, r: 4.5, life: 80,  ammo: Infinity },
  mg:      { name: "Samopal",    dmg: 11, speed: 12,  cd: 6,  spread: 0.10, count: 1, r: 4,   life: 70,  ammo: 60 },
  shotgun: { name: "Brokovnice", dmg: 13, speed: 9.5, cd: 40, spread: 0.30, count: 6, r: 4,   life: 50,  ammo: 10 },
  rocket:  { name: "Raketomet",  dmg: 55, speed: 6.2, cd: 64, spread: 0,    count: 1, r: 7.5, life: 120, ammo: 5, explode: true, radius: 78, splash: 42 },
  mines:   { name: "Miny",       cd: 20, ammo: 3, mine: true },
};
const WEAPON_IDX = { pistol: 0, mg: 1, shotgun: 2, rocket: 3, mines: 4 };
const IDX_WEAPON = ["pistol", "mg", "shotgun", "rocket", "mines"];
// bonusy z beden (zbraně + vylepšení); váhy = jak často padají
const DROPS = ["mg", "mg", "shotgun", "shotgun", "rocket", "mines", "health", "health", "shield", "turbo"];
const SHIELD_TICKS = 180, TURBO_TICKS = 210, TURBO = 1.5;            // 6 s štít, 7 s turbo (×1,5 rychlost)
const MINE = { arm: 30, life: 900, trigger: 30, radius: 88, dmg: 80, max: 24, perPlayer: 3 };
const MAX_PICKUPS = 6;

function palette(n) {
  const a = [];
  for (let i = 0; i < n; i++) a.push(`hsl(${Math.round((i * 360) / n)} 74% 58%)`);
  return a;
}
const COLORS = palette(MAX);

/* ---------- pomocné ---------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function hitsWall(x, y, r) {
  for (const w of walls)
    if (x + r > w.x && x - r < w.x + w.w && y + r > w.y && y - r < w.y + w.h) return true;
  return false;
}
function pointInWall(x, y) {
  for (const w of walls)
    if (x > w.x && x < w.x + w.w && y > w.y && y < w.y + w.h) return true;
  return false;
}
function lineClear(x1, y1, x2, y2) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 14);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (pointInWall(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)) return false;
  }
  return true;
}
function genSpawns() {
  const cand = [];
  for (let gx = 0; gx < 10; gx++)
    for (let gy = 0; gy < 7; gy++) {
      const x = 70 + (gx * (W - 140)) / 9;
      const y = 70 + (gy * (H - 140)) / 6;
      if (!hitsWall(x, y, BR + 10)) cand.push({ x, y });
    }
  // seřadit tak, aby každý další spawn byl co nejdál od už vybraných
  const out = [cand.splice(Math.floor(Math.random() * cand.length), 1)[0]];
  while (cand.length) {
    let bi = 0, bd = -1;
    cand.forEach((c, i) => { const d = Math.min(...out.map((o) => Math.hypot(o.x - c.x, o.y - c.y))); if (d > bd) { bd = d; bi = i; } });
    out.push(cand.splice(bi, 1)[0]);
  }
  return out;
}

/* ============================ MÍSTNOSTI ============================ */
const rooms = new Map();
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // bez 0/O a 1/I, ať se kód dobře přepisuje
function normCode(code) { return (typeof code === "string" ? code : "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8); }
function createRoom() {
  if (rooms.size >= MAX_ROOMS) return null;
  let code;
  do { code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(""); } while (rooms.has(code));
  const r = {
    code, players: new Map(), bullets: [], powerups: [], hostId: 0, rounds: ROUNDS_TO_WIN,
    phase: "lobby", countdown: 0, cdTimer: 0, overTimer: 0,
    powerupTimer: 180, nid: 0, tick: 0, spawns: [], roundWinner: -1,
    mapIdx: -1, mapQueue: null, walls: MAPS[0].walls,
    mines: [], ev: [], puId: 0, mineId: 0, botNames: 0,
  };
  nextMap(r);
  rooms.set(code, r);
  return r;
}
function backToLobby(room) {
  room.phase = "lobby"; room.bullets = []; room.mines = []; room.powerups = [];
  for (const p of room.players.values()) { p.alive = false; p.waiting = false; }
  broadcastRoster(room);
}

function freeColorIdx(room, pref) {
  const used = new Set([...room.players.values()].map((p) => p.colorIdx));
  if (Number.isInteger(pref) && pref >= 0 && pref < MAX && !used.has(pref)) return pref;
  for (let i = 0; i < MAX; i++) if (!used.has(i)) return i;
  return 0;
}

function cleanName(name) {
  return (typeof name === "string" ? name : "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff<>&"'`]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, 16);
}
function makePlayer(room, ws, name, prefColor, bot) {
  const ci = freeColorIdx(room, prefColor);
  const id = ++room.nid;
  name = cleanName(name);
  if (!name) name = bot ? "Bot " + id : "Hráč " + id;
  return {
    id, ws: ws || null, bot: !!bot, name, colorIdx: ci, color: COLORS[ci],
    x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2,
    hp: 100, maxHp: 100, alive: false, waiting: false,
    weapon: "pistol", ammo: Infinity, cd: 0, wins: 0, kills: 0, shield: 0, turbo: 0,
    in: { ax: 0, ay: 0, fire: false },
    ai: { aim: 0, agg: 0.55 + Math.random() * 0.4, strafe: Math.random() < 0.5 ? 1 : -1, timer: 0, side: Math.random() < 0.5 ? 1 : -1, stuckT: 0, sx: 0, sy: 0 },
  };
}

const BOT_NAMES = ["Pepa", "Jarda", "Mirek", "Franta", "Lojza", "Vašek", "Standa", "Bohouš", "Zdena", "Kája",
  "Máňa", "Ferda", "Tonda", "Olga", "Béďa", "Kuba", "Eda", "Věra", "Míla", "Šimon"];
function addBot(room) {
  if (room.players.size >= MAX) return;
  const used = new Set([...room.players.values()].map((p) => p.name));
  let name = BOT_NAMES.map((n) => "Bot " + n).find((n) => !used.has(n)) || null;
  const b = makePlayer(room, null, name, undefined, true);
  room.players.set(b.id, b);
}

/* ============================ SIMULACE ============================ */
function startRound(room) {
  nextMap(room);
  broadcast(room, { t: "map", walls: room.walls, name: MAPS[room.mapIdx].name, idx: room.mapIdx, count: MAPS.length });
  const list = [...room.players.values()];
  list.forEach((p, i) => {
    const sp = room.spawns[i % room.spawns.length] || { x: W / 2, y: H / 2 };
    p.x = sp.x; p.y = sp.y; p.vx = 0; p.vy = 0;
    p.hp = p.maxHp; p.alive = true; p.waiting = false;
    p.weapon = "pistol"; p.ammo = Infinity; p.cd = 0; p.shield = 0; p.turbo = 0;
    p.angle = Math.atan2(H / 2 - p.y, W / 2 - p.x);
  });
  room.bullets = []; room.powerups = []; room.mines = []; room.ev = []; room.powerupTimer = 90;
  room.phase = "count"; room.countdown = 3; room.cdTimer = 30; room.roundWinner = -1; room.playT = 0;
  broadcastRoster(room);
}

function tryFire(room, p) {
  if (p.cd > 0) return;
  const wpn = WEAPONS[p.weapon];
  const wIdx = WEAPON_IDX[p.weapon];
  if (wpn.mine) {
    // mina se pokládá za sebe; max 3 vlastní (nejstarší zmizí), max 24 v místnosti
    if (room.mines.length >= MINE.max) return;
    const own = room.mines.filter((m) => m.owner === p.id);
    if (own.length >= MINE.perPlayer) room.mines.splice(room.mines.indexOf(own[0]), 1);
    let mx = p.x - Math.cos(p.angle) * (BR + 10), my = p.y - Math.sin(p.angle) * (BR + 10);
    if (hitsWall(mx, my, 8)) { mx = p.x; my = p.y; }
    room.mines.push({ id: ++room.mineId, x: mx, y: my, owner: p.id, arm: MINE.arm, life: MINE.life });
  } else {
    for (let i = 0; i < wpn.count; i++) {
      let a = p.angle;
      if (wpn.count > 1) a += (i - (wpn.count - 1) / 2) * wpn.spread;
      else a += (Math.random() * 2 - 1) * wpn.spread;
      room.bullets.push({
        x: p.x + Math.cos(p.angle) * (BR + 6), y: p.y + Math.sin(p.angle) * (BR + 6),
        vx: Math.cos(a) * wpn.speed, vy: Math.sin(a) * wpn.speed,
        dmg: wpn.dmg, r: wpn.r, life: wpn.life, owner: p.id, color: p.color, w: wIdx,
        explode: !!wpn.explode, radius: wpn.radius || 0, splash: wpn.splash || 0,
      });
    }
  }
  p.cd = wpn.cd;
  room.ev.push(["f", p.id, wIdx]);
  if (wpn.ammo !== Infinity) {
    p.ammo--;
    if (p.ammo <= 0) { p.weapon = "pistol"; p.ammo = Infinity; room.ev.push(["e", p.id]); }
  }
}
function damage(room, t, amount, ownerId, wIdx) {
  if (!t.alive) return;
  if (t.shield > 0) { room.ev.push(["b", t.id]); return; } // štít všechno odrazí
  t.hp -= amount;
  room.ev.push(["h", t.id, Math.max(1, Math.round(amount)), ownerId]);
  if (t.hp <= 0) {
    t.alive = false;
    const k = room.players.get(ownerId);
    if (k && k.id !== t.id) k.kills++;
    room.ev.push(["k", ownerId, t.id, wIdx | 0]);
  }
}
function explode(room, x, y, radius, dmg, ownerId, wIdx) {
  room.ev.push(["x", Math.round(x), Math.round(y), radius]);
  for (const t of room.players.values()) {
    if (!t.alive) continue;
    const d = Math.hypot(t.x - x, t.y - y);
    if (d < radius) damage(room, t, dmg * (1 - d / radius), ownerId, wIdx);
  }
}
function botThink(room, b) {
  let tgt = null, best = 1e9;
  for (const o of room.players.values()) {
    if (o === b || !o.alive) continue;
    const d = Math.hypot(b.x - o.x, b.y - o.y);
    if (d < best) { best = d; tgt = o; }
  }
  let ax = 0, ay = 0, fire = false;
  const ai = b.ai;
  if (tgt) {
    const see = lineClear(b.x, b.y, tgt.x, tgt.y);
    const ang = Math.atan2(tgt.y - b.y, tgt.x - b.x);
    // míření s předsazením podle pohybu cíle (a drobnou nepřesností)
    const wpn = WEAPONS[b.weapon], spd = wpn.speed || 9;
    const lead = best / spd;
    const aimAng = Math.atan2(tgt.y + tgt.vy * lead - b.y, tgt.x + tgt.vx * lead - b.x) + (Math.random() - 0.5) * 0.12;
    const diff = (((aimAng - ai.aim + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    ai.aim += diff * 0.32;
    let goal = null; // kam jít, když zrovna nebojuje
    if (see) {
      const ideal = b.weapon === "shotgun" ? 120 : 170;
      const fwd = best > ideal + 40 ? 1 : best < ideal - 40 ? -1 : 0;
      ax = Math.cos(ang) * fwd + Math.cos(ang + Math.PI / 2) * ai.strafe * 0.85;
      ay = Math.sin(ang) * fwd + Math.sin(ang + Math.PI / 2) * ai.strafe * 0.85;
      if (Math.abs(diff) < 0.22 && Math.random() < ai.agg) fire = true;
    } else goal = tgt;
    if (--ai.timer <= 0) { ai.strafe *= -1; ai.timer = 40 + Math.random() * 70; }
    // bedny: s pistolí sebere blízkou, zraněný jde pro lékárnu
    if ((b.weapon === "pistol" || b.hp < 50) && (!see || best > 260)) {
      let pu = null, pd = 1e9;
      for (const c of room.powerups) {
        const d = Math.hypot(c.x - b.x, c.y - b.y);
        const limit = b.hp < 50 && c.kind === "health" ? 340 : 230;
        if (d < limit && d < pd) { pd = d; pu = c; }
      }
      if (pu) goal = pu;
    }
    if (goal) { const a2 = Math.atan2(goal.y - b.y, goal.x - b.x); ax = Math.cos(a2); ay = Math.sin(a2); }
    if (b.weapon === "mines") fire = see && best < 170;
    // obcházení zdí: zkus přímý směr, pak postupně víc do strany (preferovaná strana se mění, když se zasekne)
    if (ax || ay) {
      const base = Math.atan2(ay, ax);
      for (const off of [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8, 2.5, -2.5]) {
        const a3 = base + off * ai.side;
        if (!hitsWall(b.x + Math.cos(a3) * 14, b.y + Math.sin(a3) * 14, BR)) { ax = Math.cos(a3); ay = Math.sin(a3); break; }
      }
    }
    // detekce zaseknutí
    if (++ai.stuckT >= 45) {
      if (Math.hypot(b.x - ai.sx, b.y - ai.sy) < 12) ai.side *= -1;
      ai.sx = b.x; ai.sy = b.y; ai.stuckT = 0;
    }
  }
  return { ax, ay, fire, aim: ai.aim };
}

function updateRoom(room) {
  useRoom(room);
  room.tick++;
  if (room.phase === "count") {
    if (--room.cdTimer <= 0) { room.countdown--; room.cdTimer = 30; if (room.countdown < 0) room.phase = "play"; }
  } else if (room.phase === "play") {
    room.playT++;
    // hráči
    for (const p of room.players.values()) {
      if (!p.alive) continue;
      if (p.cd > 0) p.cd--;
      if (p.shield > 0) p.shield--;
      if (p.turbo > 0) p.turbo--;
      let ax = p.in.ax, ay = p.in.ay, fire = p.in.fire;
      if (p.bot) { const r = botThink(room, p); ax = r.ax; ay = r.ay; fire = r.fire; p.angle = r.aim; }
      const mag = Math.hypot(ax, ay);
      if (mag > 0.05) {
        ax /= mag; ay /= mag;
        if (!p.bot) p.angle = Math.atan2(ay, ax);
        const sp = SPEED * (p.turbo > 0 ? TURBO : 1);
        p.vx = ax * sp; p.vy = ay * sp;
      } else { p.vx *= 0.6; p.vy *= 0.6; }
      let nx = p.x + p.vx; if (!hitsWall(nx, p.y, BR)) p.x = clamp(nx, BR, W - BR);
      let ny = p.y + p.vy; if (!hitsWall(p.x, ny, BR)) p.y = clamp(ny, BR, H - BR);
      // powerupy
      for (let i = room.powerups.length - 1; i >= 0; i--) {
        const pu = room.powerups[i];
        if (Math.hypot(p.x - pu.x, p.y - pu.y) < BR + 14) {
          if (pu.kind === "health") p.hp = Math.min(p.maxHp, p.hp + 45);
          else if (pu.kind === "shield") p.shield = SHIELD_TICKS;
          else if (pu.kind === "turbo") p.turbo = TURBO_TICKS;
          else { p.weapon = pu.kind; p.ammo = WEAPONS[pu.kind].ammo; p.cd = 0; }
          room.ev.push(["p", p.id, pu.kind, pu.id]);
          room.powerups.splice(i, 1);
        }
      }
      if (fire) tryFire(room, p);
    }
    // střely
    for (let i = room.bullets.length - 1; i >= 0; i--) {
      const bl = room.bullets[i];
      bl.x += bl.vx; bl.y += bl.vy; bl.life--;
      let dead = bl.life <= 0;
      if (!dead && pointInWall(bl.x, bl.y)) {
        if (bl.explode) explode(room, bl.x, bl.y, bl.radius, bl.splash, bl.owner, bl.w);
        else room.ev.push(["w", Math.round(bl.x - bl.vx * 0.5), Math.round(bl.y - bl.vy * 0.5)]);
        dead = true;
      }
      if (!dead) {
        for (const t of room.players.values()) {
          if (!t.alive || t.id === bl.owner) continue;
          if (Math.hypot(bl.x - t.x, bl.y - t.y) < bl.r + BR) {
            if (bl.explode) explode(room, bl.x, bl.y, bl.radius, bl.dmg + bl.splash, bl.owner, bl.w);
            else damage(room, t, bl.dmg, bl.owner, bl.w);
            dead = true; break;
          }
        }
      }
      if (dead) room.bullets.splice(i, 1);
    }
    // miny
    for (let i = room.mines.length - 1; i >= 0; i--) {
      const m = room.mines[i];
      if (m.arm > 0) { m.arm--; continue; }
      if (--m.life <= 0) { room.mines.splice(i, 1); continue; }
      for (const t of room.players.values()) {
        if (!t.alive || t.id === m.owner) continue;
        if (Math.hypot(t.x - m.x, t.y - m.y) < MINE.trigger + BR) {
          room.mines.splice(i, 1);
          explode(room, m.x, m.y, MINE.radius, MINE.dmg, m.owner, WEAPON_IDX.mines);
          break;
        }
      }
    }
    // bedny s bonusy
    if (--room.powerupTimer <= 0) {
      if (room.powerups.length < MAX_PICKUPS) spawnPowerup(room);
      room.powerupTimer = 180 + Math.random() * 120;
    }
    // konec kola
    const alive = [...room.players.values()].filter((p) => p.alive);
    if (room.players.size < 2) backToLobby(room);
    else if (alive.length <= 1) endRound(room, alive[0] || null);
    else if (room.playT >= ROUND_TICKS) endRound(room, null); // čas vypršel → remíza
  } else if (room.phase === "roundover") {
    if (--room.overTimer <= 0) { if (room.players.size >= 2) startRound(room); else backToLobby(room); }
  } else if (room.phase === "matchover") {
    if (--room.overTimer <= 0) backToLobby(room); // další zápas spouští zase hostitel
  }
  if (room.phase === "count" && room.players.size < 2) backToLobby(room);
}

function spawnPowerup(room) {
  const kind = DROPS[Math.floor(Math.random() * DROPS.length)];
  for (let t = 0; t < 30; t++) {
    const x = 70 + Math.random() * (W - 140), y = 70 + Math.random() * (H - 140);
    if (hitsWall(x, y, 26)) continue;
    if (room.powerups.some((c) => Math.hypot(c.x - x, c.y - y) < 80)) continue;
    if ([...room.players.values()].some((p) => p.alive && Math.hypot(p.x - x, p.y - y) < 60)) continue;
    room.powerups.push({ id: ++room.puId, x, y, kind });
    return;
  }
}
function endRound(room, winner) {
  if (winner) winner.wins++;
  room.roundWinner = winner ? winner.id : -1;
  const champ = [...room.players.values()].find((p) => p.wins >= room.rounds);
  broadcastRoster(room);
  if (champ) {
    room.phase = "matchover"; room.overTimer = 8 * 30;
    broadcast(room, { t: "match", champ: champ.id, standings: standings(room) });
  } else {
    room.phase = "roundover"; room.overTimer = 3 * 30;
    broadcast(room, { t: "round", winner: room.roundWinner });
  }
}
function standings(room) {
  return [...room.players.values()]
    .sort((a, b) => b.wins - a.wins || b.kills - a.kills)
    .map((p) => [p.id, p.name, p.color, p.wins, p.kills]);
}

/* ============================ SÍŤ ============================ */
/* ---------- ochrana proti zahlcení ---------- */
const MAX_ROOMS = 25;          // každá místnost se simuluje 30× za s – víc by free instance neutáhla
const MAX_CONNECTIONS = 150;   // celkem otevřených spojení
const MAX_PER_IP = 8;          // brzda proti zahlcení z jednoho počítače (velkorysá kvůli sdílené Wi-Fi)
const MSG_RATE = 90, MSG_BURST = 180; // zpráv za sekundu na spojení (klient posílá max ~65)
const JOIN_TIMEOUT = 10000;    // kdo se do 10 s nepřipojí do hry, je odpojen
const perIp = new Map();
function clientIp(req) {
  // Render předává IP v X-Forwarded-For; první položka jde podvrhnout, proto je limit na IP jen
  // doplňková brzda – skutečnou ochranu dávají celkové stropy výše.
  const xff = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
  return xff || req.socket.remoteAddress || "?";
}
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // ne-prohlížečový klient – Origin by stejně mohl podvrhnout
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const wss = new WebSocket.Server({
  server,
  maxPayload: 1024, // naše zprávy mají desítky bajtů; větší zprávu ws odmítne a spojení zavře
  perMessageDeflate: false,
  verifyClient: ({ req }, done) => {
    if (!originOk(req)) return done(false, 403, "Forbidden");
    if (wss.clients.size >= MAX_CONNECTIONS) return done(false, 503, "Server full");
    if ((perIp.get(clientIp(req)) || 0) >= MAX_PER_IP) return done(false, 429, "Too many connections");
    done(true);
  },
});

function send(ws, obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) {
  const s = JSON.stringify(obj);
  for (const p of room.players.values())
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(s);
}
function broadcastRoster(room) {
  const players = [...room.players.values()].map((p) => [p.id, p.name, p.color, p.wins, p.kills, p.bot ? 1 : 0]);
  broadcast(room, { t: "roster", players, host: room.hostId, code: room.code, rounds: room.rounds, phase: room.phase });
}
function hostOf(ws) { // akce smí dělat jen hostitel své místnosti
  const p = ws.player, room = ws.room;
  return p && room && room.hostId === p.id ? room : null;
}

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.player = null; ws.room = null;
  const ip = clientIp(req);
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  ws.once("close", () => { const n = (perIp.get(ip) || 1) - 1; if (n > 0) perIp.set(ip, n); else perIp.delete(ip); });
  const joinTimer = setTimeout(() => { if (!ws.player) ws.terminate(); }, JOIN_TIMEOUT);
  ws.once("close", () => clearTimeout(joinTimer));
  let tokens = MSG_BURST, last = Date.now();
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (raw, isBinary) => {
    const now = Date.now();
    tokens = Math.min(MSG_BURST, tokens + ((now - last) / 1000) * MSG_RATE); last = now;
    if (--tokens < 0) { ws.terminate(); return; } // zahlcování zprávami
    if (isBinary) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object") return;
    if (m.t === "create" || m.t === "join") {
      if (ws.player) return;
      let room;
      if (m.t === "create") { room = createRoom(); if (!room) { send(ws, { t: "busy" }); return; } }
      else { room = rooms.get(normCode(m.room)); if (!room) { send(ws, { t: "nogame" }); return; } }
      if (room.players.size >= MAX) { send(ws, { t: "full" }); return; }
      const p = makePlayer(room, ws, m.name, m.color, false);
      room.players.set(p.id, p); ws.player = p; ws.room = room;
      if (!room.hostId) room.hostId = p.id;
      if (room.phase !== "lobby") { p.alive = false; p.waiting = true; } // zápas běží: přidá se od dalšího kola
      send(ws, {
        t: "welcome", id: p.id, color: p.color, W, H, BR, SPEED, TURBO, walls: room.walls,
        mapName: MAPS[room.mapIdx].name, mapIdx: room.mapIdx,
        weapons: IDX_WEAPON.map((k) => WEAPONS[k].name),
        maxRounds: room.rounds, room: room.code, host: room.hostId, max: MAX,
      });
      broadcastRoster(room);
    } else if (m.t === "start") {
      const room = hostOf(ws);
      if (!room || room.phase !== "lobby" || room.players.size < 2) return;
      for (const p of room.players.values()) { p.wins = 0; p.kills = 0; }
      startRound(room);
    } else if (m.t === "addbot") {
      const room = hostOf(ws);
      if (!room || room.phase !== "lobby") return;
      addBot(room); broadcastRoster(room);
    } else if (m.t === "kick") {
      const room = hostOf(ws);
      if (!room || !Number.isInteger(m.id) || m.id === room.hostId) return;
      const t = room.players.get(m.id);
      if (!t) return;
      if (t.bot) { room.players.delete(t.id); broadcastRoster(room); }
      else if (t.ws) { send(t.ws, { t: "kicked" }); removePlayer(t.ws); t.ws.close(4001, "kicked"); }
    } else if (m.t === "rounds") {
      const room = hostOf(ws);
      if (!room || room.phase !== "lobby" || !ROUND_CHOICES.includes(m.n)) return;
      room.rounds = m.n; broadcastRoster(room);
    } else if (m.t === "in" && ws.player) {
      ws.player.in.ax = clamp(+m.ax || 0, -1, 1);
      ws.player.in.ay = clamp(+m.ay || 0, -1, 1);
      ws.player.in.fire = !!m.f;
    } else if (m.t === "ping") {
      if (Number.isFinite(m.ts)) send(ws, { t: "pong", ts: m.ts });
    }
  });
  ws.on("close", () => removePlayer(ws));
  ws.on("error", () => {});
});

function removePlayer(ws) {
  const room = ws.room, p = ws.player;
  if (!room || !p) return;
  room.players.delete(p.id);
  ws.player = null; ws.room = null;
  const humans = [...room.players.values()].filter((x) => !x.bot);
  if (humans.length === 0) {
    rooms.delete(room.code); // bez lidí místnost zahodíme (i s boty)
    return;
  }
  if (room.hostId === p.id) room.hostId = humans[0].id; // hostitel odešel → předá se dalšímu
  if (room.phase !== "lobby" && room.players.size < 2) backToLobby(room);
  else broadcastRoster(room);
}

/* heartbeat – zahoď mrtvá spojení */
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; try { ws.ping(); } catch {}
  });
}, 15000);

/* ---------- hlavní smyčka: simulace + rozeslání stavu ---------- */
setInterval(() => {
  for (const room of rooms.values()) {
    updateRoom(room);
    const ps = [];
    for (const p of room.players.values())
      ps.push([p.id, Math.round(p.x), Math.round(p.y), +p.angle.toFixed(2), Math.max(0, Math.round(p.hp)), WEAPON_IDX[p.weapon], p.alive ? 1 : 0,
        p.ammo === Infinity ? -1 : p.ammo, (p.shield > 0 ? 1 : 0) | (p.turbo > 0 ? 2 : 0), Math.max(p.shield, p.turbo)]);
    const bs = room.bullets.map((b) => [Math.round(b.x), Math.round(b.y), +b.vx.toFixed(1), +b.vy.toFixed(1), b.r, b.color, b.w]);
    const pu = room.powerups.map((p) => [Math.round(p.x), Math.round(p.y), p.kind, p.id]);
    const mn = room.mines.map((m) => [Math.round(m.x), Math.round(m.y), m.owner, m.arm > 0 ? 0 : 1, m.id]);
    const msg = { t: "s", k: room.tick, ph: room.phase, cd: room.countdown, ps, bs, pu, mn };
    if (room.phase === "play") msg.tl = Math.max(0, Math.ceil((ROUND_TICKS - room.playT) / 30));
    if (room.ev.length) { msg.ev = room.ev; room.ev = []; }
    broadcast(room, msg);
  }
}, TICK);

server.listen(PORT, () => {
  console.log(`Bulánci online běží na portu ${PORT} (výchozí počet kol: ${ROUNDS_TO_WIN})`);
});
