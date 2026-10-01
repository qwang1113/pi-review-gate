import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "@/App";
import { DaemonProvider } from "@/lib/daemon-context";
import "@/index.css";

const container = document.getElementById("root");
if (container === null) throw new Error("#root 不在 index.html 里");

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <DaemonProvider>
        <App />
      </DaemonProvider>
    </BrowserRouter>
  </StrictMode>,
);
