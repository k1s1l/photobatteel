import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { normalizeForTelegramPhoto, validateImage } from '../../src/modules/photos/image-validator.js';
import { makeGif, makeJpeg, makePng, makeWebp } from '../helpers/images.js';

const limits = { maxBytes: 5 * 1024 * 1024, minDimension: 320, maxDimension: 8000 };

describe('image validation', () => {
  it('accepts JPEG, PNG and WEBP and computes a stable hash', async () => {
    const jpeg = await makeJpeg();
    const result = await validateImage(jpeg, limits);
    expect(result).toMatchObject({ mimeType: 'image/jpeg', width: 800, height: 600 });
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await validateImage(jpeg, limits)).contentHash).toBe(result.contentHash);
    expect((await validateImage(await makePng(), limits)).mimeType).toBe('image/png');
    expect((await validateImage(await makeWebp(), limits)).mimeType).toBe('image/webp');
  });

  it('rejects non-images and corrupted files', async () => {
    await expect(validateImage(Buffer.from('definitely not an image'), limits)).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    await expect(validateImage(Buffer.alloc(0), limits)).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    const jpeg = await makeJpeg(1200, 900);
    const truncated = jpeg.subarray(0, Math.floor(jpeg.length / 2));
    await expect(validateImage(truncated, limits)).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
  });

  it('rejects unsupported formats', async () => {
    await expect(validateImage(await makeGif(), limits)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });

  it('enforces size and dimensions', async () => {
    await expect(validateImage(await makeJpeg(200, 200), limits)).rejects.toMatchObject({ code: 'DIMENSIONS' });
    const jpeg = await makeJpeg();
    await expect(validateImage(jpeg, { ...limits, maxBytes: 100 })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('normalizes files to a metadata-free JPEG', async () => {
    const png = await sharp({ create: { width: 4000, height: 3000, channels: 4, background: '#123456' } })
      .withExif({ IFD0: { Copyright: 'secret' } })
      .png()
      .toBuffer();
    const output = await normalizeForTelegramPhoto(png);
    const meta = await sharp(output).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(2560);
    expect(meta.exif).toBeUndefined();
  });
});
