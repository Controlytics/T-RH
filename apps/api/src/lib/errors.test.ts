import { describe, it, expect } from 'vitest';
import {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} from './errors.js';

describe('Error Classes', () => {
  // ── AppError ──────────────────────────────────────────────
  describe('AppError', () => {
    it('sets statusCode, code, message, and details', () => {
      const err = new AppError(422, 'CUSTOM_ERROR', 'Something went wrong', { field: 'email' });
      expect(err.statusCode).toBe(422);
      expect(err.code).toBe('CUSTOM_ERROR');
      expect(err.message).toBe('Something went wrong');
      expect(err.details).toEqual({ field: 'email' });
    });

    it('extends Error', () => {
      const err = new AppError(500, 'ERR', 'fail');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(AppError);
    });

    it('sets name to the constructor name', () => {
      const err = new AppError(400, 'ERR', 'test');
      expect(err.name).toBe('AppError');
    });

    it('works without details', () => {
      const err = new AppError(400, 'ERR', 'no details');
      expect(err.details).toBeUndefined();
    });
  });

  // ── ValidationError ───────────────────────────────────────
  describe('ValidationError', () => {
    it('has statusCode 400 and code VALIDATION_ERROR', () => {
      const err = new ValidationError('Invalid input');
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.message).toBe('Invalid input');
    });

    it('extends AppError', () => {
      const err = new ValidationError('bad');
      expect(err).toBeInstanceOf(AppError);
    });

    it('accepts details', () => {
      const err = new ValidationError('bad', { fields: ['name'] });
      expect(err.details).toEqual({ fields: ['name'] });
    });
  });

  // ── NotFoundError ─────────────────────────────────────────
  describe('NotFoundError', () => {
    it('has statusCode 404 and code NOT_FOUND', () => {
      const err = new NotFoundError('User not found');
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe('NOT_FOUND');
      expect(err.message).toBe('User not found');
    });

    it('extends AppError', () => {
      expect(new NotFoundError('x')).toBeInstanceOf(AppError);
    });
  });

  // ── ConflictError ─────────────────────────────────────────
  describe('ConflictError', () => {
    it('has statusCode 409 and code CONFLICT', () => {
      const err = new ConflictError('Duplicate entry');
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('CONFLICT');
      expect(err.message).toBe('Duplicate entry');
    });

    it('extends AppError', () => {
      expect(new ConflictError('x')).toBeInstanceOf(AppError);
    });
  });

  // ── ForbiddenError ────────────────────────────────────────
  describe('ForbiddenError', () => {
    it('has statusCode 403 and code FORBIDDEN', () => {
      const err = new ForbiddenError('Access denied');
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe('FORBIDDEN');
      expect(err.message).toBe('Access denied');
    });

    it('extends AppError', () => {
      expect(new ForbiddenError('x')).toBeInstanceOf(AppError);
    });
  });

  // ── Error catch pattern ───────────────────────────────────
  describe('catch pattern', () => {
    it('can be caught by instanceof AppError', () => {
      try {
        throw new NotFoundError('gone');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        if (err instanceof AppError) {
          expect(err.statusCode).toBe(404);
        }
      }
    });

    it('has a proper stack trace', () => {
      const err = new ValidationError('trace test');
      expect(err.stack).toBeDefined();
      expect(err.stack).toContain('trace test');
    });
  });
});
