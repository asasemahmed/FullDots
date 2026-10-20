# FullDots brand

The logo and the penguin Dots are original artwork made for FullDots. All files have a transparent background.

| File                                                                                | What it is                                                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `fulldots-logo.svg`                                                                 | Mark and wordmark, dark text, for light backgrounds                                   |
| `fulldots-logo-light.svg`                                                           | Mark and wordmark, white "Full", for dark backgrounds                                 |
| `fulldots-mark.svg`                                                                 | The mark alone (also the favicon)                                                     |
| `dot-indigo.svg`, `dot-mint.svg`, `dot-coral.svg`, `dot-lilac.svg`, `dot-amber.svg` | The penguin Dot in all five species, each with its own colour and gear                |
| `png/`                                                                              | The same artwork as transparent PNG (characters and mark 512 x 512, logos 1200 x 288) |
| `penguin-preview.html`                                                              | A page to try every species, colour, gear and state, and export them                  |

Every file here is drawn by `npm run brand` from the same code as the app (`src/client/penguin/engine.ts`). Run it after changing the penguin or the palettes.

## The Dot

Every Dot is a round penguin. Its colour, species and gear make it recognisable; all three are chosen in the Dot's settings. A Dot that has not chosen gets a colour and a species from its id, and wears nothing.

| Species    | Mark                             |
| ---------- | -------------------------------- |
| Emperor    | Golden ear patches               |
| Adélie     | Dark face with white eye rings   |
| Rockhopper | Yellow brows                     |
| Macaroni   | An orange crest                  |
| Chick      | A softer colour and a small tuft |

Gear: none, headphones, glasses, beanie, scarf or bow tie.

In the app the penguin is drawn by `src/client/DotCharacter.tsx`, animated by `src/client/penguin/live.ts`, and its state picks the effect. The three-dot effects follow [bloub](https://github.com/jeremy-prt/bloub) (MIT): the body becomes the middle dot, two more slide out of its sides, and a wave runs through them.

| State       | Look                                                                   |
| ----------- | ---------------------------------------------------------------------- |
| idle        | Breathes, blinks; large characters watch the pointer                   |
| thinking    | Turns into three dots; a pulse runs through them                       |
| working     | Three dots hop in turn, like a chat typing indicator (writing a reply) |
| using-tool  | Focused eyes scan the work, flippers tap                               |
| needs-input | Looks up at an amber badge that pops out of a notch in its head        |
| complete    | Bursts into confetti once, comes back smiling with a green badge       |
| paused      | Shrinks to a small grey dot that slowly breathes                       |
| handing-off | Looks right and passes a small dot along                               |
| receiving   | Looks up and catches a small dot                                       |
| reviewing   | Narrowed eyes read slowly from side to side                            |
| stopped     | Greyed, eyes shut, still                                               |

A change of state blends from the frame on screen. Characters animate only while on screen, and with reduced motion each state is drawn once, at rest.

## Colours

| Name   | Body      | Light     | Shade     |
| ------ | --------- | --------- | --------- |
| Indigo | `#6e7ff3` | `#b8c1ff` | `#4b58cf` |
| Mint   | `#33c49f` | `#a0f0da` | `#1b9374` |
| Coral  | `#ff8a66` | `#ffcab6` | `#de5f3c` |
| Lilac  | `#a98bf3` | `#dccfff` | `#8063d4` |
| Amber  | `#f2ab2e` | `#ffe0a0` | `#c27d0a` |
| Sky    | `#4aaee8` | `#b4e2ff` | `#2380bd` |
| Rose   | `#ee6a98` | `#ffc4d9` | `#c93f72` |
| Moss   | `#7bab55` | `#cfe9b6` | `#568736` |
| Ink    | `#2b3040` | `#c3c8d6` | `#1a1d28` |

Badges: `#ffb020` (needs you), `#3dd68c` (done). Beak and feet `#ff9d2e`, eyes `#171a26`. Wordmark: `#242424` and `#5867e0`.

The wordmark uses the system UI font at weight 700. In the SVG files it is live text, so the exact shape follows the fonts installed where the file is opened; the PNG files are the reference rendering.
