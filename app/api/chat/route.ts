import { NextRequest } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { getProvider, DEFAULT_MODEL_ID } from "@/lib/providers";
import { generateTitle } from "@/lib/providers/anthropic";
import { TOOL_DEFINITIONS, runTool, toolStatusLabel } from "@/lib/tools";

export const runtime = "nodejs";
// Never statically optimised — every response is a live SSE stream.
export const dynamic = "force-dynamic";

const MAX_TOOL_ROUNDS = 6;

type SseEvent =
  | { type: "conversation"; id: string; title: string; modelId: string }
  | { type: "text"; text: string }
  | { type: "status"; text: string }
  | { type: "status_done" }
  | { type: "title"; id: string; title: string }
  | { type: "done" }
  | { type: "error"; message: string };

function sse(event: SseEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: NextRequest) {
  let body: {
    conversationId?: string;
    modelId?: string;
    content?: Anthropic.ContentBlockParam[];
  };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  const modelId = body.modelId ?? DEFAULT_MODEL_ID;
  const userContent = body.content;
  if (!Array.isArray(userContent) || userContent.length === 0) {
    return new Response("Missing message content", { status: 400 });
  }

  // Create or load the conversation, persist the user message up front so
  // nothing is lost even if the model call fails.
  const isNewConversation = !body.conversationId;
  const conversation = body.conversationId
    ? await prisma.conversation.update({
        where: { id: body.conversationId },
        data: { modelId },
      })
    : await prisma.conversation.create({ data: { modelId } });

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "user",
      content: JSON.stringify(userContent),
    },
  });

  const history = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
  });
  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role as "user" | "assistant",
    content: JSON.parse(m.content),
  }));

  const provider = getProvider(modelId);
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: SseEvent) => {
        try {
          controller.enqueue(sse(e));
        } catch {
          /* stream already closed by the client */
        }
      };
      let streamedText = "";

      const persistPartial = async () => {
        if (streamedText.trim()) {
          await prisma.message.create({
            data: {
              conversationId: conversation.id,
              role: "assistant",
              content: JSON.stringify([{ type: "text", text: streamedText }]),
            },
          });
        }
      };

      send({
        type: "conversation",
        id: conversation.id,
        title: conversation.title,
        modelId,
      });

      // Title generation starts immediately for brand-new conversations —
      // concurrent with the reply stream, never re-run on later messages.
      // On failure the first 40 characters of the message stand in.
      let titleTask: Promise<void> | null = null;
      if (isNewConversation) {
        const firstText = userContent.find(
          (b): b is Anthropic.TextBlockParam => b.type === "text",
        );
        const raw = typeof firstText?.text === "string" ? firstText.text.trim() : "";
        if (raw) {
          titleTask = (async () => {
            const title = (await generateTitle(raw)) ?? raw.slice(0, 40);
            await prisma.conversation.update({
              where: { id: conversation.id },
              data: { title },
            });
            send({ type: "title", id: conversation.id, title });
          })().catch(() => {});
        }
      }

      try {
        let rounds = 0;
        // Tool-use loop: stream, run requested tools, feed results back,
        // keep the text flowing. A failing tool never breaks the stream.
        for (;;) {
          let final: Anthropic.Message | null = null;
          for await (const delta of provider.stream(
            messages,
            TOOL_DEFINITIONS,
            abort.signal,
          )) {
            if (delta.type === "text") {
              streamedText += delta.text;
              send({ type: "text", text: delta.text });
            } else {
              final = delta.message;
            }
          }
          if (!final) break;

          // Persist this assistant turn exactly as produced (text + tool_use)
          await prisma.message.create({
            data: {
              conversationId: conversation.id,
              role: "assistant",
              content: JSON.stringify(final.content),
            },
          });
          streamedText = "";
          messages.push({ role: "assistant", content: final.content });

          if (final.stop_reason !== "tool_use" || rounds >= MAX_TOOL_ROUNDS) {
            break;
          }
          rounds += 1;

          const toolUses = final.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
          );
          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const tu of toolUses) {
            send({ type: "status", text: toolStatusLabel(tu.name) });
            const result = await runTool(tu.name, tu.input);
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: JSON.stringify(result),
              is_error: !result.ok,
            });
          }
          send({ type: "status_done" });

          await prisma.message.create({
            data: {
              conversationId: conversation.id,
              role: "user",
              content: JSON.stringify(results),
            },
          });
          messages.push({ role: "user", content: results });
        }

        if (titleTask) await titleTask;
        send({ type: "done" });
      } catch (err) {
        const aborted =
          abort.signal.aborted ||
          (err instanceof Error && err.name === "AbortError");
        await persistPartial().catch(() => {});
        if (titleTask) await titleTask;
        if (!aborted) {
          const message =
            err instanceof Error ? err.message : "Something went wrong.";
          send({ type: "error", message });
        }
        send({ type: "done" });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Stops nginx-style proxies from holding chunks and releasing them
      // in lumps, which looks identical to client-side jank.
      "x-accel-buffering": "no",
    },
  });
}
