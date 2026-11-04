export default function ReviewLoading() {
  return (
    <div
      className="flex animate-pulse flex-col gap-3 py-4"
      role="status"
      aria-label="Loading review queue"
    >
      <div className="h-8 w-64 rounded bg-muted" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-20 rounded-lg border bg-muted/50" />
      ))}
    </div>
  );
}
