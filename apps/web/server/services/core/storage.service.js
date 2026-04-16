import fs from 'fs';
import path from 'path';
import slugify from 'slugify';
import { ensureStorageDirs } from '../editor/config.js';

function sanitizeBaseName(filename, fallback = 'asset') {
  const raw = path.basename(filename || '', path.extname(filename || '')) || fallback;
  return slugify(raw, { lower: true, strict: true }) || fallback;
}

export function ensureProjectStorage() {
  return ensureStorageDirs();
}

export async function moveUploadedAssetFile(tempPath, assetId, originalFilename) {
  const { assetsOriginalsDir } = ensureStorageDirs();
  const ext = path.extname(originalFilename || '') || '.mp4';
  const baseName = sanitizeBaseName(originalFilename);
  const storageKey = path.join('assets', 'originals', `${assetId}-${baseName}${ext}`);
  const absolutePath = path.join(assetsOriginalsDir, `${assetId}-${baseName}${ext}`);

  await fs.promises.rename(tempPath, absolutePath);

  return {
    role: 'original',
    storageKey,
    uri: absolutePath
  };
}

export async function copyExternalAssetFile(sourcePath, assetId, originalFilename = '') {
  const { assetsOriginalsDir } = ensureStorageDirs();
  const resolvedFilename = originalFilename || path.basename(sourcePath || '') || 'imported-video.mp4';
  const ext = path.extname(resolvedFilename || '') || path.extname(sourcePath || '') || '.mp4';
  const baseName = sanitizeBaseName(resolvedFilename);
  const storageKey = path.join('assets', 'originals', `${assetId}-${baseName}${ext}`);
  const absolutePath = path.join(assetsOriginalsDir, `${assetId}-${baseName}${ext}`);

  await fs.promises.copyFile(sourcePath, absolutePath);

  return {
    role: 'original',
    storageKey,
    uri: absolutePath
  };
}

export async function copyAssetFileToPackage(sourcePath, targetDir, targetFilename = null) {
  const filename = targetFilename || path.basename(sourcePath);
  const outputPath = path.join(targetDir, filename);
  await fs.promises.copyFile(sourcePath, outputPath);
  return outputPath;
}

export function resolveStoragePath(storageKey) {
  const { storageRoot } = ensureStorageDirs();
  return path.join(storageRoot, storageKey);
}
