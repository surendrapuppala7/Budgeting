const FIREBASE_AUTH_ORIGIN = "https://ledger-d3ec5.firebaseapp.com";

export async function onRequest(context) {
    const incomingUrl = new URL(context.request.url);

    const targetUrl = new URL(
        `${FIREBASE_AUTH_ORIGIN}${incomingUrl.pathname}${incomingUrl.search}`
    );

    const headers = new Headers(context.request.headers);
    headers.delete("host");
    headers.delete("cf-connecting-ip");
    headers.delete("cf-ipcountry");
    headers.delete("cf-ray");
    headers.delete("cf-visitor");
    headers.delete("x-forwarded-proto");
    headers.delete("x-real-ip");

    const requestInit = {
        method: context.request.method,
        headers,
        redirect: "manual"
    };

    if (!["GET", "HEAD"].includes(context.request.method)) {
        requestInit.body = await context.request.arrayBuffer();
    }

    const firebaseResponse = await fetch(targetUrl.toString(), requestInit);

    const responseHeaders = new Headers(firebaseResponse.headers);

    const location = responseHeaders.get("location");
    if (location) {
        responseHeaders.set(
            "location",
            location.replace(FIREBASE_AUTH_ORIGIN, incomingUrl.origin)
        );
    }

    return new Response(firebaseResponse.body, {
        status: firebaseResponse.status,
        statusText: firebaseResponse.statusText,
        headers: responseHeaders
    });
}
