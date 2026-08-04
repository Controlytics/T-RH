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
  // Cap the upper bound so a caller can't pull thousands of rows; the default(20)
  // is what protects the "no limit supplied" case. 500 rather than 100 because the
  // recipient pickers (notification rules, send-for-review) need the WHOLE user
  // list in one request and silently truncating it drops selectable recipients —
  // a real install of this codebase runs 156 users, so 100 was not enough.
  limit: z.coerce.number().min(1).max(500).default(20),
});

export const bulkDeleteUsersSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1, 'At least one user ID is required').max(50, 'Maximum 50 users at once'),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type UserQueryInput = z.infer<typeof userQuerySchema>;
export type BulkDeleteUsersInput = z.infer<typeof bulkDeleteUsersSchema>;
