import type { Role } from "@prisma/client";

// Permission matrix from TECH_SPEC.md section 5.
// Modules map to route segments under /[workspace]/.
// Access levels are ordered; a higher level implies all lower ones.

export type Module =
  | "products" // products + purchases
  | "purchases"
  | "sales" // sales/orders
  | "customers"
  | "partners" // partner finance
  | "treasury"
  | "internal-purchases"
  | "reports"
  | "team" // settings/team
  | "backup"
  | "dashboard";

export type Access = "none" | "view" | "add" | "edit" | "full";

const ORDER: Access[] = ["none", "view", "add", "edit", "full"];

/** Does `have` satisfy `need`? (e.g. "edit" satisfies "view") */
export function satisfies(have: Access, need: Access): boolean {
  return ORDER.indexOf(have) >= ORDER.indexOf(need);
}

// role -> module -> access. Matches the matrix in TECH_SPEC section 5.
const MATRIX: Record<Role, Partial<Record<Module, Access>>> = {
  OWNER: {
    dashboard: "full",
    products: "full",
    purchases: "full",
    sales: "full",
    customers: "full",
    partners: "full",
    treasury: "full",
    "internal-purchases": "full",
    reports: "full",
    team: "full",
    backup: "full",
  },
  PARTNER: {
    dashboard: "view",
    products: "edit",
    purchases: "edit",
    sales: "edit",
    customers: "edit",
    partners: "add", // view own + add own (row-level ownership enforced in the module)
    treasury: "view",
    "internal-purchases": "edit",
    reports: "view",
    team: "none",
    backup: "view",
  },
  MANAGER: {
    dashboard: "view",
    products: "edit", // view + add + edit
    purchases: "edit",
    sales: "edit",
    customers: "edit",
    partners: "view",
    treasury: "view",
    "internal-purchases": "edit",
    reports: "view",
    team: "none",
    backup: "none",
  },
  STAFF: {
    dashboard: "view",
    products: "add", // add only
    purchases: "add",
    sales: "add",
    customers: "add",
    partners: "none",
    treasury: "none",
    "internal-purchases": "add",
    reports: "none",
    team: "none",
    backup: "none",
  },
};

/** Access a role has for a module (before any per-membership overrides). */
export function accessFor(role: Role, module: Module): Access {
  return MATRIX[role]?.[module] ?? "none";
}

/**
 * Effective access: role matrix, then per-membership JSON overrides applied on
 * top. `permissions` is the Membership.permissions JSON blob, shaped as
 * { [module]: Access }.
 */
export function effectiveAccess(
  role: Role,
  module: Module,
  permissions?: unknown,
): Access {
  const base = accessFor(role, module);
  if (permissions && typeof permissions === "object") {
    const override = (permissions as Record<string, unknown>)[module];
    if (typeof override === "string" && ORDER.includes(override as Access)) {
      return override as Access;
    }
  }
  return base;
}

export function can(
  role: Role,
  module: Module,
  need: Access,
  permissions?: unknown,
): boolean {
  return satisfies(effectiveAccess(role, module, permissions), need);
}

// Path segments -> module, for middleware route gating. Settings pages map
// per sub-page: /settings/team needs team access, /settings/backup needs
// backup access, and /settings/appearance is open to every member (null).
export function moduleForSegment(segment: string, subSegment?: string): Module | null {
  if (segment === "settings") {
    if (subSegment === "team") return "team";
    if (subSegment === "backup") return "backup";
    return null;
  }
  const map: Record<string, Module> = {
    dashboard: "dashboard",
    products: "products",
    purchases: "purchases",
    sales: "sales",
    customers: "customers",
    partners: "partners",
    treasury: "treasury",
    "internal-purchases": "internal-purchases",
    reports: "reports",
  };
  return map[segment] ?? null;
}
