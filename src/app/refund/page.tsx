import type { Metadata } from "next";
import { LegalPage } from "@/components/marketing/legal-page";
import { TRIAL_DAYS } from "@/lib/plans";

export const metadata: Metadata = { title: "Refund policy — GeduSuite" };

export default function RefundPage() {
  const contact = process.env.BILLING_SUPPORT_EMAIL || "the support address shown on this site";
  return (
    <LegalPage
      title="Refund policy"
      updated="11 October 2026"
      intro="We would rather you try GeduSuite properly before paying than ask for money back afterwards."
      sections={[
        {
          heading: "Try before you pay",
          body: [
            `Every workspace starts with a ${TRIAL_DAYS}-day free trial of the Business plan, with nothing to pay. Use that time with real orders.`,
          ],
        },
        {
          heading: "Refunds",
          body: [
            "If you pay for a plan and it is not working for you, ask within 7 days of the payment and we will refund it in full, to the same bKash, Nagad or bank account it came from.",
            "After 7 days we do not refund a period that has already begun, but you can stop at any time and the plan simply will not renew.",
          ],
        },
        {
          heading: "Mistakes",
          body: [
            "If you were charged twice, or the wrong amount, we will correct it — refund the difference or apply it to your next period, whichever you prefer.",
          ],
        },
        {
          heading: "How to ask",
          body: [
            `Write to ${contact} from the email address on your account with your transaction ID. We reply within two working days.`,
          ],
        },
      ]}
    />
  );
}
