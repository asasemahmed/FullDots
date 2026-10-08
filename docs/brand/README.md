# FullDots brand

The Dot characters are original artwork made for FullDots. The logo mark is the Hugging Face logo, downloaded from huggingface.co (`/front/assets/huggingface_logo.svg`); it is a trademark of Hugging Face, so replace it before publishing FullDots. All files have a transparent background.

| File                                                               | What it is                                                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `fulldots-logo.svg`                                                | Mark and wordmark, dark text, for light backgrounds                                          |
| `fulldots-logo-light.svg`                                          | Mark and wordmark, white "Full", for dark backgrounds                                        |
| `fulldots-mark.svg`                                                | The mark alone (also the favicon)                                                            |
| `dot-indigo.svg`, `dot-mint.svg`, `dot-coral.svg`, `dot-lilac.svg` | The Dot character in its four colourways                                                     |
| `png/`                                                             | The same artwork as transparent PNG (characters 512 x 512, mark 512 x 474, logos 1320 x 352) |

## The Dot

A round Dot with big eyes and an antenna. The tip of the antenna is a status light. In the app the character is drawn by `src/client/DotCharacter.tsx` and changes with the Dot's state:

| State       | Look                                             |
| ----------- | ------------------------------------------------ |
| idle        | Breathes slowly and blinks                       |
| working     | Bobs, looks around, the light pulses             |
| needs-input | Tilts its head, the light turns amber and blinks |
| complete    | Happy closed eyes, the light turns green         |
| paused      | Eyes closed, colours muted, the light turns grey |

Each Dot keeps the same colourway everywhere: it is chosen from the Dot's id.

## Colours

| Name   | Body      | Light     | Shade     |
| ------ | --------- | --------- | --------- |
| Indigo | `#6e7ff3` | `#b8c1ff` | `#4b58cf` |
| Mint   | `#33c49f` | `#a0f0da` | `#1b9374` |
| Coral  | `#ff8a66` | `#ffcab6` | `#de5f3c` |
| Lilac  | `#a98bf3` | `#dccfff` | `#8063d4` |

Status light: `#ffc52e` (on), `#ffb020` (needs you), `#3dd68c` (done), `#c9ccd6` (paused). Wordmark: `#242424` and `#5867e0`. The logo mark keeps its original colours.

The wordmark uses the system UI font at weight 700. In the SVG files it is live text, so the exact shape follows the fonts installed where the file is opened; the PNG files are the reference rendering.
