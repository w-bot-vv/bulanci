# Bulánci Online

Online multiplayer verze hry Bulánci pro **až 20 hráčů**. Jeden malý Node.js
server řídí celou hru (autoritativně) a zároveň servíruje i samotnou hru, takže
stačí **jeden deploy** a všichni se připojí na jednu adresu.

- Míříš tam, kam jdeš; palba střílí ve směru pohybu.
- Ovládání: klávesnice (WASD/šipky), gamepad, nebo dotyk na telefonu.
- Zbraně z beden (samopal, brokovnice, raketomet), lékárny, kola na počet výher.
- Volitelní **boti** doplní arénu, když je málo lidí.

---

## 1) Vyzkoušení na svém počítači (lokálně)

Potřebuješ [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

Otevři `http://localhost:3000`. Chceš-li si vyzkoušet víc hráčů, otevři víc
oken/karet nebo se z jiného zařízení ve stejné síti připoj na
`http://ADRESA-POCITACE:3000`.

---

## 2) Nasazení online (aby se připojili lidé odkudkoli)

Nejjednodušší je **Render** (v roce 2026 má reálný free tier bez platební karty;
free služba ale po ~15 min nečinnosti „usne" a první probuzení trvá ~30–50 s –
počítej s tím, že první hráč chvíli čeká). Postup:

1. Nahraj tuto složku do nového repozitáře na GitHub.
2. Na [render.com](https://render.com) → **New → Web Service** → připoj repozitář.
3. Nastav:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Deploy. Render ti dá adresu typu `https://neco.onrender.com` – tu pošli hráčům.
   Port si Render nastaví sám (server čte `process.env.PORT`).

> Chceš server, který nikdy neusne? Podívej se na **Koyeb** nebo **Northflank**
> (mají trvale běžící free službu, ale vyžadují kartu k ověření). **Fly.io** ani
> **Railway** už trvalý free tier nemají. **Vercel/Netlify se NEHODÍ** – neudrží
> trvalé WebSocket spojení.

### Varianta: klient na GitHub Pages, server jinde
GitHub Pages umí jen statické soubory (žádný server), takže tam nahraješ jen
`public/index.html`, a v menu hry do pole **Adresa serveru** zadáš adresu svého
serveru (např. `wss://neco.onrender.com`). Server pak stačí jen na WebSocket.
Pro většinu lidí je ale jednodušší varianta 2 (vše z jedné adresy).

---

## Nastavení (proměnné prostředí)

| Proměnná | Výchozí | Význam |
|---|---|---|
| `PORT`   | 3000 | Port serveru (hosting nastaví sám). |
| `ROUNDS` | 5    | Kolik kol je potřeba k výhře zápasu. |
| `BOTS`   | 4    | Doplnit boty do tolika bojovníků (0 = bez botů). |

Kód místnosti: v menu lze zadat „kód místnosti". Kdo má stejný kód, hraje spolu;
různé kódy = oddělené zápasy na stejném serveru.

---

## Ovládání

- **Klávesnice:** WASD + mezerník, nebo šipky + Enter.
- **Gamepad:** páčka/kříž + tlačítko A.
- **Telefon:** levá půlka displeje = pohyb a míření, pravá = palba.
- **Esc** = odejít zpět do menu.

---

## Poctivé poznámky (co čekat)

- **Toto je funkční základ, ne odladěná esportová netcode.** Server je
  autoritativní, klient plynule interpoluje ostatní hráče a předvídá pohyb té
  vlastní postavy. Při vyšší latenci se může projevit drobné „cukání" nebo
  zpoždění palby.
- **20 hráčů v rychlé akci je náročné.** Při špatném připojení některých hráčů
  nebo slabém free serveru může hra zadrhávat. Když to bude potřeba, dá se ladit
  (frekvence odesílání, interpolační zpoždění, velikost snímků) – rád pomůžu.
- Live provoz jsem netestoval v reálné síti mezi zařízeními; ověřená je logika
  serveru (připojení, boti, kola, zápas, zásahy) automatickým testem.

## Struktura

```
bulanci-online/
├── server.js          # herní server (HTTP + WebSocket + simulace)
├── package.json
├── public/
│   └── index.html     # klient (hra v prohlížeči)
└── README.md
```
