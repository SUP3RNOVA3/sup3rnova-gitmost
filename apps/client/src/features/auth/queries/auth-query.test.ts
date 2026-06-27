import { describe, it, expect } from "vitest";
import { AxiosError } from "axios";
import { collabTokenRetry } from "./auth-query";

// Regression for the offline white-screen (#237/#238): offline the collab-token
// POST rejects as an axios NETWORK error (isAxiosError === true but
// error.response === undefined). The old predicate read `error.response.status`
// without a guard and threw an uncaught TypeError inside the React Query retryer
// BEFORE React mounted, blanking the whole app. The predicate must stay total.
describe("collabTokenRetry", () => {
  it("does NOT throw and returns a retryable value for a network error with no response (offline)", () => {
    // An axios error with no `response` is exactly the offline/network-failure shape.
    const networkError = new AxiosError("Network Error");
    expect(networkError.response).toBeUndefined();

    let result: boolean | number = false;
    expect(() => {
      result = collabTokenRetry(0, networkError);
    }).not.toThrow();
    // Network failures stay retryable (truthy), matching the original intent.
    expect(result).toBe(true);
  });

  it("returns false (no retry) for a real 404 response", () => {
    const notFound = new AxiosError("Not Found");
    notFound.response = { status: 404 } as AxiosError["response"];
    expect(collabTokenRetry(0, notFound)).toBe(false);
  });

  it("retries for a non-404 response (e.g. 500)", () => {
    const serverError = new AxiosError("Server Error");
    serverError.response = { status: 500 } as AxiosError["response"];
    expect(collabTokenRetry(0, serverError)).toBe(true);
  });

  it("does not throw and retries for a non-axios error", () => {
    let result: boolean | number = false;
    expect(() => {
      result = collabTokenRetry(0, new Error("boom"));
    }).not.toThrow();
    expect(result).toBe(true);
  });
});
