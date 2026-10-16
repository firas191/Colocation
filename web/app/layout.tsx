// The [locale] layout renders <html>; this root layout only passes children through (next-intl pattern).
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
