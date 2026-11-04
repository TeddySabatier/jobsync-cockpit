import { notFound, redirect } from "next/navigation";
import { getGmailSettings } from "@/actions/cockpitGmail.actions";
import GmailCard from "@/components/cockpit/GmailCard";
import { oauthErrorMessage } from "@/lib/cockpit/gmail/oauth";

// The page authenticates itself through the action (requireUser runs first
// inside it); the dashboard layout is not a guard (SPEC §5, AC-40).
export default async function ReviewSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; connected?: string | string[] }>;
}) {
  const { error, connected } = await searchParams;
  const result = await getGmailSettings();

  if (!result.success) {
    if (result.code === "UNAUTHENTICATED") redirect("/signin");
    if (result.code === "COCKPIT_DISABLED") notFound();
    return (
      <p role="alert" className="py-4 text-sm text-destructive">
        {result.message}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      <h3 className="text-2xl font-semibold leading-none tracking-tight">
        Review settings
      </h3>
      <GmailCard
        account={result.data.account}
        missingEnv={result.data.missingEnv}
        errorMessage={error === undefined ? null : oauthErrorMessage(error)}
        justConnected={connected === "1"}
      />
    </div>
  );
}
