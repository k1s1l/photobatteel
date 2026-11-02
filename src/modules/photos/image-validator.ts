import { createHash } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import { DomainError } from '../../lib/errors.js';

export const SUPPORTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const FORMAT_TO_MIME: Record<string, (typeof SUPPORTED_MIME_TYPES)[number]> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** Telegram limits for sendPhoto: width + height <= 10000, aspect ratio <= 20. */
const TELEGRAM_MAX_SIDE_SUM = 10_000;
const TELEGRAM_MAX_RATIO = 20;
/** Side length used when re-encoding images received as files. */
const NORMALIZED_MAX_SIDE = 2560;

export interface ImageLimits {
  maxBytes: number;
  minDimension: number;
  maxDimension: number;
}

export interface ValidatedImage {
  mimeType: (typeof SUPPORTED_MIME_TYPES)[number];
  width: number;
  height: number;
  size: number;
  /** SHA-256 of the original bytes — used to reject duplicate submissions. */
  contentHash: string;
}

export function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Verifies that the bytes are a real, fully decodable JPEG/PNG/WEBP image
 * within the configured size and dimension limits.
 */
export async function validateImage(buffer: Buffer, limits: ImageLimits): Promise<ValidatedImage> {
  if (buffer.length === 0) throw new DomainError('INVALID_IMAGE');
  if (buffer.length > limits.maxBytes) {
    throw new DomainError('FILE_TOO_LARGE', { maxMb: Math.round(limits.maxBytes / 1024 / 1024) });
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'error' }).metadata();
  } catch {
    throw new DomainError('INVALID_IMAGE');
  }

  const mimeType = metadata.format ? FORMAT_TO_MIME[metadata.format] : undefined;
  if (!mimeType) throw new DomainError('UNSUPPORTED_FORMAT');
  if ((metadata.pages ?? 1) > 1) throw new DomainError('UNSUPPORTED_FORMAT'); // animated images

  const { width, height } = metadata;
  if (!width || !height) throw new DomainError('INVALID_IMAGE');
  if (Math.min(width, height) < limits.minDimension || Math.max(width, height) > limits.maxDimension) {
    throw new DomainError('DIMENSIONS', { min: limits.minDimension, max: limits.maxDimension });
  }
  if (Math.max(width, height) / Math.min(width, height) > TELEGRAM_MAX_RATIO) {
    throw new DomainError('DIMENSIONS', { min: limits.minDimension, max: limits.maxDimension });
  }

  // A full decode catches truncated or corrupted files that still have valid headers.
  try {
    await sharp(buffer, { failOn: 'truncated' }).resize(64, 64, { fit: 'inside' }).raw().toBuffer();
  } catch {
    throw new DomainError('INVALID_IMAGE');
  }

  return { mimeType, width, height, size: buffer.length, contentHash: hashBuffer(buffer) };
}

/**
 * Converts an image received as a file into a JPEG suitable for sendPhoto:
 * applies EXIF orientation, strips metadata (including GPS), and fits Telegram limits.
 */
export async function normalizeForTelegramPhoto(buffer: Buffer): Promise<Buffer> {
  const pipeline = sharp(buffer, { failOn: 'truncated' })
    .rotate()
    .resize(NORMALIZED_MAX_SIDE, NORMALIZED_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90, mozjpeg: true });
  const output = await pipeline.toBuffer({ resolveWithObject: true });
  if (output.info.width + output.info.height > TELEGRAM_MAX_SIDE_SUM) throw new DomainError('DIMENSIONS', { min: 0, max: NORMALIZED_MAX_SIDE });
  return output.data;
}
