function waitForLinks(timeoutMs = 12000) {
    return new Promise(resolve => {
        const find = () => {
            // anchor patterns that include post id or /me/stats/post/<id>
            const anchors = Array.from(document.querySelectorAll('a[href*="/me/stats/post/"], a[href*="/p/"], a[href*="/post/"]'));
            const uniq = [];
            const seen = new Set();
            for (const a of anchors) {
                const href = a.href.split("?")[0];
                if (seen.has(href)) continue;
                seen.add(href);
                // find title within anchor or nearby
                const titleEl = a.querySelector("h2, h3") || a.closest("article")?.querySelector("h2, h3");
                const title = titleEl ? (titleEl.textContent || titleEl.innerText || "").trim() : (a.textContent || "").trim();
                uniq.push({ href, title, element: a });
            }
            return uniq.length ? uniq : null;
        };

        const initial = find();
        if (initial) return resolve(initial);

        const obs = new MutationObserver(() => {
            const cur = find();
            if (cur) {
                obs.disconnect();
                resolve(cur);
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });

        setTimeout(() => {
            obs.disconnect();
            resolve(find() || []);
        }, timeoutMs);
    });
}

function extractPostIdFromHref(href) {
    try {
        const u = new URL(href, location.origin);
        // /me/stats/post/<id>
        let m = u.pathname.match(/\/me\/stats\/post\/([^/]+)/);
        if (m && m[1]) return m[1];
        // /p/<id>
        m = u.pathname.match(/\/p\/([A-Za-z0-9]+)/);
        if (m && m[1]) return m[1];
        // /@username/<slug>-<id> sometimes
        m = u.pathname.match(/-([a-f0-9]{12,})$/i);
        if (m && m[1]) return m[1];
        return null;
    } catch (e) {
        return null;
    }
}

async function gatherAndSend() {
    const list = await waitForLinks();
    const items = [];
    for (const l of list) {
        const id = extractPostIdFromHref(l.href);
        if (!id) continue;
        items.push({ id, title: l.title || "Untitled", href: l.href });
    }
    // send to background
    chrome.runtime.sendMessage({ action: "collectStatsForPosts", posts: items }, (response) => {
        // background will send result via callback
        // no UI here; popup will request / ask for results
        console.log("collectStatsForPosts response", response);
    });
}

// listen for explicit popup request too
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.action === "collectNow") {
        gatherAndSend().then(() => sendResponse({ ok: true })).catch(err => sendResponse({ error: err.message }));
        return true;
    }
});

// auto-run to warm up
// (we won't auto-fetch network data here; only gather IDs and let background know we have them)
gatherAndSend().catch(() => {});
