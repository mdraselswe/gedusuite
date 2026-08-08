import { entityLabel, fieldLabel, type FieldChanges } from "@/lib/activity";

export type ActivityEntry = {
  id: string;
  createdAt: string;
  actorLabel: string;
  action: "CREATE" | "UPDATE" | "DELETE";
  entity: string;
  entityId: string;
  entityLabel: string | null;
  summary: string;
  changes: FieldChanges | null;
  groupId: string | null;
};

const ACTION_STYLE: Record<ActivityEntry["action"], string> = {
  CREATE: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  UPDATE: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  DELETE: "bg-red-500/10 text-red-700 dark:text-red-300",
};

const ACTION_WORD: Record<ActivityEntry["action"], string> = {
  CREATE: "added",
  UPDATE: "changed",
  DELETE: "deleted",
};

/** "—" for nothing, so an empty cell never reads as a missing value. */
function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * One event, as a person reads it: who, what, when — and underneath, the
 * fields that actually moved.
 *
 * Entries sharing a groupId were written by one action (marking cash deposited
 * touches the order and the treasury), so they are drawn as one block. Two
 * lines a second apart with no visible connection is how an audit trail stops
 * being read.
 */
export function ActivityEntries({
  entries,
  showEntity = true,
}: {
  entries: ActivityEntry[];
  /** Off on a record's own history page, where every row is the same record. */
  showEntity?: boolean;
}) {
  if (entries.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Nothing recorded yet.
      </p>
    );
  }

  // Consecutive rows from the same action, kept in the order they arrived.
  const groups: ActivityEntry[][] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last && e.groupId && last[0].groupId === e.groupId) last.push(e);
    else groups.push([e]);
  }

  return (
    <ol className="divide-y">
      {groups.map((group) => {
        const head = group[0];
        return (
          <li key={head.id} className="py-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-xs tabular-nums text-muted-foreground">
                {head.createdAt}
              </span>
              <span className="text-sm font-medium">{head.actorLabel}</span>
              <span
                className={`rounded px-1.5 py-0.5 text-xs ${ACTION_STYLE[head.action]}`}
              >
                {ACTION_WORD[head.action]}
              </span>
              {showEntity && (
                <span className="text-sm text-muted-foreground">
                  {entityLabel(head.entity)}
                  {head.entityLabel ? ` ${head.entityLabel}` : ""}
                </span>
              )}
            </div>

            {group.map((e) => (
              <div key={e.id} className="mt-1 pl-1">
                <p className="text-sm">
                  {group.length > 1 && showEntity === false && (
                    <span className="text-muted-foreground">
                      {entityLabel(e.entity)}:{" "}
                    </span>
                  )}
                  {e.summary}
                </p>
                {e.changes && Object.keys(e.changes).length > 0 && (
                  <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    {Object.entries(e.changes).map(([field, { from, to }]) => (
                      <li
                        key={field}
                        className="text-xs text-muted-foreground tabular-nums"
                      >
                        <span className="font-medium">{fieldLabel(field)}</span>{" "}
                        <span className="line-through">{show(from)}</span>{" "}
                        <span aria-hidden>→</span>{" "}
                        <span className="text-foreground">{show(to)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </li>
        );
      })}
    </ol>
  );
}
