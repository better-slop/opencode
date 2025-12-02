import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider search={{ hotKey: [{ display: "/", key: "/" }] }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
