import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { ICurrentUser, IUser } from "@/features/user/types/user.types";
import { IWorkspace } from "@/features/workspace/types/workspace.types";

// `getOnInit: true` (#640, part 2) — read the persisted current user
// SYNCHRONOUSLY at atom init, so the very first frame already has a resolved
// (workspace, user) scope key (`scopeKeyAtom`). Without it, jotai 2.18.1 returns
// the initialValue (null) at t0, not storage, so `scopeKeyAtom` would be
// "anon:anon" on the first frame — and the ydoc DB name / tombstone check /
// eviction would have no real scope to compute against (an anon-scope eviction
// would target a database matching no real DB and falsely report success).
// `undefined` storage keeps jotai's DEFAULT guarded JSON storage (its
// getStringStorage swallows a SecurityError from blocked site-data), so the
// synchronous init read cannot white-screen the app. UserProvider still fetches
// `/me` and overwrites this a tick later, so a stale persisted user is corrected
// within one RTT (its authority is capped to a single round-trip).
export const currentUserAtom = atomWithStorage<ICurrentUser | null>(
  "currentUser",
  null,
  undefined,
  { getOnInit: true },
);

export const userAtom = atom(
  (get) => {
    const currentUser = get(currentUserAtom);
    return currentUser?.user ?? null;
  },
  (get, set, newUser: IUser) => {
    const currentUser = get(currentUserAtom);
    if (currentUser) {
      set(currentUserAtom, {
        ...currentUser,
        user: newUser,
      });
    }
  }
);

export const workspaceAtom = atom(
  (get) => {
    const currentUser = get(currentUserAtom);
    return currentUser?.workspace ?? null;
  },
  (get, set, newWorkspace: IWorkspace) => {
    const currentUser = get(currentUserAtom);
    if (currentUser) {
      set(currentUserAtom, {
        ...currentUser,
        workspace: newWorkspace,
      });
    }
  }
);
