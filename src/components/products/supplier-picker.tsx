"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AsyncCombobox, type ComboOption } from "@/components/ui/async-combobox";
import { searchSuppliers } from "@/server/actions/search";
import { createSupplier } from "@/server/actions/suppliers";
import { Field } from "@/components/ui/field";

/**
 * Supplier autocomplete + an inline "add supplier" shortcut, so a new
 * supplier can be created without leaving the purchase form (Products >
 * Suppliers is otherwise the only place to add one).
 */
export function SupplierPicker({
  slug,
  value,
  onChange,
  disabled,
}: {
  slug: string;
  value: ComboOption | null;
  onChange: (option: ComboOption | null) => void;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const res = await createSupplier(slug, fd);
    setLoading(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Supplier added");
    if (res.id && res.name) onChange({ value: res.id, label: res.name });
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <div className="flex gap-2">
        <AsyncCombobox
          className="flex-1"
          value={value}
          onChange={onChange}
          disabled={disabled}
          fetchPage={async (q, cursor) => {
            const res = await searchSuppliers(slug, q, cursor);
            return res.ok ? { items: res.items, next: res.next } : { items: [], next: null };
          }}
          placeholder="No supplier"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Add supplier"
          title="Add supplier"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <Plus />
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add supplier</DialogTitle>
          </DialogHeader>
          <form onSubmit={onSubmit} className="space-y-4">
            <Field name="name" label="Name" required>
              <Input id="qs-name" name="name" required autoFocus />
            </Field>
            <Field name="phone" label="Phone">
              <Input id="qs-phone" name="phone" />
            </Field>
            <Field name="altPhone" label="Alternate phone">
              <Input id="qs-alt-phone" name="altPhone" />
            </Field>
            <Field name="address" label="Address">
              <Input id="qs-address" name="address" />
            </Field>
            <Field name="notes" label="Notes">
              <Textarea id="qs-notes" name="notes" />
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={loading}>
                {loading ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
