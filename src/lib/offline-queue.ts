"use client";

// Offline write queue: mutations made while offline are stored in IndexedDB and
// replayed against /api/mutations when connectivity returns. Adopting a form just
// means calling `submitOrQueue(actionType, slug, payload)` instead of the action.

const DB_NAME = "gedusuite-outbox";
const STORE = "mutations";

export type QueuedMutation = {
  id: string;
  actionType: string;
  slug: string;
  payload: Record<string, unknown>;
  createdAt: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

export async function enqueue(
  actionType: string,
  slug: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const item: QueuedMutation = {
    id: (crypto.randomUUID?.() ?? String(Math.random())) + Date.now(),
    actionType,
    slug,
    payload,
    createdAt: Date.now(),
  };
  await tx("readwrite", (s) => s.add(item));
}

export async function listQueue(): Promise<QueuedMutation[]> {
  const all = await tx<QueuedMutation[]>("readonly", (s) => s.getAll());
  return (all ?? []).sort((a, b) => a.createdAt - b.createdAt);
}

async function removeItem(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}

async function dispatch(m: {
  actionType: string;
  slug: string;
  payload: Record<string, unknown>;
}): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/mutations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(m),
  });
  return res.json();
}

export type SubmitResult = { ok: boolean; queued?: boolean; error?: string };

/**
 * Try the mutation online; if the network is unavailable, queue it and report
 * `queued`. Server-side validation errors are returned as-is (not queued).
 */
export async function submitOrQueue(
  actionType: string,
  slug: string,
  payload: Record<string, unknown>,
): Promise<SubmitResult> {
  if (typeof navigator !== "undefined" && navigator.onLine) {
    try {
      const r = await dispatch({ actionType, slug, payload });
      return r;
    } catch {
      // Network dropped mid-request — fall through to queue.
    }
  }
  await enqueue(actionType, slug, payload);
  return { ok: true, queued: true };
}

/** Replay queued mutations. Stops on the first network failure (still offline). */
export async function flushQueue(): Promise<number> {
  const items = await listQueue();
  let flushed = 0;
  for (const item of items) {
    try {
      const r = await dispatch(item);
      // Remove on success OR on a definitive server rejection (won't succeed on retry).
      if (r.ok || r.error) await removeItem(item.id);
      if (r.ok) flushed += 1;
    } catch {
      break; // offline again — leave the rest queued
    }
  }
  return flushed;
}
