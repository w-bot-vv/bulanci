# Bulánci Online

Online multiplayerová střílečka pro **až 20 hráčů** v prohlížeči (fanouškovská hra
inspirovaná českými Bulánky). Jeden malý Node.js server řídí celou hru
(autoritativně) a zároveň servíruje i samotného klienta, takže stačí **jeden
deploy** a všichni se připojí na jednu adresu.

## Jak se hraje

1. **Hostitel** otevře hru, zadá jméno a klikne na **Založit novou hru**.
   Dostane **kód hry** (např. `K7PXQ`) a odkaz `…/?hra=K7PXQ`.
2. Kamarádi otevřou odkaz (kód se předvyplní), nebo kód zadají ručně, a kliknou
   na **Připojit**.
3. V **lobby** hostitel vidí, kdo se připojil, může **přidat / odebrat boty**,
   **vyhodit hráče** (potvrzuje se druhým kliknutím) a zvolit **počet výher do
   konce zápasu** (3 / 5 / 7 / 10).
4. Hra začne, **až ji hostitel spustí**. Kdo přijde během zápasu, naskočí od
   dalšího kola. Po konci zápasu se všichni vrátí do lobby a čeká se zase na
   hostitele. Když hostitel odejde, hostitelem se stane další hráč.

**Ve hře:** poslední přeživší bere kolo. Každé kolo je na jiné z 5 map. Kolo má
pojistku 90 s; když nikdo nevyhraje, je remíza.

**Bedny:** samopal, brokovnice, raketomet, miny (pokládají se za sebe), lékárna,
štít (6 s nezranitelnost) a turbo (7 s rychlost ×1,5). Kdo sebere zbraň, má kolem
sebe barevnou auru, zbraň je vidět v ruce a pod životy má ukazatel munice.

**Ovládání:** WASD nebo šipky = pohyb a míření, mezerník nebo Enter = palba,
gamepad funguje taky. Na telefonu: levá půlka = pohyb, pravá = palba.
**M** = zvuk, **Esc** = odchod (s potvrzením).

---

## Spuštění na svém počítači

Potřebuješ [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

Otevři `http://localhost:3000`. Pro víc hráčů otevři víc oken, nebo se z jiného
zařízení ve stejné síti připoj na `http://ADRESA-POCITACE:3000`.

## Nasazení online (Render)

Repozitář obsahuje `render.yaml`, takže stačí na [render.com](https://render.com)
zvolit **New → Blueprint** a vybrat tento repozitář. Služba se založí jako free
web service ve Frankfurtu (`npm install`, `npm start`).

Free služba po 15 minutách bez provozu usne a první načtení pak chvíli trvá.
Během hraní neusne, protože aktivitu drží WebSocket zprávy.

## Nastavení (proměnné prostředí)

| Proměnná | Výchozí | Význam |
|---|---|---|
| `PORT`          | 3000 | Port serveru (hosting nastaví sám). |
| `ROUNDS`        | 5    | Výchozí počet výher do konce zápasu (hostitel ho v lobby může změnit). |
| `ROUND_SECONDS` | 90   | Nejdelší délka jednoho kola; pak remíza. |

## Bezpečnost

- Server posílá jen soubory ze složky `public` (whitelist načtený při startu).
- Jména hráčů se čistí od HTML a řídicích znaků a zobrazují se jen jako text;
  stránka má CSP, která pustí jen vlastní skript.
- Limity proti zahlcení: max 1 KB na zprávu, limit zpráv za sekundu, max 150
  spojení, max 25 rozehraných her, max 8 spojení z jedné IP, odpojení bez vstupu
  do hry po 10 s, odmítnutí připojení z cizích webů.
- Akce hostitele (start, boti, vyhazování, počet kol) ověřuje server.
- **Kód hry není heslo.** Kdo ho zná, připojí se; hostitel ho může vyhodit, ale
  vyhozený hráč se může s kódem připojit znovu.

## Struktura

```
├── server.js          # herní server (HTTP + WebSocket + simulace, lobby, boti)
├── package.json
├── render.yaml        # nasazení na Render (Blueprint)
└── public/
    └── index.html     # klient (hra v prohlížeči, grafika a zvuky kreslené kódem)
```
