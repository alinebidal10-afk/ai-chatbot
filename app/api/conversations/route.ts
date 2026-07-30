import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { DEFAULT_MODEL_ID } from "@/lib/providers";

export const runtime = "nodejs";

export async function GET() {
  const conversations = await prisma.conversation.findMany({
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, modelId: true, updatedAt: true },
  });
  return NextResponse.json(conversations);
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const conversation = await prisma.conversation.create({
    data: { modelId: body.modelId ?? DEFAULT_MODEL_ID },
  });
  return NextResponse.json(conversation);
}
