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

/**
 * One id per intended change, minted before the first attempt and reused by
 * every retry of it.
 *
 * This is what makes a replay safe. "The network dropped" and "the write
 * committed but the answer was lost" look identical from here, so the outbox
 * retries both — and without a stable id the second kind was applied twice.
 */
function newRequestId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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

/**
 * `id` doubles as the request id sent to the server — the queue row and the
 * change it stands for are the same thing, so giving them separate identities
 * would only create a way for them to disagree.
 */
export async function enqueue(
  actionType: string,
  slug: string,
  payload: Record<string, unknown>,
  id: string = newRequestId(),
): Promise<void> {
  const item: QueuedMutation = { id, actionType, slug, payload, createdAt: Date.now() };
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
  id: string;
  actionType: string;
  slug: string;
  payload: Record<string, unknown>;
}): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/mutations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actionType: m.actionType,
      slug: m.slug,
      requestId: m.id,
      payload: m.payload,
    }),
  });
  return res.json();
}

export type SubmitResult = { ok: boolean; queued?: boolean; error?: string };

/**
 * Try the mutation online; if the network is unavailable, queue it and report
 * `queued`. Server-side validation errors are returned as-is (not queued).
 *
 * The id is minted once, up here, and used for both the direct attempt and the
 * queued copy. That is the whole point: when the write reached the server and
 * only the reply was lost, the replay carries the id the server has already
 * seen and gets the original answer back instead of buying the stock again.
 */
export async function submitOrQueue(
  actionType: string,
  slug: string,
  payload: Record<string, unknown>,
): Promise<SubmitResult> {
  const id = newRequestId();
  if (typeof navigator !== "undefined" && navigator.onLine) {
    try {
      return await dispatch({ id, actionType, slug, payload });
    } catch {
      // Network dropped mid-request — fall through to queue, under the same id.
    }
  }
  await enqueue(actionType, slug, payload, id);
  return { ok: true, queued: true };
}

/** A queued write the server refused — kept so somebody can be told. */
export type RejectedMutation = { actionType: string; error: string };

export type FlushResult = {
  flushed: number;
  /**
   * Rejections are dropped from the queue (retrying won't change the answer)
   * but they are NOT dropped from the story. A purchase entered offline that
   * the server later refuses used to vanish without a word — the person who
   * typed it saw "queued", and then nothing, ever.
   */
  rejected: RejectedMutation[];
};

/** Replay queued mutations. Stops on the first network failure (still offline). */
export async function flushQueue(): Promise<FlushResult> {
  const items = await listQueue();
  let flushed = 0;
  const rejected: RejectedMutation[] = [];
  for (const item of items) {
    try {
      const r = await dispatch(item);
      // Remove on success OR on a definitive server rejection (won't succeed on retry).
      if (r.ok || r.error) await removeItem(item.id);
      if (r.ok) flushed += 1;
      else if (r.error) rejected.push({ actionType: item.actionType, error: r.error });
    } catch {
      break; // offline again — leave the rest queued
    }
  }
  return { flushed, rejected };
}
