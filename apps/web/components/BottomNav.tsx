"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "../lib/auth-context";
import { BRAND_NAME } from "../lib/brand";

type NavItem = { href: string; label: string; symbol: string; primary?: boolean; adminOnly?: boolean; managerOnly?: boolean };

const NAV_ITEMS: NavItem[] = [
  { href: "/my-work", label: "My Work", symbol: "✓" },
  { href: "/store-count", label: "Count", symbol: "▦", primary: true },
  { href: "/store-products", label: "Products", symbol: "□" },
  { href: "/store-locations", label: "Locations", symbol: "⌖" },
  { href: "/team-work", label: "Team", symbol: "◎", managerOnly: true },
  { href: "/settings", label: "Settings", symbol: "⚙", adminOnly: true },
];

const PUBLIC_AUTH_ROUTES = new Set(["/login", "/register", "/forgot-password", "/forgot-user-id", "/help"]);

export function BottomNav() {
  const pathname = usePathname();
  const { user, isAdmin } = useAuth();
  if (PUBLIC_AUTH_ROUTES.has(pathname) || pathname.startsWith("/i/")) return null;
  const likelyManager = isAdmin || user?.taskManager === true;
  const visibleItems = NAV_ITEMS.filter((item) => (!item.adminOnly || isAdmin) && (!item.managerOnly || likelyManager));

  return (
    <nav className="bottom-nav" aria-label={`${BRAND_NAME} navigation`}>
      <div className="bottom-nav-inner">
        {visibleItems.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`) || (item.href === "/my-work" && pathname === "/daily-summary");
          return (
            <Link key={item.href} href={item.href} className={`${item.primary ? "scan-tab" : ""} ${active ? "active" : ""}`.trim()} aria-current={active ? "page" : undefined}>
              <span className={item.primary ? "icon-wrap" : undefined}><span className="icon" aria-hidden>{item.symbol}</span></span>{item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
