import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ConnectionRouter from "./ConnectionRouter";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConnectionRouter>
      <App />
    </ConnectionRouter>
  </React.StrictMode>,
);
