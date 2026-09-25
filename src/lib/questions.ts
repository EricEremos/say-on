import balanceCatalog from "../../content/balance-launch.ko.json";
import q01NewLearning from "../assets/cards/backgrounds-webp/q01-new-learning-background.webp";
import q02Recommendation from "../assets/cards/backgrounds-webp/q02-recommendation-background.webp";
import q03FirstTime from "../assets/cards/backgrounds-webp/q03-first-time-background.webp";
import q04TwentyMinuteSurvival from "../assets/cards/backgrounds-webp/q04-twenty-minute-survival-background.webp";
import q05Potato from "../assets/cards/backgrounds-webp/q05-potato-background.webp";
import q06OneAlbum from "../assets/cards/backgrounds-webp/q06-one-album-background.webp";
import q07GlobalMessage from "../assets/cards/backgrounds-webp/q07-global-message-background.webp";
import q08RemoveWord from "../assets/cards/backgrounds-webp/q08-remove-word-background.webp";
import q09OneEmoji from "../assets/cards/backgrounds-webp/q09-one-emoji-background.webp";
import q10EntranceSong from "../assets/cards/backgrounds-webp/q10-entrance-song-background.webp";
import q11FamousPerson from "../assets/cards/backgrounds-webp/q11-famous-person-background.webp";
import q12Wallpapers from "../assets/cards/backgrounds-webp/q12-wallpapers-background.webp";
import q13GuiltyPleasure from "../assets/cards/backgrounds-webp/q13-guilty-pleasure-background.webp";
import q14WorstAdvice from "../assets/cards/backgrounds-webp/q14-worst-advice-background.webp";
import q15EdibleCrayon from "../assets/cards/backgrounds-webp/q15-edible-crayon-background.webp";
import q16TalkShowGuest from "../assets/cards/backgrounds-webp/q16-talk-show-guest-background.webp";
import q17Superpower from "../assets/cards/backgrounds-webp/q17-superpower-background.webp";
import q01NewLearningSticker from "../assets/card-back-stickers-webp/q01-new-learning-sticker.webp";
import q02MediaRecommendationSticker from "../assets/card-back-stickers-webp/q02-media-recommendation-sticker.webp";
import q03FirstTimeSticker from "../assets/card-back-stickers-webp/q03-first-time-sticker.webp";
import q04EmergencyPrepSticker from "../assets/card-back-stickers-webp/q04-emergency-prep-sticker.webp";
import q05PotatoDishSticker from "../assets/card-back-stickers-webp/q05-potato-dish-sticker.webp";
import q06ForeverAlbumSticker from "../assets/card-back-stickers-webp/q06-forever-album-sticker.webp";
import q07GlobalMessageSticker from "../assets/card-back-stickers-webp/q07-global-message-sticker.webp";
import q08EraseAWordSticker from "../assets/card-back-stickers-webp/q08-erase-a-word-sticker.webp";
import q09OneEmojiSticker from "../assets/card-back-stickers-webp/q09-one-emoji-sticker.webp";
import q10EntranceSongSticker from "../assets/card-back-stickers-webp/q10-entrance-song-sticker.webp";
import q11FamousMeetingSticker from "../assets/card-back-stickers-webp/q11-famous-meeting-sticker.webp";
import q12WallpaperSticker from "../assets/card-back-stickers-webp/q12-wallpaper-sticker.webp";
import q13GuiltyPleasureSticker from "../assets/card-back-stickers-webp/q13-guilty-pleasure-sticker.webp";
import q14BadAdviceSticker from "../assets/card-back-stickers-webp/q14-bad-advice-sticker.webp";
import q15EdibleCrayonSticker from "../assets/card-back-stickers-webp/q15-edible-crayon-sticker.webp";
import q16TalkShowSticker from "../assets/card-back-stickers-webp/q16-talk-show-sticker.webp";
import q17SuperpowerSticker from "../assets/card-back-stickers-webp/q17-superpower-sticker.webp";

export const questions = [
  "최근 새롭게 배운 것이 있다면 들려주세요.",
  "요즘 다른 사람에게 추천하고 싶은 팟캐스트나 유튜브 채널이 있나요?",
  "가장 최근에 처음 해 본 일은 무엇이었나요?",
  "좀비 세상이 시작되기 전, 준비할 시간 20분이 주어진다면 가장 먼저 무엇을 챙길 건가요?",
  "내가 감자라면, 어떤 요리로 만들어지고 싶나요?",
  "평생 앨범 한 장만 들을 수 있다면 무엇을 고를 건가요?",
  "전 세계 사람들에게 한 가지 메시지를 보낼 수 있다면 무엇이라고 말하고 싶나요?",
  "사전에서 단어 하나를 없앨 수 있다면, 어떤 단어를 지우고 싶나요?",
  "평생 이모티콘 하나만 쓸 수 있다면 무엇을 고를 건가요?",
  "내가 운동선수라면, 경기장에 들어갈 때 어떤 노래를 틀고 싶나요?",
  "지금까지 만난 사람 가운데 가장 유명한 사람은 누구였나요? 어떻게 만나게 되었는지도 들려주세요.",
  "지금 컴퓨터와 휴대폰 배경화면은 어떤 이미지인가요? 그 이미지를 고른 이유도 들려주세요.",
  "좋아하지만 조금 민망해서 다른 사람에게 말하기 망설여지는 것은 무엇인가요?",
  "지금까지 들은 조언 중 가장 도움이 되지 않았던 조언은 무엇이었나요?",
  "크레용을 꼭 먹어야 한다면, 무슨 색을 고를 건가요?",
  "내가 토크쇼 진행자라면, 꼭 초대하고 싶은 손님은 누구인가요?",
  "초능력을 하나 가질 수 있다면, 어떤 능력을 갖고 싶나요?"
] as const;

export const questionCardArt = [
  q01NewLearning,
  q02Recommendation,
  q03FirstTime,
  q04TwentyMinuteSurvival,
  q05Potato,
  q06OneAlbum,
  q07GlobalMessage,
  q08RemoveWord,
  q09OneEmoji,
  q10EntranceSong,
  q11FamousPerson,
  q12Wallpapers,
  q13GuiltyPleasure,
  q14WorstAdvice,
  q15EdibleCrayon,
  q16TalkShowGuest,
  q17Superpower,
] as const;

export const questionImageFor = (questionIndex: number): string => questionCardArt[questionIndex] ?? questionCardArt[0];

export const questionStickers = [
  q01NewLearningSticker,
  q02MediaRecommendationSticker,
  q03FirstTimeSticker,
  q04EmergencyPrepSticker,
  q05PotatoDishSticker,
  q06ForeverAlbumSticker,
  q07GlobalMessageSticker,
  q08EraseAWordSticker,
  q09OneEmojiSticker,
  q10EntranceSongSticker,
  q11FamousMeetingSticker,
  q12WallpaperSticker,
  q13GuiltyPleasureSticker,
  q14BadAdviceSticker,
  q15EdibleCrayonSticker,
  q16TalkShowSticker,
  q17SuperpowerSticker,
] as const;

export const questionStickerFor = (questionIndex: number): string => questionStickers[questionIndex] ?? questionStickers[0];

export const promptFor = (sun: number, round: number): string => {
  const index = (sun - 1 + round) % questions.length;
  return questions[index] ?? "질문을 불러오는 중입니다.";
};

export type GameKey = "icebreaker" | "balance";

export const balanceCatalogId = balanceCatalog.catalogId as "balance-ko-2026-10";
export const rehearsalCatalogKey = `${balanceCatalog.catalogId}/v${balanceCatalog.version}`;
export const balanceCards = balanceCatalog.questions;
export type BalanceCard = (typeof balanceCards)[number];
export const balanceQuestions = balanceCards.map(({ prompt, choices }) => `${prompt}\n${choices.a} VS ${choices.b}`);

export const balanceQuestionCardBacks = balanceCards.map(() => "/brand/gathering-paper-v1.webp");
export const balanceQuestionReveals = balanceCards.map(() => "/brand/gathering-paper-v1.webp");
export const balanceQuestionStickers = balanceCards.map(() => "/brand/balance-paper-v1.webp");

export const remoteGameKey = (game: GameKey): string => game === "balance" ? balanceCatalogId : game;

export const questionsForGame = (game: GameKey): readonly string[] => game === "balance" ? balanceQuestions : questions;

export const questionForGameIndex = (game: GameKey, questionIndex: number): string =>
  questionsForGame(game)[questionIndex] ?? "질문을 불러오지 못했어요. 방에 다시 들어와 주세요.";

export const questionCardBackForGame = (game: GameKey, questionIndex: number): string =>
  game === "balance"
    ? balanceQuestionCardBacks[questionIndex] ?? balanceQuestionCardBacks[0]!
    : questionImageFor(questionIndex);

export const questionImageForGame = (game: GameKey, questionIndex: number): string =>
  game === "balance"
    ? balanceQuestionReveals[questionIndex] ?? balanceQuestionReveals[0]!
    : questionImageFor(questionIndex);

export const questionStickerForGame = (game: GameKey, questionIndex: number): string =>
  game === "balance"
    ? balanceQuestionStickers[questionIndex] ?? balanceQuestionStickers[0]!
    : questionStickerFor(questionIndex);
