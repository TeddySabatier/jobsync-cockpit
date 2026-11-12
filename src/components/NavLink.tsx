import React, { ForwardRefExoticComponent, RefAttributes } from "react";
import Link from "next/link";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LucideProps } from "lucide-react";
import { cn } from "@/lib/utils";

interface NavLinkProps {
  label: string;
  Icon: ForwardRefExoticComponent<
    Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>
  >;
  route: string;
  pathname: string;
  expanded: boolean;
  // A count shown next to the label (the Review queue's To do items). 0 / undefined: none.
  badge?: number;
}

function NavLink({ label, Icon, route, pathname, expanded, badge }: NavLinkProps) {
  // "/dashboard" is a prefix of every other route, so it only matches exactly.
  const isActive =
    pathname === route ||
    (route !== "/dashboard" && pathname.startsWith(`${route}/`));

  const link = (
    <Link
      href={route}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "navlink h-10 w-full hover:text-foreground",
        isActive ? "text-foreground" : "text-muted-foreground",
        isActive && expanded && "rounded-md bg-accent"
      )}
    >
      {isActive && (
        <span
          aria-hidden
          className="absolute left-0 top-0 h-full w-0.5 bg-foreground"
        />
      )}
      {/* Fixed-width lead box (= collapsed rail width) so the icon sits at the
          same spot in both states and never moves during the slide. */}
      <span className="flex h-full w-14 shrink-0 items-center justify-center">
        <Icon className="h-6 w-6 shrink-0" strokeWidth={1.5} />
        {!!badge && !expanded && (
          <span
            aria-hidden
            className="absolute right-2 top-1 h-2.5 w-2.5 rounded-full bg-primary"
          />
        )}
      </span>
      <span
        className={cn(
          "truncate text-sm transition-opacity duration-200",
          expanded ? "opacity-100 delay-100" : "opacity-0"
        )}
      >
        {label}
      </span>
      {!!badge && (
        <span
          data-testid="nav-badge"
          aria-label={`${badge} to do`}
          className={cn(
            "ml-auto mr-3 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground transition-opacity duration-200",
            expanded ? "opacity-100 delay-100" : "sr-only"
          )}
        >
          {badge}
        </span>
      )}
    </Link>
  );

  // Always render the Tooltip wrapper so the <Link> keeps a stable position in
  // the tree across expand/collapse — remounting it would reset the CSS
  // transitions and make the toggle snap instead of animate.
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      {!expanded && <TooltipContent side="right">{label}</TooltipContent>}
    </Tooltip>
  );
}

export default NavLink;
