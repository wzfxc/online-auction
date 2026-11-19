import sharp, { type Sharp } from 'sharp';
import { PHOTO_PREVIEW_WIDTH, type PhotoContentType } from '@auction/shared';

const FORMAT_TO_TYPE: Record<string, PhotoContentType> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};
const MAX_INPUT_PIXELS = 50_000_000;

function hasMagicBytes(input: Buffer, declaredType: PhotoContentType): boolean {
  if (declaredType === 'image/jpeg') {
    return input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff;
  }
  if (declaredType === 'image/png') {
    return (
      input.length >= 8 &&
      input[0] === 0x89 && input[1] === 0x50 && input[2] === 0x4e && input[3] === 0x47 &&
      input[4] === 0x0d && input[5] === 0x0a && input[6] === 0x1a && input[7] === 0x0a
    );
  }
  // RIFF....WEBP
  return (
    input.length >= 12 &&
    input.subarray(0, 4).toString('ascii') === 'RIFF' &&
    input.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

/** Validates both file signature bytes and decodable sharp image format against `declaredType`. */
export async function verifyImageContent(input: Buffer, declaredType: PhotoContentType): Promise<boolean> {
  if (!hasMagicBytes(input, declaredType)) return false;
  try {
    const format = (await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()).format;
    return (format ? FORMAT_TO_TYPE[format] : undefined) === declaredType;
  } catch {
    return false;
  }
}

export interface ProcessedImage {
  contentType: PhotoContentType;
  /** Re-encoded original without any metadata (EXIF, GPS, ICC, XMP). */
  original: Buffer;
  /** Preview, 400 px wide, WebP. */
  preview: Buffer;
}

/**
 * Decodes by content (not by the declared type), applies EXIF orientation, then re-encodes.
 * sharp drops all metadata on output unless asked to keep it, so geolocation never survives.
 * Returns null if the bytes are not a JPEG/PNG/WebP image.
 */
export async function processImage(input: Buffer, declaredType: string): Promise<ProcessedImage | null> {
  let format: string | undefined;
  try {
    format = (await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()).format;
  } catch {
    return null; // not decodable: caller treats it as an invalid upload
  }
  const contentType = format ? FORMAT_TO_TYPE[format] : undefined;
  if (!contentType || contentType !== declaredType) return null;

  const base = () => sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).rotate();
  const encoded = (p: Sharp): Sharp =>
    contentType === 'image/jpeg' ? p.jpeg({ quality: 90 }) : contentType === 'image/png' ? p.png() : p.webp({ quality: 90 });
  const original = await encoded(base()).toBuffer();
  const preview = await base().resize({ width: PHOTO_PREVIEW_WIDTH, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
  return { contentType, original, preview };
}
