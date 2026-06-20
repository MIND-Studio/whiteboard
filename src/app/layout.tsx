import { ThemeProvider } from "@mind-studio/ui";
import { mind } from "@mind-studio/ui/themes";
import type { Metadata } from "next";
import { Fraunces, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { FeedbackLauncher } from "@/components/FeedbackLauncher";

// Fleet webfonts — mirror the shared variables the @mind-studio/ui Mind brand
// expects (display / body / mono), exposed as CSS vars on <html>.
const display = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", display: "swap" });
const body = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jb", display: "swap" });

export const metadata: Metadata = {
  title: "Mind Whiteboard — collaborate, your board in your pod",
  description:
    "A privacy-first collaborative whiteboard built on Solid Pods. Draw, share a link, live-collaborate — the durable board lives in your pod, the relay never persists anything.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // data-mind-theme selects the Mind brand; next-themes toggles `.dark` on
    // <html> at runtime, so suppressHydrationWarning covers the mismatch.
    <html
      lang="en"
      data-mind-theme="mind"
      className={`${display.variable} ${body.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-background text-foreground">
        <ThemeProvider
          theme={mind}
          defaultTheme="dark"
          enableSystem={false}
          storageKey="mind-whiteboard-theme"
        >
          {children}
          <FeedbackLauncher />
        </ThemeProvider>
      </body>
    </html>
  );
}
