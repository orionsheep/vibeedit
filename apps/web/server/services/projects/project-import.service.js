import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { ensureWorkspaceDirs } from '../editor/config.js';
import { createAssetFromSourceFile } from '../library/asset-library.service.js';
import { createProject, addAssetToProject, getProjectById } from './project.service.js';
import { listAssetWords } from './timeline.service.js';
import { createTimelineSnapshot } from './timeline.service.js';
import { saveProjectEditState } from './project-edit-state.service.js';

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeReadJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function parseOtioClips(otio = {}) {
  const track = otio?.tracks?.children?.[0];
  const children = Array.isArray(track?.children) ? track.children : [];
  return children.map((clip, index) => ({
    sort_order: index + 1,
    label: String(clip?.name || '').trim(),
    old_asset_id: String(clip?.metadata?.asset_id || '').trim(),
    media_filename: path.basename(String(clip?.media_references?.DEFAULT_MEDIA?.target_url || '').replace('file://localhost/', '/')),
    source_start: Number(clip?.source_range?.start_time?.value || 0),
    source_end: Number(clip?.source_range?.start_time?.value || 0) + Number(clip?.source_range?.duration?.value || 0)
  })).filter((clip) => clip.media_filename || clip.old_asset_id);
}

function translateWordKey(key, assetIdMap) {
  const value = String(key || '');
  const wordMarker = ':word:';
  const gapMarker = ':gap:';
  if (value.includes(wordMarker)) {
    const [oldAssetId, suffix] = value.split(wordMarker);
    const nextAssetId = assetIdMap.get(oldAssetId);
    return nextAssetId ? `${nextAssetId}${wordMarker}${suffix}` : '';
  }
  if (value.includes(gapMarker)) {
    const [oldAssetId, suffix] = value.split(gapMarker);
    const nextAssetId = assetIdMap.get(oldAssetId);
    return nextAssetId ? `${nextAssetId}${gapMarker}${suffix}` : '';
  }
  return '';
}

function translateImportedEditState(editState = {}, assetIdMap) {
  return {
    assetOrder: normalizeArray(editState.asset_order || editState.assetOrder)
      .map((assetId) => assetIdMap.get(assetId))
      .filter(Boolean),
    deletedWordKeys: normalizeArray(editState.deleted_word_keys || editState.deletedWordKeys)
      .map((key) => translateWordKey(key, assetIdMap))
      .filter(Boolean),
    deletedGapKeys: normalizeArray(editState.deleted_gap_keys || editState.deletedGapKeys)
      .map((key) => translateWordKey(key, assetIdMap))
      .filter(Boolean),
    textReplacements: normalizeArray(editState.text_replacements || editState.textReplacements)
      .map((replacement) => ({
        assetId: assetIdMap.get(replacement?.assetId || replacement?.asset_id || ''),
        startWordIndex: Number(replacement?.startWordIndex ?? replacement?.start_word_index ?? -1),
        endWordIndex: Number(replacement?.endWordIndex ?? replacement?.end_word_index ?? -1),
        replacementText: String(replacement?.replacementText ?? replacement?.replacement_text ?? '')
      }))
      .filter((replacement) => replacement.assetId && replacement.endWordIndex >= replacement.startWordIndex)
  };
}

function buildFallbackEditState(assets, otioClips, assetIdMap, wordsByAssetId) {
  const assetOrder = [];
  const deletedWordKeys = [];

  for (const clip of otioClips) {
    const resolvedAssetId = assetIdMap.get(clip.old_asset_id) || assetIdMap.get(clip.media_filename);
    if (resolvedAssetId && !assetOrder.includes(resolvedAssetId)) {
      assetOrder.push(resolvedAssetId);
    }
  }

  for (const asset of assets) {
    if (!assetOrder.includes(asset.id)) {
      assetOrder.push(asset.id);
    }
  }

  for (const asset of assets) {
    const words = wordsByAssetId.get(asset.id) || [];
    const relevantClips = otioClips.filter((clip) => {
      const resolvedAssetId = assetIdMap.get(clip.old_asset_id) || assetIdMap.get(clip.media_filename);
      return resolvedAssetId === asset.id;
    });

    if (!relevantClips.length) {
      deletedWordKeys.push(...words.map((word) => word.id));
      continue;
    }

    for (const word of words) {
      const keep = relevantClips.some((clip) => (
        Number(word.end_time || 0) > Number(clip.source_start || 0) + 0.01 &&
        Number(word.start_time || 0) < Number(clip.source_end || 0) - 0.01
      ));
      if (!keep) {
        deletedWordKeys.push(word.id);
      }
    }
  }

  return {
    assetOrder,
    deletedWordKeys,
    deletedGapKeys: [],
    textReplacements: []
  };
}

function findPackageRoot(extractDir) {
  const directManifest = path.join(extractDir, 'manifest.json');
  if (fs.existsSync(directManifest)) {
    return extractDir;
  }

  const children = fs.readdirSync(extractDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(extractDir, entry.name));

  return children.find((candidate) => fs.existsSync(path.join(candidate, 'manifest.json'))) || extractDir;
}

export async function importProjectPackageFromZip(zipPath, { ownerId = '' } = {}) {
  const { outputsDir } = ensureWorkspaceDirs();
  const tempRoot = path.join(outputsDir, `package_import_${uuidv4().substring(0, 8)}`);
  await fs.promises.mkdir(tempRoot, { recursive: true });

  try {
    execFileSync('unzip', ['-oq', zipPath, '-d', tempRoot]);
    const packageRoot = findPackageRoot(tempRoot);
    const projectJson = safeReadJson(path.join(packageRoot, 'project', 'project.json')) || {};
    const otio = safeReadJson(path.join(packageRoot, 'project', 'timeline.otio')) || {};
    const assetsJson = safeReadJson(path.join(packageRoot, 'project', 'assets.json')) || [];
    const editStateJson = safeReadJson(path.join(packageRoot, 'project', 'edit-state.json'));
    const mediaDir = path.join(packageRoot, 'media');
    const captionsDir = path.join(packageRoot, 'project', 'captions');

    const project = await createProject({
      name: `${String(projectJson.name || '导入工程')}`.trim() || '导入工程',
      description: projectJson.description || '由工程包导入',
      categoryName: projectJson.category || '',
      ownerId
    });

    const importedAssets = [];
    const assetIdMap = new Map();
    const assetByMediaFilename = new Map();

    for (const assetMeta of normalizeArray(assetsJson)) {
      const mediaFilename = assetMeta.media_filename || assetMeta.original_filename;
      const sourcePath = mediaFilename ? path.join(mediaDir, mediaFilename) : '';
      if (!sourcePath || !fs.existsSync(sourcePath)) continue;
      const captionData = safeReadJson(path.join(captionsDir, assetMeta.caption_filename || `${assetMeta.asset_id}.json`));
      const asset = await createAssetFromSourceFile(sourcePath, {
        title: assetMeta.title || path.basename(mediaFilename, path.extname(mediaFilename)),
        originalFilename: assetMeta.original_filename || mediaFilename,
        jsonData: captionData?.payload || null,
        waitForAsr: !captionData?.payload,
        ownerId
      });
      await addAssetToProject(project.id, asset.id);
      importedAssets.push(asset);
      if (assetMeta.asset_id) {
        assetIdMap.set(assetMeta.asset_id, asset.id);
      }
      if (mediaFilename) {
        assetIdMap.set(mediaFilename, asset.id);
        assetByMediaFilename.set(mediaFilename, asset);
      }
    }

    if (!importedAssets.length && fs.existsSync(mediaDir)) {
      const mediaFiles = fs.readdirSync(mediaDir).filter((name) => !name.startsWith('.'));
      for (const mediaFilename of mediaFiles) {
        const sourcePath = path.join(mediaDir, mediaFilename);
        if (!fs.statSync(sourcePath).isFile()) continue;
        const asset = await createAssetFromSourceFile(sourcePath, {
          title: path.basename(mediaFilename, path.extname(mediaFilename)),
          originalFilename: mediaFilename,
          waitForAsr: true,
          ownerId
        });
        await addAssetToProject(project.id, asset.id);
        importedAssets.push(asset);
        assetIdMap.set(mediaFilename, asset.id);
        assetByMediaFilename.set(mediaFilename, asset);
      }
    }

    const otioClips = parseOtioClips(otio);
    const wordsByAssetId = new Map();
    for (const asset of importedAssets) {
      const words = await listAssetWords(asset.id);
      wordsByAssetId.set(asset.id, words);
    }

    const translatedState = editStateJson
      ? translateImportedEditState(editStateJson, assetIdMap)
      : buildFallbackEditState(importedAssets, otioClips, assetIdMap, wordsByAssetId);

    await saveProjectEditState(project.id, {
      ...translatedState,
      createSnapshot: false,
      source: 'package_import',
      note: 'Imported package edit state'
    });
    await createTimelineSnapshot(project.id, {
      source: 'package_import',
      note: 'Imported project package'
    });

    return getProjectById(project.id);
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}
