import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { AccountInfo, CategoryNode, CategoryTree, MemberInfo } from '@budget/shared';
import { api } from '../api/client.ts';

export interface CategoryEntry {
  node: CategoryNode;
  parent: CategoryNode | null;
  /** `식비 > 외식` */
  label: string;
}

/** Shared reference data (categories, accounts, members) with simple caching. */
export const useLedgerStore = defineStore('ledger', () => {
  const tree = ref<CategoryTree>({ expense: [], income: [] });
  const accounts = ref<AccountInfo[]>([]);
  const members = ref<MemberInfo[]>([]);
  const loaded = ref(false);
  let inflight: Promise<void> | null = null;

  const categoryIndex = computed(() => {
    const map = new Map<number, CategoryEntry>();
    for (const root of [...tree.value.expense, ...tree.value.income]) {
      map.set(root.id, { node: root, parent: null, label: root.name });
      for (const child of root.children) {
        map.set(child.id, { node: child, parent: root, label: `${root.name} > ${child.name}` });
      }
    }
    return map;
  });

  const activeAccounts = computed(() => accounts.value.filter((a) => !a.archived));
  const activeMembers = computed(() => members.value.filter((m) => !m.disabled));

  async function fetchAll(): Promise<void> {
    const [t, a, m] = await Promise.all([
      api.get<CategoryTree>('/categories'),
      api.get<AccountInfo[]>('/accounts'),
      api.get<MemberInfo[]>('/members'),
    ]);
    tree.value = t;
    accounts.value = a;
    members.value = m;
    loaded.value = true;
  }

  function load(force = false): Promise<void> {
    if (loaded.value && !force) return Promise.resolve();
    inflight ??= fetchAll().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function setTree(next: CategoryTree): void {
    tree.value = next;
  }

  function setAccounts(next: AccountInfo[]): void {
    accounts.value = next;
  }

  function reset(): void {
    loaded.value = false;
  }

  return {
    tree,
    accounts,
    members,
    loaded,
    categoryIndex,
    activeAccounts,
    activeMembers,
    load,
    setTree,
    setAccounts,
    reset,
  };
});
