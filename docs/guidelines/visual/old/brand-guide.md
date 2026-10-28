# LoJuBets brand guide & design system

LoJuBets is a small, friendly app for settling arguments between friends, one **lonkero** at a time. The look is taken straight from the pineapple can: **sunny yellow, deep navy, leaf green**, round shapes, lots of air.

This guide is the rulebook. The code that implements it is:

| What | Where |
| --- | --- |
| Tokens (colors, type, space, shape), the single source of truth | [`src/design/tokens.css`](../src/design/tokens.css) |
| Base styles and components | [`src/design/base.css`](../src/design/base.css), [`components.css`](../src/design/components.css) |
| Living style guide (every component, in light and dark) | the `/styleguide` page of the running app |
| Enforcement of the contrast rules below | [`src/design/contrast.test.ts`](../src/design/contrast.test.ts) (`npm test`) |

If a screen needs something the system doesn't have, add it to the system first (token or component, plus an entry here and on `/styleguide`), then use it. Don't style one-offs on a page.

---

## 1. Personality and voice

**Friendly rivalry.** Warm, quick, a bit cheeky, never snarky or mean. People are betting against friends, so losing should feel funny, not humiliating.

- Say **lonkero** (plural **lonkeros**). Never "beer". Count with the `lonkeros(n)` helper so it reads "1 lonkero", "3 lonkeros".
- **Sentence case** everywhere ("Propose bet", not "Propose Bet"). Short sentences. Address the user as "you".
- Be specific over clever: "Waiting for Sam's guess", not "Hold tight!".
- Playfulness goes in the *moments* (winning, an all-in, an empty state), not in labels people need to read quickly.
- **No emoji in the interface chrome** (buttons, tabs, headings, status). Use the icon set (section 8). Emoji are fine inside text people write themselves.
- Errors say what happened and what to do, in plain words. Never blame the user.

## 2. The can and the wordmark

The pineapple can is our logo mark; **LoJuBets** set in the display font is our wordmark. There is no other logo.

- **Files:** use the transparent PNGs from `icons/` (`can-64.png` / `can-256.png` in `public/` for the app). Never redraw it or rebuild it from shapes.
- **Clear space:** keep at least **half a can-width** free on every side.
- **Minimum size:** 24 px tall in UI, 16 px in a favicon (use the supplied favicon files).
- **Backgrounds it works on:** navy, cream, white, leaf green (see `icons/previews/background-variants.png`).
- **Never** place it on pineapple yellow (the can disappears; put it on a navy or white tile instead), and never recolor, crop, stretch, rotate, outline or add shadows to it.
- **Wordmark:** Fredoka 700, camel-case "LoJuBets" (capital L, J and B), in **yellow on navy** or **navy on light**. Never green, never all-caps, never with the can's emoji.
- The can appears **once per screen**, as an anchor (masthead, hero or welcome), not as decoration or wallpaper.

## 3. Color

### 3.1 The palette

| Name | Token | Hex | RGB | Role |
| --- | --- | --- | --- | --- |
| **Pineapple** (yellow) | `--yellow-500` | `#FDD815` | 253, 216, 21 | Action and attention |
| **Navy** | `--navy-900` | `#082754` | 8, 39, 84 | Ink and structure; the brand's "black" |
| **Leaf** (green) | `--green-500` | `#4D9942` | 77, 153, 66 | Success, "you're owed", verified |

Supporting colors (always derived from the three above, never new hues):

| Token | Hex | Used for |
| --- | --- | --- |
| `--cream-50` | `#FFFBEB` | Page background (light mode) |
| `--cream-100` | `#FFF3CE` | Warm tinted panels (from the icon set) |
| `--navy-800` / `--navy-700` | `#0E3366` / `#1B4276` | Raised surfaces in dark mode |
| `--navy-600` | `#4A5E80` | Muted text on light |
| `--navy-500` | `#5F7396` | Control borders on light |
| `--navy-200` / `--navy-100` | `#C9D2E1` / `#E7EBF2` | Hairlines, quiet fills |
| `--yellow-300` / `--yellow-600` | `#FEE766` / `#E0BC00` | Hover / pressed yellow |
| `--green-700` | `#2E6B26` | **Green used as text** on light surfaces |
| `--green-300` | `#8FD085` | Green text on navy |
| `--green-100` | `#E3F1E0` | Green tint backgrounds |

**One functional color, not a brand color:** `--signal-700` `#B3261E` (and `--signal-300` on navy, `--signal-100` tint) is for **errors and destructive confirmation only**. Never use it for decoration, and never use it for "you owe" (owing is part of the game, not a failure).

### 3.2 Roles, proportions, and what each color *means*

Use the **role tokens** (`--action-bg`, `--text`, `--surface-card` ...), never the raw palette, in components. Roles are what make dark mode work.

Rough proportions of any screen: **~60% light neutrals** (cream/white) or navy canvas in dark mode, **~30% navy** (text, masthead, tab bar, borders), **~8% yellow**, **~2% green**. Yellow is precious: if more than one thing on a screen is shouting in yellow, nothing is.

| Color | Means | Examples |
| --- | --- | --- |
| **Yellow** | "Do this" / "look here" | The one primary button; the active tab; "your move" highlight; owing-balance chip; selected option |
| **Navy** | Structure and text | All body text, headings, borders, the masthead and tab bar, secondary buttons |
| **Green** | Good news | "You won", "owes you", verified email, success confirmations |
| **Signal red** | Something went wrong | Error messages; the destructive confirmation of an all-in |

### 3.3 Pairings (measured contrast, WCAG 2.2)

These numbers are enforced by `contrast.test.ts`. "Large" means 24 px, or 18.66 px bold.

| Foreground on background | Ratio | Allowed for |
| --- | --- | --- |
| Navy on yellow | **10.5** | Everything: the primary button's label |
| Navy on white / cream-50 | 14.7 / 14.2 | Everything: body text |
| Yellow on navy | **10.5** | Everything: wordmark, headlines and active states on navy |
| Cream-50 on navy | 14.2 | Everything: text on masthead, hero, dark mode |
| Muted navy-600 on cream-50 / white | 6.3 / 6.5 | Secondary text |
| Leaf-700 on white / cream-50 | 6.5 / 6.2 | Green text (small ok) |
| Leaf-700 on green-100 | 5.5 | Positive chips |
| **Navy on leaf green** | **4.2** | **Large text and graphics only** |
| **White on leaf green** | **3.5** | **Never for text** |
| **Leaf green on white / cream** | **3.4-3.5** | **Graphics and large text only**; small green text must be Leaf-700 |
| **Yellow on white / cream** | **1.4** | **Never** as text, border or icon on a light surface |
| Signal-700 on white / cream-50 | 6.3-6.5 | Error text |

The practical rules that fall out of this:

1. **Yellow never touches light surfaces as a line or text.** On light backgrounds, yellow is only ever a *filled shape with a navy label*, and that shape gets a navy border so it has a visible edge.
2. **Green text on light surfaces is always Leaf-700.** The bright brand green is for fills, icons and large display type.
3. **Text on bright green fills is navy and large.** For small labels on a green idea, use a green-100 tint with Leaf-700 text instead.
4. **Control borders are `--border-control`** (at least 3:1 against the surface); hairlines (`--border`) are only for decorative card edges.
5. **No gradients, no transparency tricks, no new tints.** If you need a lighter version of a color, use a token from the supporting set.
6. **Never rely on color alone.** Win/lose/owe also carry words or an icon.

### 3.4 Dark mode

Dark mode makes **navy the canvas**: the brand color becomes the background, text flips to cream, yellow stays yellow (it's even stronger on navy), green shifts to Leaf-300, signal red to Signal-300. It follows the device setting; there's no in-app switch. Only role tokens change, so components never need dark-mode overrides.

## 4. Typography

Two families, both open-source and **self-hosted** (no third-party requests):

| Family | Weights | Used for |
| --- | --- | --- |
| **Fredoka** (variable) | 500-700 | Wordmark, headings, buttons, big numbers |
| **Inter** (variable) | 400-700 | Everything else: body, forms, labels, captions |

| Style | Size / line height | Font | Use |
| --- | --- | --- | --- |
| Display | 36 / 1.1 | Fredoka 700 | Hero headlines, the big lonkero count. Once per screen at most |
| H1 | 28 / 1.15 | Fredoka 700 | Page title |
| H2 | 20 / 1.25 | Fredoka 600 | Section titles |
| H3 | 17 / 1.3 | Inter 700 | Card titles, list item titles |
| Body | 16 / 1.5 | Inter 400 | Default text. **16 px is the floor for inputs** (iOS zooms below it) |
| Small | 14 / 1.4 | Inter 400/500 | Secondary text, hints |
| Caption | 12 / 1.3 | Inter 700, uppercase, +8% tracking | Eyebrow labels above sections. The only all-caps in the system |

Rules:

- **Max two families, max three sizes per screen** (title, body, small) plus at most one display.
- **Sentence case.** No title case, no all-caps except the Caption style.
- **Line length** 45-75 characters; the 520 px content width gives this naturally. Don't stretch text across wide screens.
- **Numbers** use tabular figures (`font-variant-numeric: tabular-nums`) so balances don't jiggle.
- **Weight carries emphasis** (500/700), not italics, underline or color. Links are underlined.
- Fredoka is for *voice*, Inter is for *reading*: never set paragraphs, form fields or error messages in Fredoka.
- Don't letter-space lowercase text; don't go below 12 px anywhere.

## 5. Space and layout (negative space)

Space is a feature of the brand: the can sits in a lot of yellow, and our screens should breathe the same way. **When in doubt, add space, and remove something.**

**The grid is 4 px.** Only these values exist (`--space-1` ... `--space-9`):
`4, 8, 12, 16, 24, 32, 48, 64, 96`.

**Proximity tells the story.** The closer two things are, the more related they are:

| Relationship | Space |
| --- | --- |
| Label and its field; icon and its text | 4-8 |
| Items inside one card or list row | 8-12 |
| Cards in a list; fields in a form | 12-16 |
| Between groups (e.g. "Your move" vs "In play") | **32** |
| Screen edge to content (gutter) | **16** (24 from 480 px up) |
| Hero / empty-state top and bottom breathing room | **48-96** |

Rules:

1. **One primary action per screen**, in yellow. Give it room: at least 24 px above it.
2. **Group, don't box.** Don't put every cluster in a bordered card; use space first, a card only when something is tappable or needs a clear edge.
3. **Cards have 16-20 px of padding** and never touch each other (12+ px gap).
4. **Empty states are roomy**, with the can, one sentence and one action, centered with 48+ px around them.
5. **Don't fill the screen.** A screen with three things and generous space beats one with eight things squeezed. Move the rest behind a tap.
6. **Content width is 520 px max**, centered, on any viewport; the layout never gets wider, only the margins do.
7. **Touch targets are at least 48 x 48 px** with 8 px between neighbors.
8. **Respect the safe areas** (notch, home indicator): the masthead and tab bar add the device insets to their own padding.
9. Align to one left edge. Center only heroes, empty states and the can.

## 6. Shape, borders and elevation

- **Round, like a can.** Radii: 8 (small chips), 14 (inputs), 20 (cards), **pill** (buttons, chips, tabs). Don't mix sharp corners in.
- **Borders are 2 px** on controls (buttons, inputs, chips) in a color that meets 3:1; **1 px hairlines** on cards.
- **Elevation is flat** except for one move: buttons sit on a hard 3 px navy "shadow" (like a can on a table) that disappears when pressed. No blurred drop shadows anywhere.
- **The wave:** a single navy-yellow wave edge, echoing the stripes on the can, closes the hero and the masthead. It's the only decorative graphic. Don't add more patterns.

## 7. Components

All live on `/styleguide`. Summary of the rules:

**Buttons** (Fredoka 600, 17 px, 48 px tall, pill)
- **Primary:** yellow fill, navy label, 2 px navy border, navy hard shadow. *One per screen.*
- **Secondary:** card fill, navy label, 2 px navy border.
- **Danger / all-in:** navy fill, yellow label (the all-in is a dare, not an error). Only the *confirmation dialog* uses signal red.
- Labels are verbs: "Propose bet", "Lock in my guess". Disabled = 50% opacity and no shadow.

**Inputs:** card fill, 2 px `--border-control`, radius 14, 48 px tall, 16 px text. Focus = navy border plus a yellow halo (3 px), never just a color change. Label above in Small/500; hint below in Small/muted. Errors: signal text with an icon, below the field.

**Cards:** `--surface-card`, 1 px hairline, radius 20, 16-20 px padding. A tappable card shows a chevron or has a clear title; "your move" cards get a yellow 2 px navy-bordered badge, not a colored background.

**Interpretation preview:** whenever the app turns free text into a value (durations today), it echoes the result under the field as **"= 3 months and 2 days (92 days in total)"**, with every unit spelled out and the converted total when units had to be converted. It lives in the field's **helper-text slot and replaces the hint** while the user types; the slot has one fixed height, so the form never jumps. If the input is genuinely ambiguous (a bare `m`, which means minutes), the slot turns yellow and adds a one-line fix. Never abbreviate units in confirmations ("= 92 d"); the same goes for durations anywhere else in the UI ("2 hours", not "2 h").

**Chips and pills:** radius pill, 12-14 px text, Inter 700. Positive = green-100 + Leaf-700; owing / "your move" = yellow + navy; neutral = navy-100 + navy.

**Banners:** one line of meaning plus an icon. Win = green, owing/attention = yellow, error = signal. Always text + icon, never color alone.

**Masthead** (authenticated screens): navy, safe-area padded, can (28 px) + wordmark in yellow, left-aligned. **Tab bar:** navy; inactive icons and labels in muted cream, **active in yellow** with a yellow pill behind the icon. Three tabs max.

**Avatars:** circle; with no picture, initials in Fredoka on navy with yellow text.

**Hero** (login, invitation): navy full-bleed, can, display headline in yellow or cream, one sentence, wave edge into the page. Nothing else.

## 8. Icons and imagery

- **Icons** are a custom set on a 24 px grid: 2 px stroke, round caps and joins, no fill, `currentColor`. They inherit the text color, so they work on every surface and in dark mode. See `src/components/Icon.tsx`.
- Icon next to text is 20 px with 8 px gap; standalone in a tab bar 24 px.
- **No emoji as UI.** No stock photos, no illustrations beyond the can.
- Avatars are the only user-supplied imagery.

## 9. Motion

Quiet and quick: **150 ms**, `cubic-bezier(0.2, 0.7, 0.2, 1)`, for hover, press, focus and chip selection. The button "presses" 3 px down. Nothing bounces, loops or auto-plays. With `prefers-reduced-motion`, durations drop to 0.

## 10. Accessibility

- All text meets **WCAG 2.2 AA** (4.5:1; 3:1 for large text), as tabulated in 3.3. Most pairings are AAA.
- UI components and graphics meet **3:1** against their surroundings (hence navy borders on yellow buttons).
- **Visible focus** on every interactive element: 2 px navy (yellow in dark mode) outline with a halo.
- Targets 48 px; text can scale (sizes are `rem`); layout holds at 200% zoom.
- State is never conveyed by color alone; icons are decorative (`aria-hidden`) when beside text and labelled when alone.
- Respect `prefers-color-scheme` and `prefers-reduced-motion`.

## 11. Working with the system

- Use **role tokens** in components; raw palette tokens (`--yellow-500`) appear only in `tokens.css`.
- Spacing, radii and sizes come from tokens. If you reach for a number that isn't on the scale, redesign instead.
- Add or change a component by (1) editing `components.css`, (2) adding it to `/styleguide`, (3) updating section 7.
- Changing a color? Edit `tokens.css`, then run `npm test`: the contrast tests will tell you if a pairing stopped being legal.
