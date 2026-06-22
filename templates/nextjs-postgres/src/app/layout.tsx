import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "__CTX_PROJECT_NAME__ — Next.js + Postgres + Auth.js",
  description: "cortextOS new-project Next.js-fullstack app",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
