import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteAccount, getMe, signIn, signOut, signUp, type User } from '@/lib/api';

export const meKey = ['me'] as const;

/** Who's signed in (null when nobody). Shared by every component via the query cache. */
export function useMe() {
  return useQuery({ queryKey: meKey, queryFn: getMe, staleTime: 5 * 60_000 });
}

export function useAuthActions() {
  const qc = useQueryClient();
  const setUser = (user: User | null) => {
    qc.setQueryData(meKey, user);
    // Saved regions/history belong to the previous user: refetch or drop.
    void qc.invalidateQueries({ queryKey: ['library'] });
  };
  return {
    signIn: useMutation({ mutationFn: (v: { email: string; password: string }) => signIn(v.email, v.password), onSuccess: setUser }),
    signUp: useMutation({ mutationFn: (v: { email: string; password: string }) => signUp(v.email, v.password), onSuccess: setUser }),
    signOut: useMutation({ mutationFn: signOut, onSuccess: () => setUser(null) }),
    deleteAccount: useMutation({ mutationFn: (password: string) => deleteAccount(password), onSuccess: () => setUser(null) }),
  };
}
