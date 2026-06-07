import type { Metadata } from "next";
import { ThemeProvider } from "@mind-studio/ui";
import { mind } from "@mind-studio/ui/themes";
import "./globals.css";
import { FeedbackLauncher } from "@/components/FeedbackLauncher";

export const metadata: Metadata = {
  title: "Mind Whiteboard — collaborate, your board in your pod",
  description:
    "A privacy-first collaborative whiteboard built on Solid Pods. Draw, share a link, live-collaborate — the durable board lives in your pod, the relay never persists anything.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // data-mind-theme selects the Mind brand; next-themes toggles `.dark` on
    // <html> at runtime, so suppressHydrationWarning covers the mismatch.
    <html lang="en" data-mind-theme="mind" suppressHydrationWarning>
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
