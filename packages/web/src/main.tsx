import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const apiUrl = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? "";
createRoot(document.getElementById("root")!).render(<App apiUrl={apiUrl} />);
