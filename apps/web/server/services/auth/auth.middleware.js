import {
  getOwnedAssetById,
  getOwnedProjectById,
  getSessionUserFromRequest,
  verifySignedAssetSourceToken
} from './auth.service.js';

export async function attachAuthContext(req, _res, next) {
  try {
    const user = await getSessionUserFromRequest(req);
    req.auth = {
      user,
      userId: user?.id || '',
      isAuthenticated: Boolean(user)
    };
    next();
  } catch (error) {
    next(error);
  }
}

export function requireAuth(req, res, next) {
  if (req.auth?.isAuthenticated) {
    return next();
  }
  return res.status(401).json({ error: '请先登录' });
}

export function requireAdmin(req, res, next) {
  if (req.auth?.isAuthenticated && String(req.auth?.user?.role || '') === 'admin') {
    return next();
  }
  return res.status(403).json({ error: '需要管理员权限' });
}

export async function requireOwnedProject(req, res, next) {
  try {
    const projectId = String(req.params.projectId || '').trim();
    const project = await getOwnedProjectById(projectId, req.auth?.userId || '');
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    req.projectRecord = project;
    return next();
  } catch (error) {
    return next(error);
  }
}

export async function requireOwnedAsset(req, res, next) {
  try {
    const assetId = String(req.params.assetId || req.body?.assetId || '').trim();
    const asset = await getOwnedAssetById(assetId, req.auth?.userId || '');
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }
    req.assetRecord = asset;
    return next();
  } catch (error) {
    return next(error);
  }
}

export async function allowSignedAssetSourceOrOwner(req, res, next) {
  try {
    const assetId = String(req.params.assetId || '').trim();
    const token = String(req.query?.token || '').trim();

    if (token && verifySignedAssetSourceToken(assetId, token)) {
      return next();
    }

    if (!req.auth?.isAuthenticated) {
      return res.status(401).json({ error: '请先登录' });
    }

    const asset = await getOwnedAssetById(assetId, req.auth.userId || '');
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }
    req.assetRecord = asset;
    return next();
  } catch (error) {
    return next(error);
  }
}
