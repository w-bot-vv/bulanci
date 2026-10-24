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
const ROUNDS_TO_WIN = parseInt(process.env.ROUNDS || "5", 10);
const BOTS_FILL = parseInt(process.env.BOTS || "4", 10);
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
};
const WEAPON_IDX = { pistol: 0, mg: 1, shotgun: 2, rocket: 3 };
const IDX_WEAPON = ["pistol", "mg", "shotgun", "rocket"];

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
function getRoom(code) {
  code = (typeof code === "string" ? code : "").slice(0, 24).replace(/[^\w\-]/g, "") || "main";
  let r = rooms.get(code);
  if (!r) {
    if (rooms.size >= MAX_ROOMS) return null;
    r = {
      code, players: new Map(), bullets: [], powerups: [],
      phase: "lobby", countdown: 0, cdTimer: 0, overTimer: 0,
      powerupTimer: 180, nid: 0, tick: 0, spawns: [], roundWinner: -1,
      mapIdx: -1, mapQueue: null, walls: MAPS[0].walls,
    };
    nextMap(r);
    rooms.set(code, r);
  }
  return r;
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
    weapon: "pistol", ammo: Infinity, cd: 0, wins: 0, kills: 0,
    in: { ax: 0, ay: 0, fire: false },
    ai: { aim: 0, agg: 0.55 + Math.random() * 0.4, strafe: Math.random() < 0.5 ? 1 : -1, timer: 0 },
  };
}

function addBot(room) {
  if (room.players.size >= MAX) return;
  const b = makePlayer(room, null, null, undefined, true);
  room.players.set(b.id, b);
}

function ensureBots(room) {
  const humans = [...room.players.values()].filter((p) => !p.bot);
  if (humans.length === 0) {
    for (const p of [...room.players.values()]) if (p.bot) room.players.delete(p.id);
    return;
  }
  // doplň boty do BOTS_FILL bojovníků
  while (room.players.size < Math.min(BOTS_FILL, MAX)) addBot(room);
  // uber přebytečné boty, když přibylo lidí
  const target = Math.max(BOTS_FILL, humans.length);
  if (room.players.size > target) {
    const bots = [...room.players.values()].filter((p) => p.bot);
    let over = room.players.size - target;
    for (const b of bots) { if (over <= 0) break; room.players.delete(b.id); over--; }
  }
}

/* ============================ SIMULACE ============================ */
function startRound(room) {
  ensureBots(room);
  nextMap(room);
  broadcast(room, { t: "map", walls: room.walls, name: MAPS[room.mapIdx].name, idx: room.mapIdx, count: MAPS.length });
  const list = [...room.players.values()];
  list.forEach((p, i) => {
    const sp = room.spawns[i % room.spawns.length] || { x: W / 2, y: H / 2 };
    p.x = sp.x; p.y = sp.y; p.vx = 0; p.vy = 0;
    p.hp = p.maxHp; p.alive = true; p.waiting = false;
    p.weapon = "pistol"; p.ammo = Infinity; p.cd = 0;
    p.angle = Math.atan2(H / 2 - p.y, W / 2 - p.x);
  });
  room.bullets = []; room.powerups = []; room.powerupTimer = 180;
  room.phase = "count"; room.countdown = 3; room.cdTimer = 30; room.roundWinner = -1;
  broadcastRoster(room);
}

function maybeStart(room) {
  if (room.phase !== "lobby") return;
  ensureBots(room);
  if (room.players.size >= 2) startRound(room);
  else broadcastRoster(room);
}

function tryFire(room, p) {
  if (p.cd > 0) return;
  const wpn = WEAPONS[p.weapon];
  p.cd = wpn.cd;
  for (let i = 0; i < wpn.count; i++) {
    let a = p.angle;
    if (wpn.count > 1) a += (i - (wpn.count - 1) / 2) * wpn.spread;
    else a += (Math.random() * 2 - 1) * wpn.spread;
    room.bullets.push({
      x: p.x + Math.cos(p.angle) * (BR + 6), y: p.y + Math.sin(p.angle) * (BR + 6),
      vx: Math.cos(a) * wpn.speed, vy: Math.sin(a) * wpn.speed,
      dmg: wpn.dmg, r: wpn.r, life: wpn.life, owner: p.id, color: p.color,
      explode: !!wpn.explode, radius: wpn.radius || 0, splash: wpn.splash || 0,
    });
  }
  if (wpn.ammo !== Infinity) { p.ammo--; if (p.ammo <= 0) { p.weapon = "pistol"; p.ammo = Infinity; } }
}
function damage(room, t, amount, ownerId) {
  if (!t.alive) return;
  t.hp -= amount;
  if (t.hp <= 0) {
    t.alive = false;
    const k = room.players.get(ownerId);
    if (k && k.id !== t.id) k.kills++;
  }
}
function explode(room, x, y, radius, dmg, ownerId) {
  for (const t of room.players.values()) {
    if (!t.alive) continue;
    const d = Math.hypot(t.x - x, t.y - y);
    if (d < radius) damage(room, t, dmg * (1 - d / radius), ownerId);
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
  if (tgt) {
    const see = lineClear(b.x, b.y, tgt.x, tgt.y);
    const ang = Math.atan2(tgt.y - b.y, tgt.x - b.x);
    b.ai.aim += (((ang - b.ai.aim + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 0.18;
    if (see) {
      const ideal = 210;
      const fwd = best > ideal + 40 ? 1 : best < ideal - 40 ? -1 : 0;
      ax = Math.cos(ang) * fwd + Math.cos(ang + Math.PI / 2) * b.ai.strafe * 0.9;
      ay = Math.sin(ang) * fwd + Math.sin(ang + Math.PI / 2) * b.ai.strafe * 0.9;
      const aimErr = Math.abs(((ang - b.ai.aim + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (aimErr < 0.28 && Math.random() < b.ai.agg) fire = true;
    } else { ax = Math.cos(ang); ay = Math.sin(ang); }
    if (--b.ai.timer <= 0) { b.ai.strafe *= -1; b.ai.timer = 40 + Math.random() * 70; }
    if (hitsWall(b.x + ax * 6, b.y + ay * 6, BR)) {
      ax = Math.cos(ang + Math.PI / 2) * b.ai.strafe;
      ay = Math.sin(ang + Math.PI / 2) * b.ai.strafe;
    }
  }
  return { ax, ay, fire, aim: b.ai.aim };
}

function updateRoom(room) {
  useRoom(room);
  room.tick++;
  if (room.phase === "count") {
    if (--room.cdTimer <= 0) { room.countdown--; room.cdTimer = 30; if (room.countdown < 0) room.phase = "play"; }
  } else if (room.phase === "play") {
    // hráči
    for (const p of room.players.values()) {
      if (!p.alive) continue;
      if (p.cd > 0) p.cd--;
      let ax = p.in.ax, ay = p.in.ay, fire = p.in.fire;
      if (p.bot) { const r = botThink(room, p); ax = r.ax; ay = r.ay; fire = r.fire; p.angle = r.aim; }
      const mag = Math.hypot(ax, ay);
      if (mag > 0.05) {
        ax /= mag; ay /= mag;
        if (!p.bot) p.angle = Math.atan2(ay, ax);
        p.vx = ax * SPEED; p.vy = ay * SPEED;
      } else { p.vx *= 0.6; p.vy *= 0.6; }
      let nx = p.x + p.vx; if (!hitsWall(nx, p.y, BR)) p.x = clamp(nx, BR, W - BR);
      let ny = p.y + p.vy; if (!hitsWall(p.x, ny, BR)) p.y = clamp(ny, BR, H - BR);
      // powerupy
      for (let i = room.powerups.length - 1; i >= 0; i--) {
        const pu = room.powerups[i];
        if (Math.hypot(p.x - pu.x, p.y - pu.y) < BR + 14) {
          if (pu.kind === "health") p.hp = Math.min(p.maxHp, p.hp + 45);
          else { p.weapon = pu.kind; p.ammo = WEAPONS[pu.kind].ammo; }
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
      if (!dead && pointInWall(bl.x, bl.y)) { if (bl.explode) explode(room, bl.x, bl.y, bl.radius, bl.splash, bl.owner); dead = true; }
      if (!dead) {
        for (const t of room.players.values()) {
          if (!t.alive || t.id === bl.owner) continue;
          if (Math.hypot(bl.x - t.x, bl.y - t.y) < bl.r + BR) {
            if (bl.explode) explode(room, bl.x, bl.y, bl.radius, bl.dmg + bl.splash, bl.owner);
            else damage(room, t, bl.dmg, bl.owner);
            dead = true; break;
          }
        }
      }
      if (dead) room.bullets.splice(i, 1);
    }
    // powerup spawn
    if (--room.powerupTimer <= 0 && room.powerups.length < 5) {
      spawnPowerup(room); room.powerupTimer = 300 + Math.random() * 200;
    }
    // konec kola
    const alive = [...room.players.values()].filter((p) => p.alive);
    if (alive.length <= 1 && room.players.size >= 2) endRound(room, alive[0] || null);
  } else if (room.phase === "roundover" || room.phase === "matchover") {
    if (--room.overTimer <= 0) {
      if (room.phase === "matchover") { for (const p of room.players.values()) { p.wins = 0; p.kills = 0; } }
      if (room.players.size >= 2) startRound(room);
      else { room.phase = "lobby"; broadcastRoster(room); }
    }
  }
}

function spawnPowerup(room) {
  const kinds = ["mg", "shotgun", "rocket", "health", "health"];
  const kind = kinds[Math.floor(Math.random() * kinds.length)];
  for (let t = 0; t < 30; t++) {
    const x = 70 + Math.random() * (W - 140), y = 70 + Math.random() * (H - 140);
    if (!hitsWall(x, y, 26)) { room.powerups.push({ x, y, kind }); return; }
  }
}
function endRound(room, winner) {
  if (winner) winner.wins++;
  room.roundWinner = winner ? winner.id : -1;
  const champ = [...room.players.values()].find((p) => p.wins >= ROUNDS_TO_WIN);
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
  broadcast(room, { t: "roster", players });
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
    if (m.t === "join") {
      if (ws.player) return;
      const room = getRoom(m.room);
      if (!room) { send(ws, { t: "busy" }); return; }
      if (room.players.size >= MAX) { send(ws, { t: "full" }); return; }
      const p = makePlayer(room, ws, m.name, m.color, false);
      room.players.set(p.id, p); ws.player = p; ws.room = room;
      if (room.phase === "play" || room.phase === "count") { p.alive = false; p.waiting = true; }
      send(ws, {
        t: "welcome", id: p.id, color: p.color, W, H, BR, SPEED, walls: room.walls, mapName: MAPS[room.mapIdx].name,
        weapons: Object.fromEntries(Object.entries(WEAPONS).map(([k, v]) => [k, v.name])),
        maxRounds: ROUNDS_TO_WIN, room: room.code,
      });
      broadcastRoster(room);
      maybeStart(room);
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
  if ([...room.players.values()].filter((x) => !x.bot).length === 0) {
    rooms.delete(room.code); // prázdnou místnost zahodíme
    return;
  }
  ensureBots(room);
  broadcastRoster(room);
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
      ps.push([p.id, Math.round(p.x), Math.round(p.y), +p.angle.toFixed(2), Math.max(0, Math.round(p.hp)), WEAPON_IDX[p.weapon], p.alive ? 1 : 0]);
    const bs = room.bullets.map((b) => [Math.round(b.x), Math.round(b.y), +b.vx.toFixed(1), +b.vy.toFixed(1), b.r, b.color]);
    const pu = room.powerups.map((p) => [Math.round(p.x), Math.round(p.y), p.kind]);
    broadcast(room, { t: "s", k: room.tick, ph: room.phase, cd: room.countdown, ps, bs, pu });
  }
}, TICK);

server.listen(PORT, () => {
  console.log(`Bulánci online běží na portu ${PORT} (kol: ${ROUNDS_TO_WIN}, boti do: ${BOTS_FILL})`);
});
