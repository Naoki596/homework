import "./globals.css";

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "NPBニュース（球団別）",
  description:
    "NPB 12球団から選ぶと、GoogleニュースRSSから直近ニュースを3件表示します（snippet整形・APIキー不要）。"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <div className="container">{children}</div>
      </body>
    </html>
  );
}

