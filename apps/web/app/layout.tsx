import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./brand.css";
import { RegisterServiceWorker } from "./register-sw";
import { AuthProvider } from "../lib/auth-context";
import { ToastProvider } from "../lib/toast-context";
import { ThemeProvider } from "../lib/theme-context";
import { LocaleProvider } from "../lib/i18n/locale-context";
import { BottomNav } from "../components/BottomNav";
import { OfflineBanner } from "../components/OfflineBanner";
import { RetailScannerAssist } from "../components/RetailScannerAssist";
import { BRAND_NAME, BRAND_TAGLINE } from "../lib/brand";
import { BuildMarker } from "../components/BuildMarker";

const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("continuixai_theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

export const metadata: Metadata = {
  title: {
    default: BRAND_NAME,
    template: `%s · ${BRAND_NAME}`,
  },
  description: `${BRAND_TAGLINE} Mobile-first operations, barcode scanning, store counting, inventory, distribution, and team work management.`,
  applicationName: BRAND_NAME,
  appleWebApp: {
    capable: true,
    title: BRAND_NAME,
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: "/icons/icon.svg",
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#16235A" },
    { media: "(prefers-color-scheme: dark)", color: "#0E1733" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <RegisterServiceWorker />
        <RetailScannerAssist />
        <LocaleProvider>
          <ThemeProvider>
            <ToastProvider>
              <AuthProvider>
                <OfflineBanner />
                {children}
                <BuildMarker />
                <BottomNav />
              </AuthProvider>
            </ToastProvider>
          </ThemeProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
