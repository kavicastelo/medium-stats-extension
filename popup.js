// popup.js
const collectBtn = document.getElementById("collect");
const collectAllBtn = document.getElementById("collectAll");
const fetchBtn = document.getElementById("fetchLast");
const exportBtn = document.getElementById("export");
const statusEl = document.getElementById("status");
const totalsEl = document.getElementById("totals");
const sampleEl = document.getElementById("sample");
const summaryDiv = document.getElementById("summary");
const chart = document.getElementById("chart");
let lastResult = null;

function showStatus(msg) { statusEl.textContent = msg; }

function drawSimpleBar(labels, values) {
    const ctx = chart.getContext("2d");
    ctx.clearRect(0,0,chart.width, chart.height);
    const w = chart.width, h = chart.height, padding = 40;
    const max = Math.max(...values, 1);
    const barW = (w - padding*2) / labels.length * 0.6;
    labels.forEach((lbl,i) => {
        const x = padding + i * ((w - padding*2)/labels.length) + ((w - padding*2)/labels.length - barW)/2;
        const barH = (values[i] / max) * (h - padding*2);
        const y = h - padding - barH;
        ctx.fillStyle = "#2b7cff";
        ctx.fillRect(x,y,barW,barH);
        ctx.fillStyle="#000"; ctx.font="12px Arial"; ctx.textAlign="center";
        ctx.fillText(lbl, x+barW/2, h - padding + 14);
        ctx.fillText(values[i].toLocaleString(), x+barW/2, y - 6);
    });
}

function toCSV(result) {
    const header = ["title","id","href","presentations","views","reads","claps","followersGained","subscribersGained"];
    const rows = result.stats.map(s => header.map(h => (s[h] ?? "").toString().replace(/"/g,'""')));
    const csv = [header.join(",")].concat(rows.map(r => `"${r.join('","')}"`)).join("\n");
    return csv;
}

// helper: ask content script to gather visible posts, returns items array
async function askContentToGather(tabId) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { action: "collectNow" }, (resp) => {
            if (chrome.runtime.lastError) {
                resolve({ error: chrome.runtime.lastError.message });
            } else {
                resolve(resp || { ok: true });
            }
        });
    });
}

collectBtn.addEventListener("click", async () => {
    showStatus("Collecting post IDs from this tab...");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/medium\.com\/.*me\/stats/i.test(tab.url || "")) {
        showStatus("Open the Medium stats page (https://medium.com/me/stats...) and try again.");
        return;
    }

    // Ask content script to gather items and also send them to background automatically.
    // We still need list of items here - so fetch lastMediumStats from storage, or ask background to read stored items
    // Approach: ask content to gather IDs (it will send items to background), then request background to get last stored items and then trigger collect.
    const gatherResp = await askContentToGather(tab.id);
    if (gatherResp && gatherResp.error) {
        showStatus("Content script error: " + gatherResp.error);
        return;
    }

    // Retrieve the collected post items from the page by querying anchors ourselves (just to ensure we have items)
    const getItemsFromTab = () =>
        new Promise(resolve => {
            chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
                if (!tab) return resolve([]);

                chrome.runtime.sendMessage(
                    { action: "SCAN_MEDIUM_TAB", tabId: tab.id },
                    response => resolve(response?.items || [])
                );
            });
        });

    const anchors = await getItemsFromTab();
    if (!anchors.length) {
        showStatus("No posts found on this page (wait for the page to fully load).");
        return;
    }

    // Normalize and extract IDs
    const items = anchors.map(a => {
        try {
            const u = new URL(a.href, tab.url);
            let m = u.pathname.match(/\/me\/stats\/post\/([^/]+)/) || u.pathname.match(/\/p\/([A-Za-z0-9]+)/) || u.pathname.match(/-([a-f0-9]{12,})$/i);
            const id = m ? m[1] : null;
            return id ? { id, title: a.title || "Untitled", href: a.href } : null;
        } catch (e) { return null; }
    }).filter(Boolean);

    // send items to background to collect
    showStatus(`Sending ${items.length} posts to background for GraphQL fetch...`);
    chrome.runtime.sendMessage({ action: "collect", posts: items }, (resp) => {
        if (chrome.runtime.lastError) {
            showStatus("Background error: " + chrome.runtime.lastError.message);
            return;
        }
        if (resp && resp.result) {
            lastResult = resp.result;
            renderResult(lastResult);
            showStatus(`Collected ${lastResult.count} items.`);
            exportBtn.disabled = !(lastResult && lastResult.stats && lastResult.stats.length);
        } else if (resp && resp.error) {
            showStatus("Error: " + resp.error);
        } else {
            showStatus("No response from background.");
        }
    });
});

collectAllBtn.addEventListener("click", async () => {
    showStatus("Scrolling & gathering ALL posts…");

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/medium\.com\/.*me\/stats/i.test(tab.url || "")) {
        showStatus("Open https://medium.com/me/stats first.");
        return;
    }

    try {
        // Inject the scrolling collector directly into the page
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: collectPaginatedInjected
        });

        if (!result || !Array.isArray(result)) {
            showStatus("Failed to collect posts.");
            return;
        }

        const items = result.map(a => {
            const m =
                a.href.match(/\/me\/stats\/post\/([^/]+)/) ||
                a.href.match(/\/p\/([A-Za-z0-9]+)/) ||
                a.href.match(/-([a-f0-9]{12,})$/i);
            return m ? { id: m[1], title: a.title, href: a.href } : null;
        }).filter(Boolean);

        showStatus(`Collected ${items.length} posts. Fetching stats…`);

        chrome.runtime.sendMessage({ action: "collect", posts: items }, (resp) => {
            if (chrome.runtime.lastError) {
                showStatus("Background error: " + chrome.runtime.lastError.message);
                return;
            }
            if (resp?.result) {
                lastResult = resp.result;
                renderResult(lastResult);
                showStatus(`Done! ${lastResult.count} posts.`);
                exportBtn.disabled = false;
            } else {
                showStatus("Background returned no data.");
            }
        });

    } catch (err) {
        console.error(err);
        showStatus("Script injection failed: " + err.message);
    }
});

fetchBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "getLast" }, (resp) => {
        if (resp) {
            lastResult = resp;
            if (resp) {
                renderResult(resp);
                showStatus("Loaded stored results.");
                exportBtn.disabled = !(resp && resp.stats && resp.stats.length);
            } else {
                showStatus("No stored results found.");
            }
        } else {
            showStatus("No stored results.");
        }
    });
});

exportBtn.addEventListener("click", () => {
    if (!lastResult) return;
    const csv = toCSV(lastResult);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "medium-stats.csv";
    a.click();
    URL.revokeObjectURL(url);
});

// Tab switching
document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
        btn.classList.add("active");

        document.querySelectorAll(".tabContent").forEach(c => c.classList.remove("active"));
        document.getElementById(btn.dataset.tab).classList.add("active");
    });
});

function renderTotals(totals) {
    const grid = document.getElementById("totalsGrid");
    grid.innerHTML = `
        <div><strong>Presentations:</strong> ${totals.presentations}</div>
        <div><strong>Views:</strong> ${totals.views}</div>
        <div><strong>Reads:</strong> ${totals.reads}</div>
        <div><strong>Claps:</strong> ${totals.claps}</div>
        <div><strong>Followers Gained:</strong> ${totals.followersGained}</div>
        <div><strong>Subscribers Gained:</strong> ${totals.subscribersGained}</div>
    `;
}

function renderTable(stats) {
    const body = document.querySelector("#articlesTable tbody");
    body.innerHTML = stats.map(s => `
        <tr>
            <td>${s.title}</td>
            <td>${s.views}</td>
            <td>${s.reads}</td>
            <td>${s.claps}</td>
            <td>${s.followersGained}</td>
        </tr>
    `).join("");
}

function renderResult(res) {
    if (!res) return;
    renderTotals(res.totals);
    renderTable(res.stats);
    drawSimpleBar(
        ["Presentations","Views","Reads","Claps","Followers","Subs"],
        [
            res.totals.presentations,
            res.totals.views,
            res.totals.reads,
            res.totals.claps,
            res.totals.followersGained,
            res.totals.subscribersGained
        ]
    );
}

function collectPaginatedInjected() {
    return (async () => {
        function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

        let lastHeight = 0;
        let stableCount = 0;
        const MAX_STABLE = 5;
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
    })();
}
