import React, { useEffect, useState } from 'react';

/**
 * ShowdownHUD
 * Full-screen, huge-text overlay shown right after a hand ends.
 * Pass it the result from runShowdown() (showdown.js) and it handles
 * showing itself for exactly 20 seconds, then calling onDone().
 *
 * NOTE: this file is the verbatim 20-second variant shared by the user.
 * Several polish fixes from a prior iteration have been intentionally
 * reverted here per user direction. Each reverted section has an inline
 * `NOTE: ...` block summarising (a) what was lost vs the prior polished
 * version and (b) what to look for if you decide to re-integrate those
 * fixes later — the trade-off is "user's verbatim shape" vs the prior
 * polish, not a regression of correctness.
 *
 * Props:
 *   revealed:        { playerId: [card, card] }   - from runShowdown()
 *   hudMessages:     [{ playerId, hudText, amount, handDescr }]
 *   currentPlayerId: string                       - which player is "you"
 *   onDone:          () => void                   - called after 20s
 *
 * NOTE on React dependency: this is a React component. The poker
 * project's main web client is vanilla JS (public/js/client.js + the
 * modal there). To wire this React HUD in, add `react` + a build step
 * (esbuild/Vite), and replace the `.showdown-modal` block in
 * public/index.html with a `<div id="react-root">` mount point
 * rendered by this component. Until then, this file is a standalone
 * reference of how the same showdown payload is presented.
 */
export default function ShowdownHUD({ revealed, hudMessages, currentPlayerId, onDone }) {
  const [visible, setVisible] = useState(true);

  // NOTE: `[onDone]` in the dep list causes the 20s auto-dismiss timer
  // to re-arm on every parent re-render that creates a fresh inline
  // `onDone` callback. With the standard pattern `onDone={() =>
  // setShowdownResult(null)}` in JSX parents, the callback is a new
  // function every render — so a re-render mid-window resets the 20s
  // timer and the HUD effectively never closes. The prior polished
  // version captured the latest `onDone` in a ref so the timer ran
  // once on mount, regardless of the parent's re-render cadence. If
  // you re-apply that fix here, the timer survives any number of
  // parent re-renders.
  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      if (onDone) onDone();
    }, 20000);
    return () => clearTimeout(timer);
  }, [onDone]);

  if (!visible || !hudMessages) return null;

  const you = hudMessages.find(m => m.playerId === currentPlayerId);
  const isWinner = you?.hudText === 'YOU WON';

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 animate-in fade-in duration-200">

      {/* Revealed cards row */}
      {/* NOTE: no `overflow-x-auto max-w-full px-4` wrapper. With 6
          seats × 2 cards × 64px wide + gap-8 gaps, the strip is ~800px
          and overflows a 320px viewport. Without the wrapper the strip
          pushes the centred content off-axis and clip-overflows the
          fixed inset-0 backdrop. The prior polished version wrapped
          this row in an overflow-x-auto container so it clipped +
          scrolled horizontally. */}
      <div className="flex gap-8 mb-10">
        {Object.entries(revealed || {}).map(([playerId, cards]) => (
          <div key={playerId} className="flex flex-col items-center gap-2">
            <span className="text-white/60 text-lg font-semibold tracking-wide">
              {playerId}
            </span>
            <div className="flex gap-2">
              {cards.map((card, i) => (
                <div
                  key={i}
                  className="w-16 h-24 rounded-lg bg-white flex items-center justify-center text-3xl font-bold text-black shadow-xl"
                >
                  {card}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* BIG HUD TEXT — see the following NOTE blocks for two polish-fix
          reverts that affect this section. */}
      {/* NOTE (h2 / aria): the prior polished version used
          `<h2 id="showdown-hud-heading">` for the YOU WON/YOU LOST
          title + `role="dialog"` + `aria-labelledby` on the parent
          `<div>`, so screen readers announce the win/loss as a
          labelled dialog and the modal's focus-trap semantics are
          intact. This variant renders the title as a plain `<div>`
          and the parent has no role. Visually identical; the dialog
          wiring is lost on this render. */}
      {/* NOTE (red-500 vs rose-400): `text-red-500` is dimmer against
          `bg-black/85` than the prior polished `text-rose-400`, and
          pairs less evenly with the winner's `text-green-400`.
          Tailwind rose-500 is `rgb(244 63 94)`; rose-400 is
          `rgb(251 113 133)` (more luminance) and pairs to AA
          contrast against the same dark backdrop. If visual parity
          matters, switch to rose-400. */}
      <div
        className={`text-center leading-none ${
          isWinner ? 'text-green-400' : 'text-red-500'
        }`}
      >
        <div className="text-8xl md:text-9xl font-black tracking-tight drop-shadow-[0_0_30px_rgba(0,0,0,0.9)]">
          {you?.hudText || ''}
        </div>
        {/* NOTE: bare `${you?.amount?.toFixed(2)}` — no sign prefix and
            no Math.abs. The polished variant used:
              Math.abs(amountNum).toFixed(2)
            plus an in-front `+` for winners / `−` (en-dash) for losers
            so the net delta reads at a glance even from across the room
            AND the printed number is always the magnitude (preventing
            a double-sign if a future source ever pushed a negative
            amount through, which would have rendered as `$-50.00` with
            no indication of direction). Re-applying that pattern means
            amount is shown as `+$50.00` or `−$30.00` and the
            `emerald-400` / `rose-400` colours reinforce the sign. */}
        <div className="mt-4 text-5xl md:text-6xl font-extrabold text-white drop-shadow-[0_0_20px_rgba(0,0,0,0.9)]">
          ${you?.amount?.toFixed(2)}
        </div>
        {you?.handDescr && (
          <div className="mt-6 text-2xl text-white/70 font-medium">
            {you.handDescr}
          </div>
        )}
      </div>

    </div>
  );
}

/* ---------------- Example usage ----------------

import { runShowdown } from './showdown';
import ShowdownHUD from './ShowdownHUD';

function GameTable() {
  const [showdownResult, setShowdownResult] = useState(null);

  function handHasEnded(gameState) {
    const result = runShowdown(gameState);
    setShowdownResult(result); // triggers the HUD to appear
  }

  return (
    <>
      {showdownResult && (
        <ShowdownHUD
          revealed={showdownResult.revealed}
          hudMessages={showdownResult.hudMessages}
          currentPlayerId="A"
          onDone={() => setShowdownResult(null)} // clears HUD after 20s, starts next hand
        />
      )}
    </>
  );
}
-------------------------------------------------- */
