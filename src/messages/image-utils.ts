import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export interface QQImageSource {
  file?: string;
  url?: string;
}

export function getPrimaryImageSource(images: QQImageSource[]): QQImageSource | undefined {
  return images[0];
}

export function getImageExtensionFromValue(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const match = value.match(/\.([a-z0-9]+)(?:[?#]|$)/i);
  if (!match) {
    return undefined;
  }

  const ext = match[1].toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
    return `.${ext}`;
  }

  return undefined;
}

export function getImageExtensionFromContentType(contentType?: string | null): string | undefined {
  if (!contentType) {
    return undefined;
  }

  const normalized = contentType.toLowerCase();
  if (normalized.includes('image/png')) {
    return '.png';
  }
  if (normalized.includes('image/jpeg') || normalized.includes('image/jpg')) {
    return '.jpg';
  }
  if (normalized.includes('image/gif')) {
    return '.gif';
  }
  if (normalized.includes('image/webp')) {
    return '.webp';
  }
  if (normalized.includes('image/bmp')) {
    return '.bmp';
  }

  return undefined;
}

export async function downloadImageToLocalCache(
  imageSource: string,
  options: { cacheDir: string; originalFileName?: string },
): Promise<string> {
  if (/^\//.test(imageSource) || /^file:/i.test(imageSource)) {
    return imageSource;
  }

  const response = await fetch(imageSource);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const hash = createHash('sha1').update(buffer).digest('hex');
  const ext = getImageExtensionFromValue(options.originalFileName)
    || getImageExtensionFromValue(imageSource)
    || getImageExtensionFromContentType(response.headers.get('content-type'))
    || '.img';
  mkdirSync(options.cacheDir, { recursive: true });
  const filePath = path.join(options.cacheDir, `${hash}${ext}`);
  writeFileSync(filePath, buffer);
  return filePath;
}

export function detectImageMimeType(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.bmp':
      return 'image/bmp';
    default:
      return 'application/octet-stream';
  }
}

export function buildDataUrlFromLocalImage(imagePath: string): { dataUrl: string; mediaType: string } {
  const mediaType = detectImageMimeType(imagePath);
  const buffer = readFileSync(imagePath);
  return {
    dataUrl: `data:${mediaType};base64,${buffer.toString('base64')}`,
    mediaType,
  };
}
