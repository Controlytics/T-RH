import { z } from 'zod';

export const createUserSchema = z.object({
  username: z.string().min(6, 'Minimum 6 characters').max(50, 'Maximum 50 characters'),
  fullName: z.string().min(1, 'Full name is required').max(100),
  // Email is optional (not mandatory at creation). Must be a valid email when
  // provided; '' / omitted are both accepted.
  email: z.union([z.literal(''), z.string().email('Invalid email address').max(100)]).optional(),
  department: z.string().max(50).optional(),
  role: z.string().min(1, 'Role is required'),
  password: z.string().min(8, 'Minimum 8 characters'),
  confirmPassword: z.string(),
  status: z.enum(["ENABLED", "DISABLED"]).default("ENABLED"),
}).refine((d) => d.password === d.confirmPassword, {
  message: 'Passwords must match',
  path: ['confirmPassword'],
});

export const updateUserSchema = z.object({
  fullName: z.string().min(1).max(100).optional(),
  // Email is optional on update (mirrors create). Must be a valid email when a
  // non-empty value is given; '' and null (an emailless user's edit form) are
  // both accepted so a role-only change isn't blocked by the email field.
  email: z.union([z.literal(''), z.string().email('Invalid email address').max(100)]).nullish(),
  department: z.string().max(50).optional(),
  role: z.string().min(1).optional(),
  status: z.enum(["ENABLED", "DISABLED"]).optional(),
});

export const resetPasswordSchema = z.object({
  newPassword: z.string().min(8, 'Minimum 8 characters'),
});

export const userQuerySchema = z.object({
  role: z.string().optional(),
  status: z.enum(['ENABLED', 'DISABLED', 'LOCKED', 'EXPIRED']).optional(),
  search: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  // Cap upper bound so a missing limit doesn't pull thousands of rows.
  limit: z.coerce.number().min(1).max(100).default(20),
});

export const bulkDeleteUsersSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1, 'At least one user ID is required').max(50, 'Maximum 50 users at once'),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type UserQueryInput = z.infer<typeof userQuerySchema>;
export type BulkDeleteUsersInput = z.infer<typeof bulkDeleteUsersSchema>;
