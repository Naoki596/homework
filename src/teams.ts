export type TeamId =
  | "giants"
  | "tigers"
  | "baystars"
  | "carp"
  | "swallows"
  | "dragons"
  | "hawks"
  | "fighters"
  | "marines"
  | "lions"
  | "eagles"
  | "buffaloes";

export type Team = {
  teamId: TeamId;
  name: string;
  queries: string[];
  icon: { type: "text" | "image"; value: string };
};

export const TEAMS: readonly Team[] = [
  {
    teamId: "giants",
    name: "読売ジャイアンツ",
    queries: ["巨人", "ジャイアンツ", "読売"],
    icon: { type: "text", value: "G" }
  },
  {
    teamId: "tigers",
    name: "阪神タイガース",
    queries: ["阪神", "タイガース"],
    icon: { type: "text", value: "T" }
  },
  {
    teamId: "baystars",
    name: "横浜DeNAベイスターズ",
    queries: ["DeNA", "ベイスターズ", "横浜DeNA"],
    icon: { type: "text", value: "DB" }
  },
  {
    teamId: "carp",
    name: "広島東洋カープ",
    queries: ["広島", "カープ", "広島カープ"],
    icon: { type: "text", value: "C" }
  },
  {
    teamId: "swallows",
    name: "東京ヤクルトスワローズ",
    queries: ["ヤクルト", "スワローズ", "東京ヤクルト"],
    icon: { type: "text", value: "YS" }
  },
  {
    teamId: "dragons",
    name: "中日ドラゴンズ",
    queries: ["中日", "ドラゴンズ"],
    icon: { type: "text", value: "D" }
  },
  {
    teamId: "hawks",
    name: "福岡ソフトバンクホークス",
    queries: ["ソフトバンク", "ホークス", "福岡ソフトバンク"],
    icon: { type: "text", value: "H" }
  },
  {
    teamId: "fighters",
    name: "北海道日本ハムファイターズ",
    queries: ["日本ハム", "ファイターズ", "北海道日本ハム"],
    icon: { type: "text", value: "F" }
  },
  {
    teamId: "marines",
    name: "千葉ロッテマリーンズ",
    queries: ["ロッテ", "マリーンズ", "千葉ロッテ"],
    icon: { type: "text", value: "M" }
  },
  {
    teamId: "lions",
    name: "埼玉西武ライオンズ",
    queries: ["西武", "ライオンズ", "埼玉西武"],
    icon: { type: "text", value: "L" }
  },
  {
    teamId: "eagles",
    name: "東北楽天ゴールデンイーグルス",
    queries: ["楽天", "イーグルス", "東北楽天"],
    icon: { type: "text", value: "E" }
  },
  {
    teamId: "buffaloes",
    name: "オリックス・バファローズ",
    queries: ["オリックス", "バファローズ"],
    icon: { type: "text", value: "B" }
  }
] as const;

export const TEAM_BY_ID: ReadonlyMap<TeamId, Team> = new Map(
  TEAMS.map((t) => [t.teamId, t])
);

export function getTeam(teamId: string | null | undefined): Team | null {
  if (!teamId) return null;
  return (TEAM_BY_ID.get(teamId as TeamId) ?? null) as Team | null;
}

