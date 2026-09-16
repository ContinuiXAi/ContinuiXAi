import type { MetadataRoute } from "next";
import { BRAND_NAME, BRAND_TAGLINE } from "../lib/brand";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND_NAME,
    short_name: BRAND_NAME,
    description: `${BRAND_TAGLINE} Mobile-first retail and wholesale operations, store counting, inventory, and team work management.`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#16235A",
    orientation: "portrait",
    categories: ["business", "productivity", "utilities"],
    icons: [
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Start Count", short_name: "Count", description: "Open the store counting workflow.", url: "/store-count", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
      { name: "Products", short_name: "Products", description: "Search and manage the retail product catalog.", url: "/store-products", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
      { name: "Locations", short_name: "Locations", description: "Manage store aisle, section, bin, or department locations.", url: "/store-locations", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
    ],
  };
}
