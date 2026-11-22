import { eq } from 'drizzle-orm';
import { CATEGORY_KINDS } from '@budget/shared';
import type { AppDatabase } from './client.ts';
import { DEFAULT_CATEGORIES } from './default-categories.ts';
import { categories } from './schema.ts';

/**
 * Insert any default categories that are missing, matched by `system_key`.
 * Safe to run on every startup: existing rows (including ones the family has
 * renamed, reordered or archived) are left untouched. Returns rows inserted.
 */
export function seedDefaultCategories(db: AppDatabase): number {
  return db.transaction((tx) => {
    let inserted = 0;
    const upsert = (row: typeof categories.$inferInsert): number => {
      const created = tx
        .insert(categories)
        .values(row)
        .onConflictDoNothing({ target: categories.systemKey })
        .returning({ id: categories.id })
        .get();
      if (created) {
        inserted += 1;
        return created.id;
      }
      const existing = tx
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.systemKey, row.systemKey as string))
        .get();
      if (!existing) throw new Error(`Seed category ${row.systemKey} vanished`);
      return existing.id;
    };

    for (const kind of CATEGORY_KINDS) {
      DEFAULT_CATEGORIES[kind].forEach((parent, parentIndex) => {
        const parentKey = `${kind}.${parent.key}`;
        const parentId = upsert({
          kind,
          name: parent.name,
          systemKey: parentKey,
          sortOrder: parentIndex,
        });
        parent.children.forEach((child, childIndex) => {
          upsert({
            kind,
            name: child.name,
            parentId,
            systemKey: `${parentKey}.${child.key}`,
            sortOrder: childIndex,
          });
        });
      });
    }
    return inserted;
  });
}
