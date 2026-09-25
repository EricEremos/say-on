import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./say-on-room.css";

if (import.meta.env.DEV && import.meta.env["VITE_DISABLE_REACT_DEVTOOLS"] !== "1") {
  void import("react-grab");
  void import("react-scan");
}

createRoot(document.getElementById("root") ?? document.body).render(
  <StrictMode>
    <App />
  </StrictMode>
);
