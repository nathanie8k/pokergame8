import React, { useEffect, useRef, useState } from 'react';

/**
 * ShowdownHUD
 * Full-screen, huge-text overlay shown right after a hand ends.
 * Pass it the result from runShowdown() (showdown.js) and it handles
 * showing itself for exactly 5 seconds, then calling onDone().
 *
 * Updated: amount display is BIG and DOMINANT — uses 2-decimal-cent
 * precision from runShowdown() (which already rounds via
 * `Math.round(value * 100) / 100`), prefixed with `+` for winners and
 * `−` for losers so the net delta reads at a glance even from across
 * the room.
 *
 * Props:
 *   revealed:        { playerId: [card, card] }   - from runShowdown()
 *   hudMessages:     [{ playerId, hudText, amount, handDescr }]
 *   currentPlayerId: string                       - which player is "you"
 *   onDone:          () => void                   - called after 5s
 *
 * NOTE: this is a React component. The poker project's main web client
 * is vanilla JS (public/js/client.js + the modal there). To wire this
 * React HUD in, add `react` + a build step (esbuild/Vite), and replace
 * the `.showdown-modal` block in public/index.html with a `<div id="react-root">`
 * mount point rendered by this component. Until then, this file is a
 * standalone reference of how the same 5-second showdown payload can be
 * presented with a different visual treatment.
 */
export default function ShowdownHUD({ revealed, hudMessages, currentPlayerId, onDone }) {
  const [visible, setVisible] = useState(true);

  // Capture latest onDone in a ref so the auto-dismiss timer doesn't
  // re-arm on every parent re-render that creates a fresh callback.
  // Without this, an inline `onDone={() => ...}` from the parent would
  // restart the 5-second timer on each parent re-render.
  const onDoneRef = useRef(onDone);
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);

  // Auto-dismiss after exactly 5 seconds. Empty deps: run once on mount,
  // tear down the timer on unmount or before re-mounting (defensive).
  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      if (onDoneRef.current) onDoneRef.current();
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  if (!visible || !hudMessages) return null;

  // Find the viewer's own row from the showdown payload. If the viewer
  // wasn't part of the hand (observer), `you` is undefined and we still
  // render the empty-state layout — actions are gated on `you.amount`
  // and the heading/hudText fall back to "".
  const you = hudMessages.find((m) => m.playerId === currentPlayerId);
  const isWinner = you?.hudText === 'YOU WON';

  // Format the amount exactly: cents precision from runShowdown()
  // (`Math.round(value * 100) / 100`), with a leading `+` for winners
  // and a `−` (en-dash, not ASCII hyphen) for losers so the net delta
  // reads at a glance. Tabular-nums keeps the dollar digits aligned.
  // Defensive guards in case amount is undefined (split-pot race, busted
  // arrival, etc.). Math.abs guards against future negative-amount
  // sources rendering as "− $-50.00" (double sign) — the in-front `+`/
  // `−` is the sole sign indicator, the printed number is always the
  // magnitude.
  const amountNum = typeof you?.amount === 'number' ? you.amount : 0;
  const sign = isWinner ? '+' : '−';
  const amountLabel = '$' + Math.abs(amountNum).toFixed(2);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="showdown-hud-heading"
    >
      {/* Revealed cards row: smaller secondary context so the amount
          doesn't lose visual dominance. Cards keep the standard
          white-rounded-rect treatment so dealt/revealed cards read as
          a deck, not as a generic text label. overflow-x-auto + max-w-full
          guard keeps the strip from pushing past the viewport edge on
          narrow viewports (6 seats × 2 cards + gaps ≈ 800px which would
          overflow a 320px viewport). */}
      <div className="flex gap-8 mb-12 overflow-x-auto max-w-full px-4">
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

      {/* BIG HUD TEXT — dominates the screen. The 5-second window is
          almost entirely about THIS number, so it grabs the eye from
          anywhere on screen.*/}
      <div
        className={`text-center leading-none ${
          isWinner ? 'text-emerald-400' : 'text-rose-400'
        }`}
      >
        <h2
          id="showdown-hud-heading"
          className="text-7xl sm:text-8xl md:text-9xl font-black uppercase tracking-tighter drop-shadow-[0_0_30px_rgba(0,0,0,0.9)]"
        >
          {you?.hudText || ''}
        </h2>

        {/* HUGE amount — the biggest single element on screen. Sign
            prefix (en-dash for losses) makes the net delta readable
            without parsing colour. tabular-nums keeps digits width-
            consistent across re-renders. mr scales with breakpoint so
            the sign has breathing room on tablets + desktop but stays
            tight on the smallest viewport. */}
        <div className="mt-6 font-black tabular-nums leading-none drop-shadow-[0_0_30px_rgba(0,0,0,0.9)] text-7xl sm:text-8xl md:text-9xl">
          <span className="opacity-70 mr-4 md:mr-8">{sign}</span>
          <span>{amountLabel}</span>
        </div>

        {you?.handDescr && (
          <div className="mt-8 text-2xl md:text-3xl text-white/80 font-semibold tracking-wide">
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
    setShowdownResult(result);   // triggers the HUD to appear
  }

  return (
    <>
      {showdownResult && (
        <ShowdownHUD
          revealed={showdownResult.revealed}
          hudMessages={showdownResult.hudMessages}
          currentPlayerId="A"
          onDone={() => setShowdownResult(null)}  // clears HUD after 5s, starts next hand
        />
      )}
    </>
  );
}
*/
