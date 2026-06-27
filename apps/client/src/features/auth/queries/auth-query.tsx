import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { getCollabToken, verifyUserToken } from "../services/auth-service";
import { ICollabToken, IVerifyUserToken } from "../types/auth.types";
import { isAxiosError } from "axios";

/**
 * Retry predicate for the collab-token query.
 *
 * Offline (or any network failure) the POST rejects as an axios NETWORK error:
 * `isAxiosError(error) === true` but `error.response === undefined`. Reading
 * `error.response.status` without a guard threw an uncaught TypeError inside the
 * React Query retryer BEFORE React mounted, white-screening the whole app on an
 * offline cold boot (#237/#238). Optional-chaining `error.response?.status`
 * keeps the predicate total: a network error (no response) is retryable, a real
 * 404 is not. Extracted (and exported) so it can be unit-tested in isolation.
 */
export function collabTokenRetry(
  _failureCount: number,
  error: Error,
): boolean {
  if (isAxiosError(error) && error.response?.status === 404) {
    return false;
  }
  return true;
}

export function useVerifyUserTokenQuery(
  verify: IVerifyUserToken,
): UseQueryResult<any, Error> {
  return useQuery({
    queryKey: ["verify-token", verify],
    queryFn: () => verifyUserToken(verify),
    enabled: !!verify.token,
    staleTime: 0,
  });
}

export function useCollabToken(): UseQueryResult<ICollabToken, Error> {
  return useQuery({
    queryKey: ["collab-token"],
    queryFn: () => getCollabToken(),
    staleTime: 20 * 60 * 60 * 1000, //20hrs
    //refetchInterval: 12 * 60 * 60 * 1000, // 12hrs
    //refetchIntervalInBackground: true,
    refetchOnMount: true,
    retry: collabTokenRetry,
    retryDelay: (retryAttempt) => {
      // Exponential backoff: 5s, 10s, 20s, etc.
      return 5000 * Math.pow(2, retryAttempt - 1);
    },
  });
}
