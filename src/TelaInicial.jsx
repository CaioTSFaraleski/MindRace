// src/TelaInicial.jsx
import React, { useMemo, useState, useEffect } from "react";
import "./TelaInicial.css";
import Tela2 from "./TelaCorrida";

const DIGITS = (s) => (s || "").replace(/\D+/g, "");
const loadPerfil = () => JSON.parse(localStorage.getItem("perfil.v1") || "{}");
const savePerfil = (m) => localStorage.setItem("perfil.v1", JSON.stringify(m));
const loadRanking = () => JSON.parse(localStorage.getItem("ranking.v1") || "[]");

const defaultJogador = (papel) => ({
  participaRanking: true,
  telefone: "",
  nome: "",
  sobrenome: "",
  papel, // "policia" | "taxi"
});

function fmtFinal(ms) {
  if (typeof ms !== "number") return "—";
  const t = Math.max(0, Math.floor(ms));
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const c = Math.floor((t % 1000) / 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

function FormJogador({ label, data, onChange, disablePapel }) {
  const perfil = useMemo(loadPerfil, []);
  const telDigits = DIGITS(data.telefone);

  useEffect(() => {
    if (data.participaRanking && telDigits.length >= 10) {
      const p = perfil[telDigits];
      if (p && (!data.nome || !data.sobrenome)) {
        onChange({ ...data, nome: p.nome || "", sobrenome: p.sobrenome || "" });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [telDigits]);

  const set = (patch) => onChange({ ...data, ...patch });

  return (
    <div className="form-card">
      <div className="form-title">{label}</div>

      <label className="check">
        <input
          type="checkbox"
          checked={!data.participaRanking}
          onChange={(e) => {
            const off = e.target.checked;
            if (off) {
              set({ participaRanking: false, telefone: "", nome: "", sobrenome: "" });
            } else {
              set({ participaRanking: true });
            }
          }}
        />
        Não participar do ranking
      </label>

      <div className="row">
        <label>
          Telefone (com DDD)
          <input
            type="tel"
            value={data.telefone}
            disabled={!data.participaRanking}
            onChange={(e) => set({ telefone: e.target.value })}
            placeholder="(11) 9 9999-9999"
            inputMode="numeric"
          />
        </label>
      </div>

      <div className="row two">
        <label>
          Nome
          <input
            type="text"
            value={data.nome}
            disabled={!data.participaRanking}
            onChange={(e) => set({ nome: e.target.value })}
          />
        </label>
        <label>
          Sobrenome
          <input
            type="text"
            value={data.sobrenome}
            disabled={!data.participaRanking}
            onChange={(e) => set({ sobrenome: e.target.value })}
          />
        </label>
      </div>

      <div className="row">
        <label className="radio-group">
          Papel
          <div className="radios">
            <label>
              <input
                type="radio"
                name={`papel-${label}`}
                checked={data.papel === "policia"}
                onChange={() => !disablePapel && set({ papel: "policia" })}
                disabled={disablePapel && data.papel !== "policia"}
              />
              Polícia
            </label>
            <label>
              <input
                type="radio"
                name={`papel-${label}`}
                checked={data.papel === "taxi"}
                onChange={() => !disablePapel && set({ papel: "taxi" })}
                disabled={disablePapel && data.papel !== "taxi"}
              />
              Táxi
            </label>
          </div>
        </label>
      </div>
    </div>
  );
}

function ModalForm({ j1, j2, setJ1, setJ2, onClose, onConfirm }) {
  useEffect(() => {
    if (j1.papel === j2.papel) {
      setJ2({ ...j2, papel: j1.papel === "policia" ? "taxi" : "policia" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [j1.papel]);

  const validJog = (j) => {
    if (!j.participaRanking) return true;
    const tel = DIGITS(j.telefone);
    return tel.length >= 10 && tel.length <= 11 && j.nome.trim() && j.sobrenome.trim();
  };

  const telefonesOk = () => {
    const t1 = j1.participaRanking ? DIGITS(j1.telefone) : "";
    const t2 = j2.participaRanking ? DIGITS(j2.telefone) : "";
    if (!t1 || !t2) return true;
    return t1 !== t2;
  };

  const formOk = validJog(j1) && validJog(j2) && telefonesOk() && j1.papel !== j2.papel;

  const handleConfirm = () => {
    const perfil = loadPerfil();
    if (j1.participaRanking) {
      const t = DIGITS(j1.telefone);
      perfil[t] = { nome: j1.nome.trim(), sobrenome: j1.sobrenome.trim() };
    }
    if (j2.participaRanking) {
      const t = DIGITS(j2.telefone);
      perfil[t] = { nome: j2.nome.trim(), sobrenome: j2.sobrenome.trim() };
    }
    savePerfil(perfil);
    onConfirm();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Dados dos jogadores</h3>
        <div className="modal-body two-cols">
          <FormJogador label="Jogador 1" data={j1} onChange={setJ1} disablePapel={j2.papel === "policia"} />
          <FormJogador label="Jogador 2" data={j2} onChange={setJ2} disablePapel={j1.papel === "taxi"} />
        </div>
        {!telefonesOk() && <div className="error">Telefones não podem ser iguais.</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" disabled={!formOk} onClick={handleConfirm}>Confirmar</button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [tela, setTela] = useState(1);
  const [showForm, setShowForm] = useState(false);

  const [j1, setJ1] = useState(() => defaultJogador("policia"));
  const [j2, setJ2] = useState(() => defaultJogador("taxi"));

  const [corridaAtual, setCorridaAtual] = useState(null);
  const [ranking, setRanking] = useState([]);

  // carrega ranking quando volta para a tela 1 ou na primeira montagem
  useEffect(() => {
    if (tela !== 1) return;
    const arr = loadRanking();
    arr.sort((a, b) => (a.tempoMs ?? Infinity) - (b.tempoMs ?? Infinity));
    setRanking(arr);
  }, [tela]);

  const abrirForm = () => setShowForm(true);
  const fecharForm = () => setShowForm(false);

  const confirmarForm = () => {
    const norm = (j) =>
      j.participaRanking
        ? {
            participaRanking: true,
            telefone: DIGITS(j.telefone),
            nome: j.nome.trim(),
            sobrenome: j.sobrenome.trim(),
            papel: j.papel,
          }
        : { participaRanking: false, telefone: null, nome: null, sobrenome: null, papel: j.papel };

    const corrida = {
      inicio: Date.now(),
      jogadores: [norm(j1), norm(j2)],
    };
    setCorridaAtual(corrida);
    setShowForm(false);
    setTela(2);
  };

  if (tela === 2) {
    return (
      <Tela2
        onBack={() => setTela(1)}
        corrida={corridaAtual}
      />
    );
  }

  return (
    <div className="screen">
      <header className="header">
        <img src="/new-logo.png" alt="MindRace" className="logo" />
      </header>

      <main className="main">
        <section className="ranking">
          <h2>RANKING</h2>
          {ranking.length === 0 ? (
            <p className="ranking-empty">Sem resultados ainda.</p>
          ) : (
            <ol>
              {ranking.slice(0, 8).map((r, i) => {
                const nome = (r.nome && r.nome.trim()) || (r.papel === "policia" ? "Polícia" : "Táxi");
                return (
                  <li key={i}>
                    <span className="pos">{i + 1}</span>
                    <span className="nome">
                      {nome}
                      {i === 0 && " 🏆"}
                      {i === 1 && " 🥈"}
                      {i === 2 && " 🥉"}
                    </span>
                    <span className="tempo">{fmtFinal(r.tempoMs)}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section className="frase">
          <p>
            ACEITE O DESAFIO E PROVE <br />
            <span>QUÃO RÁPIDA SUA MENTE PODE SER!</span> <br />
          </p>
        </section>
      </main>

      <div className="cta-bottom">
        <button className="btn-start" onClick={abrirForm}>INICIAR</button>
      </div>

      {showForm && (
        <ModalForm
          j1={j1}
          j2={j2}
          setJ1={setJ1}
          setJ2={setJ2}
          onClose={fecharForm}
          onConfirm={confirmarForm}
        />
      )}
    </div>
  );
}
