import sharp from 'sharp';

const TILE_WIDTH = 720;
const TILE_HEIGHT = 900;
const GAP = 12;
const BACKGROUND = '#111111';

/** Digits drawn as strokes: the production image has no fonts, so SVG <text> is not an option. */
const DIGIT_PATHS: Record<1 | 2, string> = {
  1: 'M -8 -14 L 4 -24 L 4 24',
  2: 'M -14 -12 C -12 -28 14 -28 14 -10 C 14 4 -14 12 -14 24 L 16 24',
};

function badge(digit: 1 | 2): Buffer {
  const size = 96;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <circle cx="48" cy="48" r="44" fill="#000000" fill-opacity="0.72" stroke="#ffffff" stroke-width="4"/>
    <path transform="translate(48 48)" d="${DIGIT_PATHS[digit]}" fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  return Buffer.from(svg);
}

async function tile(image: Buffer, digit: 1 | 2): Promise<Buffer> {
  return sharp(image, { failOn: 'truncated' })
    .rotate()
    .resize(TILE_WIDTH, TILE_HEIGHT, { fit: 'cover', position: 'attention' })
    .composite([{ input: badge(digit), top: 24, left: 24 }])
    .flatten({ background: BACKGROUND })
    .png()
    .toBuffer();
}

/** Puts two photos side by side with "1" and "2" badges — one image, so vote buttons fit under it. */
export async function buildDuelCollage(first: Buffer, second: Buffer): Promise<Buffer> {
  const [left, right] = await Promise.all([tile(first, 1), tile(second, 2)]);
  return sharp({ create: { width: TILE_WIDTH * 2 + GAP, height: TILE_HEIGHT, channels: 3, background: BACKGROUND } })
    .composite([
      { input: left, top: 0, left: 0 },
      { input: right, top: 0, left: TILE_WIDTH + GAP },
    ])
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}
