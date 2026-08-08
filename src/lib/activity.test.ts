import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { diffFields, fieldLabel, entityLabel } from "@/lib/activity";

describe("diffFields", () => {
  it("reports only the fields that moved", () => {
    const changes = diffFields(
      { deliveryCost: 65, packagingCost: 5, notes: "leave at gate" },
      { deliveryCost: 115, packagingCost: 5, notes: "leave at gate" },
      ["deliveryCost", "packagingCost", "notes"],
    );
    expect(changes).toEqual({ deliveryCost: { from: 65, to: 115 } });
  });

  it("returns null when nothing moved", () => {
    // The signal not to write an entry at all: a save that changed nothing is
    // not an event, and a history full of them is one nobody reads.
    expect(diffFields({ a: 1 }, { a: 1 }, ["a"])).toBeNull();
  });

  it("treats a Decimal and the same number as unchanged", () => {
    // Prisma hands money back as Decimal and forms send numbers. Comparing
    // them raw would log "115 → 115" on every single save.
    const changes = diffFields(
      { deliveryCost: new Prisma.Decimal(115) },
      { deliveryCost: 115 },
      ["deliveryCost"],
    );
    expect(changes).toBeNull();
  });

  it("records a Decimal that really did move, as a number", () => {
    const changes = diffFields(
      { deliveryCost: new Prisma.Decimal(65) },
      { deliveryCost: new Prisma.Decimal(115) },
      ["deliveryCost"],
    );
    expect(changes).toEqual({ deliveryCost: { from: 65, to: 115 } });
  });

  it("shows a date as a date, not an ISO timestamp", () => {
    const changes = diffFields(
      { date: new Date("2026-08-01T00:00:00.000Z") },
      { date: new Date("2026-08-08T00:00:00.000Z") },
      ["date"],
    );
    expect(changes).toEqual({ date: { from: "2026-08-01", to: "2026-08-08" } });
  });

  it("counts null and undefined as the same absence", () => {
    // A field the form omits comes back undefined and the column holds null;
    // that is not somebody changing something.
    expect(diffFields({ deliveryCost: null }, { deliveryCost: undefined }, ["deliveryCost"]))
      .toBeNull();
  });

  it("records a value appearing where there was none", () => {
    expect(diffFields({ courierTrackingId: null }, { courierTrackingId: "278471021" }, [
      "courierTrackingId",
    ])).toEqual({ courierTrackingId: { from: null, to: "278471021" } });
  });
});

describe("labels", () => {
  it("names fields as a shopkeeper reads them", () => {
    expect(fieldLabel("deliveryCost")).toBe("Courier cost");
    expect(fieldLabel("cancelledCollected")).toBe("Collected on cancellation");
  });

  it("falls back to the raw name rather than showing nothing", () => {
    // A new column with no label yet still has to appear in the history.
    expect(fieldLabel("someNewColumn")).toBe("someNewColumn");
    expect(entityLabel("SomeNewModel")).toBe("SomeNewModel");
  });
});
