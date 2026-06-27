import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { getMyInfo } from "@/features/user/services/user-service";
import { ICurrentUser } from "@/features/user/types/user.types";

/**
 * Centralized React Query key factory for current-user queries. This hook and
 * the offline warm path (features/offline/make-offline.ts) share it so the
 * runtime key can never silently drift, and the OFFLINE_PERSIST_ROOTS guard
 * test can assert the persisted "currentUser" root maps to a real factory.
 */
export const userKeys = {
  currentUser: () => ["currentUser"] as const,
};

export default function useCurrentUser(): UseQueryResult<ICurrentUser> {
  return useQuery({
    queryKey: userKeys.currentUser(),
    queryFn: async () => {
      return await getMyInfo();
    },
  });
}
