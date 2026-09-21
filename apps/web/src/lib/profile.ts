import type { AnnotationAuthor } from "@worktable/types";
import { fetchJSON } from "./http";

// The server participant is canonical. Keep a local mirror because annotation
// authors are read synchronously at write time.

export interface UserProfile {
  id: string;
  name: string;
}

const STORAGE_KEY = "worktable-profile";

const DEFAULT_PROFILE: UserProfile = { id: "user", name: "User" };
const DEFAULT_SERVER_NAME = "Owner";
const MAX_PROFILE_NAME_LENGTH = 100;
let profileWriteRevision = 0;
let profileWriteQueue: Promise<unknown> = Promise.resolve();

function serializedProfileWrite<T>(write: () => Promise<T>): Promise<T> {
  const result = profileWriteQueue.then(write, write);
  profileWriteQueue = result.catch(() => undefined);
  return result;
}

export function getCurrentUser(): UserProfile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PROFILE;
    const parsed = JSON.parse(raw) as Partial<UserProfile>;
    if (typeof parsed.id === "string" && parsed.id && typeof parsed.name === "string" && parsed.name) {
      return { id: parsed.id, name: parsed.name };
    }
    return DEFAULT_PROFILE;
  } catch {
    return DEFAULT_PROFILE;
  }
}

export function setCurrentUser(profile: UserProfile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // localStorage unavailable
  }
}

function shouldMigrateLegacyProfile(
  legacy: UserProfile,
  canonical: UserProfile
): boolean {
  return (
    legacy.id === DEFAULT_PROFILE.id &&
    legacy.name !== DEFAULT_PROFILE.name &&
    legacy.name.length <= MAX_PROFILE_NAME_LENGTH &&
    canonical.name === DEFAULT_SERVER_NAME
  );
}

export async function fetchUserProfile(): Promise<UserProfile> {
  // Capture the old browser-only identity before the canonical profile can
  // replace its mirror. Existing installs used this exact default id.
  const legacy = getCurrentUser();
  const requestedAtRevision = profileWriteRevision;
  const profile = await fetchJSON<UserProfile>("/api/profile");
  if (profileWriteRevision !== requestedAtRevision) {
    await profileWriteQueue;
    return fetchJSON<UserProfile>("/api/profile");
  }
  if (!shouldMigrateLegacyProfile(legacy, profile)) return profile;
  return serializedProfileWrite(() =>
    fetchJSON<UserProfile>("/api/profile", {
      method: "PUT",
      body: JSON.stringify({ name: legacy.name }),
    })
  );
}

export async function getUserProfile(): Promise<UserProfile> {
  const profile = await fetchUserProfile();
  setCurrentUser(profile);
  return profile;
}

export async function updateUserProfile(name: string): Promise<UserProfile> {
  profileWriteRevision += 1;
  const profile = await serializedProfileWrite(() =>
    fetchJSON<UserProfile>("/api/profile", {
      method: "PUT",
      body: JSON.stringify({ name }),
    })
  );
  setCurrentUser(profile);
  return profile;
}

export function currentUserAuthor(): AnnotationAuthor {
  const { id, name } = getCurrentUser();
  return { type: "user", id, name };
}
