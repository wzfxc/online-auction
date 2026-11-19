import sharp, { type Sharp } from 'sharp';
import { PHOTO_PREVIEW_WIDTH, type PhotoContentType } from '@auction/shared';

const FORMAT_TO_TYPE: Record<string, PhotoContentType> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};
const MAX_INPUT_PIXELS = 50_000_000;

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
