export const metadata = { title: "Offline — GeduSuite" };

export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-2xl font-bold">You’re offline</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        GeduSuite needs a connection to load this page. Reconnect and try again — any
        page you’ve already opened stays available offline.
      </p>
    </main>
  );
}
