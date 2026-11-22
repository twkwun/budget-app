import type { z } from 'zod';
import { errors } from './errors.ts';

/** Parse a request body/params with zod, mapping failures to a 400 validation_error. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    throw errors.validation(`${where}${first?.message ?? 'invalid'}`);
  }
  return result.data;
}
