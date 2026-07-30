import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { DEFAULT_MODEL_ID } from "@/lib/providers";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim();
  const conversations = await prisma.conversation.findMany({
    // Live sidebar search: match on the title or anywhere in the stored
    // message content (JSON blocks, so this also catches assistant text).
    where: q
      ? {
          OR: [
            { title: { contains: q } },
            { messages: { some: { content: { contains: q } } } },
          ],
        }
      : undefined,
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, modelId: true, updatedAt: true },
  });
  return NextResponse.json(conversations);
}

export async function DELETE() {
  await prisma.conversation.deleteMany();
  return NextResponse.json({ ok: true });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const conversation = await prisma.conversation.create({
    data: { modelId: body.modelId ?? DEFAULT_MODEL_ID },
  });
  return NextResponse.json(conversation);
}
