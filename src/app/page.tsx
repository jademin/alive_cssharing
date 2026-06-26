"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import {
  Wand2,
  Sparkles,
  BookOpen,
  AlertCircle,
  ChevronRight,
  Loader2,
  RefreshCw,
  ArrowLeft,
  LayoutList,
  Lightbulb,
  X,
} from "lucide-react";
import ChannelResultCard, { type ChannelKey } from "@/components/ChannelResultCard";
import { CHANNELS, CHANNEL_LABELS, CHANNEL_COLORS } from "@/lib/channels";
import Navbar from "@/components/Navbar";
import Link from "next/link";

// ── AI 제공사 정보 ────────────────────────────────────────────
type AIProvider = "mock" | "claude" | "openai" | "gemini";

const AI_PROVIDERS: {
  id: AIProvider;
  label: string;
  activeClass: string;
}[] = [
  { id: "claude",  label: "Claude",  activeClass: "bg-orange-50 border-orange-300 text-orange-700" },
  { id: "openai",  label: "OpenAI",  activeClass: "bg-emerald-50 border-emerald-300 text-emerald-700" },
  { id: "gemini",  label: "Gemini",  activeClass: "bg-blue-50 border-blue-300 text-blue-700" },
  { id: "mock",    label: "Mock",    activeClass: "bg-slate-100 border-slate-300 text-slate-700" },
];

// ── 타입 ────────────────────────────────────────────────────
type Phase = "input" | "suggest" | "channels";
type ChannelStatus = "idle" | "loading" | "done" | "error";
interface ChannelResult { status: ChannelStatus; content?: string; }

// ── 예시 주제 ────────────────────────────────────────────────
const EXAMPLE_TOPICS = [
  "CS 아웃소싱으로 비용 절감하는 방법",
  "AI 고객센터 도입 효과",
  "고객 만족도를 높이는 VOC 분석",
  "스타트업 고객센터 구축 전략",
  "24시간 고객 대응 운영 노하우",
];

// ── 메인 페이지 ─────────────────────────────────────────────
export default function HomePage() {
  const [phase, setPhase] = useState<Phase>("input");
  const [topic, setTopic] = useState("");

  // AI 선택
  const [selectedProvider, setSelectedProvider] = useState<AIProvider>("mock");
  const [availableProviders, setAvailableProviders] = useState<AIProvider[]>(["mock"]);

  // 추천 단계
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedSuggestions, setSelectedSuggestions] = useState<string[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  // 채널 생성 단계
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<ChannelKey, ChannelResult>>(
    Object.fromEntries(CHANNELS.map(c => [c, { status: "idle" }])) as Record<ChannelKey, ChannelResult>
  );
  const [resultChannels, setResultChannels] = useState<ChannelKey[]>([]);

  const resultsRef = useRef<HTMLDivElement>(null);

  // 사용 가능한 AI 제공사 목록 로드
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/settings");
        const data = await res.json() as {
          activeProvider: AIProvider;
          providers: Record<string, { apiKeySet: boolean }>;
        };
        const available: AIProvider[] = [];
        for (const p of ["claude", "openai", "gemini"] as const) {
          if (data.providers[p]?.apiKeySet) available.push(p);
        }
        available.push("mock");
        setAvailableProviders(available);

        const lsProvider = localStorage.getItem("csai_provider") as AIProvider | null;
        const configProvider = data.activeProvider as AIProvider | undefined;
        const firstReal = available.find(p => p !== "mock");
        const defaultProvider =
          (lsProvider && available.includes(lsProvider)) ? lsProvider :
          (configProvider && configProvider !== "mock" && available.includes(configProvider)) ? configProvider :
          firstReal ?? "mock";
        setSelectedProvider(defaultProvider);
      } catch {
        setAvailableProviders(["mock"]);
        setSelectedProvider("mock");
      }
    })();
  }, []);

  const toggleSuggestion = (s: string) => {
    setSelectedSuggestions(prev =>
      prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]
    );
  };

  // ── Step 1: 추천 받기 ─────────────────────────────────────
  const handleGetSuggestions = async () => {
    if (!topic.trim() || suggestLoading) return;
    setSuggestLoading(true);
    setSuggestError(null);
    setSelectedSuggestions([]);
    try {
      const res = await fetch("/api/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: topic.trim(), provider: selectedProvider }),
      });
      const data = await res.json() as { suggestions?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "추천 생성 실패");
      setSuggestions(data.suggestions ?? []);
      setPhase("suggest");
    } catch (e) {
      setSuggestError(e instanceof Error ? e.message : "추천 생성에 실패했습니다.");
    } finally {
      setSuggestLoading(false);
    }
  };

  // ── Step 2: 채널 콘텐츠 생성 ────────────────────────────────
  const handleGenerate = useCallback(async () => {
    if (generating) return;

    setGenerating(true);
    setGenError(null);
    setResultChannels([...CHANNELS]);
    setResults(
      Object.fromEntries(CHANNELS.map(c => [c, { status: "loading" }])) as Record<ChannelKey, ChannelResult>
    );
    setPhase("channels");
    setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);

    const channelsMap: Record<string, string> = {};
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic.trim(),
          channels: [...CHANNELS],
          suggestions: selectedSuggestions,
          provider: selectedProvider,
        }),
      });
      const data = await res.json() as { results?: Array<{ channel: string; content: string }>; error?: string };
      if (!res.ok) throw new Error(data.error ?? "생성 실패");

      for (const { channel, content } of data.results ?? []) {
        setResults(prev => ({ ...prev, [channel as ChannelKey]: { status: "done", content } }));
        channelsMap[channel] = content;
      }

      void fetch("/api/results", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: topic.trim(), channels: channelsMap }),
      });
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "알 수 없는 오류");
      setResults(prev => {
        const next = { ...prev };
        for (const ch of CHANNELS) {
          if (next[ch].status === "loading") next[ch] = { status: "error" };
        }
        return next;
      });
    } finally {
      setGenerating(false);
    }
  }, [generating, topic, selectedSuggestions, selectedProvider]);

  const allDone = resultChannels.length > 0 && resultChannels.every(c => results[c].status === "done");

  const resetAll = () => {
    setPhase("input");
    setSuggestions([]);
    setSelectedSuggestions([]);
    setSuggestError(null);
    setGenError(null);
    setResultChannels([]);
  };

  const backToSuggest = () => {
    setPhase("suggest");
    setGenError(null);
  };

  return (
    <div className="gradient-bg min-h-screen">
      <Navbar />

      <main className="pt-28 pb-20 px-4">
        <div className="max-w-5xl mx-auto">

          {/* ─── Hero ─────────────────────────────────────── */}
          <div className="text-center mb-10">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-50 border border-blue-100 text-blue-700 text-xs font-semibold mb-4 uppercase tracking-wide">
              <Sparkles className="w-3.5 h-3.5" />CS쉐어링 AI 마케팅 자동화
            </div>
            <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold text-slate-900 leading-tight tracking-tight mb-3">
              주제 하나로
              <span className="text-blue-600"> 5개 채널</span> 동시 생성
            </h1>
            <p className="text-slate-500 text-base sm:text-lg max-w-lg mx-auto">
              네이버 블로그 · 인스타그램 · 페이스북 · 링크드인 · 매거진<br />
              키워드를 선택하면 AI가 각 채널 가이드에 맞춰 완성합니다.
            </p>
          </div>

          {/* ─── Step 인디케이터 ───────────────────────────── */}
          {phase !== "input" && (
            <div className="flex items-center justify-center gap-2 mb-8 text-sm">
              <div className="flex items-center gap-1.5 px-3 py-1 rounded-full font-medium bg-blue-100 text-blue-700">
                <span className="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px] font-bold">1</span>
                주제 입력
              </div>
              <ChevronRight className="w-4 h-4 text-slate-400" />
              <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full font-medium ${phase === "suggest" ? "bg-blue-600 text-white" : phase === "channels" ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-400"}`}>
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${phase === "suggest" ? "bg-white text-blue-600" : phase === "channels" ? "bg-blue-600 text-white" : "bg-slate-300 text-white"}`}>2</span>
                키워드 선택
              </div>
              <ChevronRight className="w-4 h-4 text-slate-400" />
              <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full font-medium ${phase === "channels" ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-400"}`}>
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${phase === "channels" ? "bg-white text-blue-600" : "bg-slate-300 text-white"}`}>3</span>
                채널 생성
              </div>
            </div>
          )}

          {/* ─── Phase 1: 주제 입력 ───────────────────────── */}
          {(phase === "input" || phase === "suggest") && (
            <div className="glass-card rounded-3xl p-6 sm:p-8 mb-8 max-w-2xl mx-auto">

              {/* AI 선택 바 */}
              <div className="mb-5">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">AI 제공사</p>
                  {phase === "suggest" && (
                    <span className="text-[10px] text-slate-400">변경하려면 주제를 다시 입력하세요</span>
                  )}
                </div>
                {availableProviders.length <= 1 ? (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-xs">
                    <span>AI API 키가 설정되지 않았습니다.</span>
                    <a href="/settings" className="font-semibold underline hover:text-amber-900">설정 페이지에서 연결하기 →</a>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {AI_PROVIDERS.filter(p => availableProviders.includes(p.id)).map(p => {
                      const isActive = selectedProvider === p.id;
                      return (
                        <button
                          key={p.id}
                          onClick={() => { setSelectedProvider(p.id); localStorage.setItem("csai_provider", p.id); }}
                          disabled={phase === "suggest"}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all cursor-pointer disabled:opacity-50 disabled:cursor-default ${
                            isActive ? p.activeClass : "bg-white border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700"
                          }`}
                        >
                          {isActive && <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />}
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                주제 또는 핵심 문구 입력
              </label>
              <textarea
                value={topic}
                onChange={e => setTopic(e.target.value)}
                placeholder="예: CS 아웃소싱으로 비용 절감하는 방법"
                rows={3}
                disabled={suggestLoading || phase === "suggest"}
                className="w-full px-4 py-3 rounded-xl border border-slate-200 bg-white text-slate-900 text-base placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none transition-all disabled:opacity-60"
                onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && phase === "input") void handleGetSuggestions(); }}
              />
              <p className="text-xs text-slate-400 mt-1.5 mb-4">Ctrl + Enter로 바로 키워드 추천 받기</p>

              <div className="flex flex-wrap gap-2 mb-5">
                {EXAMPLE_TOPICS.map(ex => (
                  <button key={ex} onClick={() => { setTopic(ex); setPhase("input"); }}
                    className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 text-xs hover:bg-blue-50 hover:text-blue-700 transition-colors cursor-pointer">
                    {ex}
                  </button>
                ))}
              </div>

              {suggestError && (
                <div className="mb-4 flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3">
                  <AlertCircle className="w-4 h-4 shrink-0" />{suggestError}
                </div>
              )}

              {phase === "input" ? (
                <button
                  onClick={() => void handleGetSuggestions()}
                  disabled={!topic.trim() || suggestLoading}
                  className="btn-cta w-full flex items-center justify-center gap-2 py-4 rounded-xl text-base font-semibold"
                >
                  {suggestLoading
                    ? <><Loader2 className="w-5 h-5 animate-spin" />키워드 추천 중...</>
                    : <><Lightbulb className="w-5 h-5" />AI 키워드 추천 받기</>}
                </button>
              ) : (
                <button
                  onClick={() => { setPhase("input"); setSuggestions([]); setSelectedSuggestions([]); }}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-slate-200 text-slate-600 text-sm font-medium hover:bg-slate-50 cursor-pointer"
                >
                  <RefreshCw className="w-4 h-4" />주제 다시 입력하기
                </button>
              )}
            </div>
          )}

          {/* ─── Phase 2: 키워드/주제 추천 ──────────────────── */}
          {phase === "suggest" && suggestions.length > 0 && (
            <div className="max-w-2xl mx-auto mb-8">
              <div className="glass-card rounded-3xl p-6 sm:p-8">
                <div className="flex items-center gap-2 mb-1">
                  <Lightbulb className="w-5 h-5 text-amber-500" />
                  <h2 className="text-base font-bold text-slate-900">AI 추천 키워드</h2>
                </div>
                <p className="text-sm text-slate-500 mb-5">
                  콘텐츠에 포함할 키워드나 방향을 선택하세요. 선택하지 않아도 바로 생성할 수 있습니다.
                </p>

                {/* Suggestion chips */}
                <div className="flex flex-wrap gap-2 mb-6">
                  {suggestions.map(s => {
                    const isSelected = selectedSuggestions.includes(s);
                    return (
                      <button
                        key={s}
                        onClick={() => toggleSuggestion(s)}
                        className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full text-sm font-medium border transition-all cursor-pointer ${
                          isSelected
                            ? "bg-blue-600 text-white border-blue-600 shadow-sm shadow-blue-200"
                            : "bg-white text-slate-600 border-slate-200 hover:border-blue-300 hover:text-blue-600"
                        }`}
                      >
                        {isSelected && <X className="w-3 h-3" />}
                        {s}
                      </button>
                    );
                  })}
                </div>

                {/* Selected count */}
                {selectedSuggestions.length > 0 && (
                  <div className="flex items-center gap-2 mb-4 text-xs text-blue-600">
                    <span className="w-4 h-4 rounded-full bg-blue-100 flex items-center justify-center font-bold text-[10px]">
                      {selectedSuggestions.length}
                    </span>
                    개 선택됨 · 클릭해서 해제할 수 있습니다
                  </div>
                )}

                {/* Generate button */}
                <button
                  onClick={() => void handleGenerate()}
                  disabled={generating}
                  className="btn-cta w-full flex items-center justify-center gap-2 py-4 rounded-xl text-base font-semibold"
                >
                  <Wand2 className="w-5 h-5" />
                  {selectedSuggestions.length > 0
                    ? `선택한 키워드 ${selectedSuggestions.length}개 포함해서 생성`
                    : "5개 채널 콘텐츠 생성하기"}
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* ─── Phase 3: 채널 결과 ───────────────────────── */}
          {phase === "channels" && (
            <div ref={resultsRef}>
              {allDone && !generating && (
                <div className="text-center mb-6 flex flex-col items-center gap-3">
                  <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm font-medium">
                    <div className="w-2 h-2 rounded-full bg-emerald-500" />
                    {resultChannels.length}개 채널 생성 완료
                  </span>
                  <div className="flex gap-2">
                    <button onClick={backToSuggest}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-slate-200 text-slate-600 text-sm hover:bg-slate-50 cursor-pointer">
                      <ArrowLeft className="w-3.5 h-3.5" />키워드 다시 선택
                    </button>
                    <button onClick={resetAll}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-slate-200 text-slate-600 text-sm hover:bg-slate-50 cursor-pointer">
                      <RefreshCw className="w-3.5 h-3.5" />새 콘텐츠 생성
                    </button>
                    <Link href="/results"
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-50 text-blue-700 border border-blue-200 text-sm font-medium hover:bg-blue-100 cursor-pointer">
                      <LayoutList className="w-3.5 h-3.5" />결과물 보관함
                    </Link>
                  </div>
                </div>
              )}

              {genError && (
                <div className="mb-4 flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3 max-w-2xl mx-auto">
                  <AlertCircle className="w-4 h-4 shrink-0" />{genError}
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {resultChannels.map(channel => (
                  <div key={channel} className={channel === "magazine" || resultChannels.length === 1 ? "lg:col-span-2" : ""}>
                    <ChannelResultCard channel={channel} status={results[channel].status} content={results[channel].content} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {phase === "input" && (
            <div className="text-center mt-6">
              <a href="/guides" className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-blue-600 transition-colors cursor-pointer">
                <BookOpen className="w-4 h-4" />채널별 가이드 확인 및 수정하기
              </a>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
