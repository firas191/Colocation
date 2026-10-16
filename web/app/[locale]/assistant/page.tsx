// /assistant (platform P2): the conversation with the orchestrator and its agents (search, legal questions, changes
// to one's own listing). Same API as the Telegram bot.
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Chat } from "@/components/assistant/chat";
import { requireMember } from "@/lib/server/guard";

export async function generateMetadata() {
  const t = await getTranslations("assistant");
  return { title: t("title") };
}

// the agents can take more than a minute on the owner's PC; the server action waits for them
export const maxDuration = 300;

export default async function Assistant({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireMember(locale);
  const t = await getTranslations("assistant");
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
        <p className="max-w-prose text-ink-soft">{t("lead")}</p>
      </header>
      <Chat examples={[t("ex1"), t("ex2"), t("ex3")]} />
    </div>
  );
}
