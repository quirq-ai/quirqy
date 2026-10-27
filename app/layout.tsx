import type { Metadata } from "next";
import "blobatar/motion.css";
import "blobatar/gaze.css";
import "./globals.css";
import { THEME_BOOTSTRAP } from "@/lib/theme";

export const metadata: Metadata = {
  icons: { icon: "/mascot.svg" },
  title: "quirqy | open-chat — a little room for your files",
  description: "A read-only view of your local workspace. Powered by files, shaped like OpenMuse."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning><head><script id="theme-init" dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} /></head><body>{children}</body></html>;
}
