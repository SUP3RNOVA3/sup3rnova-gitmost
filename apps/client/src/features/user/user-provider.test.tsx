import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";

// Control useCurrentUser per test; stub the rest of UserProvider's network/
// socket dependencies so we only exercise its render-gating logic.
const h = vi.hoisted(() => ({ useCurrentUser: vi.fn() }));

vi.mock("@/features/user/hooks/use-current-user", () => ({
  default: h.useCurrentUser,
}));
vi.mock("@/features/auth/queries/auth-query.tsx", () => ({
  useCollabToken: () => ({ data: undefined }),
}));
vi.mock("@/features/websocket/use-query-subscription.ts", () => ({
  useQuerySubscription: () => {},
}));
vi.mock("@/features/websocket/use-tree-socket.ts", () => ({
  useTreeSocket: () => {},
}));
vi.mock("@/features/notification/hooks/use-notification-socket.ts", () => ({
  useNotificationSocket: () => {},
}));
vi.mock("@/main.tsx", () => ({ queryClient: {} }));
vi.mock("@/features/user/connect-resync.ts", () => ({
  makeConnectHandler: () => () => {},
}));
vi.mock("socket.io-client", () => ({
  io: () => ({ on: vi.fn(), disconnect: vi.fn() }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: {
      changeLanguage: vi.fn(),
      language: "en-US",
      resolvedLanguage: "en-US",
    },
  }),
}));

import { UserProvider } from "./user-provider";

const networkError = { message: "Network Error" }; // axios network error: no `response`

function renderProvider() {
  return render(
    <HelmetProvider>
      <MemoryRouter>
        <MantineProvider>
          <UserProvider>
            <div data-testid="app-child">app content</div>
          </UserProvider>
        </MantineProvider>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

beforeEach(() => {
  h.useCurrentUser.mockReset();
});

describe("UserProvider offline render-gating", () => {
  it("renders the app (cached children) when useCurrentUser errors offline but a cached user exists", () => {
    // Offline reload: the persisted ['currentUser'] cache hydrates `data`, but
    // the background POST /api/users/me refetch fails as a network error.
    h.useCurrentUser.mockReturnValue({
      data: {
        user: { id: "u1", locale: "en" },
        workspace: { id: "w1" },
      },
      isLoading: false,
      error: networkError,
      isError: true,
    });

    renderProvider();

    // The cached app must render — NOT a blank fragment (#237/#238).
    expect(screen.getByTestId("app-child")).toBeDefined();
    expect(screen.queryByText("You're offline")).toBeNull();
  });

  it("renders the offline fallback (not a blank fragment) when erroring with no cached user", () => {
    h.useCurrentUser.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: networkError,
      isError: true,
    });

    const { container } = renderProvider();

    // Previously this returned `<></>` — a blank white screen. Now it must show
    // an explicit offline fallback.
    expect(screen.getByText("You're offline")).toBeDefined();
    expect(screen.queryByTestId("app-child")).toBeNull();
    expect(container.textContent?.length).toBeGreaterThan(0);
  });

  it("renders the app normally on a successful currentUser load", () => {
    h.useCurrentUser.mockReturnValue({
      data: {
        user: { id: "u1", locale: "en" },
        workspace: { id: "w1" },
      },
      isLoading: false,
      error: null,
      isError: false,
    });

    renderProvider();
    expect(screen.getByTestId("app-child")).toBeDefined();
  });
});
