import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ToolsApp from "./index";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <ToolsApp />
  </StrictMode>,
);
