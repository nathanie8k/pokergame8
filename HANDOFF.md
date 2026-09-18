# HANDOFF.md — Poker8 Presentation Layer

## 1. File Paths and Component Names

### Table Screen
- **HTML**: `public/index.html` → `#view-table` (desktop), mobile full-felt layout
- **CSS**: `public/css/style.css` → `.view#view-table`, `.poker-table`, `.table-info`
- **JS**: `public/js/client.js` → `renderTable()`, `renderSeat()`, `populateMobileFelt()`

### Top Bar
- **HTML**: `public/index.html` → `.table-info` containing `#tableName`, `#handInfo`, `.table-actions`
- **CSS**: `public/css/style.css` → `.table-info`, `.table-actions`
- **JS**: `updateTopBar()` for player/points chips (in top-bar, not table-info)

### Header
- **Element**: `.table-info` containing `<h2 id="tableName">` and `<span id="handInfo">`
- **CSS custom property**: `--header-height: 40px` (on `.table-info`)

### Scaling Root
- **Element**: `.poker-table` (desktop), `#view-table` flex column (mobile)
- **CSS**: `aspect-ratio: 1.2 / 1` (desktop), `aspect-ratio: 4 / 5` (mobile)
- **Desktop sizing**: `max-height: calc(100dvh - var(--header-height, 40px) - 80px)`
- **Mobile sizing**: `flex: 1 1 0; min-height: 0; max-height: 100%`

### Seat Component
- **JS function**: `renderSeat(seat, idx, table, total)` in `client.js`
- **HTML output**: `<div class="seat" data-slot="N" data-seat-idx="N">` containing `.seat-ring`
- **CSS**: `public/css/style.css` → `.seat`, `.seat-ring`, `.seat .cards`

### Card Component
- **JS function**: `renderCard(c, opts)` in `client.js`
- **HTML structure**:
  ```html
  <div class="card-flip [small] [face-down]">
    <div class="card-face front [card-red]">
      <div class="card-content">
        <!-- rank, suit, center-suit -->
      </div>
    </div>
    <div class="card-face back">
      <!-- purple back design -->
    </div>
  </div>
  ```
- **CSS**: `public/css/style.css` → `.card-flip`, `.card-face`, `.card-face.front`, `.card-face.back`

### HoleCards Component
- **JS function**: `renderHoleCards(opts)` in `client.js`
- **HTML output**: `<div class="hole-cards [hole-cards-small]" data-seat-idx="N">`
- **CSS**: `public/css/style.css` → `.hole-cards`, `.hole-cards-label`

### Own-Hand Zone
- **HTML**: `public/index.html` → `#ownHandZone` containing `#ownHandCards`
- **CSS**: `public/css/style.css` → `.own-hand-zone`
- **JS**: Populated in `renderTable()` → `renderHoleCards({ faceUp: true, cards: selfSeat.holeCards, small: true })`

---

## 2. Card and HoleCards Prop Signatures

### `renderCard(c, opts)`
```javascript
function renderCard(c, opts = {}) {
  // c: { rank: number, suit: 's'|'h'|'d'|'c' } | null (for face-down placeholder)
  // opts.faceDown: boolean - force face-down (implied when c is null)
  // opts.small: boolean - use small card dimensions (--card-w-sm/--card-h-sm)
  // opts.showdown: boolean - add card-showdown class for showdown styling
  // opts.flip: boolean - add card-deal class for deal animation
  // opts.faceUp: boolean | undefined - EXPLICIT face-up state (pure prop)
  //   - faceUp === false → face-down
  //   - faceUp === true && c !== null → face-up
  //   - faceUp === undefined → derived from faceDown/c (backwards compatible)
  //
  // faceUp is a PURE PROP: the component never decides visibility from
  // seat index, "is me", game phase, or anything else. All such decisions
  // live in the caller.
}
```

### `renderHoleCards(opts)`
```javascript
function renderHoleCards(opts = {}) {
  // opts.faceUp: boolean - controls whether cards are face-up or face-down
  // opts.cards: array of {rank, suit} | null - card data (2 cards max)
  // opts.label: string | null - optional label above cards
  // opts.small: boolean - use small card dimensions
  // opts.seatIdx: number | null - seat index for data attribute
  //
  // Renders two Card components. If cards is null/undefined or doesn't
  // have exactly 2 elements, renders two face-down placeholders.
}
```

---

## 3. Flip Animation Duration Constant

- **CSS custom property**: `--card-flip-duration: 400ms` (in `:root`)
- **Location**: `public/css/style.css`, line ~950 (in the Card component CSS section)
- **Usage**: `transition: transform var(--card-flip-duration) var(--ease)` on `.card-face`
- **Reduced motion**: When `prefers-reduced-motion: reduce`, switches to instant cross-fade (opacity transition, no 3D transform)

---

## 4. CSS Custom Properties for Sizing

### Header
- `--header-height: 40px` on `.table-info` — exposed for table layout to consume

### Card Geometry (pre-existing)
- `--card-w: 64px` — standard card width
- `--card-h: 92px` — standard card height
- `--card-w-sm: 40px` — small card width (for seat displays)
- `--card-h-sm: 56px` — small card height

### Card Flip (new)
- `--card-flip-duration: 400ms` — flip animation duration

### Table Sizing (updated)
- Desktop `.poker-table`: `max-height: calc(100dvh - var(--header-height, 40px) - 80px)`
- Mobile `#view-table`: `height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))`

---

## 5. Where `faceUp` Is Currently Computed for Each Render Site

### Community Cards
- **Location**: `renderTable()` → `renderCard(c, { delay: i * 80, flip: true })`
- **faceUp**: Always face-up (community cards are always visible)
- **Computed by**: Caller (renderTable) — always passes face-up cards

### Per-Seat Displays (Desktop)
- **Location**: `renderSeat()` → `renderHoleCards({ faceUp: seatFaceUp, ... })`
- **faceUp computation**:
  ```javascript
  var isShowdownReveal = table.phase === 'hand_over' && table.lastHandResults && !seat.folded && !seat.isSelf;
  var seatFaceUp = isShowdownReveal && seat.holeCards && seat.holeCards.length > 0;
  ```
- **Logic**: Face-up ONLY during showdown reveal for non-folded, non-self seats with populated holeCards. Otherwise face-down.

### Own Hand — Bottom Zone (C1)
- **Location**: `renderTable()` → `renderHoleCards({ faceUp: true, cards: selfSeat.holeCards, small: true })`
- **faceUp**: Always `true` when cards are available
- **Visibility**: Zone hidden when selfSeat or holeCards not available

### Own Hand — Self Panel (Desktop, mobile-only)
- **Location**: `populateSelfCards()` → `renderCard(c, { delay: i * 80 })`
- **faceUp**: Always face-up (uses new renderCard which defaults to face-up when c is provided)
- **Note**: Self-panel is `display:none` on desktop; visible only on mobile

### Mobile Hole Cards (Full-Felt Center)
- **Location**: `populateMobileFelt()` → `renderCard(c, { delay: i * 80 })`
- **faceUp**: Always face-up for own cards
- **Mobile card backs**: Separate `#mfcHoleCardsBack` element renders purple back graphics via `el('div', { class: 'mfc-card-back' })`

### Showdown Modal
- **Location**: `populateShowdownModal()` → `renderCard(c, { small: true, delay: i * 80 })`
- **faceUp**: Always face-up (showdown reveals all cards)

---

## 6. What the Server Currently Sends About Other Players' Hole Cards

### Message Shape
The server sends `table_state` events with a `table` object containing:
```javascript
{
  seats: [
    {
      occupied: boolean,
      isSelf: boolean,
      holeCards: [{ rank: number, suit: string }] | undefined,
      // ... other seat properties
    }
  ],
  phase: 'waiting' | 'pre_flop' | 'flop' | 'turn' | 'river' | 'showdown' | 'hand_over',
  lastHandResults: {
    winners: [{ id: string, name: string, handName: string, share: number }],
    // ...
  } | null,
  // ...
}
```

### When Opponents' Cards Are Revealed
1. **Pre-showdown**: Opponents' `holeCards` are NOT populated in the public view. The client receives `holeCards: undefined` for opponents.
2. **Showdown window** (`phase === 'hand_over'` with `lastHandResults`):
   - The server populates `holeCards` for ALL non-folded seats (including opponents)
   - The client renders these as face-up via the `isShowdownReveal` logic in `renderSeat()`
3. **Folded seats**: Stay face-down (muck) — `holeCards` may or may not be populated, but the client checks `seat.folded` before showing

### Quote from client.js (renderSeat)
```javascript
// Cards: real faces whenever the server has populated `seat.holeCards`,
// face-down card backs otherwise. The server's publicView populates this
// for (a) the seat's owner in any phase, and (b) every non-folded seat
// during the showdown window (hand_over + lastHandResults) so all
// viewers can see everyone else's hole cards after the betting ends.
// Folded seats stay face-down (the muck).
var isShowdownReveal = table.phase === 'hand_over' && table.lastHandResults && !seat.folded && !seat.isSelf;
var seatFaceUp = isShowdownReveal && seat.holeCards && seat.holeCards.length > 0;
```

---

## 7. Ambiguities Raised and Resolutions

### Conflict 1: Top Bar vs. Bottom Action Bar Scaling
**Question**: Should the 3-dot menu (top bar) and action buttons/raise slider (bottom) scale with the table?
**Resolution**: **Table-anchored elements scale, top bar and bottom action bar stay fixed chrome.** The menu lives in the header (fixed zone), and the action bar is bottom-anchored chrome. Scaling them with the table would move them out of their fixed zones.

### Conflict 2: Own Seat Hole Card Display
**Question**: Should the current user's own seat show (i) nothing, (ii) face-down backs as placeholder, or (iii) duplicate face-up pair?
**Resolution**: **Face-down backs at own seat as a presence indicator.** The real readable hand lives in the bottom-anchored own-hand zone (`#ownHandZone`). This avoids duplicate displays and clearly separates "my hand" (bottom zone) from "seat presence" (around the table).

### Leave Confirmation
**Question**: The existing Leave button had no confirmation step. Should the menu's Leave item add one?
**Resolution**: **No confirmation added.** The existing Leave button had no confirmation, so the menu's Leave item calls the same handler without modification. Flagged in report: a mis-tap now loses the seat (same risk as before).

### Mobile Scope
**Question**: Should mobile also get the overflow menu?
**Resolution**: **Mobile is NOT in scope for this prompt.** Mobile already has visible Sit out/Leave buttons in the `.mfsr-right` pill row. The overflow menu change applies only to desktop. Mobile menu infrastructure (`#mfsrTableMenu`) is updated for ARIA consistency but functionally unchanged.

---

## 8. Anything Touched That This Prompt Did Not Anticipate

### 1. Pointerdown Outside-Dismiss (Work item 1)
Changed the outside-dismiss handler from `click` to `pointerdown` as required by the spec. This prevents stray actions when a press begins outside the menu. The existing click handler also remains for backwards compatibility with other click-based interactions.

### 2. ARIA Attribute Fix (Work item 1)
Changed `aria-haspopup="true"` to `aria-haspopup="menu"` on both desktop and mobile menu buttons. The value `"true"` is not valid per ARIA spec; `"menu"` is the correct value for a menu popup.

### 3. Touch Target Size (Work item 1)
Increased the 3-dot menu button from 34×34px to 44×44px to meet the minimum 44×44 CSS px touch target requirement. This affects both desktop and mobile menu buttons.

### 4. Focus Management (Work item 1)
Added focus management to `setTableMenuOpen()`:
- On open: focus moves to the first menu item
- On close: focus returns to the trigger button
- Added keyboard navigation (ArrowUp/ArrowDown/Enter/Space) for menu items

### 5. Desktop Button Visibility (Work item 1)
Added CSS to hide `#sitOutBtn` and `#leaveTableBtn` on desktop (`#view-table` context). These buttons remain visible on mobile (not in `#view-table` desktop context).

### 6. Header Font Size Reduction (Work item 2)
Reduced title from 22px to 12px (~45% reduction) and subtitle from 12px to 7px (proportional). Tightened margin-bottom from 18px to 10px.

### 7. Mobile Header Sync (Work item 2)
Updated mobile `#view-table .table-info h2` from 13px to 12px and `.muted` from 9px to 7px to match the desktop reduction.

### 8. Table Max-Height Update (Work item 3)
Changed desktop `.poker-table` max-height from `60vh` to `calc(100dvh - var(--header-height, 40px) - 80px)` to allow the table to consume freed vertical space. Uses `dvh` for mobile browser chrome awareness.

### 9. Card Component Structure (Work item 4)
Completely rewrote `renderCard()` to use the new 3D flip structure with both faces rendered. The function is backwards-compatible: existing callers work without changes, but now support the new `faceUp` prop for explicit face-up control.

### 10. HoleCards Component (Work item 4)
Added new `renderHoleCards()` function for rendering pairs of cards with a unified `faceUp` prop. Used for per-seat displays and the own-hand zone.

### 11. Own-Hand Zone (Work item 4)
Added new `#ownHandZone` HTML element below the seats container, populated in `renderTable()` when the player has hole cards. Hidden by default, shown only when cards are available.

### 12. Per-Seat Display Update (Work item 4)
Changed `renderSeat()` to use `renderHoleCards()` instead of directly rendering card elements. Own seat renders face-down backs (presence indicator), opponents render face-down normally and face-up during showdown reveal.
