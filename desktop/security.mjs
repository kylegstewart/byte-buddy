export function isAppDocument(value, expected) {
    try {
        const actual = new URL(value);
        const app = new URL(expected);
        return actual.origin === app.origin && actual.pathname === app.pathname && !actual.search;
    } catch { return false; }
}

export function safeExternalUrl(value) {
    try {
        const url = new URL(value);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || /^(localhost|127\.|\[::1\])/i.test(url.hostname)) return null;
        return url.href;
    } catch { return null; }
}
