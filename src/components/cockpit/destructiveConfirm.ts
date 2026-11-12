import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The global --destructive token (light: 0 84.2% 60.2%) gives white text only
// 3.60:1, under WCAG AA 4.5:1. The token is shared with the rest of the app,
// so cockpit dialogs override it locally: Tailwind red-700 (#b91c1c) with
// white text is 6.47:1, hover red-800 (#991b1b) 8.31:1. Dark mode keeps the
// token (its own dark value is already above 4.5:1).
export const DESTRUCTIVE_CONFIRM_COLORS = {
  background: "#b91c1c",
  hoverBackground: "#991b1b",
  text: "#ffffff",
} as const;

export const destructiveConfirmClass = cn(
  buttonVariants({ variant: "destructive" }),
  "bg-red-700 text-white hover:bg-red-800 dark:bg-destructive dark:text-destructive-foreground dark:hover:bg-destructive/90",
);
