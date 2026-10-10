import type { Metadata } from "next";
import { LegalPage } from "@/components/marketing/legal-page";

export const metadata: Metadata = { title: "Privacy policy — GeduSuite" };

export default function PrivacyPage() {
  const contact = process.env.BILLING_SUPPORT_EMAIL || "the support address shown on this site";
  return (
    <LegalPage
      title="Privacy policy"
      updated="11 October 2026"
      intro="This explains what information GeduSuite holds, why, who can see it, and what you can do about it. It covers two kinds of information: the account details of the people who use GeduSuite, and the business records those people enter."
      sections={[
        {
          heading: "What we hold",
          body: [
            "Account information: your name, email address, a securely scrambled form of your password (or a Google sign-in reference), your display preferences, and which workspaces you belong to and in what role.",
            "Business records you enter: products, stock, purchases, suppliers, orders, customers' names, phone numbers and addresses, courier details, payments, partner and treasury entries, advertising spend, and the activity history of changes.",
            "Technical information: the pages and actions used, error reports, and your network address, kept to run, secure and fix the service.",
          ],
        },
        {
          heading: "Why we hold it",
          body: [
            "To provide the service you asked for, to keep it secure, to take and confirm payment for your plan, and to contact you about your account — for example to confirm your email or reset a password. We do not sell your information and we do not use your business records for advertising.",
          ],
        },
        {
          heading: "Whose records they are",
          body: [
            "The customer and order records in your workspace are yours; we handle them on your behalf to run the service. You are responsible for having a proper reason to hold your own customers' details and for how you use them.",
          ],
        },
        {
          heading: "Who can see it",
          body: [
            "Within a workspace, only the people the owner has invited, limited by the role and permissions they were given. Another customer's workspace can never see yours.",
            "Our staff access workspace data only when needed to run the service or to help you with a problem you have raised.",
          ],
        },
        {
          heading: "Services we rely on",
          body: [
            "The service runs on hosted infrastructure: application hosting, a managed database, and email delivery. If you choose to connect Google Drive for backups, a courier for booking parcels, or a WooCommerce website, the relevant information is exchanged with those services using credentials you provide, which we store encrypted.",
            "Our hosting and database providers may store data outside Bangladesh.",
          ],
        },
        {
          heading: "How long we keep it",
          body: [
            "We keep your information while your workspace exists. If you delete the workspace, its records are removed from our live systems; copies in backups are removed as those backups expire. If you delete your account, your sign-in and memberships are removed.",
          ],
        },
        {
          heading: "Your choices",
          body: [
            "You can view and correct your information in the app, download a complete copy of a workspace, delete your account (once you are not its only owner or a partner of record), and ask us to delete a workspace.",
          ],
        },
        {
          heading: "Security",
          body: [
            "Passwords are stored scrambled, stored credentials are encrypted, sessions are protected, and sign-in attempts are rate-limited. No system is perfectly secure; if we learn of a breach that affects you we will tell you promptly.",
          ],
        },
        {
          heading: "Contact",
          body: [`Questions or requests about your information: ${contact}.`],
        },
      ]}
    />
  );
}
