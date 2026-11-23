<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { CategoryKind, CategoryNode, CategoryTree } from '@budget/shared';
import { api } from '../../api/client.ts';
import { errorMessage } from '../../auth/messages.ts';
import BottomSheet from '../../components/BottomSheet.vue';
import { useLedgerStore } from '../../stores/ledger.ts';

const ledger = useLedgerStore();
const kind = ref<CategoryKind>('expense');
const showArchived = ref(false);
const error = ref('');
const busy = ref(false);
const editing = ref<CategoryNode | null>(null);
const newParent = ref<number | null | undefined>(undefined);
const name = ref('');
const parentId = ref<number | null>(null);

const roots = computed(() =>
  ledger.tree[kind.value]
    .filter((r) => showArchived.value || !r.archived)
    .map((r) => ({ ...r, children: r.children.filter((c) => showArchived.value || !c.archived) })),
);
const parentOptions = computed(() => ledger.tree[kind.value].filter((r) => !r.archived));

onMounted(() => void run(async () => ledger.load(true)));

async function run(action: () => Promise<unknown>): Promise<boolean> {
  busy.value = true;
  error.value = '';
  try {
    await action();
    return true;
  } catch (e) {
    error.value = errorMessage(e);
    return false;
  } finally {
    busy.value = false;
  }
}

function openNew(parent: number | null): void {
  editing.value = null;
  newParent.value = parent;
  name.value = '';
}

function openEdit(node: CategoryNode): void {
  newParent.value = undefined;
  editing.value = node;
  name.value = node.name;
  parentId.value = node.parentId;
}

function close(): void {
  editing.value = null;
  newParent.value = undefined;
}

async function save(): Promise<void> {
  const ok = await run(async () => {
    if (editing.value) {
      const body: Record<string, unknown> = {};
      if (name.value !== editing.value.name) body.name = name.value;
      if (parentId.value !== editing.value.parentId) body.parentId = parentId.value;
      if (Object.keys(body).length) {
        ledger.setTree(await api.patch<CategoryTree>(`/categories/${editing.value.id}`, body));
      }
    } else {
      const res = await api.post<{ tree: CategoryTree }>('/categories', {
        kind: kind.value,
        name: name.value,
        parentId: newParent.value ?? null,
      });
      ledger.setTree(res.tree);
    }
  });
  if (ok) close();
}

const setArchived = (node: CategoryNode, archived: boolean) =>
  run(async () => {
    if (
      archived &&
      node.children.some((c) => !c.archived) &&
      !window.confirm(
        `'${node.name}'과 하위 분류를 모두 보관할까요? 기존 거래의 분류는 그대로 남습니다.`,
      )
    )
      return;
    ledger.setTree(await api.patch<CategoryTree>(`/categories/${node.id}`, { archived }));
  });

const move = (node: CategoryNode, delta: number) =>
  run(async () => {
    const siblings =
      node.parentId === null
        ? ledger.tree[kind.value]
        : (ledger.tree[kind.value].find((r) => r.id === node.parentId)?.children ?? []);
    const ids = siblings.map((s) => s.id);
    const i = ids.indexOf(node.id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    ids.splice(j, 0, ...ids.splice(i, 1));
    ledger.setTree(
      await api.put<CategoryTree>('/categories/order', {
        kind: kind.value,
        parentId: node.parentId,
        ids,
      }),
    );
  });
</script>

<template>
  <section class="page" data-testid="categories-page">
    <h1>분류</h1>
    <p class="muted small">
      가족 모두가 함께 쓰는 분류입니다. 보관한 분류는 새 거래에서 고를 수 없지만 기존 거래에는
      그대로 남습니다.
    </p>
    <div class="segmented" role="tablist">
      <button
        type="button"
        role="tab"
        :aria-selected="kind === 'expense'"
        :class="{ on: kind === 'expense' }"
        @click="kind = 'expense'"
      >
        지출
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="kind === 'income'"
        :class="{ on: kind === 'income' }"
        @click="kind = 'income'"
      >
        수입
      </button>
    </div>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <div class="tree" data-testid="category-tree">
      <section
        v-for="root in roots"
        :key="root.id"
        class="card group"
        :class="{ archived: root.archived }"
      >
        <div class="node root-node">
          <strong class="grow">{{ root.name }}</strong>
          <span v-if="root.archived" class="badge">보관됨</span>
          <button type="button" class="btn btn-small" aria-label="위로" @click="move(root, -1)">
            ↑
          </button>
          <button type="button" class="btn btn-small" aria-label="아래로" @click="move(root, 1)">
            ↓
          </button>
          <button type="button" class="btn btn-small" @click="openEdit(root)">수정</button>
          <button type="button" class="btn btn-small" @click="setArchived(root, !root.archived)">
            {{ root.archived ? '복원' : '보관' }}
          </button>
        </div>
        <ul class="children">
          <li
            v-for="child in root.children"
            :key="child.id"
            class="node"
            :class="{ archived: child.archived }"
          >
            <span class="grow">{{ child.name }}</span>
            <span v-if="child.archived" class="badge">보관됨</span>
            <button type="button" class="btn btn-small" aria-label="위로" @click="move(child, -1)">
              ↑
            </button>
            <button type="button" class="btn btn-small" aria-label="아래로" @click="move(child, 1)">
              ↓
            </button>
            <button type="button" class="btn btn-small" @click="openEdit(child)">수정</button>
            <button
              type="button"
              class="btn btn-small"
              :disabled="root.archived"
              @click="setArchived(child, !child.archived)"
            >
              {{ child.archived ? '복원' : '보관' }}
            </button>
          </li>
        </ul>
        <button
          v-if="!root.archived"
          type="button"
          class="link-button add-child"
          @click="openNew(root.id)"
        >
          + 하위 분류 추가
        </button>
      </section>
    </div>
    <div class="foot">
      <button
        type="button"
        class="btn btn-primary"
        data-testid="add-category"
        @click="openNew(null)"
      >
        상위 분류 추가
      </button>
      <label class="check"><input v-model="showArchived" type="checkbox" /> 보관된 분류 보기</label>
    </div>

    <BottomSheet
      v-if="editing || newParent !== undefined"
      :title="editing ? '분류 수정' : '분류 추가'"
      testid="category-sheet"
      @close="close"
    >
      <form id="category-form" class="stack" @submit.prevent="save">
        <p v-if="!editing && newParent" class="muted">
          상위 분류: {{ ledger.categoryIndex.get(newParent)?.label }}
        </p>
        <label class="field">
          <span>이름</span>
          <input v-model="name" maxlength="30" required data-testid="category-name" />
        </label>
        <label
          v-if="editing && (editing.parentId !== null || editing.children.length === 0)"
          class="field"
        >
          <span>상위 분류 (옮기기)</span>
          <select v-model="parentId">
            <option :value="null">없음 (상위 분류로)</option>
            <option
              v-for="p in parentOptions.filter((p) => p.id !== editing?.id)"
              :key="p.id"
              :value="p.id"
            >
              {{ p.name }}
            </option>
          </select>
        </label>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      </form>
      <template #footer>
        <button type="button" class="btn" @click="close">취소</button>
        <button type="submit" form="category-form" class="btn btn-primary grow" :disabled="busy">
          저장
        </button>
      </template>
    </BottomSheet>
  </section>
</template>

<style scoped>
.small {
  font-size: 0.85rem;
}
.segmented {
  display: inline-grid;
  grid-template-columns: 1fr 1fr;
  padding: 3px;
  border-radius: 10px;
  background: var(--surface-hover);
  margin-bottom: 12px;
}
.segmented button {
  min-width: 80px;
  min-height: 34px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  font-weight: 600;
  cursor: pointer;
}
.segmented .on {
  background: var(--surface);
  color: var(--text);
}
.tree {
  display: grid;
  gap: 10px;
}
.group {
  padding: 10px 12px;
}
.node {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 40px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.children {
  list-style: none;
  margin: 4px 0 0;
  padding: 0 0 0 16px;
  border-left: 2px solid var(--border);
}
.archived {
  opacity: 0.6;
}
.add-child {
  margin-top: 6px;
  font-size: 0.85rem;
}
.foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 12px;
  gap: 8px;
}
.check {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 0.85rem;
}
.check input {
  width: auto;
}
</style>
