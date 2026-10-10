# Golden flows

The flows that must behave identically before and after the SaaS upgrade. The
automated E2E suite (phase 7) walks all of them; this list is also the manual
smoke test before a production deploy.

1. **Sign in** — email/password and Google; land on the workspace picker.
2. **Product → purchase → stock** — create a product with variants, record a
   purchase; stock and inventory value rise by exactly qty and qty × unit cost.
3. **Order → profit** — create a multi-item order with discount, gift,
   packaging; order profit equals `orderNetProfit`.
4. **Courier booking** — book with Steadfast; COD fee and courier cost quoted
   from the rate card.
5. **Delivery → cash** — mark delivered; collection, courier deduction and net
   deposit match `depositAmount`; treasury entry appears.
6. **Return / cancellation** — stock restored, return-leg charges applied.
7. **Partner money** — investment, expense reimbursement, withdrawal,
   profit distribution; partner balance and treasury pot agree.
8. **Reports** — dashboard, reports and per-product profitability show the same
   figures for the same period as the orders list.
9. **Website lead** — WooCommerce webhook creates a lead; call list updates.
10. **Backup** — manual JSON backup, restore preview.
11. **Offline queue** — create an order offline, reconnect, it syncs once.
12. **Roles** — OWNER / PARTNER / MANAGER / STAFF see exactly what the matrix
    in `src/lib/rbac.ts` says.
