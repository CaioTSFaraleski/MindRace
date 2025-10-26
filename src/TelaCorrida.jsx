// src/TelaCorrida.jsx
import React, { useCallback, useEffect, useRef, useState } from "react";
import "./TelaCorrida.css";

const BAUD = 57600;
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

/** Ícone Wi-Fi de 3 barras com cores conforme qualidade (0..200). */
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

  // reset ao montar
  useEffect(() => {
    connectedOnceRef.current = { policia: false, taxi: false };
    setConnQual({ policia: 200, taxi: 200 });
    setConn({ policia: "desconectado", taxi: "desconectado" });
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

  // ===== timer =====
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

  // ===== conectado quando conexao==0; larga quando ambos =====
  const checkConnectedOnZero = useCallback((lado, conexaoVal) => {
    if (conexaoVal <= 0 && !connectedOnceRef.current[lado]) {
      connectedOnceRef.current[lado] = true;
      setConn((c) => ({ ...c, [lado]: "conectado" }));
      const both = connectedOnceRef.current.policia && connectedOnceRef.current.taxi;
      if (both && connectModalOpen) {
        setConnectModalOpen(false);
        startTimer();
      }
    }
  }, [connectModalOpen, startTimer]);

  // ===== métricas =====
  const applyPlayer = useCallback(
    (lado, data) => {
      if (data && typeof data.conexao !== "undefined") {
        const q = Math.max(0, Math.min(200, Number(data.conexao) || 0));
        setConnQual((prev) => ({ ...prev, [lado]: q }));
        checkConnectedOnZero(lado, q);
      }

      const update = (prev) => {
        const total = prev.voltasTotal || DEFAULT_TOTAL;
        const laps = Math.min(total, Math.max(0, Number(data.voltas) || 0));
        const finishedNow = prev.tempoFinalMs == null && laps >= total && running;
        return {
          ...prev,
          concentracao: Math.min(100, Math.max(0, Number(data.concentracao) || 0)),
          boost: Math.min(100, Math.max(0, Number(data.boost) || 0)),
          voltas: laps,
          voltasTotal: total,
          tempoFinalMs: finishedNow ? timerMs : prev.tempoFinalMs,
        };
      };
      if (lado === "policia") setPolicia(update);
      else if (lado === "taxi") setTaxi(update);
    },
    [running, timerMs, checkConnectedOnZero]
  );

  const parseLine = useCallback(
    (line, sideFallback) => {
      try {
        const obj = JSON.parse(line.trim());
        const lado = obj.lado ? String(obj.lado).toLowerCase() : sideFallback;
        if (lado === "policia" || lado === "taxi") {
          applyPlayer(lado, obj);
        }
      } catch {}
    },
    [applyPlayer]
  );

  // ===== serial =====
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
                try {
                  const obj = JSON.parse(line.trim());
                  const lado = obj.lado ? String(obj.lado).toLowerCase() : null;
                  if (lado === "policia" || lado === "taxi") {
                    connObj.side = lado;
                    applyPlayer(lado, obj);
                    continue;
                  }
                } catch {}
                if (connObj.side === "policia" || connObj.side === "taxi") {
                  parseLine(line, connObj.side);
                }
              }
            }
          }
        } catch {
        } finally {
          try { await reader.cancel(); } catch {}
          try { await readableClosed; } catch {}
          try { await port.close(); } catch {}
        }
      })();
    },
    [applyPlayer, parseLine]
  );

  // reabrir portas já concedidas
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
          connectReaderLoop(port);
        }
      } catch {}
    })();

    return () => {
      startedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      connsRef.current.forEach(async (c) => {
        try { await c.reader?.cancel(); } catch {}
        try { await c.port?.close(); } catch {}
      });
      connsRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // gesto no modal: abrir dois diálogos
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
        connectReaderLoop(port);
      }
    } catch {
    } finally {
      setPairingInProgress(false);
    }
  };

  // safety net: se atingir 10 voltas sem tempo, carimba com timer atual
  useEffect(() => {
    if (!running) return;
    if (policia.voltas >= policia.voltasTotal && policia.tempoFinalMs == null) {
      setPolicia(p => ({ ...p, tempoFinalMs: timerMs }));
    }
    if (taxi.voltas >= taxi.voltasTotal && taxi.tempoFinalMs == null) {
      setTaxi(p => ({ ...p, tempoFinalMs: timerMs }));
    }
  }, [running, timerMs, policia.voltas, policia.voltasTotal, policia.tempoFinalMs, taxi.voltas, taxi.voltasTotal, taxi.tempoFinalMs]);

  // finalização automática quando ambos têm tempo
  useEffect(() => {
    if (!running) return;
    const pDone = policia.voltas >= policia.voltasTotal && policia.tempoFinalMs != null;
    const tDone = taxi.voltas >= taxi.voltasTotal && taxi.tempoFinalMs != null;
    if (pDone && tDone && !resultModalOpen) {
      stopTimer();
      if (policia.tempoFinalMs < taxi.tempoFinalMs) {
        setWinner("policia");
        setWinnerReason("Menor tempo final.");
      } else if (taxi.tempoFinalMs < policia.tempoFinalMs) {
        setWinner("taxi");
        setWinnerReason("Menor tempo final.");
      } else {
        setWinner("empate");
        setWinnerReason("Tempos iguais.");
      }
      setResultModalOpen(true);
    }
  }, [running, policia, taxi, resultModalOpen, stopTimer]);

  // finalizar manual
  const finalizeManually = () => {
    stopTimer();
    if (!resultModalOpen) {
      let w = "empate";
      let reason = "Mesmas voltas.";
      if (policia.voltas > taxi.voltas) { w = "policia"; reason = "Mais voltas."; }
      else if (taxi.voltas > policia.voltas) { w = "taxi"; reason = "Mais voltas."; }
      setWinner(w);
      setWinnerReason(reason);
      setResultModalOpen(true);
    }
  };

  // salvar ranking: usa nomes da prop corrida se existirem, senão vazio
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

  return (
    <div className="t2-wrapper">
      <div className="t2-bg" />

      <header className="t2-top">
        <div className="t2-timer">{fmtTop(timerMs)}</div>
      </header>

      <main className="t2-panels">
        <section className="panel panel-left">
          <h2 className="panel-title panel-title-cyan">POLÍCIA</h2>
          <div className="metric">
            <div className="metric-label">CONCENTRAÇÃO</div>
            <div className="progress">
              <div className="progress-fill progress-cyan" style={{ width: `${policia.concentracao}%` }} />
            </div>
            <div className="metric-value metric-cyan">{policia.concentracao.toFixed(0)}%</div>
          </div>
          <div className="metric">
            <div className="metric-label">BOOST</div>
            <div className="progress">
              <div className="progress-fill progress-green" style={{ width: `${policia.boost}%` }} />
            </div>
          </div>
          <div className="kv">
            <span>VOLTAS</span><span className="kv-value">{policia.voltas}/{policia.voltasTotal}</span>
          </div>
          <div className="kv">
            <span>TEMPO FINAL</span><span className="kv-value">{policia.tempoFinalMs == null ? "-:-" : fmtFinal(policia.tempoFinalMs)}</span>
          </div>
          <div className="kv">
            <span>CONEXÃO</span>
            <span className="kv-value"><WifiIcon q={connQual.policia} /></span>
          </div>
        </section>

        <section className="panel panel-right">
          <h2 className="panel-title panel-title-amber">TÁXI</h2>
          <div className="metric">
            <div className="metric-label">CONCENTRAÇÃO</div>
            <div className="progress">
              <div className="progress-fill progress-amber" style={{ width: `${taxi.concentracao}%` }} />
            </div>
            <div className="metric-value metric-amber">{taxi.concentracao.toFixed(0)}%</div>
          </div>
          <div className="metric">
            <div className="metric-label">BOOST</div>
            <div className="progress">
              <div className="progress-fill progress-green" style={{ width: `${taxi.boost}%` }} />
            </div>
          </div>
          <div className="kv">
            <span>VOLTAS</span><span className="kv-value">{taxi.voltas}/{taxi.voltasTotal}</span>
          </div>
          <div className="kv">
            <span>TEMPO FINAL</span><span className="kv-value">{taxi.tempoFinalMs == null ? "-:-" : fmtFinal(taxi.tempoFinalMs)}</span>
          </div>
          <div className="kv">
            <span>CONEXÃO</span>
            <span className="kv-value"><WifiIcon q={connQual.taxi} /></span>
          </div>
        </section>
      </main>

      <footer className="t2-controls" style={{ justifyContent: "center" }}>
        <button className="btn" onClick={finalizeManually}>Finalizar Corrida</button>
      </footer>

      {/* Modal de conexão */}
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

              {needPairing ? (
                <>
                  <p>Toque nesta janela ou pressione uma tecla para autorizar as 2 portas. Dois diálogos abrirão em sequência.</p>
                  {pairingInProgress && <p>Solicitando acesso aos dispositivos…</p>}
                  <div className="modal-actions" style={{ justifyContent: "flex-end" }}>
                    <button className="btn" onClick={onBack}>Cancelar</button>
                  </div>
                </>
              ) : (
                <>
                  <p>Dispositivos autorizados serão reabertos automaticamente neste navegador.</p>
                  <div className="modal-actions">
                    <button className="btn" onClick={onBack}>Cancelar</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal de resultado */}
      {resultModalOpen && (
        <div className="modal-backdrop" onClick={goBack}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Corrida finalizada</h3>
            <div className="modal-body">
              <div><strong>Polícia:</strong> {policia.tempoFinalMs ? fmtFinal(policia.tempoFinalMs) : "—"} ({policia.voltas}/{policia.voltasTotal})</div>
              <div><strong>Táxi:</strong> {taxi.tempoFinalMs ? fmtFinal(taxi.tempoFinalMs) : "—"} ({taxi.voltas}/{taxi.voltasTotal})</div>
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
