import type { RoomActivityTransport } from "../hooks/use-room-activity";
import { balanceArtFor } from "../lib/balance-art";
import type { BalanceCard } from "../lib/questions";
import "./balance-question.css";

export const BalanceQuestion = ({ card, activity }: Readonly<{ card: BalanceCard; activity: RoomActivityTransport }>) => {
  const voted = activity.vote?.myChoice != null;
  const artwork = balanceArtFor(card);
  const selectedChoice = activity.vote?.myChoice ?? null;
  const aCount = activity.vote?.aCount ?? 0;
  const bCount = activity.vote?.bCount ?? 0;
  return (
    <section className="say-balance" aria-labelledby="balance-question-title" aria-busy={activity.isCastingVote}>
      <div className="say-balance__prompt">
        <h2 id="balance-question-title">{card.prompt}</h2>
      </div>
      <div className="say-balance__choices">
        {(["a", "b"] as const).map((choice) => {
          const selected = activity.vote?.myChoice === choice;
          const count = choice === "a" ? activity.vote?.aCount ?? 0 : activity.vote?.bCount ?? 0;
          return (
            <button className={`say-balance__choice${selected ? " say-balance__choice--selected" : ""}`} key={choice} type="button" aria-pressed={selected} disabled={activity.isCastingVote} onClick={() => activity.castVote(choice)}>
              <span className="say-balance__label">{card.choices[choice]}</span>
              <span className="say-balance__choice-art" aria-hidden="true">
                <img src={artwork[choice]} alt="" width={150} height={136} />
              </span>
              {voted ? <span className="say-balance__count">{count}표</span> : null}
            </button>
          );
        })}
      </div>
      {selectedChoice !== null ? <p className="sr-only" role="status">{`${card.choices[selectedChoice]} 선택. 현재 ${aCount}표 대 ${bCount}표.`}</p> : null}
    </section>
  );
};
