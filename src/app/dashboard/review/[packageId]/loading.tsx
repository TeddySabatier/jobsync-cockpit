export default function ReviewDetailLoading() {
  return (
    <div
      className="flex animate-pulse flex-col gap-3 py-4"
      role="status"
      aria-label="Loading package"
    >
      <div className="h-8 w-64 rounded bg-muted" />
      <div className="grid grid-cols-1 gap-4 @3xl/main:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-48 rounded-lg border bg-muted/50" />
        ))}
      </div>
    </div>
  );
}
