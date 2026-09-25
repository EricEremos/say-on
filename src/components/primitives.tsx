import type { ReactNode } from "react";
import type { CardTheme } from "../lib/group-room";

type ButtonProps = Readonly<{
  children: ReactNode;
  kind?: "primary" | "quiet" | "danger";
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}>;

export const Button = ({ children, kind = "primary", onClick, disabled = false, type = "button" }: ButtonProps) => (
  <button className={`button button--${kind}`} type={type} onClick={onClick} disabled={disabled}>
    {children}
  </button>
);

export const PromptCard = ({ prompt, theme, artwork, illustration }: Readonly<{ prompt: string; theme: CardTheme; artwork: string; illustration: string }>) => (
  <article className={`prompt-card prompt-card--${theme.materialKey}`}>
    <img className="prompt-card__artwork" src={artwork} alt="" aria-hidden="true" />
    <div className="prompt-card__wash" aria-hidden="true" />
    <img className="prompt-card__illustration" src={illustration} alt="" aria-hidden="true" />
    <p>{prompt}</p>
  </article>
);
