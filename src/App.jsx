// App.jsx
import React, { useState } from "react";
import TelaInicial from "./TelaInicial";
import TelaCorrida from "./TelaCorrida";

export default function App() {
  const [tela, setTela] = useState("inicial");
  return (
    <>
      {tela === "inicial" && <TelaInicial onStart={() => setTela("corrida")} />}
      {tela === "corrida" && <TelaCorrida onBack={() => setTela("inicial")} />}
    </>
  );
}
