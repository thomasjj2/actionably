// Actionably service worker: receives shared images/text from the phone's share sheet.
// It does not cache the app, so updates always load fresh.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method === "POST" && u.pathname === "/share-target") e.respondWith(receive(e.request));
});

async function receive(req) {
  try {
    const fd = await req.formData();
    const c = await caches.open("share-inbox");
    for (const k of await c.keys()) await c.delete(k);
    const files = fd.getAll("shots").filter((f) => f && f.size).slice(0, 20);
    let i = 0;
    for (const f of files) {
      await c.put("/_shared/" + i, new Response(f, { headers: { "Content-Type": f.type || "image/jpeg" } }));
      i++;
    }
    await c.put("/_shared/meta", new Response(
      JSON.stringify({ count: i, title: fd.get("title") || "", text: fd.get("text") || "", url: fd.get("url") || "" }),
      { headers: { "Content-Type": "application/json" } }
    ));
  } catch (err) {}
  return Response.redirect("/?shared=1", 303);
}
