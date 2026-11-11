import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getDbPool, IDatabasePool } from '../db/pool.js';
import { config } from '../config/index.js';
import { User, AuthActor, UserRole } from '../types/index.js';
import { UnauthorizedError, AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

interface LoginAttemptTracker {
  attempts: number;
  lockedUntil?: number;
}

const loginTracker = new Map<string, LoginAttemptTracker>();
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export class AuthService {
  constructor(private pool?: IDatabasePool) {}

  private async getPool(): Promise<IDatabasePool> {
    if (!this.pool) {
      this.pool = await getDbPool();
    }
    return this.pool;
  }

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 12);
  }

  async comparePassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  generateToken(actor: AuthActor): string {
    return jwt.sign(
      {
        sub: actor.id,
        email: actor.email,
        role: actor.role,
      },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn as any }
    );
  }

  verifyToken(token: string): AuthActor {
    try {
      const decoded = jwt.verify(token, config.jwtSecret) as any;
      return {
        id: decoded.sub,
        email: decoded.email,
        role: decoded.role as UserRole,
      };
    } catch (err: any) {
      throw new UnauthorizedError('Invalid or expired authentication token');
    }
  }

  async login(email: string, password: string): Promise<{ token: string; user: AuthActor }> {
    const normalizedEmail = email.toLowerCase().trim();

    // 1. Check brute force lockout
    const tracker = loginTracker.get(normalizedEmail);
    const now = Date.now();
    if (tracker && tracker.lockedUntil && tracker.lockedUntil > now) {
      const remainingSeconds = Math.ceil((tracker.lockedUntil - now) / 1000);
      throw new AppError(
        `Account temporarily locked due to repeated failed logins. Please retry in ${remainingSeconds} seconds.`,
        429,
        'ACCOUNT_LOCKED'
      );
    }

    const pool = await this.getPool();
    const res = await pool.query<User>(
      'SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1',
      [normalizedEmail]
    );

    const user = res.rows[0];

    // Generic error message to prevent user enumeration
    if (!user) {
      this.recordFailedAttempt(normalizedEmail);
      throw new UnauthorizedError('Invalid email or password');
    }

    if (!user.is_active) {
      throw new UnauthorizedError('User account is deactivated');
    }

    const isMatch = await this.comparePassword(password, user.password_hash);
    if (!isMatch) {
      this.recordFailedAttempt(normalizedEmail);
      throw new UnauthorizedError('Invalid email or password');
    }

    // Reset tracker on successful login
    loginTracker.delete(normalizedEmail);

    const actor: AuthActor = {
      id: user.id,
      email: user.email,
      role: user.role,
    };

    const token = this.generateToken(actor);
    logger.info({ userId: user.id, email: user.email, role: user.role }, 'User authenticated successfully');

    return { token, user: actor };
  }

  private recordFailedAttempt(email: string): void {
    const now = Date.now();
    const current = loginTracker.get(email) || { attempts: 0 };
    current.attempts += 1;

    if (current.attempts >= MAX_FAILED_ATTEMPTS) {
      current.lockedUntil = now + LOCKOUT_DURATION_MS;
      logger.warn({ email, attempts: current.attempts }, 'Account locked due to repeated failed logins');
    }

    loginTracker.set(email, current);
  }

  // Admin user management methods
  async createUser(data: {
    email: string;
    password: string;
    role: UserRole;
  }): Promise<Omit<User, 'password_hash'>> {
    const pool = await this.getPool();
    const hash = await this.hashPassword(data.password);

    const res = await pool.query<User>(
      `INSERT INTO users (email, password_hash, role, is_active)
       VALUES ($1, $2, $3, true)
       RETURNING id, email, role, is_active, created_at;`,
      [data.email.toLowerCase().trim(), hash, data.role]
    );

    return res.rows[0]!;
  }

  async getUsers(): Promise<Array<Omit<User, 'password_hash'>>> {
    const pool = await this.getPool();
    const res = await pool.query<User>(
      'SELECT id, email, role, is_active, created_at FROM users ORDER BY created_at ASC'
    );
    return res.rows;
  }

  async updateUser(
    id: string,
    updates: { is_active?: boolean; role?: UserRole }
  ): Promise<Omit<User, 'password_hash'>> {
    const pool = await this.getPool();
    const sets: string[] = [];
    const params: any[] = [id];

    if (updates.is_active !== undefined) {
      params.push(updates.is_active);
      sets.push(`is_active = $${params.length}`);
    }

    if (updates.role !== undefined) {
      params.push(updates.role);
      sets.push(`role = $${params.length}`);
    }

    if (sets.length === 0) {
      const res = await pool.query<User>(
        'SELECT id, email, role, is_active, created_at FROM users WHERE id = $1',
        [id]
      );
      return res.rows[0]!;
    }

    const res = await pool.query<User>(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING id, email, role, is_active, created_at;`,
      params
    );

    return res.rows[0]!;
  }
}

export const authService = new AuthService();
