async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Extract all post anchors on the page
function extractItems() {
    const anchors = Array.from(
        document.querySelectorAll('a[href*="/me/stats/post/"], a[href*="/p/"], a[href*="/post/"]')
    );

    const out = [];
    const seen = new Set();

    anchors.forEach(a => {
        const href = a.href.split("?")[0];
        if (seen.has(href)) return;
        seen.add(href);

        const title =
            (a.querySelector("h2, h3") ||
                a.closest("article")?.querySelector("h2, h3") ||
                a).innerText || "Untitled";

        out.push({ href, title });
    });

    return out;
}

// Auto scroll pagination
async function collectPaginated() {
    let lastHeight = 0;
    let stableCount = 0;
    const MAX_STABLE = 5; // when no new posts appear for 5 cycles, stop
    const results = new Map();

    while (true) {
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(1200);

        const items = extractItems();
        items.forEach(i => results.set(i.href, i));

        const height = document.body.scrollHeight;

        if (height === lastHeight) {
            stableCount++;
            if (stableCount >= MAX_STABLE) break;
        } else {
            stableCount = 0;
        }

        lastHeight = height;
    }

    return [...results.values()];
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "SCAN_MEDIUM_TAB_PAGINATED") {
        (async () => {
            try {
                const items = await collectPaginated();
                sendResponse({ items });
            } catch (e) {
                sendResponse({ items: null, error: e.toString() });
            }
        })();
        return true;
    }
});
