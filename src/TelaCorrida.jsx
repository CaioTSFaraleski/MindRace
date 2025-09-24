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

export default function TelaCorrida({ onBack }) {
  const [policia, setPolicia] = useState(() => initialPlayer(DEFAULT_TOTAL));
  const [taxi, setTaxi] = useState(() => initialPlayer(DEFAULT_TOTAL));

  const [timerMs, setTimerMs] = useState(0);
  const [running, setRunning] = useState(false);
  const timerRef = useRef(null);
const startTsRef = useRef(0);
const startedRef = useRef(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [winner, setWinner] = useState(null);
  const [winnerReason, setWinnerReason] = useState("");

  const connsRef = useRef([]); // [{side, port, reader, buffer}]

  // ===== helpers =====
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
  const portKey = (port) => {
    const info = port?.getInfo ? port.getInfo() : {};
    return `${info.usbVendorId || "?"}-${info.usbProductId || "?"}`;
  };

  // ===== timer =====
  const startTimer = useCallback(() => {
  if (startedRef.current) return;      // já começou
  startedRef.current = true;

  // garante que não há intervalo pendurado
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

  // ===== players update =====
  const applyPlayer = useCallback(
    (lado, data) => {
      const update = (prev) => {
        const total = prev.voltasTotal || DEFAULT_TOTAL;
        const laps = Math.min(total, Math.max(0, Number(data.voltas) || 0));
        const next = {
          ...prev,
          concentracao: Math.min(100, Math.max(0, Number(data.concentracao) || 0)),
          boost: Math.min(100, Math.max(0, Number(data.boost) || 0)),
          voltas: laps,
          voltasTotal: total,
        };
        if (laps >= total && next.tempoFinalMs == null && running) {
          next.tempoFinalMs = timerMs;
        }
        return next;
      };
      if (lado === "policia") setPolicia(update);
      else if (lado === "taxi") setTaxi(update);
    },
    [running, timerMs]
  );

  const parseLine = useCallback(
    (line, sideFallback) => {
      try {
        const obj = JSON.parse(line.trim());
        const lado = obj.lado ? String(obj.lado).toLowerCase() : sideFallback;
        if (lado === "policia" || lado === "taxi") applyPlayer(lado, obj);
      } catch {}
    },
    [applyPlayer]
  );

  // ===== serial =====
  const connectReaderLoop = (port, side) => {
    const textDecoder = new TextDecoderStream();
    const readableClosed = port.readable.pipeTo(textDecoder.writable);
    const reader = textDecoder.readable.getReader();
    const conn = { side, port, reader, buffer: "" };
    connsRef.current.push(conn);

    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            conn.buffer += value;
            let idx;
            while ((idx = conn.buffer.indexOf("\n")) >= 0) {
              const line = conn.buffer.slice(0, idx);
              conn.buffer = conn.buffer.slice(idx + 1);
              parseLine(line, side);
            }
          }
        }
      } catch {
        // ignore
      } finally {
        try { await reader.cancel(); } catch {}
        try { await readableClosed; } catch {}
        try { await port.close(); } catch {}
      }
    })();
  };

  const autoConnect = useCallback(async () => {
    if (!("serial" in navigator)) return;
    const saved = JSON.parse(localStorage.getItem("arduinoMapping") || "{}");
    const ports = await navigator.serial.getPorts();
    const map = { ...saved };

    // reabrir portas salvas
    for (const port of ports) {
      const key = portKey(port);
      const side = saved[key];
      if (side === "policia" || side === "taxi") {
        try {
          await port.open({ baudRate: BAUD });
          connectReaderLoop(port, side);
        } catch { /* se falhar, cai para requestPort */ }
      }
    }

    // pedir portas se algum lado ainda não tem
    if (!Object.values(map).includes("policia")) {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: BAUD });
      connectReaderLoop(port, "policia");
      map[portKey(port)] = "policia";
    }
    if (!Object.values(map).includes("taxi")) {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: BAUD });
      connectReaderLoop(port, "taxi");
      map[portKey(port)] = "taxi";
    }

    localStorage.setItem("arduinoMapping", JSON.stringify(map));
  }, [parseLine]);

  // ===== inicialização: conecta e inicia sozinho =====
  useEffect(() => {
  // inicia na hora (não espere a conexão)
  startTimer();

  // conecta em paralelo; não use await aqui
  autoConnect().catch(() => {});

  // cleanup
  return () => {
    startedRef.current = false;
    if (timerRef.current) clearInterval(timerRef.current);
  };
  // queremos rodar só 1x no mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

  // ===== finalização automática =====
  useEffect(() => {
    if (!running) return;
    const pDone = policia.voltas >= policia.voltasTotal && policia.tempoFinalMs != null;
    const tDone = taxi.voltas >= taxi.voltasTotal && taxi.tempoFinalMs != null;

    if (pDone && tDone && !modalOpen) {
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
      setModalOpen(true);
    }
  }, [running, policia, taxi, modalOpen, stopTimer]);

  // ===== finalizar manual =====
  const finalizeManually = () => {
    stopTimer();
    if (!modalOpen) {
      let w = "empate", reason = "Mesmas voltas.";
      if (policia.voltas > taxi.voltas) { w = "policia"; reason = "Mais voltas."; }
      else if (taxi.voltas > policia.voltas) { w = "taxi"; reason = "Mais voltas."; }
      setWinner(w);
      setWinnerReason(reason);
      setModalOpen(true);
    }
  };

  const goBack = () => {
    if (typeof onBack === "function") onBack();
    else window.location.reload();
  };

  return (
    <div className="t2-wrapper">
      <div className="t2-bg" />

      <header className="t2-top">
        <div className="t2-timer">{fmtTop(timerMs)}</div>
      </header>

      <main className="t2-panels">
        {/* Polícia */}
        <section className="panel panel-left">
          <h2 className="panel-title panel-title-cyan">POLÍCIA</h2>
          <div className="metric">
            <div className="metric-label">CONCENTRAÇÃO</div>
            <div className="progress">
              <div className="progress-fill progress-cyan" style={{ width: `${policia.concentracao}%` }}/>
            </div>
            <div className="metric-value metric-cyan">{policia.concentracao.toFixed(0)}%</div>
          </div>
          <div className="metric">
            <div className="metric-label">BOOST</div>
            <div className="progress">
              <div className="progress-fill progress-green" style={{ width: `${policia.boost}%` }}/>
            </div>
          </div>
          <div className="kv">
            <span>VOLTAS</span><span className="kv-value">{policia.voltas}/{policia.voltasTotal}</span>
          </div>
          <div className="kv">
            <span>TEMPO FINAL</span><span className="kv-value">{policia.tempoFinalMs == null ? "-:-" : fmtFinal(policia.tempoFinalMs)}</span>
          </div>
        </section>

        {/* Táxi */}
        <section className="panel panel-right">
          <h2 className="panel-title panel-title-amber">TÁXI</h2>
          <div className="metric">
            <div className="metric-label">CONCENTRAÇÃO</div>
            <div className="progress">
              <div className="progress-fill progress-amber" style={{ width: `${taxi.concentracao}%` }}/>
            </div>
            <div className="metric-value metric-amber">{taxi.concentracao.toFixed(0)}%</div>
          </div>
          <div className="metric">
            <div className="metric-label">BOOST</div>
            <div className="progress">
              <div className="progress-fill progress-green" style={{ width: `${taxi.boost}%` }}/>
            </div>
          </div>
          <div className="kv">
            <span>VOLTAS</span><span className="kv-value">{taxi.voltas}/{taxi.voltasTotal}</span>
          </div>
          <div className="kv">
            <span>TEMPO FINAL</span><span className="kv-value">{taxi.tempoFinalMs == null ? "-:-" : fmtFinal(taxi.tempoFinalMs)}</span>
          </div>
        </section>
      </main>

      {/* Rodapé: apenas Finalizar Corrida */}
      <footer className="t2-controls" style={{ justifyContent: "center" }}>
        <button className="btn" onClick={finalizeManually}>Finalizar Corrida</button>
      </footer>

      {/* Modal de resultado */}
      {modalOpen && (
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
              {winnerReason && <p>{winnerReason}</p>}
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
