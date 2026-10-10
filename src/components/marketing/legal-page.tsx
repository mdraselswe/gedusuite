import { display } from "@/components/marketing/fonts";
import { SiteFooter, SiteHeader } from "@/components/marketing/site-chrome";

export type LegalSection = { heading: string; body: string[] };

/** Shared frame for the terms, privacy and refund pages. */
export function LegalPage({
  title,
  updated,
  intro,
  sections,
}: {
  title: string;
  updated: string;
  intro: string;
  sections: LegalSection[];
}) {
  return (
    <div className={`${display.variable} min-h-screen bg-paper text-ink`}>
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-5 py-14">
        <h1 className="font-display text-4xl font-bold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-ink/60">Last updated {updated}</p>
        <p className="mt-6 leading-7 text-ink/85">{intro}</p>
        <div className="mt-10 space-y-8">
          {sections.map((s, i) => (
            <section key={s.heading}>
              <h2 className="font-display text-xl font-semibold">
                {i + 1}. {s.heading}
              </h2>
              <div className="mt-2 space-y-3 leading-7 text-ink/80">
                {s.body.map((p) => (
                  <p key={p}>{p}</p>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
