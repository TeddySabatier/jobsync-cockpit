"use client";
import { useRouter } from "next/navigation";
import { useFocusRefresh } from "./useFocusRefresh";

// Renders nothing. Re-fetches the page's server data when the owner comes back
// to this tab, at most every 15 s (D-041): after pasting a prompt into Claude
// the queue shows what the bot submitted without a manual reload.
export default function FocusRefresh() {
  const router = useRouter();
  useFocusRefresh(() => router.refresh());
  return null;
}
