# Friendly Poker - Texas Hold'em (No Money)

A friendly Texas Hold'em poker game you can run on your own computer and
optionally host on the web so people worldwide can play together.

- **No money. No gambling.** Players earn points (admin-managed). For fun only.
- **Real Texas Hold'em rules** - blinds, dealer rotation, betting rounds,
  full hand evaluation (best 5 of 7), ties, splits.
- **Random player names** ready to pick for new players.
- **Persistent accounts**: every player's name and points are saved in a
  JSON file under the project. Log back in with the same name to keep your
  points.
- **Admin panel**: password-protected. Add, set, or remove points on any
  player at any time (even mid-game).
- **Live multiplayer** via Socket.IO; multiple tables can run concurrently.

## Quick start

```bash
cd poker-game
npm install
npm start
```

Open <http://localhost:3000> in your browser. Pick a name (or a random one)
and create or join a table. The first hand auto-starts 3 seconds after 2+
players sit down.

> Default admin password: **`admin123`**. Change it from the admin panel
> once you're in.

## How to play

1. **Pick a name** on the login screen. If you've played here before, your
   points are restored automatically.
2. **Join a table** from the lobby, or create your own. You can choose
   the table name, small/big blinds, and max seats (2-9).
3. **Sit down** at an empty seat.
4. When 2+ players are seated, a hand auto-starts after a brief countdown.
5. On your turn, use **Fold / Check / Call / Raise / All-in**. The action
   bar shows the legal options for your current state.
6. After each hand, points are automatically rebalanced and the next hand
   starts in ~5 seconds.

### Texas Hold'em rules implemented

- Dealer button rotates clockwise each hand.
- Heads-up (2 players): dealer is small blind, acts first pre-flop and
  last post-flop. Otherwise standard position order applies.
- Blinds: small < big, posted at start of each hand.
- Betting rounds: pre-flop, post-flop, post-turn, post-river.
- Min-raise enforcement, including partial all-in raises that don't bump
  the min-raise.
- Showdown: best 5-of-7 hand wins the pot. Ties split the pot (rounding
  remainder to the closest player left of the dealer).
- Hand evaluator handles all 10 categories including the wheel straight
  (A-2-3-4-5) and royal flush.

## Admin panel

Open by clicking the **Admin** button in the top bar, then enter the admin
password.

- **Add points** to any player (default +X, can be negative for a deduction).
- **Set points** to an exact value.
- **Delete** a player (removes them from the lobby entirely).
- **Default starting stack** for brand-new accounts.
- **Change admin password**.

If the player is currently seated at a table, the new point total is
applied to their seat immediately. Otherwise it applies next time they
sit down.

## Project layout

```
poker-game/
├── data.json                # Persistent player accounts (auto-created)
├── package.json
├── README.md
├── server.js                # Express + Socket.IO entry point
├── src/
│   ├── poker.js             # Texas Hold'em engine (deck, eval, state machine)
│   ├── rooms.js             # In-memory table manager
│   └── database.js          # JSON-file persistence
└── public/
    ├── index.html           # Main SPA (login + lobby + table + admin modal)
    ├── css/style.css        # Styles
    └── js/client.js         # Socket.IO client + UI
```

## Hosting for friends worldwide

By default the server listens on `0.0.0.0:3000`. To make it playable
beyond your local network:

1. **Run on a VPS.** Set the `PORT` env var if needed (defaults to 3000).
2. **Tunnel from your machine.** Tools like `ngrok`, `bore`, or
   `cloudflared` can expose your localhost:3000 to the web.
3. **Reverse proxy via nginx.** Recommended for production.

Anyone who can reach the URL can play. The admin password controls who can
manage points.

## Customization

- **Starting points**: change in the admin panel, or edit `data.json`
  directly (`settings.startingStack`).
- **Default table blinds/max seats**: when creating a table in the lobby.
- **Add more random names**: edit the arrays in `server.js` (ADJ, NOUNS).

## Tips for zero-conflict play

- Admin adds points to anyone who goes bust to keep them in the game.
- Sit-out lets a player skip hands while keeping their seat.
- Reconnect with the same name to keep your points and seat identity
  whenever possible.

Have fun playing!
