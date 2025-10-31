// src/TelaCorrida.jsx
import React, { useCallback, useEffect, useRef, useState } from "react";
import "./TelaCorrida.css";

const BAUD = 115200; // mesmo baud do Serial USB do Arduino
const DEFAULT_TOTAL = 10;

const initialPlayer = (voltasTotal = DEFAULT_TOTAL) => ({
  concentracao: 0,
  boost: 0,
  voltas: 0,
  voltasTotal,
  tempoFinalMs: null,
});

const loadRanking = () => JSON.parse(localStorage.getItem("ranking.v1") || "[]");
const saveRanking = (arr) => localStorage.setItem("ranking.v1", JSON.stringify(arr));

function WifiIcon({ q }) {
  const lvl = Number.isFinite(q) ? Math.max(0, Math.min(200, q)) : 200;
  let bars = 1, color = "#ef4444";
  if (lvl === 0) { bars = 3; color = "#22c55e"; }
  else if (lvl > 0 && lvl < 200) { bars = 2; color = "#f59e0b"; }
  const bar = (h, on) => (
    <rect width="6" height={h} rx="2" x="0" y={24 - h} fill={color} opacity={on ? 1 : 0.25}/>
  );
  return (
    <svg width="28" height="24" viewBox="0 0 28 24" aria-label="qualidade de conexão" style={{ verticalAlign: "middle" }}>
      <g transform="translate(4,0)">
        <g transform="translate(0,0)">{bar(8,  bars >= 1)}</g>
        <g transform="translate(10,0)">{bar(14, bars >= 2)}</g>
        <g transform="translate(20,0)">{bar(20, bars >= 3)}</g>
      </g>
    </svg>
  );
}

// ---- Eye (blink) icon ----
const EyeIcon = ({ active = false, className = "" }) => (
  <svg
    width="22" height="14" viewBox="0 0 24 14" aria-label="blink"
    className={`${className} ${active ? "eye-on" : ""}`}
  >
    <path
      d="M1,7 C3.5,2 8,1 12,1 C16,1 20.5,2 23,7 C20.5,12 16,13 12,13 C8,13 3.5,12 1,7 Z"
      fill="none"
      stroke={active ? "#fff" : "rgba(255,255,255,0.45)"}
      strokeWidth="1.7"
    />
    <circle cx="12" cy="7" r="3.2" fill={active ? "#fff" : "rgba(255,255,255,0.45)"} />
  </svg>
);

const Bar = React.memo(function Bar({ value, className }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className={`progress ${className || ""}`}>
      <div className="progress-fill" style={{ width: `${v}%` }} />
    </div>
  );
});

export default function TelaCorrida({ onBack, corrida }) {
  const [policia, setPolicia] = useState(() => initialPlayer(DEFAULT_TOTAL));
  const [taxi, setTaxi] = useState(() => initialPlayer(DEFAULT_TOTAL));

  const [timerMs, setTimerMs] = useState(0);
  const [running, setRunning] = useState(false);
  const timerRef = useRef(null);
  const startTsRef = useRef(0);
  const startedRef = useRef(false);

  const [conn, setConn] = useState({ policia: "desconectado", taxi: "desconectado" });
  const [connectModalOpen, setConnectModalOpen] = useState(true);
  const [pairingInProgress, setPairingInProgress] = useState(false);

  const [resultModalOpen, setResultModalOpen] = useState(false);
  const [winner, setWinner] = useState(null);
  const [winnerReason, setWinnerReason] = useState("");

  const connsRef = useRef([]); // [{side:null|"policia"|"taxi", port, reader, buffer}]
  const [connQual, setConnQual] = useState({ policia: 200, taxi: 200 });
  const connectedOnceRef = useRef({ policia: false, taxi: false });

  const [relax, setRelax] = useState({ policia: 0, taxi: 0 });
  const [relaxModal, setRelaxModal] = useState({ policia: false, taxi: false });

  // ---- Blink feedback (olho piscando) ----
  const [blinkState, setBlinkState] = useState({ policia: 0, taxi: 0 });
  const BLINK_HOLD_MS = 220; // animação rápida ~180ms + margem

  const isBlinking = useCallback((lado) => {
    const t = blinkState[lado] || 0;
    return (performance.now() - t) < BLINK_HOLD_MS;
  }, [blinkState]);

  const eyeWrapStyle = { position: "absolute", top: 8, right: 10, opacity: 0.95 };
  // ----------------------------------------

  useEffect(() => {
    connectedOnceRef.current = { policia: false, taxi: false };
    setConnQual({ policia: 200, taxi: 200 });
    setConn({ policia: "desconectado", taxi: "desconectado" });
    setRelax({ policia: 0, taxi: 0 });
    setRelaxModal({ policia: false, taxi: false });
  }, []);

  const fmtTop = (ms) => {
    const t = Math.max(0, Math.floor(ms));
    const m = Math.floor(t / 60000);
    const s = Math.floor((t % 60000) / 1000);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };
  const fmtFinal = (ms) => {
    const t = Math.max(0, Math.floor(ms));
    const m = Math.floor(t / 60000);
    const s = Math.floor((t % 60000) / 1000);
    const c = Math.floor((t % 1000) / 10);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
  };
  const statusClass = (s) => `status status-${s}`;

  const startTimer = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (timerRef.current) clearInterval(timerRef.current);
    setRunning(true);
    startTsRef.current = performance.now();
    timerRef.current = setInterval(() => {
      setTimerMs(performance.now() - startTsRef.current);
    }, 30);
  }, []);

  const stopTimer = useCallback(() => {
    if (!running) return;
    clearInterval(timerRef.current);
    timerRef.current = null;
    setRunning(false);
  }, [running]);

  // NÃO inicia mais automaticamente. Apenas marca "conectado".
  const markConnected = useCallback((lado, conexaoVal) => {
    const ok = Number.isFinite(conexaoVal) && conexaoVal >= 0 && conexaoVal < 200;
    if (ok && !connectedOnceRef.current[lado]) {
      connectedOnceRef.current[lado] = true;
      setConn((c) => ({ ...c, [lado]: "conectado" }));
      // sem auto-start aqui
    }
  }, []);

  // ==== applyPlayer: usa voltasTotal do Arduino (quando vier) ====
  const applyPlayer = useCallback((lado, data) => {
    setConnQual(prev => {
      const prevQ = prev[lado];
      const n = Number(data?.conexao);
      const q = Number.isFinite(n) ? Math.max(0, Math.min(200, n))
                                   : (Number.isFinite(prevQ) ? prevQ : 200);
      markConnected(lado, q);
      return { ...prev, [lado]: q };
    });

    setRelax(prev => {
      const prevR = prev[lado];
      const n = Number(data?.relaxamento);
      const r = Number.isFinite(n) ? Math.max(0, Math.min(100, n))
                                   : (Number.isFinite(prevR) ? prevR : 0);
      return { ...prev, [lado]: r };
    });

    const setPlayer = lado === "policia" ? setPolicia : setTaxi;
    setPlayer(prev => {
      const nT = Number(data?.voltasTotal);
      const totalFromArduino = Number.isFinite(nT) && nT > 0 ? Math.floor(nT) : prev.voltasTotal || DEFAULT_TOTAL;

      const nC = Number(data?.concentracao);
      const cx = Number.isFinite(nC) ? Math.max(0, Math.min(100, nC))
                                     : (Number.isFinite(prev.concentracao) ? prev.concentracao : 0);

      const nB = Number(data?.boost);
      const bs = Number.isFinite(nB) ? Math.max(0, Math.min(100, nB))
                                     : (Number.isFinite(prev.boost) ? prev.boost : 0);

      const nV = Number(data?.voltas);
      const vtRaw = Number.isFinite(nV) ? nV : prev.voltas;
      const laps  = Math.min(totalFromArduino, Math.max(0, vtRaw));

      const rlSnapshot =
        lado === "policia"
          ? (Number.isFinite(relax.policia) ? relax.policia : 0)
          : (Number.isFinite(relax.taxi) ? relax.taxi : 0);

      const needRelaxModal = (laps >= 5 && cx <= 0 && rlSnapshot < 50);
      setRelaxModal(m => ({ ...m, [lado]: needRelaxModal }));

      const finishedNow = prev.tempoFinalMs == null && laps >= totalFromArduino && running;

      return {
        ...prev,
        concentracao: cx,
        boost: bs,
        voltas: needRelaxModal ? Math.min(prev.voltas, laps) : laps,
        voltasTotal: totalFromArduino,
        tempoFinalMs: finishedNow ? timerMs : prev.tempoFinalMs,
      };
    });
  }, [running, timerMs, relax, markConnected]);
  // ====================================

  const parseLine = useCallback(
    (line, sideFallback) => {
      try {
        const obj = JSON.parse(line.trim());

        // 1) Evento de blink vindo do Arduino
        if (obj && obj.evento === "blink") {
          const ladoBlink = obj.lado ? String(obj.lado).toLowerCase() : sideFallback;
          if (ladoBlink === "policia" || ladoBlink === "taxi") {
            setBlinkState(prev => ({ ...prev, [ladoBlink]: performance.now() }));
          }
          return;
        }

        // 2) Atualização normal de estado por lado
        const lado = obj.lado ? String(obj.lado).toLowerCase() : sideFallback;
        if (lado === "policia" || lado === "taxi") {
          applyPlayer(lado, obj);
        }
      } catch {}
    },
    [applyPlayer]
  );

  const connectReaderLoop = useCallback(
    (port, side = null) => {
      const textDecoder = new TextDecoderStream();
      const readableClosed = port.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable.getReader();
      const connObj = { side, port, reader, buffer: "" };
      connsRef.current.push(connObj);

      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              connObj.buffer += value;
              let idx;
              while ((idx = connObj.buffer.indexOf("\n")) >= 0) {
                const line = connObj.buffer.slice(0, idx);
                connObj.buffer = connObj.buffer.slice(idx + 1);

                // Tenta parse direto (pode ser evento de blink)
                try {
                  const obj = JSON.parse(line.trim());

                  if (obj && obj.evento === "blink") {
                    const ladoBlink = obj.lado ? String(obj.lado).toLowerCase() : null;
                    if (ladoBlink === "policia" || ladoBlink === "taxi") {
                      connObj.side = ladoBlink;
                      setBlinkState(prev => ({ ...prev, [ladoBlink]: performance.now() }));
                      continue;
                    }
                  }

                  const lado = obj.lado ? String(obj.lado).toLowerCase() : null;
                  if (lado === "policia" || lado === "taxi") {
                    connObj.side = lado;
                    applyPlayer(lado, obj);
                    continue;
                  }
                } catch {}

                // Se não deu parse ou não tinha 'lado', usa fallback
                if (connObj.side === "policia" || connObj.side === "taxi") {
                  parseLine(line, connObj.side);
                }
              }
            }
          }
        } catch {
        } finally {
          try { await reader.cancel(); } catch {}
          try { reader.releaseLock(); } catch {}
          try { await readableClosed; } catch {}
          try { await port.close(); } catch {}
        }
      })();
    },
    [applyPlayer, parseLine]
  );

  useEffect(() => {
    (async () => {
      if (!("serial" in navigator)) {
        setConn({ policia: "erro", taxi: "erro" });
        return;
      }
      try {
        const ports = await navigator.serial.getPorts();
        for (const port of ports) {
          if (connsRef.current.length >= 2) break;
          setConn((c) => ({
            ...c,
            policia: c.policia === "desconectado" ? "conectando" : c.policia,
            taxi: c.taxi === "desconectado" ? "conectando" : c.taxi,
          }));
          await port.open({ baudRate: BAUD });
          try { await port.setSignals({ dataTerminalReady: true, requestToSend: true }); } catch {}
          await new Promise(r => setTimeout(r, 300));
          connectReaderLoop(port);
        }
      } catch {}
    })();

    return () => {
      startedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      connsRef.current.forEach(async (c) => {
        try { await c.reader?.cancel(); } catch {}
        try { c.reader?.releaseLock(); } catch {}
        try { await c.port?.close(); } catch {}
      });
      connsRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pairTwoDialogs = async () => {
    if (!("serial" in navigator) || pairingInProgress) return;
    setPairingInProgress(true);
    try {
      for (let i = connsRef.current.length; i < 2; i++) {
        setConn((c) => ({
          ...c,
          policia: c.policia === "desconectado" ? "conectando" : c.policia,
          taxi: c.taxi === "desconectado" ? "conectando" : c.taxi,
        }));
        const port = await navigator.serial.requestPort();
        await port.open({ baudRate: BAUD });
        try { await port.setSignals({ dataTerminalReady: true, requestToSend: true }); } catch {}
        await new Promise(r => setTimeout(r, 300));
        connectReaderLoop(port);
      }
    } catch {
    } finally {
      setPairingInProgress(false);
    }
  };

  useEffect(() => {
    if (!running) return;
    if (policia.voltas >= policia.voltasTotal && policia.tempoFinalMs == null) {
      setPolicia(p => ({ ...p, tempoFinalMs: timerMs }));
    }
    if (taxi.voltas >= taxi.voltasTotal && taxi.tempoFinalMs == null) {
      setTaxi(p => ({ ...p, tempoFinalMs: timerMs }));
    }
  }, [running, timerMs, policia.voltas, policia.voltasTotal, policia.tempoFinalMs, taxi.voltas, taxi.voltasTotal, taxi.tempoFinalMs]);

  useEffect(() => {
    if (!running) return;
    const pDone = policia.voltas >= policia.voltasTotal && policia.tempoFinalMs != null;
    const tDone = taxi.voltas >= taxi.voltasTotal && taxi.tempoFinalMs != null;
    if (pDone && tDone && !resultModalOpen) {
      stopTimer();
      if (policia.tempoFinalMs < taxi.tempoFinalMs) {
        setWinner("policia"); setWinnerReason("Menor tempo final.");
      } else if (taxi.tempoFinalMs < policia.tempoFinalMs) {
        setWinner("taxi"); setWinnerReason("Menor tempo final.");
      } else {
        setWinner("empate"); setWinnerReason("Tempos iguais.");
      }
      setResultModalOpen(true);
    }
  }, [running, policia, taxi, resultModalOpen, stopTimer]);

  const finalizeManually = () => {
    stopTimer();
    if (!resultModalOpen) {
      let w = "empate"; let reason = "Mesmas voltas.";
      if (policia.voltas > taxi.voltas) { w = "policia"; reason = "Mais voltas."; }
      else if (taxi.voltas > policia.voltas) { w = "taxi"; reason = "Mais voltas."; }
      setWinner(w); setWinnerReason(reason); setResultModalOpen(true);
    }
  };

  const goBack = () => {
    const arr = loadRanking();
    const saveIf = (lado, tempoMs) => {
      if (typeof tempoMs !== "number") return;
      const j = corrida?.jogadores?.find(x => x.papel === lado);
      arr.push({
        telefone: j?.telefone || "",
        nome: j ? `${j.nome ?? ""} ${j.sobrenome ?? ""}`.trim() : "",
        papel: lado,
        tempoMs,
        data: Date.now(),
      });
    };
    saveIf("policia", policia.tempoFinalMs);
    saveIf("taxi", taxi.tempoFinalMs);
    saveRanking(arr);
    if (typeof onBack === "function") onBack();
    else window.location.reload();
  };

  const needPairing = connsRef.current.length < 2;

  // ---- Botão "Iniciar corrida" no modal ----
  const connectedCount =
    (conn.policia === "conectado" ? 1 : 0) + (conn.taxi === "conectado" ? 1 : 0);

  const beginRaceFromModal = () => {
    if (connectedCount >= 1) {
      setConnectModalOpen(false);
      startTimer();
    }
  };
  // ------------------------------------------

  return (
    <div className="t2-wrapper">
      <div className="t2-bg" />

      <header className="t2-top">
        <div className="t2-timer">{fmtTop(timerMs)}</div>
      </header>

      <main className="t2-panels">
        {/* PAINEL POLÍCIA */}
        <section className="panel panel-left">
          <div className={`panel-inner ${relaxModal.policia ? "blurred" : ""}`}>
            {/* olhinho de blink */}
            <div style={eyeWrapStyle} title="Blink detectado">
              <EyeIcon active={isBlinking("policia")} className="eye" />
            </div>

            <h2 className="panel-title panel-title-cyan">POLÍCIA</h2>
            <div className="metric">
              <div className="metric-label">CONCENTRAÇÃO</div>
              <Bar value={Number.isFinite(policia.concentracao) ? policia.concentracao : 0} className="progress-cyan" />
              <div className="metric-value metric-cyan">
                {Number.isFinite(policia.concentracao) ? policia.concentracao.toFixed(0) : "0"}%
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">BOOST</div>
              <Bar value={Number.isFinite(policia.boost) ? policia.boost : 0} className="progress-green" />
            </div>
            <div className="kv">
              <span>VOLTAS</span><span className="kv-value">{policia.voltas}/{policia.voltasTotal}</span>
            </div>
            <div className="kv">
              <span>TEMPO FINAL</span>
              <span className="kv-value">{typeof policia.tempoFinalMs === "number" ? fmtFinal(policia.tempoFinalMs) : "-:-"}</span>
            </div>
            <div className="kv">
              <span>CONEXÃO</span>
              <span className="kv-value"><WifiIcon q={connQual.policia} /></span>
            </div>
          </div>

          {relaxModal.policia && (
            <div className="side-modal">
              <div className="side-modal-box">
                <h3 className="modal-title">Polícia — Relaxamento</h3>
                <p>Concentração zerou. Retoma quando <b>relaxamento ≥ 50%</b>.</p>
                <div className="metric">
                  <div className="metric-label">RELAXAMENTO</div>
                  <Bar value={Number.isFinite(relax.policia) ? relax.policia : 0} className="progress-cyan" />
                  <div className="metric-value metric-cyan">
                    {Number.isFinite(relax.policia) ? relax.policia.toFixed(0) : "0"}%
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* PAINEL TÁXI */}
        <section className="panel panel-right">
          <div className={`panel-inner ${relaxModal.taxi ? "blurred" : ""}`}>
            {/* olhinho de blink */}
            <div style={eyeWrapStyle} title="Blink detectado">
              <EyeIcon active={isBlinking("taxi")} className="eye" />
            </div>

            <h2 className="panel-title panel-title-amber">TÁXI</h2>
            <div className="metric">
              <div className="metric-label">CONCENTRAÇÃO</div>
              <Bar value={Number.isFinite(taxi.concentracao) ? taxi.concentracao : 0} className="progress-amber" />
              <div className="metric-value metric-amber">
                {Number.isFinite(taxi.concentracao) ? taxi.concentracao.toFixed(0) : "0"}%
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">BOOST</div>
              <Bar value={Number.isFinite(taxi.boost) ? taxi.boost : 0} className="progress-green" />
            </div>
            <div className="kv">
              <span>VOLTAS</span><span className="kv-value">{taxi.voltas}/{taxi.voltasTotal}</span>
            </div>
            <div className="kv">
              <span>TEMPO FINAL</span>
              <span className="kv-value">{typeof taxi.tempoFinalMs === "number" ? fmtFinal(taxi.tempoFinalMs) : "-:-"}</span>
            </div>
            <div className="kv">
              <span>CONEXÃO</span>
              <span className="kv-value"><WifiIcon q={connQual.taxi} /></span>
            </div>
          </div>

          {relaxModal.taxi && (
            <div className="side-modal">
              <div className="side-modal-box">
                <h3 className="modal-title">Táxi — Relaxamento</h3>
                <p>Concentração zerou. Retoma quando <b>relaxamento ≥ 50%</b>.</p>
                <div className="metric">
                  <div className="metric-label">RELAXAMENTO</div>
                  <Bar value={Number.isFinite(relax.taxi) ? relax.taxi : 0} className="progress-amber" />
                  <div className="metric-value metric-amber">
                    {Number.isFinite(relax.taxi) ? relax.taxi.toFixed(0) : "0"}%
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      </main>

      <footer className="t2-controls" style={{ justifyContent: "center" }}>
        <button className="btn" onClick={finalizeManually}>Finalizar Corrida</button>
      </footer>

      {connectModalOpen && (
        <div
          className="modal-backdrop"
          tabIndex={0}
          role="button"
          aria-label="Autorizar dispositivos"
          onMouseDown={needPairing ? pairTwoDialogs : undefined}
          onTouchStart={needPairing ? pairTwoDialogs : undefined}
          onKeyDown={needPairing ? (() => { if (!pairingInProgress) pairTwoDialogs(); }) : undefined}
        >
          <div className="modal" onMouseDown={(e)=>e.stopPropagation()} onTouchStart={(e)=>e.stopPropagation()}>
            <h3 className="modal-title">Conectar dispositivos</h3>
            <div className="modal-body">
              <p>Status:</p>
              <ul>
                <li>Polícia: <b className={statusClass(conn.policia)}>{conn.policia}</b></li>
                <li>Táxi: <b className={statusClass(conn.taxi)}>{conn.taxi}</b></li>
              </ul>

              <p>Conectados: <b>{(conn.policia === "conectado" ? 1 : 0) + (conn.taxi === "conectado" ? 1 : 0)}</b> (pode iniciar com 1 ou 2 conectados)</p>

              {needPairing ? (
                <>
                  <p>Toque nesta janela ou pressione uma tecla para autorizar as 2 portas. Dois diálogos abrirão em sequência.</p>
                  {pairingInProgress && <p>Solicitando acesso aos dispositivos…</p>}
                  <div className="modal-actions" style={{ justifyContent: "space-between" }}>
                    <button className="btn" onClick={onBack}>Cancelar</button>
                    <button
                      className="btn btn-primary"
                      onClick={() => { setConnectModalOpen(false); startTimer(); }}
                      disabled={((conn.policia === "conectado" ? 1 : 0) + (conn.taxi === "conectado" ? 1 : 0)) < 1}
                      title={((conn.policia === "conectado" ? 1 : 0) + (conn.taxi === "conectado" ? 1 : 0)) < 1 ? "Conecte pelo menos 1 dispositivo" : "Iniciar corrida"}
                    >
                      Iniciar corrida
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p>Dispositivos autorizados serão reabertos automaticamente neste navegador.</p>
                  <div className="modal-actions" style={{ justifyContent: "space-between" }}>
                    <button className="btn" onClick={onBack}>Cancelar</button>
                    <button
                      className="btn btn-primary"
                      onClick={() => { setConnectModalOpen(false); startTimer(); }}
                      disabled={((conn.policia === "conectado" ? 1 : 0) + (conn.taxi === "conectado" ? 1 : 0)) < 1}
                      title={((conn.policia === "conectado" ? 1 : 0) + (conn.taxi === "conectado" ? 1 : 0)) < 1 ? "Conecte pelo menos 1 dispositivo" : "Iniciar corrida"}
                    >
                      Iniciar corrida
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {resultModalOpen && (
        <div className="modal-backdrop" onClick={goBack}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Corrida finalizada</h3>
            <div className="modal-body">
              <div><strong>Polícia:</strong> {typeof policia.tempoFinalMs === "number" ? fmtFinal(policia.tempoFinalMs) : "—"} ({policia.voltas}/{policia.voltasTotal})</div>
              <div><strong>Táxi:</strong> {typeof taxi.tempoFinalMs === "number" ? fmtFinal(taxi.tempoFinalMs) : "—"} ({taxi.voltas}/{taxi.voltasTotal})</div>
              <div className="modal-winner">
                {winner === "policia" && <>🏁 Vencedor: <b>POLÍCIA</b></>}
                {winner === "taxi" && <>🏁 Vencedor: <b>TÁXI</b></>}
                {winner === "empate" && <>🟰 <b>EMPATE</b></>}
              </div>
              {winnerReason && <p className="modal-reason">{winnerReason}</p>}
            </div>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={goBack}>OK</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
