export type GlossaryEntry = {
  term: string;
  explain: string;
  aliases?: string[];
};

// 無料運用のため、まずは「よく出る野球用語」を辞書で解説する。
// 固有名詞（選手名など）は基本的に辞書に入れず、検出だけして記事参照を促す。
export const GLOSSARY: readonly GlossaryEntry[] = [
  { term: "補強", explain: "戦力を高めるために選手を獲得・入れ替えること。" },
  { term: "FA", aliases: ["フリーエージェント"], explain: "一定年数プレーした選手が、他球団と自由に契約交渉できる制度。" },
  { term: "ドラフト", explain: "新人選手を各球団が指名して獲得する仕組み（ドラフト会議）。" },
  { term: "トレード", explain: "球団同士で選手を交換（移籍）すること。" },
  { term: "育成", aliases: ["育成契約"], explain: "育成選手として契約し、支配下登録を目指す制度/区分。" },
  { term: "支配下", aliases: ["支配下登録"], explain: "一軍公式戦に出場できる選手登録枠（支配下選手）。" },
  { term: "二軍", aliases: ["ファーム"], explain: "一軍の下部チーム。調整や育成、復帰戦などで出場する。" },
  { term: "一軍", aliases: ["トップチーム"], explain: "公式戦（NPB）に出場する主力チーム。" },
  { term: "登録抹消", aliases: ["抹消"], explain: "一軍の選手登録から外れること。一定期間一軍に出られない場合がある。" },
  { term: "昇格", explain: "二軍などから一軍の選手登録に上がること。" },
  { term: "先発", aliases: ["先発投手"], explain: "試合の最初に投げる投手。" },
  { term: "救援", aliases: ["リリーフ"], explain: "先発の後に投げる投手。" },
  { term: "中継ぎ", aliases: ["セットアッパー"], explain: "主に中盤〜終盤をつなぐ救援投手。" },
  { term: "抑え", aliases: ["クローザー"], explain: "試合の最後を締める救援投手。" },
  { term: "登板", explain: "投手として試合に出て投げること。" },
  { term: "完投", explain: "先発投手が最後まで投げ切ること。" },
  { term: "完封", explain: "相手に得点を与えずに勝つこと（投手側の記録として用いられる）。" },
  { term: "無失点", explain: "失点（相手の得点）を0に抑えること。" },
  { term: "サヨナラ", aliases: ["サヨナラ勝ち"], explain: "最終回（延長含む）の裏に得点して、その時点で試合が終了する勝ち方。" },
  { term: "本塁打", aliases: ["ホームラン"], explain: "打者が一打で本塁へ戻り得点する打撃。" },
  { term: "適時打", aliases: ["タイムリー"], explain: "走者が得点する打撃。" },
  { term: "犠打", aliases: ["バント"], explain: "打者がアウトになる代わりに走者を進める打撃。" },
  { term: "盗塁", explain: "投球の間に走者が次の塁へ進むこと。" },
  { term: "失策", aliases: ["エラー"], explain: "守備側のミスで打者/走者を生かしたり進塁させたりすること。" },
  { term: "併殺", aliases: ["ゲッツー"], explain: "1つのプレーでアウトを2つ取ること。" },
  { term: "三振", aliases: ["奪三振"], explain: "打者が3ストライクでアウトになること（投手側は奪三振）。" },
  { term: "打率", explain: "打数に対する安打数の割合（ヒットの出やすさの目安）。" },
  { term: "防御率", aliases: ["ERA"], explain: "投手が9回投げたと仮定したときの自責点の平均（低いほど良い）。" },
  { term: "OPS", explain: "出塁率＋長打率。打者の総合的な打撃力の目安。" },
  { term: "勝ち越し", explain: "同点からリードする得点、または期間合計で勝敗がプラスになること。" },
  { term: "逆転", explain: "負けている状態から得点してリードを入れ替えること。" }
] as const;

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

export function findGlossaryEntry(term: string): GlossaryEntry | null {
  const t = normalize(term);
  for (const e of GLOSSARY) {
    if (normalize(e.term) === t) return e;
    for (const a of e.aliases ?? []) {
      if (normalize(a) === t) return e;
    }
  }
  return null;
}

