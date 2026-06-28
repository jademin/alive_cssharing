import { NextRequest, NextResponse } from "next/server";
import { CHANNELS, type ChannelKey } from "@/lib/channels";
import { buildSystemPrompt, hasAgentPipeline, collectGuideFiles, readChannelFile } from "@/lib/channelFiles";
import { resolveGithubToken } from "@/lib/resolveToken";
import { loadAIConfig, type Provider, type ProviderKey } from "@/lib/aiConfig";
import { resolveProvider, resolveActiveProvider } from "@/lib/resolveProvider";

export const maxDuration = 300;

// ─── Claude API ───────────────────────────────────────────────
async function callClaude(
  apiKey: string, model: string, systemPrompt: string, userMessage: string, maxTokens = 4096
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model || "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Claude API 오류 (HTTP ${res.status})`);
  }
  const data = await res.json() as { content?: Array<{ type: string; text: string }> };
  const block = data.content?.[0];
  if (block?.type === "text") return block.text;
  throw new Error("Claude API 응답 형식 오류");
}

// ─── OpenAI API ───────────────────────────────────────────────
async function callOpenAI(
  apiKey: string, model: string, systemPrompt: string, userMessage: string
): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `OpenAI API 오류 (HTTP ${res.status})`);
  }
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  throw new Error("OpenAI API 응답 형식 오류");
}

// ─── Gemini API ───────────────────────────────────────────────
async function callGemini(
  apiKey: string, model: string, systemPrompt: string, userMessage: string, maxOutputTokens = 4096
): Promise<string> {
  const fullModel = model || "gemini-2.5-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${fullModel}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: { maxOutputTokens },
      }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Gemini API 오류 (HTTP ${res.status})`);
  }
  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map(p => p.text ?? "").join("").trim();
  if (text) return text;
  throw new Error("Gemini API 응답 형식 오류");
}

// ─── Gemini + Google Search (리서치 단계 전용) ────────────────
async function callGeminiWithSearch(
  apiKey: string, model: string, systemPrompt: string, userMessage: string
): Promise<string> {
  const fullModel = model || "gemini-2.5-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${fullModel}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: { maxOutputTokens: 4096 },
        tools: [{ google_search: {} }],
      }),
    }
  );
  if (!res.ok) {
    // 검색 도구 오류 시 일반 Gemini로 폴백
    console.warn("[pipeline/research] Gemini Search 실패, 일반 모드로 재시도");
    return callGemini(apiKey, model, systemPrompt, userMessage, 4096);
  }
  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map(p => p.text ?? "").join("").trim();
  if (text) return text;
  // 응답이 비어있으면 폴백
  return callGemini(apiKey, model, systemPrompt, userMessage, 4096);
}

// ─── Mock 생성기 ──────────────────────────────────────────────
function mockGenerate(channel: ChannelKey, topic: string, guideHint = ""): string {
  switch (channel) {
    case "naver-blog":
      return `# ${topic}: 기업이 반드시 알아야 할 핵심 전략 ${guideHint}

## 들어가며

${topic}을 제대로 이해하지 못한 기업들이 연간 수억 원의 손실을 보고 있습니다. CS쉐어링이 500개 이상의 기업을 컨설팅하며 확인한 사실입니다.

## ${topic}의 현주소

많은 기업들이 ${topic}의 중요성은 알지만, 막상 어디서부터 시작해야 할지 모르는 경우가 많습니다.

**핵심은 "무엇을 할 것인가"가 아니라 "어떻게 실행할 것인가"입니다.**

## 핵심 해결 전략 3가지

**첫 번째, 데이터 기반 현황 진단**
현재 상태를 정확히 파악하지 않고 움직이는 것은 지도 없이 길을 나서는 것과 같습니다.

**두 번째, 전문 파트너 선정**
${topic} 분야의 전문가와 함께해야 시행착오를 줄일 수 있습니다.

**세 번째, 단계적 실행과 모니터링**
빠른 실행보다 지속 가능한 프로세스가 더 중요합니다.

## CS쉐어링과 함께 시작하세요

#${topic.replace(/\s/g, "")} #CS쉐어링 #고객서비스 #아웃소싱`;

    case "instagram":
      return `${topic}에 대해 알고 계셨나요? 🤔

사실 많은 분들이 이 부분에서 막막함을 느끼세요.

✅ 포인트 1 — 현황 파악이 먼저입니다
✅ 포인트 2 — 전문가와 함께하면 달라집니다
✅ 포인트 3 — 작은 변화가 큰 차이를 만들어요

CS쉐어링이 함께라면 ${topic}도 걱정 없어요 💪

${topic}에서 가장 어려운 점이 뭔가요? 댓글로 알려주세요! 💬

#CS쉐어링 #고객센터 #고객서비스 #CX #아웃소싱`;

    case "facebook":
      return `${topic}, 여러분 기업에서는 어떻게 접근하고 계신가요?

CS쉐어링이 정리한 핵심 인사이트:

1️⃣ 현황 파악 — 데이터 기반으로 정확히 진단
2️⃣ 전략 수립 — 기업 규모와 상황에 맞게 설계
3️⃣ 실행과 개선 — 지속적인 모니터링으로 성과 확보

여러분 기업에서 ${topic}과 관련해 가장 어려운 점은 무엇인가요? 💬`;

    case "linkedin":
      return `${topic}이 기업 경쟁력의 핵심이 되고 있습니다.

**CS쉐어링 ${topic} 전략 3단계:**

▶ 1단계: 데이터 기반 현황 진단
▶ 2단계: 맞춤형 운영 모델 설계
▶ 3단계: KPI 기반 지속 개선

${topic}에 대해 이야기 나눠보고 싶으시다면 언제든 연락해주세요.

#CustomerExperience #CX #아웃소싱 #CS쉐어링`;

    case "magazine":
      return `# ${topic}: CS쉐어링 인사이트 리포트 ${guideHint}

## Executive Summary

${topic}은 현대 비즈니스 환경에서 기업의 지속 성장을 위한 핵심 요소입니다.

---

## 1. 현황 분석

디지털 전환 가속화와 고객 기대치 상승으로 ${topic}의 중요성이 높아지고 있습니다.

## 2. CS쉐어링 전략 프레임워크

**Phase 1 — 진단**: 현황 정밀 분석
**Phase 2 — 설계**: 맞춤형 운영 모델
**Phase 3 — 최적화**: KPI 기반 지속 개선

---
*CS쉐어링 인사이트 매거진 | contact@cssharing.co.kr*`;
  }
}

// ─── 단순 채널 콘텐츠 생성 (guide 파일만 있는 채널) ───────────
async function generateContent(
  req: NextRequest,
  channel: ChannelKey,
  topic: string,
  draft: string,
  systemPrompt: string,
  providerOverride?: string,
  suggestions?: string[]
): Promise<string> {
  const provider = (providerOverride ?? resolveActiveProvider(req)) as Provider;

  const suggestionContext =
    suggestions && suggestions.length > 0
      ? `\n\n[참고 키워드 및 방향]\n${suggestions.map((s) => `- ${s}`).join("\n")}`
      : "";

  // 채널별 이미지 카드 안내 (이미지가 있는 채널 가이드에 맞게 AI가 직접 HTML 카드 생성)
  const imageCardGuide = `

[이미지 카드]
콘텐츠에 이미지/인포그래픽이 필요한 위치에는 아래 형식의 HTML 카드를 직접 삽입하세요.
(CS쉐어링 B2B 맥락: 콜센터·CS 운영·기업 담당자 소재만 사용, 소비재·생활 이미지 금지)
<figure style="font-family:'맑은 고딕','Malgun Gothic',sans-serif;background:#fff;border:1px solid #e0e8f0;border-radius:10px;padding:24px 28px;margin:20px 0;box-shadow:0 2px 8px rgba(30,144,214,0.07);">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
    <div style="width:3px;height:14px;background:#1e90d6;border-radius:2px;"></div>
    <span style="font-size:12px;color:#aaa;">CS쉐어링</span>
  </div>
  <div style="font-size:22px;font-weight:700;color:#1a1a1a;margin-bottom:4px;">[헤드라인 1행]</div>
  <div style="font-size:22px;font-weight:700;color:#1e90d6;margin-bottom:16px;">[핵심 메시지 2행]</div>
  [내용: 번호 목록 / 비교표 / 소제목 요약 등 — 내용에 맞게 선택]
  <div style="background:#1e90d6;color:#fff;text-align:center;padding:13px;border-radius:7px;font-size:15px;font-weight:700;margin-top:20px;">CS쉐어링 문의 ☎ 1522-5539</div>
  <div style="text-align:right;font-size:11px;color:#ccc;margin-top:10px;letter-spacing:0.5px;">CS Sharing</div>
</figure>`;

  const userMessage = draft
    ? `위에 제공된 가이드 문서를 반드시 참고하여, 아래 작성자 초안을 바탕으로 ${channel} 채널에 맞는 완성된 콘텐츠를 작성해주세요. 가이드의 형식, 어조, 구조를 철저히 준수하세요.

[주제]
${topic}${suggestionContext}

[작성자 초안]
${draft}

위 초안의 핵심 메시지와 방향성을 유지하면서, 채널 가이드에 맞게 완성해주세요.${imageCardGuide}`
    : `위에 제공된 가이드 문서를 반드시 참고하여, 아래 주제로 ${channel} 채널에 맞는 콘텐츠를 작성해주세요. 가이드의 형식과 규칙을 철저히 준수하세요.\n\n[주제]\n${topic}${suggestionContext}${imageCardGuide}`;

  if (provider !== "mock") {
    const pc = resolveProvider(req, provider as ProviderKey)
      ?? await loadAIConfig(resolveGithubToken(req)).then(c => c.providers[provider as ProviderKey]).catch(() => null);

    if (!pc?.apiKey) {
      throw new Error(`${provider} API 키가 설정되지 않았습니다. 설정 페이지에서 API 키를 입력하고 저장해주세요.`);
    }

    if (provider === "claude") return callClaude(pc.apiKey, pc.model, systemPrompt, userMessage);
    if (provider === "openai") return callOpenAI(pc.apiKey, pc.model, systemPrompt, userMessage);
    if (provider === "gemini") return callGemini(pc.apiKey, pc.model, systemPrompt, userMessage);
  }

  return mockGenerate(channel, topic, systemPrompt ? `[가이드 ${Math.round(systemPrompt.length / 100)}백자]` : "");
}

// ─── 코드 블록 제거 헬퍼 ─────────────────────────────────────
// AI가 ```html ... ``` 또는 ~~~html ... ~~~ 로 감싸서 반환하는 경우 제거
function stripCodeFence(text: string): string {
  const s = text.trim();
  const m = s.match(/^(?:```|~~~)[\w-]*\n?([\s\S]*?)\n?(?:```|~~~)\s*$/);
  return m ? m[1].trim() : s;
}

// ─── 네이버 블로그 멀티에이전트 파이프라인 ───────────────────
const WEB_PIPELINE_NOTE = `[웹 파이프라인 환경 — 절대 규칙]
- 파일 저장/읽기/Python 코드 실행 불필요. 결과를 텍스트로 직접 출력한다.
- 이전 단계 결과는 [이전 단계 출력] 섹션으로 제공된다.
- 코드 블록(\`\`\`html, ~~~html 등)으로 감싸지 않는다.

`;

async function runAgentPipeline(
  req: NextRequest,
  channel: ChannelKey,
  topic: string,
  userDraft: string,
  token: string | undefined,
  providerOverride?: string
): Promise<string> {
  const provider = (providerOverride ?? resolveActiveProvider(req)) as Provider;

  // 채널 디렉토리의 모든 파일을 동적으로 로드 (가이드 관리에서 추가/수정된 파일 포함)
  const allFiles = await collectGuideFiles(channel, token);
  const fileContents: Record<string, string> = {};
  await Promise.all(
    allFiles.map(async k => {
      try {
        fileContents[k] = await readChannelFile(channel, k, token);
      } catch {
        console.warn(`[pipeline] ${channel}/${k} 로드 실패`);
      }
    })
  );

  // agents/ 를 제외한 모든 파일을 가이드 컨텍스트로 주입 (guide/ 포함, 루트 업로드 파일 포함)
  const guideKeys = allFiles.filter(k => !k.startsWith("agents/") && fileContents[k]);

  const loadedKeys = Object.keys(fileContents);
  const totalBytes = loadedKeys.reduce((s, k) => s + (fileContents[k]?.length ?? 0), 0);
  console.log(`[pipeline] ${channel}: 전체 ${loadedKeys.length}개 로드 (guide ${guideKeys.length}개, 총 ${totalBytes}바이트)`);
  console.log(`[pipeline] 로드된 파일: ${loadedKeys.join(", ")}`);
  if (guideKeys.length === 0) {
    console.warn(`[pipeline] ${channel}: 가이드 파일이 없습니다. 가이드 관리에서 파일을 추가해주세요.`);
  }

  // Mock 모드
  if (provider === "mock") {
    return mockGenerate(channel, topic, `[파이프라인 모의, 파일 ${Object.keys(fileContents).length}개]`) ?? "";
  }

  // Provider 인증
  const pc = resolveProvider(req, provider as ProviderKey)
    ?? await loadAIConfig(token).then(c => c.providers[provider as ProviderKey]).catch(() => null);
  if (!pc?.apiKey) {
    throw new Error(`${provider} API 키가 설정되지 않았습니다. 설정 페이지에서 API 키를 입력하고 저장해주세요.`);
  }

  // 섹션 조립 헬퍼
  const sec = (key: string) =>
    fileContents[key]
      ? `\n\n${"=".repeat(60)}\n# ${key}\n${"=".repeat(60)}\n\n${fileContents[key]}`
      : "";

  // 단계별 AI 호출 헬퍼
  const step = async (
    system: string,
    user: string,
    maxTokens: number,
    useSearch = false
  ): Promise<string> => {
    if (provider === "gemini") {
      return useSearch
        ? callGeminiWithSearch(pc.apiKey, pc.model, system, user)
        : callGemini(pc.apiKey, pc.model, system, user, maxTokens);
    }
    if (provider === "claude") return callClaude(pc.apiKey, pc.model, system, user, maxTokens);
    if (provider === "openai") return callOpenAI(pc.apiKey, pc.model, system, user);
    return "";
  };

  // ── Step 1: Research ──────────────────────────────────────
  // researcher-web.md가 있으면 우선 사용 (웹 API 최적화 버전)
  // 없으면 researcher.md 폴백 (로컬 Claude Code용이라 제한 있음)
  const researcherInstructions =
    fileContents["agents/researcher-web.md"] ??
    fileContents["agents/researcher.md"] ??
    "당신은 리서처입니다. 주제를 조사하고 research.md 형식으로 출력하세요.";

  const researchSystem =
    WEB_PIPELINE_NOTE +
    researcherInstructions +
    guideKeys.map(k => sec(k)).join("");

  const researchUser =
    `주제: ${topic}` +
    (userDraft ? `\n참고 초안 방향:\n${userDraft}` : "") +
    `\n\nresearch.md 형식으로 조사·분석 결과를 직접 출력하세요.`;

  console.log(`[pipeline] ${channel} Step 1: 리서치 시작`);
  const researchOutput = stripCodeFence(await step(researchSystem, researchUser, 4096, provider === "gemini"));
  console.log(`[pipeline] ${channel} Step 1: 리서치 완료 (${researchOutput.length}자)`);

  // ── Step 2: Write ─────────────────────────────────────────
  // writer-web.md가 있으면 우선 사용 (웹 API 최적화 버전 — 파일 경로 참조 없음)
  // 없으면 writer.md에 "파일 제공 완료" 선언을 앞에 주입해서 폴백
  const writerInstructions = fileContents["agents/writer-web.md"];

  let writeSystem: string;
  if (writerInstructions) {
    // 웹 전용 버전: 깔끔하게 가이드 전문만 뒤에 붙임
    writeSystem =
      WEB_PIPELINE_NOTE +
      writerInstructions +
      guideKeys.map(k => sec(k)).join("");
  } else {
    // 폴백: 로컬용 writer.md에 파일 제공 완료 선언 주입
    const writerFileList = guideKeys
      .map((k, i) => `${i + 1}. ${k} → 아래 === 섹션에 전문 포함됨`)
      .join("\n");
    const writeFileReadyNote =
      `[웹 파이프라인 — 파일 제공 완료. 지금 바로 작성 시작]\n` +
      `writer.md의 '읽을 파일' 목록이 모두 이 시스템 프롬프트 안에 제공되어 있습니다:\n` +
      writerFileList + "\n" +
      `${guideKeys.length + 1}. output/[주제]/research.md → 사용자 메시지의 [이전 단계 출력] 섹션\n\n` +
      `→ 모든 파일 제공 완료. '하나라도 빠지면 작성하지 않는다' 조건 충족됨. 지금 바로 전체 글 작성 시작.\n\n`;
    writeSystem =
      writeFileReadyNote +
      (fileContents["agents/writer.md"] ?? "당신은 블로그 글쓰기 전문가입니다.") +
      guideKeys.map(k => sec(k)).join("");
  }

  const writeUser =
    `[주제]\n${topic}\n\n` +
    `[이전 단계 출력 — research.md]\n${researchOutput}\n\n` +
    `위 리서치 결과와 시스템 프롬프트의 모든 가이드 파일 규칙을 철저히 적용해 블로그 초안을 작성하세요.\n` +
    `(분량·구조·톤·이모지·CTA·해시태그 등 모든 기준은 가이드 파일에 명시되어 있습니다)\n\n` +
    `[출력 형식 — 반드시 준수]\n` +
    `<!-- PUBLISH:START -->\n` +
    `[여기에 발행할 블로그 본문 전체. 제목으로 시작. 소제목은 이모지+단독행.]\n` +
    `<!-- PUBLISH:END -->\n\n` +
    `<!-- NOTES:START -->\n` +
    `[편집 메모, 대체 제목 A/B/C안, 강조 지정 표, 하네스 검증 결과]\n` +
    `<!-- NOTES:END -->`;

  console.log(`[pipeline] ${channel} Step 2: 글쓰기 시작`);
  const draftRaw = stripCodeFence(await step(writeSystem, writeUser, 8000));
  console.log(`[pipeline] ${channel} Step 2: 글쓰기 완료 (${draftRaw.length}자)`);

  if (!draftRaw.trim()) throw new Error("[pipeline] 글쓰기 단계 결과가 비어 있습니다.");

  // PUBLISH 마커가 없으면 전체를 PUBLISH 블록으로 감싸서 다음 단계로 전달
  const draftOutput = draftRaw.includes("<!-- PUBLISH:START -->")
    ? draftRaw
    : `<!-- PUBLISH:START -->\n${draftRaw}\n<!-- PUBLISH:END -->`;

  // ── Step 2.5: Image Making ────────────────────────────────
  const imageMarkers = [...draftOutput.matchAll(/\[IMAGE:\s*([^\]]+)\]/g)];
  let finalDraft = draftOutput;

  // image-maker-web.md 우선, 없으면 image-maker.md 폴백
  const imageMakerInstructions =
    fileContents["agents/image-maker-web.md"] ??
    fileContents["agents/image-maker.md"];

  if (imageMarkers.length > 0 && imageMakerInstructions) {
    const imageMakerSystem =
      WEB_PIPELINE_NOTE +
      imageMakerInstructions +
      sec("guide/04-image-guide.md") +
      sec("guide/06-brand-cta-reference.md") +
      sec("guide/01-writing-guide.md");

    const imageMakerUser =
      `[주제]\n${topic}\n\n` +
      `아래 draft.md에서 [IMAGE: ...] 마커(${imageMarkers.length}개)를 브랜드 카드 HTML+CSS로 교체하세요.\n` +
      `- 첫 번째/썸네일: 720×720px, 배경 #18A0E8, 제목·부제 흰색\n` +
      `- 소제목 요약 카드: 800px 브랜드 카드\n` +
      `- 모든 카드 하단: 파란 CTA + CS Sharing 워터마크\n` +
      `- PUBLISH/NOTES 마커와 나머지 텍스트는 그대로 유지\n` +
      `- 수정된 전체 draft.md를 출력하세요 (코드 블록 금지)\n\n` +
      `[draft.md]\n${draftOutput}`;

    console.log(`[pipeline] ${channel} Step 2.5: 이미지 제작 시작`);
    const draftWithImages = stripCodeFence(await step(imageMakerSystem, imageMakerUser, 8000));
    if (draftWithImages.trim()) {
      finalDraft = draftWithImages;
      console.log(`[pipeline] ${channel} Step 2.5: 이미지 제작 완료 (${finalDraft.length}자)`);
    } else {
      console.warn(`[pipeline] ${channel} Step 2.5: 결과 없음, 이전 draft 사용`);
    }
  }

  // ── Step 3: Assemble → 완성된 standalone HTML 생성 ────────
  // assembler-web.md 우선, 없으면 웹 전용 하드코딩 지침 사용
  const assemblerInstructions = fileContents["agents/assembler-web.md"];

  const assembleSystemBase = assemblerInstructions
    ? WEB_PIPELINE_NOTE + assemblerInstructions
    : WEB_PIPELINE_NOTE +
      `당신은 HTML 생성 전문가입니다. 블로그 초안을 완성된 standalone HTML로 변환합니다.\n\n` +
      `[출력 규칙 — 절대 준수]\n` +
      `1. <!DOCTYPE html>로 시작하는 완전한 HTML 문서를 출력한다\n` +
      `2. \`\`\`html, ~~~html 등 코드 블록으로 절대 감싸지 않는다 — <!DOCTYPE html>부터 바로 시작\n` +
      `3. <!-- PUBLISH:START -->~<!-- PUBLISH:END --> 사이 내용만 HTML로 변환 (NOTES 블록 제외)\n` +
      `4. PUBLISH 마커가 없으면 전체 내용을 본문으로 처리\n` +
      `5. 이미 삽입된 HTML 카드(<figure>, <div> 등)는 그대로 유지\n` +
      `6. 남은 [IMAGE: ...] 마커는 아래 placeholder로 처리:\n` +
      `   <div style="background:#f0f4ff;border:1.5px dashed #2c4a7c;border-radius:10px;padding:28px;text-align:center;margin:24px 0;"><span style="color:#2c4a7c;font-size:14px;">📷 이미지 자리</span></div>\n\n` +
      `[HTML 스타일 규칙]\n` +
      `body: { background:#f9f9f9; font-family:'Malgun Gothic','맑은 고딕',sans-serif; color:#333; line-height:1.8; }\n` +
      `.container: { max-width:700px; margin:40px auto; background:#fff; padding:40px; border-radius:8px; box-shadow:0 4px 8px rgba(0,0,0,0.05); }\n` +
      `h1: { font-size:28px; font-weight:bold; border-bottom:1px solid #eee; padding-bottom:16px; margin-bottom:24px; }\n` +
      `h2(소제목): { font-size:20px; font-weight:bold; border-left:5px solid #2c4a7c; padding-left:14px; color:#111; margin:32px 0 12px; }\n` +
      `p: { text-align:center; margin:12px 0; }\n` +
      `강조 마커: {{hl:텍스트}}→<mark>텍스트</mark> / {{center:텍스트}}→<span style="display:block;text-align:center">텍스트</span>\n` +
      `[RICH:PHONE]→전화번호 클릭 배너(tel:1522-5539) / [RICH:LINK:설명]→링크 카드\n` +
      `#태그→<span style="background:#e8f0fe;color:#2c4a7c;padding:2px 8px;border-radius:12px;font-size:13px;">#태그</span>`;

  const assembleSystem = assembleSystemBase + sec("guide/01-writing-guide.md");

  const assembleUser =
    `[주제]\n${topic}\n\n` +
    `[초안 (이미지 카드 포함)]\n${finalDraft}\n\n` +
    `위 초안의 PUBLISH 블록을 완성된 standalone HTML로 변환하세요.\n` +
    `반드시 <!DOCTYPE html>로 시작하는 순수 HTML을 출력하세요. 코드 블록(\`\`\`html) 금지.`;

  console.log(`[pipeline] ${channel} Step 3: 조립 시작`);
  const finalHtmlRaw = await step(assembleSystem, assembleUser, 8000);
  const finalHtml = stripCodeFence(finalHtmlRaw);
  console.log(`[pipeline] ${channel} Step 3: 조립 완료 (${finalHtml.length}자)`);

  // 유효한 HTML이 아니면 draft 그대로 반환
  if (!finalHtml.trim() || !finalHtml.includes("<")) return draftOutput;
  return finalHtml;
}

// ─── 파이프라인 단계별 실행 (Vercel Hobby 10초 타임아웃 우회) ──
// 클라이언트가 단계마다 별도 요청 → 각 단계가 독립적인 10초 타임아웃
async function runAgentPipelineStep(
  req: NextRequest,
  channel: ChannelKey,
  topic: string,
  userDraft: string,
  token: string | undefined,
  pipelineStep: "research" | "write" | "assemble",
  pipelineContext: string | undefined,
  providerOverride?: string
): Promise<string> {
  const provider = (providerOverride ?? resolveActiveProvider(req)) as Provider;

  if (provider === "mock") {
    await new Promise(r => setTimeout(r, 1200)); // 실제 AI 호출 시간 시뮬레이션
    if (pipelineStep === "research") return `# ${topic} 리서치\n> 리서치 기준일: 2026-06-28 / 참고 소스: 6개\n\n## 0. 자사 서비스 연결점\n- 착지 서비스: CS 아웃소싱 서비스 (전문 상담원 파견형)\n- 선정 이유: 비용 절감을 원하는 중소기업이 직접적인 전환 대상이며, 초기 도입 문턱 낮추는 서비스와 직결\n\n## 0-1. SEO 키워드 메모\n- 핵심 키워드: CS 아웃소싱 비용\n- 롱테일 키워드: 중소기업 고객센터 아웃소싱 비용, CS 외주 업체 비교, 인하우스 vs 아웃소싱 차이\n- 검색 의도: 비교 / 도입 결정 단계\n\n## 1. 인하우스 vs 아웃소싱 비용 비교\n인하우스 CS 팀 운영 시 상담원 1인당 연 3,800만~4,500만 원(급여+4대 보험+교육비) 소요. 아웃소싱 전환 시 동일 규모 기준 평균 30~45% 절감 가능(한국아웃소싱산업협회, 2024).\n\n## 2. 숨은 비용 항목\n- 채용·이직 비용: 상담원 1인 이직 시 대체 비용 약 800만 원(채용·교육 합산)\n- 피크 대응 버퍼 인력: 평시 대비 30% 초과 인력 상시 유지 필요\n- IT 인프라·QA 시스템 구축비 별도\n\n## 3. 도입 기업 사례\n- 이커머스 A사(직원 50명): CS 아웃소싱 전환 후 6개월 내 운영비 38% 절감, CSAT 82→91점 상승\n- SaaS B사: 심야·주말 커버리지 확보하며 CS 팀 규모 40% 축소\n\n## 참고 소스\n- [한국아웃소싱산업협회 2024 보고서](출처 미확인) — 2024-03\n- [고용노동부 임금실태조사](출처 미확인) — 2024-01`;

    if (pipelineStep === "write") return `<!-- PUBLISH:START -->\n${topic}: 인하우스 운영보다 40% 싸게 만드는 전략\n\n고객센터 운영비가 매달 부담되시나요? 상담원 한 명을 유지하는 데 연간 4,000만 원이 넘는다는 사실, 알고 계셨나요?\n\n📑 이 글의 순서\n1. 인하우스 CS의 숨은 비용 4가지\n2. 아웃소싱 전환 시 실제 절감 규모\n3. 도입 전 꼭 확인할 체크리스트\n4. CS쉐어링이 선택받는 이유\n\n[IMAGE: 인하우스 vs 아웃소싱 비용 비교 인포그래픽]\n\n🔍 상담원 1명의 진짜 비용, 계산해보셨나요?\n\n급여만 보면 월 250만 원처럼 보이지만 실제로는 다릅니다. 4대보험 사업자 부담분, 연차수당, 교육비, 이직 시 재채용 비용까지 합산하면 1인당 연 3,800만~4,500만 원이 소요됩니다.\n\n{{hl:여기에 피크 시간 버퍼 인력 30%를 더하면 실제 비용은 계산보다 훨씬 커집니다.}}\n\n[IMAGE: 상담원 실제 연간 비용 항목 분해 차트]\n\n🔍 아웃소싱 전환으로 38% 절감한 사례\n\n이커머스 A사는 50인 규모로 자체 CS팀을 운영하다가 CS쉐어링으로 전환했습니다. 6개월 후 운영비가 38% 줄었고, 고객 만족도(CSAT)는 82점에서 91점으로 올랐습니다.\n\n비결은 단순 비용 이전이 아닙니다. 전문 상담 인력의 즉시 투입과 QA 시스템을 함께 받았기 때문입니다.\n\n[IMAGE: A사 도입 전후 CSAT 변화 그래프]\n\n🔍 도입 전 확인할 3가지\n\n{{hl:계약 구조, 품질 보증(QA) 방식, 업무 인수인계 기간을 반드시 확인하세요.}} 이 3가지를 놓치면 단기 절감이 장기 리스크가 됩니다.\n\n[IMAGE: CS 아웃소싱 도입 체크리스트 카드]\n\n비용을 줄이면서 품질도 높이고 싶다면?\n\n[RICH:LINK:CS쉐어링 무료 상담 신청하기]\n\n#CS아웃소싱 #고객센터비용절감 #중소기업CS #아웃소싱비교 #CS쉐어링\n<!-- PUBLISH:END -->\n\n<!-- NOTES:START -->\n## 대체 제목\nA안: CS 아웃소싱으로 비용 절감하는 방법: 인하우스 대비 40% 아끼는 전략 (31자)\nB안: 고객센터 아웃소싱 비용, 직접 계산해봤습니다 (24자)\nC안: 상담원 1명에 연 4,000만 원? CS 아웃소싱으로 절반 줄이는 법 (33자)\n\n## 하네스 검증 결과\n- Step 0: PASS\n- 종합 점수: 83점 (B등급)\n- 수치 인용: PASS (38%, 4,500만원, CSAT 82→91)\n- 분량: 약 1,800자 (Mock — 실제 AI는 2,800자 이상)\n<!-- NOTES:END -->`;

    return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>${topic}</title><style>body{background:#f9f9f9;font-family:'Malgun Gothic',sans-serif;color:#333;line-height:1.8;}. container{max-width:700px;margin:40px auto;background:#fff;padding:40px;border-radius:8px;box-shadow:0 4px 8px rgba(0,0,0,.05);}h1{font-size:28px;font-weight:bold;border-bottom:1px solid #eee;padding-bottom:16px;margin-bottom:24px;}h2{font-size:18px;font-weight:bold;border-left:5px solid #2c4a7c;padding-left:14px;color:#111;margin:32px 0 12px;}.img-placeholder{background:#f0f4ff;border:1.5px dashed #2c4a7c;border-radius:10px;padding:28px;text-align:center;margin:24px 0;color:#2c4a7c;font-size:14px;}</style></head><body><div class="container"><h1>${topic}: 인하우스 운영보다 40% 싸게 만드는 전략</h1><p><strong>고객센터 운영비가 매달 부담되시나요?</strong> 상담원 한 명을 유지하는 데 연간 4,000만 원이 넘는다는 사실, 알고 계셨나요?</p><div class="img-placeholder">📷 이미지 자리 — 인하우스 vs 아웃소싱 비용 비교</div><h2>상담원 1명의 진짜 비용, 계산해보셨나요?</h2><p>급여만 보면 월 250만 원처럼 보이지만 실제로는 다릅니다. 4대보험·연차수당·교육비·재채용 비용까지 합산하면 <strong>1인당 연 3,800만~4,500만 원</strong>이 소요됩니다.</p><div class="img-placeholder">📷 이미지 자리 — 비용 항목 분해 차트</div><h2>아웃소싱 전환으로 38% 절감한 사례</h2><p>이커머스 A사는 50인 규모 자체 CS팀을 CS쉐어링으로 전환 후 6개월 만에 운영비 38% 절감, CSAT 82 → 91점 상승을 달성했습니다.</p><p style="background:#f0f4ff;padding:16px;border-radius:8px;margin:16px 0;">비용을 줄이면서 품질도 높이고 싶다면? → <a href="#" style="color:#2c4a7c;font-weight:bold;">CS쉐어링 무료 상담 신청</a></p><p style="color:#888;font-size:13px;">#CS아웃소싱 #고객센터비용절감 #중소기업CS</p></div></body></html>`;
  }

  const pc = resolveProvider(req, provider as ProviderKey)
    ?? await loadAIConfig(token).then(c => c.providers[provider as ProviderKey]).catch(() => null);
  if (!pc?.apiKey) throw new Error(`${provider} API 키가 설정되지 않았습니다.`);

  const allFiles = await collectGuideFiles(channel, token);
  const fileContents: Record<string, string> = {};
  await Promise.all(allFiles.map(async k => {
    try { fileContents[k] = await readChannelFile(channel, k, token); }
    catch { console.warn(`[step:${pipelineStep}] ${channel}/${k} 로드 실패`); }
  }));

  const guideKeys = allFiles.filter(k => !k.startsWith("agents/") && fileContents[k]);
  const sec = (key: string) => fileContents[key]
    ? `\n\n${"=".repeat(60)}\n# ${key}\n${"=".repeat(60)}\n\n${fileContents[key]}`
    : "";

  const call = async (system: string, user: string, maxTokens: number, useSearch = false): Promise<string> => {
    if (provider === "gemini") return useSearch
      ? callGeminiWithSearch(pc.apiKey, pc.model, system, user)
      : callGemini(pc.apiKey, pc.model, system, user, maxTokens);
    if (provider === "claude") return callClaude(pc.apiKey, pc.model, system, user, maxTokens);
    if (provider === "openai") return callOpenAI(pc.apiKey, pc.model, system, user);
    return "";
  };

  if (pipelineStep === "research") {
    const instructions =
      fileContents["agents/researcher-web.md"] ??
      fileContents["agents/researcher.md"] ??
      "당신은 리서처입니다. 주제를 조사하고 research.md 형식으로 출력하세요.";
    const system = WEB_PIPELINE_NOTE + instructions + guideKeys.map(k => sec(k)).join("");
    const user =
      `주제: ${topic}` +
      (userDraft ? `\n참고 초안 방향:\n${userDraft}` : "") +
      `\n\nresearch.md 형식으로 조사·분석 결과를 직접 출력하세요.`;
    console.log(`[step:research] ${channel} 시작`);
    return stripCodeFence(await call(system, user, 2048, provider === "gemini"));
  }

  if (pipelineStep === "write") {
    const researchOutput = pipelineContext ?? "";
    const writerInstructions = fileContents["agents/writer-web.md"];
    let writeSystem: string;
    if (writerInstructions) {
      writeSystem = WEB_PIPELINE_NOTE + writerInstructions + guideKeys.map(k => sec(k)).join("");
    } else {
      const writerFileList = guideKeys.map((k, i) => `${i + 1}. ${k} → 아래 === 섹션에 전문 포함됨`).join("\n");
      writeSystem =
        `[웹 파이프라인 — 파일 제공 완료. 지금 바로 작성 시작]\n` +
        writerFileList + `\n\n` +
        (fileContents["agents/writer.md"] ?? "당신은 블로그 글쓰기 전문가입니다.") +
        guideKeys.map(k => sec(k)).join("");
    }
    const writeUser =
      `[주제]\n${topic}\n\n` +
      `[리서치 결과]\n${researchOutput}\n\n` +
      `가이드 파일 규칙을 철저히 적용해 블로그 초안을 작성하세요.\n\n` +
      `[출력 형식 — 반드시 준수]\n` +
      `<!-- PUBLISH:START -->\n[블로그 본문 전체]\n<!-- PUBLISH:END -->\n\n` +
      `<!-- NOTES:START -->\n[편집 메모]\n<!-- NOTES:END -->`;

    console.log(`[step:write] ${channel} 시작`);
    const draftRaw = stripCodeFence(await call(writeSystem, writeUser, 3000));
    if (!draftRaw.trim()) throw new Error("[pipeline:write] 글쓰기 결과가 비어 있습니다.");

    // 4개 마커 모두 보장 — Assembler가 전부 요구하므로 누락 시 자동 보완
    let draftOutput = draftRaw.includes("<!-- PUBLISH:START -->")
      ? draftRaw
      : `<!-- PUBLISH:START -->\n${draftRaw}\n<!-- PUBLISH:END -->`;
    if (!draftOutput.includes("<!-- PUBLISH:END -->")) draftOutput += "\n<!-- PUBLISH:END -->";
    if (!draftOutput.includes("<!-- NOTES:START -->")) draftOutput += "\n<!-- NOTES:START -->\n편집 메모\n<!-- NOTES:END -->";
    if (!draftOutput.includes("<!-- NOTES:END -->"))   draftOutput += "\n<!-- NOTES:END -->";
    return draftOutput;
  }

  if (pipelineStep === "assemble") {
    const finalDraft = pipelineContext ?? "";
    const assemblerInstructions = fileContents["agents/assembler-web.md"];
    const assembleSystemBase = assemblerInstructions
      ? WEB_PIPELINE_NOTE + assemblerInstructions
      : WEB_PIPELINE_NOTE +
        `당신은 HTML 생성 전문가입니다. 블로그 초안을 완성된 standalone HTML로 변환합니다.\n\n` +
        `[출력 규칙]\n` +
        `1. <!DOCTYPE html>로 시작하는 완전한 HTML 문서를 출력한다\n` +
        `2. 코드 블록(\`\`\`html 등)으로 감싸지 않는다\n` +
        `3. <!-- PUBLISH:START -->~<!-- PUBLISH:END --> 사이 내용만 변환 (NOTES 제외)\n` +
        `4. PUBLISH 마커 없으면 전체를 본문으로 처리\n` +
        `5. 기존 HTML 카드(<figure>, <div>)는 그대로 유지\n` +
        `6. [IMAGE: ...] 마커 → <div style="background:#f0f4ff;border:1.5px dashed #2c4a7c;border-radius:10px;padding:28px;text-align:center;margin:24px 0;"><span style="color:#2c4a7c;font-size:14px;">📷 이미지 자리</span></div>\n\n` +
        `[스타일] body:{background:#f9f9f9;font-family:'Malgun Gothic',sans-serif;color:#333;line-height:1.8;} ` +
        `.container:{max-width:700px;margin:40px auto;background:#fff;padding:40px;border-radius:8px;box-shadow:0 4px 8px rgba(0,0,0,0.05);} ` +
        `h1:{font-size:28px;font-weight:bold;border-bottom:1px solid #eee;padding-bottom:16px;margin-bottom:24px;} ` +
        `h2:{font-size:20px;font-weight:bold;border-left:5px solid #2c4a7c;padding-left:14px;color:#111;margin:32px 0 12px;}`;

    const assembleSystem = assembleSystemBase + sec("guide/01-writing-guide.md");
    const assembleUser =
      `[주제]\n${topic}\n\n[초안]\n${finalDraft}\n\n` +
      `[중요] 마커 완성도 게이트를 건너뛰고 즉시 HTML 변환을 시작하세요. ` +
      `PUBLISH 블록을 완성된 standalone HTML로 변환하세요. 반드시 <!DOCTYPE html>로 시작하는 순수 HTML을 출력하세요. 코드 블록 금지. 오류 메시지 출력 금지.`;

    console.log(`[step:assemble] ${channel} 시작`);
    const finalHtmlRaw = await call(assembleSystem, assembleUser, 3000);
    const finalHtml = stripCodeFence(finalHtmlRaw);
    if (!finalHtml.trim() || !finalHtml.includes("<")) return finalDraft;
    return finalHtml;
  }

  throw new Error(`알 수 없는 파이프라인 단계: ${pipelineStep}`);
}

// ─── POST /api/generate ───────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const {
      topic,
      draft = "",
      channels: requestedChannels,
      provider: providerOverride,
      suggestions,
      pipelineStep,
      pipelineContext,
    } = (await req.json()) as {
      topic: string;
      draft?: string;
      channels?: string[];
      provider?: string;
      suggestions?: string[];
      pipelineStep?: "research" | "write" | "assemble";
      pipelineContext?: string;
    };

    if (!topic?.trim()) {
      return NextResponse.json({ error: "주제를 입력해주세요." }, { status: 400 });
    }

    const targetChannels: ChannelKey[] = Array.isArray(requestedChannels)
      ? requestedChannels.filter((c): c is ChannelKey => CHANNELS.includes(c as ChannelKey))
      : [...CHANNELS];

    if (targetChannels.length === 0) {
      return NextResponse.json({ error: "채널을 하나 이상 선택해주세요." }, { status: 400 });
    }

    const token = resolveGithubToken(req);

    // 단계별 파이프라인 모드 (Vercel Hobby 타임아웃 우회 — 클라이언트가 단계마다 별도 호출)
    if (pipelineStep) {
      const channel = targetChannels[0];
      if (!channel) return NextResponse.json({ error: "채널을 지정해주세요." }, { status: 400 });
      const output = await runAgentPipelineStep(
        req, channel, topic.trim(), draft, token, pipelineStep, pipelineContext, providerOverride
      );
      return NextResponse.json({ step: pipelineStep, output });
    }

    const results = await Promise.all(
      targetChannels.map(async (channel) => {
        // 멀티에이전트 파이프라인 여부 확인 (agents/researcher.md 존재 시)
        const isPipeline = await hasAgentPipeline(channel, token);

        if (isPipeline) {
          // blog/폴더와 동일한 researcher → writer → assembler 파이프라인
          const content = await runAgentPipeline(
            req, channel, topic.trim(), draft, token, providerOverride
          );
          return { channel, content, pipeline: true };
        }

        // 단순 가이드 기반 생성 (guide.md만 있는 채널)
        const systemPrompt = await buildSystemPrompt(channel, token);
        if (!systemPrompt) {
          console.warn(`[generate] ${channel}: 가이드를 로드하지 못했습니다.`);
        }
        const content = await generateContent(
          req, channel, topic.trim(), draft, systemPrompt, providerOverride, suggestions
        );
        return { channel, content, pipeline: false };
      })
    );

    return NextResponse.json({ topic: topic.trim(), results });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "콘텐츠 생성에 실패했습니다.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
