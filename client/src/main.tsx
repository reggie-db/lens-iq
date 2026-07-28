import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "@databricks/appkit-ui/react";
import App from "./App";
import { ThemeProvider } from "./lib/theme";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <App />
        <Toaster position="top-right" richColors closeButton />
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
