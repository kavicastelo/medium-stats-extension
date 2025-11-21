# 📐 API Reference Diagrams

### Message Flow Overview

**Extension-wide communication diagram**

```mermaid
sequenceDiagram
    autonumber

    participant Popup as Popup (popup.js)
    participant CS as Content Script (content.js)
    participant CS2 as Paginated Script (contentScript.js)
    participant BG as Background Service Worker (background.js)
    participant Medium as Medium GraphQL API

    Popup->>CS: collectNow
    CS-->>Popup: { ok: true }

    Popup->>CS: SCAN for visible posts
    CS-->>Popup: { items }

    Popup->>BG: collect { posts }
    BG->>BG: buildOperationsForIds()
    BG->>Medium: batched GraphQL POST
    Medium-->>BG: JSON response
    BG->>BG: assembleResultsFromResponses()
    BG-->>Popup: { stats, totals }

    Popup->>Popup: renderResult()
```

---

### Background Service Worker Architecture

```mermaid
flowchart TD

    A[Start Message Handler] --> B{Action Type?}

    B -->|collect| C["collectForItems(posts)"]
    B -->|collectNow| D["collectNow()"]
    B -->|collectStatsForPosts| E["collectStatsForPosts(posts)"]
    B -->|getLast| F[Return chrome.storage.local.lastMediumStats]
    B -->|SCAN_MEDIUM_TAB| G[Inject scanning script]
    B -->|Unknown| Z[Return error]

    %% collectForItems
    C --> H[Extract IDs]
    H --> I["buildOperationsForIds()"]
    I --> J["Chunk Operations (batch size = 10)"]
    J --> K["postGraphqlBatch()"]
    K --> L["assembleResultsFromResponses()"]
    L --> M[Compute Totals]
    M --> N[Save to chrome.storage.local]
    N --> O[Return Result]
```

---

### GraphQL Request Lifecycle

```mermaid
sequenceDiagram
    autonumber

    participant BG as Background Worker
    participant MAPI as Medium GraphQL Server

    BG->>BG: buildOperationsForIds()
    BG->>BG: chunk() into 10-operation groups

    loop For each batch
        BG->>MAPI: POST /_/graphql\n[batch of operations]
        MAPI-->>BG: responses[]
    end

    BG->>BG: assembleResultsFromResponses()
    BG->>BG: combine metrics (views, reads, claps, followers...)
    BG->>BG: compute totals
    BG-->>Popup: final merged result
```

---

### Content Script Flow (Visible Scan)

```mermaid
flowchart TD

    A[content.js loaded] --> B["waitForLinks()"]
    B -->|anchors found| C[extract href + title]
    C --> D["extractPostIdFromHref()"]
    D --> E["Send posts → background.collectStatsForPosts"]

    E --> F[Listen for popup.collectNow]
    F --> G["gatherAndSend()"]
    G --> E
```

---

### Auto-Pagination Collector Flow (Injected Script)

```mermaid
flowchart TD

    A["collectPaginatedInjected()"] --> B[scrollTo bottom]
    B --> C[sleep 1200ms]

    C --> D["extractItems()"]
    D --> E[Add items to map<href,item>]

    E --> F{Page height changed?}
    F -->|Yes| B
    F -->|No stable| G{Stable count >= 5?}

    G -->|No| B
    G -->|Yes| H[Return all items]
```

---

### Popup UI Rendering Lifecycle

```mermaid
flowchart TD

    A[User clicks Collect or Collect ALL] --> B[Fetch results from background]
    B -->|success| C["renderResult()"]

    C --> D["renderTotals()"]
    C --> E["renderTable()"]
    C --> F["drawSimpleBar()"]

    F --> G[Canvas Chart Updated]
    D --> H[Totals grid updated]
    E --> I[Article table updated]
```

---

### Extension Architecture Map

```mermaid
graph TD

    subgraph Frontend
        Popup[Popup UI]
        Canvas[Chart Renderer]
        Table[Articles Table]
        Totals[Totals Renderer]
    end

    subgraph Scrapers
        CS1[content.js\nvisible scan]
        CS2[contentScript.js\nauto-paginated]
    end

    subgraph Backend
        BG[background.js\nGraphQL Engine]
        Storage[(chrome.storage.local)]
    end

    Medium[Medium GraphQL API]

    Popup --> CS1
    Popup --> CS2
    Popup --> BG

    CS1 --> BG
    CS2 --> Popup
    BG --> Medium

    BG --> Storage
    Popup --> Storage
```

---

### Data Model Diagram

```mermaid
classDiagram

    class ArticleStats {
        string id
        string title
        string href
        number views
        number reads
        number presentations
        number claps
        number followersGained
        number followersLost
        number netFollowerCount
        number subscribersGained
        number subscribersLost
        number netSubscriberCount
        number feedClickThroughRate
    }

    class Totals {
        number presentations
        number views
        number reads
        number claps
        number followersGained
        number subscribersGained
    }

    class Result {
        ArticleStats[] stats
        Totals totals
        number count
        number fetchedAt
    }

    Result --> ArticleStats : contains list
    Result --> Totals : summary of stats
```

---

### Message API Reference Diagram (Extension RPC System)

```mermaid
flowchart LR

    Popup ==> BG:::msg
    CS1 ==> BG:::msg
    CS2 ==> Popup:::msg
    Popup ==> CS1:::msg

    classDef msg fill:#2b7cff,stroke:#0d3f91,color:#fff;

    subgraph Messages
        direction TB
        M1[collect]
        M2[collectNow]
        M3[collectStatsForPosts]
        M4[getLast]
        M5[SCAN_MEDIUM_TAB]
        M6[SCAN_MEDIUM_TAB_PAGINATED]
    end
```
