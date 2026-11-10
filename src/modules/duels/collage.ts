import sharp from 'sharp';

const TILE_WIDTH = 720;
const TILE_HEIGHT = 900;
const GAP = 12;
const BACKGROUND = '#111111';

/** Digits drawn as strokes: the production image has no fonts, so SVG <text> is not an option. */
const DIGIT_PATHS: Record<Digit, string> = {
  1: 'M -8 -14 L 4 -24 L 4 24',
  2: 'M -14 -12 C -12 -28 14 -28 14 -10 C 14 4 -14 12 -14 24 L 16 24',
  3: 'M -14 -20 C -6 -28 14 -28 14 -12 C 14 -2 4 0 -2 0 C 4 0 16 2 16 12 C 16 28 -6 28 -14 20',
  4: 'M 8 24 L 8 -24 L -16 10 L 18 10',
  5: 'M 14 -24 L -10 -24 L -12 -2 C 0 -10 16 -6 16 8 C 16 26 -6 28 -14 20',
  6: 'M 12 -24 C -4 -24 -14 -10 -14 8 C -14 22 -6 26 2 26 C 12 26 16 18 16 10 C 16 0 8 -4 0 -4 C -8 -4 -14 2 -14 8',
};

type Digit = 1 | 2 | 3 | 4 | 5 | 6;

function badge(digit: Digit): Buffer {
  const size = 96;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <circle cx="48" cy="48" r="44" fill="#000000" fill-opacity="0.72" stroke="#ffffff" stroke-width="4"/>
    <path transform="translate(48 48)" d="${DIGIT_PATHS[digit]}" fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  return Buffer.from(svg);
}

async function tile(image: Buffer, digit: Digit): Promise<Buffer> {
  return sharp(image, { failOn: 'truncated' })
    .rotate()
    .resize(TILE_WIDTH, TILE_HEIGHT, { fit: 'cover', position: 'attention' })
    .composite([{ input: badge(digit), top: 24, left: 24 }])
    .flatten({ background: BACKGROUND })
    .png()
    .toBuffer();
}

/**
 * One image with numbered badges, so vote buttons fit under it:
* 2 or 3 photos side by side, 4 as a 2×2 grid, 5–6 as a 3×2 grid.
 */
export async function buildDuelCollage(...images: Buffer[]): Promise<Buffer> {
  if (images.length < 2 || images.length > 6) throw new RangeError('A collage holds 2 to 6 photos');
  const tiles = await Promise.all(images.map((image, index) => tile(image, (index + 1) as Digit)));
  const columns = images.length === 4 ? 2 : Math.min(images.length, 3);
  const rows = Math.ceil(images.length / columns);
  return sharp({
    create: { width: TILE_WIDTH * columns + GAP * (columns - 1), height: TILE_HEIGHT * rows + GAP * (rows - 1), channels: 3, background: BACKGROUND },
  })
    .composite(
      tiles.map((input, index) => ({
        input,
        left: (index % columns) * (TILE_WIDTH + GAP),
        top: Math.floor(index / columns) * (TILE_HEIGHT + GAP),
      })),
    )
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}
