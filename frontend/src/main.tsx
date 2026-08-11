import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ConnectionRouter from "./ConnectionRouter";
import "./styles.css";

window.addEventListener("photoframe-auth-changed", () => {
  window.location.assign("/");
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConnectionRouter>
      <App />
    </ConnectionRouter>
  </React.StrictMode>,
);
