import { afterEach, describe, expect, it } from 'vitest';
import type { CategoryNode, CategoryTree } from '@budget/shared';
import { seedDefaultCategories } from '../src/db/seed.ts';
import { code, ledgerSetup } from './support/ledger.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const t = await ledgerSetup();
  close = () => t.app.close();
  const tree = async () => (await t.member.get('/api/categories')).json<CategoryTree>();
  const find = async (id: number): Promise<CategoryNode | undefined> => {
    const all = await tree();
    return [...all.expense, ...all.income]
      .flatMap((c) => [c, ...c.children])
      .find((c) => c.id === id);
  };
  return { ...t, tree, find };
}

describe('category tree', () => {
  it('returns seeded defaults as two levels per kind', async () => {
    const t = await setup();
    const tree = await t.tree();
    expect(tree.expense[0]).toMatchObject({ name: '식비', isDefault: true, parentId: null });
    expect(tree.expense[0]!.children.map((c) => c.name)).toContain('외식');
    expect(tree.income.map((c) => c.name)).toContain('근로소득');
  });

  it('lets any member create, rename and reorder with unique sibling names', async () => {
    const t = await setup();
    const food = t.cat('식비');
    const created = await t.member.post('/api/categories', {
      kind: 'expense',
      name: '빵집',
      parentId: food,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: number }>().id;
    expect((await t.find(id))?.parentId).toBe(food);
    expect(
      code(
        await t.member.post('/api/categories', {
          kind: 'expense',
          name: ' 빵 집 ',
          parentId: food,
        }),
      ),
    ).toBe('category_name_taken');
    expect(code(await t.member.patch(`/api/categories/${id}`, { name: '외식' }))).toBe(
      'category_name_taken',
    );
    expect((await t.member.patch(`/api/categories/${id}`, { name: '베이커리' })).statusCode).toBe(
      200,
    );

    const siblings = (await t.tree()).expense.find((c) => c.id === food)!.children.map((c) => c.id);
    const reversed = [...siblings].reverse();
    const res = await t.member.put('/api/categories/order', {
      kind: 'expense',
      parentId: food,
      ids: reversed,
    });
    expect(
      res
        .json<CategoryTree>()
        .expense.find((c) => c.id === food)!
        .children.map((c) => c.id),
    ).toEqual(reversed);
    expect(
      (
        await t.member.put('/api/categories/order', {
          kind: 'expense',
          parentId: food,
          ids: reversed.slice(1),
        })
      ).statusCode,
    ).toBe(400);
  });

  it('enforces two levels and same-kind moves', async () => {
    const t = await setup();
    const food = t.cat('식비');
    const salary = t.cat('근로소득');
    const dining = t.cat('식비/외식');
    expect(
      code(await t.admin.post('/api/categories', { kind: 'expense', name: 'x', parentId: dining })),
    ).toBe('category_invalid');
    expect(
      code(await t.admin.post('/api/categories', { kind: 'expense', name: 'x', parentId: salary })),
    ).toBe('category_invalid');
    expect(code(await t.admin.patch(`/api/categories/${food}`, { parentId: t.cat('생활') }))).toBe(
      'category_invalid',
    );
    expect(code(await t.admin.patch(`/api/categories/${dining}`, { parentId: salary }))).toBe(
      'category_invalid',
    );
    // Move a child to another parent, then promote it to the top level.
    expect(
      (await t.admin.patch(`/api/categories/${dining}`, { parentId: t.cat('생활') })).statusCode,
    ).toBe(200);
    expect((await t.find(dining))?.parentId).toBe(t.cat('생활'));
    expect((await t.admin.patch(`/api/categories/${dining}`, { parentId: null })).statusCode).toBe(
      200,
    );
    expect((await t.find(dining))?.parentId).toBeNull();
  });

  it('archives a parent with its children and restores exactly those', async () => {
    const t = await setup();
    const food = t.cat('식비');
    const cafe = t.cat('식비/카페·간식');
    await t.admin.patch(`/api/categories/${cafe}`, { archived: true }); // archived earlier on its own
    t.clock.advance(1000);
    await t.admin.patch(`/api/categories/${food}`, { archived: true });
    const archived = await t.find(food);
    expect(archived?.archived).toBe(true);
    expect(archived?.children.every((c) => c.archived)).toBe(true);

    expect(
      code(await t.admin.patch(`/api/categories/${t.cat('식비/외식')}`, { archived: false })),
    ).toBe('category_invalid');
    await t.admin.patch(`/api/categories/${food}`, { archived: false });
    const restored = await t.find(food);
    expect(restored?.archived).toBe(false);
    expect(restored?.children.find((c) => c.id === cafe)?.archived).toBe(true);
    expect(restored?.children.filter((c) => c.id !== cafe).every((c) => !c.archived)).toBe(true);
  });

  it('does not resurrect renamed or archived defaults when seeding again', async () => {
    const t = await setup();
    const pets = t.cat('반려동물');
    await t.admin.patch(`/api/categories/${pets}`, { archived: true });
    await t.admin.patch(`/api/categories/${t.cat('식비')}`, { name: '먹거리' });
    expect(seedDefaultCategories(t.db)).toBe(0);
    const tree = await t.tree();
    expect(tree.expense.filter((c) => c.name === '반려동물')).toHaveLength(1);
    expect(tree.expense.find((c) => c.id === pets)?.archived).toBe(true);
    expect(tree.expense.some((c) => c.name === '식비')).toBe(false);
  });
});
