import { NextResponse } from "next/server";

export async function GET() {
  const isVercel = process.env.VERCEL === "1";
  if (!isVercel) return NextResponse.json({ ok: true, env: "local" });

  const hasToken = !!process.env.GITHUB_TOKEN;
  return NextResponse.json({ ok: hasToken, env: "vercel" });
}
