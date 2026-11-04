import { notFound, redirect } from "next/navigation";
import {
  getAdjacentPackageIds,
  getPackageDetail,
} from "@/actions/cockpit.actions";
import DetailView from "@/components/cockpit/DetailView";

// The page authenticates itself through the actions (requireUser runs first
// inside each); the dashboard layout is not a guard (SPEC §5, AC-40).
export default async function ReviewDetailPage({
  params,
}: {
  params: Promise<{ packageId: string }>;
}) {
  const { packageId } = await params;
  const [result, adjacentResult] = await Promise.all([
    getPackageDetail(packageId),
    getAdjacentPackageIds(packageId),
  ]);

  if (!result.success) {
    if (result.code === "UNAUTHENTICATED") redirect("/signin");
    if (result.code === "COCKPIT_DISABLED" || result.code === "NOT_FOUND") {
      notFound();
    }
    return (
      <p role="alert" className="py-4 text-sm text-destructive">
        {result.message}
      </p>
    );
  }

  // j / k only work for a todo package; ids are null otherwise (§5.3).
  const adjacent = adjacentResult.success
    ? adjacentResult.data
    : { previousId: null, nextId: null };

  return <DetailView detail={result.data} adjacent={adjacent} />;
}
