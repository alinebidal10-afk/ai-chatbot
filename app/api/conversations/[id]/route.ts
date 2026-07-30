import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const conversation = await prisma.conversation.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!conversation) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({
    ...conversation,
    messages: conversation.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: JSON.parse(m.content),
      createdAt: m.createdAt,
    })),
  });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const data: { title?: string; modelId?: string } = {};
  if (typeof body.title === "string" && body.title.trim()) {
    data.title = body.title.trim().slice(0, 120);
  }
  if (typeof body.modelId === "string") data.modelId = body.modelId;
  const conversation = await prisma.conversation
    .update({ where: { id }, data })
    .catch(() => null);
  if (!conversation) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(conversation);
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  await prisma.conversation.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
