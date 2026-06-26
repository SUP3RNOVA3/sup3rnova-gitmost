import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IAiMcpServer } from "@/features/workspace/services/ai-mcp-server-service.ts";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

// Stub react-i18next so `t` returns the key with `{{count}}` interpolated. This
// keeps assertions on the row's OWN label logic, mirroring the t-mock pattern
// used by other component tests in the repo.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts && typeof opts.count === "number"
        ? key.replace("{{count}}", String(opts.count))
        : key,
  }),
}));

// Mock only the network call. The REAL useTestAiMcpServerMutation runs on a real
// QueryClient so each row gets a genuinely independent mutation instance — this
// is exactly the isolation the feature relies on (#170).
const testAiMcpServer = vi.fn();
vi.mock("@/features/workspace/services/ai-mcp-server-service.ts", () => ({
  testAiMcpServer: (id: string) => testAiMcpServer(id),
}));

import AiMcpServerRow from "./ai-mcp-server-row.tsx";

const baseServer = (over?: Partial<IAiMcpServer>): IAiMcpServer => ({
  id: "srv-1",
  name: "Search",
  transport: "http",
  url: "https://example.com/mcp",
  enabled: true,
  toolAllowlist: null,
  hasHeaders: false,
  instructions: null,
  ...over,
});

function renderRow(server: IAiMcpServer, testid: string) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MantineProvider>
        <div data-testid={testid}>
          <AiMcpServerRow
            server={server}
            onEdit={vi.fn()}
            onDelete={vi.fn()}
            onToggleEnabled={vi.fn()}
          />
        </div>
      </MantineProvider>
    </QueryClientProvider>,
  );
}

describe("AiMcpServerRow — inline Test button", () => {
  beforeEach(() => {
    testAiMcpServer.mockReset();
  });

  it("starts in the idle state with a plain 'Test' label", () => {
    renderRow(baseServer(), "row");
    const row = screen.getByTestId("row");
    expect(within(row).getByRole("button", { name: "Test" })).toBeDefined();
  });

  it("shows a green 'OK · N' label with the tool count on success", async () => {
    testAiMcpServer.mockResolvedValue({ ok: true, tools: ["a", "b", "c"] });
    renderRow(baseServer(), "row");
    const row = screen.getByTestId("row");

    fireEvent.click(within(row).getByRole("button", { name: "Test" }));

    await waitFor(() =>
      expect(within(row).getByRole("button", { name: /OK · 3/ })).toBeDefined(),
    );
  });

  it("shows 'Failed' on a connection error", async () => {
    testAiMcpServer.mockResolvedValue({ ok: false, error: "boom" });
    renderRow(baseServer(), "row");
    const row = screen.getByTestId("row");

    fireEvent.click(within(row).getByRole("button", { name: "Test" }));

    await waitFor(() =>
      expect(within(row).getByRole("button", { name: "Failed" })).toBeDefined(),
    );
  });

  it("keeps each row's result isolated (testing one does not affect another)", async () => {
    // Resolve based on id so the two rows get different outcomes.
    testAiMcpServer.mockImplementation(async (id: string) =>
      id === "ok-1"
        ? { ok: true, tools: ["x", "y"] }
        : { ok: false, error: "down" },
    );

    renderRow(baseServer({ id: "ok-1", name: "Good" }), "row-ok");
    renderRow(baseServer({ id: "fail-1", name: "Bad" }), "row-fail");

    const okRow = screen.getByTestId("row-ok");
    fireEvent.click(within(okRow).getByRole("button", { name: "Test" }));

    await waitFor(() =>
      expect(within(okRow).getByRole("button", { name: /OK · 2/ })).toBeDefined(),
    );

    // The untouched row must still be idle — no shared/global pending state.
    const failRow = screen.getByTestId("row-fail");
    expect(within(failRow).getByRole("button", { name: "Test" })).toBeDefined();
  });
});
