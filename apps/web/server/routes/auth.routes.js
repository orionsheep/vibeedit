import express from 'express';
import {
  clearAuthCookie,
  createSessionForUser,
  getAdminBootstrapEmail,
  loginUser,
  logoutRequest,
  registerUser,
  setAuthCookie
} from '../services/auth/auth.service.js';
import { attachAuthContext, requireAuth } from '../services/auth/auth.middleware.js';

const router = express.Router();

router.use(attachAuthContext);

router.get('/session', async (req, res) => {
  res.json({
    success: true,
    authenticated: Boolean(req.auth?.isAuthenticated),
    user: req.auth?.user || null,
    bootstrap_admin_email: getAdminBootstrapEmail()
  });
});

router.post('/register', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    const confirmPassword = String(req.body?.confirmPassword || req.body?.confirm_password || '');

    if (!email || !password || !confirmPassword) {
      return res.status(400).json({ error: '邮箱、密码和确认密码都不能为空' });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: '两次输入的密码不一致' });
    }

    const user = await registerUser({ email, password });
    const sessionToken = await createSessionForUser(user.id);
    setAuthCookie(res, sessionToken, req);

    return res.json({
      success: true,
      user
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const user = await loginUser({
      email: req.body?.email || '',
      password: req.body?.password || ''
    });
    const sessionToken = await createSessionForUser(user.id);
    setAuthCookie(res, sessionToken, req);
    return res.json({ success: true, user });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

router.post('/logout', requireAuth, async (req, res) => {
  try {
    await logoutRequest(req);
    clearAuthCookie(res, req);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
