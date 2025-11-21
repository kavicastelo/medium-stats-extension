// (MV3 service worker)

const GRAPHQL_URL = "https://medium.com/_/graphql";
const BATCH_SIZE = 10;
const REQUEST_TIMEOUT = 20000;

// === VALID GraphQL Operations (2025) ================================

// Combined Funnel + Impact data
const OP_FULL_STATS = `
query FullPostStats(
  $postStatsTotalBundleInput: PostStatsTotalBundleInput!,
  $postId: ID!
) {
  postStatsTotalBundle(postStatsTotalBundleInput: $postStatsTotalBundleInput) {
    post { id }
    readersCount
    viewersCount
    feedClickThroughRate
    presentationCount
    followersGained
    followersLost
    netFollowerCount
    subscribersGained
    subscribersLost
    netSubscriberCount
    __typename
  }

  postResult(id: $postId) {
    __typename
    ... on Post {
      id
      clapCount
    }
  }
}
`;

// ====================================================================

function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

async function postGraphqlBatch(operations) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

        const res = await fetch(GRAPHQL_URL, {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
                accept: "*/*",
                "x-client-version": "web-2025.01.15",
                "x-acquire-token": "true"
            },
            body: JSON.stringify(operations),
            signal: controller.signal
        });

        clearTimeout(timeout);
        if (!res.ok) throw new Error("Medium GraphQL failed: " + res.status);

        const text = await res.text();

        try {
            return JSON.parse(text);
        } catch (e) {
            return JSON.parse(text.trim());
        }
    } catch (err) {
        console.warn("postGraphqlBatch error", err);
        throw err;
    }
}

// === Build operations for each post ================================
// 2 operations per post: full bundle + claps
function buildOperationsForIds(ids) {
    const ops = [];
    for (const id of ids) {
        ops.push({
            operationName: "FullPostStats",
            variables: {
                postStatsTotalBundleInput: { postId: id },
                postId: id
            },
            query: OP_FULL_STATS
        });
    }
    return ops;
}

// === Assemble results ===============================================
function assembleResultsFromResponses(ids, responses) {
    const results = {};

    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        results[id] = {
            id,
            claps: 0,
            presentations: 0,
            views: 0,
            reads: 0,
            feedClickThroughRate: 0,
            followersGained: 0,
            followersLost: 0,
            netFollowerCount: 0,
            subscribersGained: 0,
            subscribersLost: 0,
            netSubscriberCount: 0
        };

        const resp = responses[i]; // 1 operation per post

        const bundle = resp?.data?.postStatsTotalBundle;
        const clapsBlock = resp?.data?.postResult;

        // bundle fields
        if (bundle) {
            if (typeof bundle.presentationCount === "number")
                results[id].presentations = bundle.presentationCount;

            if (typeof bundle.viewersCount === "number")
                results[id].views = bundle.viewersCount;

            if (typeof bundle.readersCount === "number")
                results[id].reads = bundle.readersCount;

            if (typeof bundle.feedClickThroughRate === "number")
                results[id].feedClickThroughRate = bundle.feedClickThroughRate;

            if (typeof bundle.followersGained === "number")
                results[id].followersGained = bundle.followersGained;

            if (typeof bundle.followersLost === "number")
                results[id].followersLost = bundle.followersLost;

            if (typeof bundle.netFollowerCount === "number")
                results[id].netFollowerCount = bundle.netFollowerCount;

            if (typeof bundle.subscribersGained === "number")
                results[id].subscribersGained = bundle.subscribersGained;

            if (typeof bundle.subscribersLost === "number")
                results[id].subscribersLost = bundle.subscribersLost;

            if (typeof bundle.netSubscriberCount === "number")
                results[id].netSubscriberCount = bundle.netSubscriberCount;
        }

        // claps
        if (clapsBlock?.clapCount != null) {
            results[id].claps = clapsBlock.clapCount;
        }
    }

    return results;
}

// === Main collector ==================================================
async function collectForItems(items) {
    const ids = items.map(i => i.id);
    if (!ids.length) return { stats: [], totals: {}, count: 0 };

    const operations = buildOperationsForIds(ids);

    const opChunks = chunk(operations, Math.max(1, BATCH_SIZE));
    const responses = [];

    for (const chunkOps of opChunks) {
        try {
            const batch = await postGraphqlBatch(chunkOps);
            responses.push(...batch);
        } catch (err) {
            for (let i = 0; i < chunkOps.length; i++)
                responses.push({ errors: [{ message: err.message }] });
        }
    }

    const assembled = assembleResultsFromResponses(ids, responses);

    const stats = items.map(it => {
        const data = assembled[it.id] || {};
        return {
            title: it.title,
            href: it.href,
            id: it.id,
            claps: data.claps || 0,
            presentations: data.presentations || 0,
            views: data.views || 0,
            reads: data.reads || 0,
            feedClickThroughRate: data.feedClickThroughRate || 0,
            followersGained: data.followersGained || 0,
            followersLost: data.followersLost || 0,
            netFollowerCount: data.netFollowerCount || 0,
            subscribersGained: data.subscribersGained || 0,
            subscribersLost: data.subscribersLost || 0,
            netSubscriberCount: data.netSubscriberCount || 0
        };
    });

    const totals = stats.reduce(
        (a, s) => {
            a.presentations += s.presentations;
            a.views += s.views;
            a.reads += s.reads;
            a.claps += s.claps;
            a.followersGained += s.followersGained;
            a.subscribersGained += s.subscribersGained;
            return a;
        },
        { presentations: 0, views: 0, reads: 0, claps: 0, followersGained: 0, subscribersGained: 0 }
    );

    await chrome.storage.local.set({
        lastMediumStats: {
            stats,
            totals,
            count: stats.length,
            fetchedAt: Date.now()
        }
    });

    return { stats, totals, count: stats.length };
}

// === collectNow: scrape page =========================================
async function collectNow() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("No active tab");

    const scanResult = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
            const anchors = Array.from(
                document.querySelectorAll(
                    'a[href*="/me/stats/post/"], a[href*="/p/"], a[href*="/post/"]'
                )
            );

            const uniq = [];
            const seen = new Set();

            anchors.forEach(a => {
                const href = a.href.split("?")[0];
                if (seen.has(href)) return;

                seen.add(href);
                const title =
                    (a.querySelector("h2, h3") ||
                        a.closest("article")?.querySelector("h2, h3") ||
                        a).innerText || "";

                uniq.push({ href, title });
            });

            return uniq;
        }
    });

    const items = scanResult?.[0]?.result || [];
    if (items.length === 0) return { stats: [], totals: {}, count: 0 };

    const normalized = items
        .map(o => {
            const match = o.href.match(/([0-9a-f]{10,})/i);
            return { ...o, id: match ? match[1] : null };
        })
        .filter(x => x.id);

    return await collectForItems(normalized);
}

// === collectStatsForPosts ===========================================
async function collectStatsForPosts(posts) {
    if (!Array.isArray(posts) || posts.length === 0)
        throw new Error("No posts provided");

    const items = posts
        .map(p => {
            if (typeof p === "string") {
                const match = p.match(/([0-9a-f]{10,})/i);
                return { id: match ? match[1] : null, href: p, title: "" };
            }

            if (typeof p === "object") {
                let id = p.id;
                if (!id && p.href) {
                    const match = p.href.match(/([0-9a-f]{10,})/i);
                    id = match ? match[1] : null;
                }
                return { id, href: p.href || "", title: p.title || "" };
            }

            return null;
        })
        .filter(x => x && x.id);

    return await collectForItems(items);
}

// === Message handler =================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.action) {
        sendResponse({ error: "no message" });
        return true;
    }

    if (msg.action === "collect") {
        collectForItems(msg.posts || [])
            .then(result => sendResponse({ ok: true, result }))
            .catch(err => sendResponse({ error: err?.message }));
        return true;
    }

    if (msg.action === "collectNow") {
        collectNow()
            .then(result => sendResponse({ ok: true, result }))
            .catch(err => sendResponse({ error: err?.message }));
        return true;
    }

    if (msg.action === "collectStatsForPosts") {
        collectStatsForPosts(msg.posts || [])
            .then(result => sendResponse({ ok: true, result }))
            .catch(err => sendResponse({ error: err?.message }));
        return true;
    }

    if (msg.action === "getLast") {
        chrome.storage.local.get(["lastMediumStats"], value => {
            sendResponse(value.lastMediumStats || null);
        });
        return true;
    }

    if (msg.action === "SCAN_MEDIUM_TAB") {
        chrome.scripting.executeScript(
            {
                target: { tabId: msg.tabId },
                func: () => {
                    const anchors = Array.from(
                        document.querySelectorAll(
                            'a[href*="/me/stats/post/"], a[href*="/p/"], a[href*="/post/"]'
                        )
                    );
                    const uniq = [];
                    const seen = new Set();

                    anchors.forEach(a => {
                        const href = a.href.split("?")[0];
                        if (seen.has(href)) return;
                        seen.add(href);

                        const title =
                            (a.querySelector("h2, h3") ||
                                a.closest("article")?.querySelector("h2, h3") ||
                                a).innerText || "";

                        uniq.push({ href, title });
                    });

                    return uniq;
                }
            },
            results => {
                if (chrome.runtime.lastError) {
                    sendResponse({ items: [] });
                } else {
                    sendResponse({ items: results?.[0]?.result || [] });
                }
            }
        );
        return true;
    }

    sendResponse({ error: "unknown action" });
    return false;
});
