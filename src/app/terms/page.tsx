import type { Metadata } from "next";
import { LegalPage } from "@/components/marketing/legal-page";
import { GRACE_DAYS, TRIAL_DAYS } from "@/lib/plans";

export const metadata: Metadata = { title: "Terms of service — GeduSuite" };

export default function TermsPage() {
  const contact = process.env.BILLING_SUPPORT_EMAIL || "the support address shown on this site";
  return (
    <LegalPage
      title="Terms of service"
      updated="11 October 2026"
      intro="These terms are the agreement between you and GeduSuite for using the service. By creating an account you agree to them. If you are using GeduSuite for a business, you agree on that business's behalf."
      sections={[
        {
          heading: "The service",
          body: [
            "GeduSuite is business-management software for small shops: products and stock, purchases, orders, couriers, customers, cash, partners and reports. It is provided as a hosted service that you use through a web browser or an installed web app.",
            "We may improve, change or retire features. If we make a change that removes something you rely on, we will tell you in advance.",
          ],
        },
        {
          heading: "Your account and workspace",
          body: [
            "You are responsible for the accuracy of what you enter, for keeping your password safe, and for what the people you invite do in your workspace. The owner of a workspace decides who joins it and what each person can see and do.",
            "You must give a real email address that you control, and you must be old enough to enter into a contract where you live.",
          ],
        },
        {
          heading: "Your data",
          body: [
            "The business information you put into GeduSuite is yours. We use it only to provide the service to you. You can download a complete copy of your workspace at any time, and you can delete your workspace, which removes its data from our systems.",
            "GeduSuite is a record-keeping tool. The figures it shows are calculated from what you enter; you remain responsible for your own accounts, taxes and decisions.",
          ],
        },
        {
          heading: "Trial, plans and payment",
          body: [
            `A new workspace starts with a free trial of ${TRIAL_DAYS} days. No payment details are collected for the trial.`,
            "Paid plans are charged per month or per year, in Bangladeshi taka, in advance. You pay by bKash, Nagad or bank transfer and we activate the plan when we confirm the payment. Prices are shown on the pricing page; if we change them, the change applies from your next renewal.",
            "Yearly plans are charged at ten months' price for twelve months of access.",
          ],
        },
        {
          heading: "When a plan ends",
          body: [
            `When a paid period ends you have ${GRACE_DAYS} more days of normal use. After that the workspace becomes read-only: you can still view, export and back up everything, but you cannot add or change records until you renew.`,
            "We do not delete a workspace because a payment is late. If a trial ends without a plan being chosen, the same read-only rule applies.",
          ],
        },
        {
          heading: "Acceptable use",
          body: [
            "Do not use the service to break the law, to store content you have no right to hold, to try to reach another customer's data, or to interfere with the service or its security. We may suspend a workspace that does, and we will tell the owner why.",
          ],
        },
        {
          heading: "Availability and backups",
          body: [
            "We work to keep the service available and to back up its data, but we cannot promise it will be uninterrupted or error-free. Keep your own downloaded backups of anything you cannot afford to lose.",
          ],
        },
        {
          heading: "Limits on our responsibility",
          body: [
            "To the extent the law allows, we are not liable for indirect or consequential loss, such as lost profit or lost sales, arising from using or being unable to use the service. Our total liability for any claim is limited to the amount you paid us in the three months before it arose.",
          ],
        },
        {
          heading: "Ending the agreement",
          body: [
            "You can stop using GeduSuite and delete your workspace whenever you like. We may end or suspend access for serious or repeated breaches of these terms.",
          ],
        },
        {
          heading: "Changes and contact",
          body: [
            "We may update these terms. If a change is significant we will tell you before it applies. Continuing to use the service afterwards means you accept the updated terms.",
            `Questions about these terms: ${contact}.`,
          ],
        },
      ]}
    />
  );
}
