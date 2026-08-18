import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.RIOT_API_KEY;
const REGION = process.env.RIOT_REGION || "asia"; // account-v1, match-v5, mastery-v4용
const PLATFORM = process.env.RIOT_PLATFORM || "kr"; // summoner-v4, league-v4용

if (!API_KEY || API_KEY.includes("여기에")) {
  console.warn("⚠️  RIOT_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.");
}

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

async function riotFetch(url) {
  const res = await fetch(url, { headers: { "X-Riot-Token": API_KEY } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Riot API 오류 (${res.status}): ${body}`);
  }
  return res.json();
}

const TIER_KO = {
  IRON: "아이언", BRONZE: "브론즈", SILVER: "실버", GOLD: "골드",
  PLATINUM: "플래티넘", EMERALD: "에메랄드", DIAMOND: "다이아몬드",
  MASTER: "마스터", GRANDMASTER: "그랜드마스터", CHALLENGER: "챌린저",
};
const QUEUE_NAME = { RANKED_SOLO_5x5: "솔로랭크", RANKED_FLEX_SR: "자유랭크" };

// ---- Data Dragon(챔피언/아이콘 이미지) 준비 ----
let ddragonVersion = "14.1.1"; // 실패 시 폴백
let championMap = {}; // championId(숫자, 문자열) -> { id: "Ahri", nameKo: "아리" }

async function loadDataDragon() {
  try {
    const versions = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json();
    ddragonVersion = versions[0];
    const champData = await (
      await fetch(`https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/ko_KR/champion.json`)
    ).json();
    championMap = {};
    for (const key of Object.keys(champData.data)) {
      const c = champData.data[key];
      championMap[c.key] = { id: c.id, nameKo: c.name };
    }
    console.log(`✅ Data Dragon ${ddragonVersion} 로드 완료 (챔피언 ${Object.keys(championMap).length}개)`);
  } catch (err) {
    console.error("Data Dragon 로드 실패, 기본값으로 진행:", err.message);
  }
}
loadDataDragon();

function profileIconUrl(iconId) {
  return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/profileicon/${iconId}.png`;
}
function championIconUrl(championId) {
  const champ = championMap[String(championId)];
  if (!champ) return null;
  return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${champ.id}.png`;
}

// ---- 팀 로스터 (서버 메모리에 저장, 재시작하면 초기화됨) ----
let roster = [];
let nextId = 1;

const LINES = ["탑", "정글", "미드", "원딜", "서포터"];

// 팀원 등록: 닉네임#태그 + 라인 선호도 -> puuid/아이콘 조회 후 슬롯 추가
app.post("/api/players", async (req, res) => {
  try {
    const { name, tag, mainLine, subLine, avoidLine } = req.body;
    if (!name || !tag || !mainLine || !subLine || !avoidLine) {
      return res.status(400).json({ error: "닉네임, 태그, 주라인, 부라인, 기피라인을 모두 입력해주세요." });
    }
    if (!LINES.includes(mainLine) || !LINES.includes(subLine) || !LINES.includes(avoidLine)) {
      return res.status(400).json({ error: "라인 값이 올바르지 않습니다." });
    }

    const account = await riotFetch(
      `https://${REGION}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`
    );
    const summoner = await riotFetch(
      `https://${PLATFORM}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${account.puuid}`
    );

    const entry = {
      id: nextId++,
      riotId: `${account.gameName}#${account.tagLine}`,
      puuid: account.puuid,
      profileIconUrl: profileIconUrl(summoner.profileIconId),
      level: summoner.summonerLevel,
      mainLine,
      subLine,
      avoidLine,
    };

    // 같은 puuid로 이미 등록되어 있으면 갱신, 아니면 추가
    roster = roster.filter((p) => p.puuid !== entry.puuid);
    roster.push(entry);

    res.json(entry);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 전체 로스터 조회
app.get("/api/players", (req, res) => {
  res.json(roster);
});

// 팀원 삭제
app.delete("/api/players/:id", (req, res) => {
  roster = roster.filter((p) => p.id !== Number(req.params.id));
  res.json({ ok: true });
});

// 특정 팀원 상세: 티어 + 모스트 챔피언 3개
app.get("/api/players/:id/detail", async (req, res) => {
  try {
    const player = roster.find((p) => p.id === Number(req.params.id));
    if (!player) return res.status(404).json({ error: "등록되지 않은 팀원입니다." });

    const [leagueEntries, topMasteries] = await Promise.all([
      riotFetch(`https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${player.puuid}`),
      riotFetch(`https://${REGION}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${player.puuid}/top?count=3`),
    ]);

    const tiers = leagueEntries.map((e) => ({
      queue: QUEUE_NAME[e.queueType] || e.queueType,
      tier: TIER_KO[e.tier] || e.tier,
      rank: e.rank,
      lp: e.leaguePoints,
      wins: e.wins,
      losses: e.losses,
    }));

    const mostChampions = topMasteries.map((m) => {
      const champ = championMap[String(m.championId)] || { nameKo: `챔피언#${m.championId}` };
      return {
        name: champ.nameKo,
        iconUrl: championIconUrl(m.championId),
        level: m.championLevel,
        points: m.championPoints,
      };
    });

    res.json({ riotId: player.riotId, tiers, mostChampions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});

