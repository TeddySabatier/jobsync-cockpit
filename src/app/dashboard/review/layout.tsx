// The dashboard puts children in a 3-column container-query grid; every review
// page (queue, detail, settings) spans all of it instead of one third.
export default function ReviewLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <div className="col-span-3 min-w-0">{children}</div>;
}
