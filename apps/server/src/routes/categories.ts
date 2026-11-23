import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import {
  CATEGORY_KINDS,
  CATEGORY_NAME_MAX_LENGTH,
  type CategoryNode,
  type CategoryTree,
} from '@budget/shared';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import type { AppDatabase } from '../db/client.ts';
import { categories } from '../db/schema.ts';
import { errors } from '../http/errors.ts';
import { parse } from '../http/validation.ts';

type CategoryRow = typeof categories.$inferSelect;
type Db = Pick<AppDatabase, 'select' | 'update' | 'insert'>;

export function buildTree(rows: CategoryRow[]): CategoryTree {
  const byOrder = (a: CategoryRow, b: CategoryRow) => a.sortOrder - b.sortOrder || a.id - b.id;
  const node = (row: CategoryRow): CategoryNode => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    parentId: row.parentId,
    sortOrder: row.sortOrder,
    archived: row.archivedAt !== null,
    isDefault: row.systemKey !== null,
    children: rows
      .filter((child) => child.parentId === row.id)
      .sort(byOrder)
      .map(node),
  });
  const roots = rows.filter((r) => r.parentId === null).sort(byOrder);
  return {
    expense: roots.filter((r) => r.kind === 'expense').map(node),
    income: roots.filter((r) => r.kind === 'income').map(node),
  };
}

function siblingsOf(db: Db, kind: CategoryRow['kind'], parentId: number | null): CategoryRow[] {
  return db
    .select()
    .from(categories)
    .where(
      and(
        eq(categories.kind, kind),
        parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId),
      ),
    )
    .all();
}

/** Names are unique among active siblings (case- and space-insensitive). */
function assertNameFree(
  db: Db,
  kind: CategoryRow['kind'],
  parentId: number | null,
  name: string,
  exceptId?: number,
): void {
  const key = name.replace(/\s+/g, '').toLowerCase();
  const clash = siblingsOf(db, kind, parentId).some(
    (s) =>
      s.id !== exceptId &&
      s.archivedAt === null &&
      s.name.replace(/\s+/g, '').toLowerCase() === key,
  );
  if (clash)
    throw errors.conflict('category_name_taken', 'A category with that name already exists');
}

function requireParent(db: Db, parentId: number, kind: CategoryRow['kind']): CategoryRow {
  const parent = db.select().from(categories).where(eq(categories.id, parentId)).get();
  if (!parent) throw errors.notFound('Parent category not found');
  if (parent.parentId !== null) {
    throw errors.conflict('category_invalid', 'Categories have only two levels');
  }
  if (parent.kind !== kind) {
    throw errors.conflict('category_invalid', 'Parent must be of the same kind');
  }
  if (parent.archivedAt) throw errors.conflict('category_invalid', 'Parent is archived');
  return parent;
}

const nameSchema = z.string().trim().min(1).max(CATEGORY_NAME_MAX_LENGTH);
const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Categories are shared by the family; any member may manage them. */
export function categoryRoutes(ctx: AppContext): FastifyPluginAsync {
  const tree = (): CategoryTree => buildTree(ctx.db.select().from(categories).all());

  return async (app) => {
    app.get('/categories', async () => tree());

    app.post('/categories', async (request, reply) => {
      const body = parse(
        z.object({
          kind: z.enum(CATEGORY_KINDS),
          name: nameSchema,
          parentId: z.number().int().positive().nullable().default(null),
        }),
        request.body,
      );
      const created = ctx.db.transaction((tx) => {
        if (body.parentId !== null) requireParent(tx, body.parentId, body.kind);
        assertNameFree(tx, body.kind, body.parentId, body.name);
        const siblings = siblingsOf(tx, body.kind, body.parentId);
        return tx
          .insert(categories)
          .values({
            kind: body.kind,
            name: body.name,
            parentId: body.parentId,
            sortOrder: siblings.reduce((m, s) => Math.max(m, s.sortOrder + 1), 0),
          })
          .returning()
          .get();
      });
      return reply.code(201).send({ id: created.id, tree: tree() });
    });

    /**
     * Rename, move (`parentId`) and archive/unarchive.
     * - A category with children cannot become a child (two levels only).
     * - Archiving a parent also archives its active children with the same
     *   timestamp; unarchiving the parent restores exactly those children.
     * - A child cannot be unarchived while its parent is archived.
     */
    app.patch('/categories/:id', async (request) => {
      const { id } = parse(idParam, request.params);
      const body = parse(
        z
          .object({
            name: nameSchema.optional(),
            parentId: z.number().int().positive().nullable().optional(),
            archived: z.boolean().optional(),
          })
          .strict(),
        request.body,
      );
      ctx.db.transaction((tx) => {
        const row = tx.select().from(categories).where(eq(categories.id, id)).get();
        if (!row) throw errors.notFound('Category not found');
        const children = tx.select().from(categories).where(eq(categories.parentId, id)).all();
        let parentId = row.parentId;

        if (body.parentId !== undefined && body.parentId !== row.parentId) {
          if (body.parentId === id)
            throw errors.conflict('category_invalid', 'Cannot nest under itself');
          if (body.parentId !== null) {
            if (children.length > 0) {
              throw errors.conflict(
                'category_invalid',
                'A category with children cannot be nested',
              );
            }
            requireParent(tx, body.parentId, row.kind);
          }
          parentId = body.parentId;
        }
        const name = body.name ?? row.name;
        if (body.name !== undefined || parentId !== row.parentId) {
          if (row.archivedAt === null) assertNameFree(tx, row.kind, parentId, name, id);
        }

        let archivedAt = row.archivedAt;
        if (body.archived === true && !row.archivedAt) {
          archivedAt = new Date(ctx.now());
          tx.update(categories)
            .set({ archivedAt })
            .where(and(eq(categories.parentId, id), isNull(categories.archivedAt)))
            .run();
        } else if (body.archived === false && row.archivedAt) {
          if (parentId !== null) {
            const parent = tx.select().from(categories).where(eq(categories.id, parentId)).get();
            if (parent?.archivedAt) {
              throw errors.conflict('category_invalid', 'Unarchive the parent category first');
            }
          }
          assertNameFree(tx, row.kind, parentId, name, id);
          tx.update(categories)
            .set({ archivedAt: null })
            .where(and(eq(categories.parentId, id), eq(categories.archivedAt, row.archivedAt)))
            .run();
          archivedAt = null;
        }

        const moved = parentId !== row.parentId;
        const sortOrder = moved
          ? siblingsOf(tx, row.kind, parentId).reduce((m, s) => Math.max(m, s.sortOrder + 1), 0)
          : row.sortOrder;
        tx.update(categories)
          .set({ name, parentId, archivedAt, sortOrder })
          .where(eq(categories.id, id))
          .run();
      });
      return tree();
    });

    /** Reorder the children of one parent (or the top level of one kind). */
    app.put('/categories/order', async (request) => {
      const body = parse(
        z.object({
          kind: z.enum(CATEGORY_KINDS),
          parentId: z.number().int().positive().nullable(),
          ids: z.array(z.number().int().positive()).min(1).max(500),
        }),
        request.body,
      );
      ctx.db.transaction((tx) => {
        const siblings = siblingsOf(tx, body.kind, body.parentId);
        const siblingIds = new Set(siblings.map((s) => s.id));
        if (
          body.ids.length !== siblings.length ||
          new Set(body.ids).size !== body.ids.length ||
          !body.ids.every((i) => siblingIds.has(i))
        ) {
          throw errors.validation('ids must list every sibling exactly once');
        }
        body.ids.forEach((categoryId, index) => {
          tx.update(categories)
            .set({ sortOrder: index })
            .where(eq(categories.id, categoryId))
            .run();
        });
      });
      return tree();
    });
  };
}

/** Category ids that a filter on `id` covers: itself plus children when it is a parent. */
export function categoryWithChildren(db: AppDatabase, id: number): number[] {
  const rows = db
    .select({ id: categories.id })
    .from(categories)
    .where(sql`${categories.id} = ${id} or ${categories.parentId} = ${id}`)
    .all();
  return rows.map((r) => r.id);
}
