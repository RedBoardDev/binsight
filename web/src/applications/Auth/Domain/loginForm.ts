import { z } from 'zod/mini';

// The server accepts passwords of up to 1024 characters.
const PASSWORD_MAX_LENGTH = 1024;

export const LOGIN_FORM_ISSUES = ['password_required', 'password_too_long'] as const;

export type LoginFormIssue = (typeof LOGIN_FORM_ISSUES)[number];

export const loginFormSchema = z.object({
  password: z
    .string()
    .check(
      z.minLength(1, 'password_required' satisfies LoginFormIssue),
      z.maxLength(PASSWORD_MAX_LENGTH, 'password_too_long' satisfies LoginFormIssue),
    ),
});

export type LoginFormValues = z.infer<typeof loginFormSchema>;
