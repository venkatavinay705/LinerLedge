import { z } from 'zod';

export const amountSchema = z
  .union([
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    z.string().regex(/^[1-9]\d*$/, { message: 'Amount must be a positive integer in cents' }),
  ])
  .transform((val) => BigInt(val));

export const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(6).max(128),
});

export const createUserSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  role: z.enum(['ADMIN', 'ACCOUNT_HOLDER', 'AUDITOR']),
});

export const updateUserSchema = z.object({
  is_active: z.boolean().optional(),
  role: z.enum(['ADMIN', 'ACCOUNT_HOLDER', 'AUDITOR']).optional(),
});

export const createAccountSchema = z.object({
  account_number: z.string().min(3).max(64),
  name: z.string().min(1).max(255),
  type: z.enum(['CUSTOMER', 'SYSTEM']).default('CUSTOMER'),
  currency: z.string().length(3).default('USD'),
  allow_overdraft: z.boolean().default(false),
  overdraft_limit: z
    .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)])
    .default(0)
    .transform((val) => BigInt(val)),
});

export const updateAccountStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'FROZEN', 'CLOSED']),
});

export const setPermissionsSchema = z.object({
  user_id: z.string().uuid(),
  permissions: z
    .array(z.enum(['VIEW', 'DEPOSIT', 'WITHDRAW', 'TRANSFER_OUT']))
    .nonempty(),
});

export const depositWithdrawSchema = z.object({
  amount: amountSchema,
  description: z.string().max(500).optional(),
});

export const transferSchema = z.object({
  source_account_id: z.string().uuid(),
  destination_account_id: z.string().uuid(),
  amount: amountSchema,
  description: z.string().max(500).optional(),
});

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
