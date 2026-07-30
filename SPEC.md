# Build spec — AI chatbot

## How to use this file

Save this as `SPEC.md` in the project root and work against it. Do not treat it as a one-off instruction: re-read it before each feature, and tick items off the acceptance checklist at the bottom only after verifying them in a running browser.

This project is graded. Every item under "Graded requirements" will be tested live, one by one, by someone typing natural language into the chat. A feature that throws an exception and freezes the stream costs more points than a feature that is missing, because it takes the rest of the demo down with it.

---

## Stack

- Next.js (App Router) + TypeScript
- Tailwind CSS
- shadcn/ui component structure
- Anthropic SDK (`@anthropic-ai/sdk`) with streaming
- Persistence: SQLite + Prisma (low setup friction; keep the migration path to Postgres open)
- API keys live only in `.env.local` and never reach the client. Every model call goes through a server route.

## Interface language

The entire UI is in **English** — button labels, placeholders, empty states, error messages, tooltips, sidebar headings, dialog copy. Use sentence case, never Title Case ("New chat", not "New Chat"). This rule covers UI chrome only: the model replies to the user in whatever language the user writes in.

---

## Graded requirements

1. **News fetching** — when the user names any publisher, return that publisher's latest 5 stories as headline + short summary + working link.
2. **Image input** — the user can upload an image and the model can see and describe it.
3. **Multiple models** — the user can switch models inside a conversation.
4. **Conversation history** — past conversations are listed, can be reopened and continued.
5. **Streaming** — responses stream in character by character.

## Bonus requirements

6. **LinkedIn profile reading** — name, headline, company, experience summary for a given profile.
7. **YouTube summarisation** — an accurate summary of the content of a given video link.

---

## Architecture

Drive everything through a tool-use loop. News, LinkedIn and YouTube are **tools the model calls**, not buttons in the UI. The grader will type "what are the BBC's latest headlines", not hunt for a button.

```
/app
  /api/chat/route.ts        POST, SSE stream, tool-use loop
  /api/conversations/...    CRUD
/lib
  /providers/               model abstraction
  /tools/news.ts
  /tools/linkedin.ts
  /tools/youtube.ts
/components
  Chat.tsx  MessageList.tsx  Composer.tsx  Sidebar.tsx  Mascot.tsx  ModelPicker.tsx
```

### Tool error policy — do not skip this

Every tool returns `{ ok: true, data }` or `{ ok: false, reason }`. No tool ever throws. When a tool fails, the model tells the user plainly what it could not do and the conversation continues. A failing tool must never break the stream, blank the page, or lose the conversation.

---

## Feature detail

### 1. News — `fetch_news(publisher, limit = 5)`

The naive approach (fetch the homepage, parse the HTML) fails on roughly half of real publishers: paywalls, JS-rendered article lists, bot protection. Order the strategy:

1. **RSS first.** Nearly every publisher exposes a feed. Keep a hardcoded feed map for well-known outlets (BBC, Reuters, The Guardian, NYT, Hürriyet, Anadolu Ajansı, NTV). For an unknown publisher, fetch the site and look for `<link rel="alternate" type="application/rss+xml">`.
2. If there is no feed, fetch the page and use a readability-style extraction to find the first five article links.
3. If neither works, return `ok: false`.

Each item: headline, one or two sentence summary, publication date, link. State the source and the fetch time in the reply.

### 2. Image input

Add a file picker and drag-and-drop to the composer. Convert to base64 and send as an `image` block in the message content. Downscale client-side so the long edge is at most 1568px before upload — this is both a speed and a token-cost win. Accept png, jpeg, webp, gif. Show a thumbnail of the uploaded image inside the user's message bubble.

### 3. Multiple models

Define one interface under `/lib/providers`:

```ts
interface Provider {
  id: string
  label: string
  supportsVision: boolean
  supportsTools: boolean
  stream(messages, tools, signal): AsyncIterable<Delta>
}
```

Offer at least three options in a dropdown next to the composer. Persist the selected model per conversation. If a non-vision model is selected while an image is attached, warn the user — never drop the image silently.

### 4. Conversation history

Schema: `Conversation(id, title, modelId, createdAt, updatedAt)` and `Message(id, conversationId, role, content JSON, createdAt)`. Store content as JSON so text, images and tool results can live in one record.

Generate the title from the first user message using the model — short, four or five words. List conversations in the sidebar ordered by last update. Support rename and delete.

### 5. Streaming

`/api/chat` returns a `ReadableStream` in SSE format. The client uses `fetch` plus `getReader()` rather than `EventSource`, because the request is a POST. Append deltas to state as they arrive.

Do not break the stream during a tool call: when the model requests a tool, show an inline status line ("fetching headlines…"), run the tool, feed the result back into the loop, and keep the text flowing.

Add a stop button backed by `AbortController`.

### 6. LinkedIn — bonus, highest-risk item

LinkedIn blocks unauthenticated requests and forbids scraping in its terms of service. Do not write a raw scraper: it will fail in the demo and it is not something that should be built.

Instead:
- If a profile-data provider key is present in the environment (`PROFILE_API_KEY`), use that provider.
- If not, the tool returns `ok: false, reason: "LinkedIn profile access is not configured"` and the model says so plainly.
- For a public figure, the model may summarise what it can find through web search, citing sources.

This item either works properly or admits it cannot. It must never invent profile data.

### 7. YouTube — `summarize_youtube(url)`

1. Extract the video ID.
2. Try to fetch a transcript (caption endpoint or a transcript library). Auto-generated captions are acceptable.
3. If the transcript is long, chunk it, summarise each chunk, then summarise the summaries.
4. If there is no transcript, produce a limited summary from title, channel, description and chapter headings, and **state clearly that no transcript was available.** Never fabricate.

Output: three to five key points, a two-sentence overall summary, plus the video title and channel name.

---

## Visual design

### Colour tokens

These were sampled pixel-by-pixel from the mascot video. Use them exactly; do not substitute your own values.

```css
--cat-green:     #88B76E;  /* the cat's body green — primary colour */
--cat-outline:   #366A16;  /* the cat's outline green */
--cat-highlight: #D6F1BD;  /* the cat's light fur tone */
--ink:           #12300A;  /* the only text colour that reads on green */
```

### Layout

- **Page background:** a vertical gradient from `#ffffff` at the top to `var(--cat-green)` at the bottom. Pure white at the top edge, full cat green at the bottom edge.
- **Input bar:** not a large panel. A single pill-shaped bar, max-width 720px, 56px tall, fully rounded (`border-radius: 28px`), white background, thin `var(--cat-outline)` border. The attach button sits inside on the left, the model picker and send button inside on the right. No large bordered container around the conversation.

### Two-state layout

This is the part that matters, not the bar's size. The layout has two states:

**Empty state** — no messages yet. The bar is vertically centred in the viewport with a short greeting line above it. Nothing else on screen: no bordered message panel, no empty box.

**Active state** — once the first message is sent, the bar animates down and docks to the bottom of the viewport with 24px of margin. Messages fill the space above it and scroll behind it. Message bubbles sit directly on the page gradient; there is no card or panel wrapping the thread.

The transition between the two states is a single smooth move of the bar, not a page swap.

The message list needs `padding-bottom` large enough to clear both the docked bar and the mascot above it, so the last message never slides underneath either.
- **Sidebar:** on the left, filled solid `var(--cat-green)`. No gradient.
- **Sidebar text must be `var(--ink)`.** White text on that background measures 2.3:1 contrast and fails WCAG AA; `--cat-outline` measures 2.8:1 and also fails; `--ink` measures 6.2:1 and passes. Do not use white or light grey text anywhere on the green sidebar.
- The active conversation row is marked with a `var(--cat-highlight)` background, text still `--ink`.
- The sidebar toggles open and closed with a smooth slide; conversation rows appear in sequence as it opens.
- One typeface, two weights. Do not reach for heavy weights.
- Under `prefers-reduced-motion: reduce`, disable all animation.

---

## Mascot

Two files are ready and go in `public/`:

| file | length | contents |
|---|---|---|
| `mascot-multiply.mp4` | 14.42s | all four beats: sleep, wake, sit, lie down |
| `mascot-rest-multiply.mp4` | 5.04s | sleeping loop only, optional |

Both are 216×164, share the same canvas, cat scale and ground line, and are interchangeable. **Use `mascot-multiply.mp4` as the primary asset** — it already contains a sleeping loop, so the second file is only needed if a lighter idle-only instance is wanted somewhere else.

### Placement

The cat lies on the top edge of the input bar, anchored toward the left end, roughly 32px in from the bar's left edge.

Size it at **160px wide** (the video is 216×164, so it renders 160×121). Do not use the earlier 72px figure — the cat is meant to read as a character sitting on the bar, not as an icon.

Vertical alignment matters and has an exact answer. Inside the video frame, the cat's ground line sits 23% of the frame height above the bottom edge. So to make the cat's body rest exactly on the bar's top edge, the video element must overlap the bar by 23% of its own height — about 28px at 160px wide. Position it with the video's bottom edge 28px below the bar's top edge, not flush with it.

Reserve at least **100px of clear vertical space above the bar.** When the cat wakes it grows from about 48px of visible height to about 87px, and it must not collide with the message above it or get clipped by the viewport in the empty state.

### Transparency

The video has no alpha channel and its background is pure white. This is handled with a blend mode, not with alpha:

```css
.mascot video { mix-blend-mode: multiply; }
```

White multiplied against any backdrop leaves that backdrop unchanged, so the white rectangle disappears over the gradient as well as over flat white. The background of both files has been clamped to exactly 255 in every single frame specifically so this leaves no visible edge.

Two rules that follow from this: do not give the mascot's container an opaque background or `isolation: isolate`, or the blend will not reach the surface behind it. And do not place the mascot over the deep green lower part of the page — multiply would visibly darken the cat there. At the top-left of the chat box the surface is near white, so there is no issue.

### Beat ranges in `mascot-multiply.mp4`

```ts
const SLEEP = [0.00,  2.58]   // loop, idle state
const WAKE  = [2.58,  4.29]   // play once
const SIT   = [4.29, 13.04]   // ping-pong, awake state
const DOZE  = [13.04, 14.38]  // play once, then SLEEP
```

### Behaviour

- Idle: `SLEEP` loops.
- On click on the mascot, or on focus of the chat input: play `WAKE` once, then enter `SIT`.
- `SIT` ping-pongs: play forward, and at the end step `currentTime` backwards frame by frame until the start, then forward again. Browsers do not support a negative `playbackRate` — do not try `playbackRate = -1`.
- After 15 seconds with no interaction: play `DOZE` at `playbackRate = 0.45` so lying down takes about three seconds, then return to `SLEEP`.
- While the model is generating a response, keep the cat awake. This turns the mascot from decoration into a status indicator.

The video element needs `muted playsinline preload="auto"`; without all of them iOS will not play it.

---

## Acceptance checklist

Verify each of these in a running browser before calling the project done.

- [ ] "Reuters' latest 5 stories" returns five items with headline, summary and a link that opens
- [ ] A publisher never tested before triggers RSS discovery and either works or fails honestly
- [ ] An uploaded image is described correctly by the model
- [ ] Switching model actually changes which model answers the next message
- [ ] After a page reload, past conversations are in the sidebar, open, and continue
- [ ] Responses stream character by character and the stop button works
- [ ] A YouTube link produces an accurate summary, and says so when no transcript exists
- [ ] A LinkedIn profile either returns data or gives a clear "not configured" message — never invented
- [ ] Deliberately breaking one tool leaves the rest of the chat working
- [x] Mascot sleeps when idle, gets up on click, lies down after 15 seconds, and shows no white or grey rectangle around it on any background
- [x] The empty state shows a centred bar with no bordered panel; sending the first message docks the bar to the bottom
- [x] The cat rests exactly on the bar's top edge and does not collide with messages or get clipped when it sits up
- [x] Not a single non-English string remains in the UI
- [x] Sidebar text is comfortably readable on the green background — no white text

---

## Working order

Get the shell and streaming up first, then add tools one at a time. As each tool lands, test its line on the acceptance checklist before moving on. Do not mark an unfinished feature as done.
