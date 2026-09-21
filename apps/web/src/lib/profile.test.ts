import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  currentUserAuthor,
  getCurrentUser,
  getUserProfile,
  setCurrentUser,
} from "./profile.ts";

const store = new Map<string, string>();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  store.clear();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("profile", () => {
  test("falls back to a safe default when nothing is stored", () => {
    expect(getCurrentUser()).toEqual({ id: "user", name: "User" });
  });

  test("roundtrips a stored profile", () => {
    setCurrentUser({ id: "ada", name: "Ada" });
    expect(getCurrentUser()).toEqual({ id: "ada", name: "Ada" });
  });

  test("falls back to default on corrupt or incomplete stored data", () => {
    store.set("worktable-profile", "not json");
    expect(getCurrentUser()).toEqual({ id: "user", name: "User" });

    store.set("worktable-profile", JSON.stringify({ id: "" }));
    expect(getCurrentUser()).toEqual({ id: "user", name: "User" });
  });

  test("builds a user-typed annotation author from the profile", () => {
    setCurrentUser({ id: "ada", name: "Ada" });
    expect(currentUserAuthor()).toEqual({ type: "user", id: "ada", name: "Ada" });
  });

  test("migrates a customized legacy name before replacing its mirror", async () => {
    setCurrentUser({ id: "user", name: "Ada" });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      return Response.json(
        init?.method === "PUT"
          ? { id: "ptc_owner", name: "Ada" }
          : { id: "ptc_owner", name: "Owner" }
      );
    };

    await expect(getUserProfile()).resolves.toEqual({
      id: "ptc_owner",
      name: "Ada",
    });
    expect(requests.map(({ url, init }) => [url, init?.method ?? "GET"])).toEqual(
      [
        ["/api/profile", "GET"],
        ["/api/profile", "PUT"],
      ]
    );
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ name: "Ada" });
    expect(getCurrentUser()).toEqual({ id: "ptc_owner", name: "Ada" });
  });
});
