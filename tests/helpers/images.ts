import sharp from 'sharp';

export async function makeJpeg(width = 800, height = 600, color = '#3366ff'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg({ quality: 85 }).toBuffer();
}

export async function makePng(width = 800, height = 600, color = '#ff6633'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
}

export async function makeWebp(width = 800, height = 600): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#22aa55' } }).webp().toBuffer();
}

export async function makeGif(): Promise<Buffer> {
  return sharp({ create: { width: 400, height: 400, channels: 3, background: '#000000' } }).gif().toBuffer();
}

/** A JPEG with random noise so that every call produces a different hash. */
export async function makeUniqueJpeg(seed: number): Promise<Buffer> {
  const width = 400;
  const height = 400;
  const raw = Buffer.alloc(width * height * 3);
  let state = seed * 9301 + 49297;
  for (let i = 0; i < raw.length; i += 1) {
    state = (state * 9301 + 49297) % 233280;
    raw[i] = state % 256;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
}
