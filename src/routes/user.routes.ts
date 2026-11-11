import { Router } from 'express';
import { authService } from '../services/auth.service.js';
import { authenticate, requireRole, blockAuditorWrites } from '../middlewares/auth.middleware.js';
import { validateBody } from '../middlewares/validation.middleware.js';
import { createUserSchema, updateUserSchema } from './validators.js';

export const userRouter = Router();

userRouter.use(authenticate);
userRouter.use(blockAuditorWrites);
userRouter.use(requireRole('ADMIN'));

userRouter.post('/', validateBody(createUserSchema), async (req, res, next) => {
  try {
    const user = await authService.createUser(req.body);
    res.status(201).json({
      success: true,
      data: user,
    });
  } catch (err) {
    next(err);
  }
});

userRouter.get('/', async (_req, res, next) => {
  try {
    const users = await authService.getUsers();
    res.json({
      success: true,
      data: users,
    });
  } catch (err) {
    next(err);
  }
});

userRouter.patch('/:id', validateBody(updateUserSchema), async (req, res, next) => {
  try {
    const user = await authService.updateUser(req.params.id!, req.body);
    res.json({
      success: true,
      data: user,
    });
  } catch (err) {
    next(err);
  }
});
