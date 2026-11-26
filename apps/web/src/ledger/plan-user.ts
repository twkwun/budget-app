import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.ts';
import { useLedgerStore } from '../stores/ledger.ts';

/**
 * Whose budgets and 고정지출 a page shows. Every member keeps their own; an
 * admin may pick another member, kept in the `user` query parameter.
 */
export function usePlanUser() {
  const route = useRoute();
  const router = useRouter();
  const auth = useAuthStore();
  const ledger = useLedgerStore();

  const me = computed(() => auth.user?.id ?? 0);
  const userId = computed<number>({
    get: () => {
      const u = Number(route.query.user);
      return auth.isAdmin && Number.isSafeInteger(u) && u > 0 ? u : me.value;
    },
    set: (u) =>
      void router.replace({
        query: { ...route.query, user: u === me.value ? undefined : String(u) },
      }),
  });
  const isSelf = computed(() => userId.value === me.value);
  /** `user` query for links and API calls; empty for the viewer's own. */
  const query = computed((): Record<string, string> =>
    isSelf.value ? {} : { user: String(userId.value) },
  );
  /** `&user=…` to append to an API path. */
  const param = computed(() => (isSelf.value ? '' : `&user=${userId.value}`));
  /**
   * Transaction-list filter for this person's spending: an admin's list holds
   * everyone's, a member's only their own.
   */
  const ownerFilter = computed((): Record<string, string> =>
    auth.isAdmin ? { ownerId: String(userId.value) } : {},
  );
  const name = computed(
    () => ledger.members.find((m) => m.id === userId.value)?.displayName ?? '구성원',
  );
  /** Members an admin can pick from (active ones, plus the one shown). */
  const choices = computed(() =>
    ledger.members.filter((m) => !m.disabled || m.id === userId.value),
  );
  const canPick = computed(() => auth.isAdmin && choices.value.length > 1);

  return { userId, isSelf, query, param, ownerFilter, name, choices, canPick };
}
