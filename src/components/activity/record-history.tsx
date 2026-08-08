import { readRecordHistory } from "@/lib/activity-read";
import { ActivityEntries } from "@/components/activity/activity-entries";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * One record's own history, for its detail page.
 *
 * A server component doing its own query, so a page can drop it in without
 * threading data through: the question "why does this order say 4.95" is asked
 * while looking at that order, and the answer belongs on the same screen.
 *
 * Renders nothing at all when there is no history — an empty card on every
 * record created before this feature existed would be noise on every page.
 */
export async function RecordHistory({
  workspaceId,
  entity,
  entityId,
  title = "History",
}: {
  workspaceId: string;
  entity: string;
  entityId: string;
  title?: string;
}) {
  const entries = await readRecordHistory(workspaceId, entity, entityId);
  if (entries.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="py-0">
        <ActivityEntries entries={entries} showEntity={false} />
      </CardContent>
    </Card>
  );
}
