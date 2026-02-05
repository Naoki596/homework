"use client";

import { useCallback, useMemo, useState } from "react";

import { TEAMS, type TeamId } from "@src/teams";
import type { NewsItem, NewsResponse } from "@src/lib/news/types";
import { ChatDock } from "./components/ChatDock";

type UiState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "success"; items: NewsItem[]; teamName: string };

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export default function Page() {
  const [selected, setSelected] = useState<TeamId | null>(null);
  const [ui, setUi] = useState<UiState>({ kind: "idle" });

  const selectedTeam = useMemo(() => {
    if (!selected) return null;
    return TEAMS.find((t) => t.teamId === selected) ?? null;
  }, [selected]);

  const fetchNews = useCallback(async (teamId?: TeamId | null) => {
    const id = teamId ?? selected;
    if (!id) return;
    setUi({ kind: "loading" });
    try {
      const res = await fetch(`/api/news?teamId=${encodeURIComponent(id)}`, {
        method: "GET",
        headers: { accept: "application/json" }
      });
      const data = (await res.json()) as NewsResponse;
      if ("errorCode" in data) {
        setUi({ kind: "error", message: data.message });
        return;
      }
      setUi({ kind: "success", items: data.items, teamName: data.teamName });
    } catch {
      setUi({
        kind: "error",
        message: "通信に失敗しました。時間をおいて再試行してください。"
      });
    }
  }, [selected]);

  const statusText = useMemo(() => {
    if (!selectedTeam) return "球団を選択してください。";
    if (ui.kind === "loading") return `${selectedTeam.name} のニュースを取得中…`;
    if (ui.kind === "success") return `${ui.teamName}：${ui.items.length}件表示`;
    return `${selectedTeam.name} を選択中`;
  }, [selectedTeam, ui]);

  return (
    <>
      <h1 className="title">NPB球団別ニュース（直近3件）</h1>
      <p className="subtitle">
        12球団から1球団を選ぶと、GoogleニュースRSSから新しい順に最大3件を表示します（APIキー不要）。
      </p>

      <div className="panel">
        <div className="grid" role="list" aria-label="球団一覧">
          {TEAMS.map((t) => {
            const isSelected = selected === t.teamId;
            return (
              <button
                key={t.teamId}
                type="button"
                className={`teamBtn ${isSelected ? "teamBtnSelected" : ""}`}
                onClick={() => {
                  setSelected(t.teamId);
                  // 選択即検索（設計書の「検索ボタン or 選択即検索」より）
                  void fetchNews(t.teamId);
                }}
                aria-pressed={isSelected}
              >
                <span className="badge" aria-hidden="true" data-logo="loading">
                  <img
                    className="badgeImg"
                    src={`/team-logos/${encodeURIComponent(t.teamId)}.png`}
                    alt=""
                    loading="lazy"
                    ref={(img) => {
                      // キャッシュ済みで onLoad が発火しないケースでも「ロゴあり」を確実に反映する
                      if (!img) return;
                      if (img.complete && img.naturalWidth > 0) {
                        img.parentElement?.setAttribute("data-logo", "loaded");
                      }
                    }}
                    onLoad={(e) => e.currentTarget.parentElement?.setAttribute("data-logo", "loaded")}
                    onError={(e) => {
                      // ロゴが見つからない/読み込み失敗時は確実にフォールバックを表示
                      e.currentTarget.parentElement?.setAttribute("data-logo", "error");
                    }}
                  />
                  <span className="badgeFallback">{t.icon.type === "text" ? t.icon.value : "★"}</span>
                </span>
                <span className="teamName">{t.name}</span>
              </button>
            );
          })}
        </div>

        <div className="actionsRow">
          <button
            className="btn"
            type="button"
            onClick={() => void fetchNews()}
            disabled={!selected || ui.kind === "loading"}
          >
            {ui.kind === "loading" ? "取得中…" : "再試行"}
          </button>
          <div className="status" aria-live="polite">
            {statusText}
          </div>
        </div>
      </div>

      {ui.kind === "error" ? (
        <div style={{ marginTop: 16 }} className="error">
          {ui.message}
        </div>
      ) : null}

      {ui.kind === "success" ? (
        <>
          {ui.items.length === 0 ? (
            <div style={{ marginTop: 16 }} className="panel" role="status">
              <div style={{ padding: 14, color: "var(--muted)" }}>
                該当するニュースが見つかりませんでした。
              </div>
            </div>
          ) : (
            <div className="cards" aria-label="ニュース一覧">
              {ui.items.map((item) => {
                const dateText = formatDate(item.publishedAt);
                return (
                  <article key={item.id} className="panel card">
                    <h3 className="cardTitle">
                      <a
                        className="link"
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {item.title}
                      </a>
                    </h3>
                    <div className="meta">
                      {item.source ? <span>{item.source}</span> : null}
                      {item.source && dateText ? <span>・</span> : null}
                      {dateText ? <time dateTime={item.publishedAt ?? undefined}>{dateText}</time> : null}
                    </div>
                    <p className="summary">{item.summary}</p>
                  </article>
                );
              })}
            </div>
          )}
        </>
      ) : null}

      <ChatDock
        context={{
          teamId: selected ?? null,
          teamName: ui.kind === "success" ? ui.teamName : selectedTeam?.name ?? null,
          items: ui.kind === "success" ? ui.items : []
        }}
      />
    </>
  );
}

