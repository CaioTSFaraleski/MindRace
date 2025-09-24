import React, { useState } from "react";
import "./TelaInicial.css";
import Tela2 from "./TelaCorrida";

export default function App() {
  const [tela, setTela] = useState(1);

  const ranking = [
    { nome: "João", tempo: "22,45" },
    { nome: "Miguel", tempo: "23,10" },
    { nome: "Gabriel", tempo: "23,92" },
    { nome: "Lucas", tempo: "25,36" },
    { nome: "Marina", tempo: "25,80" },
    { nome: "Eduardo", tempo: "26,05" },
    { nome: "Rodrigo", tempo: "26,33" },
    { nome: "Camila", tempo: "26,92" },
    { nome: "Bruno", tempo: "27,11" },
    { nome: "Léo", tempo: "27,30" },
  ];

  if (tela === 2) {
    return <Tela2 onVoltar={() => setTela(1)} />;
  }

  return (
    <div className="screen">
      {/* Logo */}
      <header className="header">
        <img src="/new-logo.png" alt="MindRace" className="logo" />
      </header>

      {/* Grid principal: ranking à esquerda, texto à direita */}
      <main className="main">
        <section className="ranking">
          <h2>RANKING</h2>
          <ol>
            {ranking.slice(0, 8).map((r, i) => (
              <li key={i}>
                <span className="pos">{i + 1}</span>
                <span className="nome">{r.nome}{i === 0 && " 🏆"}{i === 1 && " 🥈"}{i === 2 && " 🥉"}</span>
                <span className="tempo">{r.tempo}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="frase">
          <p>
            ACEITE O DESAFIO E PROVE <br />
            <span>QUÃO RÁPIDA SUA MENTE PODE SER!</span> <br />
          </p>
        </section>
      </main>

      {/* Botão fixo no centro inferior */}
      <div className="cta-bottom">
        <button className="btn-start" onClick={() => setTela(2)}>
          INICIAR
        </button>
      </div>
    </div>
  );
}
