import { Router } from 'express';
import { authService } from '../services/auth.service.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { validateBody } from '../middlewares/validation.middleware.js';
import { loginLimiter } from '../middlewares/rate-limit.middleware.js';
import { loginSchema } from './validators.js';

export const authRouter = Router();

authRouter.post('/login', loginLimiter, validateBody(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const result = await authService.login(email, password);
    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', authenticate, (_req, res) => {
  res.json({
    success: true,
    message: 'Logged out successfully',
  });
});

authRouter.get('/me', authenticate, (req, res) => {
  res.json({
    success: true,
    data: req.actor,
  });
});
